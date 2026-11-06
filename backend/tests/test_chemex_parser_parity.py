"""
Parity and Schema Snapshot Tests between ChemEx 2026.6 and 2026.9 Output Trees.

Verifies:
1. parse_chemex_run_parameters produce matching top-level keys and structure for 2026.6 and 2026.9.
2. parse_output_tree returns matching StepResult schema and parameter structures.
3. Grid parser v1 and v2 produce identical contract shapes for GridSearchSection.tsx and analysis router.
4. Statistics parser normalizes field names consistently (uncertainty_kind, 68% intervals and widths).
5. ReportModel builds identically across versions.
"""

from pathlib import Path
import pytest

from app.services.fitting.chemex_parser import parse_chemex_run_parameters
from app.services.fitting.chemex_output import parse_output_tree
from app.services.fitting.chemex_output.grid import parse_grid_directory
from app.services.fitting.chemex_output.grid_parser_v2 import (
    load_v2_1d_profiles,
    load_v2_2d_surface,
    parse_v2_grid_summary,
)
from app.services.reporting.model import build_report_model

FIXTURES_2026_6 = Path(__file__).parent / "fixtures" / "chemex_trees"
FIXTURES_2026_9 = Path(__file__).parent / "fixtures" / "chemex_trees_2026_9"


def test_parse_chemex_run_parameters_schema_parity():
    """Verify parse_chemex_run_parameters produces identical JSON schema between 2026.6 and 2026.9."""
    for case in ["single_step", "multi_step"]:
        res_6 = parse_chemex_run_parameters(str(FIXTURES_2026_6 / case))
        res_9 = parse_chemex_run_parameters(str(FIXTURES_2026_9 / case))

        # 1. Top-level dictionary keys must match exactly
        assert set(res_6.keys()) == set(res_9.keys()), f"Mismatch in top-level keys for {case}"

        # 2. Fit mode
        assert res_6["fit_mode"] == res_9["fit_mode"]

        # 3. Residue keys
        assert set(res_6["residues"].keys()) == set(res_9["residues"].keys())

        # 4. Globals keys
        assert set(res_6["globals"].keys()) == set(res_9["globals"].keys())

        # 5. Global parameter inner shape
        for gname in res_6["globals"]:
            g6 = res_6["globals"][gname]
            g9 = res_9["globals"][gname]
            assert set(g6.keys()) == set(g9.keys())
            assert isinstance(g9["value"], (int, float))

        # 6. Residue parameter inner shape
        for rname in res_6["residues"]:
            r6 = res_6["residues"][rname]
            r9 = res_9["residues"][rname]
            assert set(r6.keys()) == set(r9.keys())
            for pname in r6:
                if isinstance(r6[pname], dict):
                    assert set(r6[pname].keys()) == set(r9[pname].keys())

        # 7. Statistics keys
        assert set(res_6["statistics"].keys()) == set(res_9["statistics"].keys())


def test_parse_output_tree_schema_parity():
    """Verify parse_output_tree StepResult has matching structure on both layouts."""
    for case in ["single_step", "multi_step", "grid_fit", "stat_fit"]:
        tree_6 = parse_output_tree(FIXTURES_2026_6 / case)
        tree_9 = parse_output_tree(FIXTURES_2026_9 / case)

        assert tree_6.is_multi_step == tree_9.is_multi_step
        assert tree_6.step_order == tree_9.step_order
        assert tree_6.state == tree_9.state

        step_6 = tree_6.primary_step
        step_9 = tree_9.primary_step
        assert (step_6 is not None) == (step_9 is not None)
        if step_6 and step_9:
            assert set(step_6.globals.keys()) == set(step_9.globals.keys())
            assert set(step_6.residues.keys()) == set(step_9.residues.keys())
            assert (step_6.grid is not None) == (step_9.grid is not None)
            if case == "stat_fit":
                assert step_6.statistical_analyses is not None
                assert step_9.statistical_analyses is not None
                assert step_6.statistical_analyses.monte_carlo is not None
                assert step_9.statistical_analyses.monte_carlo is not None


