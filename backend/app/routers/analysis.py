from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import List, Optional, Tuple, Dict, Any
import os
import json
import math
import uuid
from datetime import datetime
from pathlib import Path

from .. import models, schemas, database, security
from ..services.fitting.relaxation import get_relaxation_times, extract_peak_intensities_from_results, fit_exponential_decay
from ..services.fitting.relaxation_tasks import run_relaxation_analysis_task
from .deps import get_project, get_analysis
from ..celery_app import celery_app
from ..services.fitting.cest_report import generate_cest_pdf_report
from ..services.fitting.cest_tasks import _update_experiment_toml_exclusions
from fastapi.responses import StreamingResponse

router = APIRouter(prefix="/api/projects/{project_uuid}/analysis", tags=["analysis"])
@router.post("", response_model=schemas.Analysis)
def create_analysis(
    analysis_data: schemas.AnalysisCreate,
    project: models.Project = Depends(get_project),
    db: Session = Depends(database.get_db)
):
    
    analysis_uuid = str(uuid.uuid4())
    new_analysis = models.Analysis(
        analysis_uuid=analysis_uuid,
        name=analysis_data.name,
        analysis_type=analysis_data.analysis_type,
        project_id=project.id,
        status="PENDING"
    )
    db.add(new_analysis)
    db.commit()
    db.refresh(new_analysis)
    return new_analysis

@router.get("", response_model=List[schemas.Analysis])
def list_analyses(
    project: models.Project = Depends(get_project),
    db: Session = Depends(database.get_db)
):
    
    return project.analyses

@router.get("/{analysis_uuid}", response_model=schemas.Analysis)
def get_analysis_info(
    analysis: models.Analysis = Depends(get_analysis)
):
    return analysis

@router.put("/{analysis_uuid}", response_model=schemas.Analysis)
def update_analysis(
    analysis_update: schemas.AnalysisUpdate,
    analysis: models.Analysis = Depends(get_analysis),
    db: Session = Depends(database.get_db)
):
    
    update_data = analysis_update.dict(exclude_unset=True)
    for key, value in update_data.items():
        setattr(analysis, key, value)
    
    db.commit()
    db.refresh(analysis)
    return analysis

@router.put("/{analysis_uuid}/spectra")
def update_analysis_spectra(
    spectrum_ids: List[int],
    analysis: models.Analysis = Depends(get_analysis),
    db: Session = Depends(database.get_db)
):
    
    spectra = db.query(models.Spectrum).filter(models.Spectrum.id.in_(spectrum_ids)).all()
    analysis.spectra = spectra
    db.commit()
    return {"message": "Analysis spectra updated"}

@router.post("/{analysis_uuid}/run")
def run_analysis(
    request: schemas.AnalysisRunRequest,
    analysis: models.Analysis = Depends(get_analysis),
    db: Session = Depends(database.get_db)
):
    
    spectra = db.query(models.Spectrum).filter(models.Spectrum.id.in_(request.spectrum_ids)).all()
    if not spectra:
        raise HTTPException(status_code=400, detail="No valid spectra selected")

    # Link spectra to analysis
    analysis.spectra = spectra
    
    # Store workers in parameters
    params = json.loads(analysis.parameters) if analysis.parameters else {}
    params['workers'] = request.workers
    analysis.parameters = json.dumps(params)
    
    analysis.status = "RUNNING"
    db.commit()

    # Create job directory
    project = analysis.project
    folder_name = f"{analysis.analysis_type.lower()}_fitting"
    run_dir = os.path.join(project.local_directory_path, folder_name, analysis.analysis_uuid)
    os.makedirs(run_dir, exist_ok=True)
    analysis.log_path = os.path.join(run_dir, "analysis.log")
    
    # Backup existing results before rerun
    results_path = os.path.join(run_dir, "results.json")
    if os.path.exists(results_path):
        import shutil
        bak_path = results_path.replace(".json", "_bak.json")
        try:
            shutil.move(results_path, bak_path)
            # Also backup log
            log_path = analysis.log_path
            if os.path.exists(log_path):
                shutil.copy(log_path, log_path.replace(".log", "_bak.log"))
        except Exception as e:
            print(f"Warning: Could not create backup: {e}")

    analysis.results_path = results_path
    db.commit()

    # Dispatch Celery task
    run_relaxation_analysis_task.delay(analysis.analysis_uuid, request.spectrum_ids, request.workers)
    
    return {"message": "Analysis started", "analysis_uuid": analysis.analysis_uuid}

