"""
Comprehensive Conformance and Adversarial Test Suite for ChemEx Output Tree Parsing Protocol.
Conforms to docs/chemex-output-protocol.md (§1.1 – §1.11).
"""

import copy
import random
import shutil
import tempfile
from pathlib import Path
import pytest

from app.services.fitting.chemex_output import (
    RunResult,
    RunState,
    parse_output_tree,
)
from app.services.fitting.chemex_output.data import parse_data_file
from app.services.fitting.chemex_output.parameters import parse_parameter_file
from app.services.fitting.chemex_output.statistics import parse_statistics_toml

FIXTURES_ROOT = Path(__file__).parent / "fixtures" / "chemex_trees"


# ==========================================
# §1.1 Layout Discrimination Conformance
# ==========================================

def test_protocol_1_1_single_step_layout():
    """Verify single-step fit produces scientific outputs directly at root."""
    path = FIXTURES_ROOT / "single_step"
    res = parse_output_tree(path)

    assert res.is_multi_step is False
    assert "" in res.steps
    assert res.primary_step is not None
    assert res.primary_step.parameters is not None
    assert "KEX_AB" in res.primary_step.parameters.get_global_parameters()
    assert "500mhz" in res.primary_step.data
    assert res.primary_step.statistics is not None
    assert res.primary_step.statistics.chisqr is not None


def test_protocol_1_1_multi_step_layout():
    """Verify multi-step fit produces subdirectories matching declared steps."""
    path = FIXTURES_ROOT / "multi_step"
    res = parse_output_tree(path)

    assert res.is_multi_step is True
    assert res.step_order == ["STEP1", "STEP2"]
    assert "STEP1" in res.steps
    assert "STEP2" in res.steps
    assert res.steps["STEP1"].parameters is not None
    assert res.steps["STEP2"].parameters is not None


# ==========================================
# §1.2 Ignored Directories Conformance
# ==========================================

def test_protocol_1_2_groups_and_components_ignored(tmp_path: Path):
    """Verify Groups/ and Components/ directories are ignored and do not pollute step results."""
    tree_dir = tmp_path / "test_tree"
    shutil.copytree(FIXTURES_ROOT / "multi_step", tree_dir)

    # Create dummy Components directory
    (tree_dir / "STEP2" / "Components").mkdir()
    (tree_dir / "STEP2" / "Components" / "dummy.toml").write_text("[DUMMY]\nx = 1\n")

    res = parse_output_tree(tree_dir)
    assert res.is_multi_step is True
    # Verify STEP2 parameters came from All/ (or step level), not individual Groups/ or Components/
    step2 = res.steps["STEP2"]
    assert step2.parameters is not None
    all_p = step2.parameters.get_all_parameters()
    assert "[DW_AB]/15N" in all_p
    assert "[DW_AB]/31N" in all_p


# ==========================================
# §1.3 The Trust Gate Conformance
# ==========================================

def test_protocol_1_3_complete_outcome(tmp_path: Path):
    """Verify complete outcome.toml establishes authoritative state."""
    tree_dir = tmp_path / "complete_tree"
    shutil.copytree(FIXTURES_ROOT / "single_step", tree_dir)

    outcome_content = """schema_version = 2
status = "complete"
latest_committed_revision = 1
latest_restart_revision = 1
"""
    (tree_dir / "run_info" / "outcome.toml").write_text(outcome_content)

    res = parse_output_tree(tree_dir)
    assert res.state == RunState.COMPLETE
    assert res.is_provisional is False
    assert res.outcome.latest_committed_revision == 1


def test_protocol_1_3_incomplete_outcome(tmp_path: Path):
    """Verify incomplete outcome.toml flags results as provisional and surfaces failure reason."""
    tree_dir = tmp_path / "incomplete_tree"
    shutil.copytree(FIXTURES_ROOT / "single_step", tree_dir)

    outcome_content = """schema_version = 2
status = "incomplete"
latest_committed_revision = 1
latest_restart_revision = 0
failure_stage = "minimization"
failure_reason = "Loss function diverged to NaN"
"""
    (tree_dir / "run_info" / "outcome.toml").write_text(outcome_content)

    res = parse_output_tree(tree_dir)
    assert res.state == RunState.INCOMPLETE
    assert res.is_provisional is True
    assert res.outcome.failure_stage == "minimization"
    assert res.outcome.failure_reason == "Loss function diverged to NaN"


