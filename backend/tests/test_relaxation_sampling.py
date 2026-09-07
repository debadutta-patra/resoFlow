# Copyright (C) 2026 resoFlow Authors
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.

import os
from pathlib import Path
import numpy as np
import pytest

from app.services.fitting.relaxation_sampling import (
    run_single_peak_monte_carlo,
    run_single_peak_bootstrap,
    run_single_peak_mcmc,
    run_relaxation_resampling_analysis,
    save_relaxation_statistics_files,
)
from app.services.fitting.relaxation_uncertainty import compute_relaxation_covariance
from app.services.fitting.statistics_engine import load_replicates_or_fallback
from app.services.fitting.statistics_parser import parse_statistics_directory


def test_monte_carlo_single_peak_shape_and_covariance_agreement():
    """Verify Monte Carlo replicates match asymptotic covariance standard errors within sampling noise."""
    times = np.array([0.01, 0.05, 0.1, 0.2, 0.4, 0.6, 0.8, 1.2], dtype=np.float64)
    true_amp = 1000.0
    true_rate = 2.0
    noise_sigma = 10.0
    sigmas = np.full_like(times, noise_sigma)

    # Calculate asymptotic covariance standard errors
    cov_errs, _, _ = compute_relaxation_covariance(times, true_amp * np.exp(-true_rate * times), sigmas, true_amp, true_rate)
    cov_rate_err = cov_errs["rate_err"]
    cov_amp_err = cov_errs["amplitude_err"]

    rng = np.random.default_rng(42)
    n_samples = 600
    reps, chisqr, diag = run_single_peak_monte_carlo(
        times, sigmas, true_amp, true_rate, n_samples=n_samples, rng=rng
    )

    assert reps.shape == (n_samples, 2)
    assert chisqr.shape == (n_samples,)
    assert diag["failures"] == 0

    mc_amp_sd = float(np.std(reps[:, 0], ddof=1))
    mc_rate_sd = float(np.std(reps[:, 1], ddof=1))

    # MC standard errors should agree with asymptotic covariance within 15%
    rel_diff_rate = abs(mc_rate_sd - cov_rate_err) / cov_rate_err
    rel_diff_amp = abs(mc_amp_sd - cov_amp_err) / cov_amp_err

    assert rel_diff_rate < 0.15, f"MC rate SD ({mc_rate_sd}) differs from Covariance ({cov_rate_err}) by {rel_diff_rate:.1%}"
    assert rel_diff_amp < 0.15, f"MC amp SD ({mc_amp_sd}) differs from Covariance ({cov_amp_err}) by {rel_diff_amp:.1%}"


def test_monte_carlo_seed_reproducibility():
    """Verify that providing the same seed produces bit-identical replicate matrices."""
    times = np.array([0.02, 0.06, 0.12, 0.25, 0.5, 1.0], dtype=np.float64)
    sigmas = np.full_like(times, 12.0)
    amp = 850.0
    rate = 1.6

    rng1 = np.random.default_rng(12345)
    reps1, _, _ = run_single_peak_monte_carlo(times, sigmas, amp, rate, n_samples=100, rng=rng1)

    rng2 = np.random.default_rng(12345)
    reps2, _, _ = run_single_peak_monte_carlo(times, sigmas, amp, rate, n_samples=100, rng=rng2)

    np.testing.assert_array_equal(reps1, reps2)


def test_run_relaxation_resampling_analysis_monte_carlo():
    """Verify multi-peak Monte Carlo analysis orchestration and point estimate preservation."""
    times = [0.01, 0.05, 0.1, 0.2, 0.4, 0.8]
    peaks = [
        {
            "assignment": "15N-G23",
            "rate": 1.45,
            "amplitude": 1200.0,
            "times": times,
            "intensities": [1200.0 * np.exp(-1.45 * t) for t in times],
            "intensities_err": [10.0] * len(times),
        },
        {
            "assignment": "15N-K24",
            "rate": 2.10,
            "amplitude": 950.0,
            "times": times,
            "intensities": [950.0 * np.exp(-2.10 * t) for t in times],
            "intensities_err": [8.0] * len(times),
        },
    ]

    u_res, rep_matrix, p_names, chi_arr, diag = run_relaxation_resampling_analysis(
        peak_results=peaks,
        analysis_type="R1",
        method="monte_carlo",
        n_samples=200,
        seed=999,
    )

    assert u_res.method == "monte_carlo"
    assert rep_matrix.shape == (200, 4)  # 2 peaks * 2 params
    assert len(p_names) == 4
    assert p_names[0] == "R1, NUC->15N-G23"
    assert p_names[1] == "I0, NUC->15N-G23"
    assert p_names[2] == "R1, NUC->15N-K24"
    assert p_names[3] == "I0, NUC->15N-K24"

    # Deterministic point estimates must remain 100% bit-identical
    assert u_res.point_estimate["R1, NUC->15N-G23"] == 1.45
    assert u_res.point_estimate["I0, NUC->15N-G23"] == 1200.0
    assert u_res.point_estimate["R1, NUC->15N-K24"] == 2.10
    assert u_res.point_estimate["I0, NUC->15N-K24"] == 950.0

    # Confidence intervals must be well-ordered
    for p in p_names:
        int_68 = u_res.intervals[p].interval_68
        int_95 = u_res.intervals[p].interval_95
        assert int_95[0] <= int_68[0] < int_68[1] <= int_95[1]


