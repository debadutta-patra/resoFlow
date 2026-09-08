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
Spin physics for reduced spectral density mapping: the dipolar and CSA
coupling constants, Larmor frequencies, and the linear system relating
measured relaxation rates to spectral density values.

The full master equations for an isolated 15N-1H amide pair with axially
symmetric CSA are

    R1 = (d^2/4)[J(wH-wN) + 3J(wN) + 6J(wH+wN)] + c^2 J(wN)
    R2 = (d^2/8)[4J(0) + J(wH-wN) + 3J(wN) + 6J(wH) + 6J(wH+wN)]
         + (c^2/6)[4J(0) + 3J(wN)] + Rex
    sigma = (d^2/4)[6J(wH+wN) - J(wH-wN)]

The reduced approximation collapses the three high-frequency terms onto a
single effective value J_h = J(k*wH). The factor k is a CONVENTION, not a
constant of nature -- see SdmVariant below.

Nothing in this module touches measured data: the matrix depends only on B0
and the physical constants, so it is built once per analysis and reused for
every residue.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from enum import Enum
from typing import Dict, List, Mapping, Sequence, Tuple

import numpy as np

from .constants import GAMMA_H, GAMMA_N, HBAR, MU0_OVER_4PI, SdmConstants

# Frequency labels. These are the columns of the coefficient matrix; the
# builder derives the column order from the union of labels the observables
# mention, so adding an observable never means editing a hard-coded ordering.
ZERO = "zero"
"""J(0)."""

W_N = "wN"
"""J(omega_N)."""

W_H_EFF = "wH_eff"
"""J_h -- the collapsed high-frequency term, J(k*omega_H)."""


class SdmVariant(str, Enum):
    """Which published reduced-spectral-density convention to use.

    The 0.87 factor is a convention with published variants, not *the* answer.
    Which one was used is recorded in the analysis snapshot so a result is
    self-describing.

    FARROW1995 -- J(0.87 wH), from Farrow, Zhang, Szabo, Torchia & Kay (1995)
        J Biomol NMR 6, 153-162. The factor is chosen so that, under the
        high-frequency assumption J(w) ~ w^-2, the combination appearing in
        the cross-relaxation rate collapses exactly:
            6J(wH+wN) - J(wH-wN) = 5 J(0.87 wH)
        which is what makes the sigma row of the matrix a clean 5d^2/4.
    """

    FARROW1995 = "farrow1995"


VARIANT_HIGH_FREQ_FACTOR: Dict[SdmVariant, float] = {
    SdmVariant.FARROW1995: 0.87,
}
"""Effective high-frequency factor k in J_h = J(k * omega_H), per variant."""

DEFAULT_VARIANT = SdmVariant.FARROW1995


# --- Coupling constants ----------------------------------------------------

def dipolar_constant(r_nh: float) -> float:
    """Dipolar coupling constant d = (mu0 hbar gamma_H gamma_N)/(4 pi r^3).

    Args:
        r_nh: N-H internuclear distance [m].

    Returns:
        d in rad s^-1. NEGATIVE, because gamma_N is. Every appearance of d in
        the relaxation equations is squared, so the sign does not propagate --
        but it is returned honestly rather than abs()'d, so that a caller who
        does use it linearly is not silently handed the wrong sign.

    Raises:
        ValueError: if r_nh is not positive.
    """
    if not (r_nh > 0):
        raise ValueError(f"r_NH must be positive, got {r_nh}")
    return MU0_OVER_4PI * HBAR * GAMMA_H * GAMMA_N / (r_nh ** 3)


def csa_constant(omega_n: float, delta_sigma: float) -> float:
    """CSA constant c = omega_N * delta_sigma / sqrt(3).

    Args:
        omega_n: 15N Larmor angular frequency [rad s^-1], negative.
        delta_sigma: dimensionless shielding anisotropy, negative for amide N.

    Returns:
        c in rad s^-1. Positive for the usual case of two negative inputs.
        Enters the equations squared.
    """
    return omega_n * delta_sigma / math.sqrt(3.0)


