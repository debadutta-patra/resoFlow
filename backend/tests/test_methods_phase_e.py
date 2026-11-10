"""Phase E backend: quick test runs on one residue (E8) and "Load method from run…" history (E7)."""

from __future__ import annotations

import shutil
import tomllib
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import database, models, security
from app.main import app
from app.services.fitting.test_run import execute_test_run, make_test_method, read_status

FIXTURES = Path(__file__).parent / "fixtures"
CEST_INPUTS = FIXTURES / "baselines" / "2026.6.1" / "cest_15n" / "inputs"
TREES = FIXTURES / "chemex_trees_2026_9"

METHOD = """FORMAT_VERSION = 2

[STEP1]
INCLUDE = ["13N", "26N", "28N"]
ROLES = [
  { FIT = ["PB", "KEX_AB", "DW_AB", "CS_A"] },
]

[STEP1.SEARCH.GRID]
AXES = [
  "[PB] = log(0.01, 0.1, 10)",
  "[KEX_AB] = values(20.0, 50.0, 100.0, 200.0, 400.0)",
]

[STEP2]
ROLES_FROM = "STEP1"
INCLUDE = ["13N", "26N", "28N"]
STATISTICS = { MC = 10, MCMC = { STEPS = 500 } }
"""


def test_make_test_method_reduces_selection_grid_and_statistics():
    reduced = tomllib.loads(make_test_method(METHOD, "26N"))
    assert reduced["STEP1"]["INCLUDE"] == ["26N"] and reduced["STEP2"]["INCLUDE"] == ["26N"]
    assert "STATISTICS" not in reduced["STEP2"]
    assert reduced["STEP2"]["ROLES_FROM"] == "STEP1"
    axes = reduced["STEP1"]["SEARCH"]["GRID"]["AXES"]
    assert axes == ["[PB] = log(0.01, 0.1, 3)", "[KEX_AB] = values(20, 100, 400)"]


def test_make_test_method_rejects_unparseable_methods():
    with pytest.raises(ValueError):
        make_test_method("this is [not toml", "13N")


def _run_dir(tmp_path: Path) -> Path:
    run_dir = tmp_path / "run"
    for sub in ("Data", "Experiments", "Parameters"):
        shutil.copytree(CEST_INPUTS / sub, run_dir / sub)
    return run_dir


def test_execute_test_run_is_isolated_and_records_step_timings(tmp_path: Path):
    if not CEST_INPUTS.exists():
        pytest.skip("cest_15n inputs not found")
    run_dir = _run_dir(tmp_path)
    method = make_test_method('FORMAT_VERSION = 2\n\n[QUICK]\nROLES = [{ FIT = ["PB", "KEX_AB", "DW_AB"] }]\n', "13N")
    status = execute_test_run(run_dir, "t1", method, None, "2st", "13N", None)
    assert status["state"] == "done", status.get("error")
    assert [s["name"] for s in status["steps"]] == ["QUICK"]
    assert status["steps"][0]["seconds"] > 0 and status["steps"][0]["evaluations"] == 1
    assert read_status(run_dir, "t1")["state"] == "done"
    # The analysis's own outputs are untouched.
    assert not (run_dir / "Output").exists() and not (run_dir / "results").exists()
    assert (run_dir / "test_runs" / "t1" / "job" / "Output").is_dir()


def test_execute_test_run_reports_failures(tmp_path: Path):
    run_dir = _run_dir(tmp_path)
    status = execute_test_run(run_dir, "t2", 'FORMAT_VERSION = 2\n\n[S]\nROLES = [{ FIT = ["NOPE"] }]\nINCLUDE = ["13N"]\n', None, "2st", "13N", None)
    assert status["state"] == "failed" and "No parameter matches selector" in status["error"]


@pytest.fixture()
def api(tmp_path: Path):
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    models.Base.metadata.create_all(bind=engine)
    Session = sessionmaker(autocommit=False, autoflush=False, bind=engine)

    def override_get_db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[database.get_db] = override_get_db
    db = Session()
    user = models.User(email="e@test.com", hashed_password=security.get_password_hash("pw123456"), is_active=True)
    db.add(user)
    db.commit()
    proj_dir = tmp_path / "proj"
    project = models.Project(name="P", local_directory_path=str(proj_dir), user_id=user.id)
    db.add(project)
    db.commit()
    made = {}
    for name, status, atype in (("done", "COMPLETED", "15N-CEST"), ("busy", "RUNNING", "15N-CEST"), ("cpmg", "COMPLETED", "CPMG")):
        a = models.Analysis(name=name, analysis_type=atype, project_id=project.id, status=status, summary_redchi=0.91)
        db.add(a)
        db.commit()
        made[name] = a.analysis_uuid
    run = proj_dir / "cest_fitting" / made["done"]
    shutil.copytree(TREES / "cest_grid_edge", run / "Output")
    shutil.copytree(TREES / "cest_step_grid", run / "Output_bak")
    (proj_dir / "cest_fitting" / made["busy"]).mkdir(parents=True)
    headers = {"Authorization": f"Bearer {security.create_access_token({'sub': user.email})}"}
    yield TestClient(app), project.project_uuid, made, headers, proj_dir
    db.close()
    app.dependency_overrides.clear()


def test_test_run_endpoints(api):
    client, puuid, made, headers, proj_dir = api
    base = f"/api/projects/{puuid}/analysis/{made['done']}/chemex"
    with patch("app.services.fitting.test_run.run_test_fit_task.apply_async") as dispatch:
        r = client.post(f"{base}/test-run", json={"method_toml": METHOD, "residue": "13N"}, headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["state"] == "queued" and 'INCLUDE = ["13N"]' in body["method_toml"]
    dispatch.assert_called_once()
    assert client.get(f"{base}/test-run/{body['test_id']}", headers=headers).json()["state"] == "queued"
    assert client.get(f"{base}/test-run/latest", headers=headers).json()["test"]["test_id"] == body["test_id"]
    assert client.get(f"{base}/test-run/nope", headers=headers).status_code == 404
    # A queued test is not used for estimates; a finished one is.
    assert client.get(f"{base}/step-timings", headers=headers).json()["test"] is None
    from app.services.fitting.test_run import write_status

    write_status(proj_dir / "cest_fitting" / made["done"], body["test_id"], {**body, "state": "done", "steps": [{"name": "STEP1", "seconds": 2.0, "evaluations": 9}]})
    assert client.get(f"{base}/step-timings", headers=headers).json()["test"]["steps"][0]["evaluations"] == 9
    # Never while a real run is active.
    busy = f"/api/projects/{puuid}/analysis/{made['busy']}/chemex/test-run"
    assert client.post(busy, json={"method_toml": METHOD, "residue": "13N"}, headers=headers).status_code == 409


def test_method_history_lists_runs_and_backups_of_the_family(api):
    client, puuid, made, headers, _ = api
    runs = client.get(f"/api/projects/{puuid}/chemex/method-history", params={"family": "cest"}, headers=headers).json()["runs"]
    assert {(r["analysis_uuid"], r["source"]) for r in runs} == {(made["done"], "current"), (made["done"], "backup")}
    current = next(r for r in runs if r["source"] == "current")
    assert current["steps"] == ["STEP1", "STEP2", "STEP3"] and current["redchi"] == pytest.approx(0.91)
    assert "[STEP1.SEARCH.GRID]" in current["method_toml"]
    backup = next(r for r in runs if r["source"] == "backup")
    assert backup["steps"] == ["STEP1", "STEP2"]
    assert client.get(f"/api/projects/{puuid}/chemex/method-history", params={"family": "cpmg"}, headers=headers).json()["runs"] == []
