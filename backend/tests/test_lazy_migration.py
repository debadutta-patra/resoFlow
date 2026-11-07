"""Tests for lazy migration fallback on GET /results (§3.11).

Verifies:
- When an analysis has no results/ bundle, GET /results still succeeds via raw parse fallback.
- An ingest_results_task background task is enqueued to migrate the run asynchronously.
"""

import shutil
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import database, models, security
from app.main import app


FIXTURE_PATH = Path(__file__).parent / "fixtures" / "chemex_trees_2026_9" / "cest_step_grid"


@pytest.fixture(scope="module")
def client_and_db():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    models.Base.metadata.create_all(bind=engine)

    def override_get_db():
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[database.get_db] = override_get_db
    client = TestClient(app)
    yield client, TestingSessionLocal, engine
    app.dependency_overrides.clear()


def test_lazy_migration_enqueues_ingest(client_and_db, tmp_path: Path) -> None:
    client, SessionLocal, _ = client_and_db
    db = SessionLocal()

    # Create user
    user = models.User(
        email="miguser@test.com",
        hashed_password=security.get_password_hash("password123"),
        full_name="Migration User",
        is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    # Create project directory
    proj_dir = tmp_path / "proj"
    proj_dir.mkdir(parents=True, exist_ok=True)

    project = models.Project(
        project_uuid="proj-lazy-mig",
        name="Lazy Migration Project",
        user_id=user.id,
        local_directory_path=str(proj_dir),
    )
    db.add(project)
    db.commit()
    db.refresh(project)

    analysis_uuid = "analysis-lazy-1234"
    run_dir = proj_dir / "cest_fitting" / analysis_uuid
    shutil.copytree(FIXTURE_PATH, run_dir)

    # Ensure results/ bundle does NOT exist
    assert not (run_dir / "results").exists()

    analysis = models.Analysis(
        analysis_uuid=analysis_uuid,
        name="Lazy CEST",
        analysis_type="15N-CEST",
        project_id=project.id,
        status="COMPLETED",
    )
    db.add(analysis)
    db.commit()
    db.refresh(analysis)
    user_email = user.email
    proj_uuid = project.project_uuid
    an_uuid = analysis.analysis_uuid
    db.close()

    token = security.create_access_token({"sub": user_email})
    headers = {"Authorization": f"Bearer {token}"}

    with patch("app.services.results_bundle.tasks.ingest_results_task.delay") as mock_delay:
        res = client.get(
            f"/api/projects/{proj_uuid}/analysis/{an_uuid}/results",
            headers=headers,
        )
        assert res.status_code == 200, res.text
        data = res.json()
        assert data["status"] == "COMPLETED"
        assert "results" in data
        assert "residues" in data["results"]
        assert len(data["results"]["residues"]) > 0

        # Verify background ingest was enqueued
        mock_delay.assert_called_once_with(an_uuid)


def test_rebuild_bundles_cli(client_and_db, tmp_path: Path) -> None:
    from app.cli import rebuild_bundles
    from app.services.results_bundle.store import is_bundle_valid

    _, SessionLocal, _ = client_and_db
    db = SessionLocal()

    user = models.User(
        email="cliuser@test.com",
        hashed_password=security.get_password_hash("password123"),
        full_name="CLI User",
        is_active=True,
    )
    db.add(user)
    db.commit()

    proj_dir = tmp_path / "cli_proj"
    proj_dir.mkdir(parents=True, exist_ok=True)

    project = models.Project(
        project_uuid="proj-cli-rebuild",
        name="CLI Project",
        user_id=user.id,
        local_directory_path=str(proj_dir),
    )
    db.add(project)
    db.commit()

    analysis_uuid = "analysis-cli-9999"
    run_dir = proj_dir / "cest_fitting" / analysis_uuid
    shutil.copytree(FIXTURE_PATH, run_dir)
    assert not (run_dir / "results").exists()

    analysis = models.Analysis(
        analysis_uuid=analysis_uuid,
        name="CLI Analysis",
        analysis_type="15N-CEST",
        project_id=project.id,
        status="COMPLETED",
        bundle_status="PENDING",
    )
    db.add(analysis)
    db.commit()
    db.close()

    # Run CLI rebuild
    with patch("app.database.get_db", return_value=iter([SessionLocal()])):
        rc = rebuild_bundles(analysis_uuid=analysis_uuid)
        assert rc == 0

    assert is_bundle_valid(run_dir)

    # Verify db was updated
    verify_db = SessionLocal()
    updated_a = verify_db.query(models.Analysis).filter_by(analysis_uuid=analysis_uuid).first()
    assert updated_a is not None
    assert updated_a.bundle_status == "VALID"
    assert updated_a.summary_redchi is not None
    assert updated_a.summary_n_residues > 0
    verify_db.close()


def test_lazy_migration_skipped_when_running_or_failed(client_and_db, tmp_path: Path) -> None:
    """Ensure GET /results never triggers lazy migration or overwrites status if RUNNING or FAILED."""
    client, SessionLocal, _ = client_and_db
    db = SessionLocal()

    user = models.User(
        email="guarduser@test.com",
        hashed_password=security.get_password_hash("password123"),
        full_name="Guard User",
        is_active=True,
    )
    db.add(user)
    db.commit()

    proj_dir = tmp_path / "guard_proj"
    proj_dir.mkdir(parents=True, exist_ok=True)

    project = models.Project(
        project_uuid="proj-guard-1",
        name="Guard Project",
        user_id=user.id,
        local_directory_path=str(proj_dir),
    )
    db.add(project)
    db.commit()

    # Case 1: RUNNING analysis
    running_uuid = "analysis-guard-running"
    run_dir = proj_dir / "cest_fitting" / running_uuid
    shutil.copytree(FIXTURE_PATH, run_dir)
    assert not (run_dir / "results").exists()

    analysis_running = models.Analysis(
        analysis_uuid=running_uuid,
        name="Running CEST",
        analysis_type="15N-CEST",
        project_id=project.id,
        status="RUNNING",
    )
    db.add(analysis_running)

    # Case 2: FAILED analysis
    failed_uuid = "analysis-guard-failed"
    fail_dir = proj_dir / "cest_fitting" / failed_uuid
    shutil.copytree(FIXTURE_PATH, fail_dir)

    analysis_failed = models.Analysis(
        analysis_uuid=failed_uuid,
        name="Failed CEST",
        analysis_type="15N-CEST",
        project_id=project.id,
        status="FAILED",
        error_message="Test run failure",
    )
    db.add(analysis_failed)
    db.commit()
    user_email = user.email
    proj_uuid = project.project_uuid
    db.close()

    token = security.create_access_token({"sub": user_email})
    headers = {"Authorization": f"Bearer {token}"}

    with patch("app.services.results_bundle.tasks.ingest_results_task.delay") as mock_delay:
        # Request results for RUNNING
        res = client.get(
            f"/api/projects/{proj_uuid}/analysis/{running_uuid}/results",
            headers=headers,
        )
        assert res.status_code == 200
        assert res.json()["status"] == "RUNNING"
        assert res.json()["results"] is None

        # Request results for FAILED
        res_f = client.get(
            f"/api/projects/{proj_uuid}/analysis/{failed_uuid}/results",
            headers=headers,
        )
        assert res_f.status_code == 200
        assert res_f.json()["status"] == "FAILED"
        assert res_f.json()["results"] is None

        # ingest_results_task MUST NOT be called in either case
        mock_delay.assert_not_called()


def test_reconcile_orphaned_runs_with_old_created_at_does_not_fail(client_and_db, tmp_path: Path) -> None:
    """Ensure reconcile_orphaned_runs does NOT mark re-run PENDING analysis as FAILED based on old created_at."""
    from datetime import datetime, timezone, timedelta
    from app.routers.dashboard import reconcile_orphaned_runs
    import json

    _, SessionLocal, _ = client_and_db
    db = SessionLocal()

    user = models.User(
        email="reconcile@test.com",
        hashed_password=security.get_password_hash("password123"),
        full_name="Reconcile User",
        is_active=True,
    )
    db.add(user)
    db.commit()

    project = models.Project(
        project_uuid="proj-reconcile-1",
        name="Reconcile Project",
        user_id=user.id,
        local_directory_path=str(tmp_path / "reconcile_proj"),
    )
    db.add(project)
    db.commit()

    # Created 5 days ago, but queued 10 seconds ago
    old_created = datetime.now(timezone.utc) - timedelta(days=5)
    recent_queued = datetime.now(timezone.utc) - timedelta(seconds=10)

    analysis = models.Analysis(
        analysis_uuid="analysis-rerun-1234",
        name="Rerun Analysis",
        analysis_type="15N-CEST",
        project_id=project.id,
        status="PENDING",
        created_at=old_created,
        parameters=json.dumps({"queued_at": recent_queued.isoformat()}),
    )
    db.add(analysis)
    db.commit()

    # Run reconcile_orphaned_runs
    reconcile_orphaned_runs(db, user.id)

    db.refresh(analysis)
    # MUST still be PENDING, not falsely failed!
    assert analysis.status == "PENDING"
    assert analysis.error_message is None
    db.close()


def test_ingest_results_task_aborts_if_container_is_running(client_and_db) -> None:
    """Ensure ingest_results_task safely aborts without modifying DB if ChemEx container is active."""
    from app.services.results_bundle.tasks import ingest_results_task

    _, SessionLocal, _ = client_and_db
    db = SessionLocal()

    user = models.User(
        email="containeruser@test.com",
        hashed_password=security.get_password_hash("password123"),
        full_name="Container User",
        is_active=True,
    )
    db.add(user)
    db.commit()

    project = models.Project(
        project_uuid="proj-container-1",
        name="Container Project",
        user_id=user.id,
    )
    db.add(project)
    db.commit()

    analysis = models.Analysis(
        analysis_uuid="analysis-container-running",
        name="Active Container Analysis",
        analysis_type="15N-CEST",
        project_id=project.id,
        status="RUNNING",
    )
    db.add(analysis)
    db.commit()
    an_uuid = analysis.analysis_uuid
    db.close()

    with patch("app.services.fitting.chemex_runner.is_chemex_container_running", return_value=True):
        with patch("app.database.get_db", return_value=iter([SessionLocal()])):
            res = ingest_results_task(an_uuid)
            assert res.get("status") == "aborted"
            assert res.get("reason") == "container_still_running"

    verify_db = SessionLocal()
    check_a = verify_db.query(models.Analysis).filter_by(analysis_uuid=an_uuid).first()
    assert check_a.status == "RUNNING"
    verify_db.close()


