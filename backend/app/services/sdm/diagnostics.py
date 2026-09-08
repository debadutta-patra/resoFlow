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
Interpretation helpers for a mapped dataset: a global tau_c estimate, the
geometry of the J(0) vs J(wN) correlation plot, and per-residue flags.

These are diagnostics, not fits. Everything here is descriptive, and the
flags are advisory -- nothing is silently dropped on their account.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

from .mapping import SdmMapping

# Flag identifiers, surfaced verbatim in the API, the residue table and the
# CSV export so a user can see exactly why a residue is marked.
FLAG_NEGATIVE_NOE = "negative_noe"
FLAG_LOW_NOE_PRECISION = "low_noe_precision"
FLAG_NEGATIVE_J = "negative_j"
FLAG_HIGH_J0 = "elevated_j0"
FLAG_LOW_J0 = "reduced_j0"

FLAG_DESCRIPTIONS: Dict[str, str] = {
    FLAG_NEGATIVE_NOE: (
        "Heteronuclear NOE is negative. Physically valid for flexible tails "
        "and loops, and NOT filtered -- but J(0.87 wH) then carries very "
        "large relative error."
    ),
    FLAG_LOW_NOE_PRECISION: (
        "NOE uncertainty dominates J(0.87 wH). The NOE error propagates into "
        "J_h almost entirely, so treat J_h for this residue as indicative."
    ),
    FLAG_NEGATIVE_J: (
        "A spectral density came out negative, which is unphysical. Usually "
        "a sign of inconsistent input rates, a field mismatch, or an "
        "over-subtracted Rex."
    ),
    FLAG_HIGH_J0: (
        "J(0) sits well above the trimmed mean. Base RSDM assumes no chemical "
        "exchange, and exchange contamination lands entirely on J(0), so this "
        "is the expected signature of exchange rather than of slow tumbling."
    ),
    FLAG_LOW_J0: (
        "J(0) sits well below the trimmed mean, the expected signature of "
        "fast internal motion."
    ),
}


def trimmed_mean(values: np.ndarray, trim_fraction: float = 0.1) -> float:
    """Symmetric trimmed mean, robust to the exchange-broadened tail.

    A plain mean of J(0) is pulled up by exactly the residues one wants to
    identify as outliers, so the reference value is trimmed.
    """
    v = np.asarray(values, dtype=np.float64)
    v = v[np.isfinite(v)]
    if v.size == 0:
        return float("nan")
    if v.size < 3 or trim_fraction <= 0:
        return float(np.mean(v))
    k = int(math.floor(v.size * trim_fraction))
    ordered = np.sort(v)
    if 2 * k >= v.size:
        return float(np.median(v))
    return float(np.mean(ordered[k:v.size - k]))


def tau_c_from_ratio(j0: float, jwn: float, omega_n: float) -> Optional[float]:
    """Isotropic rigid-rotor tau_c from the J(0)/J(wN) ratio.

    For J(w) = (2/5) tau / (1 + (w tau)^2),
        J(0)/J(wN) = 1 + (wN tau)^2   =>   tau = sqrt(J0/JwN - 1)/|wN|

    Returns None when the ratio is below 1, which the rigid-rotor model
    cannot produce and which therefore signals internal motion or noise
    rather than a shorter correlation time.
    """
    if not (np.isfinite(j0) and np.isfinite(jwn)) or jwn <= 0 or j0 <= 0:
        return None
    ratio = j0 / jwn
    if ratio <= 1.0:
        return None
    return math.sqrt(ratio - 1.0) / abs(omega_n)


def rigid_rotor_curve(
    omega_n: float,
    j0_min: float,
    j0_max: float,
    n_points: int = 200,
) -> Tuple[np.ndarray, np.ndarray]:
    """The rigid-rotor locus for the J(0) vs J(wN) correlation plot.

    Parametrised by tau: J(0) = (2/5) tau and J(wN) = J(0)/(1 + (wN tau)^2).
    Residues fall off this line in two characteristic directions -- exchange
    displaces points along J(0), fast internal motion drops them below -- so
    the line is what makes the plot readable.

    Returns:
        (j0_values, jwn_values), both in the same units as the input bounds.
    """
    lo = max(float(j0_min), 1e-15)
    hi = max(float(j0_max), lo * 1.0000001)
    j0 = np.linspace(lo, hi, int(n_points))
    tau = 2.5 * j0
    jwn = j0 / (1.0 + (omega_n * tau) ** 2)
    return j0, jwn


@dataclass
class ResidueDiagnostics:
    """Per-residue advisory flags and derived values."""

    index: int
    flags: List[str] = field(default_factory=list)
    tau_c: Optional[float] = None
    noe_error_share_jh: Optional[float] = None


@dataclass
class DatasetDiagnostics:
    """Dataset-level summary of a mapped set of residues."""

    tau_c_estimate: Optional[float]
    tau_c_j0_trimmed: float
    tau_c_jwn_trimmed: float
    j0_trimmed_mean: float
    jwn_trimmed_mean: float
    jh_trimmed_mean: float
    n_residues: int
    n_flagged: int
    flag_counts: Dict[str, int]
    residues: List[ResidueDiagnostics]

    def to_dict(self) -> Dict[str, object]:
        return {
            "tau_c_estimate_s": self.tau_c_estimate,
            "tau_c_estimate_ns": (
                self.tau_c_estimate * 1e9 if self.tau_c_estimate is not None else None
            ),
            "j0_trimmed_mean": self.j0_trimmed_mean,
            "jwn_trimmed_mean": self.jwn_trimmed_mean,
            "jh_trimmed_mean": self.jh_trimmed_mean,
            "n_residues": self.n_residues,
            "n_flagged": self.n_flagged,
            "flag_counts": dict(self.flag_counts),
            "flag_descriptions": {
                k: FLAG_DESCRIPTIONS[k] for k in self.flag_counts if k in FLAG_DESCRIPTIONS
            },
        }


