"""Methods-page run overview cached in the results bundle (Phase B).

Uses two real ChemEx 2026.9.2 trees: cest_step_grid (interior grid minimum, MCMC with a
tentative burn) and cest_grid_edge (minimum on the lower PB and upper KEX_AB grid edges).
"""

from __future__ import annotations

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
from app.services.results_bundle import store
from app.services.results_bundle.ingest import ingest_results
from app.services.results_bundle.run_overview import edge_position

TREES = Path(__file__).parent / "fixtures" / "chemex_trees_2026_9"


def _ingest(tmp_path: Path, tree: str) -> Path:
    run_dir = tmp_path / tree
    shutil.copytree(TREES / tree, run_dir / "Output")
    ingest_results(run_dir, analysis_uuid=tree, analysis_type="15N-CEST")
    return run_dir


def _step(ov: dict, name: str) -> dict:
    return next(s for s in ov["steps"] if s["name"] == name)


def test_edge_position():
    assert edge_position(0.01, [0.01, 0.0316, 0.1]) == "low"
    assert edge_position(200.0, [20.0, 63.2, 200.0]) == "high"
    assert edge_position(63.2, [20.0, 63.2, 200.0]) is None
    assert edge_position(None, [1.0, 2.0]) is None
    assert edge_position(1.0, [1.0]) is None


def test_grid_edge_detection_from_fixture(tmp_path: Path):
    ov = store.get_run_overview(_ingest(tmp_path, "cest_grid_edge"))
    assert ov is not None and ov["step_order"] == ["STEP1", "STEP2", "STEP3"]
    grid = _step(ov, "STEP1")["grid"]
    axes = {a["param"]: a for a in grid["axes"]}
    # Scale comes from the method snapshot (ChemEx's own output does not record it).
    assert axes["PB"]["fn"] == "log" and axes["KEX_AB"]["fn"] == "log"
    assert axes["PB"]["count"] == 3 and axes["PB"]["low"] == pytest.approx(0.01) and axes["PB"]["high"] == pytest.approx(0.1)
    assert axes["PB"]["best"] == pytest.approx(0.01) and axes["PB"]["edge"] == "low"
    assert axes["KEX_AB"]["best"] == pytest.approx(200.0) and axes["KEX_AB"]["edge"] == "high"
    assert grid["pairs"] == [["PB", "KEX_AB"]]
    assert _step(ov, "STEP2")["grid"] is None


def test_interior_minimum_has_no_edge(tmp_path: Path):
    ov = store.get_run_overview(_ingest(tmp_path, "cest_step_grid"))
    axes = {a["param"]: a for a in _step(ov, "STEP1")["grid"]["axes"]}
    assert axes["PB"]["edge"] is None and axes["KEX_AB"]["edge"] is None
    assert axes["PB"]["fn"] == "lin"


def test_committed_values_and_correlations(tmp_path: Path):
    ov = store.get_run_overview(_ingest(tmp_path, "cest_grid_edge"))
    s2 = _step(ov, "STEP2")
    assert s2["status"] == "complete" and s2["redchi"] == pytest.approx(0.907739, rel=1e-4)
    pb = s2["values"]["PB"]
    assert pb["scope"] == "global" and pb["roles"] == ["fit"]
    assert pb["copies"][0]["value"] == pytest.approx(0.0161252, rel=1e-4)
    assert pb["copies"][0]["stderr"] == pytest.approx(0.000568412, rel=1e-3)
    dw = s2["values"]["DW_AB"]
    assert dw["scope"] == "residue" and sorted(c["residue"] for c in dw["copies"]) == ["13N", "26N", "28N"]
    assert set(s2["residue_redchi"]) == {"13N", "26N", "28N"}
    # Covariance correlations (|ρ| ≥ 0.5) are read from ChemEx's evidence.
    cov = [c for c in s2["correlations"] if c["method"] == "Covariance"]
    assert len(cov) == 1
    assert {cov[0]["a"], cov[0]["b"]} == {"__PB", "__KEX_AB"} and cov[0]["rho"] == pytest.approx(-0.9498, abs=1e-3)


