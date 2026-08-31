"""
Tests for ChemEx uncertainty statistics output parser (Monte Carlo, Bootstrap, BootstrapNS, MCMC).
"""

import os
from pathlib import Path
import pytest
from app.services.fitting.statistics_parser import parse_statistics_directory


def test_parse_empty_statistics_directory(tmp_path: Path):
    """When no Statistics/ directory exists, parser returns has_statistics=False."""
    result = parse_statistics_directory(str(tmp_path))
    assert result["has_statistics"] is False
    assert result["methods"] == {}


def test_parse_monte_carlo_directory(tmp_path: Path):
    """Test parsing a completed Monte Carlo run output."""
    mc_dir = tmp_path / "Statistics" / "MonteCarlo"
    mc_dir.mkdir(parents=True)

    # 1. summary.toml
    summary_content = """["PB"]
interval = "95% percentile"
sample_count = 100
mean = 7.02971e-02
standard_deviation = 1.14784e-03
median = 7.01234e-02
percentile_95_lower = 6.81234e-02
percentile_95_upper = 7.25678e-02
lower_1sigma = 6.91234e-02
upper_1sigma = 7.13456e-02
stderr = 1.11110e-03

["KEX_AB"]
interval = "95% percentile"
sample_count = 100
mean = 3.81511e+02
standard_deviation = 8.90870e+00
median = 3.81000e+02
percentile_95_lower = 3.65000e+02
percentile_95_upper = 3.98000e+02
lower_1sigma = 3.73000e+02
upper_1sigma = 3.90000e+02
stderr = 8.50000e+00
"""
    (mc_dir / "summary.toml").write_text(summary_content)

    # 2. diagnostics.toml
    diag_content = """method = "Monte Carlo"
fitmethod = "leastsq"
requested_samples = 100
completed_samples = 100
workers = 4
parameters = ["PB", "KEX_AB"]
samples_file = "samples.tsv"
summary_file = "summary.toml"
correlations_file = "correlations.tsv"
plots_file = "plots.pdf"
"""
    (mc_dir / "diagnostics.toml").write_text(diag_content)

    # 3. correlations.tsv
    corr_content = "parameter\tPB\tKEX_AB\nPB\t1.00000e+00\t-4.50000e-01\nKEX_AB\t-4.50000e-01\t1.00000e+00\n"
    (mc_dir / "correlations.tsv").write_text(corr_content)

    # 4. samples.tsv
    samples_content = "PB\tKEX_AB\tchisqr\n7.0e-2\t3.8e2\t12.5\n7.1e-2\t3.7e2\t11.9\n"
    (mc_dir / "samples.tsv").write_text(samples_content)

    # 5. plots.pdf
    (mc_dir / "plots.pdf").write_bytes(b"%PDF-1.4 mock pdf content")

    res = parse_statistics_directory(str(tmp_path))
    assert res["has_statistics"] is True
    assert "monte_carlo" in res["methods"]

    mc = res["methods"]["monte_carlo"]
    assert mc["method_name"] == "Monte Carlo"
    assert mc["status"] == "completed"
    assert mc["has_plots_pdf"] is True
    assert mc["sample_count"] == 100

    # Verify parsed parameters
    assert "PB" in mc["summary"]
    pb_stat = mc["summary"]["PB"]
    assert pb_stat["median"] == pytest.approx(0.0701234)
    assert pb_stat["stderr"] == pytest.approx(0.0011111)

    assert "KEX_AB" in mc["summary"]
    kex_stat = mc["summary"]["KEX_AB"]
    assert kex_stat["mean"] == pytest.approx(381.511)

    # Verify correlations
    assert mc["correlations"]["parameters"] == ["PB", "KEX_AB"]
    assert mc["correlations"]["matrix"][0][1] == pytest.approx(-0.45)


