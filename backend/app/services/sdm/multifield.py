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
EXPERIMENTAL: multi-field spectral density mapping and the chi-square
exchange test.

With relaxation data at two or more fields the per-field blocks stack into
one overdetermined system:

    3n rows          (R1, R2, sigma at each of n fields)
    1 + 2n unknowns  (ONE shared field-independent J(0), plus J(omega_N)
                      and J_h at each field)

so there are n - 1 surplus degrees of freedom, and that surplus is exactly
the "J(0) is the same at every field" assumption. Because R1 and the NOE
carry no exchange contribution, a bad chi-square implicates exchange rather
than the rest of the model -- which is what makes the residual a test rather
than just a goodness-of-fit number.

M is no longer square, so this uses generalised least squares:

    x_hat   = (M^T W M)^-1 M^T W y ,   W = Cov_y^-1
    Cov_hat = (M^T W M)^-1

Everything here is gated behind RESOFLOW_ENABLE_EXPERIMENTAL_SDM_REX at the
API layer. The module itself stays importable and side-effect free.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Sequence, Tuple

import numpy as np
from scipy import optimize, stats

from .mapping import build_input_covariance, build_transform, cross_relaxation_rate
from .physics import (
    DEFAULT_OBSERVABLE_ORDER,
    FieldPhysics,
    OBSERVABLE_BUILDERS,
    W_H_EFF,
    W_N,
    ZERO,
)

J0_COLUMN = "J0_shared"
"""The one column shared across every field."""

MIN_FIELD_SEPARATION_MHZ = 5.0
"""Fields closer than this are treated as the same field."""


@dataclass
class FieldObservation:
    """One field's worth of measured rates, aligned residue-by-residue."""

    physics: FieldPhysics
    r1: np.ndarray
    r1_err: np.ndarray
    r2: np.ndarray
    r2_err: np.ndarray
    noe: np.ndarray
    noe_err: np.ndarray

    @property
    def b0_h_hz(self) -> float:
        return self.physics.b0_h_hz

    def __len__(self) -> int:
        return int(np.asarray(self.r1).shape[0])


def build_multifield_matrix(
    physics_list: Sequence[FieldPhysics],
    observable_order: Sequence[str] = DEFAULT_OBSERVABLE_ORDER,
) -> Tuple[np.ndarray, List[str], List[str]]:
    """Stack the per-field blocks into one (3n) x (1 + 2n) design matrix.

    J(0) gets a single shared column; J(omega_N) and J_h get one column per
    field, because both are frequency dependent and cannot be shared.

    Returns:
        (M, column_labels, row_labels).

    Raises:
        ValueError: with fewer than two fields, where the system is not
            overdetermined and the chi-square test has no degrees of freedom.
    """
    n_fields = len(physics_list)
    if n_fields < 2:
        raise ValueError(
            "Multi-field mapping needs at least two fields; with one field "
            "the system is square and the chi-square exchange test has zero "
            "degrees of freedom."
        )

    columns = [J0_COLUMN]
    for k in range(n_fields):
        columns.extend([f"{W_N}@{k}", f"{W_H_EFF}@{k}"])
    col_index = {label: j for j, label in enumerate(columns)}

    rows: List[str] = []
    matrix = np.zeros((3 * n_fields, len(columns)), dtype=np.float64)

    for k, phys in enumerate(physics_list):
        for i, obs_name in enumerate(observable_order):
            row = 3 * k + i
            rows.append(f"{obs_name}@{k}")
            coefficients = OBSERVABLE_BUILDERS[obs_name](phys)
            for label, coefficient in coefficients.items():
                if label == ZERO:
                    matrix[row, col_index[J0_COLUMN]] = coefficient
                elif label == W_N:
                    matrix[row, col_index[f"{W_N}@{k}"]] = coefficient
                elif label == W_H_EFF:
                    matrix[row, col_index[f"{W_H_EFF}@{k}"]] = coefficient
                else:  # pragma: no cover - guards a future observable
                    raise ValueError(f"Unhandled frequency label {label!r}")
    return matrix, columns, rows


