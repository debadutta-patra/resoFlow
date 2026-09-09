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
from typing import Any, Callable, Dict, List, Optional, Sequence

import numpy as np

from ...services.sdm import (
    FLAG_DESCRIPTIONS,
    S_RAD_TO_NS_RAD,
    SdmVariant,
    analyse,
    constants_from_presets,
    custom_constants,
    field_physics,
    map_dataset,
    monte_carlo_covariance,
    systematic_band,
    tau_c_from_ratio,
    trimmed_mean,
)
from ...services.sdm.multifield import (
    MIN_FIELDS_FOR_SCALING,
    FieldObservation,
    fit_rex_scaling_exponent,
    map_multifield_dataset,
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
    # diagnostics works in s/rad; the payload declares ns/rad and every
    # residue row is converted, so the summary must be too or the two
    # disagree by nine orders of magnitude.
    for key in ("j0_trimmed_mean", "jwn_trimmed_mean", "jh_trimmed_mean"):
        if summary.get(key) is not None:
            summary[key] = float(summary[key]) * S_RAD_TO_NS_RAD
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


MULTIFIELD_CAVEAT = (
    "The chi-square tests one thing: whether a single field-independent J(0) "
    "explains R2 at every field. R1 and the NOE carry no exchange, so a small "
    "p-value implicates exchange. It cannot see exchange that does not vary "
    "with field -- that component is perfectly degenerate with J(0) and is "
    "absorbed into it, biasing J(0) with no warning sign."
)


def run_multifield_mapping(
    datasets: Sequence[SdmDataset],
    params: Dict[str, Any],
) -> Dict[str, Any]:
    """EXPERIMENTAL multi-field consistency analysis with the exchange test.

    Args:
        datasets: one per field, already aligned to common residues.
        params: stored analysis parameters.

    Returns:
        The results payload, in display units.
    """
    constants = build_constants(params)
    variant = SdmVariant(params.get("variant", SdmVariant.FARROW1995.value))

    observations = [
        FieldObservation(
            physics=field_physics(dataset.b0_mhz * 1e6, constants, variant),
            r1=dataset.r1, r1_err=dataset.r1_err,
            r2=dataset.r2, r2_err=dataset.r2_err,
            noe=dataset.noe, noe_err=dataset.noe_err,
        )
        for dataset in datasets
    ]
    result = map_multifield_dataset(observations)

    primary = datasets[0]
    fields_mhz = [d.b0_mhz for d in datasets]
    j0_ns = result.j0 * S_RAD_TO_NS_RAD
    j0_err_ns = result.j0_err * S_RAD_TO_NS_RAD
    j_wn_ns = result.j_wn * S_RAD_TO_NS_RAD
    j_h_ns = result.j_h * S_RAD_TO_NS_RAD

    residues: List[Dict[str, Any]] = []
    alphas: List[Optional[float]] = []
    for i, assignment in enumerate(primary.assignments):
        scaling = fit_rex_scaling_exponent(
            [d.b0_mhz * 1e6 for d in datasets],
            result.r2_residual[i],
            [max(d.r2_err[i], 1e-9) for d in datasets],
        )
        alphas.append(scaling.alpha if scaling else None)
        residues.append({
            "assignment": assignment,
            "res_num": primary.res_num[i],
            "res_name": primary.res_name[i],
            "j0": float(j0_ns[i]),
            "j0_err": float(j0_err_ns[i]),
            "chi2": float(result.chi2[i]),
            "p_value": float(result.p_value[i]),
            "per_field": [
                {
                    "b0_h_mhz": fields_mhz[k],
                    "j_wn": float(j_wn_ns[i, k]),
                    "j_h": float(j_h_ns[i, k]),
                    "r1": float(datasets[k].r1[i]),
                    "r2": float(datasets[k].r2[i]),
                    "noe": float(datasets[k].noe[i]),
                    "r2_residual": float(result.r2_residual[i, k]),
                }
                for k in range(len(datasets))
            ],
            "scaling_exponent": (
                {
                    "alpha": scaling.alpha,
                    "alpha_err": scaling.alpha_err,
                    "exactly_determined": scaling.exactly_determined,
                    "at_bound": scaling.at_bound,
                }
                if scaling else None
            ),
        })

    significant = [r for r in residues if r["p_value"] < 0.05]
    reported_alphas = [a for a in alphas if a is not None]

    return {
        "analysis_type": "SDM",
        "mode": "multi_field",
        "timestamp": datetime.now().isoformat(),
        "experimental": True,
        "experimental_notice": EXPERIMENTAL_NOTICE,
        "j0_caveat": J0_EXCHANGE_CAVEAT,
        "multifield_caveat": MULTIFIELD_CAVEAT,
        "b0_h_mhz": primary.b0_mhz,
        "fields_mhz": fields_mhz,
        "variant": variant.value,
        "error_method": params.get("error_method", ErrorMethod.ANALYTIC.value),
        "rex_source": RexSource.MULTI_FIELD.value,
        "r2_provenance": params.get("r2_provenance", R2Provenance.ECHO_DECAY.value),
        "constants_snapshot": constants.to_snapshot(),
        "physics_snapshot": observations[0].physics.to_snapshot(),
        "source_analyses": {
            "r1": params.get("source_r1_analysis_uuid"),
            "r2": params.get("source_r2_analysis_uuid"),
            "noe": params.get("source_noe_analysis_uuid"),
            "additional_fields": params.get("additional_field_sources"),
        },
        "summary": {
            "n_fields": len(datasets),
            "dof": result.dof,
            "n_residues": len(residues),
            "n_exchange_flagged": len(significant),
            "median_chi2": float(np.median(result.chi2)) if len(residues) else None,
            "median_alpha": (
                float(np.median(reported_alphas)) if reported_alphas else None
            ),
            "scaling_available": len(datasets) >= MIN_FIELDS_FOR_SCALING,
            "scaling_unavailable_reason": (
                None if len(datasets) >= MIN_FIELDS_FOR_SCALING else
                f"The exponent needs at least {MIN_FIELDS_FOR_SCALING} fields: "
                f"{len(datasets)} fields leave {len(datasets) - 1} residual "
                "degrees of freedom against a two-parameter power law, so "
                "alpha is not identifiable."
            ),
            "n_excluded": len(primary.excluded),
        },
        "residues": residues,
        "excluded_residues": [e.to_dict() for e in primary.excluded],
        "j_units": "ns/rad",
    }


def build_multifield_csv(payload: Dict[str, Any]) -> str:
    """Per-residue CSV for a multi-field run, with the experimental marker."""
    lines = [f"# {payload.get('experimental_notice', EXPERIMENTAL_NOTICE)}"]
    fields = payload.get("fields_mhz", [])
    lines.append(
        f"# resoFlow multi-field spectral density | fields="
        f"{'/'.join(f'{f:.2f}' for f in fields)} MHz "
        f"| dof={payload.get('summary', {}).get('dof')} "
        f"| variant={payload.get('variant')}"
    )
    lines.append("# J values in ns/rad; small p-values implicate exchange")

    header = ["Res #", "Assignment", "J(0) [ns/rad]", "J(0) err", "chi2", "p-value", "alpha"]
    for f in fields:
        header.extend([f"J(wN)@{f:.0f}", f"J(0.87wH)@{f:.0f}",
                       f"R2@{f:.0f}", f"R2 residual@{f:.0f}"])
    lines.append(",".join(header))

    for row in payload.get("residues", []):
        scaling = row.get("scaling_exponent") or {}
        record = [
            _csv_cell(row.get("res_num")), _csv_cell(row.get("assignment")),
            _num(row.get("j0")), _num(row.get("j0_err")),
            _num(row.get("chi2")), _num(row.get("p_value")),
            _num(scaling.get("alpha")),
        ]
        for entry in row.get("per_field", []):
            record.extend([
                _num(entry.get("j_wn")), _num(entry.get("j_h")),
                _num(entry.get("r2")), _num(entry.get("r2_residual")),
            ])
        lines.append(",".join(record))
    return "\n".join(lines) + "\n"


EXCLUDED_BY_USER = "excluded by user"

DEFAULT_NOE_THRESHOLD = 0.65
"""hetNOE below which a residue is excluded by default.

Residues in flexible tails and loops carry a low hetNOE, and their
J(0.87 wH) carries enormous relative error because the NOE error propagates
into it almost entirely. They also should not be setting the overall
tumbling time, which is a property of the folded core. Excluding them is
therefore the usual practice.

This is a FILTER, not a flag, and it is applied on read like the manual
exclusion list -- so changing the threshold updates the summary immediately,
and setting it to None turns the filter off entirely. The excluded residues
stay in the payload with their values and a reason naming the threshold,
because "measured and set aside" is a different statement from "never
measured", and a reader must be able to tell which.
"""

# Flags derived from a residue's own inputs. These stand whatever else is in
# the dataset, unlike the J(0) outlier flags, which are relative to the rest
# of the residues and therefore change when the kept set changes.
_INPUT_DERIVED_FLAGS = ("negative_noe", "low_noe_precision", "negative_j")


def apply_exclusions(
    payload: Dict[str, Any],
    excluded: Optional[Sequence[str]],
    noe_threshold: Optional[float] = DEFAULT_NOE_THRESHOLD,
) -> Dict[str, Any]:
    """Mark excluded residues and recompute everything that depends on the set.

    Per-residue J values are NOT recomputed: each residue is an independent
    solve, so excluding one cannot change another's spectral densities, and
    the stored values stay valid. What does change is everything aggregate --
    the trimmed means, the tau_c estimate, and the J(0) outlier flags, which
    are defined relative to the other residues. Leaving those computed over
    the full set would put a tau_c on the summary card that does not match
    the residues shown underneath it.

    Excluded rows are kept in the payload rather than dropped, flagged with
    `excluded` and a reason, so the table can show them greyed out and the
    export can account for them.

    Returns a new payload; the input is not modified.
    """
    from .sdm_sources import canonical_residue_key

    residues = payload.get("residues") or []
    if not residues:
        return payload

    wanted = {canonical_residue_key(str(r)) for r in (excluded or []) if str(r).strip()}
    result = dict(payload)
    rows = [dict(r) for r in residues]

    threshold = noe_threshold if noe_threshold is not None else None
    for row in rows:
        by_user = canonical_residue_key(str(row.get("assignment", ""))) in wanted
        noe = row.get("noe")
        below = (
            threshold is not None
            and isinstance(noe, (int, float))
            and np.isfinite(noe)
            and noe < threshold
        )

        row["excluded"] = bool(by_user or below)
        if by_user and below:
            # Both apply; say so rather than picking one and hiding the other.
            row["exclusion_reason"] = (
                f"{EXCLUDED_BY_USER}; hetNOE {noe:.3f} below threshold {threshold:g}"
            )
        elif by_user:
            row["exclusion_reason"] = EXCLUDED_BY_USER
        elif below:
            row["exclusion_reason"] = (
                f"hetNOE {noe:.3f} below threshold {threshold:g}"
            )
        else:
            row["exclusion_reason"] = None

    kept = [r for r in rows if not r["excluded"]]
    if payload.get("mode") == "multi_field":
        # The multi-field payload has no J triple or outlier flags to
        # recompute; only the counts depend on the kept set.
        summary = dict(payload.get("summary", {}))
        summary["n_residues"] = len(kept)
        summary["n_excluded_by_user"] = sum(
            1 for r in rows if r["excluded"] and EXCLUDED_BY_USER in (r["exclusion_reason"] or "")
        )
        summary["n_excluded_by_noe"] = sum(
            1 for r in rows if r["excluded"] and "below threshold" in (r["exclusion_reason"] or "")
        )
        summary["noe_threshold"] = threshold
        summary["n_exchange_flagged"] = sum(
            1 for r in kept if (r.get("p_value") or 1.0) < 0.05
        )
        chi2 = [r["chi2"] for r in kept if r.get("chi2") is not None]
        summary["median_chi2"] = float(np.median(chi2)) if chi2 else None
        result["summary"] = summary
        result["residues"] = rows
        return result

    j0 = np.array([r.get("j0", np.nan) for r in kept], dtype=np.float64)
    jwn = np.array([r.get("j_wn", np.nan) for r in kept], dtype=np.float64)
    jh = np.array([r.get("j_h", np.nan) for r in kept], dtype=np.float64)

    j0_ref = trimmed_mean(j0) if j0.size else float("nan")
    jwn_ref = trimmed_mean(jwn) if jwn.size else float("nan")
    jh_ref = trimmed_mean(jh) if jh.size else float("nan")

    def _finite(value: float) -> Optional[float]:
        """None rather than NaN for a statistic with nothing to compute from.

        Excluding every residue -- easy to do now that the hetNOE filter has
        a default -- leaves the trimmed means undefined. NaN is not JSON, so
        returning it crashes the endpoint; None is both serialisable and the
        honest answer, since there is no value rather than an unrepresentable
        one.
        """
        return float(value) if np.isfinite(value) else None

    finite = j0[np.isfinite(j0)]
    if finite.size:
        mad = float(np.median(np.abs(finite - np.median(finite))))
        scale = mad * 1.4826 if mad > 0 else float(np.std(finite))
    else:
        scale = 0.0

    # Recompute only the relative flags; input-derived ones are untouched.
    for row in rows:
        flags = [f for f in (row.get("flags") or []) if f in _INPUT_DERIVED_FLAGS]
        if not row["excluded"] and scale > 0 and np.isfinite(row.get("j0", np.nan)):
            z = (row["j0"] - j0_ref) / scale
            if z > 2.5:
                flags.append("elevated_j0")
            elif z < -2.5:
                flags.append("reduced_j0")
        row["flags"] = flags

    flag_counts: Dict[str, int] = {}
    for row in kept:
        for flag in row["flags"]:
            flag_counts[flag] = flag_counts.get(flag, 0) + 1

    # J is stored in ns/rad; tau_c_from_ratio works on the ratio, which is
    # unit-free, so the scale cancels and only omega_N sets the time unit.
    omega_n = float((payload.get("physics_snapshot") or {}).get("omega_n_rad_s") or 0.0)
    tau_c = tau_c_from_ratio(j0_ref, jwn_ref, omega_n) if omega_n else None

    summary = dict(payload.get("summary", {}))
    summary.update({
        "j0_trimmed_mean": _finite(j0_ref),
        "jwn_trimmed_mean": _finite(jwn_ref),
        "jh_trimmed_mean": _finite(jh_ref),
        "tau_c_estimate_s": tau_c,
        "tau_c_estimate_ns": tau_c * 1e9 if tau_c is not None else None,
        "n_residues": len(kept),
        "n_flagged": sum(1 for r in kept if r["flags"]),
        "n_excluded_by_user": sum(
            1 for r in rows if r["excluded"]
            and EXCLUDED_BY_USER in (r["exclusion_reason"] or "")
        ),
        "n_excluded_by_noe": sum(
            1 for r in rows if r["excluded"]
            and "below threshold" in (r["exclusion_reason"] or "")
        ),
        "noe_threshold": threshold,
        "flag_counts": flag_counts,
        "flag_descriptions": {
            k: FLAG_DESCRIPTIONS[k] for k in flag_counts if k in FLAG_DESCRIPTIONS
        },
    })
    result["summary"] = summary
    result["residues"] = rows
    result["excluded_by_user"] = sorted(wanted)
    return result


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
        "Res #", "Res Name", "Assignment", "Excluded",
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
            _csv_cell("yes" if row.get("excluded") else ""),
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

    excluded = [
        (item.get("residue"), item.get("res_num"), item.get("reason"))
        for item in (payload.get("excluded_residues") or [])
    ] + [
        (row.get("assignment"), row.get("res_num"),
         row.get("exclusion_reason") or EXCLUDED_BY_USER)
        for row in payload.get("residues", []) if row.get("excluded")
    ]
    if excluded:
        lines.append("")
        lines.append("# Excluded residues")
        lines.append("Residue,Res #,Reason")
        for residue, res_num, reason in excluded:
            lines.append(",".join([
                _csv_cell(residue), _csv_cell(res_num), _csv_cell(reason),
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
