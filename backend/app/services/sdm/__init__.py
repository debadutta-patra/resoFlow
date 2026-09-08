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

"""Reduced spectral density mapping (RSDM).

Converts per-residue R1, R2 and heteronuclear NOE measured at a single field
into the spectral density values J(0), J(omega_N) and J(0.87 omega_H).

This package is deliberately standalone: no FastAPI, SQLAlchemy, Celery or
filesystem imports, so it can be used from a plain script against arrays.

    from app.services.sdm import constants_from_presets, field_physics, map_dataset

    consts = constants_from_presets("1.02", "-160")
    phys = field_physics(600.13e6, consts)
    result = map_dataset(r1, r1_err, r2, r2_err, noe, noe_err, phys)
    j0_ns = result.j_ns()[:, 0]
"""

from .constants import (
    DELTA_SIGMA_PRESETS_PPM,
    GAMMA_H,
    GAMMA_N,
    GAMMA_RATIO_N_H,
    HBAR,
    MU0_OVER_4PI,
    R_NH_PRESETS,
    SdmConstants,
    constants_from_presets,
    custom_constants,
    perturb,
)
from .diagnostics import (
    DatasetDiagnostics,
    FLAG_DESCRIPTIONS,
    ResidueDiagnostics,
    analyse,
    error_ellipse,
    rigid_rotor_curve,
    tau_c_from_ratio,
    trimmed_mean,
)
from .mapping import (
    J_LABELS,
    S_RAD_TO_NS_RAD,
    SdmMapping,
    SystematicBand,
    build_input_covariance,
    build_transform,
    cross_relaxation_rate,
    map_dataset,
    monte_carlo_covariance,
    systematic_band,
)
from .physics import (
    DEFAULT_VARIANT,
    SdmVariant,
    VARIANT_HIGH_FREQ_FACTOR,
    build_matrix,
    build_rsdm_matrix,
    csa_constant,
    dipolar_constant,
    field_physics,
    larmor_frequencies,
    reorder_lower_triangular,
)

__all__ = [
    "DELTA_SIGMA_PRESETS_PPM",
    "DEFAULT_VARIANT",
    "DatasetDiagnostics",
    "FLAG_DESCRIPTIONS",
    "GAMMA_H",
    "GAMMA_N",
    "GAMMA_RATIO_N_H",
    "HBAR",
    "J_LABELS",
    "MU0_OVER_4PI",
    "R_NH_PRESETS",
    "ResidueDiagnostics",
    "S_RAD_TO_NS_RAD",
    "SdmConstants",
    "SdmMapping",
    "SdmVariant",
    "SystematicBand",
    "VARIANT_HIGH_FREQ_FACTOR",
    "analyse",
    "build_input_covariance",
    "build_matrix",
    "build_rsdm_matrix",
    "build_transform",
    "constants_from_presets",
    "cross_relaxation_rate",
    "csa_constant",
    "custom_constants",
    "dipolar_constant",
    "error_ellipse",
    "field_physics",
    "larmor_frequencies",
    "map_dataset",
    "monte_carlo_covariance",
    "perturb",
    "reorder_lower_triangular",
    "rigid_rotor_curve",
    "systematic_band",
    "tau_c_from_ratio",
    "trimmed_mean",
]