def sanitize_floats_for_json(obj: Any) -> Any:
    """Recursively replace inf and nan float values with None for JSON compliance."""
    if isinstance(obj, float):
        if math.isinf(obj) or math.isnan(obj):
            return None
        return obj
    elif isinstance(obj, dict):
        return {k: sanitize_floats_for_json(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [sanitize_floats_for_json(item) for item in obj]
    return obj


@router.get("/{analysis_uuid}/results")
def get_analysis_results(
    analysis: models.Analysis = Depends(get_analysis)
):
    if analysis.status in ["RUNNING", "PENDING"]:
        return {"status": analysis.status, "results": None}

    if analysis.analysis_type.lower() in ["cest", "15n-cest", "cpmg"]:
        run_dir = os.path.dirname(analysis.results_path) if analysis.results_path else None
        if run_dir and os.path.exists(run_dir):
            try:
                from ..services.fitting.cest_tasks import _parse_chemex_output
                parsed = _parse_chemex_output(run_dir)
                if parsed and parsed.get("residues"):
                    results_data = {
                        "analysis_uuid": analysis.analysis_uuid,
                        "timestamp": datetime.now().isoformat(),
                        "fit_mode": parsed.get("fit_mode", "global"),
                        **parsed
                    }
                    temp_path = f"{analysis.results_path}.tmp"
                    with open(temp_path, "w") as f:
                        json.dump(sanitize_floats_for_json(results_data), f, indent=2, default=str)
                    os.replace(temp_path, analysis.results_path)
            except Exception as e:
                print(f"Error refreshing analysis results: {e}")

    if not analysis.results_path or not os.path.exists(analysis.results_path):
        return {"status": analysis.status, "results": None}
        
    with open(analysis.results_path, "r") as f:
        results = json.load(f)
        
    project = analysis.project
    folder_name = "cpmg_fitting" if analysis.analysis_type.upper() == "CPMG" else "cest_fitting"
    run_dir = os.path.join(project.local_directory_path, folder_name, analysis.analysis_uuid)
    config_name = "cpmg_config.json" if analysis.analysis_type.upper() == "CPMG" else "config.json"
    config_path = os.path.join(run_dir, config_name)
    residue_mapping = {}
    if os.path.exists(config_path):
        try:
            with open(config_path, "r") as cf:
                config = json.load(cf)
                residue_mapping = config.get("residue_mapping", {})
        except Exception:
            pass

    if isinstance(results, dict):
        results["residue_mapping"] = residue_mapping
        
    return {"status": analysis.status, "results": sanitize_floats_for_json(results)}


@router.delete("/{analysis_uuid}")
def delete_analysis(
    analysis: models.Analysis = Depends(get_analysis),
    db: Session = Depends(database.get_db)
):
    
    # Optional: Delete the results directory if it exists
    project = analysis.project
    folder_name = f"{analysis.analysis_type.lower()}_fitting"
    run_dir = os.path.join(project.local_directory_path, folder_name, analysis.analysis_uuid)
    if os.path.exists(run_dir):
        import shutil
        try:
            shutil.rmtree(run_dir)
        except Exception as e:
            print(f"Warning: Could not delete results directory {run_dir}: {e}")

    db.delete(analysis)
    db.commit()
    return {"message": "Analysis deleted"}

@router.post("/{analysis_uuid}/restore", response_model=schemas.Analysis)
def restore_analysis(
    analysis: models.Analysis = Depends(get_analysis),
    db: Session = Depends(database.get_db)
):
    
    if not analysis.results_path:
        raise HTTPException(status_code=400, detail="No results path defined for this analysis")
        
    bak_path = analysis.results_path.replace(".json", "_bak.json")
    if not os.path.exists(bak_path):
        raise HTTPException(status_code=404, detail="Backup file not found")
        
    import shutil
    try:
        # Move current to temporary if it exists
        if os.path.exists(analysis.results_path):
            temp_path = analysis.results_path.replace(".json", "_tmp.json")
            shutil.move(analysis.results_path, temp_path)
            shutil.move(bak_path, analysis.results_path)
            shutil.move(temp_path, bak_path) # Swap them
            
            # Swap logs too if they exist
            if analysis.log_path:
                bak_log = analysis.log_path.replace(".log", "_bak.log")
                if os.path.exists(bak_log):
                    tmp_log = analysis.log_path.replace(".log", "_tmp.log")
                    shutil.move(analysis.log_path, tmp_log)
                    shutil.move(bak_log, analysis.log_path)
                    shutil.move(tmp_log, bak_log)
        else:
            # Just move backup to current
            shutil.move(bak_path, analysis.results_path)
            bak_log = analysis.log_path.replace(".log", "_bak.log")
            if os.path.exists(bak_log):
                shutil.move(bak_log, analysis.log_path)
                
        analysis.status = "COMPLETED"
        analysis.completed_at = datetime.utcnow()
        db.commit()
        db.refresh(analysis)
        return analysis
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Restore failed: {str(e)}")


# =========================================================================
# 15N-CEST (ChemEx) Endpoints
# =========================================================================

@router.post("/{analysis_uuid}/cest/run")
def run_cest_analysis(
    request: dict,
    analysis: models.Analysis = Depends(get_analysis),
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(security.get_current_user),
):
    """
    Launch a ChemEx CEST fitting job.

    Expects a JSON body with:
      - experiment_toml: str
      - parameter_toml: str
      - method_toml: str (optional)
      - data_files: dict {residue_name: filepath}
      - model: str (default "2st")
      - include: list[int] (optional)
      - exclude: list[int] (optional)
    """
    from ..services.fitting.cest_tasks import run_cest_analysis_task

    if analysis.analysis_type != "15N-CEST":
        raise HTTPException(status_code=400, detail="This endpoint is only for 15N-CEST analyses")

    project = analysis.project

    # Setup run directory
    run_dir = os.path.join(project.local_directory_path, "cest_fitting", analysis.analysis_uuid)
    os.makedirs(run_dir, exist_ok=True)

    # Update config for later retrieval (merging with existing data config)
    config_path = os.path.join(run_dir, "config.json")
    existing_config = {}
    if os.path.exists(config_path):
        with open(config_path, "r") as f:
            existing_config = json.load(f)
    
    # Merge new fit parameters into config
    existing_config.update(request)
    
    with open(config_path, "w") as f:
        json.dump(existing_config, f, indent=2)

    import uuid
    task_id = str(uuid.uuid4())

    # Set up log and results paths
    analysis.log_path = os.path.join(run_dir, "chemex.log")
    analysis.results_path = os.path.join(run_dir, "results.json")
    analysis.status = "PENDING"
    analysis.completed_at = None
    analysis.error_message = None
    analysis.celery_task_id = task_id

    params = json.loads(analysis.parameters) if analysis.parameters else {}
    params["config_path"] = config_path
    params["task_id"] = task_id
    analysis.parameters = json.dumps(params)
    db.commit()

    # Dispatch Celery task with FULL merged configuration and preset task_id
    run_cest_analysis_task.apply_async(
        args=[analysis.analysis_uuid, existing_config],
        task_id=task_id
    )

    return {"message": "CEST analysis started", "analysis_uuid": analysis.analysis_uuid, "task_id": task_id}


@router.post("/{analysis_uuid}/cest/stop")
@router.post("/{analysis_uuid}/cancel")
def stop_cest_analysis(
    analysis: models.Analysis = Depends(get_analysis),
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(security.get_current_user),
):
    """Terminate a running CEST/CPMG fitting job inside its ephemeral container."""
    if analysis.status not in ["RUNNING", "PENDING"]:
        return {"message": f"Analysis is already in {analysis.status} state"}

    # 1. Terminate Celery task if recorded
    task_id = analysis.celery_task_id
    if not task_id and analysis.parameters:
        try:
            params = json.loads(analysis.parameters)
            task_id = params.get("task_id")
        except Exception:
            pass
    if task_id:
        try:
            celery_app.control.revoke(task_id, terminate=True, signal="SIGTERM")
        except Exception:
            pass

    # 2. Terminate ChemEx ephemeral container
    from ..services.fitting.chemex_runner import cancel_chemex_job
    cancel_chemex_job(analysis.analysis_uuid)

    # 3. Update analysis status
    analysis.cancel_requested = True
    analysis.status = "CANCELLED"
    analysis.error_message = "Cancelled by user"
    analysis.completed_at = datetime.utcnow()
    db.commit()

    # Append stop message to log if possible
    if analysis.log_path and os.path.exists(analysis.log_path):
        try:
            with open(analysis.log_path, "a") as f:
                f.write(f"\n\n{'=' * 60}\n")
                f.write(f"ANALYSIS CANCELLED BY USER AT: {datetime.utcnow().isoformat()}\n")
                f.write(f"{'=' * 60}\n")
        except Exception:
            pass

    return {"message": "Analysis cancelled successfully", "status": "CANCELLED"}


@router.get("/{analysis_uuid}/cest/logs")
def get_cest_logs(
    analysis: models.Analysis = Depends(get_analysis),
):
    """Return the live log content from the ChemEx run."""
    if not analysis.log_path or not os.path.exists(analysis.log_path):
        return {"logs": "", "status": analysis.status}

    with open(analysis.log_path, "r") as f:
        logs = f.read()

    return {"logs": logs, "status": analysis.status}


@router.get("/{analysis_uuid}/cest/config")
def get_cest_config(
    analysis: models.Analysis = Depends(get_analysis),
):
    """Return the saved CEST configuration."""
    project = analysis.project
    run_dir = os.path.join(project.local_directory_path, "cest_fitting", analysis.analysis_uuid)
    config_path = os.path.join(run_dir, "config.json")

    if not os.path.exists(config_path):
        return {"config": None, "has_backup": False}

    with open(config_path, "r") as f:
        config = json.load(f)
    
    output_bak = os.path.join(run_dir, "Output_bak")
    return {"config": config, "has_backup": os.path.exists(output_bak)}


@router.get("/{analysis_uuid}/cest/method-parameters")
def get_cest_method_parameters(
    model: str = "2st",
    analysis: models.Analysis = Depends(get_analysis),
):
    """
    Return the parameter definitions, glosses, and metadata for a given kinetic model in ChemEx.
    """
    # Base parameters available for 2-state models
    params_2st = [
        {
            "name": "PB",
            "gloss": "Population of minor state B (0 - 0.5)",
            "scope": "global",
            "default_mode": "default",
            "default_bounds": "< 0.5",
            "category": "kinetic",
            "is_primary": True
        },
        {
            "name": "KEX_AB",
            "gloss": "Exchange rate between states A and B (s⁻¹)",
            "scope": "global",
            "default_mode": "default",
            "category": "kinetic",
            "is_primary": True
        },
        {
            "name": "CS_A",
            "gloss": "Chemical shift of major ground state A (ppm)",
            "scope": "residue",
            "default_mode": "default",
            "category": "chemical_shift",
            "is_primary": True
        },
        {
            "name": "DW_AB",
            "gloss": "Chemical shift difference between states B and A: CS_B - CS_A (ppm)",
            "scope": "residue",
            "default_mode": "default",
            "category": "chemical_shift",
            "is_primary": True
        },
        {
            "name": "R1_A",
            "gloss": "Longitudinal relaxation rate of state A (s⁻¹)",
            "scope": "residue",
            "default_mode": "default",
            "category": "relaxation",
            "is_primary": True
        },
        {
            "name": "R2_A",
            "gloss": "Transverse relaxation rate of state A (s⁻¹)",
            "scope": "residue",
            "default_mode": "default",
            "category": "relaxation",
            "is_primary": True
        },
        {
            "name": "R1_B",
            "gloss": "Longitudinal relaxation rate of state B (s⁻¹)",
            "scope": "residue",
            "default_mode": "default",
            "default_expression": "[R1_A]",
            "category": "relaxation",
            "is_primary": True
        },
        {
            "name": "R2_B",
            "gloss": "Transverse relaxation rate of state B (s⁻¹)",
            "scope": "residue",
            "default_mode": "default",
            "default_expression": "[R2_A]",
            "category": "relaxation",
            "is_primary": True
        },
        {
            "name": "TAUC_A",
            "gloss": "Rotational correlation time of state A (s)",
            "scope": "global",
            "default_mode": "default",
            "category": "hydrodynamic",
            "is_primary": False
        },
    ]

    # Parameters for 3-state models
    params_3st = [
        {
            "name": "PB",
            "gloss": "Population of state B (0 - 1)",
            "scope": "global",
            "default_mode": "default",
            "category": "kinetic",
            "is_primary": True
        },
        {
            "name": "PC",
            "gloss": "Population of state C (0 - 1)",
            "scope": "global",
            "default_mode": "default",
            "category": "kinetic",
            "is_primary": True
        },
        {
            "name": "KEX_AB",
            "gloss": "Exchange rate between states A and B (s⁻¹)",
            "scope": "global",
            "default_mode": "default",
            "category": "kinetic",
            "is_primary": True
        },
        {
            "name": "KEX_AC",
            "gloss": "Exchange rate between states A and C (s⁻¹)",
            "scope": "global",
            "default_mode": "default",
            "category": "kinetic",
            "is_primary": True
        },
        {
            "name": "KEX_BC",
            "gloss": "Exchange rate between states B and C (s⁻¹)",
            "scope": "global",
            "default_mode": "default",
            "category": "kinetic",
            "is_primary": False
        },
        {
            "name": "CS_A",
            "gloss": "Chemical shift of major state A (ppm)",
            "scope": "residue",
            "default_mode": "default",
            "category": "chemical_shift",
            "is_primary": True
        },
        {
            "name": "DW_AB",
            "gloss": "Chemical shift difference CS_B - CS_A (ppm)",
            "scope": "residue",
            "default_mode": "default",
            "category": "chemical_shift",
            "is_primary": True
        },
        {
            "name": "DW_AC",
            "gloss": "Chemical shift difference CS_C - CS_A (ppm)",
            "scope": "residue",
            "default_mode": "default",
            "category": "chemical_shift",
            "is_primary": True
        },
        {
            "name": "R1_A",
            "gloss": "Longitudinal relaxation rate of state A (s⁻¹)",
            "scope": "residue",
            "default_mode": "default",
            "category": "relaxation",
            "is_primary": True
        },
        {
            "name": "R2_A",
            "gloss": "Transverse relaxation rate of state A (s⁻¹)",
            "scope": "residue",
            "default_mode": "default",
            "category": "relaxation",
            "is_primary": True
        },
        {
            "name": "R1_B",
            "gloss": "Longitudinal relaxation rate of state B (s⁻¹)",
            "scope": "residue",
            "default_mode": "default",
            "default_expression": "[R1_A]",
            "category": "relaxation",
            "is_primary": True
        },
        {
            "name": "R2_B",
            "gloss": "Transverse relaxation rate of state B (s⁻¹)",
            "scope": "residue",
            "default_mode": "default",
            "default_expression": "[R2_A]",
            "category": "relaxation",
            "is_primary": True
        },
        {
            "name": "R1_C",
            "gloss": "Longitudinal relaxation rate of state C (s⁻¹)",
            "scope": "residue",
            "default_mode": "default",
            "default_expression": "[R1_A]",
            "category": "relaxation",
            "is_primary": True
        },
        {
            "name": "R2_C",
            "gloss": "Transverse relaxation rate of state C (s⁻¹)",
            "scope": "residue",
            "default_mode": "default",
            "default_expression": "[R2_A]",
            "category": "relaxation",
            "is_primary": True
        },
        {
            "name": "TAUC_A",
            "gloss": "Rotational correlation time of state A (s)",
            "scope": "global",
            "default_mode": "default",
            "category": "hydrodynamic",
            "is_primary": False
        },
    ]

    model_clean = (model or "2st").lower()
    if "3st" in model_clean or "3" in model_clean:
        return {"model": model, "parameters": params_3st}
    
    return {"model": model, "parameters": params_2st}


@router.post("/{analysis_uuid}/methods/validate", response_model=schemas.MethodValidationResponse)
def validate_method_endpoint(
    req: schemas.MethodValidationRequest,
    analysis: models.Analysis = Depends(get_analysis),
):
    """
    Validate method configuration or raw method.toml and return validation issues and preview.
    """
    from ..services.fitting.method_emitter import (
        MethodConfigModel,
        emit_method_toml,
        parse_method_toml,
        validate_method_config,
    )

    if req.config is not None:
        try:
            config_model = MethodConfigModel(**req.config.model_dump())
            issues = validate_method_config(config_model, req.available_params)
            emitted = emit_method_toml(config_model)
            has_errors = any(i.get("severity") == "error" for i in issues)
            return schemas.MethodValidationResponse(
                valid=not has_errors,
                issues=[schemas.MethodValidationIssue(**i) for i in issues],
                emitted_toml=emitted,
            )
        except Exception as e:
            return schemas.MethodValidationResponse(
                valid=False,
                issues=[
                    schemas.MethodValidationIssue(
                        id="validation-exception",
                        stepIndex=-1,
                        stepName="",
                        field="",
                        severity="error",
                        message=str(e),
                    )
                ],
                emitted_toml=None,
            )
    elif req.toml is not None:
        try:
            config_model = parse_method_toml(req.toml)
            issues = validate_method_config(config_model, req.available_params)
            emitted = emit_method_toml(config_model)
            has_errors = any(i.get("severity") == "error" for i in issues)
            return schemas.MethodValidationResponse(
                valid=not has_errors,
                issues=[schemas.MethodValidationIssue(**i) for i in issues],
                emitted_toml=emitted,
            )
        except Exception as e:
            return schemas.MethodValidationResponse(
                valid=False,
                issues=[
                    schemas.MethodValidationIssue(
                        id="parse-exception",
                        stepIndex=-1,
                        stepName="",
                        field="",
                        severity="error",
                        message=f"Failed to parse method TOML: {e}",
                    )
                ],
                emitted_toml=req.toml,
            )

    return schemas.MethodValidationResponse(valid=True, issues=[], emitted_toml="")


def _get_analysis_run_metadata(analysis: models.Analysis) -> Dict[str, Any]:
    """Extract metadata for an analysis from its config.json, database, and spectra."""
    project = analysis.project
    run_dir = os.path.join(project.local_directory_path, "cest_fitting", analysis.analysis_uuid)
    config_path = os.path.join(run_dir, "config.json")

    config = {}
    if os.path.exists(config_path):
        try:
            with open(config_path, "r") as cf:
                config = json.load(cf)
        except Exception:
            pass

    # Extract model
    model = config.get("model") or "2st"

    # Extract fit mode
    fit_mode = config.get("fit_mode") or "global"

    # Extract nucleus (from analysis_type e.g. 15N-CEST -> 15N)
    nucleus = "15N" if "15N" in (analysis.analysis_type or "").upper() else "15N"

    # Extract static field (b0) & temperature
    spectra = analysis.spectra
    static_field = None
    temperature = None
    if spectra:
        for s in spectra:
            if s.b0 is not None and static_field is None:
                static_field = s.b0
            if s.temperature is not None and temperature is None:
                temperature = s.temperature

    metadata = config.get("metadata", {})
    if not static_field and metadata:
        for b1_k, b1_meta in metadata.items():
            if isinstance(b1_meta, dict) and b1_meta.get("b0"):
                static_field = b1_meta["b0"]
                break

    if static_field is None:
        static_field = 600.0
    if temperature is None:
        temperature = 298.15

    # Extract chi2_red and total_residues if available
    chi2_red = None
    total_residues = 0

    results_path = analysis.results_path or os.path.join(run_dir, "results.json")
    if os.path.exists(results_path):
        try:
            with open(results_path, "r") as rf:
                res_data = json.load(rf)
                chi2_red = res_data.get("global", {}).get("chi2_red")
                residues = res_data.get("residues", {})
                total_residues = len(residues)
                if not fit_mode and res_data.get("fit_mode"):
                    fit_mode = res_data.get("fit_mode")
        except Exception:
            pass

    # Fallback to statistics.toml or parser if results.json didn't have chi2_red
    if chi2_red is None or total_residues == 0:
        try:
            from ..services.fitting.chemex_parser import parse_chemex_run_parameters
            parsed = parse_chemex_run_parameters(run_dir)
            if chi2_red is None:
                chi2_red = parsed.get("statistics", {}).get("chi2_red")
            if total_residues == 0:
                total_residues = len(parsed.get("residues", {}))
            if parsed.get("fit_mode"):
                fit_mode = parsed.get("fit_mode")
        except Exception:
            pass

    return {
        "analysis_uuid": analysis.analysis_uuid,
        "name": analysis.name,
        "analysis_type": analysis.analysis_type,
        "status": analysis.status,
        "created_at": analysis.created_at.isoformat() if analysis.created_at else None,
        "completed_at": analysis.completed_at.isoformat() if analysis.completed_at else None,
        "model": model,
        "nucleus": nucleus,
        "fit_mode": fit_mode,
        "static_field": static_field,
        "temperature": temperature,
        "chi2_red": chi2_red,
        "total_residues": total_residues,
    }


from ..services.fitting.chemex_parser import (
    evaluate_source_compatibility as _evaluate_source_compatibility,
)


@router.get("/compatible-sources")
def list_compatible_sources_for_project(
    project: models.Project = Depends(get_project),
    model: str = "2st",
    nucleus: str = "15N",
    temperature: Optional[float] = None,
    static_field: Optional[float] = None,
    db: Session = Depends(database.get_db),
):
    """
    List completed runs in the project for source parameter inheritance during new analysis creation.
    """
    target_meta = {
        "model": model,
        "nucleus": nucleus,
        "temperature": temperature or 298.15,
        "static_field": static_field or 600.0,
        "analysis_type": f"{nucleus}-CEST",
    }

    candidate_analyses = (
        db.query(models.Analysis)
        .filter(
            models.Analysis.project_id == project.id,
            models.Analysis.status == "COMPLETED",
        )
        .order_by(models.Analysis.created_at.desc())
        .all()
    )

    sources = []
    for cand in candidate_analyses:
        cand_meta = _get_analysis_run_metadata(cand)
        is_compat, block_reasons, warn_reasons = _evaluate_source_compatibility(cand_meta, target_meta)
        cand_meta["is_compatible"] = is_compat
        cand_meta["block_reasons"] = block_reasons
        cand_meta["warning_reasons"] = warn_reasons
        sources.append(cand_meta)

    return {
        "target": target_meta,
        "sources": sources,
    }


@router.get("/{analysis_uuid}/cest/compatible-sources")
def get_compatible_cest_sources(
    analysis: models.Analysis = Depends(get_analysis),
    db: Session = Depends(database.get_db),
):
    """
    List completed runs in the project for source parameter inheritance with compatibility status.
    """
    project = analysis.project
    target_meta = _get_analysis_run_metadata(analysis)

    candidate_analyses = (
        db.query(models.Analysis)
        .filter(
            models.Analysis.project_id == project.id,
            models.Analysis.status == "COMPLETED",
            models.Analysis.id != analysis.id,
        )
        .order_by(models.Analysis.created_at.desc())
        .all()
    )

    sources = []
    for cand in candidate_analyses:
        cand_meta = _get_analysis_run_metadata(cand)
        is_compat, block_reasons, warn_reasons = _evaluate_source_compatibility(cand_meta, target_meta)
        cand_meta["is_compatible"] = is_compat
        cand_meta["block_reasons"] = block_reasons
        cand_meta["warning_reasons"] = warn_reasons
        sources.append(cand_meta)

    return {
        "target": target_meta,
        "sources": sources,
    }


@router.get("/source-parameters/{source_uuid}")
@router.get("/{analysis_uuid}/cest/source-parameters/{source_uuid}")
def get_cest_source_parameters(
    source_uuid: str,
    project: models.Project = Depends(get_project),
    db: Session = Depends(database.get_db),
):
    """
    Fetch parsed fitted parameters and uncertainties for a specific completed source run.
    """
    source_analysis = (
        db.query(models.Analysis)
        .filter(
            models.Analysis.project_id == project.id,
            models.Analysis.analysis_uuid == source_uuid,
        )
        .first()
    )

    if not source_analysis:
        raise HTTPException(status_code=404, detail="Source analysis not found")

    if source_analysis.status != "COMPLETED":
        raise HTTPException(status_code=400, detail="Source analysis is not completed")

    from ..services.fitting.chemex_parser import parse_chemex_run_parameters
    run_dir = os.path.join(project.local_directory_path, "cest_fitting", source_analysis.analysis_uuid)
    if not os.path.exists(run_dir):
        raise HTTPException(status_code=404, detail="Source analysis run directory not found on disk")

    parsed_results = parse_chemex_run_parameters(run_dir)
    source_meta = _get_analysis_run_metadata(source_analysis)

    return {
        "source": source_meta,
        "parameters": parsed_results,
    }


@router.put("/{analysis_uuid}/cest/config")
def save_cest_config(
    request: dict,
    analysis: models.Analysis = Depends(get_analysis),
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(security.get_current_user),
):
    """Save CEST configuration without running."""
    project = analysis.project
    run_dir = os.path.join(project.local_directory_path, "cest_fitting", analysis.analysis_uuid)
    os.makedirs(run_dir, exist_ok=True)

    config_path = os.path.join(run_dir, "config.json")
    existing_config = {}
    if os.path.exists(config_path):
        with open(config_path, "r") as f:
            existing_config = json.load(f)

    existing_config.update(request)

    # Sync exclusions to experiment TOML files on disk
    param_cfg = existing_config.get("parameter_config") or {}
    excluded_res = set(
        param_cfg.get("excludedResidues", [])
        or existing_config.get("excluded_residues", [])
        or []
    )
    experiments_dir = existing_config.get("experiments_dir") or os.path.join(run_dir, "experiments")
    gen_exps = existing_config.get("generatedExperiments", [])

    if isinstance(gen_exps, list) and os.path.exists(experiments_dir):
        updated_exps = []
        for exp in gen_exps:
            if not isinstance(exp, dict):
                continue
            toml_content = exp.get("toml_content", "")
            exp_path = exp.get("path") or os.path.join(experiments_dir, exp.get("filename", ""))

            if not toml_content and os.path.exists(exp_path):
                try:
                    with open(exp_path, "r") as f:
                        toml_content = f.read()
                except Exception:
                    pass

            if toml_content:
                new_toml = _update_experiment_toml_exclusions(toml_content, excluded_res)
                exp["toml_content"] = new_toml
                try:
                    with open(exp_path, "w") as f:
                        f.write(new_toml)
                except Exception:
                    pass
            updated_exps.append(exp)
        existing_config["generatedExperiments"] = updated_exps

    with open(config_path, "w") as f:
        json.dump(existing_config, f, indent=2)

    params = json.loads(analysis.parameters) if analysis.parameters else {}
    params["config_path"] = config_path
    analysis.parameters = json.dumps(params)
    db.commit()

    return {
        "message": "Configuration saved",
        "config_path": config_path,
        "experiments": existing_config.get("generatedExperiments", []),
    }


@router.post("/{analysis_uuid}/cest/restore")
def restore_cest_analysis(
    analysis: models.Analysis = Depends(get_analysis),
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(security.get_current_user),
):
    """Restore the last backed-up CEST results."""
    project = analysis.project
    run_dir = os.path.join(project.local_directory_path, "cest_fitting", analysis.analysis_uuid)
    
    output_dir = os.path.join(run_dir, "Output")
    output_bak = os.path.join(run_dir, "Output_bak")
    output_tmp = os.path.join(run_dir, "Output_tmp")
    
    results_path = os.path.join(run_dir, "results.json")
    results_bak = os.path.join(run_dir, "results_bak.json")
    results_tmp = os.path.join(run_dir, "results_tmp.json")
    
    log_path = os.path.join(run_dir, "chemex.log")
    log_bak = os.path.join(run_dir, "chemex_bak.log")
    log_tmp = os.path.join(run_dir, "chemex_tmp.log")

    if not os.path.exists(output_bak):
        raise HTTPException(status_code=404, detail="No backup found to restore")

    try:
        # Swap Output directories
        if os.path.exists(output_dir):
            os.rename(output_dir, output_tmp)
        os.rename(output_bak, output_dir)
        if os.path.exists(output_tmp):
            os.rename(output_tmp, output_bak)

        # Swap Results JSON files
        if os.path.exists(results_path):
            os.rename(results_path, results_tmp)
        if os.path.exists(results_bak):
            os.rename(results_bak, results_path)
        if os.path.exists(results_tmp):
            os.rename(results_tmp, results_bak)

        # Swap Log files
        if os.path.exists(log_path):
            os.rename(log_path, log_tmp)
        if os.path.exists(log_bak):
            os.rename(log_bak, log_path)
        if os.path.exists(log_tmp):
            os.rename(log_tmp, log_bak)

        # Update analysis status back to completed 
        analysis.status = "COMPLETED"
        db.commit()
        
        return {"message": "Results restored from backup"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Restore failed: {str(e)}")


@router.get("/{analysis_uuid}/cest/report")
def export_cest_report(
    style: str = "publication",
    analysis: models.Analysis = Depends(get_analysis),
    db: Session = Depends(database.get_db)
):
    """Generate and return a multi-page PDF report for the CEST analysis."""
    project = analysis.project
    if analysis.results_path and os.path.exists(analysis.results_path):
        run_dir = os.path.dirname(analysis.results_path)
    else:
        run_dir = os.path.join(project.local_directory_path, "cest_fitting", analysis.analysis_uuid)
    
    try:
        pdf_buffer = generate_cest_pdf_report(
            run_dir,
            analysis.name,
            analysis_type="CEST",
            style=style,
            chemex_image_digest=analysis.chemex_image_digest,
        )
        return StreamingResponse(
            pdf_buffer,
            media_type="application/pdf",
            headers={
                "Content-Disposition": f"attachment; filename=cest_{analysis.analysis_uuid}_report.pdf"
            }
        )
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        raise HTTPException(status_code=500, detail=f"Failed to generate report: {str(e)}\n{tb}")

@router.get("/{analysis_uuid}/cpmg/report")
@router.get("/{analysis_uuid}/report")
def export_cpmg_report(
    style: str = "publication",
    analysis: models.Analysis = Depends(get_analysis),
    db: Session = Depends(database.get_db)
):
    """Generate and return a multi-page PDF report for the CPMG or general analysis."""
    project = analysis.project
    is_cpmg = analysis.analysis_type.upper() == "CPMG"
    folder_name = "cpmg_fitting" if is_cpmg else "cest_fitting"
    if analysis.results_path and os.path.exists(analysis.results_path):
        run_dir = os.path.dirname(analysis.results_path)
    else:
        run_dir = os.path.join(project.local_directory_path, folder_name, analysis.analysis_uuid)
    type_name = "cpmg" if is_cpmg else "cest"
    
    try:
        pdf_buffer = generate_cest_pdf_report(
            run_dir,
            analysis.name,
            analysis_type=type_name.upper(),
            style=style,
            chemex_image_digest=analysis.chemex_image_digest,
        )
        return StreamingResponse(
            pdf_buffer,
            media_type="application/pdf",
            headers={
                "Content-Disposition": f"attachment; filename={type_name}_{analysis.analysis_uuid}_report.pdf"
            }
        )
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        raise HTTPException(status_code=500, detail=f"Failed to generate report: {str(e)}\n{tb}")


@router.post("/{analysis_uuid}/export-token")
def create_export_token(
    request: Optional[Dict[str, Any]] = None,
    analysis: models.Analysis = Depends(get_analysis),
    current_user: models.User = Depends(security.get_current_user),
):
    """
    Issue a short-lived (60s) single-use signed download token for streaming ZIP archive export.
    """
    from ..services.export.zip_export import generate_export_token

    if analysis.status != "COMPLETED":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Analysis export requires status COMPLETED (current status: {analysis.status})",
        )

    options = request or {}
    token = generate_export_token(
        project_uuid=analysis.project.project_uuid,
        analysis_uuid=analysis.analysis_uuid,
        user_id=current_user.id,
        options=options,
        validity_seconds=60,
    )
    return {"token": token, "expires_in": 60}


@router.get("/{analysis_uuid}/export")
def export_analysis_zip(
    project_uuid: str,
    analysis_uuid: str,
    token: Optional[str] = None,
    include_data: bool = False,
    include_plots: bool = True,
    include_statistics: bool = True,
    style: str = "publication",
    db: Session = Depends(database.get_db),
    current_user: Optional[models.User] = Depends(security.get_optional_current_user),
):
    """
    Stream a deterministic ZIP archive of the analysis direct to disk.
    Supports short-lived signed tokens as well as direct session authentication.
    """
    from ..services.export.zip_export import verify_export_token, stream_analysis_zip
    import re

    # Verify authorization via token or current_user
    if token:
        valid, token_opts, err_msg = verify_export_token(token, project_uuid, analysis_uuid)
        if not valid:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=err_msg)
        if token_opts:
            include_data = token_opts.get("include_data", include_data)
            include_plots = token_opts.get("include_plots", include_plots)
            include_statistics = token_opts.get("include_statistics", include_statistics)
            style = token_opts.get("style", style)
    elif current_user:
        # Check permissions through project lookup
        project = db.query(models.Project).filter(models.Project.project_uuid == project_uuid).first()
        if not project or (project.user_id != current_user.id and not current_user.is_superuser):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not enough permissions")
    else:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication token required")

    # Fetch analysis record
    analysis = db.query(models.Analysis).filter(
        models.Analysis.analysis_uuid == analysis_uuid
    ).first()
    if not analysis:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Analysis not found")

    if analysis.status != "COMPLETED":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Analysis export requires status COMPLETED (current status: {analysis.status})",
        )

    project = analysis.project
    is_cpmg = analysis.analysis_type.upper() == "CPMG"
    folder_name = "cpmg_fitting" if is_cpmg else "cest_fitting"
    run_dir = os.path.join(project.local_directory_path, folder_name, analysis.analysis_uuid)

    clean_name = re.sub(r"[^A-Za-z0-9_-]", "_", analysis.name.strip()).lower()
    short_uuid = analysis.analysis_uuid[:8]
    date_str = datetime.now().strftime("%Y%m%d")
    filename = f"resoflow_{clean_name}_{short_uuid}_{date_str}.zip"

    generator = stream_analysis_zip(
        analysis_dir=run_dir,
        analysis_name=analysis.name,
        analysis_type=analysis.analysis_type,
        include_data=include_data,
        include_plots=include_plots,
        include_statistics=include_statistics,
        style=style,
        chemex_image_digest=analysis.chemex_image_digest,
    )

    return StreamingResponse(
        generator,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )



