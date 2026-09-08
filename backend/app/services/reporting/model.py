# backend/app/services/reporting/model.py
"""
Data model and model-builder for resoFlow report generation.
Extracts data assembly, uncertainty resolution, and flag evaluation out of
the rendering layer per WeasyPrint design spec §3.
"""

from __future__ import annotations

import json
import logging
import math
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
import re
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

import numpy as np

from .uncertainty import (
    UncertaintyResolver,
    UncertaintySource,
    ParameterStatus,
    ResolvedParameter,
)
from .kinetics import propagate_derived_kinetics, DerivedKineticResult
from .provenance import (
    extract_report_provenance,
    ReportProvenance,
    DegreeOfFreedomAccounting,
)
from ..fitting.statistics_engine import clean_param_name

logger = logging.getLogger(__name__)


def natural_sort_key(s: str) -> list:
    """Sort residues numerically (e.g. 2N, 14N, 55N, 100N)."""
    return [int(text) if text.isdigit() else text.lower() for text in re.split(r"([0-9]+)", s)]


def is_residue_excluded(
    residue: Any,
    excluded: Optional[Sequence[str]],
    res_num: Optional[int] = None,
) -> bool:
    """
    Check if a residue (string like '10PHE', '15N', or int 10) matches
    any residue in the excluded list.
    """
    if not excluded or residue is None:
        return False

    r_str = str(residue).strip().upper()
    if not r_str:
        return False

    r_digits = "".join(c for c in r_str if c.isdigit())
    r_letters = "".join(c for c in r_str if c.isalpha())

    for ex in excluded:
        if not ex:
            continue
        ex_str = str(ex).strip().upper()
        if not ex_str:
            continue
        if r_str == ex_str:
            return True

        ex_digits = "".join(c for c in ex_str if c.isdigit())
        ex_letters = "".join(c for c in ex_str if c.isalpha())

        if res_num is not None and ex_digits and str(res_num) == ex_digits:
            if not ex_letters or not r_letters or ex_letters == r_letters:
                return True

        if r_digits and ex_digits and r_digits == ex_digits:
            if not r_letters or not ex_letters or r_letters == ex_letters:
                return True

    return False


def is_param_excluded(param_name: str, excluded: Optional[Sequence[str]]) -> bool:
    """
    Check if a parameter name (e.g. '[R2, NUC->10PHE]', 'R2, NUC->10PHE', 'I0, NUC->10PHE')
    is associated with an excluded residue.
    """
    if not excluded or not param_name:
        return False

    p_clean = param_name.strip().strip("[]")
    parts = [x.strip() for x in p_clean.split(",")]
    if not parts:
        return False

    base = parts[0].upper()
    if base in ("KEX_AB", "KEX", "PB", "PA", "KAB", "KBA", "TAUC_A", "TAUC"):
        return False

    # Find NUC-> part or residue part
    res = None
    for part in parts[1:]:
        if part.upper().startswith("NUC->"):
            res = part[5:].strip()
            break
        elif not part.upper().startswith("B0->"):
            res = part.strip()
            break

    if res:
        return is_residue_excluded(res, excluded)

    # Fallback substring check
    upper_param = param_name.upper()
    for ex in excluded:
        if not ex:
            continue
        ex_upper = str(ex).strip().upper()
        if not ex_upper:
            continue
        if f"NUC->{ex_upper}" in upper_param or f", {ex_upper}" in upper_param or f",{ex_upper}" in upper_param:
            return True
        ex_digits = "".join(c for c in ex_upper if c.isdigit())
        if ex_digits and (f"NUC->{ex_digits}" in upper_param or f", {ex_digits}" in upper_param or f",{ex_digits}" in upper_param):
            return True

    return False


def resolved_param_to_dict(p: ResolvedParameter) -> dict[str, Any]:
    """Serialize a ResolvedParameter instance to a JSON-compatible dict."""
    return {
        "name": p.name,
        "scope": p.scope,
        "value": p.value,
        "sigma": p.sigma,
        "err_low": p.err_low,
        "err_high": p.err_high,
        "err_low_95": p.err_low_95,
        "err_high_95": p.err_high_95,
        "source": p.source.value if hasattr(p.source, "value") else str(p.source),
        "status": p.status.value if hasattr(p.status, "value") else str(p.status),
        "unit": p.unit,
        "n_samples": p.n_samples,
        "expression": p.expression,
        "is_near_bound": p.is_near_bound,
        "bound_low": p.bound_low,
        "bound_high": p.bound_high,
        "flag_reason": p.flag_reason,
        "is_asymmetric": p.is_asymmetric,
        "method_name": p.method_name,
    }


