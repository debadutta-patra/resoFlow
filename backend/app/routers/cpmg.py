
from __future__ import annotations
from ..services.fitting.experiments.cpmg_builder import build_cpmg_experiment

import os
import json
import math
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.orm import Session

from .. import database, models, security
from ..services.fitting.chemex_registry import (
    MODULE_METADATA,
    SPIN_KEY_FORMATS,
    get_module_schema,
    get_chemex_module_registry,
)
from ..services.fitting.cpmg_reduction import (
    compute_r2eff_profile,
    compute_rex_and_flatness,
    estimate_delta_omega_fast_exchange,
)
from ..services.fitting.cpmg_diagnostics import evaluate_cpmg_identifiability
from ..services.fitting.spin_system import SpinSystemKey
from .deps import get_analysis

router = APIRouter(
    prefix="/api/projects/{project_uuid}/analysis",
    tags=["cpmg-analysis"],
)



@router.get("/{analysis_uuid}/cpmg/config")
def get_cpmg_config(
    analysis: models.Analysis = Depends(get_analysis),
    current_user: models.User = Depends(security.get_current_user),
):
    project = analysis.project
    run_dir = os.path.join(project.local_directory_path, "cpmg_fitting", analysis.analysis_uuid)
    config_path = os.path.join(run_dir, "cpmg_config.json")
    if os.path.exists(config_path):
        try:
            with open(config_path, "r") as f:
                data = json.load(f)
            return {"config": data, "has_backup": analysis.has_backup}
        except Exception:
            pass
    return {"config": None, "has_backup": analysis.has_backup}


@router.put("/{analysis_uuid}/cpmg/config")
def save_cpmg_config(
    request: dict,
    analysis: models.Analysis = Depends(get_analysis),
    current_user: models.User = Depends(security.get_current_user),
):
    project = analysis.project
    run_dir = os.path.join(project.local_directory_path, "cpmg_fitting", analysis.analysis_uuid)
    os.makedirs(run_dir, exist_ok=True)
    config_path = os.path.join(run_dir, "cpmg_config.json")
    with open(config_path, "w") as f:
        json.dump(request, f, indent=2)
    return {"status": "saved"}


