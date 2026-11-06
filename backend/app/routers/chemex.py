"""ChemEx library interaction endpoints: validation, parameter inspection, and model catalog."""

from __future__ import annotations

import contextlib
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Analysis
from ..routers.analysis import _get_analysis_run_dir
from resoflow.chemex_api.session import inspect_parameters, validate_inputs
from resoflow.chemex_api.spec import FitJobSpec

router = APIRouter(prefix="/api/chemex", tags=["chemex"])


class ChemexValidateRequest(BaseModel):
    analysis_uuid: Optional[str] = None
    project_uuid: Optional[str] = None
    model: str = "2st"
    experiment_files: Optional[List[str]] = None
    parameter_files: Optional[List[str]] = None
    method_files: Optional[List[str]] = None
    parameter_toml: Optional[str] = None
    method_toml: Optional[str] = None
    include: Optional[List[str]] = None
    exclude: Optional[List[str]] = None


class ChemexInspectRequest(BaseModel):
    analysis_uuid: Optional[str] = None
    project_uuid: Optional[str] = None
    model: str = "2st"
    experiment_files: Optional[List[str]] = None
    parameter_files: Optional[List[str]] = None
    method_files: Optional[List[str]] = None
    parameter_toml: Optional[str] = None
    method_toml: Optional[str] = None
    include: Optional[List[str]] = None


@router.get("/models")
def get_chemex_models() -> dict[str, Any]:
    """Return all available ChemEx kinetic models."""
    try:
        from chemex.models.loader import register_kinetic_settings
        import chemex.models.factory as f

        register_kinetic_settings()
        models = sorted(f.model_factory.setting_makers_registry.keys())
    except Exception as exc:
        models = ["1st", "2st", "2st_eyring", "2st_hd", "3st", "3st_linear", "3st_fork"]

    return {
        "chemex_version": "2026.9.2",
        "method_format": 2,
        "models": models,
    }


def _prepare_job_spec(
    req: ChemexValidateRequest | ChemexInspectRequest,
    db: Session,
    temp_dir: Path,
) -> tuple[FitJobSpec, Path]:
    """Resolve files and construct FitJobSpec for validation or inspection."""
    run_dir: Path | None = None
    analysis: Analysis | None = None

    if req.analysis_uuid:
        analysis = db.query(Analysis).filter_by(analysis_uuid=req.analysis_uuid).first()
        if analysis:
            run_dir = Path(_get_analysis_run_dir(analysis))

    # Base directory from which to resolve relative files
    target_dir = temp_dir
    exp_files: list[str] = req.experiment_files or []
    param_files: list[str] = req.parameter_files or []
    method_files: list[str] = req.method_files or []

    base_src = run_dir if (run_dir and run_dir.exists()) else Path.cwd().resolve()

    # Link or copy Experiments and Data from base_src into target_dir
    exp_dir = base_src / "Experiments"
    if exp_dir.exists():
        (target_dir / "Experiments").mkdir(parents=True, exist_ok=True)
        for ef in exp_dir.glob("*.toml"):
            dest = target_dir / "Experiments" / ef.name
            if not dest.exists():
                try:
                    os.symlink(ef, dest)
                except OSError:
                    shutil.copy2(ef, dest)
        if not exp_files:
            exp_files = [f"Experiments/{ef.name}" for ef in sorted((target_dir / "Experiments").glob("*.toml"))]

    data_dir = base_src / "Data"
    if data_dir.exists():
        dest_data = target_dir / "Data"
        if not dest_data.exists():
            try:
                os.symlink(data_dir, dest_data)
            except OSError:
                shutil.copytree(data_dir, dest_data)

    p_dir = base_src / "Parameters"
    if p_dir.exists() and not (target_dir / "Parameters").exists():
        dest_p = target_dir / "Parameters"
        dest_p.mkdir(parents=True, exist_ok=True)
        for pf in p_dir.glob("*.toml"):
            dest = dest_p / pf.name
            if not dest.exists():
                shutil.copy2(pf, dest)
        if not param_files and not req.parameter_toml:
            param_files = [f"Parameters/{pf.name}" for pf in sorted(dest_p.glob("*.toml"))]

    m_dir = base_src / "Methods"
    if m_dir.exists() and not (target_dir / "Methods").exists():
        dest_m = target_dir / "Methods"
        dest_m.mkdir(parents=True, exist_ok=True)
        for mf in m_dir.glob("*.toml"):
            dest = dest_m / mf.name
            if not dest.exists():
                shutil.copy2(mf, dest)
        if not method_files and not req.method_toml:
            method_files = [f"Methods/{mf.name}" for mf in sorted(dest_m.glob("*.toml"))]

    # If raw in-memory parameter_toml is provided, write it to target_dir / "Parameters" / "parameters.toml"
    if req.parameter_toml:
        p_dir = target_dir / "Parameters"
        p_dir.mkdir(parents=True, exist_ok=True)
        p_path = p_dir / "parameters.toml"
        p_path.write_text(req.parameter_toml, encoding="utf-8")
        param_files = ["Parameters/parameters.toml"]

    # If raw in-memory method_toml is provided, write it to target_dir / "Methods" / "method.toml"
    if req.method_toml:
        m_dir = target_dir / "Methods"
        m_dir.mkdir(parents=True, exist_ok=True)
        m_path = m_dir / "method.toml"
        m_path.write_text(req.method_toml, encoding="utf-8")
        method_files = ["Methods/method.toml"]

    spec = FitJobSpec(
        job_id="validation_spec",
        experiment_files=exp_files,
        parameter_files=param_files,
        method_files=method_files,
        model=req.model or "2st",
        include=req.include or [],
        exclude=getattr(req, "exclude", None) or [],
        output_dir="Output",
    )

    return spec, target_dir


@router.post("/validate")
def validate_chemex_inputs(
    req: ChemexValidateRequest,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Validate fit specifications and method plans without starting a fitting run.
    
    Checks syntax, parameter model construction, method selectors, and reports
    errors or sharing warnings.
    """
    with tempfile.TemporaryDirectory() as td:
        spec, job_dir = _prepare_job_spec(req, db, Path(td))
        report = validate_inputs(spec, job_dir=job_dir)
        return report


@router.post("/parameters/inspect")
def inspect_chemex_parameters(
    req: ChemexInspectRequest,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Introspect all parameters instantiated for the given experiments and model.
    
    Returns fit/fix/constrained status per parameter, shared status across experiments,
    and CONDITION_MISMATCH / NEAR_FIELD / ISOLATED sharing warnings.
    """
    with tempfile.TemporaryDirectory() as td:
        spec, job_dir = _prepare_job_spec(req, db, Path(td))
        res = inspect_parameters(spec, job_dir=job_dir, include_warnings=True)
        if isinstance(res, dict):
            return res
        return {"parameters": res, "warnings": [], "experiments": []}
