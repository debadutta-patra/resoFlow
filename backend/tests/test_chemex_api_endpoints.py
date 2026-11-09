"""Tests for ChemEx API endpoints: /api/chemex/models, the project-scoped
.../analysis/{uuid}/chemex/validate and /parameters/inspect, and /continue."""

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


FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures" / "baselines" / "2026.6.1" / "cest_15n" / "inputs"

GOOD_METHOD = """FORMAT_VERSION = 2

[STEP1]
INCLUDE = ["13N"]
ROLES = [
  { FIT = ["PB", "KEX_AB", "DW_AB", "CS_A"] },
  { FIX = ["R1_A", "R2_A"] },
]
"""


def _make_analysis(db_session, project, analysis_uuid: str, *, lowercase_data: bool = False) -> Analysis:
    """Create a CEST analysis whose run directory holds the cest_15n baseline inputs."""
    if not FIXTURE_DIR.exists():
        pytest.skip("Baseline inputs for cest_15n not found.")
    analysis = db_session.query(Analysis).filter_by(analysis_uuid=analysis_uuid).first()
    if not analysis:
        analysis = Analysis(
            analysis_uuid=analysis_uuid,
            name=f"Run {analysis_uuid}",
            analysis_type="15N-CEST",
            project_id=project.id,
            status="PENDING",
        )
        db_session.add(analysis)
        db_session.commit()
    run_dir = Path(project.local_directory_path) / "cest_fitting" / analysis_uuid
    if run_dir.exists():
        shutil.rmtree(run_dir)
    shutil.copytree(FIXTURE_DIR / "Parameters", run_dir / "Parameters")
    if lowercase_data:
        # Simulates spectrum extraction into lowercase data/ with renamed dataset dirs.
        data_dir = run_dir / "data" / "600MHz_28hz"
        data_dir.mkdir(parents=True)
        for f in (FIXTURE_DIR / "Data" / "13Hz").glob("*.out"):
            shutil.copy2(f, data_dir / f.name)
        (run_dir / "Experiments").mkdir(parents=True)
        exp = (FIXTURE_DIR / "Experiments" / "13hz.toml").read_text(encoding="utf-8")
        (run_dir / "Experiments" / "cest_15n_600mhz_28hz.toml").write_text(
            exp.replace('"../Data/13Hz/"', '"../data/600MHz_28hz"'), encoding="utf-8"
        )
    else:
        shutil.copytree(FIXTURE_DIR / "Data", run_dir / "Data")
        shutil.copytree(FIXTURE_DIR / "Experiments", run_dir / "Experiments")
    return analysis


def _url(project, analysis_uuid: str, tail: str) -> str:
    return f"/api/projects/{project.project_uuid}/analysis/{analysis_uuid}/chemex/{tail}"


def test_get_chemex_models(auth_headers):
    """GET /api/chemex/models returns the catalog and the installed ChemEx version."""
    import chemex

    res = client.get("/api/chemex/models", headers=auth_headers)
    assert res.status_code == 200
    data = res.json()
    assert data["chemex_version"] == chemex.__version__ == "2026.9.2"
    assert data["method_format"] == 2
    assert "2st" in data["models"]
    assert "3st" in data["models"]


def test_chemex_endpoints_require_auth(db_session, test_project):
    analysis = _make_analysis(db_session, test_project, "analysis-chemex-noauth")
    assert client.get("/api/chemex/models").status_code == 401
    for tail in ("validate", "parameters/inspect"):
        assert client.post(_url(test_project, analysis.analysis_uuid, tail), json={}).status_code == 401


def test_legacy_unscoped_routes_are_gone(auth_headers):
    """The old unauthenticated /api/chemex/validate and /inspect routes must not exist."""
    assert client.post("/api/chemex/validate", json={}, headers=auth_headers).status_code in (404, 405)
    assert client.post("/api/chemex/parameters/inspect", json={}, headers=auth_headers).status_code in (404, 405)


