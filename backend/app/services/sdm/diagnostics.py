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
    tau_c_method: str
    correlation: Optional[TauMSolution]
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
        corr = self.correlation
        return {
            "tau_c_estimate_s": self.tau_c_estimate,
            "tau_c_estimate_ns": (
                self.tau_c_estimate * 1e9 if self.tau_c_estimate is not None else None
            ),
            "tau_c_method": self.tau_c_method,
            "correlation_fit": (
                {
                    "alpha": corr.alpha,
                    # Reported in ns rad^-1, the unit the source paper quotes
                    # beta in and the unit the J values are displayed in.
                    "beta_ns_rad": corr.beta * 1e9,
                    "r": corr.r,
                    "roots_ns": [t * 1e9 for t in corr.roots],
                    "positive_roots_ns": [t * 1e9 for t in corr.positive_roots],
                    "selected_reason": corr.selected_reason,
                }
                if corr else None
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

    # Overall tumbling time. The correlation method of Lefevre, Dayie, Peng &
    # Wagner (1996) uses the whole dataset -- fit J(wN) = alpha J(0) + beta,
    # then solve the resulting cubic -- rather than a single ratio of trimmed
    # means, so it is preferred. The ratio remains the fallback for datasets
    # too small or too degenerate to fit a line to.
    fit = fit_j_correlation(j0, jwn)
    correlation = (
        tau_m_from_correlation(fit, mapping.physics.omega_n, j0_reference=j0_ref)
        if fit else None
    )

    if correlation is not None and correlation.tau_m is not None:
        tau_global = correlation.tau_m
        tau_method = "correlation"
    else:
        tau_global = tau_c_from_ratio(j0_ref, jwn_ref, mapping.physics.omega_n)
        tau_method = "trimmed_ratio"

    return DatasetDiagnostics(
        tau_c_estimate=tau_global,
        tau_c_method=tau_method,
        correlation=correlation,
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


@dataclass
class JCorrelationFit:
    """Linear least-squares fit of J(omega_N) against J(0).

    Lefevre, Dayie, Peng & Wagner (1996) Biochemistry 35, 2674-2686 proposed
    that the reduced spectral densities of a folded protein fall on a line

        J(omega_N) = alpha J(0) + beta

    from which the overall tumbling time follows analytically. Both spectral
    densities are in s rad^-1 here, so beta is too and alpha is dimensionless.

    Attributes:
        alpha: slope, dimensionless.
        beta: intercept [s rad^-1].
        r: Pearson correlation coefficient of the fit. Routinely POOR for
            this correlation -- the source paper reports 21.8% -- because the
            residues crowd into a narrow range of J(0). A weak r does not by
            itself invalidate tau_m, but it is reported rather than hidden,
            since it is the honest measure of how well the line describes the
            data.
        n: number of residues in the fit.
    """

    alpha: float
    beta: float
    r: float
    n: int


def fit_j_correlation(
    j0: Sequence[float],
    jwn: Sequence[float],
) -> Optional[JCorrelationFit]:
    """Least-squares fit of J(omega_N) = alpha J(0) + beta.

    Returns None when fewer than three finite pairs are available, where a
    two-parameter line has no residual to speak of.
    """
    x = np.asarray(j0, dtype=np.float64)
    y = np.asarray(jwn, dtype=np.float64)
    good = np.isfinite(x) & np.isfinite(y)
    x, y = x[good], y[good]
    if x.size < 3 or np.ptp(x) <= 0:
        return None

    alpha, beta = np.polyfit(x, y, 1)
    sx, sy = np.std(x), np.std(y)
    r = float(np.corrcoef(x, y)[0, 1]) if sx > 0 and sy > 0 else 0.0
    return JCorrelationFit(alpha=float(alpha), beta=float(beta), r=r, n=int(x.size))


@dataclass
class TauMSolution:
    """Overall tumbling time from the J(omega_N) vs J(0) correlation.

    Attributes:
        tau_m: the selected root [s], or None when none is physical.
        roots: every real root of the cubic [s], ascending.
        positive_roots: the real positive subset [s].
        selected_reason: why tau_m was chosen, for the report.
        alpha, beta, r: the fit it came from.
    """

    tau_m: Optional[float]
    roots: List[float]
    positive_roots: List[float]
    selected_reason: str
    alpha: float
    beta: float
    r: float


def tau_m_from_correlation(
    fit: JCorrelationFit,
    omega_n: float,
    j0_reference: Optional[float] = None,
) -> TauMSolution:
    """Solve for tau_m from a fitted J(omega_N) = alpha J(0) + beta.

    Substituting the rigid-rotor forms J(0) = (2/5) tau_m and
    J(omega_N) = (2/5) tau_m / (1 + (omega_N tau_m)^2) into the fitted line
    and clearing denominators gives

        2 alpha w^2 tau^3 + 5 beta w^2 tau^2 + 2(alpha - 1) tau + 5 beta = 0

    Verified against the worked example in the source: alpha = 0.0772,
    beta = 0.2182 ns/rad at 600 MHz yields roots near -13.4, 0.63 and 5.73 ns
    against the published -14.4, 0.6 and 5.7 ns.

    ROOT SELECTION. The source chooses "the most realistic value" by eye,
    which is not a rule that generalises: with two positive roots the larger
    is right, but a slightly negative alpha -- a line sloping the wrong way
    for any rigid rotor -- produces a THIRD positive root far outside the
    data, and taking the largest then returns something like 140 ns for a
    protein tumbling in ten.

    So the root is chosen by whether it describes the data it was fitted to.
    A rigid rotor has J(0) = (2/5) tau_m, so each root implies a J(0); the
    root whose implied J(0) is closest to the dataset's own trimmed-mean J(0)
    wins. That is physical rather than aesthetic, and reproduces the source's
    choice as well as rejecting the spurious root above.

    Every root is reported regardless, with the reason for the choice, so the
    selection can be overridden by someone who disagrees with it.

    Args:
        j0_reference: trimmed-mean J(0) of the dataset [s rad^-1]. Without
            it the slow-tumbling branch is used as a weaker fallback.
    """
    w = abs(float(omega_n))
    coeffs = [
        2.0 * fit.alpha * w ** 2,
        5.0 * fit.beta * w ** 2,
        2.0 * (fit.alpha - 1.0),
        5.0 * fit.beta,
    ]

    roots: List[float] = []
    if abs(coeffs[0]) > 0:
        raw = np.roots(coeffs)
        # A root is real when its imaginary part is negligible next to its
        # own magnitude, not against an absolute floor.
        roots = sorted(
            float(z.real) for z in raw
            if abs(z.imag) <= 1e-8 * max(abs(z), 1.0)
        )

    positive = [t for t in roots if t > 0]
    boundary = 1.0 / w if w > 0 else float("inf")

    if not positive:
        tau_m = None
        reason = (
            "no positive real root; the fitted line is not consistent with a "
            "rigid rotor"
        )
    elif j0_reference is not None and np.isfinite(j0_reference) and j0_reference > 0:
        # Each root implies J(0) = (2/5) tau; pick the one that matches the
        # J(0) actually observed.
        best = min(positive, key=lambda t: abs(0.4 * t - j0_reference))
        tau_m = best
        implied = 0.4 * best
        reason = (
            f"root whose implied J(0) = (2/5)tau_m = {implied * 1e9:.2f} ns/rad "
            f"is closest to the observed trimmed mean "
            f"{j0_reference * 1e9:.2f} ns/rad"
        )
        if len(positive) > 1:
            reason += f"; {len(positive)} positive roots were available"
    else:
        slow = [t for t in positive if t > boundary]
        tau_m = min(slow) if slow else max(positive)
        reason = (
            "smallest positive root on the slow-tumbling branch "
            f"(omega_N*tau > 1, boundary {boundary * 1e9:.2f} ns); "
            "no J(0) reference was supplied to check it against"
            if slow else
            "largest positive root; none clears omega_N*tau = 1"
        )

    if fit.alpha < 0:
        reason += (
            ". NOTE: the fitted slope is negative, which no rigid rotor can "
            "produce, so tau_m from this fit is not well founded"
        )

    return TauMSolution(
        tau_m=tau_m,
        roots=roots,
        positive_roots=positive,
        selected_reason=reason,
        alpha=fit.alpha,
        beta=fit.beta,
        r=fit.r,
    )