@dataclass
class MultiFieldMapping:
    """Per-residue GLS solution with the exchange test.

    Attributes:
        j0: (N,) shared field-independent J(0) [s rad^-1].
        j_wn: (N, n_fields) J(omega_N) per field.
        j_h: (N, n_fields) J_h per field.
        covariance: (N, 1+2n, 1+2n) full covariance of the solution vector.
        chi2: (N,) weighted residual of the overdetermined system.
        dof: n_fields - 1, the surplus that tests the shared-J(0) assumption.
        p_value: (N,) survival probability of chi2 at that dof. SMALL values
            implicate exchange.
        r2_residual: (N, n_fields) the part of R2 the shared-J(0) model
            cannot account for. This is a RESIDUAL, not a calibrated R_ex:
            n fields leave only n-1 residual degrees of freedom while n R_ex
            values would be needed, and the shortfall is exactly the
            FIELD-INDEPENDENT component of R_ex, which is perfectly
            degenerate with J(0). Any exchange that does not vary with field
            is absorbed into J(0) and is invisible here. Differences between
            fields are meaningful; absolute values are not.
        matrix, columns, rows: the design matrix and its labels.
        b0_h_hz: the fields, in the column order used.
    """

    j0: np.ndarray
    j_wn: np.ndarray
    j_h: np.ndarray
    covariance: np.ndarray
    chi2: np.ndarray
    dof: int
    p_value: np.ndarray
    r2_residual: np.ndarray
    matrix: np.ndarray
    columns: List[str]
    rows: List[str]
    b0_h_hz: List[float]

    @property
    def j0_err(self) -> np.ndarray:
        """(N,) standard error on the shared J(0)."""
        return np.sqrt(np.clip(self.covariance[:, 0, 0], 0.0, None))