def test_chemex_endpoints_enforce_ownership(db_session, test_project):
    """Another user cannot validate/inspect against someone else's analysis."""
    analysis = _make_analysis(db_session, test_project, "analysis-chemex-owned")
    other = User(email="intruder@example.com", hashed_password="pw", full_name="Other", is_active=True)
    db_session.add(other)
    db_session.commit()
    headers = {"Authorization": f"Bearer {create_access_token(data={'sub': other.email})}"}
    for tail in ("validate", "parameters/inspect"):
        res = client.post(_url(test_project, analysis.analysis_uuid, tail), json={"model": "2st"}, headers=headers)
        assert res.status_code in (403, 404), res.text


def test_client_supplied_paths_are_ignored(db_session, test_project, auth_headers, tmp_path):
    """Requests cannot point ChemEx at arbitrary server files."""
    analysis = _make_analysis(db_session, test_project, "analysis-chemex-paths")
    secret = tmp_path / "secret.toml"
    secret.write_text("[GLOBAL]\nPB = 0.5\n", encoding="utf-8")
    payload = {"model": "2st", "parameter_files": [str(secret)], "experiment_files": [str(secret)], "include": ["13N"]}
    res = client.post(_url(test_project, analysis.analysis_uuid, "parameters/inspect"), json=payload, headers=auth_headers)
    assert res.status_code == 200
    pb = next(p for p in res.json()["parameters"] if p["name"] == "PB")
    assert pb["value"] != 0.5  # value came from the analysis's own parameters, not the injected file


def test_validate_inputs_clean(db_session, test_project, auth_headers):
    analysis = _make_analysis(db_session, test_project, "analysis-chemex-clean")
    res = client.post(
        _url(test_project, analysis.analysis_uuid, "validate"),
        json={"model": "2st", "method_toml": GOOD_METHOD, "include": ["13N"]},
        headers=auth_headers,
    )
    assert res.status_code == 200
    report = res.json()
    assert report["valid"] is True, report
    assert report["errors"] == []


def test_validate_inputs_wrong_selector_error(db_session, test_project, auth_headers):
    """An unknown selector is reported with ChemEx's readable MethodFormatError."""
    analysis = _make_analysis(db_session, test_project, "analysis-chemex-badsel")
    bad_method = GOOD_METHOD.replace('{ FIT = ["PB", "KEX_AB", "DW_AB", "CS_A"] }', '{ FIT = ["INVALID_SELECTOR_XYZ"] }')
    res = client.post(
        _url(test_project, analysis.analysis_uuid, "validate"),
        json={"model": "2st", "method_toml": bad_method, "include": ["13N"]},
        headers=auth_headers,
    )
    assert res.status_code == 200
    report = res.json()
    assert report["valid"] is False
    assert any("INVALID_SELECTOR_XYZ" in err["message"] for err in report["errors"])


def test_validate_inputs_legacy_parameter_error(db_session, test_project, auth_headers):
    analysis = _make_analysis(db_session, test_project, "analysis-chemex-legacy")
    params = (FIXTURE_DIR / "Parameters" / "parameters.toml").read_text(encoding="utf-8") + "\n[DWP_AB]\nvalue = 1.0\n"
    res = client.post(
        _url(test_project, analysis.analysis_uuid, "validate"),
        json={"model": "2st", "parameter_toml": params, "include": ["13N"]},
        headers=auth_headers,
    )
    assert res.status_code == 200
    report = res.json()
    assert report["valid"] is False
    assert any("DWP_AB" in err["message"] for err in report["errors"])
    assert any(err.get("type") == "LegacyParameterError" for err in report["errors"])


def test_inspect_parameters(db_session, test_project, auth_headers):
    analysis = _make_analysis(db_session, test_project, "analysis-chemex-inspect")
    res = client.post(
        _url(test_project, analysis.analysis_uuid, "parameters/inspect"),
        json={"model": "2st", "include": ["13N"]},
        headers=auth_headers,
    )
    assert res.status_code == 200
    data = res.json()
    assert len(data["parameters"]) > 0
    p0 = data["parameters"][0]
    assert "status" in p0
    assert "is_shared" in p0
    assert "experiments" in data