@router.post("/{analysis_uuid}/cpmg/generate")
def generate_cpmg_files(
    request: dict,
    analysis: models.Analysis = Depends(get_analysis),
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(security.get_current_user),
):
    if analysis.analysis_type != "CPMG":
        raise HTTPException(status_code=400, detail="Only for CPMG analyses")

    spectrum_ids = request.get("spectrum_ids", [])
    if not spectrum_ids:
        raise HTTPException(status_code=400, detail="No spectra selected")

    project = analysis.project
    run_dir = os.path.join(project.local_directory_path, "cpmg_fitting", analysis.analysis_uuid)
    data_dir = os.path.join(run_dir, "data")
    experiments_dir = os.path.join(run_dir, "experiments")
    os.makedirs(data_dir, exist_ok=True)
    os.makedirs(experiments_dir, exist_ok=True)

    spectra = db.query(models.Spectrum).filter(models.Spectrum.id.in_(spectrum_ids)).all()
    if not spectra:
        raise HTTPException(status_code=404, detail="No spectra found")

    config_path = os.path.join(run_dir, "cpmg_config.json")
    existing_cfg_temp = {}
    if os.path.exists(config_path):
        try:
            with open(config_path, "r") as f:
                existing_cfg_temp = json.load(f)
        except Exception:
            pass

    selected_module = request.get("selected_module") or request.get("module_name") or existing_cfg_temp.get("selected_module") or "cpmg_15n_ip"
    
    param_cfg_temp = existing_cfg_temp.get("parameter_config") or {}
    excluded_residues = list(set(
        request.get("excluded_residues", [])
        or param_cfg_temp.get("excludedResidues", [])
        or existing_cfg_temp.get("excluded_residues", [])
        or []
    ))

    block_settings = dict(request)
    block_settings["module_name"] = selected_module

    experiment_tomls = []
    all_profiles_by_res = {}
    skipped_reasons = []

    for spectrum in spectra:
        b0_val = getattr(spectrum, "b0", None)
        if b0_val is None:
            skipped_reasons.append(f"Spectrum '{spectrum.name}' missing B0")
            continue
            
        exp_filename = f"exp_{b0_val:.0f}MHz_{spectrum.id}.toml"
        exp_path = os.path.join(experiments_dir, exp_filename)
        
        try:
            gen_exp = build_cpmg_experiment(
                block_settings=block_settings,
                spectrum=spectrum,
                out_data_dir=data_dir,
                toml_path=exp_path,
                include=[],
                exclude=excluded_residues
            )
            
            experiment_tomls.append({
                "b0": b0_val,
                "path": exp_path,
                "filename": exp_filename,
                "profiles_count": len(gen_exp.written_data_files),
                "toml_content": gen_exp.toml_content,
                "spectrum_id": spectrum.id,
            })
            
            for prof in gen_exp.inspection_profiles:
                res_lbl = prof["residue"]
                if res_lbl not in all_profiles_by_res:
                    all_profiles_by_res[res_lbl] = {
                        "residue": res_lbl,
                        "full_residue": prof["full_residue"],
                        "cs_a": prof["cs_a"],
                        "experiments": [],
                    }
                all_profiles_by_res[res_lbl]["experiments"].extend(prof["experiments"])
                if prof["cs_a"] > 0:
                    all_profiles_by_res[res_lbl]["cs_a"] = prof["cs_a"]
                    
        except ValueError as e:
            skipped_reasons.append(str(e))

    if not experiment_tomls:
        error_detail = "Failed to generate CPMG files. " + " ".join(skipped_reasons)
        raise HTTPException(status_code=400, detail=error_detail)

    profiles_list = list(all_profiles_by_res.values())
    for prof in profiles_list:
        max_rex = max((e.get("rex", 0.0) for e in prof["experiments"]), default=0.0)
        prof["overall_rex"] = max_rex
        
        # Calculate estimated_dw using the first valid b0
        b0_mhz = prof["experiments"][0]["b0"] if prof["experiments"] else 600.0
        
        # Get xi_ratio
        from ..services.fitting.chemex_registry import MODULE_METADATA
        meta = MODULE_METADATA.get(selected_module, {})
        xi_ratio = meta.get("xi_ratio", 0.101329118)
        
        from ..services.fitting.cpmg_reduction import estimate_delta_omega_fast_exchange
        prof["estimated_dw"] = estimate_delta_omega_fast_exchange(
            rex=max_rex,
            kex=500.0,
            pb=0.05,
            b0_mhz=b0_mhz,
            xi_ratio=xi_ratio,
        )

    existing_cfg_temp.update({
        "experiments": experiment_tomls,
        "profiles": profiles_list,
        "selected_module": selected_module,
        "time_t2": request.get("time_t2", 0.04),
        "carrier": request.get("carrier", 117.0),
        "pw90": request.get("pw90", 35.0e-6),
        "data_error": request.get("data_error", "duplicates"),
        "generated_files": len(experiment_tomls),
        "spectrum_ids": spectrum_ids,
    })

    with open(config_path, "w") as f:
        json.dump(existing_cfg_temp, f, indent=2)


    params = json.loads(analysis.parameters) if analysis.parameters else {}
    params["cpmg_config_path"] = config_path
    analysis.parameters = json.dumps(params)
    db.commit()

    return {
        "status": "success",
        "total_data_files": sum([e.get("profiles_count", 0) for e in experiment_tomls]),
        "experiments": experiment_tomls,
        "profiles": profiles_list,
        "residue_mapping": {p["residue"]: p.get("full_residue", p["residue"]) for p in profiles_list},
        "warnings": [],
    }


@router.get("/{analysis_uuid}/cpmg/profiles")
def get_cpmg_profiles(
    analysis: models.Analysis = Depends(get_analysis),
    current_user: models.User = Depends(security.get_current_user),
):
    """
    Retrieve calculated dispersion profiles for the inspection tab.
    """
    project = analysis.project
    run_dir = os.path.join(project.local_directory_path, "cpmg_fitting", analysis.analysis_uuid)
    config_path = os.path.join(run_dir, "cpmg_config.json")
    if os.path.exists(config_path):
        try:
            with open(config_path, "r") as f:
                cfg = json.load(f)
            if "profiles" in cfg:
                return {"profiles": cfg["profiles"]}
        except Exception:
            pass
    return {"profiles": []}


