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

    # 1. Experiments: check both 'Experiments' and 'experiments' in base_src
    dest_exp = target_dir / "Experiments"
    dest_exp_lower = target_dir / "experiments"
    dest_exp.mkdir(parents=True, exist_ok=True)

    for exp_dir_name in ("Experiments", "experiments"):
        exp_src = base_src / exp_dir_name
        if exp_src.exists() and exp_src.is_dir():
            for ef in exp_src.glob("*.toml"):
                dest = dest_exp / ef.name
                if not dest.exists():
                    try:
                        os.symlink(ef.resolve(), dest)
                    except OSError:
                        shutil.copy2(ef, dest)

    if not dest_exp_lower.exists():
        try:
            os.symlink("Experiments", dest_exp_lower)
        except OSError:
            pass

    if not exp_files:
        exp_files = [f"Experiments/{ef.name}" for ef in sorted(dest_exp.glob("*.toml"))]

    # 2. Data: support both 'Data' and 'data' directories, with cross-casing linking
    dest_Data = target_dir / "Data"
    dest_data = target_dir / "data"

    src_Data = base_src / "Data"
    src_data = base_src / "data"

    has_src_Data = src_Data.exists() and src_Data.is_dir()
    has_src_data = src_data.exists() and src_data.is_dir()

    if has_src_Data and has_src_data:
        if src_Data.resolve() == src_data.resolve():
            try:
                os.symlink(src_Data.resolve(), dest_Data)
            except OSError:
                shutil.copytree(src_Data, dest_Data)
            if not dest_data.exists():
                try:
                    os.symlink("Data", dest_data)
                except OSError:
                    pass
        else:
            dest_Data.mkdir(parents=True, exist_ok=True)
            for item in src_Data.iterdir():
                dest = dest_Data / item.name
                if not dest.exists():
                    try:
                        os.symlink(item.resolve(), dest)
                    except OSError:
                        if item.is_dir():
                            shutil.copytree(item, dest)
                        else:
                            shutil.copy2(item, dest)

            dest_data.mkdir(parents=True, exist_ok=True)
            for item in src_data.iterdir():
                dest = dest_data / item.name
                if not dest.exists():
                    try:
                        os.symlink(item.resolve(), dest)
                    except OSError:
                        if item.is_dir():
                            shutil.copytree(item, dest)
                        else:
                            shutil.copy2(item, dest)

            for item in dest_data.iterdir():
                target = dest_Data / item.name
                if not target.exists():
                    try:
                        os.symlink(f"../data/{item.name}", target)
                    except OSError:
                        pass

            for item in dest_Data.iterdir():
                target = dest_data / item.name
                if not target.exists():
                    try:
                        os.symlink(f"../Data/{item.name}", target)
                    except OSError:
                        pass
    elif has_src_Data:
        try:
            os.symlink(src_Data.resolve(), dest_Data)
        except OSError:
            shutil.copytree(src_Data, dest_Data)
        if not dest_data.exists():
            try:
                os.symlink("Data", dest_data)
            except OSError:
                pass
    elif has_src_data:
        try:
            os.symlink(src_data.resolve(), dest_data)
        except OSError:
            shutil.copytree(src_data, dest_data)
        if not dest_Data.exists():
            try:
                os.symlink("data", dest_Data)
            except OSError:
                pass

    # 3. Parameters: check both 'Parameters' and 'parameters' in base_src
    dest_p = target_dir / "Parameters"
    dest_p_lower = target_dir / "parameters"
    dest_p.mkdir(parents=True, exist_ok=True)

    for p_name in ("Parameters", "parameters"):
        p_src = base_src / p_name
        if p_src.exists() and p_src.is_dir():
            for pf in p_src.glob("*.toml"):
                dest = dest_p / pf.name
                if not dest.exists():
                    shutil.copy2(pf, dest)

    if not dest_p_lower.exists():
        try:
            os.symlink("Parameters", dest_p_lower)
        except OSError:
            pass

    if not param_files and not req.parameter_toml:
        param_files = [f"Parameters/{pf.name}" for pf in sorted(dest_p.glob("*.toml"))]

    # 4. Methods: check both 'Methods' and 'methods' in base_src
    dest_m = target_dir / "Methods"
    dest_m_lower = target_dir / "methods"
    dest_m.mkdir(parents=True, exist_ok=True)

    for m_name in ("Methods", "methods"):
        m_src = base_src / m_name
        if m_src.exists() and m_src.is_dir():
            for mf in m_src.glob("*.toml"):
                dest = dest_m / mf.name
                if not dest.exists():
                    shutil.copy2(mf, dest)

    if not dest_m_lower.exists():
        try:
            os.symlink("Methods", dest_m_lower)
        except OSError:
            pass

    if not method_files and not req.method_toml:
        method_files = [f"Methods/{mf.name}" for mf in sorted(dest_m.glob("*.toml"))]

    # If raw in-memory parameter_toml is provided, write it to target_dir / "Parameters" / "parameters.toml"
    if req.parameter_toml:
        p_path = dest_p / "parameters.toml"
        p_path.write_text(req.parameter_toml, encoding="utf-8")
        param_files = ["Parameters/parameters.toml"]

    # If raw in-memory method_toml is provided, write it to target_dir / "Methods" / "method.toml"
    if req.method_toml:
        m_path = dest_m / "method.toml"
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