def test_inspect_ignores_broken_saved_method(db_session, test_project, auth_headers):
    """Baseline inspection must not depend on (or fail because of) the saved method file."""
    analysis = _make_analysis(db_session, test_project, "analysis-chemex-brokenmethod")
    run_dir = Path(test_project.local_directory_path) / "cest_fitting" / analysis.analysis_uuid
    (run_dir / "Methods").mkdir()
    (run_dir / "Methods" / "method.toml").write_text("FORMAT_VERSION = 2\n[S]\nROLES = 3\n", encoding="utf-8")
    res = client.post(
        _url(test_project, analysis.analysis_uuid, "parameters/inspect"), json={"model": "2st"}, headers=auth_headers
    )
    assert res.status_code == 200, res.text
    assert any(p["name"] == "PB" for p in res.json()["parameters"])


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



def test_validate_and_inspect_with_lowercase_data(db_session, test_project, auth_headers):
    """Validate/inspect resolve lowercase data/ dirs referenced by experiment files."""
    analysis = _make_analysis(db_session, test_project, "analysis-cest-lowercase-data-1234", lowercase_data=True)
    payload = {"model": "2st", "include": ["13N"]}

    res_val = client.post(_url(test_project, analysis.analysis_uuid, "validate"), json=payload, headers=auth_headers)
    assert res_val.status_code == 200
    report = res_val.json()
    assert report["valid"] is True, f"Validation failed: {report.get('errors')}"
    assert report["errors"] == []

    res_insp = client.post(_url(test_project, analysis.analysis_uuid, "parameters/inspect"), json=payload, headers=auth_headers)
    assert res_insp.status_code == 200
    assert any(p["name"] == "PB" for p in res_insp.json()["parameters"])


def test_inspect_without_experiments_reports_error(db_session, test_project, auth_headers):
    """Before experiments are generated, inspect explains why instead of returning 500."""
    analysis = Analysis(analysis_uuid="analysis-chemex-empty", name="Empty", analysis_type="15N-CEST",
                        project_id=test_project.id, status="PENDING")
    db_session.add(analysis)
    db_session.commit()
    res = client.post(_url(test_project, analysis.analysis_uuid, "parameters/inspect"), json={"model": "2st"}, headers=auth_headers)
    assert res.status_code == 200
    body = res.json()
    assert body["parameters"] == []
    assert body["error"]


def test_validate_without_experiments_reports_error(db_session, test_project, auth_headers):
    analysis = Analysis(analysis_uuid="analysis-chemex-empty-v", name="EmptyV", analysis_type="15N-CEST",
                        project_id=test_project.id, status="PENDING")
    db_session.add(analysis)
    db_session.commit()
    res = client.post(_url(test_project, analysis.analysis_uuid, "validate"), json={"model": "2st"}, headers=auth_headers)
    assert res.status_code == 200
    assert res.json()["valid"] is False
    assert "experiment" in res.json()["errors"][0]["message"].lower()


def _resolve_url(project, analysis_uuid: str) -> str:
    """The single ChemEx-backed method validation route (validation + per-step resolution)."""
    return f"/api/projects/{project.project_uuid}/analysis/{analysis_uuid}/methods/validate"


def test_methods_resolve_from_frontend_config(db_session, test_project, auth_headers):
    """The frontend's camelCase MethodConfig is emitted to v2 TOML and resolved per step by ChemEx."""
    analysis = _make_analysis(db_session, test_project, "analysis-resolve-config")
    config = {
        "steps": [
            {"id": "a", "name": "GLOBAL_FIT", "residueMode": "include", "residues": ["13", "26"],
             "parameters": [{"name": "PB", "mode": "fit"}, {"name": "KEX_AB", "mode": "fit"}, {"name": "DW_AB", "mode": "fix"}]},
            {"id": "b", "name": "LOCAL_FITS", "residueMode": "include", "residues": [], "rolesFrom": "GLOBAL_FIT",
             "parameters": [{"name": "PB", "mode": "fix"}, {"name": "KEX_AB", "mode": "fix"}],
             "roleRules": [{"id": "r", "action": "FIT", "entries": ["DW_AB, NUC->26N"]}]},
        ]
    }
    res = client.post(_resolve_url(test_project, analysis.analysis_uuid), json={"model": "2st", "config": config}, headers=auth_headers)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["valid"] is True, body["errors"]
    assert 'ROLES_FROM = "GLOBAL_FIT"' in body["method_toml"]
    g, local = body["steps"]
    assert g["counts"]["fit"] >= 2
    dw26 = next(p for p in local["parameters"] if p["id"] == "__DW_AB_26N")
    # The rule is the 2nd ROLES action of LOCAL_FITS (after the table's FIX action).
    assert dw26["role"] == "fit" and dw26["rule"]["action_index"] == 1 and dw26["rule"]["step"] == "LOCAL_FITS"