@router.get("/{analysis_uuid}/statistics/plots/{method_name}")
def download_statistics_plots(
    method_name: str,
    analysis: models.Analysis = Depends(get_analysis),
    step_name: Optional[str] = None,
):
    """
    Download the plots.pdf generated by ChemEx for Monte Carlo, Bootstrap, or MCMC.
    """
    from pathlib import Path
    from fastapi.responses import FileResponse

    project = analysis.project
    is_cpmg = analysis.analysis_type.upper() == "CPMG"
    folder_name = "cpmg_fitting" if is_cpmg else "cest_fitting"
    run_dir = Path(project.local_directory_path) / folder_name / analysis.analysis_uuid

    method_dir_map = {
        "mc": "MonteCarlo",
        "monte_carlo": "MonteCarlo",
        "montecarlo": "MonteCarlo",
        "bs": "Bootstrap",
        "bootstrap": "Bootstrap",
        "bsn": "BootstrapNS",
        "bootstrap_ns": "BootstrapNS",
        "bootstrapns": "BootstrapNS",
        "mcmc": "MCMC",
    }
    dir_name = method_dir_map.get(method_name.lower(), method_name)

    candidates = []
    if step_name:
        candidates.append(run_dir / step_name / "Statistics" / dir_name / "plots.pdf")
        candidates.append(run_dir / "Output" / step_name / "Statistics" / dir_name / "plots.pdf")
    candidates.extend([
        run_dir / "Statistics" / dir_name / "plots.pdf",
        run_dir / "Output" / "Statistics" / dir_name / "plots.pdf",
        run_dir / "STEP1" / "Statistics" / dir_name / "plots.pdf",
        run_dir / "Output" / "STEP1" / "Statistics" / dir_name / "plots.pdf",
    ])

    for p in candidates:
        if p.is_file():
            return FileResponse(
                path=str(p),
                media_type="application/pdf",
                filename=f"{method_name}_plots_{analysis.analysis_uuid}.pdf",
            )

    # Search inside group directories
    try:
        method_dirs = _locate_all_statistics_method_dirs(analysis, method_name, step_name)
        for m_dir in method_dirs:
            pdf_f = m_dir / "plots.pdf"
            if pdf_f.is_file():
                return FileResponse(
                    path=str(pdf_f),
                    media_type="application/pdf",
                    filename=f"{method_name}_plots_{analysis.analysis_uuid}.pdf",
                )
    except Exception:
        pass

    raise HTTPException(status_code=404, detail=f"No {method_name} plots.pdf report found for this analysis.")


