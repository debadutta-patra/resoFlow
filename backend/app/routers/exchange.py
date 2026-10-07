import os
import json
import logging
from typing import Optional
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, database, security
from ..services.fitting.exchange_tasks import run_exchange_analysis_task
from ..services.fitting.experiments.cest_builder import build_cest_experiment
from ..services.fitting.experiments.cpmg_builder import build_cpmg_experiment
from ..services.fitting.chemex_runner import run_chemex_job

router = APIRouter(
    prefix="/api/projects/{project_uuid}/analysis/{analysis_uuid}/exchange",
    tags=["exchange_fitting"]
)

logger = logging.getLogger(__name__)

def get_analysis(project_uuid: str, analysis_uuid: str, db: Session = Depends(database.get_db)) -> models.Analysis:
    project = db.query(models.Project).filter(models.Project.uuid == project_uuid).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    analysis = db.query(models.Analysis).filter(
        models.Analysis.analysis_uuid == analysis_uuid,
        models.Analysis.project_id == project.id
    ).first()
    if not analysis:
        raise HTTPException(status_code=404, detail="Analysis not found")
    return analysis

@router.post("/preflight")
def run_exchange_preflight(
    request: dict,
    analysis: models.Analysis = Depends(get_analysis),
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(security.get_current_user),
):
    spectrum_ids = request.get("spectrum_ids", [])
    if not spectrum_ids:
        raise HTTPException(status_code=400, detail="No spectra selected")

    project = analysis.project
    run_dir = os.path.join(project.local_directory_path, "exchange_fitting", analysis.analysis_uuid)
    preflight_dir = os.path.join(run_dir, "preflight")
    os.makedirs(preflight_dir, exist_ok=True)
    
    spectra = db.query(models.Spectrum).filter(models.Spectrum.id.in_(spectrum_ids)).all()
    
    # We will generate temporary TOMLs in preflight_dir to run the preflight script on them
    tomls = []
    
    # The frontend should send a 'model' (like '2st') for preflight
    model = request.get("model", "2st")
    
    base_block_settings = dict(request)
    base_block_settings["module_name"] = request.get("module_name", "cest_15n") # Or we get this per spectrum?
    
    for spectrum in spectra:
        block_settings = dict(base_block_settings)
        if spectrum.experiment_type.upper() == "CEST":
            b1 = spectrum.b1
            b0 = spectrum.b0
            b1_label = f"{b0:.0f}MHz_{b1:.0f}hz" if b1 and b0 else f"spec_{spectrum.id}"
            toml_path = os.path.join(preflight_dir, f"cest_{b1_label}.toml")
            # We just need the TOML, so we can pass a dummy out_data_dir that doesn't write anything if we catch it, but builder writes it.
            # Actually, builder writes data. Let's let it write in preflight.
            out_data = os.path.join(preflight_dir, f"data_{b1_label}")
            os.makedirs(out_data, exist_ok=True)
            try:
                gen = build_cest_experiment(
                    block_settings=block_settings,
                    spectrum=spectrum,
                    out_data_dir=out_data,
                    toml_path=toml_path,
                    include=[],
                    exclude=[]
                )
                tomls.append(toml_path)
            except Exception:
                pass
                
        elif spectrum.experiment_type.upper() == "CPMG":
            b0 = spectrum.b0
            label = f"{b0:.0f}MHz" if b0 else f"spec_{spectrum.id}"
            toml_path = os.path.join(preflight_dir, f"cpmg_{label}.toml")
            out_data = os.path.join(preflight_dir, f"data_{label}")
            os.makedirs(out_data, exist_ok=True)
            try:
                gen = build_cpmg_experiment(
                    block_settings=block_settings,
                    spectrum=spectrum,
                    out_data_dir=out_data,
                    toml_path=toml_path,
                    include=[],
                    exclude=[]
                )
                tomls.append(toml_path)
            except Exception:
                pass

    if not tomls:
        raise HTTPException(status_code=400, detail="Could not generate any TOMLs for preflight")

    # Just run it using the local resoflow.preflight since the environment is shared or podman
    import subprocess
    from ..services.path_utils import to_host_path
    from ..services.fitting.chemex_runner import DEFAULT_CHEMEX_IMAGE

    cmd = [
        "podman", "run", "--rm", "--userns=keep-id",
        "--entrypoint", "python",
        "-v", f"{to_host_path(preflight_dir)}:/work:z",
        DEFAULT_CHEMEX_IMAGE,
        "-m", "resoflow.preflight", "--json", "-e"
    ]
    # Re-map absolute paths to relative ones inside the container which mounts /work
    container_tomls = [os.path.basename(t) for t in tomls]
    cmd.extend(container_tomls)
    cmd.extend(["-d", model])

    try:
        res = subprocess.run(cmd, cwd=preflight_dir, capture_output=True, text=True)
        if res.returncode != 0 and not res.stdout.strip():
            raise HTTPException(status_code=400, detail=f"Preflight failed: {res.stderr}")
        return json.loads(res.stdout)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail=f"Preflight output parsing failed: {res.stdout}")