def test_methods_resolve_raw_toml_errors_and_guards(db_session, test_project, auth_headers):
    analysis = _make_analysis(db_session, test_project, "analysis-resolve-raw")
    url = _resolve_url(test_project, analysis.analysis_uuid)
    bad = 'FORMAT_VERSION = 2\n\n[S]\nROLES = [{ FIT = ["PB, FOO->1"] }]\n'
    body = client.post(url, json={"method_toml": bad}, headers=auth_headers).json()
    assert body["valid"] is False
    assert body["errors"][0]["source"]["field"] == "ROLES[0].FIT[0]"

    assert client.post(url, json={}, headers=auth_headers).status_code == 422
    assert client.post(url, json={"method_toml": bad}).status_code == 401

    empty = Analysis(analysis_uuid="analysis-resolve-empty", name="E", analysis_type="15N-CEST",
                     project_id=test_project.id, status="PENDING")
    db_session.add(empty)
    db_session.commit()
    body = client.post(_resolve_url(test_project, "analysis-resolve-empty"), json={"method_toml": bad}, headers=auth_headers).json()
    assert body["errors"][0]["type"] == "MissingInputs"


def test_inspect_reports_protected_parameters(db_session, test_project, auth_headers):
    analysis = _make_analysis(db_session, test_project, "analysis-inspect-protected")
    rows = client.post(_url(test_project, analysis.analysis_uuid, "parameters/inspect"), json={"model": "2st"}, headers=auth_headers).json()["parameters"]
    by = {r["name"]: r for r in rows}
    assert by["KAB"]["protected"] is True
    assert by["PB"]["protected"] is False and by["PB"]["estimable"] is True


def test_step_timings_endpoint(db_session, test_project, auth_headers):
    """Durations come back with each step's fit count, recomputed once from the run's method snapshot."""
    analysis = _make_analysis(db_session, test_project, "analysis-timings")
    url = _url(test_project, analysis.analysis_uuid, "step-timings")
    assert client.get(url, headers=auth_headers).json() == {"state": None, "steps": [], "workers": None}
    run_dir = Path(test_project.local_directory_path) / "cest_fitting" / analysis.analysis_uuid
    (run_dir / "Methods").mkdir()
    (run_dir / "Methods" / "method.toml").write_text(
        'FORMAT_VERSION = 2\n\n[GRID]\nINCLUDE = [13, 26]\nROLES = [{ FIT = ["PB", "DW_AB"] }]\n\n'
        '[GRID.SEARCH.GRID]\nAXES = ["[PB] = values(0.01, 0.02, 0.03)", "[DW_AB] = lin(-5.0, 5.0, 4)"]\n\n[REFINE]\nROLES_FROM = "GRID"\n',
        encoding="utf-8",
    )
    (run_dir / "step_timings.json").write_text(
        '{"state": "DONE", "workers": 4, "steps": [{"name": "GRID", "index": 1, "seconds": 48.0}, {"name": "REFINE", "index": 2, "seconds": 2.5}]}',
        encoding="utf-8",
    )
    body = client.get(url, headers=auth_headers).json()
    grid, refine = body["steps"]
    assert grid["evaluations"] == 3 * (4 + 4)  # 3 global points × (4 local points for each of 2 residues)
    assert refine["evaluations"] == 1
    assert body["workers"] == 4
    assert '"evaluations"' in (run_dir / "step_timings.json").read_text()  # cached
    assert client.get(url).status_code == 401


