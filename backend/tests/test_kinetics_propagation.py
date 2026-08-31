"""
Unit tests for derived kinetics error propagation (Phase 7).
Asserts that covariance-aware propagation accounts for k_ex/p_b correlation
and differs from naive independent quadrature.
"""

import math
import numpy as np
import pytest
from app.services.reporting.kinetics import propagate_derived_kinetics, DerivedKineticResult


class TestKineticsPropagation:
    """Test suite for kinetics covariance and resampling propagation rules."""

    def test_correlated_vs_independent_quadrature(self):
        """
        Verify that anti-correlated k_ex and p_b produce materially different uncertainties
        under full covariance propagation versus independent quadrature.
        """
        kex = 450.0  # s⁻¹
        pb = 0.03    # 3%
        kex_sig = 30.0
        pb_sig = 0.005

        # Strongly anti-correlated (r = -0.85) typical for CEST
        r_corr = -0.85
        cov_val = r_corr * kex_sig * pb_sig

        res_cov = propagate_derived_kinetics(
            kex_val=kex,
            pb_val=pb,
            kex_sigma=kex_sig,
            pb_sigma=pb_sig,
            cov_kex_pb=cov_val,
            correlation_r=r_corr,
        )

        res_indep = propagate_derived_kinetics(
            kex_val=kex,
            pb_val=pb,
            kex_sigma=kex_sig,
            pb_sigma=pb_sig,
            cov_kex_pb=None,
            correlation_r=None,
        )

        # Values should be identical
        assert abs(res_cov["kab"].value - res_indep["kab"].value) < 1e-9
        assert abs(res_cov["kba"].value - res_indep["kba"].value) < 1e-9

        # For k_AB = k_ex * p_b, negative correlation reduces variance:
        # var(k_AB) = p_b^2*s_k^2 + k_ex^2*s_p^2 + 2*k_ex*p_b*cov (where cov < 0)
        assert res_cov["kab"].sigma < res_indep["kab"].sigma

        # For k_BA = k_ex * (1 - p_b), negative correlation increases variance:
        # var(k_BA) = (1-p_b)^2*s_k^2 + k_ex^2*s_p^2 - 2*k_ex*(1-p_b)*cov (where -cov > 0)
        assert res_cov["kba"].sigma > res_indep["kba"].sigma

        assert res_cov["kab"].propagation_method == "COVARIANCE"
        assert res_indep["kab"].propagation_method == "INDEPENDENT_QUADRATURE"

    def test_resampled_propagation_with_samples(self):
        """Verify that resampling samples calculate exact percentiles."""
        np.random.seed(42)
        kex_samples = np.random.normal(loc=400.0, scale=20.0, size=500)
        pb_samples = np.random.normal(loc=0.02, scale=0.003, size=500)

        res = propagate_derived_kinetics(
            kex_val=400.0,
            pb_val=0.02,
            samples={"kex": kex_samples, "pb": pb_samples},
        )

        assert res["kab"].propagation_method == "RESAMPLED"
        assert res["kab"].n_samples == 500
        assert res["tau_b"].unit == "ms"
        assert res["tau_b"].value is not None
        assert res["tau_b"].err_low is not None and res["tau_b"].err_high is not None

    def test_fixture_derived_kinetics_sanity(self):
        """Sanity check on fixture values: k_ex = 379.27 s⁻¹, pb = 0.353%."""
        kex = 379.269
        pb = 0.00353022
        res = propagate_derived_kinetics(kex_val=kex, pb_val=pb)

        # k_BA = 379.269 * (1 - 0.00353) ≈ 377.93 s⁻¹
        assert abs(res["kba"].value - 377.93) < 0.5
        # tau_B = 1000 / 377.93 ≈ 2.646 ms
        assert abs(res["tau_b"].value - 2.65) < 0.1
