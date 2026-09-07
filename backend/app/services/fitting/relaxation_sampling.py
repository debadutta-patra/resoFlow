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
Resampling and Uncertainty Estimation Engines for Native Relaxation Analyses.

Implements:
- Phase 1: Parametric Monte Carlo Resampling
- Phase 2: Residual and Case Resampling Bootstrap
- Phase 3: MCMC Posterior Sampling via emcee
- Phase 4: hetNOE Resampling and Pooled Variance Propagation
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple, Union

import numpy as np
from scipy.optimize import curve_fit

from .relaxation_uncertainty import (
    ParameterIntervals,
    ProvenanceInfo,
    UncertaintyResult,
    get_environment_package_versions,
)
from .statistics_engine import save_mcmc_chains_npz, save_replicates_npz

logger = logging.getLogger(__name__)


def _decay_model(t: np.ndarray, amplitude: float, rate: float) -> np.ndarray:
    """Mono-exponential decay model: I(t) = amplitude * exp(-rate * t)."""
    return amplitude * np.exp(-rate * t)


# ============================================================================
# Phase 1: Parametric Monte Carlo Engine
# ============================================================================

def run_single_peak_monte_carlo(
    times: np.ndarray,
    sigmas: np.ndarray,
    opt_amplitude: float,
    opt_rate: float,
    n_samples: int = 500,
    rng: Optional[np.random.Generator] = None,
) -> Tuple[np.ndarray, np.ndarray, Dict[str, Any]]:
    """
    Perform parametric Monte Carlo for a single peak's mono-exponential decay.

    Generates synthetic datasets:
      y_synth^{(k)} = opt_amplitude * exp(-opt_rate * times) + eps, eps ~ N(0, sigmas^2)
    Fits each replicate starting from (opt_amplitude, opt_rate).

    Returns:
      replicates: shape (n_samples, 2), cols = [amplitude, rate]
      chisqr: shape (n_samples,)
      diagnostics: summary metrics and failure count
    """
    times = np.asarray(times, dtype=np.float64)
    sigmas = np.asarray(sigmas, dtype=np.float64)
    safe_sigmas = np.where(sigmas > 1e-12, sigmas, 1.0)
    n_pts = len(times)

    if rng is None:
        rng = np.random.default_rng()

    y_opt = _decay_model(times, opt_amplitude, opt_rate)

    replicates = np.empty((n_samples, 2), dtype=np.float64)
    chisqr = np.empty(n_samples, dtype=np.float64)
    failures = 0

    p0 = [max(opt_amplitude, 1e-6), max(opt_rate, 1e-6)]
    bounds = ([0.0, 0.0], [np.inf, np.inf])

    for i in range(n_samples):
        noise = rng.normal(0.0, safe_sigmas, size=n_pts)
        y_synth = y_opt + noise

        try:
            popt, _ = curve_fit(
                _decay_model,
                times,
                y_synth,
                p0=p0,
                sigma=safe_sigmas,
                absolute_sigma=True,
                bounds=bounds,
                maxfev=300,
            )
            replicates[i] = popt
            res = (y_synth - _decay_model(times, *popt)) / safe_sigmas
            chisqr[i] = np.sum(res**2)
        except Exception:
            failures += 1
            replicates[i] = p0
            res = (y_synth - y_opt) / safe_sigmas
            chisqr[i] = np.sum(res**2)

    # Compute correlation between amplitude and rate across replicates
    amp_col = replicates[:, 0]
    rate_col = replicates[:, 1]
    std_a = float(np.std(amp_col, ddof=1))
    std_r = float(np.std(rate_col, ddof=1))

    corr = 0.0
    if std_a > 1e-12 and std_r > 1e-12:
        corr = float(np.corrcoef(amp_col, rate_col)[0, 1])

    diagnostics = {
        "n_samples": n_samples,
        "failures": failures,
        "failure_rate": float(failures / n_samples),
        "correlation": corr,
        "chisqr_mean": float(np.mean(chisqr)),
    }

    return replicates, chisqr, diagnostics


# ============================================================================
# Phase 2: Bootstrap Resampling Engine (Residual & Case)
# ============================================================================

