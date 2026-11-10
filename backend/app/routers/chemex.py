"""ChemEx library interaction endpoints: method validation, parameter inspection, model catalog.

Everything runs ChemEx against an analysis's own run directory, so routes are
project-scoped and ownership-checked through ``deps.get_analysis``.

Method validation has ONE implementation (``validate_method_for_analysis`` →
``resoflow.chemex_api.roles.validate_method``), served at ``…/methods/validate``;
``…/chemex/validate`` (run pre-flight) is a thin alias over the same service.
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import models, security
from ..routers.analysis import _get_analysis_run_dir
from ..schemas import MethodConfigSchema
from ..services.fitting.chemex_workspace import stage_validation_workspace
from ..services.fitting.method_emitter import MethodConfigModel, emit_method_toml_v2
from ..services.fitting.method_resolution import (
    missing_inputs_message,
    step_timings_with_evaluations,
    validate_method_for_analysis,
)
from ..services.fitting.run_dirs import load_chemex_config
from .deps import get_analysis
from resoflow.chemex_api.session import inspect_parameters
from resoflow.chemex_api.spec import FitJobSpec

router = APIRouter(tags=["chemex"])

ANALYSIS_CHEMEX = "/api/projects/{project_uuid}/analysis/{analysis_uuid}/chemex"


class ChemexValidateRequest(BaseModel):
    """In-memory inputs layered over the analysis's saved files. Paths are never accepted."""

    model: str = "2st"
    parameter_toml: Optional[str] = None
    method_toml: Optional[str] = None
    include: Optional[List[str]] = None
    exclude: Optional[List[str]] = None


class ChemexInspectRequest(BaseModel):
    model: str = "2st"
    parameter_toml: Optional[str] = None
    method_toml: Optional[str] = None
    include: Optional[List[str]] = None


class MethodValidateRequest(BaseModel):
    """The method being edited (structured config, or TOML) plus optional unsaved parameters."""

    model: str = "2st"
    config: Optional[MethodConfigSchema] = None
    method_toml: Optional[str] = None
    toml: Optional[str] = None  # accepted alias of method_toml
    parameter_toml: Optional[str] = None
    include: Optional[List[str]] = None
    exclude: Optional[List[str]] = None
    #: Also report parameter-sharing warnings (costs a second ChemEx session build).
    sharing_warnings: bool = False

#: A method with one empty step: ChemEx's default (baseline roles, all profiles).
DEFAULT_METHOD_TOML = "FORMAT_VERSION = 2\n\n[DEFAULT]\n"


def _chemex_version() -> str:
    try:
        import chemex

        return str(getattr(chemex, "__version__", "unknown"))
    except Exception:
        return "unknown"


@router.get("/api/chemex/models")
def get_chemex_models(
    current_user: models.User = Depends(security.get_current_user),
) -> dict[str, Any]:
    """Return all available ChemEx kinetic models."""
    try:
        from chemex.models.loader import register_kinetic_settings
        import chemex.models.factory as f

        register_kinetic_settings()
        model_names = sorted(f.model_factory.setting_makers_registry.keys())
    except Exception:
        model_names = ["1st", "2st", "2st_eyring", "2st_hd", "3st", "3st_linear", "3st_fork"]

    return {
        "chemex_version": _chemex_version(),
        "method_format": 2,
        "models": model_names,
    }


def _run_dir(analysis: models.Analysis) -> Path:
    return Path(_get_analysis_run_dir(analysis))


def _configured_experiments(analysis: models.Analysis) -> Optional[list]:
    """The experiments a run of this analysis would use (saved config), if recorded."""
    cfg = load_chemex_config(analysis) or {}
    exps = cfg.get("generatedExperiments") or cfg.get("experiments")
    return exps if isinstance(exps, list) and exps else None


def _missing_inputs(spec: FitJobSpec) -> Optional[str]:
    return missing_inputs_message(spec.experiment_files, spec.parameter_files)


@router.post(f"{ANALYSIS_CHEMEX}/validate")
def validate_chemex_inputs(
    req: ChemexValidateRequest,
    analysis: models.Analysis = Depends(get_analysis),
) -> dict[str, Any]:
    """Run pre-flight: alias of ``…/methods/validate`` with sharing warnings.

    Without ``method_toml`` the analysis's saved method (or ChemEx's default plan) is checked.
    """
    method_toml = req.method_toml or _saved_method_toml(analysis) or DEFAULT_METHOD_TOML
    return validate_method_for_analysis(
        _run_dir(analysis),
        method_toml=method_toml,
        model=req.model,
        parameter_toml=req.parameter_toml,
        include=req.include,
        exclude=req.exclude,
        sharing_warnings=True,
        experiments=_configured_experiments(analysis),
    )


def _saved_method_toml(analysis: models.Analysis) -> Optional[str]:
    methods = _run_dir(analysis) / "Methods"
    files = sorted(methods.glob("*.toml")) if methods.is_dir() else []
    return files[0].read_text(encoding="utf-8") if files else None


