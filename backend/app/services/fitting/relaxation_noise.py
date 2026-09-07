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
Noise Model and Precedence Hierarchy for Native Relaxation Fitting (§Phase 0).

Provides explicit, user-selectable noise sources in order of scientific precedence:
1. Lineshape covariance: per-residue, per-plane amplitude standard error from peak fit.
2. Duplicate delay points: pooled variance from paired differences, combined as max(sigma_duplicate, sigma_lineshape).
3. Spectral RMSD: estimated noise from spectral baseline / blank regions (MAD).
4. Residual-scaled: inflate sigma so reduced chi^2 = 1.0 (labeled as absorbing systematic error).
"""

from __future__ import annotations

import logging
from enum import Enum
from typing import Any, Dict, List, Optional, Tuple, Union

import numpy as np

logger = logging.getLogger(__name__)


class NoiseSource(str, Enum):
    LINESHAPE = "lineshape"
    DUPLICATE = "duplicate"
    RMSD = "rmsd"
    RESIDUAL_SCALED = "residual_scaled"


def detect_duplicate_delays(
    times: np.ndarray,
    tolerance: float = 1e-5,
) -> Dict[float, List[int]]:
    """
    Find indices of matching delays within the given absolute tolerance.

    Returns a dict mapping delay value to the list of indices where that delay appears.
    Only delays with 2 or more occurrences are included.
    """
    times = np.asarray(times, dtype=np.float64)
    n = len(times)
    if n < 2:
        return {}

    visited = np.zeros(n, dtype=bool)
    duplicates: Dict[float, List[int]] = {}

    for i in range(n):
        if visited[i]:
            continue
        t_val = times[i]
        match_mask = np.abs(times - t_val) <= tolerance
        match_indices = np.where(match_mask)[0].tolist()
        if len(match_indices) >= 2:
            visited[match_mask] = True
            duplicates[float(t_val)] = sorted(match_indices)

    return duplicates


def compute_pooled_duplicate_sigma(
    times: np.ndarray,
    intensities: np.ndarray,
    tolerance: float = 1e-5,
) -> Optional[float]:
    """
    Compute pooled standard deviation from duplicate delay measurements.

    For paired differences d_k = y_{a,k} - y_{b,k} at the same delay,
    Var(d_k) = 2 * sigma^2.
    More generally for m_j replicates at delay t_j:
    sum_sq = sum_{j} sum_{i=1}^{m_j} (y_{i,j} - mean(y_j))^2
    dof = sum_{j} (m_j - 1)
    pooled_sigma = sqrt(sum_sq / dof)

    Returns None if no duplicate delays exist or if degrees of freedom < 1.
    """
    times = np.asarray(times, dtype=np.float64)
    intensities = np.asarray(intensities, dtype=np.float64)

    dup_map = detect_duplicate_delays(times, tolerance=tolerance)
    if not dup_map:
        return None

    sum_sq = 0.0
    dof = 0

    for _delay_val, indices in dup_map.items():
        y_vals = intensities[indices]
        m = len(y_vals)
        if m >= 2:
            y_mean = np.mean(y_vals)
            sum_sq += float(np.sum((y_vals - y_mean) ** 2))
            dof += (m - 1)

    if dof < 1:
        return None

    return float(np.sqrt(sum_sq / dof))


def compute_spectral_rmsd_noise(
    intensities: np.ndarray,
    spectral_rmsd: Optional[float] = None,
) -> float:
    """
    Return spectral RMSD noise floor. If not provided externally, estimate
    using MAD from successive differences (von Neumann estimator).
    """
    if spectral_rmsd is not None and spectral_rmsd > 0:
        return float(spectral_rmsd)

    # Fallback to robust difference estimator: sigma = 1.4826 * MAD(diff(y) / sqrt(2))
    if len(intensities) >= 3:
        diffs = np.diff(intensities) / np.sqrt(2.0)
        mad = float(1.4826 * np.median(np.abs(diffs - np.median(diffs))))
        if mad > 1e-12:
            return mad

    # Ultimate fallback: 1% of mean intensity
    mean_int = float(np.mean(np.abs(intensities))) if len(intensities) > 0 else 1.0
    return max(mean_int * 0.01, 1e-4)


def resolve_noise_model(
    times: np.ndarray,
    intensities: np.ndarray,
    lineshape_errs: Optional[np.ndarray] = None,
    requested_source: Union[str, NoiseSource] = NoiseSource.LINESHAPE,
    spectral_rmsd: Optional[float] = None,
    tolerance: float = 1e-5,
) -> Tuple[np.ndarray, Dict[str, Any]]:
    """
    Resolve per-point sigma vector using the requested NoiseModel and precedence hierarchy.

    Precedence order:
    1. Lineshape covariance: per-point amplitude standard errors.
    2. Duplicate delay points: combined as max(sigma_duplicate, sigma_lineshape).
    3. Spectral RMSD: uniform noise across points.
    4. Residual-scaled: placeholder evaluated post-fit if requested.

    Returns:
        (sigmas, metadata_dict)
    """
    times = np.asarray(times, dtype=np.float64)
    intensities = np.asarray(intensities, dtype=np.float64)
    n_points = len(times)

    if isinstance(requested_source, str):
        try:
            req_source = NoiseSource(requested_source.lower().strip())
        except ValueError:
            req_source = NoiseSource.LINESHAPE
    else:
        req_source = requested_source

    dup_sigma = compute_pooled_duplicate_sigma(times, intensities, tolerance=tolerance)
    has_duplicates = dup_sigma is not None and dup_sigma > 1e-12
    dup_details = detect_duplicate_delays(times, tolerance=tolerance)
    n_dup_pairs = sum(len(idxs) - 1 for idxs in dup_details.values()) if dup_details else 0

    has_lineshape = (
        lineshape_errs is not None
        and len(lineshape_errs) == n_points
        and np.any(np.asarray(lineshape_errs) > 1e-12)
    )

    clean_lineshape = np.asarray(lineshape_errs, dtype=np.float64) if has_lineshape else np.zeros(n_points)
    # Replace zeros or NaNs in lineshape errors with median positive error or spectral noise
    if has_lineshape:
        pos_mask = (clean_lineshape > 1e-12) & ~np.isnan(clean_lineshape)
        fill_val = float(np.median(clean_lineshape[pos_mask])) if np.any(pos_mask) else 0.0
        clean_lineshape = np.where(clean_lineshape > 1e-12, clean_lineshape, fill_val)

    metadata: Dict[str, Any] = {
        "source": req_source.value,
        "requested_source": req_source.value,
        "effective_source": req_source.value,
        "fallback_applied": False,
        "fallback_reason": None,
        "duplicate_sigma": dup_sigma,
        "duplicate_delays_detected": list(dup_details.keys()),
        "duplicate_dof": n_dup_pairs,
        "has_lineshape_covariance": has_lineshape,
        "spectral_rmsd": spectral_rmsd,
    }

    # 1. Lineshape Covariance
    if req_source == NoiseSource.LINESHAPE:
        if has_lineshape and np.all(clean_lineshape > 1e-12):
            return clean_lineshape, metadata
        elif has_duplicates:
            metadata["fallback_applied"] = True
            metadata["effective_source"] = NoiseSource.DUPLICATE.value
            metadata["source"] = NoiseSource.DUPLICATE.value
            metadata["fallback_reason"] = "Lineshape covariance errors incomplete; fell back to duplicate delays."
            sigmas = np.full(n_points, dup_sigma)
            if has_lineshape:
                sigmas = np.maximum(sigmas, clean_lineshape)
            return sigmas, metadata
        else:
            metadata["fallback_applied"] = True
            metadata["effective_source"] = NoiseSource.RMSD.value
            metadata["source"] = NoiseSource.RMSD.value
            metadata["fallback_reason"] = "Lineshape covariance and duplicate delays unavailable; fell back to spectral RMSD."
            rmsd_val = compute_spectral_rmsd_noise(intensities, spectral_rmsd)
            return np.full(n_points, rmsd_val), metadata

    # 2. Duplicate Delay Points
    elif req_source == NoiseSource.DUPLICATE:
        if has_duplicates:
            # Combine as max(sigma_duplicate, sigma_lineshape) per specification
            if has_lineshape:
                combined = np.maximum(np.full(n_points, dup_sigma), clean_lineshape)
                metadata["effective_source"] = "duplicate+lineshape_max"
                metadata["source"] = metadata["effective_source"]
                return combined, metadata
            else:
                metadata["source"] = metadata["effective_source"]
                return np.full(n_points, dup_sigma), metadata
        else:
            # Fallback to lineshape if available, else RMSD
            if has_lineshape:
                metadata["fallback_applied"] = True
                metadata["effective_source"] = NoiseSource.LINESHAPE.value
                metadata["source"] = metadata["effective_source"]
                metadata["fallback_reason"] = "No duplicate delays detected; fell back to lineshape covariance."
                return clean_lineshape, metadata
            else:
                metadata["fallback_applied"] = True
                metadata["effective_source"] = NoiseSource.RMSD.value
                metadata["source"] = metadata["effective_source"]
                metadata["fallback_reason"] = "No duplicate delays detected and lineshape covariance unavailable; fell back to spectral RMSD."
                rmsd_val = compute_spectral_rmsd_noise(intensities, spectral_rmsd)
                return np.full(n_points, rmsd_val), metadata

    # 3. Spectral RMSD
    elif req_source == NoiseSource.RMSD:
        rmsd_val = compute_spectral_rmsd_noise(intensities, spectral_rmsd)
        metadata["source"] = metadata["effective_source"]
        return np.full(n_points, rmsd_val), metadata

    # 4. Residual-scaled (Initial baseline before fit inflation)
    elif req_source == NoiseSource.RESIDUAL_SCALED:
        metadata["label"] = "Residual-scaled (absorbs systematic error into noise term)"
        metadata["source"] = metadata["effective_source"]
        if has_lineshape:
            return clean_lineshape, metadata
        elif has_duplicates:
            return np.full(n_points, dup_sigma), metadata
        else:
            rmsd_val = compute_spectral_rmsd_noise(intensities, spectral_rmsd)
            return np.full(n_points, rmsd_val), metadata

    # General catch-all
    rmsd_val = compute_spectral_rmsd_noise(intensities, spectral_rmsd)
    metadata["source"] = metadata["effective_source"]
    return np.full(n_points, rmsd_val), metadata


def apply_residual_scaling(
    sigmas: np.ndarray,
    residuals: np.ndarray,
    n_params: int = 2,
) -> Tuple[np.ndarray, float]:
    """
    Inflate noise sigma vector so that reduced chi-square = 1.0.

    redchi = sum((residuals / sigma)^2) / (N - p)
    sigma_scaled = sigma * sqrt(redchi)

    Returns:
        (scaled_sigmas, redchi_factor)
    """
    sigmas = np.asarray(sigmas, dtype=np.float64)
    residuals = np.asarray(residuals, dtype=np.float64)
    n = len(residuals)
    dof = max(n - n_params, 1)

    with np.errstate(divide="ignore", invalid="ignore"):
        norm_res = residuals / np.where(sigmas > 1e-12, sigmas, 1.0)
        chisqr = float(np.sum(norm_res**2))
        redchi = chisqr / dof

    if redchi > 1e-12 and not np.isnan(redchi) and not np.isinf(redchi):
        scale_factor = float(np.sqrt(redchi))
        scaled_sigmas = sigmas * scale_factor
        return scaled_sigmas, scale_factor

    return sigmas, 1.0