def _locate_all_statistics_method_dirs(analysis: models.Analysis, method_name: str, step_name: Optional[str] = None):
    from pathlib import Path
    project = analysis.project
    is_cpmg = analysis.analysis_type.upper() == "CPMG"
    folder_name = "cpmg_fitting" if is_cpmg else "cest_fitting"
    run_dir = Path(project.local_directory_path) / folder_name / analysis.analysis_uuid

    method_dir_map = {
        "mc": "MonteCarlo",
        "monte_carlo": "MonteCarlo",
        "montecarlo": "MonteCarlo",
        "bs": "Bootstrap",
        "bootstrap": "Bootstrap",
        "bsn": "BootstrapNS",
        "bootstrap_ns": "BootstrapNS",
        "bootstrapns": "BootstrapNS",
        "mcmc": "MCMC",
    }
    dir_name = method_dir_map.get(method_name.lower(), method_name)

    # 1. Check top-level single statistics directories
    top_candidates = []
    if step_name:
        top_candidates.extend([
            run_dir / step_name / "Statistics" / dir_name,
            run_dir / "Output" / step_name / "Statistics" / dir_name,
        ])
    top_candidates.extend([
        run_dir / "Output" / "STEP2" / "Statistics" / dir_name,
        run_dir / "STEP2" / "Statistics" / dir_name,
        run_dir / "Output" / "STEP1" / "Statistics" / dir_name,
        run_dir / "STEP1" / "Statistics" / dir_name,
        run_dir / "Output" / "Statistics" / dir_name,
        run_dir / "Statistics" / dir_name,
    ])
    for p in top_candidates:
        if p.is_dir():
            return [p]

    # 2. Check for Groups/ folders across potential roots
    group_parents = []
    if step_name:
        group_parents.extend([
            run_dir / step_name / "Groups",
            run_dir / "Output" / step_name / "Groups",
        ])
    group_parents.extend([
        run_dir / "Output" / "Groups",
        run_dir / "Groups",
        run_dir / "Output" / "STEP2" / "Groups",
        run_dir / "STEP2" / "Groups",
        run_dir / "Output" / "STEP1" / "Groups",
        run_dir / "STEP1" / "Groups",
    ])
    for g_parent in group_parents:
        if g_parent.is_dir():
            group_dirs = []
            for g_dir in sorted(g_parent.iterdir()):
                stat_sub = g_dir / "Statistics" / dir_name
                if stat_sub.is_dir():
                    group_dirs.append(stat_sub)
            if group_dirs:
                return group_dirs

    raise HTTPException(status_code=404, detail=f"No {method_name} statistics directory found.")


def _locate_statistics_method_dir(analysis: models.Analysis, method_name: str, step_name: Optional[str] = None):
    dirs = _locate_all_statistics_method_dirs(analysis, method_name, step_name)
    return dirs[0]