def test_mcmc_tentative_burn_and_withheld_ess(tmp_path: Path):
    ov = store.get_run_overview(_ingest(tmp_path, "cest_step_grid"))
    mcmc = _step(ov, "STEP2")["mcmc"]
    assert mcmc["tentative_burn"] is True
    assert mcmc["tau_max"] == pytest.approx(5.2254, rel=1e-4) and mcmc["tau_tentative"] is True
    assert mcmc["ess_withheld"] is True and mcmc["ess_min"] is None
    assert any("tentative" in w for w in mcmc["warnings"])


def test_grid_surface_both_orders(tmp_path: Path):
    run_dir = _ingest(tmp_path, "cest_grid_edge")
    s = store.get_grid_surface(run_dir, "STEP1", "PB", "KEX_AB")
    assert s["x_param"] == "PB" and len(s["x"]) == 3 and len(s["y"]) == 3
    assert s["min_point"]["x"] == pytest.approx(0.01) and s["min_point"]["y"] == pytest.approx(200.0)
    t = store.get_grid_surface(run_dir, "STEP1", "KEX_AB", "PB")
    assert t["x_param"] == "KEX_AB" and t["x"] == s["y"] and t["min_point"]["x"] == pytest.approx(200.0)
    assert t["z_chisqr"][0][1] == s["z_chisqr"][1][0]
    assert store.get_grid_surface(run_dir, "STEP2", "PB", "KEX_AB") is None


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
    user = models.User(email="ov@test.com", hashed_password=security.get_password_hash("pw123456"), is_active=True)
    db.add(user)
    db.commit()
    proj_dir = tmp_path / "proj"
    project = models.Project(name="P", local_directory_path=str(proj_dir), user_id=user.id)
    db.add(project)
    db.commit()
    analyses = {}
    for status in ("COMPLETED", "RUNNING"):
        a = models.Analysis(name=status, analysis_type="15N-CEST", project_id=project.id, status=status)
        db.add(a)
        db.commit()
        shutil.copytree(TREES / "cest_grid_edge", proj_dir / "cest_fitting" / a.analysis_uuid / "Output")
        analyses[status] = a.analysis_uuid
    headers = {"Authorization": f"Bearer {security.create_access_token({'sub': user.email})}"}
    yield TestClient(app), project.project_uuid, analyses, headers, proj_dir
    db.close()
    app.dependency_overrides.clear()


def test_endpoint_builds_once_then_serves_from_bundle(api):
    client, puuid, analyses, headers, _ = api
    base = f"/api/projects/{puuid}/analysis/{analyses['COMPLETED']}/chemex"
    r = client.get(f"{base}/run-overview", headers=headers)
    assert r.status_code == 200 and r.json()["available"] is True
    assert r.json()["overview"]["steps"][0]["grid"]["axes"][0]["edge"] in ("low", "high")
    # Second visit: no ChemEx output parsing at all.
    with patch("app.services.results_bundle.ingest.parse_output_tree", side_effect=RuntimeError("re-parsed!")):
        r2 = client.get(f"{base}/run-overview", headers=headers)
        assert r2.status_code == 200 and r2.json()["available"] is True
        s = client.get(f"{base}/steps/STEP1/grid-surface", params={"x": "KEX_AB", "y": "PB"}, headers=headers)
        assert s.status_code == 200 and s.json()["x_param"] == "KEX_AB"
        assert client.get(f"{base}/steps/STEP2/grid-surface", params={"x": "PB", "y": "KEX_AB"}, headers=headers).status_code == 404


def test_endpoint_hides_results_while_running(api):
    client, puuid, analyses, headers, _ = api
    r = client.get(f"/api/projects/{puuid}/analysis/{analyses['RUNNING']}/chemex/run-overview", headers=headers)
    assert r.status_code == 200 and r.json() == {"available": False, "completed_at": None, "overview": None}