@router.get("/{analysis_uuid}/cpmg/diagnostics")
def get_cpmg_diagnostics(
    analysis: models.Analysis = Depends(get_analysis),
    current_user: models.User = Depends(security.get_current_user),
):
    """
    Calculate identifiability diagnostics for CPMG fitting results.
    """
    project = analysis.project
    run_dir = os.path.join(project.local_directory_path, "cpmg_fitting", analysis.analysis_uuid)
    results_path = os.path.join(run_dir, "results.json")

    if not os.path.exists(results_path):
        return {"warnings": [], "regimes": {}, "fast_exchange_count": 0, "total_residues": 0}

    try:
        with open(results_path, "r") as f:
            res_data = json.load(f)
        global_params = res_data.get("global_parameters", {})
        residue_params = res_data.get("residues", {})
        num_fields = len(res_data.get("experiments", [1]))
        return evaluate_cpmg_identifiability(global_params, residue_params, num_fields=num_fields)
    except Exception as e:
        return {"error": str(e), "warnings": [], "regimes": {}}


@router.get("/{analysis_uuid}/cpmg/logs")
def get_cpmg_logs(
    analysis: models.Analysis = Depends(get_analysis),
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(security.get_current_user),
):
    """Return the live log content and progress state from the ChemEx CPMG run."""
    db.refresh(analysis)
    if not analysis.log_path or not os.path.exists(analysis.log_path):
        return {"logs": "", "status": analysis.status if analysis else "PENDING", "progress": None}

    progress_data = None
    progress_file = os.path.join(os.path.dirname(analysis.log_path), "progress.json")
    if os.path.exists(progress_file):
        try:
            with open(progress_file, "r", encoding="utf-8") as pf:
                progress_data = json.load(pf)
        except Exception:
            pass

    if analysis and analysis.status in ("COMPLETED", "FAILED", "CANCELLED"):
        progress_data = None

    try:
        file_size = os.path.getsize(analysis.log_path)
        if file_size > 500 * 1024:
            with open(analysis.log_path, "rb") as f:
                f.seek(-250 * 1024, os.SEEK_END)
                raw = f.read()
                first_nl = raw.find(b"\n")
                if first_nl != -1:
                    raw = raw[first_nl + 1 :]
                logs = "[... earlier log lines truncated for performance ...]\n" + raw.decode("utf-8", errors="replace")
        else:
            with open(analysis.log_path, "r", errors="replace") as f:
                logs = f.read()
    except Exception:
        logs = ""

    return {"logs": logs, "status": analysis.status, "progress": progress_data}