@router.post(f"{ANALYSIS_CHEMEX}/parameters/inspect")
def inspect_chemex_parameters(
    req: ChemexInspectRequest,
    analysis: models.Analysis = Depends(get_analysis),
) -> dict[str, Any]:
    """Introspect every parameter ChemEx instantiates for the analysis's experiments and model.

    Returns the baseline fit/fix/constrain status per parameter, sharing across
    experiments, and CONDITION_MISMATCH / NEAR_FIELD / ISOLATED warnings.
    """
    with tempfile.TemporaryDirectory() as td:
        spec = stage_validation_workspace(
            _run_dir(analysis),
            Path(td),
            model=req.model,
            parameter_toml=req.parameter_toml,
            method_toml=req.method_toml,
            include=req.include,
            stage_methods=req.method_toml is not None,
            experiments=_configured_experiments(analysis),
        )
        if (missing := _missing_inputs(spec)):
            return {"parameters": [], "warnings": [], "experiments": [], "error": missing}
        try:
            res = inspect_parameters(spec, job_dir=Path(td), include_warnings=True)
        except (Exception, SystemExit) as exc:
            # Expected before experiments exist (e.g. CEST before generation); the UI shows
            # the reason instead of a resolved baseline.
            return {"parameters": [], "warnings": [], "experiments": [], "error": f"{type(exc).__name__}: {exc}"}
        if isinstance(res, dict):
            return res
        return {"parameters": res, "warnings": [], "experiments": []}


@router.post("/api/projects/{project_uuid}/analysis/{analysis_uuid}/methods/validate")
def validate_method_endpoint(
    req: MethodValidateRequest,
    analysis: models.Analysis = Depends(get_analysis),
) -> dict[str, Any]:
    """Validate a method with ChemEx against the analysis's inputs (the single validation path).

    Returns ``{valid, format, errors, warnings, steps, chemex_version, method_toml}``.
    Each error carries ChemEx's location (step, field such as ``ROLES[1].FIT[0]`` /
    ``SEARCH.GRID.AXES`` + index / ``STATISTICS.MC``, and a character span). Each step
    carries the effective role of every concrete parameter after ROLES_FROM and all
    ROLES actions, scoped to its INCLUDE/EXCLUDE, and per-axis search resolution.
    """
    if req.config is not None:
        method_toml = emit_method_toml_v2(MethodConfigModel(**req.config.model_dump()))
    elif (req.method_toml or req.toml) is not None:
        method_toml = req.method_toml if req.method_toml is not None else req.toml
    else:
        raise HTTPException(status_code=422, detail="Provide either config or method_toml.")
    report = validate_method_for_analysis(
        _run_dir(analysis),
        method_toml=method_toml,
        model=req.model,
        parameter_toml=req.parameter_toml,
        include=req.include,
        exclude=req.exclude,
        sharing_warnings=req.sharing_warnings,
        experiments=_configured_experiments(analysis),
    )
    report["method_toml"] = method_toml
    return report


@router.get(f"{ANALYSIS_CHEMEX}/last-run-method")
def get_last_run_method(analysis: models.Analysis = Depends(get_analysis)) -> dict[str, Any]:
    """method.toml used by the last completed run (archived by ChemEx in Output/run_info)."""
    output = _run_dir(analysis) / "Output"
    candidates = [output / "run_info" / "inputs" / "methods"]
    if output.is_dir():  # individual fit mode: Output/<residue>/run_info
        candidates += sorted(d / "run_info" / "inputs" / "methods" for d in output.iterdir() if d.is_dir())
    for methods in candidates:
        files = sorted(methods.glob("*.toml")) if methods.is_dir() else []
        if files:
            return {
                "method_toml": "\n".join(f.read_text(encoding="utf-8") for f in files),
                "completed_at": analysis.completed_at.isoformat() if analysis.completed_at else None,
            }
    return {"method_toml": None, "completed_at": None}


@router.get(f"{ANALYSIS_CHEMEX}/step-timings")
def get_step_timings(analysis: models.Analysis = Depends(get_analysis)) -> dict[str, Any]:
    """Per-step wall-clock durations of the analysis's last ChemEx run, with the number of
    fits each step performed (for runtime / cost estimates of the next run)."""
    model = (load_chemex_config(analysis) or {}).get("model") or "2st"
    return step_timings_with_evaluations(_run_dir(analysis), model=model, experiments=_configured_experiments(analysis))


@router.get(f"{ANALYSIS_CHEMEX}/run-overview")
def get_run_overview(analysis: models.Analysis = Depends(get_analysis)) -> dict[str, Any]:
    """Last completed run, per step (values ± errors, GRID landscape summary, MCMC flags,
    strong correlations, method snapshot), read from the results bundle."""
    from ..services.results_bundle import store
    from ..services.results_bundle.run_overview import ensure_bundle

    run_dir = _run_dir(analysis)
    if not ensure_bundle(run_dir, analysis):
        return {"available": False, "completed_at": None, "overview": None}
    overview = store.get_run_overview(run_dir)
    return {
        "available": overview is not None,
        "completed_at": analysis.completed_at.isoformat() if analysis.completed_at else None,
        "overview": overview,
    }


@router.get(f"{ANALYSIS_CHEMEX}/steps/{{step_name}}/grid-surface")
def get_grid_surface(step_name: str, x: str, y: str, analysis: models.Analysis = Depends(get_analysis)) -> dict[str, Any]:
    """A GRID step's 2D χ² surface for axes x/y, from the results bundle."""
    from ..services.results_bundle import store
    from ..services.results_bundle.run_overview import ensure_bundle

    run_dir = _run_dir(analysis)
    if not ensure_bundle(run_dir, analysis):
        raise HTTPException(status_code=404, detail="No completed run results")
    surface = store.get_grid_surface(run_dir, step_name, x, y)
    if surface is None:
        raise HTTPException(status_code=404, detail=f"No GRID surface for {x}/{y} in step {step_name}")
    return surface