def derived_kinetic_to_dict(k: DerivedKineticResult) -> dict[str, Any]:
    """Serialize a DerivedKineticResult instance to a JSON-compatible dict."""
    return {
        "name": k.name,
        "symbol": k.symbol,
        "value": k.value,
        "sigma": k.sigma,
        "err_low": k.err_low,
        "err_high": k.err_high,
        "err_low_95": k.err_low_95,
        "err_high_95": k.err_high_95,
        "unit": k.unit,
        "propagation_method": k.propagation_method,
        "source": k.source.value if hasattr(k.source, "value") else str(k.source),
        "status": k.status.value if hasattr(k.status, "value") else str(k.status),
        "n_samples": k.n_samples,
        "correlation_r": k.correlation_r,
        "expression": k.expression,
    }


def dof_accounting_to_dict(d: DegreeOfFreedomAccounting) -> dict[str, Any]:
    """Serialize a DegreeOfFreedomAccounting instance to a JSON-compatible dict."""
    return {
        "n_data_global": d.n_data_global,
        "n_global_params": d.n_global_params,
        "n_local_params_total": d.n_local_params_total,
        "n_varys_global": d.n_varys_global,
        "dof_global": d.dof_global,
        "chi2_global": d.chi2_global,
        "chi2_red_global": d.chi2_red_global,
        "residue_dofs": to_json_serializable(d.residue_dofs),
        "reconciliation_note": d.reconciliation_note,
    }


def provenance_to_dict(p: ReportProvenance) -> dict[str, Any]:
    """Serialize a ReportProvenance instance to a JSON-compatible dict."""
    return {
        "timestamp_iso": p.timestamp_iso,
        "resoflow_version": p.resoflow_version,
        "git_sha": p.git_sha,
        "chemex_version": p.chemex_version,
        "chemex_image_digest": p.chemex_image_digest,
        "analysis_name": p.analysis_name,
        "analysis_uuid": p.analysis_uuid,
        "analysis_type": p.analysis_type,
        "model_name": p.model_name,
        "minimizer": p.minimizer,
        "convergence_status": p.convergence_status,
        "b0_fields": list(p.b0_fields),
        "temperature_k": p.temperature_k,
        "carrier_ppm": p.carrier_ppm,
        "b1_fields": to_json_serializable(p.b1_fields),
        "input_files": to_json_serializable(p.input_files),
        "dof_accounting": dof_accounting_to_dict(p.dof_accounting),
        "delta_omega_convention": p.delta_omega_convention,
        "uncertainty_sources_used": list(p.uncertainty_sources_used),
        "has_statistics_runs": p.has_statistics_runs,
        "warnings": list(p.warnings),
    }


def to_json_serializable(obj: Any) -> Any:
    """Recursively convert data structures to plain JSON-serializable types."""
    if obj is None:
        return None
    if isinstance(obj, (str, int, bool)):
        return obj
    if isinstance(obj, (float, np.floating)):
        return None if (math.isnan(obj) or math.isinf(obj)) else float(obj)
    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, np.bool_):
        return bool(obj)
    if isinstance(obj, np.ndarray):
        return [to_json_serializable(x) for x in obj.tolist()]
    if isinstance(obj, Enum):
        return obj.value
    if isinstance(obj, Path):
        return obj.name
    if isinstance(obj, ResidueRecord):
        return obj.to_dict()
    if isinstance(obj, ResolvedParameter):
        return resolved_param_to_dict(obj)
    if isinstance(obj, DerivedKineticResult):
        return derived_kinetic_to_dict(obj)
    if isinstance(obj, ReportProvenance):
        return provenance_to_dict(obj)
    if isinstance(obj, DegreeOfFreedomAccounting):
        return dof_accounting_to_dict(obj)
    if hasattr(obj, "to_dict") and callable(obj.to_dict):
        return obj.to_dict()
    if isinstance(obj, dict):
        return {str(k): to_json_serializable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set)):
        return [to_json_serializable(x) for x in obj]
    return str(obj)


