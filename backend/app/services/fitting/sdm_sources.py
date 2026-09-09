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
Reading R1, R2 and hetNOE analyses out of the project and assembling a
consistent per-residue dataset for spectral density mapping.

The mapping itself is trivial; not silently producing garbage is the
engineering. Everything in this module exists to make an inconsistent input
set fail loudly and legibly rather than produce plausible-looking nonsense.
"""

from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

from ..path_utils import resolve_existing_path
from .spin_system import SpinSystemKey

# Two spectrometers described as "600 MHz" rarely report identical 1H
# frequencies, so an exact match is the wrong test; but a 600/800 mix must
# never pass. 1 MHz separates instrument-to-instrument scatter from a
# genuinely different field.
B0_TOLERANCE_MHZ = 1.0

REASON_MISSING_R1 = "missing R1"
REASON_MISSING_R2 = "missing R2"
REASON_MISSING_NOE = "missing hetNOE"
REASON_NON_FINITE = "non-finite input"
REASON_NON_POSITIVE_R1 = "R1 is zero or negative"
REASON_MISSING_REX = "missing Rex"
REASON_SYMBOL_CONFLICT = "residue symbol disagrees between sources"


class SdmSourceError(ValueError):
    """A source analysis cannot be used. Surfaces as a 422 with the message."""

    def __init__(self, message: str, detail: Optional[Dict[str, object]] = None):
        super().__init__(message)
        self.detail = detail or {}


@dataclass
class RateSeries:
    """Per-residue values pulled from one relaxation analysis."""

    analysis_uuid: str
    analysis_name: str
    analysis_type: str
    b0_mhz: Optional[float]
    values: Dict[str, float] = field(default_factory=dict)
    errors: Dict[str, float] = field(default_factory=dict)
    res_num: Dict[str, Optional[int]] = field(default_factory=dict)
    res_name: Dict[str, Optional[str]] = field(default_factory=dict)
    raw_assignment: Dict[str, str] = field(default_factory=dict)


@dataclass
class ExcludedResidue:
    residue: str
    reason: str
    res_num: Optional[int] = None

    def to_dict(self) -> Dict[str, object]:
        return {"residue": self.residue, "res_num": self.res_num, "reason": self.reason}


@dataclass
class SdmDataset:
    """The intersected, validated dataset handed to the mapper."""

    assignments: List[str]
    res_num: List[Optional[int]]
    res_name: List[Optional[str]]
    r1: np.ndarray
    r1_err: np.ndarray
    r2: np.ndarray
    r2_err: np.ndarray
    noe: np.ndarray
    noe_err: np.ndarray
    excluded: List[ExcludedResidue]
    b0_mhz: float
    rex: Optional[np.ndarray] = None
    rex_err: Optional[np.ndarray] = None

    def __len__(self) -> int:
        return len(self.assignments)


def canonical_residue_key(assignment: str) -> str:
    """Normalise an assignment so sources can be intersected.

    Uses the SYMBOL-FREE form ("10N"), not the canonical one ("G10N").
    Relaxation analyses inherit assignments from peak fitting and carry the
    amino-acid symbol; ChemEx writes its spin-system keys without one, so
    matching on the canonical form would fail to intersect a CPMG-derived
    R2,0 with an R1 from the same residue and silently drop every residue as
    "missing R2". This mirrors SpinSystemKey.matches, which likewise treats
    an absent symbol as compatible.

    Symbols are not discarded: residue_symbol() keeps them so build_dataset
    can reject a genuine disagreement rather than merging two residues.
    """
    try:
        key = SpinSystemKey.parse(assignment)
        if key.res_num:
            return key.short
    except Exception:
        pass
    return assignment.strip().upper()


def residue_symbol(assignment: str) -> str:
    """The amino-acid symbol in an assignment, or "" when it carries none."""
    try:
        return SpinSystemKey.parse(assignment).symbol or ""
    except Exception:
        return ""


def display_assignment(*candidates: Optional[str]) -> str:
    """Prefer the most informative spelling of a residue for display."""
    best = ""
    for candidate in candidates:
        if not candidate:
            continue
        if residue_symbol(candidate) and not residue_symbol(best):
            best = candidate
        elif not best:
            best = candidate
    return best


def load_rate_series(analysis) -> RateSeries:
    """Read one completed relaxation analysis into a RateSeries.

    For R1/R2 the stored `rate` is the relaxation rate in s^-1. For hetNOE it
    is the I_sat/I_ref ratio -- the NOE value itself -- and `rate_err` is
    propagated from spectral noise on that ratio rather than from an
    exponential fit, which is what makes it usable here.

    Raises:
        SdmSourceError: if the analysis is not complete or has no results.
    """
    name = getattr(analysis, "name", "?")
    if (analysis.status or "").upper() != "COMPLETED":
        raise SdmSourceError(
            f"Source analysis '{name}' has status {analysis.status}; "
            "spectral density mapping requires a COMPLETED source."
        )

    path = resolve_existing_path(analysis.results_path) if analysis.results_path else None
    if not path or not os.path.exists(path):
        raise SdmSourceError(
            f"Source analysis '{name}' has no results file on disk."
        )

    with open(path, "r", encoding="utf-8") as handle:
        payload = json.load(handle)

    peak_results = payload.get("peak_results") or []
    if not peak_results:
        raise SdmSourceError(f"Source analysis '{name}' contains no peak results.")

    series = RateSeries(
        analysis_uuid=analysis.analysis_uuid,
        analysis_name=name,
        analysis_type=(analysis.analysis_type or "").upper(),
        b0_mhz=resolve_b0_mhz(analysis),
    )
    for peak in peak_results:
        assignment = peak.get("assignment")
        if not assignment:
            continue
        key = canonical_residue_key(assignment)
        series.raw_assignment[key] = str(assignment)
        series.values[key] = float(peak.get("rate", float("nan")))
        series.errors[key] = float(peak.get("rate_err", 0.0) or 0.0)
        series.res_num[key] = peak.get("res_num")
        series.res_name[key] = peak.get("res_name")
    return series


def load_cpmg_r2_series(analysis, target_b0_mhz: float,
                        tolerance_mhz: float = B0_TOLERANCE_MHZ) -> RateSeries:
    """Read exchange-free R2,0 (ChemEx R2_A) out of a completed CPMG fit.

    ChemEx's fitted R2_A *is* the transverse rate with exchange already
    removed by the fitted model, so using it needs no Rex subtraction and no
    covariance bookkeeping. That makes it a production R2 provenance, not an
    experimental exchange correction, and it is NOT gated by the Rex flag.

    Field selection is the whole risk here. A multi-field CPMG fit writes one
    R2_A block per field:

        ["R2_A, B0->500.0MHZ"]
        15N =  4.00996e+00 # +/-2.27191e-01
        ["R2_A, B0->800.0MHZ"]
        15N =  6.67323e+00 # +/-3.42271e-01

    -- the same residue differing by two thirds. The general ChemEx parser
    strips the B0 qualifier when it normalises parameter names, so the blocks
    collide there and the last one silently wins. This function therefore
    reads the raw sections and selects on the field itself, refusing to guess
    when the requested one is absent.

    Args:
        analysis: a COMPLETED CPMG analysis in the same project.
        target_b0_mhz: the field the mapping runs at, taken from the R1 and
            hetNOE sources.
        tolerance_mhz: how close a block's field must be to count as a match.

    Raises:
        SdmSourceError: if the fit is incomplete, has no R2_A, or has none at
            the requested field.
    """
    from .chemex_parser import parse_fitted_toml_file
    from .param_canonicalizer import canonicalize

    name = getattr(analysis, "name", "?")
    if (analysis.status or "").upper() != "COMPLETED":
        raise SdmSourceError(
            f"CPMG analysis '{name}' has status {analysis.status}; "
            "an R2,0 source must be a COMPLETED fit."
        )

    run_dir = _cpmg_run_dir(analysis)
    sections: Dict[str, Dict[str, Dict[str, object]]] = {}
    for candidate in _parameter_file_candidates(run_dir):
        if os.path.isfile(candidate):
            parsed = parse_fitted_toml_file(candidate)
            if parsed:
                sections.update(parsed)
    if not sections:
        raise SdmSourceError(
            f"CPMG analysis '{name}' has no fitted parameter file to read "
            "R2,0 from. Run the fit to completion first."
        )

    # Collect every R2_A block with the field it belongs to.
    blocks: List[Tuple[Optional[float], Dict[str, Dict[str, object]]]] = []
    for section_name, entries in sections.items():
        key = canonicalize(section_name)
        if key.name != "R2_A":
            continue
        blocks.append((_parse_field_mhz(key.field), entries))

    if not blocks:
        raise SdmSourceError(
            f"CPMG analysis '{name}' has no fitted R2_A parameter, so it "
            "cannot supply an exchange-free R2. Fit R2,0 and try again."
        )

    available = [f for f, _ in blocks if f is not None]
    matching = [
        entries for f, entries in blocks
        if f is None or abs(f - target_b0_mhz) <= tolerance_mhz
    ]
    if not matching:
        raise SdmSourceError(
            f"CPMG analysis '{name}' has no R2,0 at {target_b0_mhz:.2f} MHz. "
            f"It was fitted at {', '.join(f'{f:.2f}' for f in sorted(available))} MHz. "
            "Using an R2,0 from a different field would silently change R2 by "
            "tens of percent and land the error on J(0).",
            detail={
                "requested_mhz": target_b0_mhz,
                "available_mhz": sorted(available),
                "tolerance_mhz": tolerance_mhz,
            },
        )
    if len(matching) > 1:
        raise SdmSourceError(
            f"CPMG analysis '{name}' has more than one R2,0 block matching "
            f"{target_b0_mhz:.2f} MHz; the fit is ambiguous at this field.",
            detail={"requested_mhz": target_b0_mhz, "available_mhz": sorted(available)},
        )

    series = RateSeries(
        analysis_uuid=analysis.analysis_uuid,
        analysis_name=name,
        analysis_type="CPMG_R2_0",
        b0_mhz=target_b0_mhz,
    )
    for res_key, entry in matching[0].items():
        value = entry.get("value") if isinstance(entry, dict) else None
        if value is None:
            continue
        key = canonical_residue_key(str(res_key))
        series.raw_assignment[key] = str(res_key)
        series.values[key] = float(value)
        err = entry.get("err") if isinstance(entry, dict) else None
        series.errors[key] = float(err) if err is not None else 0.0
        parsed_key = SpinSystemKey.parse(str(res_key))
        series.res_num[key] = parsed_key.res_num or None
        series.res_name[key] = None

    if not series.values:
        raise SdmSourceError(
            f"CPMG analysis '{name}' has an R2_A block at "
            f"{target_b0_mhz:.2f} MHz but no per-residue values in it."
        )
    return series


def _cpmg_run_dir(analysis) -> str:
    """Locate a CPMG analysis run directory, mirroring the analysis router."""
    if analysis.results_path:
        resolved = resolve_existing_path(analysis.results_path)
        if resolved and os.path.isdir(resolved):
            return resolved
        if resolved:
            return os.path.dirname(resolved)
    project = getattr(analysis, "project", None)
    base = getattr(project, "local_directory_path", "") or ""
    return os.path.join(base, "cpmg_fitting", analysis.analysis_uuid)


def _parameter_file_candidates(run_dir: str) -> List[str]:
    """Where ChemEx may have written fitted parameters, most specific last.

    Later files override earlier ones, so the final fitted values win over
    starting parameters.
    """
    names = ["parameters.toml", "fitted.toml"]
    dirs = [
        run_dir,
        os.path.join(run_dir, "Parameters"),
        os.path.join(run_dir, "Output"),
        os.path.join(run_dir, "Output", "Parameters"),
        os.path.join(run_dir, "Output", "All", "Parameters"),
    ]
    if os.path.isdir(os.path.join(run_dir, "Output")):
        output = os.path.join(run_dir, "Output")
        for step in sorted(
            d for d in os.listdir(output) if d.upper().startswith("STEP")
        ):
            dirs.append(os.path.join(output, step, "Parameters"))
            dirs.append(os.path.join(output, step, "All", "Parameters"))
    return [os.path.join(d, n) for d in dirs for n in names]


def _parse_field_mhz(field: Optional[str]) -> Optional[float]:
    """Turn a ChemEx B0 qualifier such as "600.3MHZ" into MHz."""
    if not field:
        return None
    text = str(field).upper().replace("MHZ", "").strip()
    try:
        return float(text)
    except ValueError:
        return None


def resolve_b0_mhz(analysis) -> Optional[float]:
    """The 1H Larmor frequency in MHz for an analysis, from its spectra.

    Spectrum.b0 holds the value nmrglue reports (FDF2OBS for NMRPipe,
    acqus/SFO1 for Bruker), which is MHz. Returns None when no linked
    spectrum carries one -- the caller hard-fails rather than defaulting,
    because a wrong field silently produces plausible nonsense.
    """
    for spectrum in getattr(analysis, "spectra", None) or []:
        b0 = getattr(spectrum, "b0", None)
        if b0 is not None and float(b0) > 0:
            return float(b0)
    return None


def validate_field_consistency(series: Sequence[RateSeries],
                               tolerance_mhz: float = B0_TOLERANCE_MHZ) -> float:
    """All three sources must share B0. HARD FAILURE, never a warning.

    Mapping a 600 MHz R1 against an 800 MHz R2 produces J values that look
    entirely reasonable and are entirely wrong, so this cannot degrade to a
    warning the user clicks past.

    Returns:
        The agreed B0 in MHz.

    Raises:
        SdmSourceError: if any source lacks B0, or the spread exceeds the
            tolerance. The detail carries every field so the UI can name the
            odd one out.
    """
    fields = {s.analysis_type or s.analysis_uuid: s.b0_mhz for s in series}
    missing = [k for k, v in fields.items() if v is None]
    if missing:
        raise SdmSourceError(
            "Cannot determine the static field for source analyses: "
            f"{', '.join(sorted(missing))}. Set B0 on the linked spectra "
            "before mapping -- it is not safe to assume a default.",
            detail={"fields_mhz": fields, "tolerance_mhz": tolerance_mhz},
        )

    values = [float(v) for v in fields.values()]
    spread = max(values) - min(values)
    if spread > tolerance_mhz:
        raise SdmSourceError(
            "Source analyses were recorded at different static fields "
            f"({', '.join(f'{k}={v:.2f} MHz' for k, v in sorted(fields.items()))}). "
            "Reduced spectral density mapping is a single-field method; "
            "mixing fields produces plausible-looking but meaningless J values.",
            detail={"fields_mhz": fields, "tolerance_mhz": tolerance_mhz},
        )
    return float(np.mean(values))


def convert_r1rho_to_r2(
    r1rho: np.ndarray,
    r1rho_err: np.ndarray,
    r1: np.ndarray,
    r1_err: np.ndarray,
    tilt_angle_deg: float,
) -> Tuple[np.ndarray, np.ndarray]:
    """R2 = (R1rho - R1 cos^2 theta) / sin^2 theta.

    Which provenance produced R2 is recorded in the analysis snapshot, since
    an R1rho-derived R2 and an echo-decay R2 are not interchangeable when
    exchange is present.

    Raises:
        SdmSourceError: if the tilt angle makes the conversion singular.
    """
    theta = math.radians(float(tilt_angle_deg))
    sin2 = math.sin(theta) ** 2
    cos2 = math.cos(theta) ** 2
    if sin2 < 1e-6:
        raise SdmSourceError(
            f"R1rho tilt angle {tilt_angle_deg} deg gives sin^2(theta) = "
            f"{sin2:.2e}; the conversion to R2 is singular near 0 or 180 deg."
        )
    r2 = (np.asarray(r1rho, dtype=np.float64) - np.asarray(r1, dtype=np.float64) * cos2) / sin2
    # Independent errors: R1rho and R1 come from separate experiments.
    r2_err = np.sqrt(
        np.asarray(r1rho_err, dtype=np.float64) ** 2
        + (np.asarray(r1_err, dtype=np.float64) * cos2) ** 2
    ) / sin2
    return r2, r2_err


def build_dataset(
    r1_series: RateSeries,
    r2_series: RateSeries,
    noe_series: RateSeries,
    rex_by_residue: Optional[Dict[str, Tuple[float, float]]] = None,
    tolerance_mhz: float = B0_TOLERANCE_MHZ,
) -> SdmDataset:
    """Intersect the three sources into one aligned dataset.

    Every residue that does not make it into the intersection is recorded
    with a specific reason rather than silently dropped, and the counts are
    surfaced in both the API response and the UI.

    Negative and near-zero NOE values are kept: they are physically valid for
    tails and flexible loops. They are flagged downstream because J(0.87 wH)
    then carries very large relative error, but filtering them would discard
    real measurements.
    """
    b0 = validate_field_consistency([r1_series, r2_series, noe_series], tolerance_mhz)

    all_keys = set(r1_series.values) | set(r2_series.values) | set(noe_series.values)
    excluded: List[ExcludedResidue] = []
    kept: List[str] = []

    # Report residues by their most informative spelling, not the bare match
    # key, so the table and CSV read the way the user's peak list does.
    display = {
        key: display_assignment(
            r1_series.raw_assignment.get(key),
            noe_series.raw_assignment.get(key),
            r2_series.raw_assignment.get(key),
        ) or key
        for key in all_keys
    }

    for key in sorted(all_keys, key=_residue_sort_key):
        res_num = (
            r1_series.res_num.get(key)
            or r2_series.res_num.get(key)
            or noe_series.res_num.get(key)
        )
        missing = []
        if key not in r1_series.values:
            missing.append(REASON_MISSING_R1)
        if key not in r2_series.values:
            missing.append(REASON_MISSING_R2)
        if key not in noe_series.values:
            missing.append(REASON_MISSING_NOE)
        if missing:
            excluded.append(ExcludedResidue(display[key], ", ".join(missing), res_num))
            continue

        # Residues are matched on the symbol-free form so that peak-fitting
        # assignments ("G10N") intersect ChemEx spin keys ("10N"). That makes
        # a genuine symbol disagreement -- G10N in one source, A10N in
        # another -- invisible unless it is checked for explicitly here.
        symbols = {
            residue_symbol(series.raw_assignment.get(key, ""))
            for series in (r1_series, r2_series, noe_series)
        }
        symbols.discard("")
        if len(symbols) > 1:
            excluded.append(ExcludedResidue(
                display[key],
                f"{REASON_SYMBOL_CONFLICT} ({', '.join(sorted(symbols))})",
                res_num,
            ))
            continue

        values = (
            r1_series.values[key], r2_series.values[key], noe_series.values[key],
            r1_series.errors.get(key, 0.0), r2_series.errors.get(key, 0.0),
            noe_series.errors.get(key, 0.0),
        )
        if not all(math.isfinite(v) for v in values):
            excluded.append(ExcludedResidue(display[key], REASON_NON_FINITE, res_num))
            continue
        # sigma = k(NOE-1)R1 and J_h = sigma/(5d^2/4): a non-positive R1 makes
        # the NOE-to-sigma conversion meaningless rather than merely noisy.
        if r1_series.values[key] <= 0:
            excluded.append(ExcludedResidue(display[key], REASON_NON_POSITIVE_R1, res_num))
            continue
        if rex_by_residue is not None and key not in rex_by_residue:
            excluded.append(ExcludedResidue(display[key], REASON_MISSING_REX, res_num))
            continue
        kept.append(key)

    dataset = SdmDataset(
        assignments=[display[k] for k in kept],
        res_num=[r1_series.res_num.get(k) or r2_series.res_num.get(k)
                 or noe_series.res_num.get(k) for k in kept],
        res_name=[r1_series.res_name.get(k) or r2_series.res_name.get(k)
                  or noe_series.res_name.get(k) for k in kept],
        r1=np.array([r1_series.values[k] for k in kept], dtype=np.float64),
        r1_err=np.array([r1_series.errors.get(k, 0.0) for k in kept], dtype=np.float64),
        r2=np.array([r2_series.values[k] for k in kept], dtype=np.float64),
        r2_err=np.array([r2_series.errors.get(k, 0.0) for k in kept], dtype=np.float64),
        noe=np.array([noe_series.values[k] for k in kept], dtype=np.float64),
        noe_err=np.array([noe_series.errors.get(k, 0.0) for k in kept], dtype=np.float64),
        excluded=excluded,
        b0_mhz=b0,
    )
    if rex_by_residue is not None:
        dataset.rex = np.array([rex_by_residue[k][0] for k in kept], dtype=np.float64)
        dataset.rex_err = np.array([rex_by_residue[k][1] for k in kept], dtype=np.float64)
    return dataset


def _residue_sort_key(assignment: str):
    """Sort by residue number where one can be read, else alphabetically."""
    try:
        key = SpinSystemKey.parse(assignment)
        if key.res_num:
            return (0, key.res_num, assignment)
    except Exception:
        pass
    return (1, 0, assignment)
