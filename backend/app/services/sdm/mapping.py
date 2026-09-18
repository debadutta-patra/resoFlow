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
The reduced spectral density map itself: rates in, J values plus their full
covariance out, vectorised across residues.

Base RSDM assumes NO CHEMICAL EXCHANGE. Because R1 and the NOE carry no Rex,
any exchange contribution lands entirely on J(0) -- which is also the value
users over-interpret. That caveat belongs next to the plot in the UI, not
only in the docs.

Units are angular throughout: rates in s^-1, J in s rad^-1. Conversion to
ns rad^-1 happens at the display and export boundary.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Optional, Sequence, Tuple

import numpy as np

from .constants import GAMMA_RATIO_N_H, SdmConstants, perturb
from .physics import (
    DEFAULT_OBSERVABLE_ORDER,
    FieldPhysics,
    build_rsdm_matrix,
    field_physics,
)

ProgressCallback = Callable[[int, int, str], None]

# Column order of the returned J vector and covariance, matching
# physics.build_rsdm_matrix's canonical ordering.
J_LABELS = ("J0", "JwN", "Jh")

S_RAD_TO_NS_RAD = 1e9
"""J values are computed in s rad^-1 and reported in ns rad^-1."""


def cross_relaxation_rate(noe: np.ndarray, r1: np.ndarray) -> np.ndarray:
    """sigma = (gamma_N/gamma_H)(NOE - 1) R1.

    The gamma ratio is negative and is NOT squared here. A sign error at this
    point yields J_h of the wrong sign, which looks like a small anomaly
    rather than an obvious failure.
    """
    return GAMMA_RATIO_N_H * (np.asarray(noe, dtype=np.float64) - 1.0) * np.asarray(
        r1, dtype=np.float64
    )


def build_transform(
    r1: np.ndarray,
    noe: np.ndarray,
    with_rex: bool = False,
) -> np.ndarray:
    """Jacobian T = d(y)/d(u) mapping measurement errors onto the rate vector.

    With u = (R1, R2, NOE) and y = (R1, R2, sigma):

            [ 1            0   0        ]
        T = [ 0            1   0        ]
            [ k(NOE - 1)   0   k * R1   ]        k = gamma_N/gamma_H

    The bottom-left entry is where the R1-sigma correlation enters, because
    sigma is a product of two measured quantities and R1 appears in both y1
    and y3. Dropping it -- treating sigma as an independent observable -- is
    the most common quiet error in published RSDM error bars, and it biases
    J(0) and J(wN) as well as J_h. There is a test that fails without it.

    With `with_rex`, u gains a fourth component and y2 = R2 - Rex, so the
    matrix gains a column [0, -1, 0]^T.

    Returns:
        (N, 3, 3) array, or (N, 3, 4) when with_rex.
    """
    r1 = np.asarray(r1, dtype=np.float64)
    noe = np.asarray(noe, dtype=np.float64)
    n = r1.shape[0]
    n_inputs = 4 if with_rex else 3
    t = np.zeros((n, 3, n_inputs), dtype=np.float64)
    t[:, 0, 0] = 1.0
    t[:, 1, 1] = 1.0
    t[:, 2, 0] = GAMMA_RATIO_N_H * (noe - 1.0)
    t[:, 2, 2] = GAMMA_RATIO_N_H * r1
    if with_rex:
        t[:, 1, 3] = -1.0
    return t


def build_input_covariance(
    r1_err: np.ndarray,
    r2_err: np.ndarray,
    noe_err: np.ndarray,
    rex_err: Optional[np.ndarray] = None,
    rex_r2_covariance: Optional[np.ndarray] = None,
) -> np.ndarray:
    """Assemble Cov_u, diagonal in the measured quantities by default.

    R1, R2 and the NOE come from three separate experiments, so treating them
    as uncorrelated is right. Rex is different: if it was fitted from data
    that shares the R2 measurement, that covariance is real and is accepted
    via `rex_r2_covariance`.

    Returns:
        (N, 3, 3) array, or (N, 4, 4) when rex_err is given.
    """
    r1_err = np.asarray(r1_err, dtype=np.float64)
    r2_err = np.asarray(r2_err, dtype=np.float64)
    noe_err = np.asarray(noe_err, dtype=np.float64)
    n = r1_err.shape[0]

    if rex_err is None:
        cov = np.zeros((n, 3, 3), dtype=np.float64)
    else:
        cov = np.zeros((n, 4, 4), dtype=np.float64)
        rex_err = np.asarray(rex_err, dtype=np.float64)
        cov[:, 3, 3] = rex_err ** 2
        if rex_r2_covariance is not None:
            crc = np.asarray(rex_r2_covariance, dtype=np.float64)
            cov[:, 1, 3] = crc
            cov[:, 3, 1] = crc

    cov[:, 0, 0] = r1_err ** 2
    cov[:, 1, 1] = r2_err ** 2
    cov[:, 2, 2] = noe_err ** 2
    return cov