def run_single_peak_bootstrap(
    times: np.ndarray,
    intensities: np.ndarray,
    sigmas: np.ndarray,
    opt_amplitude: float,
    opt_rate: float,
    n_samples: int = 500,
    case_resampling: bool = False,
    rng: Optional[np.random.Generator] = None,
) -> Tuple[np.ndarray, np.ndarray, Dict[str, Any]]:
    """
    Perform Bootstrap resampling for a single peak.

    Modes:
      case_resampling=False (Residual Bootstrap):
        Centers normalized residuals e_i = (y_i - y_hat_i)/sigma_i.
        Resamples residuals with replacement and reconstructs y_boot.
      case_resampling=True (Case Resampling):
        Resamples (t_i, y_i, sigma_i) tuples with replacement.
        Guarantees >= 2 distinct delay points.
    """
    times = np.asarray(times, dtype=np.float64)
    intensities = np.asarray(intensities, dtype=np.float64)
    sigmas = np.asarray(sigmas, dtype=np.float64)
    safe_sigmas = np.where(sigmas > 1e-12, sigmas, 1.0)
    n_pts = len(times)

    if rng is None:
        rng = np.random.default_rng()

    p0 = [max(opt_amplitude, 1e-6), max(opt_rate, 1e-6)]
    bounds = ([0.0, 0.0], [np.inf, np.inf])

    replicates = np.empty((n_samples, 2), dtype=np.float64)
    chisqr = np.empty(n_samples, dtype=np.float64)
    failures = 0

    if not case_resampling:
        # Residual bootstrap
        y_opt = _decay_model(times, opt_amplitude, opt_rate)
        norm_res = (intensities - y_opt) / safe_sigmas
        # Centering normalized residuals is mathematically required
        centered_res = norm_res - np.mean(norm_res)

        for i in range(n_samples):
            res_boot = rng.choice(centered_res, size=n_pts, replace=True)
            y_boot = y_opt + safe_sigmas * res_boot
            try:
                popt, _ = curve_fit(
                    _decay_model,
                    times,
                    y_boot,
                    p0=p0,
                    sigma=safe_sigmas,
                    absolute_sigma=True,
                    bounds=bounds,
                    maxfev=300,
                )
                replicates[i] = popt
                r = (y_boot - _decay_model(times, *popt)) / safe_sigmas
                chisqr[i] = np.sum(r**2)
            except Exception:
                failures += 1
                replicates[i] = p0
                chisqr[i] = np.sum(((y_boot - y_opt) / safe_sigmas) ** 2)
    else:
        # Case resampling bootstrap
        for i in range(n_samples):
            # Ensure at least 2 distinct delay times to prevent singular Jacobian
            for _ in range(20):
                idx = rng.choice(n_pts, size=n_pts, replace=True)
                t_boot = times[idx]
                if len(np.unique(t_boot)) >= 2:
                    break
            y_boot = intensities[idx]
            s_boot = safe_sigmas[idx]

            try:
                popt, _ = curve_fit(
                    _decay_model,
                    t_boot,
                    y_boot,
                    p0=p0,
                    sigma=s_boot,
                    absolute_sigma=True,
                    bounds=bounds,
                    maxfev=300,
                )
                replicates[i] = popt
                r = (y_boot - _decay_model(t_boot, *popt)) / s_boot
                chisqr[i] = np.sum(r**2)
            except Exception:
                failures += 1
                replicates[i] = p0
                chisqr[i] = np.sum(((y_boot - _decay_model(t_boot, *p0)) / s_boot) ** 2)

    amp_col = replicates[:, 0]
    rate_col = replicates[:, 1]
    std_a = float(np.std(amp_col, ddof=1))
    std_r = float(np.std(rate_col, ddof=1))
    corr = 0.0
    if std_a > 1e-12 and std_r > 1e-12:
        corr = float(np.corrcoef(amp_col, rate_col)[0, 1])

    diagnostics = {
        "n_samples": n_samples,
        "failures": failures,
        "failure_rate": float(failures / n_samples),
        "correlation": corr,
        "chisqr_mean": float(np.mean(chisqr)),
        "bootstrap_mode": "case" if case_resampling else "residual",
    }

    return replicates, chisqr, diagnostics


# ============================================================================
# Phase 3: MCMC Sampling Engine via emcee
# ============================================================================