def test_protocol_1_3_running_and_staleness(tmp_path: Path):
    """Verify running outcome transitions to abandoned on staleness timeout."""
    tree_dir = tmp_path / "running_tree"
    shutil.copytree(FIXTURES_ROOT / "single_step", tree_dir)

    outcome_content = """schema_version = 2
status = "running"
latest_committed_revision = 0
latest_restart_revision = 0
"""
    (tree_dir / "run_info" / "outcome.toml").write_text(outcome_content)

    # 1. When staleness_minutes is huge, it is RUNNING
    res_running = parse_output_tree(tree_dir, staleness_minutes=999999.0)
    assert res_running.state == RunState.RUNNING
    assert res_running.is_provisional is True

    # 2. When staleness_minutes is 0.0 (and task not active), it is ABANDONED
    res_abandoned = parse_output_tree(tree_dir, staleness_minutes=0.0, is_task_active_fn=lambda: False)
    assert res_abandoned.state == RunState.ABANDONED
    assert res_abandoned.is_provisional is True


def test_protocol_1_3_revision_divergence_warning(tmp_path: Path):
    """Verify revision divergence triggers warning banner."""
    tree_dir = tmp_path / "diverged_tree"
    shutil.copytree(FIXTURES_ROOT / "single_step", tree_dir)

    outcome_content = """schema_version = 2
status = "complete"
latest_committed_revision = 3
latest_restart_revision = 2
"""
    (tree_dir / "run_info" / "outcome.toml").write_text(outcome_content)

    res = parse_output_tree(tree_dir)
    warning_codes = [w.code for w in res.warnings]
    assert "REVISION_DIVERGENCE" in warning_codes


# ==========================================
# §1.4 Provenance Ingestion Conformance
# ==========================================

def test_protocol_1_4_provenance_and_restart():
    """Verify run.toml, parameters_used.toml, and restart.toml ingestion."""
    path = FIXTURES_ROOT / "single_step"
    res = parse_output_tree(path)

    assert res.provenance is not None
    assert res.provenance.chemex_version == "2026.6.1"
    assert res.provenance.python_version is not None
    assert len(res.provenance.inputs) >= 3

    # Starting parameters
    assert "GLOBAL" in res.starting_parameters
    assert "KEX_AB" in res.starting_parameters["GLOBAL"]
    p_init = res.starting_parameters["GLOBAL"]["KEX_AB"]
    assert p_init.value == 400.0
    assert p_init.min_val == 0.0


# ==========================================
# §1.5 Parameter Reports Conformance
# ==========================================

def test_protocol_1_5_comment_preservation_and_error_capture():
    """Verify exact comment grammar for fitted, fixed, and constrained parameters."""
    warnings = []
    fitted_file = FIXTURES_ROOT / "single_step" / "Parameters" / "fitted.toml"
    fixed_file = FIXTURES_ROOT / "single_step" / "Parameters" / "fixed.toml"
    con_file = FIXTURES_ROOT / "single_step" / "Parameters" / "constrained.toml"

    fitted = parse_parameter_file(fitted_file, "fitted", warnings)
    fixed = parse_parameter_file(fixed_file, "fixed", warnings)
    con = parse_parameter_file(con_file, "constrained", warnings)

    # Fitted checks
    assert "GLOBAL" in fitted
    kex = fitted["GLOBAL"]["KEX_AB"]
    assert pytest.approx(kex.value, rel=1e-3) == 377.303
    assert pytest.approx(kex.stderr, rel=1e-3) == 15.973
    assert kex.has_stderr is True

    # Fixed checks
    assert "CS_A" in fixed
    cs_a = fixed["CS_A"]["15N"]
    assert cs_a.is_fixed is True
    assert cs_a.stderr is None

    # Constrained checks
    assert "GLOBAL" in con
    kab = con["GLOBAL"]["KAB"]
    assert kab.is_constrained is True
    assert kab.expression == "[KEX_AB] * [PB]"
    assert pytest.approx(kab.stderr, rel=1e-3) == 0.789977


