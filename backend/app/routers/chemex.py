"""ChemEx library interaction endpoints: validation, parameter inspection, and model catalog.

Validation and inspection run ChemEx against an analysis's own run directory, so
they are project-scoped and ownership-checked through ``deps.get_analysis``.
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any, List, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from .. import models, security
from ..routers.analysis import _get_analysis_run_dir
from ..services.fitting.chemex_workspace import stage_validation_workspace
from .deps import get_analysis
from resoflow.chemex_api.session import inspect_parameters, validate_inputs
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


def _missing_inputs(spec: FitJobSpec) -> Optional[str]:
    """ChemEx's CLI parser exits (SystemExit) without these; report it plainly instead."""
    if not spec.experiment_files:
        return "No experiment files for this analysis yet. Generate the experiments first."
    if not spec.parameter_files:
        return "No parameters file for this analysis yet."
    return None


@router.post(f"{ANALYSIS_CHEMEX}/validate")
def validate_chemex_inputs(
    req: ChemexValidateRequest,
    analysis: models.Analysis = Depends(get_analysis),
) -> dict[str, Any]:
    """Validate the analysis inputs and method plan with ChemEx without starting a run."""
    with tempfile.TemporaryDirectory() as td:
        spec = stage_validation_workspace(
            _run_dir(analysis),
            Path(td),
            model=req.model,
            parameter_toml=req.parameter_toml,
            method_toml=req.method_toml,
            include=req.include,
            exclude=req.exclude,
        )
        if (missing := _missing_inputs(spec)):
            return {"valid": False, "errors": [{"message": missing, "type": "MissingInputs"}], "warnings": []}
        try:
            return validate_inputs(spec, job_dir=Path(td))
        except SystemExit as exc:  # argparse inside ChemEx
            return {"valid": False, "errors": [{"message": f"ChemEx rejected the inputs (exit {exc.code}).", "type": "SystemExit"}], "warnings": []}


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
