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

"""
Normalized Uncertainty Result Schema and Covariance Baseline (§Phase 0).

Provides:
- UncertaintyResult normalized schema (point_estimate, sd, intervals, samples_ref, diagnostics, provenance)
- Asymptotic covariance matrix calculation for mono-exponential decay and hetNOE
- Bridge adapter converting UncertaintyResult into the shape expected by StatisticsResultsSection.tsx
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import lmfit
import numpy as np
import scipy
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class ProvenanceInfo(BaseModel):
    method: str  # "covariance" | "monte_carlo" | "bootstrap" | "bootstrap_residuals" | "mcmc"
    n_samples: int = 0
    seed: Optional[int] = None
    noise_source: str = "lineshape"
    package_versions: Dict[str, str] = Field(default_factory=dict)
    timestamp: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class ParameterIntervals(BaseModel):
    interval_68: Tuple[float, float]  # 16th and 84th percentiles (or 1-sigma)
    interval_95: Tuple[float, float]  # 2.5th and 97.5th percentiles (or 95% CI/HPD)


class UncertaintyResult(BaseModel):
    """
    Normalized result container for parameter uncertainty estimation.
    Matches the Phase 0 specification.
    """
    method: str  # covariance | monte_carlo | bootstrap | bootstrap_residuals | mcmc
    point_estimate: Dict[str, float]
    sd: Dict[str, float]
    intervals: Dict[str, ParameterIntervals]
    samples_ref: Optional[str] = None
    diagnostics: Dict[str, Any] = Field(default_factory=dict)
    provenance: ProvenanceInfo


def get_environment_package_versions() -> Dict[str, str]:
    """Capture environment package versions for provenance tracking."""
    return {
        "numpy": str(np.__version__),
        "scipy": str(scipy.__version__),
        "lmfit": str(lmfit.__version__),
    }


def compute_relaxation_covariance(
    times: np.ndarray,
    intensities: np.ndarray,
    sigmas: np.ndarray,
    amplitude: float,
    rate: float,
) -> Tuple[Dict[str, float], np.ndarray, Dict[str, Any]]:
    """
    Compute asymptotic covariance matrix and standard errors for mono-exponential decay.
    I(t) = amplitude * exp(-rate * t)

    Analytic Jacobian:
      dI/d(amplitude) = exp(-rate * t)
      dI/d(rate)      = -amplitude * t * exp(-rate * t)

    Fisher Information F = J_w^T J_w, where J_w = J / sigma.
    Covariance Matrix = inv(F).

    Returns:
        (std_errors_dict, cov_matrix_2x2, diagnostics_dict)
    """
    times = np.asarray(times, dtype=np.float64)
    intensities = np.asarray(intensities, dtype=np.float64)
    sigmas = np.asarray(sigmas, dtype=np.float64)
    safe_sigmas = np.where(sigmas > 1e-12, sigmas, 1.0)

    decay = np.exp(-rate * times)
    j_amp = decay
    j_rate = -amplitude * times * decay

    j_weighted = np.column_stack([j_amp / safe_sigmas, j_rate / safe_sigmas])

    # Fisher information matrix
    fim = j_weighted.T @ j_weighted

    cov = np.zeros((2, 2), dtype=np.float64)
    cond_num = float(np.linalg.cond(fim)) if np.all(np.isfinite(fim)) else float("inf")

    if cond_num < 1e14:
        try:
            cov = np.linalg.inv(fim)
        except np.linalg.LinAlgError:
            cov = np.linalg.pinv(fim)
    else:
        cov = np.linalg.pinv(fim)

    amp_var = max(float(cov[0, 0]), 0.0)
    rate_var = max(float(cov[1, 1]), 0.0)
    amp_err = float(np.sqrt(amp_var))
    rate_err = float(np.sqrt(rate_var))

    corr = 0.0
    if amp_err > 1e-12 and rate_err > 1e-12:
        corr = float(np.clip(cov[0, 1] / (amp_err * rate_err), -1.0, 1.0))

    # Calculate residuals and goodness-of-fit
    pred = amplitude * decay
    residuals = intensities - pred
    weighted_res = residuals / safe_sigmas
    chisqr = float(np.sum(weighted_res**2))
    nfree = max(len(times) - 2, 1)
    redchi = chisqr / nfree

    diagnostics = {
        "condition_number": cond_num,
        "correlation": corr,
        "chisqr": chisqr,
        "redchi": redchi,
        "dof": nfree,
        "ndata": len(times),
    }

    std_errors = {
        "amplitude_err": amp_err,
        "rate_err": rate_err,
    }

    return std_errors, cov, diagnostics


def compute_hetnoe_covariance(
    i_sat: float,
    i_unsat: float,
    sigma_sat: float,
    sigma_unsat: float,
) -> Tuple[float, float, Tuple[float, float], Tuple[float, float], Dict[str, Any]]:
    """
    Compute analytical error propagation for hetNOE intensity ratio.
    ratio = I_sat / I_unsat
    SE(ratio) = |ratio| * sqrt((sigma_sat / I_sat)^2 + (sigma_unsat / I_unsat)^2)

    Returns:
        (ratio, ratio_err, interval_68, interval_95, diagnostics)
    """
    if abs(i_unsat) < 1e-12:
        return 0.0, 0.0, (0.0, 0.0), (0.0, 0.0), {"warning": "Zero reference intensity"}

    ratio = float(i_sat / i_unsat)

    rel_sat = abs(sigma_sat / i_sat) if abs(i_sat) > 1e-12 else 0.0
    rel_unsat = abs(sigma_unsat / i_unsat) if abs(i_unsat) > 1e-12 else 0.0

    ratio_err = float(abs(ratio) * np.sqrt(rel_sat**2 + rel_unsat**2))

    int_68 = (float(ratio - ratio_err), float(ratio + ratio_err))
    int_95 = (float(ratio - 1.95996 * ratio_err), float(ratio + 1.95996 * ratio_err))

    diagnostics = {
        "snr_sat": float(abs(i_sat) / max(sigma_sat, 1e-12)),
        "snr_unsat": float(abs(i_unsat) / max(sigma_unsat, 1e-12)),
        "relative_error": float(ratio_err / max(abs(ratio), 1e-12)),
    }

    return ratio, ratio_err, int_68, int_95, diagnostics


def build_covariance_uncertainty_result(
    point_estimates: Dict[str, float],
    standard_errors: Dict[str, float],
    noise_source: str = "lineshape",
    diagnostics: Optional[Dict[str, Any]] = None,
) -> UncertaintyResult:
    """
    Build a standardized UncertaintyResult instance for the asymptotic covariance baseline.
    """
    intervals: Dict[str, ParameterIntervals] = {}
    for param_name, pt in point_estimates.items():
        se = standard_errors.get(param_name, 0.0)
        int_68 = (float(pt - se), float(pt + se))
        int_95 = (float(pt - 1.95996 * se), float(pt + 1.95996 * se))
        intervals[param_name] = ParameterIntervals(
            interval_68=int_68,
            interval_95=int_95,
        )

    provenance = ProvenanceInfo(
        method="covariance",
        n_samples=0,
        seed=None,
        noise_source=noise_source,
        package_versions=get_environment_package_versions(),
    )

    return UncertaintyResult(
        method="covariance",
        point_estimate=point_estimates,
        sd=standard_errors,
        intervals=intervals,
        samples_ref=None,
        diagnostics=diagnostics or {},
        provenance=provenance,
    )


def uncertainty_result_to_statistics_payload(
    uncertainty_results: Dict[str, UncertaintyResult],
    correlations_by_method: Optional[Dict[str, Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """
    Format UncertaintyResult objects into the JSON shape consumed by
    StatisticsResultsSection.tsx, MarginalDistributionModal, and the /statistics/* endpoints.
    """
    correlations_by_method = correlations_by_method or {}
    methods_dict: Dict[str, Any] = {}

    for method_key, u_res in uncertainty_results.items():
        summary: Dict[str, Any] = {}
        for param_name, pt in u_res.point_estimate.items():
            sd = u_res.sd.get(param_name, 0.0)
            inter = u_res.intervals.get(param_name)
            p_68 = inter.interval_68 if inter else (pt - sd, pt + sd)
            p_95 = inter.interval_95 if inter else (pt - 1.95996 * sd, pt + 1.95996 * sd)

            summary[param_name] = {
                "parameter_name": param_name,
                "interval": "95% confidence interval" if method_key == "covariance" else "95% percentile interval",
                "sample_count": u_res.provenance.n_samples,
                "mean": pt,
                "standard_deviation": sd,
                "std_dev": sd,
                "std": sd,
                "sem": sd if u_res.provenance.n_samples <= 1 else float(sd / np.sqrt(u_res.provenance.n_samples)),
                "median": pt,
                "percentile_95_lower": p_95[0],
                "percentile_95_upper": p_95[1],
                "interval_95_lower": p_95[0],
                "interval_95_upper": p_95[1],
                "eti_95_lower": p_95[0],
                "eti_95_upper": p_95[1],
                "lower_1sigma": p_68[0],
                "upper_1sigma": p_68[1],
                "stderr": sd,
                "deterministic_value": pt,
                "skew": u_res.diagnostics.get(f"{param_name}_skew", 0.0),
                "is_skewed": bool(u_res.diagnostics.get(f"{param_name}_is_skewed", False)),
                "bias": u_res.diagnostics.get(f"{param_name}_bias", 0.0),
            }

        method_display_names = {
            "covariance": "Covariance",
            "monte_carlo": "Monte Carlo",
            "bootstrap": "Bootstrap",
            "bootstrap_residuals": "Bootstrap (Residuals)",
            "mcmc": "MCMC",
        }

        methods_dict[method_key] = {
            "method_name": method_display_names.get(method_key, method_key.replace("_", " ").title()),
            "status": "complete",
            "summary": summary,
            "correlations": correlations_by_method.get(method_key, {"parameters": list(u_res.point_estimate.keys()), "matrix": []}),
            "diagnostics": u_res.diagnostics,
            "sample_count": u_res.provenance.n_samples,
            "samples_ref": u_res.samples_ref,
            "provenance": u_res.provenance.model_dump(),
        }

    return {
        "methods": methods_dict,
        # Also provide top-level keys for backward-compatibility with ChemEx convention
        **{k: methods_dict[k] for k in methods_dict},
    }