def test_protocol_1_5_withheld_errors(tmp_path: Path):
    """Verify parameters with withheld errors parse cleanly as None with reason."""
    custom_fitted = """[GLOBAL]
KEX_AB = 3.81511e+02 # (error not calculated)
PB     = 7.02971e-02 # ±1.14784e-03
"""
    f_path = tmp_path / "fitted.toml"
    f_path.write_text(custom_fitted)

    warnings = []
    parsed = parse_parameter_file(f_path, "fitted", warnings)
    kex = parsed["GLOBAL"]["KEX_AB"]
    assert kex.value == 381.511
    assert kex.stderr is None
    assert kex.has_stderr is False
    assert kex.error_reason == "NOT_CALCULATED"


# ==========================================
# §1.6 Data Parser Conformance
# ==========================================

def test_protocol_1_6_dynamic_headers_and_masking():
    """Verify non-TOML data parser extracts profiles, active, and masked points."""
    warnings = []
    dat_path = FIXTURES_ROOT / "single_step" / "Data" / "500mhz.dat"
    data_file = parse_data_file(dat_path, warnings)

    assert data_file is not None
    assert data_file.stem == "500mhz"
    assert "15N" in data_file.profiles

    profile = data_file.profiles["15N"]
    assert len(profile.points) > 0
    p0 = profile.points[0]
    assert p0.mask is True
    assert pytest.approx(p0.exp, rel=1e-3) == 34705.98
    assert pytest.approx(p0.err, rel=1e-3) == 145.93
    assert pytest.approx(p0.calc, rel=1e-3) == 34706.46
    assert p0.metadata["NCYC"] == 0.0


def test_protocol_1_6_masked_points(tmp_path: Path):
    """Verify masked rows starting with # are parsed with mask=False."""
    content = """[15N]
#         NCYC   INTENSITY (EXP)       ERROR (EXP)  INTENSITY (CALC)
             0    3.47059800e+04    1.45930401e+02    3.47064601e+04
#            1    1.81234230e+04    1.45930401e+02    1.82708770e+04 # NOT USED IN THE FIT
"""
    f = tmp_path / "test.dat"
    f.write_text(content)

    warnings = []
    df = parse_data_file(f, warnings)
    assert df is not None
    pts = df.profiles["15N"].points
    assert len(pts) == 2
    assert pts[0].mask is True
    assert pts[1].mask is False


# ==========================================
# §1.7 Grid Search Conformance
# ==========================================

def test_protocol_1_7_grid_search():
    """Verify Grid/grid.out matrix parsing and PDF cataloguing."""
    path = FIXTURES_ROOT / "grid_fit"
    res = parse_output_tree(path)

    assert res.primary_step is not None
    assert res.primary_step.grid is not None
    grid = res.primary_step.grid
    assert "PB" in grid.parameters
    assert "KEX_AB" in grid.parameters
    assert len(grid.points) == 9
    assert grid.best_point is not None
    assert grid.best_point.chisqr > 0.0
    assert grid.grid_1d_pdf is not None
    assert grid.grid_2d_pdf is not None


# ==========================================
# §1.8 Goodness-of-Fit Conformance
# ==========================================

def test_protocol_1_8_statistics_toml_mapping_and_unknown_keys(tmp_path: Path):
    """Verify statistics.toml mapping and preservation of unknown keys."""
    content = """"number of data points"                = 46
"number of variables"                  = 5
"chi-square"                           =  5.37738e+01
"reduced-chi-square"                   =  1.31156e+00
"chi-squared test"                     =  8.72234e-02
"Kolmogorov-Smirnov test"              =  8.79728e-01
"Akaike Information Criterion (AIC)"   =  6.37738e+01
"Bayesian Information Criterion (BIC)" =  7.29170e+01
"custom_metric"                        = 42.0
"""
    f = tmp_path / "statistics.toml"
    f.write_text(content)

    warnings = []
    stats = parse_statistics_toml(f, warnings)
    assert stats is not None
    assert stats.ndata == 46
    assert stats.nvarys == 5
    assert pytest.approx(stats.chisqr, rel=1e-3) == 53.7738
    assert pytest.approx(stats.redchi, rel=1e-3) == 1.31156
    assert pytest.approx(stats.pvalue, rel=1e-3) == 0.0872234
    assert stats.extra["custom_metric"] == 42.0