def test_parse_mcmc_converged_directory(tmp_path: Path):
    """Test parsing a fully converged MCMC run."""
    mcmc_dir = tmp_path / "Statistics" / "MCMC"
    mcmc_dir.mkdir(parents=True)

    summary_content = """["PB"]
prior = "uniform"
prior_lower = 0.00000e+00
prior_upper = 5.00000e-01
credible_interval = "95% equal-tailed"
mean = 7.02971e-02
standard_deviation = 1.14784e-03
median = 7.01234e-02
eti_95_lower = 6.81234e-02
eti_95_upper = 7.25678e-02
lower_1sigma = 6.91234e-02
upper_1sigma = 7.13456e-02
stderr = 1.11110e-03
effective_sample_size = 5.36000e+03
mcse_mean = 1.56789e-05
"""
    (mcmc_dir / "summary.toml").write_text(summary_content)

    diag_content = """sampler = "emcee via ChemEx direct EnsembleSampler"
lmfit_version = "1.3.2"
emcee_version = "3.1.6"
credible_interval = "95% equal-tailed"
convergence_diagnostic = "integrated_autocorrelation_time"
autocorrelation_status = "reliable"
steps = 5000
requested_burn = "auto"
discarded_steps = 120
thin = 1
walkers = 64
workers = 4
retained_steps = 4880
retained_samples = 312320
acceptance_fraction_mean = 2.45000e-01
autocorrelation_time = [ 5.82341e+01 ]
max_autocorrelation_time = 5.82341e+01
steps_over_max_autocorrelation_time = 8.58603e+01
min_effective_sample_size = 5.36000e+03
"""
    (mcmc_dir / "diagnostics.toml").write_text(diag_content)

    res = parse_statistics_directory(str(tmp_path))
    assert res["has_statistics"] is True
    assert "mcmc" in res["methods"]

    mcmc = res["methods"]["mcmc"]
    assert mcmc["status"] == "converged"
    assert mcmc["autocorrelation_status"] == "reliable"
    assert mcmc["retained_samples"] == 312320
    assert mcmc["summary"]["PB"]["effective_sample_size"] == pytest.approx(5360.0)


def test_parse_mcmc_underconverged_withheld_summary(tmp_path: Path):
    """
    Test ChemEx's under-converged MCMC status:
    When chain is too short for 50*tau, ChemEx withholds ESS and marks autocorrelation_status = "unreliable_short_chain".
    Parser must surface status = 'diagnostics_available_summary_withheld' with explicit reason.
    """
    mcmc_dir = tmp_path / "Statistics" / "MCMC"
    mcmc_dir.mkdir(parents=True)

    summary_content = """["PB"]
prior = "uniform"
prior_lower = 0.0
prior_upper = 0.5
credible_interval = "95% equal-tailed"
mean = 0.070
standard_deviation = 0.001
median = 0.070
eti_95_lower = 0.068
eti_95_upper = 0.072
lower_1sigma = 0.069
upper_1sigma = 0.071
stderr = 0.001
"""
    (mcmc_dir / "summary.toml").write_text(summary_content)

    diag_content = """sampler = "emcee via ChemEx direct EnsembleSampler"
autocorrelation_status = "unreliable_short_chain"
autocorrelation_warning = "chain shorter than 50 times the autocorrelation time; tentative estimate reported"
effective_sample_size_warning = "not reported: autocorrelation time estimate is unreliable"
steps = 500
requested_burn = "auto"
discarded_steps = 40
thin = 1
walkers = 32
retained_steps = 460
retained_samples = 14720
max_autocorrelation_time_tentative = 35.5
"""
    (mcmc_dir / "diagnostics.toml").write_text(diag_content)

    res = parse_statistics_directory(str(tmp_path))
    assert res["has_statistics"] is True
    mcmc = res["methods"]["mcmc"]
    assert mcmc["status"] == "diagnostics_available_summary_withheld"
    assert "chain shorter than 50 times" in mcmc["withheld_reason"]
    assert mcmc["summary"]["PB"]["effective_sample_size"] is None
