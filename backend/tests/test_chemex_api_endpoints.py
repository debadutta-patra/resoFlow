"""Tests for ChemEx API endpoints: /api/chemex/models, /api/chemex/validate, /api/chemex/parameters/inspect, and /continue."""

import shutil
from pathlib import Path
import pytest
from fastapi.testclient import TestClient

from app.database import get_db
from app.main import app
from app.models import Analysis, Base, Project, User
from app.security import create_access_token
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

client = TestClient(app)


@pytest.fixture
def db_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(bind=engine)
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    session = TestingSessionLocal()

    def override_get_db():
        try:
            yield session
        finally:
            pass

    app.dependency_overrides[get_db] = override_get_db
    try:
        yield session
    finally:
        session.close()
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def auth_headers(db_session):
    user = db_session.query(User).filter_by(email="test@example.com").first()
    if not user:
        user = User(email="test@example.com", hashed_password="pw", full_name="Test User", is_active=True)
        db_session.add(user)
        db_session.commit()
    token = create_access_token(data={"sub": user.email})
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def test_project(db_session, auth_headers):
    user = db_session.query(User).filter_by(email="test@example.com").first()
    project = db_session.query(Project).filter_by(name="ChemExTestProj").first()
    if not project:
        project = Project(
            name="ChemExTestProj",
            project_uuid="proj-chemex-test-1234",
            local_directory_path="/tmp/resoflow_chemex_test_proj",
            user_id=user.id if user else None,
        )
        db_session.add(project)
        db_session.commit()
        db_session.refresh(project)
    Path(project.local_directory_path).mkdir(parents=True, exist_ok=True)
    return project


def test_get_chemex_models():
    """Verify GET /api/chemex/models returns ChemEx models catalog and metadata."""
    res = client.get("/api/chemex/models")
    assert res.status_code == 200
    data = res.json()
    assert data["chemex_version"] == "2026.9.2"
    assert data["method_format"] == 2
    assert "2st" in data["models"]
    assert "3st" in data["models"]


def test_validate_inputs_clean(tmp_path: Path):
    """Verify POST /api/chemex/validate succeeds on valid inputs."""
    fixture_dir = (
        Path(__file__).resolve().parent
        / "fixtures"
        / "baselines"
        / "2026.6.1"
        / "cest_15n"
        / "inputs"
    )
    if not fixture_dir.exists():
        pytest.skip("Baseline inputs for cest_15n not found.")

    shutil.copytree(fixture_dir, tmp_path, dirs_exist_ok=True)

    method_v2 = """FORMAT_VERSION = 2

[STEP1]
INCLUDE = ["13N"]
ROLES = [
  { FIT = ["PB", "KEX_AB", "DW_AB", "CS_A"] },
  { FIX = ["R1_A", "R2_A"] },
]
"""
    payload = {
        "model": "2st",
        "experiment_files": [f"Experiments/{f.name}" for f in sorted((tmp_path / "Experiments").glob("*.toml"))],
        "parameter_files": [f"Parameters/{f.name}" for f in sorted((tmp_path / "Parameters").glob("*.toml"))],
        "method_toml": method_v2,
        "include": ["13N"],
    }

    import contextlib, os
    with contextlib.chdir(tmp_path):
        res = client.post("/api/chemex/validate", json=payload)
    assert res.status_code == 200
    report = res.json()
    assert report["valid"] is True
    assert report["errors"] == []