def test_save_relaxation_statistics_files_monte_carlo(tmp_path: Path):
    """Verify writing ChemEx-compatible Statistics/MonteCarlo directory structure."""
    times = [0.02, 0.08, 0.2, 0.5, 1.0]
    peaks = [
        {
            "assignment": "15N-A10",
            "rate": 1.8,
            "amplitude": 1000.0,
            "times": times,
            "intensities": [1000.0 * np.exp(-1.8 * t) for t in times],
            "intensities_err": [12.0] * len(times),
        }
    ]

    u_res, rep_matrix, p_names, chi_arr, diag = run_relaxation_resampling_analysis(
        peak_results=peaks,
        analysis_type="R2",
        method="monte_carlo",
        n_samples=150,
        seed=42,
    )

    stat_dir = tmp_path / "Statistics" / "MonteCarlo"
    save_relaxation_statistics_files(
        stat_dir,
        "Monte Carlo",
        u_res,
        rep_matrix,
        p_names,
        chisqr_array=chi_arr,
        diagnostics=diag,
    )

    # Check files exist
    assert (stat_dir / "replicates.npz").is_file()
    assert (stat_dir / "samples.tsv").is_file()
    assert (stat_dir / "summary.toml").is_file()
    assert (stat_dir / "diagnostics.toml").is_file()
    assert (stat_dir / "correlations.tsv").is_file()

    # Verify loading via statistics engine
    loaded = load_replicates_or_fallback(stat_dir, "MonteCarlo")
    assert loaded is not None
    assert loaded["replicates"].shape == (150, 2)
    assert len(loaded["parameter_names"]) == 2

    # Verify parsing via statistics parser
    parsed = parse_statistics_directory(str(tmp_path))
    assert "monte_carlo" in parsed["methods"]
    mc_stat = parsed["methods"]["monte_carlo"]
    assert mc_stat["status"] == "completed"
    assert mc_stat["sample_count"] == 150
    assert "R2, NUC->15N-A10" in mc_stat["summary"]


def test_bootstrap_residual_centering_and_spread():
    """Verify centered residual bootstrap produces sound distribution centered on fit optimum."""
    times = np.array([0.01, 0.05, 0.1, 0.2, 0.4, 0.6, 0.8, 1.2], dtype=np.float64)
    true_amp = 1000.0
    true_rate = 2.0
    noise_sigma = 10.0
    rng_synth = np.random.default_rng(101)
    y_synth = true_amp * np.exp(-true_rate * times) + rng_synth.normal(0, noise_sigma, size=len(times))
    sigmas = np.full_like(times, noise_sigma)

    cov_errs, _, _ = compute_relaxation_covariance(times, y_synth, sigmas, true_amp, true_rate)
    cov_rate_err = cov_errs["rate_err"]

    rng = np.random.default_rng(42)
    n_samples = 500
    reps, chisqr, diag = run_single_peak_bootstrap(
        times, y_synth, sigmas, true_amp, true_rate, n_samples=n_samples, case_resampling=False, rng=rng
    )

    assert diag["bootstrap_mode"] == "residual"
    assert reps.shape == (n_samples, 2)
    assert diag["failures"] == 0

    bs_rate_mean = float(np.mean(reps[:, 1]))
    bs_rate_sd = float(np.std(reps[:, 1], ddof=1))

    # Mean of replicates should be close to true rate (within 5%)
    assert abs(bs_rate_mean - true_rate) / true_rate < 0.05
    # SD should be consistent with covariance error (within 25% due to residual sample variance)
    assert abs(bs_rate_sd - cov_rate_err) / cov_rate_err < 0.25