@router.get("/{analysis_uuid}/cpmg/method-parameters")
def get_cpmg_method_parameters(
    model: str = "2st",
    analysis: models.Analysis = Depends(get_analysis),
    current_user: models.User = Depends(security.get_current_user),
):
    """
    Return parameter definitions, glosses, and metadata for CPMG fitting in ChemEx.
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
            "is_primary": True,
        },
        {
            "name": "KEX_AB",
            "gloss": "Exchange rate between states A and B (s⁻¹)",
            "scope": "global",
            "default_mode": "default",
            "category": "kinetic",
            "is_primary": True,
        },
        {
            "name": "CS_A",
            "gloss": "Chemical shift of major ground state A (ppm)",
            "scope": "residue",
            "default_mode": "default",
            "category": "chemical_shift",
            "is_primary": True,
        },
        {
            "name": "DW_AB",
            "gloss": "Chemical shift difference between states B and A: CS_B - CS_A (ppm)",
            "scope": "residue",
            "default_mode": "default",
            "category": "chemical_shift",
            "is_primary": True,
        },
        {
            "name": "R1_A",
            "gloss": "Longitudinal relaxation rate of state A (s⁻¹)",
            "scope": "residue",
            "default_mode": "default",
            "category": "relaxation",
            "is_primary": True,
        },
        {
            "name": "R2_A",
            "gloss": "Transverse relaxation rate of state A (s⁻¹)",
            "scope": "residue",
            "default_mode": "default",
            "category": "relaxation",
            "is_primary": True,
        },
        {
            "name": "R1_B",
            "gloss": "Longitudinal relaxation rate of state B (s⁻¹)",
            "scope": "residue",
            "default_mode": "default",
            "default_expression": "[R1_A]",
            "category": "relaxation",
            "is_primary": True,
        },
        {
            "name": "R2_B",
            "gloss": "Transverse relaxation rate of state B (s⁻¹)",
            "scope": "residue",
            "default_mode": "default",
            "default_expression": "[R2_A]",
            "category": "relaxation",
            "is_primary": True,
        },
        {
            "name": "TAUC_A",
            "gloss": "Rotational correlation time of state A (ns)",
            "scope": "global",
            "default_mode": "default",
            "category": "hydrodynamic",
            "is_primary": False,
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
            "is_primary": True,
        },
        {
            "name": "PC",
            "gloss": "Population of state C (0 - 1)",
            "scope": "global",
            "default_mode": "default",
            "category": "kinetic",
            "is_primary": True,
        },
        {
            "name": "KEX_AB",
            "gloss": "Exchange rate between states A and B (s⁻¹)",
            "scope": "global",
            "default_mode": "default",
            "category": "kinetic",
            "is_primary": True,
        },
        {
            "name": "KEX_AC",
            "gloss": "Exchange rate between states A and C (s⁻¹)",
            "scope": "global",
            "default_mode": "default",
            "category": "kinetic",
            "is_primary": True,
        },
        {
            "name": "KEX_BC",
            "gloss": "Exchange rate between states B and C (s⁻¹)",
            "scope": "global",
            "default_mode": "default",
            "category": "kinetic",
            "is_primary": False,
        },
        {
            "name": "CS_A",
            "gloss": "Chemical shift of major state A (ppm)",
            "scope": "residue",
            "default_mode": "default",
            "category": "chemical_shift",
            "is_primary": True,
        },
        {
            "name": "DW_AB",
            "gloss": "Chemical shift difference CS_B - CS_A (ppm)",
            "scope": "residue",
            "default_mode": "default",
            "category": "chemical_shift",
            "is_primary": True,
        },
        {
            "name": "DW_AC",
            "gloss": "Chemical shift difference CS_C - CS_A (ppm)",
            "scope": "residue",
            "default_mode": "default",
            "category": "chemical_shift",
            "is_primary": True,
        },
        {
            "name": "R1_A",
            "gloss": "Longitudinal relaxation rate of state A (s⁻¹)",
            "scope": "residue",
            "default_mode": "default",
            "category": "relaxation",
            "is_primary": True,
        },
        {
            "name": "R2_A",
            "gloss": "Transverse relaxation rate of state A (s⁻¹)",
            "scope": "residue",
            "default_mode": "default",
            "category": "relaxation",
            "is_primary": True,
        },
        {
            "name": "R1_B",
            "gloss": "Longitudinal relaxation rate of state B (s⁻¹)",
            "scope": "residue",
            "default_mode": "default",
            "default_expression": "[R1_A]",
            "category": "relaxation",
            "is_primary": True,
        },
        {
            "name": "R2_B",
            "gloss": "Transverse relaxation rate of state B (s⁻¹)",
            "scope": "residue",
            "default_mode": "default",
            "default_expression": "[R2_A]",
            "category": "relaxation",
            "is_primary": True,
        },
        {
            "name": "R1_C",
            "gloss": "Longitudinal relaxation rate of state C (s⁻¹)",
            "scope": "residue",
            "default_mode": "default",
            "default_expression": "[R1_A]",
            "category": "relaxation",
            "is_primary": True,
        },
        {
            "name": "R2_C",
            "gloss": "Transverse relaxation rate of state C (s⁻¹)",
            "scope": "residue",
            "default_mode": "default",
            "default_expression": "[R2_A]",
            "category": "relaxation",
            "is_primary": True,
        },
        {
            "name": "TAUC_A",
            "gloss": "Rotational correlation time of state A (ns)",
            "scope": "global",
            "default_mode": "default",
            "category": "hydrodynamic",
            "is_primary": False,
        },
    ]

    model_clean = (model or "2st").lower()
    if "3st" in model_clean or "3" in model_clean:
        return {"model": model, "parameters": params_3st}

    return {"model": model, "parameters": params_2st}



@router.post("/{analysis_uuid}/cpmg/run")

def run_cpmg_analysis(
    request: dict,
    analysis: models.Analysis = Depends(get_analysis),
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(security.get_current_user),
):
    """
    Launch a ChemEx CPMG fitting job.
    """
    from ..services.fitting.cpmg_tasks import run_cpmg_analysis_task
    import uuid

    project = analysis.project
    run_dir = os.path.join(project.local_directory_path, "cpmg_fitting", analysis.analysis_uuid)
    os.makedirs(run_dir, exist_ok=True)

    config_path = os.path.join(run_dir, "cpmg_config.json")
    existing_config = {}
    if os.path.exists(config_path):
        try:
            with open(config_path, "r") as f:
                existing_config = json.load(f)
        except Exception:
            pass

    existing_config.update(request)
    with open(config_path, "w") as f:
        json.dump(existing_config, f, indent=2)

    # Clean up stale progress.json from prior run
    stale_progress = os.path.join(run_dir, "progress.json")
    if os.path.exists(stale_progress):
        try:
            os.remove(stale_progress)
        except OSError:
            pass

    analysis.log_path = os.path.join(run_dir, "chemex.log")
    analysis.results_path = os.path.join(run_dir, "results.json")
    analysis.status = "PENDING"
    analysis.cancel_requested = False
    analysis.completed_at = None
    analysis.error_message = None

    # Initialize / clear log for the new run
    try:
        with open(analysis.log_path, "w") as f:
            f.write(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] CPMG analysis queued: {analysis.name} (UUID: {analysis.analysis_uuid})\n")
    except Exception:
        pass

    task_id = str(uuid.uuid4())
    params = json.loads(analysis.parameters) if analysis.parameters else {}
    params["cpmg_config_path"] = config_path
    params["task_id"] = task_id
    analysis.parameters = json.dumps(params)
    db.commit()

    run_cpmg_analysis_task.apply_async(
        args=[analysis.analysis_uuid, existing_config],
        task_id=task_id,
    )

    return {"message": "CPMG analysis started", "analysis_uuid": analysis.analysis_uuid, "task_id": task_id, "status": "PENDING"}


@router.post("/{analysis_uuid}/cpmg/stop")
@router.post("/{analysis_uuid}/cancel")
def stop_cpmg_analysis(
    analysis: models.Analysis = Depends(get_analysis),
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(security.get_current_user),
):
    """Terminate a running CPMG fitting job inside its ephemeral container."""
    from ..celery_app import celery_app
    from datetime import datetime

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

    if analysis.log_path and os.path.exists(analysis.log_path):
        try:
            with open(analysis.log_path, "a") as f:
                f.write(f"\n\n{'=' * 60}\n")
                f.write(f"ANALYSIS CANCELLED BY USER AT: {datetime.utcnow().isoformat()}\n")
                f.write(f"{'=' * 60}\n")
        except Exception:
            pass

    return {"message": "Analysis cancelled successfully", "status": "CANCELLED"}


@router.post("/{analysis_uuid}/cpmg/restore")
def restore_cpmg_analysis(
    analysis: models.Analysis = Depends(get_analysis),
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(security.get_current_user),
):
    """Restore the last backed-up CPMG results."""
    project = analysis.project
    run_dir = os.path.join(project.local_directory_path, "cpmg_fitting", analysis.analysis_uuid)
    
    output_dir = os.path.join(run_dir, "Output")
    output_bak = os.path.join(run_dir, "Output_bak")
    output_tmp = os.path.join(run_dir, "Output_tmp")
    
    results_path = os.path.join(run_dir, "results.json")
    results_bak = os.path.join(run_dir, "results_bak.json")
    results_tmp = os.path.join(run_dir, "results_tmp.json")
    
    log_path = os.path.join(run_dir, "chemex.log")
    log_bak = os.path.join(run_dir, "chemex_bak.log")
    log_tmp = os.path.join(run_dir, "chemex_tmp.log")

    if not os.path.exists(output_bak) and not os.path.exists(results_bak):
        raise HTTPException(status_code=404, detail="No backup found to restore")

    try:
        # Swap Output directories
        if os.path.exists(output_dir):
            os.rename(output_dir, output_tmp)
        if os.path.exists(output_bak):
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


