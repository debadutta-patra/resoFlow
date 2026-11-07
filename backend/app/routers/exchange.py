import os
import json
import logging
import uuid
import shutil
from typing import Optional, List, Dict, Any
from pathlib import Path
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, database, security
from ..services.fitting.exchange_tasks import run_exchange_analysis_task
from ..services.fitting.experiments.cest_builder import build_cest_experiment
from ..services.fitting.experiments.cpmg_builder import build_cpmg_experiment
from ..services.fitting.chemex_runner import run_chemex_job, cancel_chemex_job, is_chemex_container_running
from ..services.path_utils import to_container_path, to_host_path
from .deps import get_analysis

router = APIRouter(
    prefix="/api/projects/{project_uuid}/analysis/{analysis_uuid}/exchange",
    tags=["exchange_fitting"]
)

logger = logging.getLogger(__name__)


def _get_exchange_run_dir(analysis: models.Analysis) -> str:
    project = analysis.project
    container_project_dir = to_container_path(project.local_directory_path) or project.local_directory_path
    run_dir = os.path.join(container_project_dir, "exchange_fitting", analysis.analysis_uuid)
    os.makedirs(run_dir, exist_ok=True)
    return run_dir


@router.post("/generate")
def generate_exchange_files(
    request: dict,
    analysis: models.Analysis = Depends(get_analysis),
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(security.get_current_user),
):
    """
    Generate experiment TOMLs and data files for both CEST and CPMG spectra.
    Prepares inspection profiles for Pick CEST and Inspect Dispersion.
    """
    spectrum_ids = request.get("spectrum_ids", [])
    if not spectrum_ids:
        # Fallback to separate arrays if provided
        spectrum_ids = list(set((request.get("cest_spectrum_ids") or []) + (request.get("cpmg_spectrum_ids") or [])))

    if not spectrum_ids:
        raise HTTPException(status_code=400, detail="No spectra selected for exchange analysis")

    run_dir = _get_exchange_run_dir(analysis)
    data_dir = os.path.join(run_dir, "data")
    experiments_dir = os.path.join(run_dir, "experiments")
    os.makedirs(data_dir, exist_ok=True)
    os.makedirs(experiments_dir, exist_ok=True)

    spectra = db.query(models.Spectrum).filter(models.Spectrum.id.in_(spectrum_ids)).all()
    if not spectra:
        raise HTTPException(status_code=404, detail="No spectra found")

    config_path = os.path.join(run_dir, "config.json")
    existing_cfg: Dict[str, Any] = {}
    if os.path.exists(config_path):
        try:
            with open(config_path, "r") as f:
                existing_cfg = json.load(f)
        except Exception:
            pass

    cest_module_name = request.get("cest_module_name") or existing_cfg.get("cest_module_name") or "cest_15n"
    cpmg_module_name = request.get("cpmg_module_name") or existing_cfg.get("cpmg_module_name") or "cpmg_15n_ip"
    model = request.get("model") or existing_cfg.get("model") or "2st"
    use_height = request.get("use_height", existing_cfg.get("use_height", True))

    param_cfg_temp = existing_cfg.get("parameter_config") or {}
    excluded_residues = list(set(
        request.get("excluded_residues", [])
        or param_cfg_temp.get("excludedResidues", [])
        or existing_cfg.get("excluded_residues", [])
        or []
    ))

    experiment_tomls = []
    generated_data_files = {}
    metadata: Dict[str, Any] = {}
    residue_mapping: Dict[str, str] = {}
    fields_set = set()

    # Data structures for Pick CEST and Inspect Dispersion
    grouped_cest_profiles: Dict[str, List[Dict[str, Any]]] = {}
    grouped_cpmg_profiles: Dict[str, Dict[str, Any]] = {}

    for spectrum in spectra:
        exp_type = (spectrum.experiment_type or "").upper()
        b0 = getattr(spectrum, "b0", None)
        if b0 is not None:
            fields_set.add(float(b0))

        if "CEST" in exp_type:
            b1 = getattr(spectrum, "b1", None)
            if b1 is None or b0 is None:
                continue

            b1_label = f"{b0:.0f}MHz_{b1:.0f}hz"
            b1_dir = os.path.join(data_dir, b1_label)
            os.makedirs(b1_dir, exist_ok=True)

            exp_filename = f"cest_{b1_label}.toml"
            exp_path = os.path.join(experiments_dir, exp_filename)

            offsets_by_spec = request.get("filter_offsets_by_spectrum") or existing_cfg.get("filter_offsets_by_spectrum")
            raw_filter_offsets = request.get("filter_offsets") or existing_cfg.get("filter_offsets")
            spec_offsets = None
            if isinstance(offsets_by_spec, dict):
                spec_offsets = offsets_by_spec.get(spectrum.id) or offsets_by_spec.get(str(spectrum.id))
            if spec_offsets is None and isinstance(raw_filter_offsets, dict):
                spec_offsets = (
                    raw_filter_offsets.get(spectrum.id) or raw_filter_offsets.get(str(spectrum.id)) or
                    raw_filter_offsets.get(b1_label) or raw_filter_offsets.get(str(b1)) or
                    raw_filter_offsets.get(f"{b1:.0f}hz")
                )

            filter_offsets = None
            if spec_offsets is not None and isinstance(spec_offsets, list):
                filter_offsets = spec_offsets
            elif isinstance(raw_filter_offsets, list) and raw_filter_offsets:
                adapted = []
                has_carrier = False
                for pair in raw_filter_offsets:
                    if isinstance(pair, (list, tuple)) and len(pair) == 2:
                        if float(pair[0]) == 0.0:
                            adapted.append([0.0, float(b1)])
                            has_carrier = True
                        else:
                            adapted.append([float(pair[0]), float(pair[1])])
                if not has_carrier:
                    adapted.insert(0, [0.0, float(b1)])
                filter_offsets = adapted

            block_settings = dict(request)
            block_settings["module_name"] = cest_module_name
            block_settings["use_height"] = use_height
            if filter_offsets is not None:
                block_settings["filter_offsets"] = filter_offsets
            else:
                block_settings["filter_offsets"] = [[0.0, float(b1)]]

            if "b1_distribution" in request:
                block_settings["b1_distribution"] = request["b1_distribution"]

            try:
                gen_exp = build_cest_experiment(
                    block_settings=block_settings,
                    spectrum=spectrum,
                    out_data_dir=b1_dir,
                    toml_path=exp_path,
                    include=[],
                    exclude=excluded_residues
                )

                experiment_tomls.append({
                    "b1": b1,
                    "b0": b0,
                    "b1_label": b1_label,
                    "type": "CEST",
                    "module": cest_module_name,
                    "filename": exp_filename,
                    "path": exp_path,
                    "toml_content": gen_exp.toml_content,
                    "residue_count": len(gen_exp.written_data_files),
                })

                for res_key, fpath in gen_exp.written_data_files.items():
                    generated_data_files[f"{res_key}:{b1_label}"] = fpath

                metadata[b1_label] = {
                    "b1": b1,
                    "b0": b0,
                    "carrier": getattr(spectrum, "carrier", 0.0),
                    "spectrum_id": spectrum.id,
                }

                # Group CEST profiles from written .out files
                for res_key, fpath in gen_exp.written_data_files.items():
                    if not os.path.exists(fpath):
                        continue
                    offsets, intensities, uncertainties = [], [], []
                    try:
                        with open(fpath, "r") as f:
                            for line in f:
                                line = line.strip()
                                if not line or line.startswith("#"):
                                    continue
                                parts = line.split()
                                if len(parts) >= 2:
                                    offsets.append(float(parts[0]))
                                    intensities.append(float(parts[1]))
                                    uncertainties.append(float(parts[2]) if len(parts) >= 3 else 0.0)
                    except Exception:
                        pass

                    if res_key not in grouped_cest_profiles:
                        grouped_cest_profiles[res_key] = []

                    grouped_cest_profiles[res_key].append({
                        "b1": b1_label,
                        "b1_actual": b1,
                        "b0": b0,
                        "carrier": getattr(spectrum, "carrier", 0.0),
                        "offsets": offsets,
                        "intensities": intensities,
                        "uncertainties": uncertainties,
                        "filepath": fpath,
                    })

                # Populate residue_mapping from inspection_profiles
                for ip in gen_exp.inspection_profiles:
                    r = ip.get("residue")
                    fr = ip.get("full_residue")
                    if r and fr:
                        residue_mapping[r] = fr

            except Exception as e:
                logger.warning(f"Failed to build CEST experiment for {spectrum.name}: {e}")

        elif "CPMG" in exp_type:
            if b0 is None:
                continue

            label = f"{b0:.0f}MHz_spec_{spectrum.id}"
            exp_dir = os.path.join(data_dir, label)
            os.makedirs(exp_dir, exist_ok=True)

            exp_filename = f"cpmg_{label}.toml"
            exp_path = os.path.join(experiments_dir, exp_filename)

            block_settings = dict(request)
            block_settings["module_name"] = cpmg_module_name
            block_settings["use_height"] = use_height

            try:
                gen_exp = build_cpmg_experiment(
                    block_settings=block_settings,
                    spectrum=spectrum,
                    out_data_dir=exp_dir,
                    toml_path=exp_path,
                    include=[],
                    exclude=excluded_residues
                )

                experiment_tomls.append({
                    "b0": b0,
                    "label": label,
                    "type": "CPMG",
                    "module": cpmg_module_name,
                    "filename": exp_filename,
                    "path": exp_path,
                    "toml_content": gen_exp.toml_content,
                    "residue_count": len(gen_exp.written_data_files),
                })

                for res_key, fpath in gen_exp.written_data_files.items():
                    generated_data_files[f"{res_key}:{label}"] = fpath

                # Group CPMG inspection profiles
                for ip in gen_exp.inspection_profiles:
                    r = ip.get("residue")
                    if not r:
                        continue
                    fr = ip.get("full_residue") or r
                    residue_mapping[r] = fr

                    if r not in grouped_cpmg_profiles:
                        grouped_cpmg_profiles[r] = {
                            "residue": r,
                            "full_residue": fr,
                            "cs_a": ip.get("cs_a"),
                            "overall_rex": ip.get("overall_rex", 0.0),
                            "estimated_dw": ip.get("estimated_dw", 0.0),
                            "experiments": [],
                        }
                    for exp_item in ip.get("experiments", []):
                        grouped_cpmg_profiles[r]["experiments"].append(exp_item)

            except Exception as e:
                logger.warning(f"Failed to build CPMG experiment for {spectrum.name}: {e}")

    # Format CEST profiles list
    cest_profiles = []
    for r in sorted(grouped_cest_profiles.keys()):
        cest_profiles.append({
            "residue": r,
            "full_residue": residue_mapping.get(r, r),
            "experiments": grouped_cest_profiles[r],
        })

    # Format CPMG profiles list
    cpmg_profiles = [grouped_cpmg_profiles[r] for r in sorted(grouped_cpmg_profiles.keys())]

    # Build union of all residue keys
    all_res_keys = sorted(list(set(list(grouped_cest_profiles.keys()) + list(grouped_cpmg_profiles.keys()))))
    sorted_fields = sorted(list(fields_set))

    # Construct initial parameter config if not already present or preserve existing
    unified_param_config = existing_cfg.get("parameter_config")
    if not unified_param_config or not isinstance(unified_param_config, dict):
        unified_param_config = {
            "globals": {
                "pb": {"value": 0.05, "source": {"kind": "default"}},
                "kex_ab": {"value": 500.0, "source": {"kind": "default"}},
                "tauc_a": {"value": 4.0, "source": {"kind": "default"}},
            },
            "residues": {},
            "excludedResidues": excluded_residues,
        }
    else:
        unified_param_config["excludedResidues"] = excluded_residues

    parameters_toml = existing_cfg.get("parameters_toml", "")
    if not parameters_toml:
        globals_dict = unified_param_config.get("globals", {})
        toml_lines = [
            "# Auto-generated ChemEx parameter file for Combined Exchange",
            "[GLOBAL]",
            f"PB = {globals_dict.get('pb', {}).get('value', 0.05)}",
            f"KEX_AB = {globals_dict.get('kex_ab', {}).get('value', 500.0)}",
            f"TAUC_A = {globals_dict.get('tauc_a', {}).get('value', 4.0)}",
        ]
        parameters_toml = "\n".join(toml_lines) + "\n"

    # Save to config.json
    cfg_to_save = {
        "generatedExperiments": experiment_tomls,
        "experiments_dir": experiments_dir,
        "data_dir": data_dir,
        "spectrum_ids": spectrum_ids,
        "cest_module_name": cest_module_name,
        "cpmg_module_name": cpmg_module_name,
        "model": model,
        "use_height": use_height,
        "data_files": generated_data_files,
        "metadata": metadata,
        "residue_mapping": residue_mapping,
        "fields": sorted_fields,
        "cest_profiles": cest_profiles,
        "cpmg_profiles": cpmg_profiles,
        "parameter_config": unified_param_config,
        "parameters_toml": parameters_toml,
        "method_toml": existing_cfg.get("method_toml", ""),
        "method_config": existing_cfg.get("method_config"),
        "excluded_residues": excluded_residues,
        "picks": request.get("picks") or existing_cfg.get("picks", {}),
    }

    with open(config_path, "w") as f:
        json.dump(cfg_to_save, f, indent=2, default=str)

    # Sync parameters with Analysis model
    params_blob = json.loads(analysis.parameters) if analysis.parameters else {}
    params_blob["spectrum_ids"] = spectrum_ids
    params_blob["exchange_model"] = model
    params_blob["config_path"] = config_path
    analysis.parameters = json.dumps(params_blob)
    db.commit()

    return {
        "status": "success",
        "experiments": experiment_tomls,
        "cest_profiles": cest_profiles,
        "cpmg_profiles": cpmg_profiles,
        "parameter_config": unified_param_config,
        "parameters_toml": parameters_toml,
        "residue_mapping": residue_mapping,
        "fields": sorted_fields,
        "picks": cfg_to_save["picks"],
        "run_dir": run_dir,
    }