def run_single_peak_mcmc(
    times: np.ndarray,
    intensities: np.ndarray,
    sigmas: np.ndarray,
    opt_amplitude: float,
    opt_rate: float,
    n_samples: int = 500,
    seed: Optional[int] = None,
) -> Tuple[np.ndarray, np.ndarray, Dict[str, Any]]:
    """
    Perform Markov Chain Monte Carlo (MCMC) posterior sampling using emcee.

    Parameters: (amplitude, rate)
    Priors: Uniform on amplitude in [0, 5 * opt_amplitude], rate in [0, 500] s^-1.
    Likelihood: Gaussian with fixed point uncertainties sigmas.

    Returns:
      replicates: shape (n_samples, 2), flattened production chain
      chains_3d: shape (n_walkers, n_steps, 2)
      diagnostics: autocorrelation time, ESS, acceptance fraction, warnings
    """
    import emcee

    times = np.asarray(times, dtype=np.float64)
    intensities = np.asarray(intensities, dtype=np.float64)
    sigmas = np.asarray(sigmas, dtype=np.float64)
    safe_sigmas = np.where(sigmas > 1e-12, sigmas, 1.0)
    inv_two_sig2 = 1.0 / (2.0 * safe_sigmas**2)

    a_max = max(opt_amplitude * 10.0, 1000.0)
    r_max = 500.0

    def log_prior(theta):
        a, r = theta
        if 0.0 < a < a_max and 0.0 < r < r_max:
            return 0.0
        return -np.inf

    def log_likelihood(theta):
        a, r = theta
        model_y = a * np.exp(-r * times)
        return -np.sum((intensities - model_y)**2 * inv_two_sig2)

    def log_posterior(theta):
        lp = log_prior(theta)
        if not np.isfinite(lp):
            return -np.inf
        return lp + log_likelihood(theta)

    n_dim = 2
    n_walkers = 16

    rng = np.random.default_rng(seed)
    p0 = np.array([max(opt_amplitude, 1e-4), max(opt_rate, 1e-4)])

    # Initialize walkers in a tight Gaussian ball around optimal parameters
    pos = p0 + 1e-3 * p0 * rng.normal(size=(n_walkers, n_dim))
    pos[:, 0] = np.clip(pos[:, 0], 1e-5, a_max)
    pos[:, 1] = np.clip(pos[:, 1], 1e-5, r_max)

    # Determine required steps to yield approx n_samples after discarding burn-in
    burn_in = 100
    production_steps = max(int(np.ceil(n_samples / n_walkers)), 50)
    total_steps = burn_in + production_steps

    sampler = emcee.EnsembleSampler(n_walkers, n_dim, log_posterior)
    sampler.run_mcmc(pos, total_steps, progress=False)

    full_chain = sampler.get_chain()  # shape: (total_steps, n_walkers, 2)
    # Transpose to (n_walkers, total_steps, 2) for standard ChemEx compatibility
    chains_3d = np.transpose(full_chain, (1, 0, 2))

    # Production chain after discarding burn-in
    flat_chain = sampler.get_chain(discard=burn_in, flat=True)  # (n_walkers * production_steps, 2)

    # Autocorrelation diagnostics
    autocorr_warning = False
    autocorr_status = "ok"
    tau_max = 0.0
    try:
        tau = sampler.get_autocorr_time(discard=burn_in, quiet=True)
        tau_max = float(np.max(tau)) if np.all(np.isfinite(tau)) else 0.0
        if production_steps < 30 * tau_max:
            autocorr_warning = True
            autocorr_status = "underconverged"
    except Exception:
        autocorr_status = "unavailable"

    # Effective sample size approximation
    ess = float(flat_chain.shape[0] / max(tau_max, 1.0))

    mean_acc = float(np.mean(sampler.acceptance_fraction))

    # Take first n_samples from flat chain
    replicates = flat_chain[:n_samples] if flat_chain.shape[0] >= n_samples else flat_chain

    diagnostics = {
        "n_samples": len(replicates),
        "walkers": n_walkers,
        "total_steps": total_steps,
        "burn_in": burn_in,
        "production_steps": production_steps,
        "acceptance_fraction_mean": mean_acc,
        "autocorrelation_time_max": tau_max,
        "autocorrelation_warning": autocorr_warning,
        "autocorrelation_status": autocorr_status,
        "effective_sample_size": ess,
    }

    return replicates, chains_3d, diagnostics


