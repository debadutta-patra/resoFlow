"""
Tests for Grid Search Parser, Profile Likelihood, 2D Surface, and Output Protocol.
"""

from pathlib import Path
import numpy as np
import pytest

from app.services.fitting.chemex_output.grid_parser import (
    compute_1d_profiles,
    compute_2d_surface,
    compute_grid_minimum,
    extract_residue_label_from_filename,
    find_grid_out_files,
    get_grid_data_for_group,
    load_grid_file,
)
from app.services.fitting.chemex_output.grid import parse_grid_directory
from app.services.fitting.chemex_output.parser import parse_output_tree

FIXTURES_DIR = Path(__file__).parent / "fixtures" / "chemex_trees" / "cest_step_grid"


def test_load_grid_file_header_and_data():
    """Verify loading real .out file extracts parameter names, order, and chi2 column."""
    out_file = FIXTURES_DIR / "STEP1" / "Grid" / "Groups" / "1_14N.out"
    if not out_file.exists():
        pytest.skip("Fixture 1_14N.out not found")

    param_names, data = load_grid_file(out_file)
    assert param_names == ["KEX_AB", "PB"]
    assert data.shape == (400, 3)
    assert data[0, 0] == pytest.approx(10.0)
    assert data[0, 1] == pytest.approx(0.001)
    assert data[0, 2] == pytest.approx(2719.02, abs=0.1)


def test_compute_grid_minimum():
    """Verify finding the global minimum chi-square and its coordinates."""
    out_file = FIXTURES_DIR / "STEP1" / "Grid" / "Groups" / "1_14N.out"
    if not out_file.exists():
        pytest.skip("Fixture 1_14N.out not found")

    param_names, data = load_grid_file(out_file)
    min_info = compute_grid_minimum(param_names, data)

    assert min_info["chisqr"] == pytest.approx(101.005, abs=0.01)
    assert min_info["coordinates"]["KEX_AB"] == pytest.approx(483.293, abs=0.1)
    assert min_info["coordinates"]["PB"] == pytest.approx(0.00413311, abs=0.0001)


def test_compute_1d_profiles():
    """Verify profile likelihood minimization over other parameters."""
    out_file = FIXTURES_DIR / "STEP1" / "Grid" / "Groups" / "1_14N.out"
    if not out_file.exists():
        pytest.skip("Fixture 1_14N.out not found")

    param_names, data = load_grid_file(out_file)
    profiles = compute_1d_profiles(param_names, data)

    assert len(profiles) == 2
    p_kex = next(p for p in profiles if p["parameter"] == "KEX_AB")
    p_pb = next(p for p in profiles if p["parameter"] == "PB")

    assert len(p_kex["x"]) == 20
    assert len(p_kex["chisqr"]) == 20
    assert len(p_kex["delta_chisqr"]) == 20
    # Minimum delta chi-square must be 0.0 at the minimum point
    assert min(p_kex["delta_chisqr"]) == pytest.approx(0.0, abs=1e-6)

    assert len(p_pb["x"]) == 20
    assert min(p_pb["delta_chisqr"]) == pytest.approx(0.0, abs=1e-6)


def test_compute_2d_surface():
    """Verify 2D contour mesh generation with delta chi2 values."""
    out_file = FIXTURES_DIR / "STEP1" / "Grid" / "Groups" / "1_14N.out"
    if not out_file.exists():
        pytest.skip("Fixture 1_14N.out not found")

    param_names, data = load_grid_file(out_file)
    surface = compute_2d_surface(param_names, data, "KEX_AB", "PB")

    assert surface["x_param"] == "KEX_AB"
    assert surface["y_param"] == "PB"
    assert len(surface["x"]) == 20
    assert len(surface["y"]) == 20
    assert len(surface["z_chisqr"]) == 20
    assert len(surface["z_chisqr"][0]) == 20
    assert len(surface["z_delta"]) == 20

    # Minimum point coordinates
    assert surface["min_point"]["x"] == pytest.approx(483.293, abs=0.1)
    assert surface["min_point"]["y"] == pytest.approx(0.00413311, abs=0.0001)


def test_get_grid_data_aggregated_and_mapped():
    """Verify multi-group sum aggregation and group name resolution."""
    grid_dir = FIXTURES_DIR / "STEP1" / "Grid"
    if not grid_dir.exists():
        pytest.skip("Grid dir not found")

    res_map = {"14N": "C14N", "55N": "Q55N", "65N": "L65N"}

    # 1. Specific group
    pnames, data_14n, label_14n = get_grid_data_for_group(grid_dir, "C14N", residue_mapping=res_map)
    assert label_14n == "C14N"
    assert data_14n.shape == (400, 3)

    # 2. All groups
    pnames, agg_data, label_all = get_grid_data_for_group(grid_dir, None, residue_mapping=res_map)
    assert label_all == "All Groups"
    assert agg_data.shape == (400, 3)
    min_agg = compute_grid_minimum(pnames, agg_data)
    assert min_agg["coordinates"]["KEX_AB"] == pytest.approx(379.269, abs=0.1)
    assert min_agg["coordinates"]["PB"] == pytest.approx(0.00353022, abs=0.0001)