def test_grid_v2_and_v1_api_parity():
    """Verify grid parsing on v1 and v2 produces matching contracts for UI consumption."""
    grid_6 = parse_grid_directory(FIXTURES_2026_6 / "grid_fit" / "Grid", warnings=[])
    grid_9 = parse_grid_directory(FIXTURES_2026_9 / "grid_fit" / "Grid", warnings=[])

    assert grid_6 is not None
    assert grid_9 is not None

    # Both recognize grid parameters PB and KEX_AB
    assert set(grid_6.parameters) == set(grid_9.parameters) == {"PB", "KEX_AB"}
    assert len(grid_6.points) == len(grid_9.points) == 9

    assert grid_6.best_point is not None
    assert grid_9.best_point is not None
    assert grid_6.best_point.chisqr > 0
    assert grid_9.best_point.chisqr > 0

    assert grid_6.grid_1d_pdf is not None
    assert grid_9.grid_1d_pdf is not None
    assert grid_6.grid_2d_pdf is not None
    assert grid_9.grid_2d_pdf is not None

    # 1D profiles contract
    v2_1d = load_v2_1d_profiles(FIXTURES_2026_9 / "grid_fit" / "Grid")
    assert len(v2_1d) == 2
    for p in v2_1d:
        for key in ["parameter", "values", "x", "chisqr", "delta_chisqr", "min_val", "min_x", "min_chisqr"]:
            assert key in p

    # 2D surface contract
    v2_2d = load_v2_2d_surface(FIXTURES_2026_9 / "grid_fit" / "Grid")
    assert v2_2d is not None
    for key in ["x_param", "y_param", "x", "y", "z_chisqr", "z_delta", "min_point", "available_parameters"]:
        assert key in v2_2d


def test_statistics_normalization_schema_parity():
    """Verify statistics summaries populate both legacy and 2026.9 uncertainty fields."""
    stat_6 = parse_output_tree(FIXTURES_2026_6 / "stat_fit").primary_step.statistical_analyses
    stat_9 = parse_output_tree(FIXTURES_2026_9 / "stat_fit").primary_step.statistical_analyses

    assert stat_6 is not None
    assert stat_9 is not None

    # Monte Carlo summary
    mc_6 = stat_6.monte_carlo.summary["KEX_AB"]
    mc_9 = stat_9.monte_carlo.summary["KEX_AB"]

    # Both must have legacy fields
    assert mc_6.stderr is not None and mc_9.stderr is not None
    assert mc_6.lower_1sigma is not None and mc_9.lower_1sigma is not None
    assert mc_6.upper_1sigma is not None and mc_9.upper_1sigma is not None

    # Both must have normalized 2026.9 fields
    assert mc_6.percentile_68_lower is not None and mc_9.percentile_68_lower is not None
    assert mc_6.percentile_68_upper is not None and mc_9.percentile_68_upper is not None
    assert mc_6.half_percentile_68_width is not None and mc_9.half_percentile_68_width is not None
    assert mc_6.uncertainty_kind == mc_9.uncertainty_kind == "mc"

    # MCMC summary
    mcmc_6 = stat_6.mcmc.summary["KEX_AB"]
    mcmc_9 = stat_9.mcmc.summary["KEX_AB"]

    assert mcmc_6.stderr is not None and mcmc_9.stderr is not None
    assert mcmc_6.credible_interval_68_lower is not None and mcmc_9.credible_interval_68_lower is not None
    assert mcmc_6.credible_interval_68_upper is not None and mcmc_9.credible_interval_68_upper is not None
    assert mcmc_6.half_credible_interval_68_width is not None and mcmc_9.half_credible_interval_68_width is not None
    assert mcmc_6.uncertainty_kind == mcmc_9.uncertainty_kind == "mcmc"


def test_report_model_schema_parity():
    """Verify build_report_model produces matching dictionary keys on 2026.6 and 2026.9 trees."""
    for case in ["single_step", "multi_step", "stat_fit"]:
        m_6 = build_report_model(str(FIXTURES_2026_6 / case), "test_proj", analysis_type="CPMG")
        m_9 = build_report_model(str(FIXTURES_2026_9 / case), "test_proj", analysis_type="CPMG")

        d_6 = m_6.to_dict()
        d_9 = m_9.to_dict()

        assert set(d_6.keys()) == set(d_9.keys()), f"Mismatch in report model keys for {case}"
        assert len(d_6["residues"]) == len(d_9["residues"])
        assert len(d_6["global_params"]) == len(d_9["global_params"])