def _get_step_deterministic_values(analysis: models.Analysis, step_name: Optional[str] = None) -> Dict[str, float]:
    from pathlib import Path
    import tomllib
    project = analysis.project
    is_cpmg = analysis.analysis_type.upper() == "CPMG"
    folder_name = "cpmg_fitting" if is_cpmg else "cest_fitting"
    run_dir = Path(project.local_directory_path) / folder_name / analysis.analysis_uuid

    fitted_candidates = []
    if step_name:
        fitted_candidates.extend([
            run_dir / step_name / "Parameters" / "fitted.toml",
            run_dir / "Output" / step_name / "Parameters" / "fitted.toml",
            run_dir / step_name / "All" / "Parameters" / "fitted.toml",
            run_dir / "Output" / step_name / "All" / "Parameters" / "fitted.toml",
        ])
    fitted_candidates.extend([
        run_dir / "Output" / "All" / "Parameters" / "fitted.toml",
        run_dir / "All" / "Parameters" / "fitted.toml",
        run_dir / "Output" / "STEP2" / "Parameters" / "fitted.toml",
        run_dir / "STEP2" / "Parameters" / "fitted.toml",
        run_dir / "Output" / "STEP1" / "Parameters" / "fitted.toml",
        run_dir / "STEP1" / "Parameters" / "fitted.toml",
        run_dir / "Output" / "Parameters" / "fitted.toml",
        run_dir / "Parameters" / "fitted.toml",
    ])

    det_map: Dict[str, float] = {}
    for p in fitted_candidates:
        if p.is_file():
            try:
                data = tomllib.loads(p.read_text(encoding="utf-8"))
                for section, val in data.items():
                    if isinstance(val, dict):
                        for sub_k, sub_v in val.items():
                            if isinstance(sub_v, (int, float)):
                                det_map[f"{section}, {sub_k}"] = float(sub_v)
                                det_map[f"{section}, NUC->{sub_k}"] = float(sub_v)
                                det_map[sub_k] = float(sub_v)
                                det_map[f"{section}_{sub_k}"] = float(sub_v)
                    elif isinstance(val, (int, float)):
                        det_map[section] = float(val)
                if det_map:
                    return det_map
            except Exception:
                pass

    # Per-group fitted.toml
    group_parents = [
        run_dir / "Output" / "Groups",
        run_dir / "Groups",
        run_dir / "Output" / "STEP2" / "Groups",
        run_dir / "STEP2" / "Groups",
    ]
    for g_parent in group_parents:
        if g_parent.is_dir():
            for g_dir in g_parent.iterdir():
                fitted_f = g_dir / "Parameters" / "fitted.toml"
                if fitted_f.is_file():
                    try:
                        data = tomllib.loads(fitted_f.read_text(encoding="utf-8"))
                        for section, val in data.items():
                            if isinstance(val, dict):
                                for sub_k, sub_v in val.items():
                                    if isinstance(sub_v, (int, float)):
                                        det_map[f"{section}, {sub_k}"] = float(sub_v)
                                        det_map[f"{section}, NUC->{sub_k}"] = float(sub_v)
                                        det_map[sub_k] = float(sub_v)
                                        det_map[f"{section}_{sub_k}"] = float(sub_v)
                            elif isinstance(val, (int, float)):
                                det_map[section] = float(val)
                    except Exception:
                        pass
    return det_map


@router.get("/{analysis_uuid}/statistics/summary")
def get_statistics_summary(
    analysis: models.Analysis = Depends(get_analysis),
    method_name: str = "monte_carlo",
    step_name: Optional[str] = None,
):
    """Return per-parameter statistical summary derived from replicate matrix across all groups."""
    from ..services.fitting.statistics_engine import compute_parameter_summary, load_replicates_or_fallback
    method_dirs = _locate_all_statistics_method_dirs(analysis, method_name, step_name)
    det_vals = _get_step_deterministic_values(analysis, step_name)

    merged_summary = {}
    all_parameters = []
    total_samples = 0

    for m_dir in method_dirs:
        rep_data = load_replicates_or_fallback(m_dir, method_name)
        if rep_data and rep_data.get("replicates") is not None and len(rep_data["parameter_names"]) > 0:
            summary = compute_parameter_summary(
                rep_data["replicates"],
                rep_data["parameter_names"],
                deterministic_values=det_vals,
            )
            merged_summary.update(summary)
            all_parameters.extend(rep_data["parameter_names"])
            total_samples = max(total_samples, rep_data["replicates"].shape[0])

    if not merged_summary:
        raise HTTPException(status_code=404, detail="No replicate matrix available for this technique.")

    return {
        "analysis_uuid": analysis.analysis_uuid,
        "method_name": method_name,
        "step_name": step_name or "primary",
        "sample_count": total_samples,
        "parameters": all_parameters,
        "summary": merged_summary,
    }


@router.get("/{analysis_uuid}/statistics/histogram")
def get_parameter_histogram(
    parameter_name: str,
    analysis: models.Analysis = Depends(get_analysis),
    method_name: str = "monte_carlo",
    step_name: Optional[str] = None,
    bins: Optional[int] = None,
):
    """Return server-side Freedman-Diaconis binned histogram counts and edges for single/grouped fits."""
    from ..services.fitting.statistics_engine import compute_parameter_histogram, load_replicates_or_fallback, clean_param_name
    method_dirs = _locate_all_statistics_method_dirs(analysis, method_name, step_name)
    det_vals = _get_step_deterministic_values(analysis, step_name)
    det_val = det_vals.get(parameter_name) or det_vals.get(clean_param_name(parameter_name))

    clean_target = clean_param_name(parameter_name).lower()

    for m_dir in method_dirs:
        rep_data = load_replicates_or_fallback(m_dir, method_name)
        if rep_data and rep_data.get("replicates") is not None:
            p_names = rep_data["parameter_names"]
            match_found = any(clean_param_name(p).lower() == clean_target for p in p_names)
            if match_found:
                hist_data = compute_parameter_histogram(
                    rep_data["replicates"],
                    p_names,
                    target_param=parameter_name,
                    bins=bins,
                    deterministic_value=det_val,
                )
                if hist_data is not None:
                    return hist_data

    raise HTTPException(status_code=404, detail=f"Parameter '{parameter_name}' not found in replicate matrix.")


@router.get("/{analysis_uuid}/statistics/joint-distribution")
def get_joint_distribution(
    param_x: str,
    param_y: str,
    analysis: models.Analysis = Depends(get_analysis),
    method_name: str = "monte_carlo",
    step_name: Optional[str] = None,
    bins: int = 25,
):
    """Return 2D joint density matrix and correlation r for a parameter pair in single/grouped fits."""
    from ..services.fitting.statistics_engine import compute_joint_2d_distribution, load_replicates_or_fallback, clean_param_name
    import numpy as np
    method_dirs = _locate_all_statistics_method_dirs(analysis, method_name, step_name)
    det_vals = _get_step_deterministic_values(analysis, step_name)
    det_x = det_vals.get(param_x) or det_vals.get(clean_param_name(param_x))
    det_y = det_vals.get(param_y) or det_vals.get(clean_param_name(param_y))

    clean_x = clean_param_name(param_x).lower()
    clean_y = clean_param_name(param_y).lower()

    # 1. First check if both parameters reside in the same group
    for m_dir in method_dirs:
        rep_data = load_replicates_or_fallback(m_dir, method_name)
        if rep_data and rep_data.get("replicates") is not None:
            p_names = rep_data["parameter_names"]
            has_x = any(clean_param_name(p).lower() == clean_x for p in p_names)
            has_y = any(clean_param_name(p).lower() == clean_y for p in p_names)
            if has_x and has_y:
                joint_data = compute_joint_2d_distribution(
                    rep_data["replicates"],
                    p_names,
                    param_x=param_x,
                    param_y=param_y,
                    bins=bins,
                    x_deterministic=det_x,
                    y_deterministic=det_y,
                )
                if joint_data is not None:
                    return joint_data

    # 2. If in different groups, merge aligned columns
    col_x, col_y = None, None
    for m_dir in method_dirs:
        rep_data = load_replicates_or_fallback(m_dir, method_name)
        if rep_data and rep_data.get("replicates") is not None:
            for idx, p in enumerate(rep_data["parameter_names"]):
                if clean_param_name(p).lower() == clean_x and col_x is None:
                    col_x = rep_data["replicates"][:, idx]
                if clean_param_name(p).lower() == clean_y and col_y is None:
                    col_y = rep_data["replicates"][:, idx]

    if col_x is not None and col_y is not None and len(col_x) == len(col_y):
        merged_reps = np.column_stack([col_x, col_y])
        joint_data = compute_joint_2d_distribution(
            merged_reps,
            [param_x, param_y],
            param_x=param_x,
            param_y=param_y,
            bins=bins,
            x_deterministic=det_x,
            y_deterministic=det_y,
        )
        if joint_data is not None:
            return joint_data

    raise HTTPException(status_code=404, detail="One or both parameters not found in replicate matrix.")


@router.get("/{analysis_uuid}/statistics/download/replicates")
def download_replicates(
    analysis: models.Analysis = Depends(get_analysis),
    method_name: str = "monte_carlo",
    step_name: Optional[str] = None,
    format: str = "csv",
):
    """Download raw replicates matrix as CSV or compressed NPZ archive across single/grouped fits."""
    import io
    import csv
    import numpy as np
    from fastapi.responses import FileResponse, StreamingResponse
    from ..services.fitting.statistics_engine import load_replicates_or_fallback

    method_dirs = _locate_all_statistics_method_dirs(analysis, method_name, step_name)
    all_p_names = []
    all_reps_cols = []
    chisqr_col = None

    for m_dir in method_dirs:
        rep_data = load_replicates_or_fallback(m_dir, method_name)
        if rep_data and rep_data.get("replicates") is not None:
            for idx, p in enumerate(rep_data["parameter_names"]):
                all_p_names.append(p)
                all_reps_cols.append(rep_data["replicates"][:, idx])
            if chisqr_col is None and rep_data.get("chisqr") is not None:
                chisqr_col = rep_data["chisqr"]

    if not all_reps_cols:
        raise HTTPException(status_code=404, detail="No replicate matrix available to download.")

    min_len = min(len(c) for c in all_reps_cols)
    merged_reps = np.column_stack([c[:min_len] for c in all_reps_cols])

    if format.lower() == "npz":
        mem_buf = io.BytesIO()
        np.savez_compressed(mem_buf, replicates=merged_reps, parameter_names=all_p_names, chisqr=chisqr_col[:min_len] if chisqr_col is not None else None)
        mem_buf.seek(0)
        return StreamingResponse(
            mem_buf,
            media_type="application/octet-stream",
            headers={
                "Content-Disposition": f'attachment; filename="{method_name}_replicates_{analysis.analysis_uuid}.npz"'
            },
        )

    # CSV export
    output = io.StringIO()
    writer = csv.writer(output)
    csv_headers = list(all_p_names)
    has_chisqr = chisqr_col is not None and len(chisqr_col) >= min_len
    if has_chisqr:
        csv_headers.append("chisqr")
    writer.writerow(csv_headers)

    for i in range(min_len):
        row = merged_reps[i].tolist()
        if has_chisqr:
            row.append(float(chisqr_col[i]))
        writer.writerow(row)

    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={
            "Content-Disposition": f'attachment; filename="{method_name}_replicates_{analysis.analysis_uuid}.csv"'
        },
    )