def map_multifield_dataset(
    observations: Sequence[FieldObservation],
    observable_order: Sequence[str] = DEFAULT_OBSERVABLE_ORDER,
) -> MultiFieldMapping:
    """Solve the stacked system by GLS and report the exchange test.

    Cov_y is block diagonal across fields -- separate experiments at separate
    fields are independent -- but DENSE within each 3x3 block, because sigma
    shares R1 with the first row. That within-field correlation is exactly
    what the T matrix carries, and dropping it would mis-weight the fit as
    well as mis-state the errors.

    Raises:
        ValueError: for fewer than two fields, mismatched residue counts, or
            a rank-deficient system.
    """
    if len(observations) < 2:
        raise ValueError("Multi-field mapping needs at least two fields")

    lengths = {len(obs) for obs in observations}
    if len(lengths) != 1:
        raise ValueError(
            f"Every field must cover the same residues; got counts {sorted(lengths)}"
        )
    n_res = lengths.pop()
    n_fields = len(observations)

    matrix, columns, rows = build_multifield_matrix(
        [obs.physics for obs in observations], observable_order
    )
    n_unknown = matrix.shape[1]
    dof = 3 * n_fields - n_unknown
    if dof != n_fields - 1:  # pragma: no cover - structural invariant
        raise ValueError(f"Unexpected degrees of freedom {dof} for {n_fields} fields")

    if np.linalg.matrix_rank(matrix) < n_unknown:  # pragma: no cover
        raise ValueError(
            "The stacked design matrix is rank deficient and cannot be solved."
        )

    # Distinct fields must be checked separately: each field gets its OWN
    # J(omega_N) and J_h columns, so repeating a field leaves the matrix full
    # rank. It would solve, and the chi-square would then be a replicate
    # consistency check rather than the field-dependence test the analysis
    # claims to be -- a wrong answer that looks like a right one.
    fields_mhz = sorted(obs.b0_h_hz / 1e6 for obs in observations)
    closest = min(
        (b - a for a, b in zip(fields_mhz, fields_mhz[1:])), default=float("inf")
    )
    if closest < MIN_FIELD_SEPARATION_MHZ:
        raise ValueError(
            "Multi-field consistency needs genuinely different fields; got "
            f"{', '.join(f'{f:.2f}' for f in fields_mhz)} MHz. Repeating a "
            "field turns the chi-square into a replicate consistency check, "
            "not a test of exchange."
        )

    # y and its covariance, stacked field by field.
    y = np.zeros((n_res, 3 * n_fields), dtype=np.float64)
    cov_y = np.zeros((n_res, 3 * n_fields, 3 * n_fields), dtype=np.float64)

    for k, obs in enumerate(observations):
        r1 = np.asarray(obs.r1, dtype=np.float64)
        r2 = np.asarray(obs.r2, dtype=np.float64)
        noe = np.asarray(obs.noe, dtype=np.float64)
        sigma = cross_relaxation_rate(noe, r1)

        row_values = {"R1": r1, "R2": r2, "sigma": sigma}
        for i, obs_name in enumerate(observable_order):
            y[:, 3 * k + i] = row_values[obs_name]

        transform = build_transform(r1, noe)
        cov_u = build_input_covariance(obs.r1_err, obs.r2_err, obs.noe_err)
        block = np.einsum("nij,njk,nlk->nil", transform, cov_u, transform)
        cov_y[:, 3 * k:3 * k + 3, 3 * k:3 * k + 3] = 0.5 * (
            block + np.transpose(block, (0, 2, 1))
        )

    x_hat = np.zeros((n_res, n_unknown), dtype=np.float64)
    cov_x = np.zeros((n_res, n_unknown, n_unknown), dtype=np.float64)
    chi2 = np.zeros(n_res, dtype=np.float64)

    for i in range(n_res):
        weight = np.linalg.pinv(cov_y[i])
        normal = matrix.T @ weight @ matrix
        cov_i = np.linalg.pinv(normal)
        x_i = cov_i @ matrix.T @ weight @ y[i]
        residual = y[i] - matrix @ x_i

        x_hat[i] = x_i
        cov_x[i] = 0.5 * (cov_i + cov_i.T)
        chi2[i] = float(residual @ weight @ residual)

    # Chi-square is non-negative by construction; clip only against
    # floating-point noise around zero.
    chi2 = np.clip(chi2, 0.0, None)
    p_value = stats.chi2.sf(chi2, dof) if dof > 0 else np.full(n_res, np.nan)

    j_wn = np.zeros((n_res, n_fields), dtype=np.float64)
    j_h = np.zeros((n_res, n_fields), dtype=np.float64)
    for k in range(n_fields):
        j_wn[:, k] = x_hat[:, columns.index(f"{W_N}@{k}")]
        j_h[:, k] = x_hat[:, columns.index(f"{W_H_EFF}@{k}")]

    # What a shared J(0) cannot explain, per field. Determined only up to
    # an additive field-independent constant, which J(0) has already absorbed.
    r2_residual = np.zeros((n_res, n_fields), dtype=np.float64)
    r2_row = list(observable_order).index("R2")
    predicted = np.einsum("ij,nj->ni", matrix, x_hat)
    for k in range(n_fields):
        r2_residual[:, k] = y[:, 3 * k + r2_row] - predicted[:, 3 * k + r2_row]

    return MultiFieldMapping(
        j0=x_hat[:, 0],
        j_wn=j_wn,
        j_h=j_h,
        covariance=cov_x,
        chi2=chi2,
        dof=dof,
        p_value=np.asarray(p_value, dtype=np.float64),
        r2_residual=r2_residual,
        matrix=matrix,
        columns=columns,
        rows=rows,
        b0_h_hz=[obs.b0_h_hz for obs in observations],
    )


@dataclass
class ScalingExponent:
    """The fitted field dependence of R_ex.

    R_ex ∝ B0^2 holds ONLY in the fast-exchange limit, so the exponent is
    fitted rather than assumed. alpha is itself the diagnostic of the
    exchange time scale (Millet, Loria, Kroenke, Pons & Palmer (2000) JACS
    122, 2867-2877, doi:10.1021/ja993511y): alpha near 2 indicates fast
    exchange, and smaller values indicate the intermediate-to-slow regime.

    Attributes:
        alpha: fitted exponent, constrained to [0, 2].
        alpha_err: standard error, or None when it cannot be estimated.
        amplitude: R_ex at the reference field.
        exactly_determined: True at exactly three fields, where the two
            power-law parameters consume both residual degrees of freedom and
            there is nothing left to judge the fit by.
        at_bound: True when alpha landed on 0 or 2, where the error estimate
            is not meaningful and the value should be read as "at least" or
            "at most".
    """

    alpha: float
    alpha_err: Optional[float]
    amplitude: float
    exactly_determined: bool
    at_bound: bool


