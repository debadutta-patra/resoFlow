# Copyright (C) 2026 resoFlow Authors
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

import numpy as np
import pytest
from app.services.fitting.relaxation_noise import (
    NoiseSource,
    apply_residual_scaling,
    compute_pooled_duplicate_sigma,
    compute_spectral_rmsd_noise,
    detect_duplicate_delays,
    resolve_noise_model,
)
from app.services.fitting.relaxation_uncertainty import (
    build_covariance_uncertainty_result,
    compute_hetnoe_covariance,
    compute_relaxation_covariance,
    uncertainty_result_to_statistics_payload,
)
from app.services.fitting.param_canonicalizer import canonicalize


def test_detect_duplicate_delays():
    """Verify that duplicate relaxation delay times are correctly grouped."""
    times = np.array([0.01, 0.05, 0.1, 0.05, 0.2, 0.01, 0.5])
    dup_map = detect_duplicate_delays(times, tolerance=1e-5)
    assert len(dup_map) == 2
    # Verify index sets
    dup_indices = sorted([sorted(v) for v in dup_map.values()])
    assert dup_indices == [[0, 5], [1, 3]]


def test_compute_pooled_duplicate_sigma():
    """Verify pooled variance and standard deviation across replicate delay points."""
    times = np.array([0.01, 0.05, 0.1, 0.05, 0.2, 0.01])
    # Delays 0.01 has values 100, 104 (diff=4, s1^2 = 8)
    # Delays 0.05 has values 80, 82 (diff=2, s2^2 = 2)
    # Total sum of squares = 8 + 2 = 10, total dof = (2-1) + (2-1) = 2 -> pooled var = 5 -> sigma = sqrt(5)
    intensities = np.array([100.0, 80.0, 50.0, 82.0, 30.0, 104.0])
    pooled_sigma = compute_pooled_duplicate_sigma(times, intensities)
    assert pooled_sigma is not None
    expected_sigma = np.sqrt(5.0)
    assert np.isclose(pooled_sigma, expected_sigma, rtol=1e-5)


def test_resolve_noise_model_precedence():
    """Verify fallback hierarchy: lineshape -> duplicate -> rmsd -> residual_scaled."""
    times = np.array([0.01, 0.05, 0.1, 0.2])
    intensities = np.array([100.0, 80.0, 60.0, 40.0])

    # 1. Lineshape errors present and positive -> uses lineshape
    lineshape_errs = np.array([1.5, 1.2, 1.1, 0.9])
    sigmas, meta = resolve_noise_model(
        times, intensities, lineshape_errs=lineshape_errs, requested_source=NoiseSource.LINESHAPE
    )
    assert meta["source"] == NoiseSource.LINESHAPE.value
    assert np.allclose(sigmas, lineshape_errs)

    # 2. Lineshape requested but missing -> falls back to duplicate if available, else rmsd
    sigmas_fallback, meta_fallback = resolve_noise_model(
        times, intensities, lineshape_errs=None, requested_source=NoiseSource.LINESHAPE, spectral_rmsd=2.5
    )
    assert meta_fallback["source"] == NoiseSource.RMSD.value
    assert np.allclose(sigmas_fallback, 2.5)

    # 3. Duplicate requested and available
    times_with_dup = np.array([0.01, 0.05, 0.01, 0.1])
    ints_with_dup = np.array([100.0, 70.0, 98.0, 50.0])
    sigmas_dup, meta_dup = resolve_noise_model(
        times_with_dup, ints_with_dup, requested_source=NoiseSource.DUPLICATE
    )
    assert meta_dup["source"] == NoiseSource.DUPLICATE.value
    assert np.all(sigmas_dup > 0)


