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
Runs a spectral density mapping and writes the results payload.

The analytic path is milliseconds for a few hundred residues, so it runs
synchronously in the request. Only the Monte Carlo cross-check goes to the
stats Celery queue, where it emits kind="resample" progress events through
the same progress.json contract the relaxation task already uses.
"""

from __future__ import annotations

import json
import os
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional

import numpy as np

from ...services.sdm import (
    S_RAD_TO_NS_RAD,
    SdmVariant,
    analyse,
    constants_from_presets,
    custom_constants,
    field_physics,
    map_dataset,
    monte_carlo_covariance,
    systematic_band,
)
from ...services.sdm.schemas import ErrorMethod, R2Provenance, RexSource
from .sdm_sources import SdmDataset

EXPERIMENTAL_NOTICE = (
    "EXPERIMENTAL: these spectral densities were produced with an "
    "experimental chemical-exchange correction and have not been validated. "
    "Do not report them as production results."
)

# Base RSDM assumes no chemical exchange. R1 and the NOE carry no Rex, so any
# exchange contribution lands entirely on J(0) -- which is also the quantity
# users over-interpret. This text is surfaced NEXT TO THE PLOT in the UI, not
# only in the docs.
J0_EXCHANGE_CAVEAT = (
    "Base RSDM assumes no chemical exchange. Any exchange contribution lands "
    "entirely on J(0), so an elevated J(0) is as consistent with microsecond-"
    "millisecond exchange as with slow overall tumbling. Interpret J(0) "
    "differences with that ambiguity in mind."
)


def build_constants(params: Dict[str, Any]):
    """Resolve the constants choice from stored parameters."""
    constants_cfg = params.get("constants") or {}
    r_nh_a = constants_cfg.get("r_nh_angstrom")
    csa_ppm = constants_cfg.get("delta_sigma_ppm")
    if r_nh_a is not None and csa_ppm is not None:
        return custom_constants(float(r_nh_a), float(csa_ppm))
    return constants_from_presets(
        str(constants_cfg.get("r_nh_preset", "1.02")),
        str(constants_cfg.get("delta_sigma_preset", "-160")),
    )


def run_mapping(
    dataset: SdmDataset,
    params: Dict[str, Any],
    progress_callback: Optional[Callable[[int, int, str], None]] = None,
) -> Dict[str, Any]:
    """Map a prepared dataset and build the JSON-serialisable results payload.

    Args:
        dataset: the intersected, field-validated inputs.
        params: stored analysis parameters (constants, variant, error method).
        progress_callback: forwarded to the Monte Carlo path.

    Returns:
        The results payload, in display units (ns rad^-1) at the boundary.
    """
    constants = build_constants(params)
    variant = SdmVariant(params.get("variant", SdmVariant.FARROW1995.value))
    # Spectrum.b0 is the 1H Larmor frequency in MHz; the core package wants Hz.
    b0_hz = dataset.b0_mhz * 1e6
    physics = field_physics(b0_hz, constants, variant)

    rex_source = RexSource(params.get("rex_source", RexSource.NONE.value))
    use_rex = rex_source != RexSource.NONE and dataset.rex is not None

    result = map_dataset(
        dataset.r1, dataset.r1_err,
        dataset.r2, dataset.r2_err,
        dataset.noe, dataset.noe_err,
        physics,
        rex=dataset.rex if use_rex else None,
        rex_err=dataset.rex_err if use_rex else None,
    )

    error_method = ErrorMethod(params.get("error_method", ErrorMethod.ANALYTIC.value))
    covariance = result.covariance
    if error_method == ErrorMethod.MONTE_CARLO:
        # MC is a cross-check on the analytic result, so the point estimates
        # stay analytic and only the covariance is replaced.
        _, mc_cov = monte_carlo_covariance(
            dataset.r1, dataset.r1_err,
            dataset.r2, dataset.r2_err,
            dataset.noe, dataset.noe_err,
            physics,
            n_replicates=int(params.get("n_replicates", 2000)),
            seed=params.get("seed"),
            progress_callback=progress_callback,
        )
        covariance = mc_cov

    diagnostics = analyse(result, dataset.noe, dataset.noe_err)

    band = systematic_band(
        dataset.r1, dataset.r1_err,
        dataset.r2, dataset.r2_err,
        dataset.noe, dataset.noe_err,
        b0_hz, constants, variant,
    )
    band_frac = band.fractional_span().mean(axis=0)

    j_ns = result.j * S_RAD_TO_NS_RAD
    # ns^2 rad^-2 for the covariance, consistent with the reported J unit.
    cov_ns = covariance * (S_RAD_TO_NS_RAD ** 2)
    err_ns = np.sqrt(np.clip(np.einsum("nii->ni", cov_ns), 0.0, None))

    residues: List[Dict[str, Any]] = []
    for i, assignment in enumerate(dataset.assignments):
        rd = diagnostics.residues[i]
        row: Dict[str, Any] = {
            "assignment": assignment,
            "res_num": dataset.res_num[i],
            "res_name": dataset.res_name[i],
            "j0": float(j_ns[i, 0]),
            "j_wn": float(j_ns[i, 1]),
            "j_h": float(j_ns[i, 2]),
            "j0_err": float(err_ns[i, 0]),
            "j_wn_err": float(err_ns[i, 1]),
            "j_h_err": float(err_ns[i, 2]),
            "covariance": [[float(v) for v in row_] for row_ in cov_ns[i]],
            "r1": float(dataset.r1[i]),
            "r1_err": float(dataset.r1_err[i]),
            "r2": float(dataset.r2[i]),
            "r2_err": float(dataset.r2_err[i]),
            "noe": float(dataset.noe[i]),
            "noe_err": float(dataset.noe_err[i]),
            "sigma": float(result.sigma[i]),
            "sigma_err": float(result.sigma_err[i]),
            "tau_c": rd.tau_c,
            "flags": list(rd.flags),
            "excluded": False,
            "exclusion_reason": None,
        }
        if use_rex:
            row["rex"] = float(dataset.rex[i])
            row["rex_err"] = float(dataset.rex_err[i])
        residues.append(row)

    experimental = rex_source != RexSource.NONE
    summary = diagnostics.to_dict()
    summary["n_excluded"] = len(dataset.excluded)
    summary["systematic_band"] = {
        "description": band.description,
        "j0_fractional": float(band_frac[0]),
        "j_wn_fractional": float(band_frac[1]),
        "j_h_fractional": float(band_frac[2]),
    }

    return {
        "analysis_type": "SDM",
        "timestamp": datetime.now().isoformat(),
        "experimental": experimental,
        "experimental_notice": EXPERIMENTAL_NOTICE if experimental else None,
        "j0_caveat": J0_EXCHANGE_CAVEAT,
        "b0_h_mhz": dataset.b0_mhz,
        "variant": variant.value,
        "error_method": error_method.value,
        "rex_source": rex_source.value,
        "r2_provenance": params.get("r2_provenance", R2Provenance.ECHO_DECAY.value),
        "constants_snapshot": constants.to_snapshot(),
        "physics_snapshot": physics.to_snapshot(),
        "source_analyses": {
            "r1": params.get("source_r1_analysis_uuid"),
            "r2": params.get("source_r2_analysis_uuid"),
            "noe": params.get("source_noe_analysis_uuid"),
            "rex_cpmg": params.get("rex_cpmg_analysis_uuid"),
        },
        "summary": summary,
        "residues": residues,
        "excluded_residues": [e.to_dict() for e in dataset.excluded],
        "j_units": "ns/rad",
    }


def sdm_run_dir(analysis) -> str:
    """Run directory for a spectral density analysis.

    Mirrors the relaxation convention: <project>/<type>_fitting/<uuid>/.
    """
    return os.path.join(
        analysis.project.local_directory_path, "sdm_fitting", analysis.analysis_uuid
    )


def write_results(analysis, payload: Dict[str, Any]) -> str:
    """Write results.json into the analysis run directory, atomically."""
    run_dir = sdm_run_dir(analysis)
    os.makedirs(run_dir, exist_ok=True)
    path = os.path.join(run_dir, "results.json")
    payload = dict(payload, analysis_uuid=analysis.analysis_uuid, name=analysis.name)
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, default=_json_default)
    os.replace(tmp, path)
    return path


def _json_default(obj):
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating,)):
        return float(obj)
    if isinstance(obj, (np.bool_,)):
        return bool(obj)
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")


def build_csv(payload: Dict[str, Any]) -> str:
    """Per-residue CSV export.

    An experimental analysis carries its marker in a header comment, so the
    file cannot circulate looking validated once it has left the app.
    """
    lines: List[str] = []
    if payload.get("experimental"):
        lines.append(f"# {payload.get('experimental_notice', EXPERIMENTAL_NOTICE)}")
    lines.append(
        f"# resoFlow spectral density mapping | variant={payload.get('variant')} "
        f"| B0={payload.get('b0_h_mhz')} MHz "
        f"| r_NH={payload.get('constants_snapshot', {}).get('r_nh_angstrom')} A "
        f"| delta_sigma={payload.get('constants_snapshot', {}).get('delta_sigma_ppm')} ppm "
        f"| error_method={payload.get('error_method')} "
        f"| rex_source={payload.get('rex_source')}"
    )
    lines.append("# J values in ns/rad; covariance entries in ns^2/rad^2")

    header = [
        "Res #", "Res Name", "Assignment",
        "J(0) [ns/rad]", "J(0) err",
        "J(wN) [ns/rad]", "J(wN) err",
        "J(0.87wH) [ns/rad]", "J(0.87wH) err",
        "Cov J0-JwN", "Cov J0-Jh", "Cov JwN-Jh",
        "R1 [s-1]", "R1 err", "R2 [s-1]", "R2 err", "NOE", "NOE err",
        "sigma [s-1]", "sigma err", "tau_c [ns]", "Flags",
    ]
    include_rex = any("rex" in r for r in payload.get("residues", []))
    if include_rex:
        header.extend(["Rex [s-1]", "Rex err"])
    lines.append(",".join(header))

    for row in payload.get("residues", []):
        cov = row.get("covariance") or [[0.0] * 3 for _ in range(3)]
        tau_c = row.get("tau_c")
        record = [
            _csv_cell(row.get("res_num")),
            _csv_cell(row.get("res_name")),
            _csv_cell(row.get("assignment")),
            _num(row.get("j0")), _num(row.get("j0_err")),
            _num(row.get("j_wn")), _num(row.get("j_wn_err")),
            _num(row.get("j_h")), _num(row.get("j_h_err")),
            _num(cov[0][1]), _num(cov[0][2]), _num(cov[1][2]),
            _num(row.get("r1")), _num(row.get("r1_err")),
            _num(row.get("r2")), _num(row.get("r2_err")),
            _num(row.get("noe")), _num(row.get("noe_err")),
            _num(row.get("sigma")), _num(row.get("sigma_err")),
            _num(tau_c * 1e9 if tau_c is not None else None),
            _csv_cell(" ".join(row.get("flags") or [])),
        ]
        if include_rex:
            record.extend([_num(row.get("rex")), _num(row.get("rex_err"))])
        lines.append(",".join(record))

    excluded = payload.get("excluded_residues") or []
    if excluded:
        lines.append("")
        lines.append("# Excluded residues")
        lines.append("Residue,Res #,Reason")
        for item in excluded:
            lines.append(",".join([
                _csv_cell(item.get("residue")),
                _csv_cell(item.get("res_num")),
                _csv_cell(item.get("reason")),
            ]))
    return "\n".join(lines) + "\n"


def _csv_cell(value: Any) -> str:
    if value is None:
        return ""
    text = str(value)
    if any(ch in text for ch in (",", '"', "\n")):
        return '"' + text.replace('"', '""') + '"'
    return text


def _num(value: Any, digits: int = 6) -> str:
    if value is None:
        return ""
    try:
        f = float(value)
    except (TypeError, ValueError):
        return ""
    if not np.isfinite(f):
        return ""
    return f"{f:.{digits}g}"
