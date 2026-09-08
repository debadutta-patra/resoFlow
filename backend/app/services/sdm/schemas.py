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
Pydantic models for reduced spectral density mapping.

These describe the request, the persisted snapshot and the per-residue result
rows. Pydantic only -- no FastAPI, so the core package stays importable from a
plain script.

Display units are used at this boundary (Angstrom, ppm, MHz, ns rad^-1); the
computation itself is angular SI throughout.
"""

from __future__ import annotations

from enum import Enum
from typing import Dict, List, Literal, Optional, Tuple

from pydantic import BaseModel, Field, field_validator, model_validator


class RexSource(str, Enum):
    """Where an exchange correction comes from.

    NONE is the only value available unless the experimental Rex feature flag
    is enabled; the API rejects everything else with a 422 naming the flag.
    The schema accepts all of them regardless -- gating is at the API layer,
    not here, so that a stored experimental record still deserialises.
    """

    NONE = "none"
    CPMG_ANALYSIS = "cpmg_analysis"
    MULTI_FIELD = "multi_field"


class R2Provenance(str, Enum):
    """How the R2 input was obtained. Recorded in the snapshot.

    R1RHO values are converted as R2 = (R1rho - R1 cos^2 theta)/sin^2 theta
    before mapping.
    """

    ECHO_DECAY = "echo_decay"
    CPMG_R2_0 = "cpmg_r2_0"
    R1RHO_CONVERTED = "r1rho_converted"


class ErrorMethod(str, Enum):
    """Analytic propagation, or Monte Carlo as a cross-check."""

    ANALYTIC = "analytic"
    MONTE_CARLO = "monte_carlo"


class ConstantsInput(BaseModel):
    """The constants choice, in display units."""

    r_nh_preset: Optional[str] = Field(
        default="1.02", description="Named r_NH preset, or None when custom."
    )
    delta_sigma_preset: Optional[str] = Field(
        default="-160", description="Named CSA preset, or None when custom."
    )
    r_nh_angstrom: Optional[float] = Field(
        default=None, description="Custom N-H distance in Angstrom."
    )
    delta_sigma_ppm: Optional[float] = Field(
        default=None, description="Custom 15N CSA in ppm (negative)."
    )

    @model_validator(mode="after")
    def _require_preset_or_custom(self) -> "ConstantsInput":
        has_custom = (
            self.r_nh_angstrom is not None or self.delta_sigma_ppm is not None
        )
        if has_custom:
            if self.r_nh_angstrom is None or self.delta_sigma_ppm is None:
                raise ValueError(
                    "custom constants require both r_nh_angstrom and "
                    "delta_sigma_ppm"
                )
        elif not (self.r_nh_preset and self.delta_sigma_preset):
            raise ValueError(
                "either both presets or both custom constant values are required"
            )
        return self

    @field_validator("r_nh_angstrom")
    @classmethod
    def _positive_distance(cls, v: Optional[float]) -> Optional[float]:
        if v is not None and not (0.5 <= v <= 2.0):
            raise ValueError(
                f"r_NH = {v} A is outside the plausible range 0.5-2.0 A; "
                "check the units"
            )
        return v

    @field_validator("delta_sigma_ppm")
    @classmethod
    def _plausible_csa(cls, v: Optional[float]) -> Optional[float]:
        if v is not None and not (-400.0 <= v <= 400.0):
            raise ValueError(
                f"delta_sigma = {v} ppm is outside the plausible range "
                "+/-400 ppm; check the units"
            )
        return v


class SpectralDensityCreate(BaseModel):
    """Request body for creating and running an RSDM analysis."""

    name: str
    source_r1_analysis_uuid: str
    source_r2_analysis_uuid: str
    source_noe_analysis_uuid: str
    constants: ConstantsInput = Field(default_factory=ConstantsInput)
    variant: str = "farrow1995"
    error_method: ErrorMethod = ErrorMethod.ANALYTIC
    n_replicates: int = Field(
        default=2000, ge=100, le=1_000_000,
        description="Monte Carlo replicates; ignored for the analytic path.",
    )
    seed: Optional[int] = None
    r2_provenance: R2Provenance = R2Provenance.ECHO_DECAY
    r1rho_tilt_angle_deg: Optional[float] = Field(
        default=None,
        description="Effective tilt angle theta, required when converting R1rho.",
    )

    # --- experimental, gated at the API layer -----------------------------
    rex_source: RexSource = RexSource.NONE
    rex_cpmg_analysis_uuid: Optional[str] = None

    @model_validator(mode="after")
    def _check_conditional_fields(self) -> "SpectralDensityCreate":
        if self.r2_provenance == R2Provenance.R1RHO_CONVERTED:
            if self.r1rho_tilt_angle_deg is None:
                raise ValueError(
                    "r1rho_tilt_angle_deg is required when r2_provenance is "
                    "r1rho_converted"
                )
        if self.rex_source == RexSource.CPMG_ANALYSIS and not self.rex_cpmg_analysis_uuid:
            raise ValueError(
                "rex_cpmg_analysis_uuid is required when rex_source is "
                "cpmg_analysis"
            )
        return self


class ExcludedResidue(BaseModel):
    """A residue dropped from the mapping, with the reason surfaced."""

    residue: str
    res_num: Optional[int] = None
    reason: str


class SpectralDensityResidueOut(BaseModel):
    """One mapped residue.

    J values and their errors are in ns rad^-1. The covariance is the full
    3x3 in ns^2 rad^-2, row/column order [J(0), J(wN), J_h] -- not just the
    variances, because every derived quantity needs the off-diagonals.
    """

    assignment: str
    res_num: Optional[int] = None
    res_name: Optional[str] = None

    j0: float
    j_wn: float
    j_h: float
    j0_err: float
    j_wn_err: float
    j_h_err: float
    covariance: List[List[float]]

    # Inputs echoed, so a row is self-contained in the CSV and the table.
    r1: float
    r1_err: float
    r2: float
    r2_err: float
    noe: float
    noe_err: float
    sigma: float
    sigma_err: float
    rex: Optional[float] = None
    rex_err: Optional[float] = None

    tau_c: Optional[float] = None
    flags: List[str] = Field(default_factory=list)
    excluded: bool = False
    exclusion_reason: Optional[str] = None


class SystematicBandOut(BaseModel):
    """Coherent band from the constants choice, reported separately."""

    description: str
    j0_fractional: float
    j_wn_fractional: float
    j_h_fractional: float


class SpectralDensitySummary(BaseModel):
    """Dataset-level summary shown on the results card."""

    tau_c_estimate_ns: Optional[float] = None
    j0_trimmed_mean: float
    j_wn_trimmed_mean: float
    j_h_trimmed_mean: float
    n_residues: int
    n_flagged: int
    n_excluded: int
    flag_counts: Dict[str, int] = Field(default_factory=dict)
    flag_descriptions: Dict[str, str] = Field(default_factory=dict)
    systematic_band: Optional[SystematicBandOut] = None


class SpectralDensityResults(BaseModel):
    """Full result payload for one RSDM analysis."""

    analysis_uuid: str
    name: str
    status: str
    experimental: bool = False
    experimental_notice: Optional[str] = None
    b0_h_mhz: float
    variant: str
    error_method: ErrorMethod
    rex_source: RexSource = RexSource.NONE
    r2_provenance: R2Provenance = R2Provenance.ECHO_DECAY
    constants_snapshot: Dict[str, object] = Field(default_factory=dict)
    source_analyses: Dict[str, str] = Field(default_factory=dict)
    summary: SpectralDensitySummary
    residues: List[SpectralDensityResidueOut] = Field(default_factory=list)
    excluded_residues: List[ExcludedResidue] = Field(default_factory=list)
    j_units: Literal["ns/rad"] = "ns/rad"


class FieldMismatchDetail(BaseModel):
    """Structured 422 body for the B0 consistency failure.

    A 600/800 mix produces plausible-looking nonsense, so this is a hard
    failure rather than a warning, and the response names every field so the
    user can see which source is the odd one out.
    """

    message: str
    fields_mhz: Dict[str, Optional[float]]
    tolerance_mhz: float