ALPHA_BOUNDS = (0.0, 2.0)


MIN_FIELDS_FOR_SCALING = 3
"""Below this the exponent is not identifiable -- see fit_rex_scaling_exponent."""


def fit_rex_scaling_exponent(
    b0_h_hz: Sequence[float],
    rex: Sequence[float],
    rex_err: Optional[Sequence[float]] = None,
) -> Optional[ScalingExponent]:
    """Fit R_ex = A (B0/B0_ref)^alpha with alpha FREE in [0, 2].

    Deliberately NOT a fit of R2 against B0^2 with the exponent fixed.
    R_ex proportional to B0^2 holds only in the fast-exchange limit, and
    imposing it where exchange is not fast silently misattributes the result.
    alpha is itself the diagnostic of the exchange time scale (Millet et al.
    2000), so it is reported rather than assumed.

    THREE FIELDS MINIMUM. The multi-field system leaves n-1 residual degrees
    of freedom, and the power law costs two parameters, so two fields leave
    -1: the exponent is simply not identifiable, and any number returned
    would be an artefact of the parametrisation. Three fields determine it
    exactly, four or more overdetermine it.

    Args:
        b0_h_hz: the fields.
        rex: the exchange contribution at each field. In practice these are
            GLS R2 residuals, which are determined only up to a
            field-independent constant absorbed by J(0), so alpha describes
            how the field-DEPENDENT part scales.
        rex_err: standard errors; uniform weighting when omitted.

    Returns:
        ScalingExponent, or None when the exponent is not identifiable
        (fewer than three fields, or no positive R_ex to speak of).
    """
    fields = np.asarray(b0_h_hz, dtype=np.float64)
    values = np.asarray(rex, dtype=np.float64)
    if fields.size < MIN_FIELDS_FOR_SCALING or values.size != fields.size:
        return None
    if not np.all(np.isfinite(values)) or np.all(values <= 0):
        return None

    errors = (
        np.asarray(rex_err, dtype=np.float64)
        if rex_err is not None
        else np.ones_like(values)
    )
    errors = np.where(np.isfinite(errors) & (errors > 0), errors, 1.0)

    # Referencing to the mean field keeps A on the scale of R_ex itself,
    # which conditions the fit far better than an absolute-Hz power law.
    b0_ref = float(np.mean(fields))
    ratio = fields / b0_ref

    def residuals(params):
        amplitude, alpha = params
        return (amplitude * ratio ** alpha - values) / errors

    start_amplitude = float(np.max(values))
    result = optimize.least_squares(
        residuals,
        x0=[max(start_amplitude, 1e-9), 1.0],
        bounds=([0.0, ALPHA_BOUNDS[0]], [np.inf, ALPHA_BOUNDS[1]]),
    )
    amplitude, alpha = float(result.x[0]), float(result.x[1])
    at_bound = bool(
        np.isclose(alpha, ALPHA_BOUNDS[0], atol=1e-6)
        or np.isclose(alpha, ALPHA_BOUNDS[1], atol=1e-6)
    )

    alpha_err: Optional[float] = None
    try:
        # Gauss-Newton covariance from the Jacobian at the solution.
        _, s, vt = np.linalg.svd(result.jac, full_matrices=False)
        positive = s > max(s) * 1e-12 if s.size and max(s) > 0 else np.array([])
        if np.any(positive):
            inv = (vt[positive].T / s[positive] ** 2) @ vt[positive]
            variance = float(inv[1, 1])
            if np.isfinite(variance) and variance >= 0:
                alpha_err = float(np.sqrt(variance))
    except np.linalg.LinAlgError:
        alpha_err = None

    return ScalingExponent(
        alpha=alpha,
        alpha_err=None if at_bound else alpha_err,
        amplitude=amplitude,
        exactly_determined=fields.size == MIN_FIELDS_FOR_SCALING,
        at_bound=at_bound,
    )
