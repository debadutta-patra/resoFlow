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
from typing import Any, Dict, List, Optional, Tuple, Union

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

    @property
    def has_flags(self) -> bool:
        return bool(self.flags)

    @property
    def anchor(self) -> str:
        return "res-" + re.sub(r"[^A-Za-z0-9]", "-", self.raw_key)

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
        return {
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

    def to_dict(self) -> dict[str, Any]:
        """Convert model to plain JSON-serializable types for API and golden tests."""
        return {
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


def build_report_model(
    analysis_dir: Union[str, Path],
    analysis_name: str,
    analysis_type: str = "CEST",
    chemex_image_digest: Optional[str] = None,
    fixed_timestamp: Optional[str] = None,
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

    # 3. Initialize UncertaintyResolver
    resolver = UncertaintyResolver(a_dir, results_data=results_data)

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

    if has_stats_runs and ledger_summary.get(UncertaintySource.RESAMPLED.value, 0) == 0:
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
    )
