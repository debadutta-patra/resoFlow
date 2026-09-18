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
Physical constants and user-selectable constant presets for reduced spectral
density mapping (RSDM).

Everything here is SI and angular: gyromagnetic ratios in rad s^-1 T^-1, bond
lengths in metres, CSA as a dimensionless shielding anisotropy (not ppm).
Conversion to display units (ppm, Angstrom, ns rad^-1) happens at the API and
export boundary, never inside this package.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Dict, Optional

# --- Fundamental constants -------------------------------------------------
# CODATA 2018 recommended values. hbar is exact under the 2019 SI redefinition.
HBAR = 1.054571817e-34
"""Reduced Planck constant [J s] (exact, 2019 SI)."""

MU0_OVER_4PI = 1e-7
"""Vacuum permeability / 4pi [T m A^-1].

Exact in the pre-2019 SI; the CODATA 2018 value differs by 5.5e-10 relative,
far below the uncertainty in r_NH, so the round number is kept.
"""

GAMMA_H = 2.6752218744e8
"""Proton gyromagnetic ratio [rad s^-1 T^-1] (CODATA 2018)."""

GAMMA_N = -2.71261804e7
"""15N gyromagnetic ratio [rad s^-1 T^-1] (CODATA 2018).

NEGATIVE, and it must stay negative. The sign propagates into the dipolar
constant d (which enters squared, so d is sign-safe), into omega_N = -|omega_N|,
and into sigma = (gamma_N/gamma_H)(NOE-1)R1 where it is NOT squared. Taking
abs() here produces cross-relaxation rates of the wrong sign and J values that
look merely "a bit off" rather than obviously broken.
"""

GAMMA_RATIO_N_H = GAMMA_N / GAMMA_H
"""gamma_N / gamma_H ~= -0.10133. Negative; used unsquared in sigma."""


# --- Constant presets ------------------------------------------------------

@dataclass(frozen=True)
class SdmConstants:
    """The two physical choices that set the RSDM coefficient matrix.

    Attributes:
        r_nh: Effective N-H internuclear distance [m].
        delta_sigma: 15N chemical shift anisotropy, dimensionless
            (i.e. ppm * 1e-6). Negative for amide 15N.
        label: Human-readable provenance string, snapshotted with the analysis.
    """

    r_nh: float
    delta_sigma: float
    label: str = "custom"

    @property
    def r_nh_angstrom(self) -> float:
        """Bond length in Angstrom, for display and export only."""
        return self.r_nh * 1e10

    @property
    def delta_sigma_ppm(self) -> float:
        """CSA in ppm, for display and export only."""
        return self.delta_sigma * 1e6

    def to_snapshot(self) -> Dict[str, object]:
        """Self-describing record persisted with every analysis.

        Re-running with a different CSA two months later must produce a
        distinguishable record, so both the SI values actually used and the
        display values are stored, alongside the preset label.
        """
        return {
            "label": self.label,
            "r_nh_m": self.r_nh,
            "r_nh_angstrom": self.r_nh_angstrom,
            "delta_sigma": self.delta_sigma,
            "delta_sigma_ppm": self.delta_sigma_ppm,
            "gamma_h": GAMMA_H,
            "gamma_n": GAMMA_N,
            "hbar": HBAR,
            "mu0_over_4pi": MU0_OVER_4PI,
        }


# Bond-length presets.
#   1.02 A  - the value used throughout the reduced spectral density literature,
#             including Farrow, Zhang, Szabo, Torchia & Kay (1995) J Biomol NMR
#             6, 153-162, which is where the J(0.87 wH) form is set out.
#   1.015 A - vibrationally-corrected effective length used in later analyses;
#             see the discussion of geometric parameters in Kroenke, Loria, Lee,
#             Rance & Palmer (1998) JACS 120, 7905-7915, doi:10.1021/ja980832l.
# The choice moves d^2 by ~3% between these two, which is a systematic band on
# every J value and is reported as such, never folded into per-residue errors.
R_NH_PRESETS: Dict[str, float] = {
    "1.02": 1.02e-10,
    "1.015": 1.015e-10,
}