def test_bootstrap_case_resampling():
    """Verify case resampling produces non-degenerate replicates with valid parameter estimates."""
    times = np.array([0.01, 0.04, 0.1, 0.2, 0.4, 0.8, 1.2], dtype=np.float64)
    true_amp = 800.0
    true_rate = 1.8
    noise_sigma = 8.0
    rng_synth = np.random.default_rng(202)
    y_synth = true_amp * np.exp(-true_rate * times) + rng_synth.normal(0, noise_sigma, size=len(times))
    sigmas = np.full_like(times, noise_sigma)

    rng = np.random.default_rng(42)
    n_samples = 400
    reps, chisqr, diag = run_single_peak_bootstrap(
        times, y_synth, sigmas, true_amp, true_rate, n_samples=n_samples, case_resampling=True, rng=rng
    )

    assert diag["bootstrap_mode"] == "case"
    assert reps.shape == (n_samples, 2)
    assert diag["failures"] == 0

    # All rates and amplitudes must be strictly positive
    assert np.all(reps[:, 0] > 0)
    assert np.all(reps[:, 1] > 0)

    # Median rate should reasonably bracket true rate
    med_rate = float(np.median(reps[:, 1]))
    assert abs(med_rate - true_rate) / true_rate < 0.10


def test_run_relaxation_resampling_analysis_bootstrap_modes(tmp_path: Path):
    """Verify both residual and case bootstrap through high-level orchestration."""
    times = [0.02, 0.08, 0.2, 0.5, 1.0]
    peaks = [
        {
            "assignment": "15N-V12",
            "rate": 1.75,
            "amplitude": 1100.0,
            "times": times,
            "intensities": [1100.0 * np.exp(-1.75 * t) for t in times],
            "intensities_err": [10.0] * len(times),
        }
    ]

    # 1. Residual bootstrap
    u_res_res, rep_mat_res, p_names_res, chi_res, diag_res = run_relaxation_resampling_analysis(
        peak_results=peaks,
        analysis_type="R1",
        method="bootstrap",
        n_samples=150,
        seed=123,
    )
    assert u_res_res.method == "bootstrap"
    assert u_res_res.point_estimate["R1, NUC->15N-V12"] == 1.75

    # 2. Case bootstrap
    u_res_case, rep_mat_case, p_names_case, chi_case, diag_case = run_relaxation_resampling_analysis(
        peak_results=peaks,
        analysis_type="R1",
        method="bootstrap_case",
        n_samples=150,
        seed=456,
    )
    assert u_res_case.method == "bootstrap_case"
    assert u_res_case.point_estimate["R1, NUC->15N-V12"] == 1.75

    # 3. Test persistence to Statistics/Bootstrap/
    stat_dir = tmp_path / "Statistics" / "Bootstrap"
    save_relaxation_statistics_files(
        stat_dir,
        "Bootstrap",
        u_res_res,
        rep_mat_res,
        p_names_res,
        chisqr_array=chi_res,
        diagnostics=diag_res,
    )
    assert (stat_dir / "replicates.npz").is_file()
    assert (stat_dir / "samples.tsv").is_file()
    assert (stat_dir / "summary.toml").is_file()
    assert (stat_dir / "diagnostics.toml").is_file()
    assert (stat_dir / "correlations.tsv").is_file()

    parsed = parse_statistics_directory(str(tmp_path))
    assert "bootstrap" in parsed["methods"]
    assert parsed["methods"]["bootstrap"]["status"] == "completed"
    assert parsed["methods"]["bootstrap"]["sample_count"] == 150