def test_residual_scaling():
    """Verify residual scaling properly inflates/deflates sigma to achieve redchi = 1.0."""
    times = np.array([0.0, 0.1, 0.2, 0.4, 0.8])
    rate_true = 2.0
    amp_true = 100.0
    pred = amp_true * np.exp(-rate_true * times)
    # Constant offset residuals
    residuals = np.array([2.0, -1.5, 3.0, -2.5, 1.0])

    initial_sigmas = np.ones_like(times) * 0.5  # Underestimated errors -> redchi > 1
    scaled_sigmas, scale_factor = apply_residual_scaling(initial_sigmas, residuals, n_params=2)
    
    # Calculate new redchi with scaled sigmas
    dof = len(residuals) - 2
    new_chisqr = np.sum((residuals / scaled_sigmas)**2)
    new_redchi = new_chisqr / dof
    assert np.isclose(new_redchi, 1.0, rtol=1e-4)
    assert np.all(scaled_sigmas > initial_sigmas)


def test_covariance_baseline_exponential():
    """Verify analytic covariance standard errors for mono-exponential decay."""
    np.random.seed(123)
    times = np.array([0.0, 0.05, 0.1, 0.2, 0.4, 0.8, 1.2])
    amp_true = 500.0
    rate_true = 1.8
    sigma_true = 5.0

    intensities = amp_true * np.exp(-rate_true * times) + np.random.normal(0, sigma_true, len(times))
    sigmas = np.full_like(times, sigma_true)

    std_errors, cov, diag = compute_relaxation_covariance(times, intensities, sigmas, amp_true, rate_true)

    assert "rate_err" in std_errors
    assert "amplitude_err" in std_errors
    assert std_errors["rate_err"] > 0.0
    assert std_errors["amplitude_err"] > 0.0
    assert cov.shape == (2, 2)
    assert -1.0 <= diag["correlation"] <= 1.0
    assert diag["dof"] == len(times) - 2
    assert diag["chisqr"] > 0.0


def test_hetnoe_covariance():
    """Verify analytical error propagation for hetNOE intensity ratio."""
    i_sat = 80.0
    i_unsat = 100.0
    sigma_sat = 2.0
    sigma_unsat = 2.0

    ratio, ratio_err, int_68, int_95, diag = compute_hetnoe_covariance(
        i_sat, i_unsat, sigma_sat, sigma_unsat
    )

    expected_ratio = 0.8
    expected_ratio_err = 0.8 * np.sqrt((2.0 / 80.0)**2 + (2.0 / 100.0)**2)

    assert np.isclose(ratio, expected_ratio, rtol=1e-6)
    assert np.isclose(ratio_err, expected_ratio_err, rtol=1e-6)
    assert int_68[0] < ratio < int_68[1]
    assert int_95[0] < ratio < int_95[1]
    assert diag["snr_sat"] == 40.0
    assert diag["snr_unsat"] == 50.0


def test_uncertainty_result_payload_formatting():
    """Verify build_covariance_uncertainty_result and bridge formatting for StatisticsResultsSection."""
    point_estimates = {
        "R1, NUC->15N": 1.45,
        "I0, NUC->15N": 1200.0,
    }
    standard_errors = {
        "R1, NUC->15N": 0.04,
        "I0, NUC->15N": 15.0,
    }

    cov_res = build_covariance_uncertainty_result(
        point_estimates,
        standard_errors,
        noise_source="lineshape",
        diagnostics={"test_flag": True},
    )

    payload = uncertainty_result_to_statistics_payload({"covariance": cov_res})

    assert "methods" in payload
    assert "covariance" in payload["methods"]
    cov_method = payload["methods"]["covariance"]
    assert cov_method["method_name"] == "Covariance"
    assert cov_method["status"] == "complete"
    assert "R1, NUC->15N" in cov_method["summary"]

    r1_summary = cov_method["summary"]["R1, NUC->15N"]
    assert r1_summary["mean"] == 1.45
    assert r1_summary["std"] == 0.04
    assert r1_summary["percentile_95_lower"] < 1.45 < r1_summary["percentile_95_upper"]


def test_canonicalize_relaxation_params():
    """Verify param_canonicalizer handles relaxation format without space after comma."""
    canon1 = canonicalize("R1,NUC->15N")
    assert canon1.name == "R1"
    assert canon1.scope == "15N"

    canon2 = canonicalize("HETNOE, NUC->22N")
    assert canon2.name == "HETNOE"
    assert canon2.scope == "22N"