def test_validate_inputs_wrong_selector_error(tmp_path: Path):
    """Verify POST /api/chemex/validate detects invalid selector with readable MethodFormatError."""
    fixture_dir = (
        Path(__file__).resolve().parent
        / "fixtures"
        / "baselines"
        / "2026.6.1"
        / "cest_15n"
        / "inputs"
    )
    if not fixture_dir.exists():
        pytest.skip("Baseline inputs for cest_15n not found.")

    shutil.copytree(fixture_dir, tmp_path, dirs_exist_ok=True)

    bad_method = """FORMAT_VERSION = 2

[STEP1]
INCLUDE = ["13N"]
ROLES = [
  { FIT = ["INVALID_SELECTOR_XYZ"] },
]
"""
    payload = {
        "model": "2st",
        "experiment_files": [f"Experiments/{f.name}" for f in sorted((tmp_path / "Experiments").glob("*.toml"))],
        "parameter_files": [f"Parameters/{f.name}" for f in sorted((tmp_path / "Parameters").glob("*.toml"))],
        "method_toml": bad_method,
        "include": ["13N"],
    }

    import contextlib
    with contextlib.chdir(tmp_path):
        res = client.post("/api/chemex/validate", json=payload)
    assert res.status_code == 200
    report = res.json()
    assert report["valid"] is False
    assert any("INVALID_SELECTOR_XYZ" in err["message"] for err in report["errors"])


def test_validate_inputs_legacy_parameter_error(tmp_path: Path):
    """Verify POST /api/chemex/validate detects legacy DWP_AB parameter name."""
    fixture_dir = (
        Path(__file__).resolve().parent
        / "fixtures"
        / "baselines"
        / "2026.6.1"
        / "cest_15n"
        / "inputs"
    )
    if not fixture_dir.exists():
        pytest.skip("Baseline inputs for cest_15n not found.")

    shutil.copytree(fixture_dir, tmp_path, dirs_exist_ok=True)

    legacy_params = (tmp_path / "Parameters" / "parameters.toml").read_text(encoding="utf-8")
    legacy_params += "\n[DWP_AB]\nvalue = 1.0\n"

    payload = {
        "model": "2st",
        "experiment_files": [f"Experiments/{f.name}" for f in sorted((tmp_path / "Experiments").glob("*.toml"))],
        "parameter_toml": legacy_params,
        "include": ["13N"],
    }

    import contextlib
    with contextlib.chdir(tmp_path):
        res = client.post("/api/chemex/validate", json=payload)
    assert res.status_code == 200
    report = res.json()
    assert report["valid"] is False
    assert any("DWP_AB" in err["message"] for err in report["errors"])
    assert any(err.get("type") == "LegacyParameterError" for err in report["errors"])


def test_inspect_parameters(tmp_path: Path):
    """Verify POST /api/chemex/parameters/inspect introspects parameters and flags sharing."""
    fixture_dir = (
        Path(__file__).resolve().parent
        / "fixtures"
        / "baselines"
        / "2026.6.1"
        / "cest_15n"
        / "inputs"
    )
    if not fixture_dir.exists():
        pytest.skip("Baseline inputs for cest_15n not found.")

    shutil.copytree(fixture_dir, tmp_path, dirs_exist_ok=True)

    payload = {
        "model": "2st",
        "experiment_files": [f"Experiments/{f.name}" for f in sorted((tmp_path / "Experiments").glob("*.toml"))],
        "parameter_files": [f"Parameters/{f.name}" for f in sorted((tmp_path / "Parameters").glob("*.toml"))],
        "include": ["13N"],
    }

    import contextlib
    with contextlib.chdir(tmp_path):
        res = client.post("/api/chemex/parameters/inspect", json=payload)
    assert res.status_code == 200
    data = res.json()
    assert "parameters" in data
    assert len(data["parameters"]) > 0
    p0 = data["parameters"][0]
    assert "status" in p0
    assert "is_shared" in p0
    assert "experiments" in data