def larmor_frequencies(b0_h_hz: float) -> Tuple[float, float]:
    """Angular Larmor frequencies from the spectrometer 1H frequency.

    Args:
        b0_h_hz: 1H Larmor frequency in Hz (e.g. 600.13e6 for a "600 MHz"
            spectrometer). Hz, NOT MHz -- callers holding MHz must convert,
            and the API layer does so explicitly.

    Returns:
        (omega_H, omega_N) in rad s^-1. omega_N is negative.

    Raises:
        ValueError: if b0_h_hz is not positive.
    """
    if not (b0_h_hz > 0):
        raise ValueError(f"1H frequency must be positive, got {b0_h_hz} Hz")
    omega_h = 2.0 * math.pi * b0_h_hz
    omega_n = omega_h * (GAMMA_N / GAMMA_H)
    return omega_h, omega_n


@dataclass(frozen=True)
class FieldPhysics:
    """Everything the coefficient matrix needs, for one field and one constants
    choice. Depends only on B0 and the constants -- never on measured data."""

    b0_h_hz: float
    omega_h: float
    omega_n: float
    omega_h_eff: float
    d: float
    c: float
    constants: SdmConstants
    variant: SdmVariant

    @property
    def d2(self) -> float:
        return self.d * self.d

    @property
    def c2(self) -> float:
        return self.c * self.c

    def to_snapshot(self) -> Dict[str, object]:
        """Self-describing record persisted with the analysis."""
        return {
            "b0_h_hz": self.b0_h_hz,
            "b0_h_mhz": self.b0_h_hz / 1e6,
            "omega_h_rad_s": self.omega_h,
            "omega_n_rad_s": self.omega_n,
            "omega_h_eff_rad_s": self.omega_h_eff,
            "high_freq_factor": VARIANT_HIGH_FREQ_FACTOR[self.variant],
            "d_rad_s": self.d,
            "c_rad_s": self.c,
            "variant": self.variant.value,
            "constants": self.constants.to_snapshot(),
        }


def field_physics(
    b0_h_hz: float,
    constants: SdmConstants,
    variant: SdmVariant = DEFAULT_VARIANT,
) -> FieldPhysics:
    """Assemble the field- and constants-dependent quantities."""
    omega_h, omega_n = larmor_frequencies(b0_h_hz)
    factor = VARIANT_HIGH_FREQ_FACTOR[variant]
    return FieldPhysics(
        b0_h_hz=b0_h_hz,
        omega_h=omega_h,
        omega_n=omega_n,
        omega_h_eff=factor * omega_h,
        d=dipolar_constant(constants.r_nh),
        c=csa_constant(omega_n, constants.delta_sigma),
        constants=constants,
        variant=variant,
    )


# --- Observables as declarative coefficient maps ---------------------------
#
# Each observable is a mapping {frequency label -> coefficient}. Writing them
# this way rather than as a literal 3x3 array means a variant, or an extra
# observable such as an exchange-free R2 surrogate, is a new entry in a list
# rather than a new code path -- and it makes a transcribed factor error
# visible as a wrong coefficient rather than a silently wrong solve.

Observable = Mapping[str, float]


def r1_observable(phys: FieldPhysics) -> Dict[str, float]:
    """R1 = (3d^2/4 + c^2) J(wN) + (7d^2/4) J_h.

    From (d^2/4)[J(wH-wN) + 3J(wN) + 6J(wH+wN)] + c^2 J(wN) with the three
    high-frequency terms collapsed: (1 + 6) d^2/4 = 7d^2/4 on J_h.
    No J(0) dependence -- R1 carries no exchange contribution.
    """
    d2, c2 = phys.d2, phys.c2
    return {W_N: 3.0 * d2 / 4.0 + c2, W_H_EFF: 7.0 * d2 / 4.0}


def r2_observable(phys: FieldPhysics) -> Dict[str, float]:
    """R2 = (d^2/2 + 2c^2/3) J(0) + (3d^2/8 + c^2/2) J(wN) + (13d^2/8) J_h.

    From (d^2/8)[4J(0) + J(wH-wN) + 3J(wN) + 6J(wH) + 6J(wH+wN)]
       + (c^2/6)[4J(0) + 3J(wN)],
    with (1 + 6 + 6) d^2/8 = 13d^2/8 on J_h.

    Any exchange contribution Rex is NOT part of the matrix: it is subtracted
    from the measured R2 on the data side (y2 -> R2 - Rex), leaving M
    untouched.
    """
    d2, c2 = phys.d2, phys.c2
    return {
        ZERO: d2 / 2.0 + 2.0 * c2 / 3.0,
        W_N: 3.0 * d2 / 8.0 + c2 / 2.0,
        W_H_EFF: 13.0 * d2 / 8.0,
    }