def test_validation_is_consolidated_on_methods_validate(db_session, test_project, auth_headers):
    """One implementation: /methods/validate (editor) and /chemex/validate (run pre-flight) agree."""
    analysis = _make_analysis(db_session, test_project, "analysis-consolidated")
    bad = 'FORMAT_VERSION = 2\n\n[S]\nROLES = [{ FIX = ["PB"] }, { FIT = ["DW_AB, NUC->13N, NUC->26N"] }]\n'
    editor = client.post(_resolve_url(test_project, analysis.analysis_uuid), json={"toml": bad}, headers=auth_headers).json()
    preflight = client.post(_url(test_project, analysis.analysis_uuid, "validate"), json={"method_toml": bad}, headers=auth_headers).json()
    assert editor["valid"] is False and preflight["valid"] is False
    assert editor["errors"] == preflight["errors"]
    assert editor["errors"][0]["source"] == {
        "step": "S", "field": "ROLES[1].FIT[0]", "index": None, "start": 17, "end": 25,
        "action_index": 1, "action": "FIT", "entry_index": 0,
    }
    assert preflight["chemex_version"] == editor["chemex_version"] and editor["chemex_version"].startswith("2026.9")
    assert "warnings" in preflight and "steps" in preflight

    # Without a method, pre-flight checks the saved one, else ChemEx's default plan.
    default = client.post(_url(test_project, analysis.analysis_uuid, "validate"), json={"model": "2st"}, headers=auth_headers).json()
    assert default["valid"] is True and [s["name"] for s in default["steps"]] == ["DEFAULT"]

    # The Phase-1 /methods/resolve route is gone (folded into /methods/validate).
    gone = client.post(f"/api/projects/{test_project.project_uuid}/analysis/{analysis.analysis_uuid}/methods/resolve", json={"method_toml": bad}, headers=auth_headers)
    assert gone.status_code in (404, 405)


def test_legacy_names_are_reported_before_session_errors(db_session, test_project, auth_headers):
    analysis = _make_analysis(db_session, test_project, "analysis-legacy-method")
    body = client.post(
        _resolve_url(test_project, analysis.analysis_uuid),
        json={"method_toml": 'FORMAT_VERSION = 2\n\n[S]\nROLES = [{ FIT = ["DWP_AB"] }]\n'},
        headers=auth_headers,
    ).json()
    assert body["valid"] is False
    assert body["errors"][0]["type"] == "LegacyParameterError" and "DWP_AB" in body["errors"][0]["message"]


def test_last_run_method_endpoint(db_session, test_project, auth_headers):
    analysis = _make_analysis(db_session, test_project, "analysis-last-run")
    url = _url(test_project, analysis.analysis_uuid, "last-run-method")
    assert client.get(url, headers=auth_headers).json() == {"method_toml": None, "completed_at": None}
    run_dir = Path(test_project.local_directory_path) / "cest_fitting" / analysis.analysis_uuid
    # Individual fit mode archives per residue: Output/<residue>/run_info/inputs/methods.
    archived = run_dir / "Output" / "13N" / "run_info" / "inputs" / "methods"
    archived.mkdir(parents=True)
    (archived / "method.toml").write_text("FORMAT_VERSION = 2\n\n[A]\n", encoding="utf-8")
    assert client.get(url, headers=auth_headers).json()["method_toml"] == "FORMAT_VERSION = 2\n\n[A]\n"
    top = run_dir / "Output" / "run_info" / "inputs" / "methods"
    top.mkdir(parents=True)
    (top / "method.toml").write_text("FORMAT_VERSION = 2\n\n[GLOBAL]\n", encoding="utf-8")
    assert client.get(url, headers=auth_headers).json()["method_toml"] == "FORMAT_VERSION = 2\n\n[GLOBAL]\n"
    assert client.get(url).status_code == 401