def test_continue_from_run(db_session, test_project, auth_headers):
    """Verify POST /api/projects/{project_uuid}/analysis/{analysis_uuid}/continue creates a new run initialized from restart.toml."""
    source_uuid = "analysis-source-cont-1234"
    source = Analysis(
        analysis_uuid=source_uuid,
        name="SourceCESTRun",
        analysis_type="15N-CEST",
        project_id=test_project.id,
        status="COMPLETED",
    )
    db_session.add(source)
    db_session.commit()

    # Create dummy source run directory with restart.toml
    source_run_dir = Path(test_project.local_directory_path) / "cest_fitting" / source_uuid
    (source_run_dir / "Output" / "run_info").mkdir(parents=True, exist_ok=True)
    (source_run_dir / "Output" / "run_info" / "restart.toml").write_text('[PB]\nvalue = 0.05\n', encoding="utf-8")
    (source_run_dir / "Experiments").mkdir(parents=True, exist_ok=True)
    (source_run_dir / "Experiments" / "dummy.toml").write_text('# exp\n', encoding="utf-8")

    res = client.post(
        f"/api/projects/{test_project.project_uuid}/analysis/{source_uuid}/continue",
        headers=auth_headers,
    )
    assert res.status_code == 200
    new_data = res.json()
    assert new_data["name"] == "SourceCESTRun (continued)"
    assert new_data["status"] == "PENDING"
    assert new_data["analysis_uuid"] != source_uuid

    # Verify that the new analysis directory has Parameters/parameters.toml copied from restart.toml
    new_run_dir = Path(test_project.local_directory_path) / "cest_fitting" / new_data["analysis_uuid"]
    new_param_file = new_run_dir / "Parameters" / "parameters.toml"
    assert new_param_file.exists()
    assert "[PB]" in new_param_file.read_text(encoding="utf-8")


def test_validate_and_inspect_with_analysis_uuid_lowercase_data(db_session, test_project):
    """Verify POST /api/chemex/validate and /parameters/inspect resolve lowercase data/ paths from analysis_uuid."""
    fixture_dir = (
        Path(__file__).resolve().parent
        / "fixtures"
        / "baselines"
        / "2026.6.1"
        / "cest_15n"
        / "inputs"
    )
    if not fixture_dir.exists():
        pytest.skip("Baseline inputs for cest_15n not found.")

    analysis_uuid = "analysis-cest-lowercase-data-1234"
    analysis = Analysis(
        analysis_uuid=analysis_uuid,
        name="CESTLowercaseDataRun",
        analysis_type="15N-CEST",
        project_id=test_project.id,
        status="PENDING",
    )
    db_session.add(analysis)
    db_session.commit()

    run_dir = Path(test_project.local_directory_path) / "cest_fitting" / analysis_uuid
    run_dir.mkdir(parents=True, exist_ok=True)

    # Copy Parameters
    shutil.copytree(fixture_dir / "Parameters", run_dir / "Parameters", dirs_exist_ok=True)

    # Create lowercase 'data' directory (simulating spectrum extraction in analysis.py)
    data_dir = run_dir / "data" / "600MHz_28hz"
    data_dir.mkdir(parents=True, exist_ok=True)
    for f in (fixture_dir / "Data" / "13Hz").glob("*.out"):
        shutil.copy2(f, data_dir / f.name)

    # Create Experiments pointing to lowercase '../data/600MHz_28hz'
    exp_dir = run_dir / "Experiments"
    exp_dir.mkdir(parents=True, exist_ok=True)
    exp_toml_content = (fixture_dir / "Experiments" / "13hz.toml").read_text(encoding="utf-8")
    exp_toml_content = exp_toml_content.replace('"../Data/13Hz/"', '"../data/600MHz_28hz"')
    (exp_dir / "cest_15n_600mhz_28hz.toml").write_text(exp_toml_content, encoding="utf-8")

    # 1. Test POST /api/chemex/validate
    payload = {
        "analysis_uuid": analysis_uuid,
        "model": "2st",
        "include": ["13N"],
    }
    res_val = client.post("/api/chemex/validate", json=payload)
    assert res_val.status_code == 200
    report = res_val.json()
    assert report["valid"] is True, f"Validation failed: {report.get('errors')}"
    assert report["errors"] == []

    # 2. Test POST /api/chemex/parameters/inspect
    res_insp = client.post("/api/chemex/parameters/inspect", json=payload)
    assert res_insp.status_code == 200
    insp_data = res_insp.json()
    assert "parameters" in insp_data
    assert len(insp_data["parameters"]) > 0
    assert any(p["name"] == "PB" for p in insp_data["parameters"])