def test_parse_grid_directory_and_step_has_grid():
    """Verify StepResult has_grid flag and GridResultModel population."""
    tree = parse_output_tree(FIXTURES_DIR)
    assert "STEP1" in tree.steps
    assert "STEP2" in tree.steps

    assert tree.steps["STEP1"].has_grid is True
    assert tree.steps["STEP2"].has_grid is False

    g1 = tree.steps["STEP1"].grid
    assert g1 is not None
    assert g1.has_grid is True
    assert g1.grid_1d_pdf is not None
    assert g1.grid_2d_pdf is not None
    assert g1.parameters == ["KEX_AB", "PB"]
    assert "PB" in g1.specs
    assert g1.specs["PB"].scale == "log"
    assert g1.specs["PB"].min_val == 0.001
    assert g1.specs["PB"].max_val == 0.02
    assert g1.specs["PB"].num_points == 20

    assert len(g1.groups) == 3
    assert g1.groups[0].raw_key == "1_14N"
    assert g1.groups[0].residue == "14N"


def test_grid_endpoints_integration(tmp_path: Path):
    """Test FastAPI endpoints for grid search info, 1d profiles, and 2d surface."""
    import shutil
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool
    from app import database, models, security
    from app.main import app

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

    db = TestingSessionLocal()
    user = models.User(
        email="gridtest@test.com",
        hashed_password=security.get_password_hash("pass"),
        full_name="Grid User",
        is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    project_dir = tmp_path / "project"
    project_dir.mkdir()
    project = models.Project(
        project_uuid="proj-grid-123",
        name="Grid Test Project",
        user_id=user.id,
        local_directory_path=str(project_dir),
    )
    db.add(project)
    db.commit()
    db.refresh(project)

    # Setup CEST fitting folder with fixture
    run_dir = project_dir / "cest_fitting" / "analysis-grid-456"
    shutil.copytree(FIXTURES_DIR, run_dir / "Output")
    # Also write a config.json with residue mapping
    (run_dir / "config.json").write_text('{"residue_mapping": {"14N": "C14N", "55N": "Q55N", "65N": "L65N"}}')

    analysis = models.Analysis(
        analysis_uuid="analysis-grid-456",
        name="Grid Analysis",
        analysis_type="CEST",
        project_id=project.id,
        status="COMPLETED",
        results_path=str(run_dir / "results.json"),
    )
    db.add(analysis)
    db.commit()

    token = security.create_access_token({"sub": user.email})
    headers = {"Authorization": f"Bearer {token}"}

    # 1. GET STEP1 grid info
    r1 = client.get("/api/projects/proj-grid-123/analysis/analysis-grid-456/steps/STEP1/grid", headers=headers)
    assert r1.status_code == 200
    d1 = r1.json()
    assert d1["has_grid"] is True
    assert d1["parameters"] == ["KEX_AB", "PB"]
    assert d1["has_1d_pdf"] is True
    assert d1["has_2d_pdf"] is True
    assert len(d1["groups"]) == 3
    assert d1["groups"][0]["display_name"] == "C14N"
    assert d1["min_point"]["coordinates"]["KEX_AB"] == pytest.approx(379.269, abs=0.1)

    # 2. GET STEP2 grid info (no grid)
    r2 = client.get("/api/projects/proj-grid-123/analysis/analysis-grid-456/steps/STEP2/grid", headers=headers)
    assert r2.status_code == 200
    d2 = r2.json()
    assert d2["has_grid"] is False

    # 3. GET 1D profiles for STEP1
    r_1d = client.get("/api/projects/proj-grid-123/analysis/analysis-grid-456/steps/STEP1/grid/1d", headers=headers)
    assert r_1d.status_code == 200
    d_1d = r_1d.json()
    assert len(d_1d["profiles"]) == 2
    assert d_1d["profiles"][0]["parameter"] == "KEX_AB"
    assert len(d_1d["profiles"][0]["x"]) == 20

    # 4. GET 2D surface for STEP1
    r_2d = client.get("/api/projects/proj-grid-123/analysis/analysis-grid-456/steps/STEP1/grid/2d?x=KEX_AB&y=PB", headers=headers)
    assert r_2d.status_code == 200
    d_2d = r_2d.json()
    assert d_2d["x_param"] == "KEX_AB"
    assert d_2d["y_param"] == "PB"
    assert len(d_2d["z_delta"]) == 20
    assert len(d_2d["z_delta"][0]) == 20

    # 5. GET raw PDF
    r_pdf = client.get("/api/projects/proj-grid-123/analysis/analysis-grid-456/steps/STEP1/grid/plots/grid_1d.pdf", headers=headers)
    assert r_pdf.status_code == 200
    assert r_pdf.headers["content-type"] == "application/pdf"

    app.dependency_overrides.clear()


def test_bracketed_header_with_residue_tag(tmp_path: Path):
    """Verify parsing header containing residue-tagged parameter names with commas and spaces."""
    sample_file = tmp_path / "1_14N.out"
    content = (
        "# [DW_AB, NUC->14N] [KEX_AB] [PB] [χ²]\n"
        "6.84211 483.293 0.00353022 115.476\n"
        "4.73684 615.848 0.00413311 120.500\n"
    )
    sample_file.write_text(content, encoding="utf-8")

    param_names, data = load_grid_file(sample_file)
    assert param_names == ["DW_AB, NUC->14N", "KEX_AB", "PB"]
    assert data.shape == (2, 4)
    assert data[0, 0] == pytest.approx(6.84211)
    assert data[0, 1] == pytest.approx(483.293)
    assert data[0, 2] == pytest.approx(0.00353022)
    assert data[0, 3] == pytest.approx(115.476)