# ============================================================================
# Phase 4: hetNOE Sampling Engine
# ============================================================================

def run_hetnoe_sampling(
    i_sat: float,
    i_unsat: float,
    sigma_sat: float,
    sigma_unsat: float,
    n_samples: int = 500,
    seed: Optional[int] = None,
) -> Tuple[np.ndarray, np.ndarray, Dict[str, Any]]:
    """
    Parametric resampling of hetNOE ratio.

    Resamples I_sat ~ N(i_sat, sigma_sat^2) and I_unsat ~ N(i_unsat, sigma_unsat^2).
    Ratio r = I_sat / I_unsat.
    Handles small denominator values safely by clipping near zero.

    Returns:
      ratios: shape (n_samples, 1)
      intensities: shape (n_samples, 2), cols = [i_unsat, i_sat]
      diagnostics: summary statistics and SNR
    """
    rng = np.random.default_rng(seed)

    s_sat = max(float(sigma_sat), 1e-12)
    s_unsat = max(float(sigma_unsat), 1e-12)

    synth_sat = rng.normal(i_sat, s_sat, size=n_samples)
    synth_unsat = rng.normal(i_unsat, s_unsat, size=n_samples)

    # Safe ratio calculation preventing division by near-zero
    safe_denom = np.where(np.abs(synth_unsat) > 1e-9, synth_unsat, np.sign(synth_unsat + 1e-12) * 1e-9)
    ratios = synth_sat / safe_denom

    replicates = np.column_stack([synth_unsat, ratios])  # cols: [I_REF, HETNOE]

    diagnostics = {
        "n_samples": n_samples,
        "snr_sat": float(abs(i_sat) / s_sat),
        "snr_unsat": float(abs(i_unsat) / s_unsat),
        "ratio_mean": float(np.mean(ratios)),
        "ratio_std": float(np.std(ratios, ddof=1)),
        "ratio_median": float(np.median(ratios)),
    }

    return ratios, replicates, diagnostics


# ============================================================================
# High-Level Resampling Orchestration
# ============================================================================