def test_mcmc_single_peak_sampling():
    """Verify MCMC posterior sampling via emcee captures true parameters and healthy diagnostics."""
    times = np.array([0.01, 0.04, 0.1, 0.2, 0.4, 0.8, 1.2], dtype=np.float64)
    true_amp = 900.0
    true_rate = 1.5
    noise_sigma = 8.0
    rng = np.random.default_rng(303)
    y_data = true_amp * np.exp(-true_rate * times) + rng.normal(0, noise_sigma, size=len(times))
    sigmas = np.full_like(times, noise_sigma)

    reps, chains_3d, diag = run_single_peak_mcmc(
        times, y_data, sigmas, true_amp, true_rate, n_samples=300, seed=42
    )

    assert reps.shape == (300, 2)
    assert chains_3d.ndim == 3  # (n_walkers, total_steps, 2)
    assert chains_3d.shape[0] == 16  # 16 walkers
    assert chains_3d.shape[2] == 2   # [amp, rate]

    # Acceptance fraction should be in reasonable range for ensemble sampler
    assert 0.15 <= diag["acceptance_fraction_mean"] <= 0.85

    # Posterior median should be close to true value
    post_rate_median = float(np.median(reps[:, 1]))
    post_amp_median = float(np.median(reps[:, 0]))
    assert abs(post_rate_median - true_rate) / true_rate < 0.10
    assert abs(post_amp_median - true_amp) / true_amp < 0.10

    # 95% posterior interval must capture the true rate
    p2_5 = float(np.percentile(reps[:, 1], 2.5))
    p97_5 = float(np.percentile(reps[:, 1], 97.5))
    assert p2_5 <= true_rate <= p97_5


def test_mcmc_seed_reproducibility():
    """Verify that same seed produces bit-identical MCMC posterior chains."""
    times = np.array([0.02, 0.08, 0.2, 0.5, 1.0], dtype=np.float64)
    true_amp = 1000.0
    true_rate = 1.8
    sigmas = np.full_like(times, 10.0)
    y_data = true_amp * np.exp(-true_rate * times)

    reps1, c1, _ = run_single_peak_mcmc(times, y_data, sigmas, true_amp, true_rate, n_samples=100, seed=777)
    reps2, c2, _ = run_single_peak_mcmc(times, y_data, sigmas, true_amp, true_rate, n_samples=100, seed=777)

    np.testing.assert_array_equal(reps1, reps2)
    np.testing.assert_array_equal(c1, c2)


def test_run_relaxation_resampling_analysis_mcmc(tmp_path: Path):
    """Verify multi-peak MCMC orchestration and ChemEx-compatible MCMC directory persistence."""
    times = [0.02, 0.08, 0.2, 0.5, 1.0]
    peaks = [
        {
            "assignment": "15N-D15",
            "rate": 1.6,
            "amplitude": 1050.0,
            "times": times,
            "intensities": [1050.0 * np.exp(-1.6 * t) for t in times],
            "intensities_err": [10.0] * len(times),
        },
        {
            "assignment": "15N-E16",
            "rate": 2.2,
            "amplitude": 920.0,
            "times": times,
            "intensities": [920.0 * np.exp(-2.2 * t) for t in times],
            "intensities_err": [9.0] * len(times),
        }
    ]

    u_res, rep_mat, p_names, chi_arr, diag = run_relaxation_resampling_analysis(
        peak_results=peaks,
        analysis_type="R2",
        method="mcmc",
        n_samples=200,
        seed=888,
    )

    assert u_res.method == "mcmc"
    assert rep_mat.shape == (200, 4)
    assert "chains_3d" in diag
    assert diag["chains_3d"].shape[0] == 16  # 16 walkers
    assert diag["chains_3d"].shape[2] == 4   # 4 parameters

    # Verify deterministic point estimates preserved
    assert u_res.point_estimate["R2, NUC->15N-D15"] == 1.6
    assert u_res.point_estimate["R2, NUC->15N-E16"] == 2.2

    # Save to Statistics/MCMC/
    stat_dir = tmp_path / "Statistics" / "MCMC"
    save_relaxation_statistics_files(
        stat_dir,
        "MCMC",
        u_res,
        rep_mat,
        p_names,
        chisqr_array=chi_arr,
        diagnostics=diag,
    )

    # Check that mcmc_chains.npz exists and can be loaded
    assert (stat_dir / "mcmc_chains.npz").is_file()
    assert (stat_dir / "replicates.npz").is_file()
    assert (stat_dir / "samples.tsv").is_file()
    assert (stat_dir / "summary.toml").is_file()
    assert (stat_dir / "diagnostics.toml").is_file()
    assert (stat_dir / "correlations.tsv").is_file()

    loaded = load_replicates_or_fallback(stat_dir, "MCMC")
    assert loaded is not None
    assert loaded["is_mcmc"] is True
    assert loaded["chains"].ndim == 3
    assert loaded["chains"].shape[0] == 16
    assert len(loaded["parameter_names"]) == 4

    parsed = parse_statistics_directory(str(tmp_path))
    assert "mcmc" in parsed["methods"]
    assert parsed["methods"]["mcmc"]["status"] in ("completed", "converged")
    assert "R2, NUC->15N-D15" in parsed["methods"]["mcmc"]["summary"]