@router.get("/{analysis_uuid}/chemex-results")
def get_typed_chemex_results(
    analysis: models.Analysis = Depends(get_analysis),
):
    """
    Return fully typed, protocol-conforming ChemEx output tree results (docs/chemex-output-protocol.md).
    Includes discriminated RunState, provisional status, separate deterministic fit and statistics,
    restart checkpoint status, and structured warnings.
    """
    from ..services.fitting.chemex_output import parse_output_tree
    from pathlib import Path

    project = analysis.project
    is_cpmg = analysis.analysis_type.upper() == "CPMG"
    folder_name = "cpmg_fitting" if is_cpmg else "cest_fitting"
    run_dir = Path(project.local_directory_path) / folder_name / analysis.analysis_uuid

    if not run_dir.exists():
        raise HTTPException(status_code=404, detail="Analysis directory not found on disk.")

    parsed = parse_output_tree(run_dir)
    return sanitize_floats_for_json(parsed.model_dump())


@router.get("/{analysis_uuid}/restart-config")
def get_restart_config(
    analysis: models.Analysis = Depends(get_analysis),
):
    """
    Retrieve restart parameter checkpoint configuration (restart.toml) for continuation runs.
    """
    from ..services.fitting.chemex_output import parse_output_tree
    from pathlib import Path

    project = analysis.project
    is_cpmg = analysis.analysis_type.upper() == "CPMG"
    folder_name = "cpmg_fitting" if is_cpmg else "cest_fitting"
    run_dir = Path(project.local_directory_path) / folder_name / analysis.analysis_uuid

    if not run_dir.exists():
        raise HTTPException(status_code=404, detail="Analysis directory not found on disk.")

    parsed = parse_output_tree(run_dir)
    content = None
    if parsed.restart_file_path and Path(parsed.restart_file_path).exists():
        try:
            content = Path(parsed.restart_file_path).read_text(encoding="utf-8")
        except Exception:
            content = None

    return {
        "analysis_uuid": analysis.analysis_uuid,
        "available": parsed.can_continue_fit,
        "restart_file_path": parsed.restart_file_path,
        "explanation": parsed.continue_explanation,
        "content": content,
    }


@router.get("/{analysis_uuid}/cest/profiles")
def get_cest_profiles(
    analysis: models.Analysis = Depends(get_analysis),
    db: Session = Depends(database.get_db),
):
    """
    Get CEST profile data from the data files referenced in the analysis config.
    Returns profile data for each residue for the Pick CEST interface.
    """
    project = analysis.project
    run_dir = os.path.join(project.local_directory_path, "cest_fitting", analysis.analysis_uuid)
    config_path = os.path.join(run_dir, "config.json")

    if not os.path.exists(config_path):
        return {"profiles": []}

    with open(config_path, "r") as f:
        config = json.load(f)

    data_files = config.get("data_files", {})
    grouped_profiles = {}  # residue -> list of experiment data

    for key, filepath in data_files.items():
        if ":" in key:
            residue_name, b1_label = key.split(":", 1)
        else:
            residue_name, b1_label = key, "unknown"

        if not os.path.exists(filepath):
            continue

        try:
            offsets = []
            intensities = []
            uncertainties = []
            with open(filepath, "r") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    parts = line.split()
                    if len(parts) >= 2:
                        offsets.append(float(parts[0]))
                        intensities.append(float(parts[1]))
                        if len(parts) >= 3:
                            uncertainties.append(float(parts[2]))
                        else:
                            uncertainties.append(0.0)

            if residue_name not in grouped_profiles:
                grouped_profiles[residue_name] = []

            # Find metadata for this b1 (b0 and carrier) with safe defaults
            metadata = config.get("metadata", {}).get(b1_label, {})

            grouped_profiles[residue_name].append({
                "b1": b1_label,
                "b1_actual": metadata.get("b1") or 0.0,
                "b0": metadata.get("b0") or 600.0,
                "carrier": metadata.get("carrier") or 0.0,
                "offsets": offsets,
                "intensities": intensities,
                "uncertainties": uncertainties,
                "filepath": filepath,
            })
        except Exception as e:
            if residue_name not in grouped_profiles:
                grouped_profiles[residue_name] = []
            grouped_profiles[residue_name].append({
                "b1": b1_label,
                "error": str(e),
                "filepath": filepath,
            })

    # Convert dictionary to sorted list of profiles
    profiles = []
    residue_mapping = config.get("residue_mapping", {})
    for res in sorted(grouped_profiles.keys()):
        profiles.append({
            "residue": res,
            "full_residue": residue_mapping.get(res, res),
            "experiments": grouped_profiles[res]
        })

    return {"profiles": profiles}


# 15N gyromagnetic ratio relative to 1H
GAMMA_N15_RATIO = 0.10136  # γ(15N) / γ(1H)


def _parse_f3list(path: str) -> list:
    """Parse f3list file (ppm values, one per line)."""
    values = []
    with open(path, "r") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            try:
                values.append(float(line))
            except ValueError:
                pass
    return values