@dataclass
class SdmMapping:
    """Per-residue spectral densities with their full covariance.

    Attributes:
        j: (N, 3) array of [J(0), J(wN), J_h] in s rad^-1.
        covariance: (N, 3, 3) covariance of j. DENSE even when the input
            covariance is diagonal -- the three J values are mutually
            correlated, and any derived quantity (a tau_c estimate, a trimmed
            mean, the error ellipses on the correlation plot) needs the
            off-diagonals. Storing only the three variances throws that away.
        sigma: (N,) cross-relaxation rates [s^-1].
        sigma_err: (N,) standard errors on sigma [s^-1].
        matrix: (3, 3) coefficient matrix, shared by every residue.
        columns: labels of the J columns.
        rows: labels of the rate rows.
        physics: the field/constants context the matrix was built from.
    """

    j: np.ndarray
    covariance: np.ndarray
    sigma: np.ndarray
    sigma_err: np.ndarray
    matrix: np.ndarray
    columns: Sequence[str]
    rows: Sequence[str]
    physics: FieldPhysics

    @property
    def j0(self) -> np.ndarray:
        return self.j[:, 0]

    @property
    def jwn(self) -> np.ndarray:
        return self.j[:, 1]

    @property
    def jh(self) -> np.ndarray:
        return self.j[:, 2]

    @property
    def errors(self) -> np.ndarray:
        """(N, 3) standard errors, i.e. sqrt of the covariance diagonal.

        Provided for plotting convenience. It is a lossy view of `covariance`
        and must not be used where the correlations matter.
        """
        var = np.einsum("nii->ni", self.covariance)
        return np.sqrt(np.clip(var, 0.0, None))

    def j_ns(self) -> np.ndarray:
        """J values in ns rad^-1, for display and export."""
        return self.j * S_RAD_TO_NS_RAD

    def errors_ns(self) -> np.ndarray:
        """Standard errors in ns rad^-1, for display and export."""
        return self.errors * S_RAD_TO_NS_RAD


