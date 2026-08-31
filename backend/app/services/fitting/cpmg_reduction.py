from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Tuple
import numpy as np


def compute_r2eff_profile(
    ncycs: List[float],
    intensities: List[float],
    uncertainties: Optional[List[float]],
    time_t2: float,
) -> Dict[str, Any]:
    """
    Compute nu_cpmg, R2eff and propagated errors from raw intensity profile.
    Plane with ncyc == 0 is the reference plane (I0).
    """
    if time_t2 <= 0:
        raise ValueError("time_t2 must be positive")

    # Find reference plane
    ref_idx = None
    for idx, ncyc in enumerate(ncycs):
        if abs(ncyc) < 1e-6:
            ref_idx = idx
            break

    if ref_idx is None:
        return {
            "error": "Missing reference plane (ncyc = 0)",
            "nu_cpmg": [],
            "r2eff": [],
            "r2eff_err": [],
            "valid": False,
        }

    i0 = intensities[ref_idx]
    if i0 <= 0:
        return {
            "error": f"Non-positive reference intensity: {i0}",
            "nu_cpmg": [],
            "r2eff": [],
            "r2eff_err": [],
            "valid": False,
        }

    i0_err = uncertainties[ref_idx] if uncertainties and len(uncertainties) > ref_idx else (0.02 * i0)

    raw_points = []
    invalid_points: List[int] = []
    for idx, (ncyc, i_val) in enumerate(zip(ncycs, intensities)):
        if abs(ncyc) < 1e-6:
            continue  # Skip reference plane in R2eff dispersion curve

        nu = ncyc / time_t2
        if i_val <= 0:
            invalid_points.append(idx)
            continue

        ratio = i_val / i0
        r2eff = -math.log(ratio) / time_t2

        i_err = uncertainties[idx] if uncertainties and len(uncertainties) > idx else (0.02 * i_val)
        # Error propagation: sigma_R2 = (1 / time_t2) * sqrt((sigma_I / I)^2 + (sigma_I0 / I0)^2)
        rel_err_sq = (i_err / i_val) ** 2 + (i0_err / i0) ** 2
        r2eff_err = math.sqrt(rel_err_sq) / time_t2

        raw_points.append((nu, r2eff, r2eff_err))

    # Always sort points ascending by CPMG frequency
    raw_points.sort(key=lambda p: p[0])
    nu_list = [p[0] for p in raw_points]
    r2eff_list = [p[1] for p in raw_points]
    err_list = [p[2] for p in raw_points]

    return {
        "nu_cpmg": nu_list,
        "r2eff": r2eff_list,
        "r2eff_err": err_list,
        "i0": i0,
        "i0_err": i0_err,
        "invalid_points": invalid_points,
        "valid": len(nu_list) > 0,
    }


def compute_rex_and_flatness(
    nu_cpmg: List[float],
    r2eff: List[float],
    r2eff_err: List[float],
) -> Dict[str, Any]:
    """
    Compute Rex = R2eff(nu_min) - R2eff(nu_max) and chi2 flatness score against horizontal line.
    Averages duplicate points at the minimum and maximum frequencies.
    """
    if len(nu_cpmg) < 2 or len(r2eff) < 2:
        return {
            "rex": 0.0,
            "rex_err": 0.0,
            "chi2_red": 0.0,
            "is_flat": True,
        }

    # Sort by nu_cpmg
    points = sorted(zip(nu_cpmg, r2eff, r2eff_err), key=lambda p: p[0])
    nu_sorted = [p[0] for p in points]
    r2_sorted = [p[1] for p in points]
    err_sorted = [p[2] if p[2] > 1e-6 else 1.0 for p in points]

    min_nu = nu_sorted[0]
    max_nu = nu_sorted[-1]

    # Collect points at min_nu and max_nu (accounting for possible duplicates)
    min_pts = [(r, e) for n, r, e in points if abs(n - min_nu) < 1e-3]
    max_pts = [(r, e) for n, r, e in points if abs(n - max_nu) < 1e-3]

    r2_min = float(np.mean([p[0] for p in min_pts]))
    err_min = math.sqrt(sum(p[1] ** 2 for p in min_pts)) / len(min_pts)

    r2_max = float(np.mean([p[0] for p in max_pts]))
    err_max = math.sqrt(sum(p[1] ** 2 for p in max_pts)) / len(max_pts)

    rex = r2_min - r2_max
    rex_err = math.sqrt(err_min ** 2 + err_max ** 2)

    # Flatness test: weighted mean and chi-square
    weights = [1.0 / (e ** 2) for e in err_sorted]
    sum_w = sum(weights)
    weighted_mean_r2 = sum(w * r for w, r in zip(weights, r2_sorted)) / sum_w if sum_w > 0 else float(np.mean(r2_sorted))

    chi2 = sum(w * ((r - weighted_mean_r2) ** 2) for w, r in zip(weights, r2_sorted))
    dof = max(1, len(r2_sorted) - 1)
    chi2_red = chi2 / dof

    return {
        "rex": max(0.0, rex),
        "rex_raw": rex,
        "rex_err": rex_err,
        "chi2_red": chi2_red,
        "is_flat": chi2_red < 1.5,
        "weighted_mean_r2": weighted_mean_r2,
    }


def estimate_delta_omega_fast_exchange(
    rex: float,
    kex: float,
    pb: float,
    b0_mhz: float,
    xi_ratio: float = 0.101329118,
) -> float:
    """
    Estimate unsigned |dw| (ppm) from Rex in the fast-exchange limit:
    Rex = pa * pb * dw^2 / kex
    => |dw_rad_s| = sqrt(Rex * kex / (pa * pb))
    => |dw_ppm| = |dw_rad_s| / (2 * pi * B0 * xi)
    """
    if rex <= 0 or kex <= 0 or pb <= 0 or pb >= 1.0 or b0_mhz <= 0:
        return 0.0

    pa = 1.0 - pb
    denom = pa * pb
    if denom <= 1e-9:
        return 0.0

    dw_rad_s = math.sqrt((rex * kex) / denom)
    nu0_mhz = b0_mhz * xi_ratio
    dw_ppm = dw_rad_s / (2.0 * math.pi * nu0_mhz)
    return round(dw_ppm, 3)