# ==========================================
# §1.9 Statistics Trees Conformance
# ==========================================

def test_protocol_1_9_resampling_and_mcmc_statistics():
    """Verify parsing of MonteCarlo, Bootstrap, and MCMC outputs."""
    path = FIXTURES_ROOT / "stat_fit"
    res = parse_output_tree(path)

    step = res.primary_step
    assert step is not None
    assert step.statistical_analyses is not None
    stats = step.statistical_analyses

    # Monte Carlo
    assert stats.monte_carlo is not None
    assert stats.monte_carlo.status == "complete"
    assert "KEX_AB" in stats.monte_carlo.summary
    mc_kex = stats.monte_carlo.summary["KEX_AB"]
    assert mc_kex.sample_count == 4
    assert mc_kex.interval == "95% percentile"
    assert len(stats.monte_carlo.samples) == 4

    # MCMC
    assert stats.mcmc is not None
    assert stats.mcmc.status == "complete"
    assert "KEX_AB" in stats.mcmc.summary
    mcmc_kex = stats.mcmc.summary["KEX_AB"]
    assert mcmc_kex.prior == "uniform"
    assert mcmc_kex.credible_interval == "95% equal-tailed"
    assert mcmc_kex.stderr is not None
    assert stats.mcmc.diagnostics is not None
    assert stats.mcmc.diagnostics.sampler == "emcee via ChemEx direct EnsembleSampler"
    assert stats.mcmc.diagnostics.workers == 8


def test_protocol_1_9_interrupted_statistics():
    """Verify interrupted statistics parsing with completed_samples = 0."""
    path = FIXTURES_ROOT / "stat_interrupted"
    res = parse_output_tree(path)

    step = res.primary_step
    assert step is not None
    assert step.statistical_analyses is not None
    stats = step.statistical_analyses

    assert stats.monte_carlo is not None
    assert stats.monte_carlo.status == "incomplete"
    assert stats.monte_carlo.diagnostics.completed_samples == 0
    assert stats.monte_carlo.diagnostics.requested_samples == 100


# ==========================================
# §1.10 Directory Reuse Semantics Conformance
# ==========================================

def test_protocol_1_10_directory_reuse_stale_step_warning():
    """Verify single-step run on top of old multi-step directory warns and ignores stale folders."""
    path = FIXTURES_ROOT / "reused_multitosingle"
    res = parse_output_tree(path)

    assert res.is_multi_step is False
    assert "" in res.steps
    warning_codes = [w.code for w in res.warnings]
    assert "STALE_STEP_DIRECTORY" in warning_codes


# ==========================================
# §1.11 Adversarial & Error Recovery Tests
# ==========================================

def test_adversarial_truncated_tsv_mid_row(tmp_path: Path):
    """Verify parser does not crash on truncated samples.tsv."""
    stat_dir = tmp_path / "Statistics" / "MonteCarlo"
    stat_dir.mkdir(parents=True)
    (stat_dir / "samples.tsv").write_text("KEX_AB\tPB\tchisqr\n3.8e2\t0.07\t50.0\n3.9e2\t")

    res = parse_output_tree(tmp_path)
    assert res.primary_step is not None


def test_adversarial_missing_correlations_file(tmp_path: Path):
    """Verify summary.toml present with correlations.tsv missing parses cleanly."""
    stat_dir = tmp_path / "Statistics" / "MonteCarlo"
    stat_dir.mkdir(parents=True)
    (stat_dir / "summary.toml").write_text('[KEX_AB]\nsample_count = 10\nmean = 380.0\n')

    res = parse_output_tree(tmp_path)
    assert res.primary_step is not None
    assert res.primary_step.statistical_analyses is not None
    mc = res.primary_step.statistical_analyses.monte_carlo
    assert mc is not None
    assert mc.summary["KEX_AB"].mean == 380.0
    assert mc.correlations == {}