@router.post("/{analysis_uuid}/cest/generate")
def generate_cest_files(
    request: dict,
    analysis: models.Analysis = Depends(get_analysis),
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(security.get_current_user),
):
    """
    Generate CEST data files and experiment TOMLs from fitted spectra.

    Reads peak-fitted results from selected CEST spectra, computes offsets
    from f3list & carrier, and writes per-residue data files organized by B1.
    Also generates experiment TOML files.

    Expects JSON body:
      - spectrum_ids: list[int]   (IDs of CEST spectra to include)
      - use_height: bool          (use height instead of amplitude, default true)
    """
    if analysis.analysis_type != "15N-CEST":
        raise HTTPException(status_code=400, detail="Only for 15N-CEST analyses")

    spectrum_ids = request.get("spectrum_ids", [])
    use_height = request.get("use_height", True)

    if not spectrum_ids:
        raise HTTPException(status_code=400, detail="No spectra selected")

    project = analysis.project
    run_dir = os.path.join(project.local_directory_path, "cest_fitting", analysis.analysis_uuid)
    data_dir = os.path.join(run_dir, "data")
    experiments_dir = os.path.join(run_dir, "experiments")
    os.makedirs(data_dir, exist_ok=True)
    os.makedirs(experiments_dir, exist_ok=True)

    spectra = db.query(models.Spectrum).filter(models.Spectrum.id.in_(spectrum_ids)).all()
    if not spectra:
        raise HTTPException(status_code=404, detail="No spectra found with the given IDs")

    val_field = "height" if use_height else "amp"
    err_field = "height_err" if use_height else "amp_err"

    generated_data_files = {}
    experiment_tomls = []
    all_residues = set()
    residue_mapping = {}
    skipped_reasons = []

    for spectrum in spectra:
        spec_label = f"Spectrum '{spectrum.name}' (ID: {spectrum.id})"
        b1 = getattr(spectrum, "b1", None)
        b0 = getattr(spectrum, "b0", None)
        carrier = getattr(spectrum, "carrier", None)
        t_relax = getattr(spectrum, "t_relax", None)

        missing_params = []
        if b1 is None: missing_params.append("B1 (Hz)")
        if b0 is None: missing_params.append("B0 (MHz)")
        if carrier is None: missing_params.append("Carrier (ppm)")
        if t_relax is None: missing_params.append("T_relax (s)")
        if missing_params:
            skipped_reasons.append(f"{spec_label}: missing parameters ({', '.join(missing_params)})")
            continue

        if not spectrum.f3list_path or not os.path.exists(spectrum.f3list_path):
            skipped_reasons.append(f"{spec_label}: f3list file not found at '{spectrum.f3list_path or ''}'")
            continue

        if not spectrum.results_json_path or not os.path.exists(spectrum.results_json_path):
            skipped_reasons.append(f"{spec_label}: peak fitting results not found at '{spectrum.results_json_path or ''}'")
            continue

        # Calculate 15N Larmor frequency in MHz
        n15_larmor_mhz = b0 * GAMMA_N15_RATIO

        # Parse f3list (ppm values)
        freq_list_ppm = _parse_f3list(spectrum.f3list_path)
        if not freq_list_ppm:
            skipped_reasons.append(f"{spec_label}: f3list file at '{spectrum.f3list_path}' is empty or invalid")
            continue


        import numpy as np
        freq_arr = np.array(freq_list_ppm)
        # Convert ppm offsets to Hz: (freq_ppm - carrier_ppm) * larmor_freq_MHz
        offsets_hz = (freq_arr - carrier) * n15_larmor_mhz

        # Create B1-specific data directory
        b1_label = f"{b1:.0f}hz"
        b1_dir = os.path.join(data_dir, b1_label)
        os.makedirs(b1_dir, exist_ok=True)

        # Load fitted results
        with open(spectrum.results_json_path, "r") as f:
            fit_data = json.load(f)

        results = fit_data.get("results", [])

        # Group by assignment to handle both flat and nested formats
        assignments = {}
        for peak in results:
            ass = peak.get("assignment")
            if not ass:
                continue
            if ass not in assignments:
                assignments[ass] = {
                    "res_num": peak.get("res_num") or peak.get("RES_NUM"),
                    "res_name": peak.get("res_name") or peak.get("RES_NAME"),
                    "planes": [],
                }
            # Nested format
            if "planes" in peak:
                for plane in sorted(peak["planes"], key=lambda p: p.get("plane", 0)):
                    assignments[ass]["planes"].append(plane)
            else:
                assignments[ass]["planes"].append(peak)

        # For each residue, write a data file
        residue_files = {}
        for ass, data in assignments.items():
            planes = sorted(data["planes"], key=lambda p: p.get("plane", 0))

            plane_offsets = list(offsets_hz)
            if len(planes) > len(plane_offsets):
                # Assume the extra initial planes are reference scans (offset = -100000.0 Hz)
                num_refs = len(planes) - len(plane_offsets)
                plane_offsets = [-100000.0] * num_refs + plane_offsets

            if len(planes) != len(plane_offsets):
                continue  # Still a mismatch, ignore this residue

            # Amino acid mapping: 3-letter to single-letter
            AA_MAP = {
                'ALA': 'A', 'ARG': 'R', 'ASN': 'N', 'ASP': 'D', 'CYS': 'C',
                'GLU': 'E', 'GLN': 'Q', 'GLY': 'G', 'HIS': 'H', 'ILE': 'I',
                'LEU': 'L', 'LYS': 'K', 'MET': 'M', 'PHE': 'F', 'PRO': 'P',
                'SER': 'S', 'THR': 'T', 'TRP': 'W', 'TYR': 'Y', 'VAL': 'V'
            }

            res_num = data.get("res_num", "")
            res_name = data.get("res_name", "")
            
            # Full residue label with 1-letter prefix (for UI tracking)
            if res_num and res_name:
                res_single = AA_MAP.get(res_name.upper(), res_name)
                full_residue_label = f"{res_single}{res_num}N"
            elif res_num:
                full_residue_label = f"{res_num}N"
            else:
                full_residue_label = ass.replace(" ", "")

            # Short residue label for ChemEx (no 1-letter prefix)
            if res_num:
                residue_label = f"{res_num}N"
            else:
                residue_label = full_residue_label

            residue_mapping[residue_label] = full_residue_label
            
            filename = f"{residue_label}-HN.out"
            filepath = os.path.join(b1_dir, filename)

            lines = ["#Offset (Hz)        Intensity    Uncertainty"]
            for i, plane in enumerate(planes):
                offset = plane_offsets[i]
                intensity = plane.get(val_field, 0.0)
                uncertainty = plane.get(err_field, 0.0)
                if uncertainty == 0.0:
                    # Fallback: estimate as 1% of max intensity
                    uncertainty = abs(intensity) * 0.01
                lines.append(f"  {offset:12.3e}   {intensity:15.7e}  {uncertainty:13.7e}")

            with open(filepath, "w") as f:
                f.write("\n".join(lines) + "\n")

            residue_files[residue_label] = filename
            all_residues.add(residue_label)
            generated_data_files[f"{residue_label}:{b1_label}"] = filepath

        # Read excluded residues from request or existing config
        config_path = os.path.join(run_dir, "config.json")
        existing_cfg_temp = {}
        if os.path.exists(config_path):
            try:
                with open(config_path, "r") as f:
                    existing_cfg_temp = json.load(f)
            except Exception:
                pass

        param_cfg_temp = existing_cfg_temp.get("parameter_config") or {}
        excluded_residues = set(
            request.get("excluded_residues", [])
            or param_cfg_temp.get("excludedResidues", [])
            or existing_cfg_temp.get("excluded_residues", [])
            or []
        )

        from ..services.fitting.spin_system import SpinSystemKey
        parsed_exclusions = [SpinSystemKey.parse(str(r)) for r in excluded_residues]
        excluded_nums = {sp.res_num for sp in parsed_exclusions if sp.res_num > 0}
        excluded_canonical = {sp.canonical.upper() for sp in parsed_exclusions if sp.canonical}
        excluded_raw = {str(r).strip().upper() for r in excluded_residues}

        def is_res_excluded(res_str: str) -> bool:
            if res_str.upper() in excluded_raw:
                return True
            sp = SpinSystemKey.parse(res_str)
            if sp.canonical and sp.canonical.upper() in excluded_canonical:
                return True
            if sp.res_num and sp.res_num in excluded_nums:
                return True
            return False

        # Generate experiment TOML for this B1 field
        profiles_lines = []
        for res, fname in sorted(residue_files.items()):
            if is_res_excluded(res):
                profiles_lines.append(f'# {res} = "{fname}"')
            else:
                profiles_lines.append(f'{res} = "{fname}"')
        profiles_section = "\n".join(profiles_lines)

        # Module name from request or config (defaults to cest_15n)
        module_name = request.get("selected_module") or request.get("module_name") or existing_cfg_temp.get("selected_module") or "cest_15n"

        # B1 distribution config (defaults to dephasing)
        b1_dist = request.get("b1_distribution") or existing_cfg_temp.get("b1_distribution") or {"type": "dephasing"}
        b1_dist_type = b1_dist.get("type", "dephasing") if isinstance(b1_dist, dict) else "dephasing"
        b1_dist_lines = [f'  [experiment.b1_distribution]', f'  type = "{b1_dist_type}"']
        if isinstance(b1_dist, dict):
            if "scale" in b1_dist and b1_dist["scale"] is not None:
                b1_dist_lines.append(f'  scale = {b1_dist["scale"]}')
            if "res" in b1_dist and b1_dist["res"] is not None:
                b1_dist_lines.append(f'  res = {b1_dist["res"]}')
            if "skew" in b1_dist and b1_dist["skew"] is not None:
                b1_dist_lines.append(f'  skew = {b1_dist["skew"]}')
        b1_dist_section = "\n".join(b1_dist_lines)

        # Extra module-specific fields
        extra_exp_lines = []
        if module_name == "cest_15n_cw":
            carrier_dec = request.get("carrier_dec") if request.get("carrier_dec") is not None else existing_cfg_temp.get("carrier_dec", 8.5)
            b1_frq_dec = request.get("b1_frq_dec") if request.get("b1_frq_dec") is not None else existing_cfg_temp.get("b1_frq_dec", 2000.0)
            extra_exp_lines.append(f'carrier_dec  = {carrier_dec}')
            extra_exp_lines.append(f'b1_frq_dec   = {b1_frq_dec}')
        elif module_name == "cest_15n_tr":
            antitrosy = request.get("antitrosy") if request.get("antitrosy") is not None else existing_cfg_temp.get("antitrosy", False)
            extra_exp_lines.append(f'antitrosy    = {str(bool(antitrosy)).lower()}')
        elif module_name in ("cest_1hn_ip_ap", "cest_ch3_1h_ip_ap"):
            d1_val = request.get("d1") if request.get("d1") is not None else existing_cfg_temp.get("d1", 1.0)
            taua_val = request.get("taua") if request.get("taua") is not None else existing_cfg_temp.get("taua", 0.002)
            extra_exp_lines.append(f'd1           = {d1_val}')
            extra_exp_lines.append(f'taua         = {taua_val}')
            if module_name == "cest_1hn_ip_ap":
                eta_block = request.get("eta_block") if request.get("eta_block") is not None else existing_cfg_temp.get("eta_block", False)
                extra_exp_lines.append(f'eta_block    = {str(bool(eta_block)).lower()}')

        extra_exp_str = ("\n" + "\n".join(extra_exp_lines)) if extra_exp_lines else ""

        # Data filters and error type
        filter_offsets = request.get("filter_offsets") or existing_cfg_temp.get("filter_offsets") or [[0.0, float(b1)]]
        filter_planes = request.get("filter_planes") if request.get("filter_planes") is not None else existing_cfg_temp.get("filter_planes")
        data_error = request.get("data_error") or existing_cfg_temp.get("data_error") or "scatter"

        data_filter_lines = [f'error          = "{data_error}"', f'filter_offsets = {json.dumps(filter_offsets)}']
        if filter_planes:
            data_filter_lines.append(f'filter_planes  = {json.dumps(filter_planes)}')
        data_filter_str = "\n".join(data_filter_lines)

        exp_toml = f"""[experiment]
name         = "{module_name}"
time_t1      = {t_relax}
carrier      = {carrier}
b1_frq       = {b1}{extra_exp_str}
{b1_dist_section}

[conditions]
h_larmor_frq = {b0}
# temperature = {spectrum.temperature or 298.15}

[data]
path           = "../data/{b1_label}"
{data_filter_str}
  [data.profiles]
{profiles_section}
"""
        exp_filename = f"{module_name}_{b1_label}.toml"
        exp_path = os.path.join(experiments_dir, exp_filename)
        with open(exp_path, "w") as f:
            f.write(exp_toml)

        experiment_tomls.append({
            "b1": b1,
            "b1_label": b1_label,
            "filename": exp_filename,
            "path": exp_path,
            "toml_content": exp_toml,
            "residue_count": len(residue_files),
        })

    # Collect metadata per B1 label (using standardized rounding for keys, exact floats for values)
    metadata = {}
    for spectrum in spectra:
        b1_val = getattr(spectrum, "b1", 0.0)
        b1_lbl = f"{b1_val:.0f}hz"
        metadata[b1_lbl] = {
            "b1": b1_val,
            "b0": getattr(spectrum, "b0", 600.0),
            "carrier": getattr(spectrum, "carrier", 0.0),
        }

    if not experiment_tomls or not generated_data_files:
        error_detail = "Failed to generate CEST data files. " + " ".join(skipped_reasons) if skipped_reasons else "No matching peaks or planes found for the selected spectra."
        raise HTTPException(status_code=400, detail=error_detail)

    # Save config with generated info
    config_path = os.path.join(run_dir, "config.json")
    existing_config = {}
    if os.path.exists(config_path):
        with open(config_path, "r") as f:
            existing_config = json.load(f)

    existing_config["data_files"] = generated_data_files
    existing_config["experiments_dir"] = experiments_dir
    existing_config["data_dir"] = data_dir
    existing_config["spectrum_ids"] = spectrum_ids
    existing_config["generatedExperiments"] = experiment_tomls
    existing_config["metadata"] = metadata
    existing_config["residue_mapping"] = residue_mapping

    with open(config_path, "w") as f:
        json.dump(existing_config, f, indent=2)

    params = json.loads(analysis.parameters) if analysis.parameters else {}
    params["config_path"] = config_path
    analysis.parameters = json.dumps(params)
    db.commit()

    return {
        "message": "CEST data files and experiment TOMLs generated",
        "experiments": experiment_tomls,
        "total_residues": len(all_residues),
        "total_data_files": len(generated_data_files),
        "run_dir": run_dir,
    }


def _locate_analysis_run_dir(analysis: models.Analysis) -> Path:
    from pathlib import Path
    project = analysis.project
    is_cpmg = analysis.analysis_type.upper() == "CPMG"
    folder_name = "cpmg_fitting" if is_cpmg else "cest_fitting"
    return Path(project.local_directory_path) / folder_name / analysis.analysis_uuid


def _locate_step_grid_dir(run_dir: Path, step_name: str) -> Optional[Path]:
    clean_step = step_name.strip()
    candidates = []
    if clean_step and clean_step.lower() != "root":
        candidates.extend([
            run_dir / clean_step / "Grid",
            run_dir / "Output" / clean_step / "Grid",
            run_dir / clean_step / "All" / "Grid",
            run_dir / "Output" / clean_step / "All" / "Grid",
        ])
    candidates.extend([
        run_dir / "Grid",
        run_dir / "Output" / "Grid",
        run_dir / "All" / "Grid",
        run_dir / "Output" / "All" / "Grid",
    ])
    for p in candidates:
        if p.is_dir():
            return p
    return None