@dataclass
class ResidueRecord:
    """Residue-level resolved parameters, quality flags, and metadata."""
    raw_key: str
    display_name: str
    chi2_red: float | None
    dw: ResolvedParameter
    r1a: ResolvedParameter
    r2a: ResolvedParameter
    r2b: ResolvedParameter
    csa: ResolvedParameter
    csb: ResolvedParameter
    flags: list[str]
    experiments: list[dict]
    step_name: Optional[str] = None
    rate: Optional[ResolvedParameter] = None
    amplitude: Optional[ResolvedParameter] = None
    decay_curve_data: Optional[dict] = None
    res_num: Optional[int] = None
    res_name: Optional[str] = None
    rmse: Optional[float] = None

    @property
    def has_flags(self) -> bool:
        return bool(self.flags)

    @property
    def anchor(self) -> str:
        prefix = f"res-{self.step_name}-" if self.step_name else "res-"
        return prefix + re.sub(r"[^A-Za-z0-9]", "-", self.raw_key)

    def __getitem__(self, key: str) -> Any:
        """Allow backward-compatible dictionary-style access."""
        if hasattr(self, key):
            return getattr(self, key)
        raise KeyError(key)

    def __contains__(self, key: str) -> bool:
        return hasattr(self, key)

    def get(self, key: str, default: Any = None) -> Any:
        return getattr(self, key, default)

    def to_dict(self) -> dict[str, Any]:
        d = {
            "raw_key": self.raw_key,
            "display_name": self.display_name,
            "chi2_red": self.chi2_red,
            "dw": resolved_param_to_dict(self.dw),
            "r1a": resolved_param_to_dict(self.r1a),
            "r2a": resolved_param_to_dict(self.r2a),
            "r2b": resolved_param_to_dict(self.r2b),
            "csa": resolved_param_to_dict(self.csa),
            "csb": resolved_param_to_dict(self.csb),
            "flags": list(self.flags),
            "has_flags": self.has_flags,
            "anchor": self.anchor,
            "experiments": to_json_serializable(self.experiments),
        }
        if self.step_name is not None:
            d["step_name"] = self.step_name
        if self.rate is not None:
            d["rate"] = resolved_param_to_dict(self.rate)
        if self.amplitude is not None:
            d["amplitude"] = resolved_param_to_dict(self.amplitude)
        if self.res_num is not None:
            d["res_num"] = self.res_num
        if self.res_name is not None:
            d["res_name"] = self.res_name
        if self.rmse is not None:
            d["rmse"] = self.rmse
        if self.decay_curve_data is not None:
            d["decay_curve_data"] = to_json_serializable(self.decay_curve_data)
        return d


@dataclass
class StepReportModel:
    """Step-level report model representing an individual fitting step in a multi-step pipeline."""
    step_name: str
    step_index: int
    status: str
    has_grid: bool
    has_statistics: bool
    global_params: list[tuple[str, ResolvedParameter]]
    derived_kinetics: dict[str, DerivedKineticResult]
    residues: list[ResidueRecord]
    dof_info: Optional[DegreeOfFreedomAccounting]
    resampled: dict[str, dict]
    grid_1d: dict
    grid_2d: Optional[Any] = None
    ledger: dict[str, int] = field(default_factory=dict)
    excluded_residues: Optional[list[str]] = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "step_name": self.step_name,
            "step_index": self.step_index,
            "status": self.status,
            "has_grid": self.has_grid,
            "has_statistics": self.has_statistics,
            "global_params": [
                [name, resolved_param_to_dict(param)]
                for name, param in self.global_params
            ],
            "derived_kinetics": {k: derived_kinetic_to_dict(v) for k, v in self.derived_kinetics.items()},
            "residues": [r.to_dict() for r in self.residues],
            "dof_info": dof_accounting_to_dict(self.dof_info) if self.dof_info else None,
            "resampled": to_json_serializable(self.resampled),
            "grid_1d": to_json_serializable(self.grid_1d),
            "ledger": dict(self.ledger),
            **({"excluded_residues": list(self.excluded_residues)}
               if self.excluded_residues is not None else {}),
        }


@dataclass
class ReportModel:
    """Unified report data model separating data assembly from rendering."""
    analysis_name: str
    analysis_type: str
    analysis_dir: Path
    results: dict
    provenance: ReportProvenance
    derived_kinetics: dict[str, DerivedKineticResult]
    residues: list[ResidueRecord]
    global_params: list[tuple[str, ResolvedParameter]]
    resampled: dict[str, dict]
    grid_1d: dict
    ledger: dict[str, int]
    is_multi_step: bool = False
    step_order: list[str] = field(default_factory=list)
    steps: list[StepReportModel] = field(default_factory=list)
    grid_2d: Optional[Any] = None
    sequence_summary: Optional[Dict[str, Any]] = None
    excluded_residues: Optional[list[str]] = None
    spectral_density: Optional[Dict[str, Any]] = None

    def to_dict(self) -> dict[str, Any]:
        """Convert model to plain JSON-serializable types for API and golden tests."""
        d = {
            "analysis_name": self.analysis_name,
            "analysis_type": self.analysis_type,
            "analysis_dir": self.analysis_dir.name,
            "results": to_json_serializable(self.results),
            "provenance": provenance_to_dict(self.provenance),
            "derived_kinetics": {k: derived_kinetic_to_dict(v) for k, v in self.derived_kinetics.items()},
            "residues": [r.to_dict() for r in self.residues],
            "global_params": [
                [name, resolved_param_to_dict(param)]
                for name, param in self.global_params
            ],
            "resampled": to_json_serializable(self.resampled),
            "grid_1d": to_json_serializable(self.grid_1d),
            "ledger": dict(self.ledger),
        }
        if self.excluded_residues is not None:
            d["excluded_residues"] = list(self.excluded_residues)
        if self.sequence_summary is not None:
            d["sequence_summary"] = to_json_serializable(self.sequence_summary)
        if self.spectral_density is not None:
            d["spectral_density"] = to_json_serializable(self.spectral_density)
        if self.is_multi_step:
            d["is_multi_step"] = True
            d["step_order"] = list(self.step_order)
            d["steps"] = [s.to_dict() for s in self.steps]
        return d