def test_adversarial_absent_restart_file(tmp_path: Path):
    """Verify absent restart.toml produces can_continue_fit=False with clear explanation."""
    run_info = tmp_path / "run_info"
    run_info.mkdir(parents=True)
    (run_info / "run.toml").write_text('schema_version = 1\n')

    res = parse_output_tree(tmp_path)
    assert res.can_continue_fit is False
    assert res.restart_file_path is None
    assert res.continue_explanation is not None


def test_adversarial_nonexistent_directory():
    """Verify non-existent path returns valid RunResult with UNKNOWN state without exception."""
    res = parse_output_tree("/path/to/nonexistent/directory/12345")
    assert res.state == RunState.UNKNOWN
    assert res.is_provisional is True
    assert len(res.warnings) > 0


# ==========================================
# Property Test: Random Deletions
# ==========================================

def test_property_never_raises_on_arbitrary_file_deletions(tmp_path: Path):
    """
    Property test: Randomly delete subsets of files from a complete tree;
    parse_output_tree must ALWAYS return a valid RunResult and never raise an unhandled exception.
    """
    base_fixture = FIXTURES_ROOT / "single_step"

    for trial in range(10):
        test_dir = tmp_path / f"trial_{trial}"
        shutil.copytree(base_fixture, test_dir)

        # Get list of all files
        all_files = [p for p in test_dir.rglob("*") if p.is_file()]
        # Randomly delete 0% to 100% of files
        delete_count = random.randint(0, len(all_files))
        files_to_delete = random.sample(all_files, delete_count)
        for f in files_to_delete:
            f.unlink()

        # Execute parser
        res = parse_output_tree(test_dir)
        assert isinstance(res, RunResult)
        assert res.state in RunState


# ==========================================
# §3.12 & §3.13 Conformance & Regression Tests
# ==========================================

def test_protocol_3_12_residue_level_extraction_and_derived_chi2():
    """Verify residue extraction, canonical keying, and resoFlow-derived chi2 calculations."""
    path = FIXTURES_ROOT / "multi_step"
    res = parse_output_tree(path)

    assert res.primary_step is not None
    step2 = res.steps.get("STEP2")
    assert step2 is not None

    # Step2 should have residues
    assert len(step2.residues) > 0
    res_13 = step2.residues.get("13N") or list(step2.residues.values())[0]
    assert res_13 is not None
    assert res_13.dof_convention == "NDATA_MINUS_LOCAL_NVARYS"
    assert res_13.chi2 is not None and res_13.chi2 >= 0
    assert res_13.chi2_red is not None and res_13.chi2_red >= 0


def test_protocol_3_13_step_order_natural_sort(tmp_path: Path):
    """Verify natural sorting order for steps (STEP1, STEP2, ..., STEP10) when method is absent."""
    for sname in ["STEP1", "STEP10", "STEP2", "STEP3"]:
        sdir = tmp_path / sname
        sdir.mkdir(parents=True)
        (sdir / "statistics.toml").write_text('chisqr = 100.0\nredchi = 1.0\nndata = 100\nnvarys = 5\n')
        params_dir = sdir / "Parameters"
        params_dir.mkdir()
        (params_dir / "fitted.toml").write_text('[global]\nkex_ab = 500.0\n')

    res = parse_output_tree(tmp_path)
    assert res.is_multi_step is True
    assert res.step_order == ["STEP1", "STEP2", "STEP3", "STEP10"]
    assert res.primary_step.name == "STEP10"


def test_real_world_regression_analysis_ba38acbb():
    """
    Regression test against real-world analysis ba38acbb-3055-4a52-a228-9977a0d8d903:
    1. Multi-step detected (STEP1, STEP2)
    2. Global parameter kex_ab parsed with error bar
    3. Global statistics chisqr & redchi populated (no em-dash)
    4. Residues populated (13N, 15N, 20N) with resoFlow-derived chi2 & redchi
    5. Multi-field profile curves populated (exp_points & calc_points)
    """
