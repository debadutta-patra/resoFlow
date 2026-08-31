"""
Derived kinetic quantity evaluation with strict covariance-aware error propagation (Phase 7).
Calculates:
  - k_AB = k_ex * p_b
  - k_BA = k_ex * (1 - p_b)
  - tau_B = 1 / k_BA  (seconds & ms)
  - tau_A = 1 / k_AB  (seconds & ms)

Propagation Hierarchy:
  1. RESAMPLED samples (evaluates quantity per sample, handles non-Gaussian marginals)
  2. Full Covariance Matrix (evaluates exact 2D first-order Taylor expansion with cov(k_ex, p_b))
  3. Independent Quadrature Fallback (only if covariance is unavailable, labelled as such)
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple, Union

import numpy as np

from .uncertainty import ParameterStatus, UncertaintySource


@dataclass
class DerivedKineticResult:
    name: str
    symbol: str
    value: Optional[float]
    err_low: Optional[float] = None
    err_high: Optional[float] = None
    err_low_95: Optional[float] = None
    err_high_95: Optional[float] = None
    unit: str = "s⁻¹"
    propagation_method: str = "COVARIANCE"  # "RESAMPLED" | "COVARIANCE" | "INDEPENDENT_QUADRATURE"
    source: UncertaintySource = UncertaintySource.COVARIANCE
    status: ParameterStatus = ParameterStatus.DERIVED
    n_samples: Optional[int] = None
    correlation_r: Optional[float] = None
    expression: str = ""

    @property
    def sigma(self) -> Optional[float]:
        if self.err_low is None and self.err_high is None:
            return None
        if self.err_low is not None and self.err_high is None:
            return self.err_low
        if self.err_low is None and self.err_high is not None:
            return self.err_high
        return (self.err_low + self.err_high) / 2.0


def propagate_derived_kinetics(
    kex_val: Optional[float],
    pb_val: Optional[float],
    kex_sigma: Optional[float] = None,
    pb_sigma: Optional[float] = None,
    cov_kex_pb: Optional[float] = None,
    correlation_r: Optional[float] = None,
    samples: Optional[Dict[str, np.ndarray]] = None,
) -> Dict[str, DerivedKineticResult]:
    """
    Compute derived kinetic quantities and propagate uncertainties.

    Parameters:
      kex_val: Exchange rate (s⁻¹)
      pb_val: Excited state population fraction (0.0 to 1.0)
      kex_sigma: Symmetric 1-sigma uncertainty on k_ex
      pb_sigma: Symmetric 1-sigma uncertainty on p_b (fraction)
      cov_kex_pb: Off-diagonal covariance term between k_ex and p_b
      correlation_r: Pearson correlation coefficient between k_ex and p_b
      samples: Optional dict with 'kex' and 'pb' 1D numpy arrays from MC/Bootstrap

    Returns:
      Dict mapping quantity key ('kab', 'kba', 'tau_b', 'tau_a') to DerivedKineticResult.
    """
    results: Dict[str, DerivedKineticResult] = {}

    if kex_val is None or pb_val is None or not math.isfinite(kex_val) or not math.isfinite(pb_val):
        for key, sym, unit, expr in [
            ("kab", "k_AB", "s⁻¹", "k_ex · p_b"),
            ("kba", "k_BA", "s⁻¹", "k_ex · (1 − p_b)"),
            ("tau_b", "τ_B", "ms", "1 / k_BA"),
            ("tau_a", "τ_A", "ms", "1 / k_AB"),
        ]:
            results[key] = DerivedKineticResult(
                name=key,
                symbol=sym,
                value=None,
                unit=unit,
                status=ParameterStatus.NOT_IN_MODEL,
                expression=expr,
            )
        return results

    # Normalize pb_val to fraction if passed as percentage
    pb_frac = pb_val / 100.0 if pb_val > 1.0 else pb_val
    pb_sig = (pb_sigma / 100.0 if (pb_sigma is not None and pb_val > 1.0) else pb_sigma) if pb_sigma is not None else None

    # Base values
    kab_val = kex_val * pb_frac
    kba_val = kex_val * (1.0 - pb_frac)
    tau_b_sec = (1.0 / kba_val) if kba_val > 0 else np.nan
    tau_b_ms = tau_b_sec * 1000.0 if math.isfinite(tau_b_sec) else np.nan
    tau_a_sec = (1.0 / kab_val) if kab_val > 0 else np.nan
    tau_a_ms = tau_a_sec * 1000.0 if math.isfinite(tau_a_sec) else np.nan

    # Rule 1: Resampling Samples (Highest Priority)
    if (
        samples is not None
        and "kex" in samples
        and "pb" in samples
        and len(samples["kex"]) > 1
        and len(samples["pb"]) > 1
    ):
        kex_s = samples["kex"]
        pb_s = samples["pb"]
        # Normalize pb samples if percentage
        if np.nanmedian(pb_s) > 1.0:
            pb_s = pb_s / 100.0

        valid_mask = ~np.isnan(kex_s) & ~np.isnan(pb_s)
        kex_valid = kex_s[valid_mask]
        pb_valid = pb_s[valid_mask]
        n_samples = len(kex_valid)

        if n_samples >= 2:
            kab_s = kex_valid * pb_valid
            kba_s = kex_valid * (1.0 - pb_valid)

            with np.errstate(divide="ignore", invalid="ignore"):
                tau_b_s_ms = np.where(kba_s > 0, (1.0 / kba_s) * 1000.0, np.nan)
                tau_a_s_ms = np.where(kab_s > 0, (1.0 / kab_s) * 1000.0, np.nan)

            r_val = float(np.corrcoef(kex_valid, pb_valid)[0, 1]) if np.std(kex_valid) > 0 and np.std(pb_valid) > 0 else None

            def get_percentile_errors(arr: np.ndarray, central: float) -> Tuple[float, float, float, float]:
                valid_arr = arr[~np.isnan(arr)]
                if len(valid_arr) < 2:
                    return 0.0, 0.0, 0.0, 0.0
                p16 = float(np.percentile(valid_arr, 15.8655))
                p84 = float(np.percentile(valid_arr, 84.1345))
                p2_5 = float(np.percentile(valid_arr, 2.5))
                p97_5 = float(np.percentile(valid_arr, 97.5))
                med = float(np.median(valid_arr))
                ref = central if math.isfinite(central) else med
                return max(0.0, ref - p16), max(0.0, p84 - ref), max(0.0, ref - p2_5), max(0.0, p97_5 - ref)

            kab_el, kab_eh, kab_el95, kab_eh95 = get_percentile_errors(kab_s, kab_val)
            kba_el, kba_eh, kba_el95, kba_eh95 = get_percentile_errors(kba_s, kba_val)
            tb_el, tb_eh, tb_el95, tb_eh95 = get_percentile_errors(tau_b_s_ms, tau_b_ms)
            ta_el, ta_eh, ta_el95, ta_eh95 = get_percentile_errors(tau_a_s_ms, tau_a_ms)

            results["kab"] = DerivedKineticResult(
                name="kab", symbol="k_AB", value=kab_val,
                err_low=kab_el, err_high=kab_eh, err_low_95=kab_el95, err_high_95=kab_eh95,
                unit="s⁻¹", propagation_method="RESAMPLED", source=UncertaintySource.RESAMPLED,
                n_samples=n_samples, correlation_r=r_val, expression="k_ex · p_b",
            )
            results["kba"] = DerivedKineticResult(
                name="kba", symbol="k_BA", value=kba_val,
                err_low=kba_el, err_high=kba_eh, err_low_95=kba_el95, err_high_95=kba_eh95,
                unit="s⁻¹", propagation_method="RESAMPLED", source=UncertaintySource.RESAMPLED,
                n_samples=n_samples, correlation_r=r_val, expression="k_ex · (1 − p_b)",
            )
            results["tau_b"] = DerivedKineticResult(
                name="tau_b", symbol="τ_B", value=tau_b_ms,
                err_low=tb_el, err_high=tb_eh, err_low_95=tb_el95, err_high_95=tb_eh95,
                unit="ms", propagation_method="RESAMPLED", source=UncertaintySource.RESAMPLED,
                n_samples=n_samples, correlation_r=r_val, expression="1 / k_BA",
            )
            results["tau_a"] = DerivedKineticResult(
                name="tau_a", symbol="τ_A", value=tau_a_ms,
                err_low=ta_el, err_high=ta_eh, err_low_95=ta_el95, err_high_95=ta_eh95,
                unit="ms", propagation_method="RESAMPLED", source=UncertaintySource.RESAMPLED,
                n_samples=n_samples, correlation_r=r_val, expression="1 / k_AB",
            )
            return results

    # Rule 2: Full Covariance Matrix Propagation
    has_sigmas = (kex_sigma is not None and kex_sigma > 0 and pb_sig is not None and pb_sig > 0)
    if has_sigmas:
        # Determine covariance term
        cov_term = cov_kex_pb
        if cov_term is None and correlation_r is not None and math.isfinite(correlation_r):
            cov_term = correlation_r * kex_sigma * pb_sig

        method_used = "COVARIANCE" if cov_term is not None else "INDEPENDENT_QUADRATURE"
        cov_val = cov_term if cov_term is not None else 0.0

        # Variance formulas with cross-term
        var_kab = (pb_frac ** 2) * (kex_sigma ** 2) + (kex_val ** 2) * (pb_sig ** 2) + 2.0 * kex_val * pb_frac * cov_val
        var_kba = ((1.0 - pb_frac) ** 2) * (kex_sigma ** 2) + (kex_val ** 2) * (pb_sig ** 2) - 2.0 * kex_val * (1.0 - pb_frac) * cov_val

        sigma_kab = math.sqrt(max(0.0, var_kab))
        sigma_kba = math.sqrt(max(0.0, var_kba))

        sigma_tb_ms = (sigma_kba / (kba_val ** 2) * 1000.0) if (kba_val > 0 and math.isfinite(kba_val)) else None
        sigma_ta_ms = (sigma_kab / (kab_val ** 2) * 1000.0) if (kab_val > 0 and math.isfinite(kab_val)) else None

        source_tag = UncertaintySource.COVARIANCE if method_used == "COVARIANCE" else UncertaintySource.NONE

        results["kab"] = DerivedKineticResult(
            name="kab", symbol="k_AB", value=kab_val,
            err_low=sigma_kab, err_high=sigma_kab, err_low_95=sigma_kab * 1.96, err_high_95=sigma_kab * 1.96,
            unit="s⁻¹", propagation_method=method_used, source=source_tag,
            correlation_r=correlation_r, expression="k_ex · p_b",
        )
        results["kba"] = DerivedKineticResult(
            name="kba", symbol="k_BA", value=kba_val,
            err_low=sigma_kba, err_high=sigma_kba, err_low_95=sigma_kba * 1.96, err_high_95=sigma_kba * 1.96,
            unit="s⁻¹", propagation_method=method_used, source=source_tag,
            correlation_r=correlation_r, expression="k_ex · (1 − p_b)",
        )
        results["tau_b"] = DerivedKineticResult(
            name="tau_b", symbol="τ_B", value=tau_b_ms,
            err_low=sigma_tb_ms, err_high=sigma_tb_ms, err_low_95=sigma_tb_ms * 1.96 if sigma_tb_ms else None,
            err_high_95=sigma_tb_ms * 1.96 if sigma_tb_ms else None,
            unit="ms", propagation_method=method_used, source=source_tag,
            correlation_r=correlation_r, expression="1 / k_BA",
        )
        results["tau_a"] = DerivedKineticResult(
            name="tau_a", symbol="τ_A", value=tau_a_ms,
            err_low=sigma_ta_ms, err_high=sigma_ta_ms, err_low_95=sigma_ta_ms * 1.96 if sigma_ta_ms else None,
            err_high_95=sigma_ta_ms * 1.96 if sigma_ta_ms else None,
            unit="ms", propagation_method=method_used, source=source_tag,
            correlation_r=correlation_r, expression="1 / k_AB",
        )
        return results

    # Rule 4: Value only, no errors available
    for key, sym, val, unit, expr in [
        ("kab", "k_AB", kab_val, "s⁻¹", "k_ex · p_b"),
        ("kba", "k_BA", kba_val, "s⁻¹", "k_ex · (1 − p_b)"),
        ("tau_b", "τ_B", tau_b_ms, "ms", "1 / k_BA"),
        ("tau_a", "τ_A", tau_a_ms, "ms", "1 / k_AB"),
    ]:
        results[key] = DerivedKineticResult(
            name=key,
            symbol=sym,
            value=val,
            unit=unit,
            propagation_method="NONE",
            source=UncertaintySource.NONE,
            expression=expr,
        )

    return results