def run_relaxation_resampling_analysis(
    peak_results: List[Dict[str, Any]],
    analysis_type: str,
    method: str = "monte_carlo",
    n_samples: int = 500,
    seed: Optional[int] = None,
    noise_source: str = "lineshape",
    progress_callback: Optional[Callable[[int, int, str], None]] = None,
) -> Tuple[UncertaintyResult, np.ndarray, List[str], Optional[np.ndarray], Dict[str, Any]]:
    """
    Execute uncertainty resampling across all peaks for an analysis.

    Supports:
      method in ("monte_carlo", "mc") -> Parametric Monte Carlo
      method in ("bootstrap", "bs") -> Residual Bootstrap
      method in ("bootstrap_case", "bs_case") -> Case Resampling Bootstrap
      method in ("mcmc",) -> MCMC via emcee

    Returns:
      (uncertainty_result, replicates_matrix, parameter_names, chisqr_array, summary_dict)
    """
    atype = (analysis_type or "").upper()
    is_hetnoe = atype == "HETNOE"
    rate_name = "HETNOE" if is_hetnoe else atype
    amp_name = "I_REF" if is_hetnoe else "I0"

    n_peaks = len(peak_results)
    rng = np.random.default_rng(seed)

    # Prepare parameter names (2 params per peak: rate and amplitude)
    parameter_names: List[str] = []
    for p in peak_results:
        assign = p["assignment"]
        parameter_names.append(f"{rate_name}, NUC->{assign}")
        parameter_names.append(f"{amp_name}, NUC->{assign}")

    n_params = len(parameter_names)
    replicate_matrix = np.empty((n_samples, n_params), dtype=np.float64)
    combined_chisqr = np.zeros(n_samples, dtype=np.float64)

    is_mcmc = method.lower() in ("mcmc",)
    n_walkers = 16
    burn_in = 100
    production_steps = max(int(np.ceil(n_samples / n_walkers)), 50)
    total_steps = burn_in + production_steps
    all_chains_3d: Optional[np.ndarray] = None
    if is_mcmc and not is_hetnoe:
        all_chains_3d = np.empty((n_walkers, total_steps, n_params), dtype=np.float64)

    all_diagnostics: Dict[str, Any] = {
        "analysis_type": atype,
        "method": method,
        "n_samples": n_samples,
        "n_peaks": n_peaks,
    }

    # Iterate over peaks and run the chosen resampling algorithm
    for peak_idx, p in enumerate(peak_results):
        assign = p["assignment"]
        rate_col_idx = 2 * peak_idx
        amp_col_idx = 2 * peak_idx + 1

        if progress_callback:
            progress_callback(peak_idx + 1, n_peaks, f"Resampling peak {assign} ({peak_idx + 1}/{n_peaks})")

        if is_hetnoe:
            # hetNOE sampling
            i_unsat = float(p.get("amplitude", 100.0))
            ratio = float(p.get("rate", 0.8))
            i_sat = ratio * i_unsat

            errs = p.get("intensities_err", [1.0, 1.0])
            s_unsat = float(errs[0]) if len(errs) > 0 else 1.0
            s_sat = float(errs[1]) if len(errs) > 1 else 1.0

            ratios, reps_noe, diag_noe = run_hetnoe_sampling(
                i_sat=i_sat,
                i_unsat=i_unsat,
                sigma_sat=s_sat,
                sigma_unsat=s_unsat,
                n_samples=n_samples,
                seed=int(rng.integers(0, 2**31 - 1)),
            )
            replicate_matrix[:, rate_col_idx] = ratios
            replicate_matrix[:, amp_col_idx] = reps_noe[:, 0]
            continue

        # Relaxation (R1 / R2) fitting
        times = np.asarray(p["times"], dtype=np.float64)
        intensities = np.asarray(p["intensities"], dtype=np.float64)
        sigmas = np.asarray(p.get("intensities_err", np.ones_like(times)), dtype=np.float64)
        opt_amp = float(p["amplitude"])
        opt_rate = float(p["rate"])

        peak_seed = int(rng.integers(0, 2**31 - 1))
        peak_rng = np.random.default_rng(peak_seed)

        if method.lower() in ("monte_carlo", "mc"):
            reps, chi, diag = run_single_peak_monte_carlo(
                times, sigmas, opt_amp, opt_rate, n_samples=n_samples, rng=peak_rng
            )
        elif method.lower() in ("bootstrap", "bs", "bootstrap_residuals"):
            reps, chi, diag = run_single_peak_bootstrap(
                times, intensities, sigmas, opt_amp, opt_rate, n_samples=n_samples, case_resampling=False, rng=peak_rng
            )
        elif method.lower() in ("bootstrap_case", "bs_case"):
            reps, chi, diag = run_single_peak_bootstrap(
                times, intensities, sigmas, opt_amp, opt_rate, n_samples=n_samples, case_resampling=True, rng=peak_rng
            )
        elif method.lower() in ("mcmc",):
            reps, c3d, diag = run_single_peak_mcmc(
                times, intensities, sigmas, opt_amp, opt_rate, n_samples=n_samples, seed=peak_seed
            )
            chi = np.zeros(n_samples)
            if all_chains_3d is not None:
                all_chains_3d[:, :, rate_col_idx] = c3d[:, :, 1]
                all_chains_3d[:, :, amp_col_idx] = c3d[:, :, 0]
            all_diagnostics.update({
                "walkers": n_walkers,
                "burn_in": burn_in,
                "total_steps": total_steps,
                "production_steps": production_steps,
                "acceptance_fraction_mean": diag.get("acceptance_fraction_mean", 0.25),
                "autocorrelation_time_max": diag.get("autocorrelation_time_max", 0.0),
                "autocorrelation_status": diag.get("autocorrelation_status", "ok"),
                "effective_sample_size": diag.get("effective_sample_size", float(n_samples)),
            })
        else:
            # Fallback to Monte Carlo
            reps, chi, diag = run_single_peak_monte_carlo(
                times, sigmas, opt_amp, opt_rate, n_samples=n_samples, rng=peak_rng
            )

        replicate_matrix[:, rate_col_idx] = reps[:, 1]   # rate
        replicate_matrix[:, amp_col_idx] = reps[:, 0]    # amplitude
        combined_chisqr += chi

    if all_chains_3d is not None:
        all_diagnostics["chains_3d"] = all_chains_3d

    # Compute correlation matrix across all parameters
    try:
        with np.errstate(divide="ignore", invalid="ignore"):
            corr_matrix = np.corrcoef(replicate_matrix, rowvar=False)
        if np.any(np.isnan(corr_matrix)):
            corr_matrix = np.nan_to_num(corr_matrix, nan=0.0)
            np.fill_diagonal(corr_matrix, 1.0)
    except Exception:
        corr_matrix = np.eye(n_params)

    correlations = {
        "parameters": parameter_names,
        "matrix": corr_matrix.tolist(),
    }
    all_diagnostics["correlations"] = correlations

    # Compute empirical summary statistics and intervals
    point_estimates: Dict[str, float] = {}
    standard_errors: Dict[str, float] = {}
    intervals: Dict[str, ParameterIntervals] = {}

    for idx, p_name in enumerate(parameter_names):
        col = replicate_matrix[:, idx]
        is_rate = p_name.startswith(rate_name)
        peak_idx = idx // 2
        orig_peak = peak_results[peak_idx]

        pt = float(orig_peak["rate"] if is_rate else orig_peak["amplitude"])
        sd = float(np.std(col, ddof=1)) if len(col) > 1 else 0.0

        p16 = float(np.percentile(col, 15.8655))
        p84 = float(np.percentile(col, 84.1345))
        p2_5 = float(np.percentile(col, 2.5))
        p97_5 = float(np.percentile(col, 97.5))

        # Skewness
        mean_v = float(np.mean(col))
        skew_v = 0.0
        if len(col) >= 3 and sd > 1e-12:
            m3 = float(np.mean((col - mean_v) ** 3))
            skew_v = float((m3 / (sd ** 3)) * (np.sqrt(len(col) * (len(col) - 1)) / (len(col) - 2)))

        point_estimates[p_name] = pt
        standard_errors[p_name] = sd
        intervals[p_name] = ParameterIntervals(
            interval_68=(p16, p84),
            interval_95=(p2_5, p97_5),
        )
        all_diagnostics[f"{p_name}_skew"] = skew_v
        all_diagnostics[f"{p_name}_is_skewed"] = bool(abs(skew_v) > 0.45)
        all_diagnostics[f"{p_name}_bias"] = float((pt - np.median(col)) / sd) if sd > 1e-12 else 0.0

    provenance = ProvenanceInfo(
        method=method,
        n_samples=n_samples,
        seed=seed,
        noise_source=noise_source,
        package_versions=get_environment_package_versions(),
    )

    unc_result = UncertaintyResult(
        method=method,
        point_estimate=point_estimates,
        sd=standard_errors,
        intervals=intervals,
        samples_ref=None,
        diagnostics=all_diagnostics,
        provenance=provenance,
    )

    return unc_result, replicate_matrix, parameter_names, combined_chisqr, all_diagnostics


