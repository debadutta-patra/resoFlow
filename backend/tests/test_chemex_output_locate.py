"""
Unit tests for ChemEx artifact locator (locate.py).
"""

import tempfile
from pathlib import Path
import pytest

from app.services.fitting.chemex_output import locate

FIXTURES_ROOT = Path(__file__).parent / "fixtures" / "chemex_trees"


def test_locate_single_step_fixture():
    single = FIXTURES_ROOT / "single_step"
    if not single.exists():
        pytest.skip("single_step fixture missing")

    assert locate.resolve_run_dir(single) == single
    assert locate.step_names(single) == []
    assert locate.fitted_params(single) == single / "Parameters" / "fitted.toml"
    assert locate.fixed_params(single) == single / "Parameters" / "fixed.toml"
    assert locate.constrained_params(single) == single / "Parameters" / "constrained.toml"
    assert len(locate.data_files(single)) == 2
    assert locate.statistics_toml(single) == single / "statistics.toml"
    assert locate.plots_dir(single) == single / "Plots"
    assert len(locate.plot_files(single)) >= 3


def test_locate_multi_step_fixture():
    multi = FIXTURES_ROOT / "multi_step"
    if not multi.exists():
        pytest.skip("multi_step fixture missing")

    steps = locate.step_names(multi)
    assert steps == ["STEP1", "STEP2"]

    # STEP1 has direct Parameters/fitted.toml
    step1_fitted = locate.fitted_params(multi, "STEP1")
    assert step1_fitted == multi / "STEP1" / "Parameters" / "fitted.toml"

    # STEP2 in 2026.6 legacy has All/Parameters/fitted.toml
    step2_fitted = locate.fitted_params(multi, "STEP2")
    assert step2_fitted == multi / "STEP2" / "All" / "Parameters" / "fitted.toml"

    # Last step lookup when step_name is None
    last_fitted = locate.fitted_params(multi)
    assert last_fitted == step2_fitted


def test_locate_grid_and_stat_fixtures():
    grid_fit = FIXTURES_ROOT / "grid_fit"
    if grid_fit.exists():
        assert locate.grid_dir(grid_fit) == grid_fit / "Grid"

    stat_fit = FIXTURES_ROOT / "stat_fit"
    if stat_fit.exists():
        mc_dir = locate.statistics_dir(stat_fit, "MonteCarlo")
        assert mc_dir == stat_fit / "Statistics" / "MonteCarlo"
        bs_dir = locate.statistics_dir(stat_fit, "bootstrap")
        assert bs_dir == stat_fit / "Statistics" / "Bootstrap"
        mcmc_dir = locate.statistics_dir(stat_fit, "mcmc")
        assert mcmc_dir == stat_fit / "Statistics" / "MCMC"


def test_locate_synthetic_v2026_9():
    with tempfile.TemporaryDirectory() as tmp_dir:
        root = Path(tmp_dir)
        step1 = root / "STEP1"
        (step1 / "Parameters").mkdir(parents=True)
        (step1 / "Parameters" / "fitted.toml").write_text("[DW_AB]\n", encoding="utf-8")
        (step1 / "Data").mkdir(parents=True)
        (step1 / "Data" / "exp.dat").write_text("", encoding="utf-8")
        (step1 / "Grid").mkdir(parents=True)
        (step1 / "Grid" / "summary.toml").write_text('status = "complete"\n', encoding="utf-8")
        (step1 / "Statistics" / "MonteCarlo").mkdir(parents=True)

        assert locate.step_names(root) == ["STEP1"]
        assert locate.fitted_params(root, "STEP1") == step1 / "Parameters" / "fitted.toml"
        assert len(locate.data_files(root, "STEP1")) == 1
        assert locate.grid_dir(root, "STEP1") == step1 / "Grid"
        assert locate.statistics_dir(root, "mc", "STEP1") == step1 / "Statistics" / "MonteCarlo"