def map_dataset(
    r1: np.ndarray,
    r1_err: np.ndarray,
    r2: np.ndarray,
    r2_err: np.ndarray,
    noe: np.ndarray,
    noe_err: np.ndarray,
    physics: FieldPhysics,
    rex: Optional[np.ndarray] = None,
    rex_err: Optional[np.ndarray] = None,
    rex_r2_covariance: Optional[np.ndarray] = None,
    observable_order: Sequence[str] = DEFAULT_OBSERVABLE_ORDER,
) -> SdmMapping:
    """Map per-residue R1/R2/NOE onto J(0), J(wN) and J_h with covariance.

    The matrix contains no measured quantities, so the rate -> density map is
    exactly linear and the analytic propagation below is EXACT for Gaussian
    input errors, not a first-order approximation. The only nonlinearity in
    the whole chain is sigma = k(NOE-1)R1, a product of two measured values,
    and that is precisely what T linearises.

    Args:
        r1, r2: relaxation rates [s^-1], shape (N,).
        noe: heteronuclear NOE ratios I_sat/I_ref, shape (N,). Negative and
            near-zero values are physically valid (tails, flexible loops) and
            are mapped, not filtered -- though they carry very large relative
            error in J_h, which the diagnostics flag.
        *_err: standard errors on the same scale.
        physics: field and constants context; build once per analysis.
        rex: optional per-residue exchange contribution [s^-1], subtracted
            from R2 before mapping. M is untouched.
        rex_err: standard error on rex.
        rex_r2_covariance: covariance between the Rex estimate and the R2
            measurement, when the two share data.
        observable_order: row order of the linear system.

    Returns:
        SdmMapping.

    Raises:
        ValueError: if the inputs disagree in length, or the system is
            singular.
    """
    arrays = [np.atleast_1d(np.asarray(a, dtype=np.float64))
              for a in (r1, r1_err, r2, r2_err, noe, noe_err)]
    lengths = {a.shape[0] for a in arrays}
    if len(lengths) != 1:
        raise ValueError(
            f"All inputs must have the same length; got {[a.shape[0] for a in arrays]}"
        )
    r1_a, r1_e, r2_a, r2_e, noe_a, noe_e = arrays
    n = r1_a.shape[0]

    matrix, columns, rows = build_rsdm_matrix(physics, observable_order)
    det = float(np.linalg.det(matrix))
    if not np.isfinite(det) or abs(det) < 1e-300:
        raise ValueError(
            f"RSDM coefficient matrix is singular (det={det}); "
            "check B0 and the constants."
        )
    matrix_inv = np.linalg.inv(matrix)

    with_rex = rex is not None
    if with_rex:
        rex_a = np.atleast_1d(np.asarray(rex, dtype=np.float64))
        if rex_a.shape[0] != n:
            raise ValueError("rex must have the same length as the rates")
        rex_e = (np.atleast_1d(np.asarray(rex_err, dtype=np.float64))
                 if rex_err is not None else np.zeros(n))
        r2_effective = r2_a - rex_a
    else:
        rex_e = None
        r2_effective = r2_a

    sigma = cross_relaxation_rate(noe_a, r1_a)

    # y is stacked in `rows` order, so a caller reordering the observables
    # gets a consistent system rather than a silently transposed one.
    row_values = {"R1": r1_a, "R2": r2_effective, "sigma": sigma}
    y = np.vstack([row_values[name] for name in rows])          # (3, N)

    j = np.linalg.solve(matrix, y).T                            # (N, 3)

    transform = build_transform(r1_a, noe_a, with_rex=with_rex)  # (N,3,3|4)
    cov_u = build_input_covariance(
        r1_e, r2_e, noe_e, rex_err=rex_e, rex_r2_covariance=rex_r2_covariance
    )

    # A = M^-1 T, then Cov_x = A Cov_u A^T, per residue.
    a_mat = np.einsum("ij,njk->nik", matrix_inv, transform)
    cov_x = np.einsum("nij,njk,nlk->nil", a_mat, cov_u, a_mat)
    # Symmetrise against accumulated floating-point asymmetry.
    cov_x = 0.5 * (cov_x + np.transpose(cov_x, (0, 2, 1)))

    sigma_var = np.einsum("nj,njk,nk->n", transform[:, 2, :], cov_u, transform[:, 2, :])
    sigma_err = np.sqrt(np.clip(sigma_var, 0.0, None))

    return SdmMapping(
        j=j,
        covariance=cov_x,
        sigma=sigma,
        sigma_err=sigma_err,
        matrix=matrix,
        columns=columns,
        rows=rows,
        physics=physics,
    )