@router.get("/config")
def get_exchange_config(
    analysis: models.Analysis = Depends(get_analysis),
    current_user: models.User = Depends(security.get_current_user),
):
    """Retrieve saved Exchange configuration."""
    run_dir = _get_exchange_run_dir(analysis)
    cfg_path = os.path.join(run_dir, "config.json")
    if os.path.exists(cfg_path):
        try:
            with open(cfg_path, "r") as f:
                return json.load(f)
        except Exception as e:
            logger.warning(f"Failed to read exchange config: {e}")
    return {}


@router.put("/config")
def update_exchange_config(
    request: dict,
    analysis: models.Analysis = Depends(get_analysis),
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(security.get_current_user),
):
    """Update Exchange configuration (parameters, methods, exclusions)."""
    run_dir = _get_exchange_run_dir(analysis)
    cfg_path = os.path.join(run_dir, "config.json")
    existing_cfg = {}
    if os.path.exists(cfg_path):
        try:
            with open(cfg_path, "r") as f:
                existing_cfg = json.load(f)
        except Exception:
            pass

    existing_cfg.update(request)
    with open(cfg_path, "w") as f:
        json.dump(existing_cfg, f, indent=2, default=str)

    params_blob = json.loads(analysis.parameters) if analysis.parameters else {}
    if "model" in request:
        params_blob["exchange_model"] = request["model"]
    analysis.parameters = json.dumps(params_blob)
    db.commit()

    return {"status": "success", "message": "Exchange configuration updated"}