# CSA presets (ppm; stored dimensionless below).
#   -160 ppm - the value paired with r_NH = 1.02 A in Farrow et al. (1995)
#              J Biomol NMR 6, 153-162 and in much of the RSDM literature that
#              follows it.
#   -170 ppm - representative of the site-specific 15N CSA values measured by
#              Kroenke, Loria, Lee, Rance & Palmer (1998) JACS 120, 7905-7915,
#              doi:10.1021/ja980832l, who report a mean near this magnitude.
#   -172 ppm - the alternative magnitude in common use in the same literature;
#              retained as a preset so a published analysis using it can be
#              reproduced exactly.
# These are NOT interchangeable: c^2 scales as delta_sigma^2, so -160 vs -172
# is a ~16% change in the CSA contribution to R2 and hence to J(0).
DELTA_SIGMA_PRESETS_PPM: Dict[str, float] = {
    "-160": -160.0,
    "-170": -170.0,
    "-172": -172.0,
}

DEFAULT_R_NH_PRESET = "1.02"
DEFAULT_DELTA_SIGMA_PRESET = "-160"


def constants_from_presets(
    r_nh_preset: str = DEFAULT_R_NH_PRESET,
    delta_sigma_preset: str = DEFAULT_DELTA_SIGMA_PRESET,
) -> SdmConstants:
    """Build SdmConstants from named presets.

    Raises:
        KeyError: if either preset name is unknown.
    """
    if r_nh_preset not in R_NH_PRESETS:
        raise KeyError(
            f"Unknown r_NH preset {r_nh_preset!r}; "
            f"available: {sorted(R_NH_PRESETS)}"
        )
    if delta_sigma_preset not in DELTA_SIGMA_PRESETS_PPM:
        raise KeyError(
            f"Unknown delta_sigma preset {delta_sigma_preset!r}; "
            f"available: {sorted(DELTA_SIGMA_PRESETS_PPM)}"
        )
    return SdmConstants(
        r_nh=R_NH_PRESETS[r_nh_preset],
        delta_sigma=DELTA_SIGMA_PRESETS_PPM[delta_sigma_preset] * 1e-6,
        label=f"r_NH={r_nh_preset} A, dsigma={delta_sigma_preset} ppm",
    )


def custom_constants(
    r_nh_angstrom: float,
    delta_sigma_ppm: float,
    label: Optional[str] = None,
) -> SdmConstants:
    """Build SdmConstants from user-supplied display-unit values.

    Args:
        r_nh_angstrom: N-H distance in Angstrom (must be positive).
        delta_sigma_ppm: 15N CSA in ppm (negative for amide 15N).
        label: Optional provenance label; defaults to a descriptive string.

    Raises:
        ValueError: if r_nh_angstrom is not positive, or if either value is
            outside a physically sane range.
    """
    if not (r_nh_angstrom > 0):
        raise ValueError(f"r_NH must be positive, got {r_nh_angstrom} A")
    # Generous bounds: these catch unit mistakes (metres typed as Angstrom,
    # ppm entered as a fraction) rather than legislating chemistry.
    if not (0.5 <= r_nh_angstrom <= 2.0):
        raise ValueError(
            f"r_NH = {r_nh_angstrom} A is outside the plausible range "
            "0.5-2.0 A; check the units."
        )
    if not (-400.0 <= delta_sigma_ppm <= 400.0):
        raise ValueError(
            f"delta_sigma = {delta_sigma_ppm} ppm is outside the plausible "
            "range +/-400 ppm; check the units."
        )
    return SdmConstants(
        r_nh=r_nh_angstrom * 1e-10,
        delta_sigma=delta_sigma_ppm * 1e-6,
        label=label or f"custom r_NH={r_nh_angstrom} A, dsigma={delta_sigma_ppm} ppm",
    )


def perturb(constants: SdmConstants, *, r_nh_scale: float = 1.0,
            delta_sigma_scale: float = 1.0) -> SdmConstants:
    """Return a copy with the geometry scaled, for systematic-band estimation.

    Used to propagate the r_NH / delta_sigma choice as a coherent band across
    all residues, which is reported separately from the statistical error.
    """
    return replace(
        constants,
        r_nh=constants.r_nh * r_nh_scale,
        delta_sigma=constants.delta_sigma * delta_sigma_scale,
        label=f"{constants.label} (perturbed)",
    )