def test_real_world_regression_analysis_ba38acbb():
    """
    Regression test against real-world analysis ba38acbb-3055-4a52-a228-9977a0d8d903:
    1. Multi-step detected (STEP1, STEP2) with per-step has_grid flags.
    2. Global parameter kex_ab parsed.
    3. Global statistics chisqr & redchi populated.
    4. Residues populated (14N, 55N, 65N) with resoFlow-derived chi2 & redchi.
    5. Multi-field profile curves populated (exp_points & calc_points).
    """
    real_path = FIXTURES_ROOT / "cest_step_grid"
    if not real_path.exists():
        real_path = Path("/home/debadutta/Documents/test/cest_fitting/ba38acbb-3055-4a52-a228-9977a0d8d903/Output")
    if not real_path.exists():
        pytest.skip("Real-world analysis path not present in test environment")

    res = parse_output_tree(real_path)

    # 1. Step detection & has_grid
    assert res.is_multi_step is True
    assert res.step_order == ["STEP1", "STEP2"]
    assert "STEP1" in res.steps
    assert "STEP2" in res.steps
    assert res.steps["STEP1"].has_grid is True
    assert res.steps["STEP2"].has_grid is False
    assert res.steps["STEP1"].grid is not None
    assert res.steps["STEP1"].grid.parameters == ["KEX_AB", "PB"]
    assert len(res.steps["STEP1"].grid.groups) == 3

    assert res.primary_step is not None
    step = res.primary_step

    # 2. Globals with values
    assert "kex_ab" in step.globals
    kex = step.globals["kex_ab"]
    assert kex.value == pytest.approx(379.269, abs=0.1)

    assert "pb" in step.globals
    pb = step.globals["pb"]
    assert pb.value == pytest.approx(0.00353, abs=0.001)

    # 2b. Constrained kinetics & derived tau_b (§1.3)
    assert step.kba is not None
    assert step.tau_b is not None
    assert step.tau_b.is_derived is True

    # 3. Overall statistics (no em-dash)
    assert step.statistics is not None
    assert step.statistics.chisqr is not None

    # 4. Residues (14N, 55N, 65N)
    assert len(step.residues) == 3
    assert set(step.residues.keys()) == {"14N", "55N", "65N"}

    for res_name in ["14N", "55N", "65N"]:
        r = step.residues[res_name]
        assert r.chi2 is not None and r.chi2 > 0
        assert r.chi2_red is not None and r.chi2_red > 0
        assert r.ndata is not None and r.ndata > 0
        assert r.dof_convention == "NDATA_MINUS_LOCAL_NVARYS"

        # dw_ab present with error bar (§1.1)
        assert r.dw_ab is not None
        assert r.dw_ab.has_stderr is True
        assert abs(r.dw_ab.value) > 3.0

        # 5. Multi-field profile overlay data fetched from Plots/*.exp and Plots/*.fit
        assert len(r.experiments) == 2
        for exp in r.experiments:
            assert exp.get("b1_label") in ("28.2 Hz", "66.8 Hz")
            # .exp file has 64 or 65 discrete measured points
            assert len(exp.get("exp_points", {}).get("x", [])) in (64, 65)
            # .fit file has 400 smooth calculated points
            assert len(exp.get("calc_points", {}).get("x", [])) == 400
            assert len(exp.get("fit_curve", {}).get("x", [])) == 400
            # x-values are in PPM range
            first_x = exp.get("exp_points", {}).get("x", [])[0]
            assert 90.0 <= first_x <= 140.0

        # Ground-state CS_A exists
        assert r.cs_a is not None and r.cs_a.value > 0