import subprocess
from ..services.path_utils import to_host_path

@router.post("/generate")
def generate_exchange_files(
    request: dict,
    analysis: models.Analysis = Depends(get_analysis),
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(security.get_current_user),
):
    spectrum_ids = request.get("spectrum_ids", [])
    if not spectrum_ids:
        raise HTTPException(status_code=400, detail="No spectra selected")

    project = analysis.project
    run_dir = os.path.join(project.local_directory_path, "exchange_fitting", analysis.analysis_uuid)
    data_dir = os.path.join(run_dir, "data")
    experiments_dir = os.path.join(run_dir, "experiments")
    os.makedirs(data_dir, exist_ok=True)
    os.makedirs(experiments_dir, exist_ok=True)

    spectra = db.query(models.Spectrum).filter(models.Spectrum.id.in_(spectrum_ids)).all()
    if not spectra:
        raise HTTPException(status_code=404, detail="No spectra found")

    experiment_tomls = []
    generated_data_files = {}

    model = request.get("model", "2st")
    base_block_settings = dict(request)
    base_block_settings["module_name"] = request.get("module_name", "cest_15n")

    for spectrum in spectra:
        block_settings = dict(base_block_settings)
        if spectrum.experiment_type.upper() == "CEST":
            b1 = spectrum.b1
            b0 = spectrum.b0
            if b1 is None or b0 is None:
                continue
            b1_label = f"{b0:.0f}MHz_{b1:.0f}hz"
            b1_dir = os.path.join(data_dir, b1_label)
            os.makedirs(b1_dir, exist_ok=True)
            
            exp_filename = f"cest_{b1_label}.toml"
            exp_path = os.path.join(experiments_dir, exp_filename)
            
            block_settings["filter_offsets"] = [[0.0, float(b1)]]
            try:
                gen = build_cest_experiment(
                    block_settings=block_settings,
                    spectrum=spectrum,
                    out_data_dir=b1_dir,
                    toml_path=exp_path,
                    include=[],
                    exclude=[]
                )
                experiment_tomls.append({
                    "b1": b1,
                    "b1_label": b1_label,
                    "filename": exp_filename,
                    "path": exp_path,
                    "toml_content": gen.toml_content,
                    "residue_count": len(gen.written_data_files),
                })
            except Exception:
                pass
                
        elif spectrum.experiment_type.upper() == "CPMG":
            b0 = spectrum.b0
            if b0 is None:
                continue
            label = f"{b0:.0f}MHz_spec_{spectrum.id}"
            exp_dir = os.path.join(data_dir, label)
            os.makedirs(exp_dir, exist_ok=True)
            
            exp_filename = f"cpmg_{label}.toml"
            exp_path = os.path.join(experiments_dir, exp_filename)
            
            try:
                gen = build_cpmg_experiment(
                    block_settings=block_settings,
                    spectrum=spectrum,
                    out_data_dir=exp_dir,
                    toml_path=exp_path,
                    include=[],
                    exclude=[]
                )
                experiment_tomls.append({
                    "b0": b0,
                    "filename": exp_filename,
                    "path": exp_path,
                    "toml_content": gen.toml_content,
                    "profiles_count": len(gen.written_data_files),
                })
            except Exception:
                pass

    config_path = os.path.join(run_dir, "exchange_config.json")
    cfg = {
        "experiments": experiment_tomls,
        "experiments_dir": experiments_dir,
        "data_dir": data_dir,
        "spectrum_ids": spectrum_ids,
        "model": model,
    }
    with open(config_path, "w") as f:
        json.dump(cfg, f, indent=2)

    params = json.loads(analysis.parameters) if analysis.parameters else {}
    params["exchange_config_path"] = config_path
    analysis.parameters = json.dumps(params)
    db.commit()

    return {
        "status": "success",
        "experiments": experiment_tomls,
        "run_dir": run_dir,
    }