def build_report_model(
    analysis_dir: Union[str, Path],
    analysis_name: str,
    analysis_type: str = "CEST",
    chemex_image_digest: Optional[str] = None,
    fixed_timestamp: Optional[str] = None,
    excluded_residues: Optional[Sequence[str]] = None,
) -> ReportModel:
    """
    Build the canonical ReportModel from an analysis output directory.
    
    Performs data assembly, uncertainty resolution, derived kinetics propagation,
    residue flag indexing, and pre-render validation. Raises RuntimeError early if
    resampling statistics artifacts exist but 0 parameters resolve to them.
    """
    a_dir = Path(analysis_dir)
    a_type = analysis_type.upper()

    # 1. Load results.json
    results_data: Dict[str, Any] = {}
    res_file = a_dir / "results.json"
    if res_file.is_file():
        try:
            results_data = json.loads(res_file.read_text(encoding="utf-8"))
        except Exception as exc:
            logger.warning("Could not read results.json: %s", exc)

    # 2. Load residue mapping from configuration (cpmg_config.json then config.json)
    residue_mapping: Dict[str, str] = {}
    for cfg_name in ["cpmg_config.json", "config.json"]:
        cfg_p = a_dir / cfg_name
        if cfg_p.is_file():
            try:
                c_data = json.loads(cfg_p.read_text(encoding="utf-8"))
                residue_mapping = c_data.get("residue_mapping", {})
                break
            except Exception:
                pass

    # 2b. Load excluded residues if not explicitly passed
    if excluded_residues is None:
        for cfg_name in ["cpmg_config.json", "config.json", "relaxation_config.json"]:
            cfg_p = a_dir / cfg_name
            if cfg_p.is_file():
                try:
                    c_data = json.loads(cfg_p.read_text(encoding="utf-8"))
                    ex_cfg = c_data.get("excluded_residues") or c_data.get("excludedResidues")
                    if ex_cfg:
                        excluded_residues = ex_cfg
                        break
                except Exception:
                    pass
        if excluded_residues is None and results_data:
            excluded_residues = results_data.get("excluded_residues") or results_data.get("excludedResidues")

    # 3. Initialize UncertaintyResolver
    resolver = UncertaintyResolver(a_dir, results_data=results_data)

    is_relaxation = a_type in ("R1", "R2", "HETNOE")
    is_sdm = a_type == "SDM"
    sequence_summary: Optional[Dict[str, Any]] = None
    spectral_density: Optional[Dict[str, Any]] = None

    if is_sdm:
        # Spectral density results are already reduced per residue, so there
        # is nothing to resolve out of a ChemEx statistics tree; the payload
        # written by the mapper is carried through intact and the residue
        # records exist so the shared index/summary machinery still works.
        global_params: list[tuple[str, ResolvedParameter]] = []
        derived_kinetics: dict[str, DerivedKineticResult] = {}
        residue_records: list[ResidueRecord] = []
        spectral_density = results_data

        not_in_mod_tpl = dict(value=None, status=ParameterStatus.NOT_IN_MODEL)
        for row in results_data.get("residues", []):
            raw_key = str(row.get("assignment", ""))
            if is_residue_excluded(raw_key, excluded_residues, res_num=row.get("res_num")):
                continue
            # J(0) stands in as "the rate" so the shared sequence plot and
            # index table render without special-casing.
            j0 = ResolvedParameter(
                name="J0",
                scope=raw_key,
                value=row.get("j0"),
                err_low=row.get("j0_err", 0.0),
                err_high=row.get("j0_err", 0.0),
                source=UncertaintySource.COVARIANCE,
                status=ParameterStatus.FITTED,
                unit="ns rad⁻¹",
            )
            nim = ResolvedParameter(name="none", scope=raw_key, **not_in_mod_tpl)
            residue_records.append(ResidueRecord(
                raw_key=raw_key,
                display_name=residue_mapping.get(raw_key, raw_key),
                chi2_red=None,
                dw=nim, r1a=nim, r2a=nim, r2b=nim, csa=nim, csb=nim,
                flags=list(row.get("flags") or []),
                experiments=[],
                rate=j0,
                amplitude=nim,
                res_num=row.get("res_num"),
                res_name=row.get("res_name"),
            ))
        residue_records.sort(key=lambda r: natural_sort_key(r.raw_key))

        summary = results_data.get("summary", {})
        sequence_summary = {
            "n_residues": len(residue_records),
            "mean_rate": summary.get("j0_trimmed_mean"),
            "sd_rate": 0.0,
            "median_rate": summary.get("j0_trimmed_mean"),
            "mean_sigma": None,
            "min_rate": None,
            "max_rate": None,
            "mean_chi2_red": None,
            "mean_rmse": None,
            "noise_model": "propagated",
            "uncertainty_method": results_data.get("error_method", "analytic"),
        }
    elif is_relaxation:
        global_params: list[tuple[str, ResolvedParameter]] = []
        derived_kinetics: dict[str, DerivedKineticResult] = {}
        peak_results = results_data.get("peak_results", [])
        residue_records: list[ResidueRecord] = []
        rate_param = "noe" if a_type == "HETNOE" else ("r1" if a_type == "R1" else "r2")

        for p in peak_results:
            raw_key = str(p.get("assignment", f"Peak_{p.get('res_num', '?')}"))
            if is_residue_excluded(raw_key, excluded_residues, res_num=p.get("res_num")):
                continue
            display_name = residue_mapping.get(raw_key, raw_key)
            chi2_red = p.get("redchi")

            rate_res = resolver.resolve(rate_param, raw_key)
            amp_res = resolver.resolve("i0", raw_key)

            if rate_res.value is None and p.get("rate") is not None:
                rate_val = float(p["rate"])
                rate_err = float(p.get("rate_err", 0.0))
                rate_res = ResolvedParameter(
                    name=rate_param.upper(),
                    scope=raw_key,
                    value=rate_val,
                    err_low=rate_err,
                    err_high=rate_err,
                    source=UncertaintySource.COVARIANCE,
                    status=ParameterStatus.FITTED,
                    unit="s⁻¹" if a_type != "HETNOE" else "",
                )
            if amp_res.value is None and p.get("amplitude") is not None:
                amp_val = float(p["amplitude"])
                amp_err = float(p.get("amplitude_err", 0.0))
                amp_res = ResolvedParameter(
                    name="I0",
                    scope=raw_key,
                    value=amp_val,
                    err_low=amp_err,
                    err_high=amp_err,
                    source=UncertaintySource.COVARIANCE,
                    status=ParameterStatus.FITTED,
                    unit="a.u.",
                )

            flags = []
            if chi2_red is not None and (chi2_red < 0.5 or chi2_red > 2.0):
                flags.append(f"χ²ᵣ={chi2_red:.2f}")
            if rate_res.sigma and rate_res.value and abs(rate_res.value) > 1e-4:
                if (rate_res.sigma / abs(rate_res.value)) > 0.4:
                    flags.append("High Rate err")

            decay_data = {
                "times": p.get("times", []),
                "intensities": p.get("intensities", []),
                "intensities_err": p.get("intensities_err", []),
                "fit_times_dense": p.get("fit_times_dense", []),
                "fit_intensities_dense": p.get("fit_intensities_dense", []),
                "fit_intensities_lower_68": p.get("fit_intensities_lower_68", []),
                "fit_intensities_upper_68": p.get("fit_intensities_upper_68", []),
                "fit_intensities_lower_95": p.get("fit_intensities_lower_95", []),
                "fit_intensities_upper_95": p.get("fit_intensities_upper_95", []),
                "residuals": p.get("residuals", []),
            }

            not_in_mod = ResolvedParameter(name="none", scope=raw_key, value=None, status=ParameterStatus.NOT_IN_MODEL)
            record = ResidueRecord(
                raw_key=raw_key,
                display_name=display_name,
                chi2_red=chi2_red,
                dw=not_in_mod,
                r1a=rate_res if a_type == "R1" else not_in_mod,
                r2a=rate_res if a_type == "R2" else not_in_mod,
                r2b=not_in_mod,
                csa=not_in_mod,
                csb=not_in_mod,
                flags=flags,
                experiments=[],
                rate=rate_res,
                amplitude=amp_res,
                decay_curve_data=decay_data,
                res_num=p.get("res_num"),
                res_name=p.get("res_name"),
                rmse=p.get("rmse"),
            )
            residue_records.append(record)

        residue_records.sort(key=lambda r: natural_sort_key(r.raw_key))

        rates = [r.rate.value for r in residue_records if r.rate and r.rate.value is not None]
        errors = [r.rate.sigma for r in residue_records if r.rate and r.rate.sigma is not None]
        chi2s = [r.chi2_red for r in residue_records if r.chi2_red is not None]
        rmses = [r.rmse for r in residue_records if r.rmse is not None]

        sequence_summary = {
            "n_residues": len(residue_records),
            "mean_rate": float(np.mean(rates)) if rates else None,
            "sd_rate": float(np.std(rates, ddof=1)) if len(rates) > 1 else 0.0,
            "median_rate": float(np.median(rates)) if rates else None,
            "mean_sigma": float(np.mean(errors)) if errors else None,
            "min_rate": float(np.min(rates)) if rates else None,
            "max_rate": float(np.max(rates)) if rates else None,
            "mean_chi2_red": float(np.mean(chi2s)) if chi2s else None,
            "mean_rmse": float(np.mean(rmses)) if rmses else None,
            "noise_model": results_data.get("noise_model", "lineshape"),
            "uncertainty_method": results_data.get("uncertainty_method", "covariance"),
        }
    else:
        # 4. Resolve global parameters
        kex_res = resolver.resolve("kex_ab", "global")
        pb_res = resolver.resolve("pb", "global")
        tauc_res = resolver.resolve("tauc_a", "global")

        global_params: list[tuple[str, ResolvedParameter]] = [
            ("kex_ab", kex_res),
            ("pb", pb_res),
        ]
        if tauc_res.status != ParameterStatus.NOT_IN_MODEL:
            global_params.append(("tauc_a", tauc_res))

        # 5. Derived Kinetics (Phase 7)
        kex_samples = None
        pb_samples = None
        for sm_dict in resolver.resampled_cache.values():
            p_names = [clean_param_name(x).upper() for x in sm_dict.get("parameter_names", [])]
            reps = sm_dict.get("replicates")
            if reps is not None and "KEX_AB" in p_names and "PB" in p_names:
                kex_samples = reps[:, p_names.index("KEX_AB")]
                pb_samples = reps[:, p_names.index("PB")]
                break

        derived_kinetics = propagate_derived_kinetics(
            kex_val=kex_res.value,
            pb_val=(pb_res.value / 100.0 if (pb_res.value and pb_res.unit == "%") else pb_res.value),
            kex_sigma=kex_res.sigma,
            pb_sigma=((pb_res.sigma / 100.0 if pb_res.sigma else None) if (pb_res.unit == "%") else pb_res.sigma),
            samples={"kex": kex_samples, "pb": pb_samples} if (kex_samples is not None and pb_samples is not None) else None,
        )

        # 6. Index and classify all residues and flags (Phase 5c)
        raw_residues = results_data.get("residues", {})
        if not raw_residues and resolver.primary_step and resolver.primary_step.residues:
            raw_residues = {r_k: {"parameters": {}} for r_k in resolver.primary_step.residues.keys()}

        sorted_keys = sorted(raw_residues.keys(), key=natural_sort_key)
        residue_records: list[ResidueRecord] = []

        for raw_key in sorted_keys:
            if is_residue_excluded(raw_key, excluded_residues):
                continue
            display_name = residue_mapping.get(raw_key, raw_key)
            r_data = raw_residues[raw_key]
            params = r_data.get("parameters", {})

            # Resolve parameters with uncertainties
            dw_res = resolver.resolve("dw_ab", raw_key)
            r1a_res = resolver.resolve("r1_a", raw_key)
            r2a_res = resolver.resolve("r2_a", raw_key)
            r2b_res = resolver.resolve("r2_b", raw_key)
            csa_res = resolver.resolve("cs_a", raw_key)
            csb_res = resolver.resolve("cs_b", raw_key)

            chi2_red = params.get("chi2_red")
            if chi2_red is None and r_data.get("chi2_red") is not None:
                chi2_red = r_data.get("chi2_red")

            flags: list[str] = []
            if chi2_red is not None and (chi2_red < 0.5 or chi2_red > 2.0):
                flags.append(f"χ²ᵣ={chi2_red:.2f}")

            if dw_res.is_near_bound or r2a_res.is_near_bound or r2b_res.is_near_bound:
                flags.append("At Bound")

            if dw_res.source == UncertaintySource.NONE and dw_res.status == ParameterStatus.FITTED:
                flags.append("No Δω err")

            if dw_res.value and dw_res.sigma and abs(dw_res.value) > 1e-4:
                if (dw_res.sigma / abs(dw_res.value)) > 0.5:
                    flags.append("High Δω err")

            record = ResidueRecord(
                raw_key=raw_key,
                display_name=display_name,
                chi2_red=chi2_red,
                dw=dw_res,
                r1a=r1a_res,
                r2a=r2a_res,
                r2b=r2b_res,
                csa=csa_res,
                csb=csb_res,
                flags=flags,
                experiments=r_data.get("experiments", []),
            )
            residue_records.append(record)

    # 7. Finalize ledger and enforce loud failure guard
    ledger_summary = resolver.get_ledger_summary()
    has_stats_runs = len(resolver.resampled_cache) > 0

    if has_stats_runs and len(residue_records) > 0 and ledger_summary.get(UncertaintySource.RESAMPLED.value, 0) == 0:
        raise RuntimeError(
            "Resampling statistics artifacts were found on disk, but zero parameters "
            "resolved to them. Failing loud to prevent silent degradation."
        )

    # 8. Extract provenance record with finalized ledger
    provenance: ReportProvenance = extract_report_provenance(
        a_dir,
        analysis_name=analysis_name,
        analysis_type=a_type,
        chemex_image_digest=chemex_image_digest,
        results_json=results_data,
        fixed_timestamp=fixed_timestamp,
        uncertainty_ledger_summary=ledger_summary,
        has_statistics_runs=has_stats_runs,
    )

    # Update provenance uncertainty_sources_used explicitly
    uncertainty_sources_used: list[str] = []
    if ledger_summary.get("GRID", 0) > 0:
        uncertainty_sources_used.append("GRID")
    if ledger_summary.get("RESAMPLED", 0) > 0:
        uncertainty_sources_used.append("RESAMPLED")
    if ledger_summary.get("COVARIANCE", 0) > 0:
        uncertainty_sources_used.append("COVARIANCE")
    if not uncertainty_sources_used:
        uncertainty_sources_used.append("COVARIANCE")
    provenance.uncertainty_sources_used = uncertainty_sources_used

    # 9. Multi-step pipeline processing (§3 WeasyPrint design spec)
    is_multi_step = bool(resolver.run_result and resolver.run_result.is_multi_step)
    step_order = list(resolver.run_result.step_order) if (resolver.run_result and is_multi_step) else []
    step_models: list[StepReportModel] = []

    if is_multi_step and step_order:
        for s_idx, sname in enumerate(step_order):
            s_res = resolver.run_result.steps.get(sname)
            s_resolver = UncertaintyResolver(a_dir, step_name=sname)

            # Step global parameters
            s_kex = s_resolver.resolve("kex_ab", "global")
            s_pb = s_resolver.resolve("pb", "global")
            s_tauc = s_resolver.resolve("tauc_a", "global")
            s_globals: list[tuple[str, ResolvedParameter]] = [
                ("kex_ab", s_kex),
                ("pb", s_pb),
            ]
            if s_tauc.status != ParameterStatus.NOT_IN_MODEL:
                s_globals.append(("tauc_a", s_tauc))

            # Step derived kinetics
            s_kex_samples = None
            s_pb_samples = None
            for sm_dict in s_resolver.resampled_cache.values():
                p_names = [clean_param_name(x).upper() for x in sm_dict.get("parameter_names", [])]
                reps = sm_dict.get("replicates")
                if reps is not None and "KEX_AB" in p_names and "PB" in p_names:
                    s_kex_samples = reps[:, p_names.index("KEX_AB")]
                    s_pb_samples = reps[:, p_names.index("PB")]
                    break

            s_derived = propagate_derived_kinetics(
                kex_val=s_kex.value,
                pb_val=(s_pb.value / 100.0 if (s_pb.value and s_pb.unit == "%") else s_pb.value),
                kex_sigma=s_kex.sigma,
                pb_sigma=((s_pb.sigma / 100.0 if s_pb.sigma else None) if (s_pb.unit == "%") else s_pb.sigma),
                samples={"kex": s_kex_samples, "pb": s_pb_samples} if (s_kex_samples is not None and s_pb_samples is not None) else None,
            )

            # Step residues
            s_raw_residues: dict[str, Any] = {}
            if s_res and s_res.residues:
                for r_k, s_rmodel in s_res.residues.items():
                    s_raw_residues[r_k] = {
                        "parameters": {
                            "chi2_red": s_rmodel.chi2_red,
                        },
                        "chi2_red": s_rmodel.chi2_red,
                        "experiments": s_rmodel.experiments,
                    }
            elif results_data.get("residues"):
                s_raw_residues = results_data["residues"]

            s_sorted_keys = sorted(s_raw_residues.keys(), key=natural_sort_key)
            s_residue_records: list[ResidueRecord] = []

            for raw_key in s_sorted_keys:
                if is_residue_excluded(raw_key, excluded_residues):
                    continue
                display_name = residue_mapping.get(raw_key, raw_key)
                r_data = s_raw_residues[raw_key]
                params = r_data.get("parameters", {})

                dw_res = s_resolver.resolve("dw_ab", raw_key)
                r1a_res = s_resolver.resolve("r1_a", raw_key)
                r2a_res = s_resolver.resolve("r2_a", raw_key)
                r2b_res = s_resolver.resolve("r2_b", raw_key)
                csa_res = s_resolver.resolve("cs_a", raw_key)
                csb_res = s_resolver.resolve("cs_b", raw_key)

                chi2_red = params.get("chi2_red")
                if chi2_red is None and r_data.get("chi2_red") is not None:
                    chi2_red = r_data.get("chi2_red")

                flags: list[str] = []
                if chi2_red is not None and (chi2_red < 0.5 or chi2_red > 2.0):
                    flags.append(f"χ²ᵣ={chi2_red:.2f}")

                if dw_res.is_near_bound or r2a_res.is_near_bound or r2b_res.is_near_bound:
                    flags.append("At Bound")

                if dw_res.source == UncertaintySource.NONE and dw_res.status == ParameterStatus.FITTED:
                    flags.append("No Δω err")

                if dw_res.value and dw_res.sigma and abs(dw_res.value) > 1e-4:
                    if (dw_res.sigma / abs(dw_res.value)) > 0.5:
                        flags.append("High Δω err")

                s_rec = ResidueRecord(
                    raw_key=raw_key,
                    display_name=display_name,
                    chi2_red=chi2_red,
                    dw=dw_res,
                    r1a=r1a_res,
                    r2a=r2a_res,
                    r2b=r2b_res,
                    csa=csa_res,
                    csb=csb_res,
                    flags=flags,
                    experiments=r_data.get("experiments", []),
                    step_name=sname,
                )
                s_residue_records.append(s_rec)

            # Degree of freedom accounting for step
            s_dof = None
            if s_res and getattr(s_res, "dof_info", None):
                s_dof = s_res.dof_info
            elif s_res and getattr(s_res, "statistics", None):
                st = s_res.statistics
                nd = st.ndata or 0
                nv = st.nvarys or 0
                s_dof = DegreeOfFreedomAccounting(
                    n_data_global=nd,
                    n_global_params=0,
                    n_local_params_total=0,
                    n_varys_global=nv,
                    dof_global=max(0, nd - nv),
                    chi2_global=st.chisqr or 0.0,
                    chi2_red_global=st.redchi or 0.0,
                    residue_dofs={},
                    reconciliation_note=f"Step {sname} goodness of fit",
                )

            s_ledger = s_resolver.get_ledger_summary()

            step_models.append(
                StepReportModel(
                    step_name=sname,
                    step_index=s_idx + 1,
                    status=s_res.status if s_res else "complete",
                    has_grid=s_res.has_grid if s_res else False,
                    has_statistics=s_res.has_statistics if s_res else False,
                    global_params=s_globals,
                    derived_kinetics=s_derived,
                    residues=s_residue_records,
                    dof_info=s_dof,
                    resampled=s_resolver.resampled_cache,
                    grid_1d=s_resolver.grid_1d_cache,
                    grid_2d=s_resolver.grid_2d_cache,
                    ledger=s_ledger,
                    excluded_residues=list(excluded_residues) if excluded_residues else None,
                )
            )

    return ReportModel(
        analysis_name=analysis_name,
        analysis_type=a_type,
        analysis_dir=a_dir,
        results=results_data,
        provenance=provenance,
        derived_kinetics=derived_kinetics,
        residues=residue_records,
        global_params=global_params,
        resampled=resolver.resampled_cache,
        grid_1d=resolver.grid_1d_cache,
        ledger=ledger_summary,
        is_multi_step=is_multi_step,
        step_order=step_order,
        steps=step_models,
        grid_2d=resolver.grid_2d_cache,
        sequence_summary=sequence_summary,
        excluded_residues=list(excluded_residues) if excluded_residues else None,
        spectral_density=spectral_density,
    )