def analyse(
    mapping: SdmMapping,
    noe: Sequence[float],
    noe_err: Sequence[float],
    j0_outlier_sigma: float = 2.5,
    noe_precision_threshold: float = 0.5,
) -> DatasetDiagnostics:
    """Derive tau_c, flags and summary statistics for a mapped dataset.

    Args:
        mapping: the result of map_dataset.
        noe, noe_err: the NOE inputs, for the precision flags.
        j0_outlier_sigma: how far from the trimmed mean, in robust sigma, a
            J(0) must sit to be flagged.
        noe_precision_threshold: relative NOE error above which J_h is
            considered precision-limited.

    Returns:
        DatasetDiagnostics.
    """
    j0 = mapping.j0
    jwn = mapping.jwn
    jh = mapping.jh
    noe_a = np.asarray(noe, dtype=np.float64)
    noe_e = np.asarray(noe_err, dtype=np.float64)
    n = j0.shape[0]

    j0_ref = trimmed_mean(j0)
    jwn_ref = trimmed_mean(jwn)
    jh_ref = trimmed_mean(jh)

    # Robust scale: MAD, scaled to be a consistent estimator of sigma for
    # Gaussian data. Using the plain standard deviation here would be
    # inflated by the very outliers being tested for.
    finite_j0 = j0[np.isfinite(j0)]
    if finite_j0.size:
        mad = float(np.median(np.abs(finite_j0 - np.median(finite_j0))))
        scale = mad * 1.4826 if mad > 0 else float(np.std(finite_j0))
    else:
        scale = 0.0

    residues: List[ResidueDiagnostics] = []
    flag_counts: Dict[str, int] = {}

    with np.errstate(divide="ignore", invalid="ignore"):
        rel_noe_err = np.abs(noe_e / np.where(np.abs(noe_a) > 0, noe_a, np.nan))

    for i in range(n):
        rd = ResidueDiagnostics(index=i)

        if np.isfinite(noe_a[i]) and noe_a[i] < 0:
            rd.flags.append(FLAG_NEGATIVE_NOE)
        if np.isfinite(rel_noe_err[i]) and rel_noe_err[i] > noe_precision_threshold:
            rd.flags.append(FLAG_LOW_NOE_PRECISION)
        if any(np.isfinite(v) and v < 0 for v in (j0[i], jwn[i], jh[i])):
            rd.flags.append(FLAG_NEGATIVE_J)
        if scale > 0 and np.isfinite(j0[i]):
            z = (j0[i] - j0_ref) / scale
            if z > j0_outlier_sigma:
                rd.flags.append(FLAG_HIGH_J0)
            elif z < -j0_outlier_sigma:
                rd.flags.append(FLAG_LOW_J0)

        rd.tau_c = tau_c_from_ratio(float(j0[i]), float(jwn[i]),
                                    mapping.physics.omega_n)
        rd.noe_error_share_jh = (
            float(rel_noe_err[i]) if np.isfinite(rel_noe_err[i]) else None
        )

        for f in rd.flags:
            flag_counts[f] = flag_counts.get(f, 0) + 1
        residues.append(rd)

    tau_global = tau_c_from_ratio(j0_ref, jwn_ref, mapping.physics.omega_n)

    return DatasetDiagnostics(
        tau_c_estimate=tau_global,
        tau_c_j0_trimmed=j0_ref,
        tau_c_jwn_trimmed=jwn_ref,
        j0_trimmed_mean=j0_ref,
        jwn_trimmed_mean=jwn_ref,
        jh_trimmed_mean=jh_ref,
        n_residues=n,
        n_flagged=sum(1 for r in residues if r.flags),
        flag_counts=flag_counts,
        residues=residues,
    )


def error_ellipse(
    covariance_2x2: np.ndarray,
    n_sigma: float = 1.0,
    n_points: int = 64,
) -> Tuple[np.ndarray, np.ndarray]:
    """Points tracing an error ellipse for a 2x2 covariance block.

    The correlation plot needs ellipses rather than independent error bars:
    J(0) and J(wN) are correlated by construction, so crossed bars overstate
    the plausible region along one diagonal and understate it along the other.

    Returns:
        (dx, dy) offsets from the centre, to be added to the point.
    """
    cov = np.asarray(covariance_2x2, dtype=np.float64)
    # Symmetric PSD by construction; eigh is the stable choice.
    vals, vecs = np.linalg.eigh(0.5 * (cov + cov.T))
    vals = np.clip(vals, 0.0, None)
    theta = np.linspace(0.0, 2.0 * np.pi, int(n_points))
    unit = np.vstack([np.cos(theta), np.sin(theta)])
    scaled = (vecs * (n_sigma * np.sqrt(vals))) @ unit
    return scaled[0], scaled[1]