def sigma_observable(phys: FieldPhysics) -> Dict[str, float]:
    """sigma = (5d^2/4) J_h.

    From (d^2/4)[6J(wH+wN) - J(wH-wN)]. Under J(w) ~ w^-2 and the 0.87
    convention this collapses to exactly 5 J_h, which is what fixes the
    factor -- see SdmVariant.FARROW1995.
    """
    return {W_H_EFF: 5.0 * phys.d2 / 4.0}


DEFAULT_OBSERVABLE_ORDER = ("R1", "R2", "sigma")

OBSERVABLE_BUILDERS = {
    "R1": r1_observable,
    "R2": r2_observable,
    "sigma": sigma_observable,
}


def build_matrix(
    observables: Sequence[Observable],
    columns: Sequence[str] | None = None,
) -> Tuple[np.ndarray, List[str]]:
    """Assemble the coefficient matrix from declarative observable maps.

    Args:
        observables: one coefficient mapping per measured quantity, in the
            order the measurement vector y is stacked.
        columns: optional explicit column ordering. When omitted the ordering
            is derived from the union of labels the observables mention, in a
            fixed canonical order so that the result is reproducible.

    Returns:
        (M, columns) where M[i, j] is the coefficient of column j in
        observable i.

    Raises:
        ValueError: if an observable mentions a label not in `columns`.
    """
    canonical = [ZERO, W_N, W_H_EFF]
    if columns is None:
        mentioned = {label for obs in observables for label in obs}
        cols = [c for c in canonical if c in mentioned]
        # Anything outside the canonical set keeps a deterministic position.
        cols += sorted(mentioned - set(canonical))
    else:
        cols = list(columns)

    index = {label: j for j, label in enumerate(cols)}
    matrix = np.zeros((len(observables), len(cols)), dtype=np.float64)
    for i, obs in enumerate(observables):
        for label, coeff in obs.items():
            if label not in index:
                raise ValueError(
                    f"Observable {i} references unknown frequency {label!r}; "
                    f"columns are {cols}"
                )
            matrix[i, index[label]] = coeff
    return matrix, cols


def build_rsdm_matrix(
    phys: FieldPhysics,
    observable_order: Sequence[str] = DEFAULT_OBSERVABLE_ORDER,
) -> Tuple[np.ndarray, List[str], List[str]]:
    """Build the square RSDM system for one field.

    Returns:
        (M, columns, rows) with rows in `observable_order` and columns in
        canonical [J(0), J(wN), J_h] order.

    Raises:
        KeyError: if observable_order names an unknown observable.
    """
    obs = [OBSERVABLE_BUILDERS[name](phys) for name in observable_order]
    matrix, cols = build_matrix(obs)
    return matrix, cols, list(observable_order)


def reorder_lower_triangular(
    matrix: np.ndarray,
    columns: Sequence[str],
    rows: Sequence[str],
) -> Tuple[np.ndarray, List[str], List[str]]:
    """Permute the square system to (sigma, R1, R2) x (J_h, J(wN), J(0)).

    In that order the matrix is lower triangular, and forward substitution
    reproduces the textbook sequential RSDM equations exactly:
        J_h    from sigma
        J(wN)  from R1 given J_h
        J(0)   from R2 given J(wN) and J_h
    This is a structural property worth asserting in tests -- it catches a
    transcribed coefficient that a determinant check alone would not.
    """
    row_order = ["sigma", "R1", "R2"]
    col_order = [W_H_EFF, W_N, ZERO]
    row_idx = [list(rows).index(r) for r in row_order]
    col_idx = [list(columns).index(c) for c in col_order]
    return matrix[np.ix_(row_idx, col_idx)], col_order, row_order