def monte_carlo_covariance(
    r1: np.ndarray,
    r1_err: np.ndarray,
    r2: np.ndarray,
    r2_err: np.ndarray,
    noe: np.ndarray,
    noe_err: np.ndarray,
    physics: FieldPhysics,
    n_replicates: int = 2000,
    seed: Optional[int] = None,
    observable_order: Sequence[str] = DEFAULT_OBSERVABLE_ORDER,
    progress_callback: Optional[ProgressCallback] = None,
    chunk_size: int = 500,
) -> Tuple[np.ndarray, np.ndarray]:
    """Monte Carlo covariance, as a CROSS-CHECK on the analytic result.

    This is deliberately not the default. The analytic propagation is exact
    for Gaussian inputs, so MC can only agree with it to within MC error --
    it exists to demonstrate that agreement, and to catch an implementation
    slip in the analytic path.

    Args:
        n_replicates: number of resampled datasets.
        seed: RNG seed for reproducibility.
        progress_callback: called as (done, total, message) per chunk, so a
            Celery task can emit progress events.
        chunk_size: replicates per batch; bounds peak memory at roughly
            chunk_size * N * 3 floats.

    Returns:
        (mean_j, cov_j) with shapes (N, 3) and (N, 3, 3).
    """
    rng = np.random.default_rng(seed)
    r1_a = np.atleast_1d(np.asarray(r1, dtype=np.float64))
    r2_a = np.atleast_1d(np.asarray(r2, dtype=np.float64))
    noe_a = np.atleast_1d(np.asarray(noe, dtype=np.float64))
    r1_e = np.atleast_1d(np.asarray(r1_err, dtype=np.float64))
    r2_e = np.atleast_1d(np.asarray(r2_err, dtype=np.float64))
    noe_e = np.atleast_1d(np.asarray(noe_err, dtype=np.float64))
    n = r1_a.shape[0]

    matrix, _, rows = build_rsdm_matrix(physics, observable_order)
    matrix_inv = np.linalg.inv(matrix)

    # Streaming first and second moments, so memory stays bounded regardless
    # of n_replicates.
    total = np.zeros((n, 3), dtype=np.float64)
    total_outer = np.zeros((n, 3, 3), dtype=np.float64)
    done = 0
    while done < n_replicates:
        size = min(chunk_size, n_replicates - done)
        s_r1 = r1_a + rng.normal(0.0, 1.0, (size, n)) * r1_e
        s_r2 = r2_a + rng.normal(0.0, 1.0, (size, n)) * r2_e
        s_noe = noe_a + rng.normal(0.0, 1.0, (size, n)) * noe_e
        s_sigma = GAMMA_RATIO_N_H * (s_noe - 1.0) * s_r1

        row_values = {"R1": s_r1, "R2": s_r2, "sigma": s_sigma}
        y = np.stack([row_values[name] for name in rows], axis=-1)   # (S,N,3)
        j = np.einsum("ij,snj->sni", matrix_inv, y)                  # (S,N,3)

        total += j.sum(axis=0)
        total_outer += np.einsum("sni,snj->nij", j, j)
        done += size
        if progress_callback is not None:
            progress_callback(
                done, n_replicates, f"Monte Carlo replicate {done}/{n_replicates}"
            )

    mean = total / n_replicates
    # E[xx^T] - E[x]E[x]^T, with the usual (n-1) correction.
    cov = total_outer / n_replicates - np.einsum("ni,nj->nij", mean, mean)
    cov *= n_replicates / (n_replicates - 1.0)
    cov = 0.5 * (cov + np.transpose(cov, (0, 2, 1)))
    return mean, cov


@dataclass
class SystematicBand:
    """Coherent shift in J from the constants choice.

    This is a SYSTEMATIC uncertainty: it moves every residue in the same
    direction at once, so it is reported as a band on the summary and never
    folded into per-residue error bars, where it would look like independent
    scatter and be wrongly averaged down.
    """

    reference: np.ndarray
    lower: np.ndarray
    upper: np.ndarray
    description: str

    def fractional_span(self) -> np.ndarray:
        """(N, 3) fractional half-width of the band, for reporting."""
        with np.errstate(divide="ignore", invalid="ignore"):
            span = 0.5 * np.abs(self.upper - self.lower) / np.abs(self.reference)
        return np.nan_to_num(span, nan=0.0, posinf=0.0)


def systematic_band(
    r1: np.ndarray,
    r1_err: np.ndarray,
    r2: np.ndarray,
    r2_err: np.ndarray,
    noe: np.ndarray,
    noe_err: np.ndarray,
    b0_h_hz: float,
    constants: SdmConstants,
    variant,
    r_nh_rel: float = 0.005,
    delta_sigma_rel: float = 0.075,
) -> SystematicBand:
    """Re-map the dataset with perturbed constants to size the systematic band.

    Defaults correspond roughly to the spread between the shipped presets:
    0.5% on r_NH (1.02 vs 1.015 A) and 7.5% on the CSA (-160 vs -172 ppm).
    """
    def _run(consts: SdmConstants) -> np.ndarray:
        phys = field_physics(b0_h_hz, consts, variant)
        return map_dataset(r1, r1_err, r2, r2_err, noe, noe_err, phys).j

    reference = _run(constants)
    lo = _run(perturb(constants, r_nh_scale=1.0 - r_nh_rel,
                      delta_sigma_scale=1.0 - delta_sigma_rel))
    hi = _run(perturb(constants, r_nh_scale=1.0 + r_nh_rel,
                      delta_sigma_scale=1.0 + delta_sigma_rel))
    return SystematicBand(
        reference=reference,
        lower=np.minimum(lo, hi),
        upper=np.maximum(lo, hi),
        description=(
            f"r_NH +/-{r_nh_rel * 100:.1f}%, "
            f"delta_sigma +/-{delta_sigma_rel * 100:.1f}% about {constants.label}"
        ),
    )