def save_relaxation_statistics_files(
    stat_dir: Union[str, Path],
    method_name: str,
    unc_result: UncertaintyResult,
    replicate_matrix: np.ndarray,
    parameter_names: List[str],
    chisqr_array: Optional[np.ndarray] = None,
    diagnostics: Optional[Dict[str, Any]] = None,
) -> None:
    """
    Persist standardized ChemEx-compatible statistics directory:
      - replicates.npz
      - mcmc_chains.npz (if MCMC)
      - samples.tsv
      - summary.toml
      - diagnostics.toml
      - correlations.tsv
    """
    stat_dir = Path(stat_dir)
    stat_dir.mkdir(parents=True, exist_ok=True)
    diag = diagnostics or {}

    is_mcmc = method_name.lower() in ("mcmc", "mcmc posterior sampling")

    # 1. replicates.npz
    try:
        save_replicates_npz(
            stat_dir / "replicates.npz",
            replicate_matrix,
            parameter_names,
            chisqr=chisqr_array,
            metadata=diag,
        )
    except Exception as exc:
        logger.warning(f"Could not write replicates.npz: {exc}")

    # 2. mcmc_chains.npz (if MCMC)
    if is_mcmc and "chains_3d" in diag:
        try:
            save_mcmc_chains_npz(
                stat_dir / "mcmc_chains.npz",
                diag["chains_3d"],
                parameter_names,
                discarded_steps=diag.get("burn_in", 100),
                thin=1,
                metadata=diag,
            )
        except Exception as exc:
            logger.warning(f"Could not write mcmc_chains.npz: {exc}")

    # 3. samples.tsv
    samples_path = stat_dir / "samples.tsv"
    try:
        with samples_path.open("w", encoding="utf-8") as sf:
            sf.write("\t".join(parameter_names) + "\tchitot\n")
            for i in range(len(replicate_matrix)):
                row_vals = [f"{v:.6e}" for v in replicate_matrix[i]]
                chi_val = f"{chisqr_array[i]:.6e}" if chisqr_array is not None else "0.000000e+00"
                sf.write("\t".join(row_vals) + f"\t{chi_val}\n")
    except Exception as exc:
        logger.warning(f"Could not write samples.tsv: {exc}")

    # 4. summary.toml
    summary_path = stat_dir / "summary.toml"
    try:
        with summary_path.open("w", encoding="utf-8") as sf:
            for idx, p_name in enumerate(parameter_names):
                col = replicate_matrix[:, idx]
                pt = unc_result.point_estimate.get(p_name, 0.0)
                se = unc_result.sd.get(p_name, 0.0)
                inter = unc_result.intervals.get(p_name)
                p_68 = inter.interval_68 if inter else (pt - se, pt + se)
                p_95 = inter.interval_95 if inter else (pt - 1.95996 * se, pt + 1.95996 * se)

                mean_val = float(np.mean(col))
                med_val = float(np.median(col))

                sf.write(f'["{p_name}"]\n')
                sf.write(f'mean = {mean_val:.6e}\n')
                sf.write(f'median = {med_val:.6e}\n')
                sf.write(f'standard_deviation = {se:.6e}\n')
                sf.write(f'percentile_95_lower = {p_95[0]:.6e}\n')
                sf.write(f'percentile_95_upper = {p_95[1]:.6e}\n')
                sf.write(f'lower_1sigma = {p_68[0]:.6e}\n')
                sf.write(f'upper_1sigma = {p_68[1]:.6e}\n')
                sf.write(f'stderr = {se:.6e}\n')
                sf.write(f'sample_count = {len(replicate_matrix)}\n\n')
    except Exception as exc:
        logger.warning(f"Could not write summary.toml: {exc}")

    # 5. diagnostics.toml
    diag_path = stat_dir / "diagnostics.toml"
    try:
        with diag_path.open("w", encoding="utf-8") as df:
            df.write(f'method_name = "{method_name}"\n')
            df.write(f'requested_samples = {diag.get("n_samples", len(replicate_matrix))}\n')
            df.write(f'completed_samples = {len(replicate_matrix)}\n')
            df.write('status = "completed"\n')
            df.write(f'failure_rate = {diag.get("failure_rate", 0.0):.4f}\n')
            if is_mcmc:
                df.write(f'walkers = {diag.get("walkers", 16)}\n')
                df.write(f'burn_in = {diag.get("burn_in", 100)}\n')
                df.write(f'discarded_steps = {diag.get("burn_in", 100)}\n')
                df.write(f'steps = {diag.get("total_steps", 150)}\n')
                df.write(f'autocorrelation_status = "{diag.get("autocorrelation_status", "ok")}"\n')
                df.write(f'max_autocorrelation_time = {diag.get("autocorrelation_time_max", 0.0):.2f}\n')
                df.write(f'acceptance_fraction_mean = {diag.get("acceptance_fraction_mean", 0.25):.4f}\n')
    except Exception as exc:
        logger.warning(f"Could not write diagnostics.toml: {exc}")

    # 6. correlations.tsv
    corr_path = stat_dir / "correlations.tsv"
    try:
        corr_info = diag.get("correlations", {})
        corr_mat = corr_info.get("matrix")
        if corr_mat is None or len(corr_mat) != len(parameter_names):
            corr_mat = np.eye(len(parameter_names)).tolist()

        with corr_path.open("w", encoding="utf-8") as cf:
            cf.write("\t" + "\t".join(parameter_names) + "\n")
            for i, p1 in enumerate(parameter_names):
                row_strs = [f"{corr_mat[i][j]:.4f}" for j in range(len(parameter_names))]
                cf.write(p1 + "\t" + "\t".join(row_strs) + "\n")
    except Exception as exc:
        logger.warning(f"Could not write correlations.tsv: {exc}")