def _get_analysis_residue_mapping(run_dir: Path) -> dict[str, str]:
    for cfg in ("config.json", "cpmg_config.json"):
        cfg_path = run_dir / cfg
        if cfg_path.exists():
            try:
                with open(cfg_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    return data.get("residue_mapping", {})
            except Exception:
                pass
def _lookup_fitted_param(step_res, pname: str, group_str: Optional[str] = None) -> Optional[float]:
    if not step_res:
        return None
    base_p = pname.split(",")[0].strip()
    p_clean = pname.strip().strip("[]")
    # 1. Check globals
    if step_res.globals:
        for cand in (pname, p_clean, base_p, pname.lower(), p_clean.lower(), base_p.lower()):
            if cand in step_res.globals and step_res.globals[cand].value is not None:
                return float(step_res.globals[cand].value)
    # 2. Check residues
    if step_res.residues:
        res_candidates = []
        if "NUC->" in pname:
            res_candidates.append(pname.split("NUC->")[1].split("]")[0].strip())
        if group_str:
            from ..services.fitting.chemex_output.grid_parser import extract_residue_label_from_filename
            res_candidates.append(extract_residue_label_from_filename(group_str))
            res_candidates.append(group_str)
        for r_key in res_candidates:
            if r_key in step_res.residues and step_res.residues[r_key].parameters:
                params_dict = step_res.residues[r_key].parameters
                for cand in (pname, p_clean, base_p, pname.lower(), p_clean.lower(), base_p.lower()):
                    if cand in params_dict and params_dict[cand].value is not None:
                        return float(params_dict[cand].value)
    return None


@router.get("/{analysis_uuid}/steps/{step_name}/grid")
def get_step_grid_info(
    step_name: str,
    analysis: models.Analysis = Depends(get_analysis),
):
    """
    Get grid metadata, parameters, specs, groups, and PDF availability for a step.
    """
    from ..services.fitting.chemex_output import (
        parse_output_tree,
        parse_grid_directory,
        get_grid_data_for_group,
        compute_grid_minimum,
    )
    from pathlib import Path

    run_dir = _locate_analysis_run_dir(analysis)
    if not run_dir.exists():
        raise HTTPException(status_code=404, detail="Analysis directory not found on disk.")

    res_map = _get_analysis_residue_mapping(run_dir)
    grid_dir = _locate_step_grid_dir(run_dir, step_name)

    if not grid_dir:
        return {
            "analysis_uuid": analysis.analysis_uuid,
            "step_name": step_name,
            "has_grid": False,
            "parameters": [],
            "specs": {},
            "groups": [],
            "has_1d_pdf": False,
            "has_2d_pdf": False,
            "min_point": None,
            "fitted_point": None,
        }

    run_info_dir = run_dir / "run_info" if (run_dir / "run_info").exists() else (run_dir / "Output" / "run_info")
    grid_res = parse_grid_directory(
        grid_dir,
        [],
        step_name=step_name,
        run_info_dir=run_info_dir,
        residue_labels_map=res_map,
    )

    if not grid_res or not grid_res.has_grid:
        return {
            "analysis_uuid": analysis.analysis_uuid,
            "step_name": step_name,
            "has_grid": False,
            "parameters": [],
            "specs": {},
            "groups": [],
            "has_1d_pdf": False,
            "has_2d_pdf": False,
            "min_point": None,
            "fitted_point": None,
        }

    min_point = None
    fitted_point = {}
    try:
        from ..services.fitting.chemex_output import load_grid_file
        global_params, agg_data, _ = get_grid_data_for_group(grid_dir, None, residue_mapping=res_map)
        global_min = compute_grid_minimum(global_params, agg_data)
        all_min_coords = dict(global_min["coordinates"])

        out_files = sorted((grid_dir / "Groups").glob("*.out"))
        for f in out_files:
            pnames, g_data = load_grid_file(f)
            g_min = compute_grid_minimum(pnames, g_data)
            for p in pnames:
                if p not in global_params and p in g_min["coordinates"]:
                    all_min_coords[p] = g_min["coordinates"][p]

        min_point = {
            "chisqr": global_min["chisqr"],
            "coordinates": all_min_coords,
            "point_index": global_min.get("point_index"),
        }
    except Exception:
        pass

    # Extract fitted point for this step if available
    try:
        out_tree = parse_output_tree(run_dir if (run_dir / "run_info").exists() else (run_dir / "Output"))
        step_res = out_tree.steps.get(step_name)
        if step_res:
            for p in grid_res.parameters:
                val = _lookup_fitted_param(step_res, p)
                if val is not None:
                    fitted_point[p] = val
    except Exception:
        pass

    return sanitize_floats_for_json({
        "analysis_uuid": analysis.analysis_uuid,
        "step_name": step_name,
        "has_grid": True,
        "parameters": grid_res.parameters,
        "specs": {k: v.model_dump() for k, v in grid_res.specs.items()},
        "groups": [g.model_dump() for g in grid_res.groups],
        "has_1d_pdf": bool(grid_res.grid_1d_pdf),
        "has_2d_pdf": bool(grid_res.grid_2d_pdf),
        "min_point": min_point,
        "fitted_point": fitted_point,
    })


@router.get("/{analysis_uuid}/steps/{step_name}/grid/plots/{filename}")
def get_grid_plot_pdf(
    step_name: str,
    filename: str,
    analysis: models.Analysis = Depends(get_analysis),
):
    """
    Stream the raw grid_1d.pdf or grid_2d.pdf.
    """
    from fastapi.responses import FileResponse
    run_dir = _locate_analysis_run_dir(analysis)
    grid_dir = _locate_step_grid_dir(run_dir, step_name)
    if not grid_dir:
        raise HTTPException(status_code=404, detail="Grid directory not found for this step.")

    if filename not in ("grid_1d.pdf", "grid_2d.pdf"):
        raise HTTPException(status_code=400, detail=f"Invalid grid plot filename: {filename}")

    target = grid_dir / filename
    if not target.is_file():
        raise HTTPException(status_code=404, detail=f"{filename} not found on disk.")

    return FileResponse(
        path=str(target),
        media_type="application/pdf",
        filename=f"{step_name}_{filename}",
    )


@router.get("/{analysis_uuid}/steps/{step_name}/grid/1d")
def get_grid_1d_profiles(
    step_name: str,
    param: Optional[str] = None,
    group: Optional[str] = None,
    analysis: models.Analysis = Depends(get_analysis),
):
    """
    Get 1D profile likelihood curves minimizing chi-square over other parameters.
    """
    from ..services.fitting.chemex_output import (
        load_grid_file,
        get_grid_data_for_group,
        compute_1d_profiles,
        compute_grid_minimum,
        parse_output_tree,
    )
    run_dir = _locate_analysis_run_dir(analysis)
    grid_dir = _locate_step_grid_dir(run_dir, step_name)
    if not grid_dir:
        raise HTTPException(status_code=404, detail="Grid directory not found for this step.")

    res_map = _get_analysis_residue_mapping(run_dir)
    out_tree = None
    try:
        out_tree = parse_output_tree(run_dir if (run_dir / "run_info").exists() else (run_dir / "Output"))
    except Exception:
        pass
    step_res = out_tree.steps.get(step_name) if out_tree else None

    if group:
        try:
            param_names, data, resolved_group = get_grid_data_for_group(
                grid_dir, group=group, residue_mapping=res_map
            )
        except Exception as e:
            raise HTTPException(status_code=404, detail=str(e))

        profiles = compute_1d_profiles(param_names, data, target_param=param)
        min_info = compute_grid_minimum(param_names, data)

        for prof in profiles:
            prof["fitted_val"] = _lookup_fitted_param(step_res, prof["parameter"], group_str=group) if step_res else None

        return sanitize_floats_for_json({
            "step_name": step_name,
            "group": resolved_group,
            "parameters": param_names,
            "profiles": profiles,
            "min_point": min_info,
        })
    else:
        try:
            global_params, agg_data, _ = get_grid_data_for_group(
                grid_dir, group=None, residue_mapping=res_map
            )
        except Exception as e:
            raise HTTPException(status_code=404, detail=str(e))

        global_profiles = compute_1d_profiles(global_params, agg_data, target_param=param)
        global_min = compute_grid_minimum(global_params, agg_data)

        for prof in global_profiles:
            prof["fitted_val"] = _lookup_fitted_param(step_res, prof["parameter"]) if step_res else None

        all_profiles = []
        all_min_coords = dict(global_min["coordinates"])
        all_param_names = []

        # Gather per-group profiles (e.g. DW_AB for each group)
        out_files = sorted((grid_dir / "Groups").glob("*.out"))
        for f in out_files:
            g_key = f.stem
            pnames, g_data = load_grid_file(f)
            g_min = compute_grid_minimum(pnames, g_data)
            for p in pnames:
                if p not in global_params:
                    if p not in all_param_names:
                        all_param_names.append(p)
                    if not param or param.upper() in p.upper() or p.upper() in param.upper():
                        g_profs = compute_1d_profiles(pnames, g_data, target_param=p)
                        for gp in g_profs:
                            gp["fitted_val"] = _lookup_fitted_param(step_res, gp["parameter"], group_str=g_key) if step_res else None
                            all_profiles.append(gp)
                    if p in g_min["coordinates"]:
                        all_min_coords[p] = g_min["coordinates"][p]

        # Add global profiles at the end
        for gp in global_params:
            if gp not in all_param_names:
                all_param_names.append(gp)
        all_profiles.extend(global_profiles)

        combined_min_info = {
            "chisqr": global_min["chisqr"],
            "coordinates": all_min_coords,
            "point_index": global_min.get("point_index"),
        }

        return sanitize_floats_for_json({
            "step_name": step_name,
            "group": "All Groups",
            "parameters": all_param_names,
            "profiles": all_profiles,
            "min_point": combined_min_info,
        })


@router.get("/{analysis_uuid}/steps/{step_name}/grid/2d")
def get_grid_2d_surface(
    step_name: str,
    x: Optional[str] = None,
    y: Optional[str] = None,
    group: Optional[str] = None,
    analysis: models.Analysis = Depends(get_analysis),
):
    """
    Get 2D surface matrix of delta-chi-square and chi-square with fitted and minimum points.
    """
    from ..services.fitting.chemex_output import (
        load_grid_file,
        get_grid_data_for_group,
        compute_2d_surface,
        compute_grid_minimum,
        parse_output_tree,
    )
    run_dir = _locate_analysis_run_dir(analysis)
    grid_dir = _locate_step_grid_dir(run_dir, step_name)
    if not grid_dir:
        raise HTTPException(status_code=404, detail="Grid directory not found for this step.")

    res_map = _get_analysis_residue_mapping(run_dir)
    out_files = sorted((grid_dir / "Groups").glob("*.out"))

    # Map parameters to group stems
    all_params: list[str] = []
    group_param_map: dict[str, str] = {}
    for f in out_files:
        g_key = f.stem
        pnames, _ = load_grid_file(f)
        for p in pnames:
            if p not in all_params:
                all_params.append(p)
            group_param_map[p] = g_key

    try:
        global_params, agg_data, _ = get_grid_data_for_group(
            grid_dir, group=None, residue_mapping=res_map
        )
    except Exception as e:
        raise HTTPException(status_code=404, detail=str(e))

    for gp in global_params:
        if gp not in all_params:
            all_params.append(gp)

    target_group = group
    if not target_group:
        # Check if x or y belongs to a residue group
        for p_test in (x, y):
            if p_test and p_test not in global_params:
                for p_full, g_k in group_param_map.items():
                    if p_test.strip().upper() == p_full.strip().upper():
                        target_group = g_k
                        break
                if not target_group:
                    for p_full, g_k in group_param_map.items():
                        g_tag = g_k.split("_")[-1].upper()
                        if g_tag in p_test.upper():
                            target_group = g_k
                            break
                if target_group:
                    break

    if target_group:
        try:
            param_names, data, resolved_group = get_grid_data_for_group(
                grid_dir, group=target_group, residue_mapping=res_map
            )
        except Exception as e:
            raise HTTPException(status_code=404, detail=str(e))
        avail_params = all_params if not group else param_names
    else:
        param_names = global_params
        data = agg_data
        resolved_group = "All Groups"
        avail_params = all_params

    if len(param_names) < 2:
        raise HTTPException(status_code=400, detail="Grid has fewer than 2 parameters; cannot generate 2D surface.")

    x_param = x or param_names[0]
    y_param = y or param_names[1]

    try:
        surface = compute_2d_surface(param_names, data, x_param=x_param, y_param=y_param)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    min_info = compute_grid_minimum(param_names, data)

    # Attach fitted values for x and y
    fitted_point = {"x": None, "y": None}
    try:
        out_tree = parse_output_tree(run_dir if (run_dir / "run_info").exists() else (run_dir / "Output"))
        step_res = out_tree.steps.get(step_name)
        if step_res:
            fitted_point["x"] = _lookup_fitted_param(step_res, x_param, group_str=target_group)
            fitted_point["y"] = _lookup_fitted_param(step_res, y_param, group_str=target_group)
    except Exception:
        pass

    surface["fitted_point"] = fitted_point
    surface["group"] = resolved_group
    surface["available_parameters"] = avail_params

    return sanitize_floats_for_json(surface)