@router.get("/profiles")
def get_exchange_profiles(
    analysis: models.Analysis = Depends(get_analysis),
    current_user: models.User = Depends(security.get_current_user),
):
    """Return both CEST profiles and CPMG dispersion profiles."""
    run_dir = _get_exchange_run_dir(analysis)
    cfg_path = os.path.join(run_dir, "config.json")
    if os.path.exists(cfg_path):
        try:
            with open(cfg_path, "r") as f:
                cfg = json.load(f)
            return {
                "cest_profiles": cfg.get("cest_profiles", []),
                "cpmg_profiles": cfg.get("cpmg_profiles", []),
            }
        except Exception as e:
            logger.warning(f"Failed to read profiles: {e}")
    return {"cest_profiles": [], "cpmg_profiles": []}


@router.get("/method-parameters")
def get_exchange_method_parameters(
    model: str = "2st",
    analysis: models.Analysis = Depends(get_analysis),
    current_user: models.User = Depends(security.get_current_user),
):
    """Return available parameters for method step configuration."""
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
            "gloss": "Chemical shift of major state A (ppm)",
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


@router.post("/run")
def run_exchange_analysis(
    request: dict,
    analysis: models.Analysis = Depends(get_analysis),
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(security.get_current_user),
):
    """Start the combined ChemEx fitting task via Celery."""
    run_dir = _get_exchange_run_dir(analysis)
    config_path = os.path.join(run_dir, "config.json")
    existing_config = {}
    if os.path.exists(config_path):
        try:
            with open(config_path, "r") as f:
                existing_config = json.load(f)
        except Exception:
            pass

    existing_config.update(request)
    with open(config_path, "w") as f:
        json.dump(existing_config, f, indent=2, default=str)

    task_id = str(uuid.uuid4())
    log_path = os.path.join(run_dir, "chemex.log")
    analysis.log_path = log_path
    analysis.results_path = os.path.join(run_dir, "results.json")
    analysis.status = "PENDING"
    analysis.cancel_requested = False
    analysis.completed_at = None
    analysis.error_message = None
    analysis.celery_task_id = task_id
    analysis.bundle_status = "NONE"
    analysis.summary_redchi = None
    analysis.summary_n_residues = None

    # Backup previous outputs immediately so no stale outputs exist during the run
    from ..services.fitting.cest_tasks import _backup_output_directory
    _backup_output_directory(run_dir)

    try:
        with open(log_path, "w") as f:
            f.write(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Exchange analysis queued: {analysis.name} (UUID: {analysis.analysis_uuid})\n")
    except Exception:
        pass

    params = json.loads(analysis.parameters) if analysis.parameters else {}
    params["task_id"] = task_id
    params["config_path"] = config_path
    params["queued_at"] = datetime.now(timezone.utc).isoformat()
    analysis.parameters = json.dumps(params)
    db.commit()

    run_exchange_analysis_task.apply_async(
        args=[analysis.analysis_uuid, existing_config],
        task_id=task_id,
        queue="chemex",
    )

    return {
        "message": "Exchange analysis started",
        "analysis_uuid": analysis.analysis_uuid,
        "task_id": task_id,
        "status": "PENDING"
    }


@router.post("/stop")
@router.post("/cancel")
def stop_exchange_analysis(
    analysis: models.Analysis = Depends(get_analysis),
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(security.get_current_user),
):
    """Cancel an active ChemEx combined fit."""
    analysis.cancel_requested = True
    analysis.status = "CANCELLING"
    db.commit()

    try:
        cancel_chemex_job(analysis.analysis_uuid)
    except Exception as e:
        logger.warning(f"Error cancelling chemex job {analysis.analysis_uuid}: {e}")

    return {"message": "Cancellation requested"}


@router.get("/logs")
def get_exchange_logs(
    analysis: models.Analysis = Depends(get_analysis),
    current_user: models.User = Depends(security.get_current_user),
):
    """Retrieve contents of chemex.log."""
    run_dir = _get_exchange_run_dir(analysis)
    log_path = os.path.join(run_dir, "chemex.log")
    if os.path.exists(log_path):
        try:
            with open(log_path, "r", encoding="utf-8", errors="replace") as f:
                return {"logs": f.read()}
        except Exception as e:
            return {"logs": f"Error reading log file: {e}"}
    return {"logs": ""}


@router.post("/restore")
def restore_exchange_backup(
    analysis: models.Analysis = Depends(get_analysis),
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(security.get_current_user),
):
    """Restore previous run from Output_bak and results_bak.json."""
    run_dir = _get_exchange_run_dir(analysis)
    output_bak = os.path.join(run_dir, "Output_bak")
    output_cur = os.path.join(run_dir, "Output")
    results_bak = os.path.join(run_dir, "results_bak.json")
    results_cur = os.path.join(run_dir, "results.json")

    if not os.path.exists(output_bak) and not os.path.exists(results_bak):
        raise HTTPException(status_code=400, detail="No backup available to restore")

    if os.path.exists(output_bak):
        if os.path.exists(output_cur):
            shutil.rmtree(output_cur, ignore_errors=True)
        shutil.copytree(output_bak, output_cur)

    if os.path.exists(results_bak):
        shutil.copy2(results_bak, results_cur)
        analysis.results_path = results_cur

    analysis.status = "COMPLETED"
    analysis.error_message = None
    db.commit()

    return {"status": "success", "message": "Restored previous run successfully"}


@router.post("/preflight")
def run_exchange_preflight(
    request: dict,
    analysis: models.Analysis = Depends(get_analysis),
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(security.get_current_user),
):
    """
    Backwards-compatible preflight endpoint that generates preview files safely.
    """
    gen_result = generate_exchange_files(request, analysis, db, current_user)
    return {
        "status": "preflight_ok",
        "experiments": gen_result.get("experiments", []),
        "parameters": gen_result.get("parameter_config", {}),
    }
