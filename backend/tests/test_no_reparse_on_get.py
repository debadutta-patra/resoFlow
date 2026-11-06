"""Tests ensuring GET endpoints serve from bundle without reparsing raw ChemEx trees (§3.11).

Verifies:
- GET /results serves directly from the bundle without re-parsing raw trees.
- Raw parsers raising an exception do not affect GET requests on a bundled run.
- ETag and HTTP 304 Not Modified behavior works as expected.
- Granular endpoints (/results/summary and /results/residues/{residue}) work from SQLite/store.
"""

import shutil
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import database, models, security
from app.main import app
from app.services.results_bundle.ingest import ingest_results


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


def test_no_reparse_on_get_with_etag_and_304(client_and_db, tmp_path: Path) -> None:
    client, SessionLocal, _ = client_and_db
    db = SessionLocal()

    user = models.User(
        email="bundleuser@test.com",
        hashed_password=security.get_password_hash("password123"),
        full_name="Bundle User",
        is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    proj_dir = tmp_path / "proj"
    proj_dir.mkdir(parents=True, exist_ok=True)

    project = models.Project(
        project_uuid="proj-no-reparse",
        name="No Reparse Project",
        user_id=user.id,
        local_directory_path=str(proj_dir),
    )
    db.add(project)
    db.commit()
    db.refresh(project)

    analysis_uuid = "analysis-no-reparse-1234"
    run_dir = proj_dir / "cest_fitting" / analysis_uuid
    shutil.copytree(FIXTURE_PATH, run_dir)

    # Ingest bundle beforehand
    ingest_results(run_dir, analysis_uuid=analysis_uuid, analysis_type="CEST")
    assert (run_dir / "results" / "manifest.json").exists()

    analysis = models.Analysis(
        analysis_uuid=analysis_uuid,
        name="No Reparse CEST",
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

    # Monkeypatch both raw parsers to raise if called
    with patch(
        "app.services.fitting.cest_tasks._parse_chemex_output",
        side_effect=RuntimeError("FAIL: _parse_chemex_output was called!"),
    ), patch(
        "app.services.fitting.chemex_output.parser.parse_output_tree",
        side_effect=RuntimeError("FAIL: parse_output_tree was called!"),
    ):
        # 1. Test GET /results
        res = client.get(
            f"/api/projects/{proj_uuid}/analysis/{an_uuid}/results",
            headers=headers,
        )
        assert res.status_code == 200, res.text
        etag = res.headers.get("ETag")
        assert etag is not None
        assert etag.startswith('"') and etag.endswith('"')

        data = res.json()
        assert data["status"] == "COMPLETED"
        assert "results" in data
        assert "residues" in data["results"]
        assert len(data["results"]["residues"]) > 0

        # 2. Test HTTP 304 Not Modified with If-None-Match
        res_304 = client.get(
            f"/api/projects/{proj_uuid}/analysis/{an_uuid}/results",
            headers={**headers, "If-None-Match": etag},
        )
        assert res_304.status_code == 304

        # 3. Test GET /results/summary
        res_summary = client.get(
            f"/api/projects/{proj_uuid}/analysis/{an_uuid}/results/summary",
            headers=headers,
        )
        assert res_summary.status_code == 200, res_summary.text
        s_data = res_summary.json()
        assert "residues" in s_data
        assert len(s_data["residues"]) > 0

        # 4. Test GET /results/residues/{residue}
        res_residue = client.get(
            f"/api/projects/{proj_uuid}/analysis/{an_uuid}/results/residues/14N",
            headers=headers,
        )
        assert res_residue.status_code == 200, res_residue.text
        r_data = res_residue.json()
        assert r_data["residue"] == "14N"
        assert "profiles" in r_data