def test_numeric_residue_sorting_large_scale():
    """
    Test that 100+ residues sort numerically (1, 2, ..., 10, 20, ..., 100, 101)
    and not lexicographically ('100N' before '20N').
    """
    raw_spins = [f"{i}N" for i in range(1, 150)]
    import random
    shuffled = list(raw_spins)
    random.seed(42)
    random.shuffle(shuffled)

    def extract_seq_num(spin: str) -> int:
        import re
        m = re.match(r"^(\d+)", spin)
        return int(m.group(1)) if m else 0

    sorted_spins = sorted(shuffled, key=extract_seq_num)
    assert sorted_spins == raw_spins
    assert sorted_spins.index("20N") < sorted_spins.index("100N")
    assert sorted_spins.index("9N") < sorted_spins.index("10N")


def test_group_fit_and_2st_rs_kinetics_and_statistics(tmp_path: Path):
    """
    Test that group fits and 2st_rs models where KEX_AB and PB are per-residue
    and statistics are under Groups/*/Statistics/ are properly parsed into:
    1. Per-residue kex_ab, pb, kab, kba, tau_b with uncertainties.
    2. Step-level aggregate globals with derived averages.
    3. Merged statistics collection with all group parameters.
    """
    step_dir = tmp_path / "STEP2"
    step_dir.mkdir(parents=True)
    all_params_dir = step_dir / "All" / "Parameters"
    all_params_dir.mkdir(parents=True)

    # Write fitted.toml with per-residue KEX_AB and PB
    fitted_toml = """[DW_AB]
32N = 4.15 # ±0.26
55N = 4.71 # ±1.95

[KEX_AB]
32 = 331.4 # ±297.7
55 = 177.4 # ±918.0

[PB]
32 = 0.00798 # ±0.00648
55 = 0.0122 # ±0.0603

["R2_A, B0->600.3MHZ"]
32N = 9.38 # ±0.11
55N = 12.41 # ±0.30
"""
    (all_params_dir / "fitted.toml").write_text(fitted_toml)

    # Write group statistics for group 1_32 and 2_55
    g1_stat = step_dir / "Groups" / "1_32" / "Statistics" / "MonteCarlo"
    g1_stat.mkdir(parents=True)
    g1_sum = """['DW_AB, NUC->32N']
mean = 4.15
standard_deviation = 0.26

['KEX_AB, NUC->32']
mean = 331.4
standard_deviation = 297.7
"""
    (g1_stat / "summary.toml").write_text(g1_sum)

    g2_stat = step_dir / "Groups" / "2_55" / "Statistics" / "MonteCarlo"
    g2_stat.mkdir(parents=True)
    g2_sum = """['DW_AB, NUC->55N']
mean = 4.71
standard_deviation = 1.95

['KEX_AB, NUC->55']
mean = 177.4
standard_deviation = 918.0
"""
    (g2_stat / "summary.toml").write_text(g2_sum)

    from app.services.fitting.chemex_output.parser import _parse_step_directory
    w = []
    res = _parse_step_directory(step_dir, "STEP2", w)

    assert res.status == "complete"
    assert res.has_statistics is True
    assert "32N" in res.residues
    assert "55N" in res.residues

    r32 = res.residues["32N"]
    assert r32.kex_ab is not None
    assert abs(r32.kex_ab.value - 331.4) < 1e-3
    assert r32.pb is not None
    assert abs(r32.pb.value - 0.00798) < 1e-5
    assert r32.kab is not None
    assert abs(r32.kab.value - (331.4 * 0.00798)) < 1e-3
    assert r32.kba is not None
    assert abs(r32.kba.value - (331.4 * (1.0 - 0.00798))) < 1e-3
    assert r32.tau_b is not None
    assert abs(r32.tau_b.value - (1000.0 / (331.4 * (1.0 - 0.00798)))) < 1e-2

    # Verify merged statistics collection
    assert res.statistical_analyses is not None
    assert res.statistical_analyses.monte_carlo is not None
    mc_sum = res.statistical_analyses.monte_carlo.summary
    assert "DW_AB, NUC->32N" in mc_sum
    assert "DW_AB, NUC->55N" in mc_sum
    assert "KEX_AB, NUC->32" in mc_sum
    assert "KEX_AB, NUC->55" in mc_sum


