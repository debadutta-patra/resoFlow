"""
Celery task to run ChemEx CPMG analysis.

Manages the full lifecycle of a ChemEx CPMG fitting job:
  1. Sets up directory structure and writes TOML config files
  2. Launches `chemex fit` as a subprocess
  3. Captures stdout/stderr to a log file
  4. Parses results using chemex_parser and updates the analysis record
"""

import os
import json
import logging
import subprocess
import shutil
from datetime import datetime

from ...celery_app import celery_app
from ... import models, database
from .cest_tasks import _update_experiment_toml_exclusions, _backup_output_directory, _parse_chemex_output
from .chemex_runner import run_chemex_job, get_chemex_image_info

logger = logging.getLogger(__name__)


def _write_toml(path: str, content: str):
    """Write raw TOML string content to a file."""
    with open(path, "w") as f:
        f.write(content)


def _setup_cpmg_directory(run_dir: str, config: dict):
    """
    Create the ChemEx directory structure and write all config files for CPMG.
    """
    experiments_dir = os.path.join(run_dir, "experiments")
    experiments_dir_cap = os.path.join(run_dir, "Experiments")
    parameters_dir = os.path.join(run_dir, "Parameters")
    methods_dir = os.path.join(run_dir, "Methods")
    data_dir = os.path.join(run_dir, "data")
    data_dir_cap = os.path.join(run_dir, "Data")
    output_dir = os.path.join(run_dir, "Output")

    for d in [experiments_dir, experiments_dir_cap, parameters_dir, methods_dir, data_dir, data_dir_cap, output_dir]:
        os.makedirs(d, exist_ok=True)

    # Extract excluded residues from config
    param_cfg = config.get("parameter_config") or {}
    excluded_residues = set(
        param_cfg.get("excludedResidues", [])
        or config.get("excluded_residues", [])
        or []
    )

    # Write / update experiment TOMLs
    generated_experiments = config.get("generatedExperiments", []) or config.get("experiments", [])
    if isinstance(generated_experiments, list) and len(generated_experiments) > 0:
        for i, exp_entry in enumerate(generated_experiments):
            fname = exp_entry.get("filename") if isinstance(exp_entry, dict) else f"exp_{i}.toml"
            exp_toml = exp_entry.get("toml_content", "") if isinstance(exp_entry, dict) else str(exp_entry)
            if not exp_toml and isinstance(exp_entry, dict) and exp_entry.get("path") and os.path.exists(exp_entry["path"]):
                try:
                    with open(exp_entry["path"], "r") as f:
                        exp_toml = f.read()
                except Exception:
                    pass
            exp_toml = _update_experiment_toml_exclusions(exp_toml, excluded_residues)
            _write_toml(os.path.join(experiments_dir, fname), exp_toml)
            _write_toml(os.path.join(experiments_dir_cap, fname), exp_toml)
    else:
        # Check if existing toml files exist in experiments_dir
        if os.path.exists(experiments_dir):
            for exp_f in os.listdir(experiments_dir):
                if exp_f.endswith(".toml"):
                    src = os.path.join(experiments_dir, exp_f)
                    with open(src, "r") as f:
                        content = _update_experiment_toml_exclusions(f.read(), excluded_residues)
                    _write_toml(os.path.join(experiments_dir_cap, exp_f), content)

    # Write parameter TOML
    parameter_toml = config.get("parameters_toml") or config.get("parameter_toml", "")
    if parameter_toml:
        _write_toml(os.path.join(parameters_dir, "parameters.toml"), parameter_toml)

    # Write method TOML (optional)
    method_toml = config.get("method_toml", "")
    if method_toml and method_toml.strip():
        _write_toml(os.path.join(methods_dir, "method.toml"), method_toml)

    # Ensure Data/ and data/ both have the .dat files
    if os.path.exists(data_dir):
        for df in os.listdir(data_dir):
            if df.endswith(".dat"):
                src = os.path.join(data_dir, df)
                dst = os.path.join(data_dir_cap, df)
                if not os.path.exists(dst):
                    try:
                        shutil.copy2(src, dst)
                    except Exception:
                        pass

    return {
        "experiments_dir": experiments_dir_cap,
        "parameters_dir": parameters_dir,
        "methods_dir": methods_dir,
        "data_dir": data_dir_cap,
        "output_dir": output_dir,
    }


def _build_cpmg_chemex_command(dirs: dict, config: dict) -> list:
    """Build the chemex fit command line arguments for CPMG."""
    cmd = ["fit"]

    # Experiment files
    experiments_dir = dirs["experiments_dir"]
    toml_files = [
        os.path.join(experiments_dir, f)
        for f in os.listdir(experiments_dir)
        if f.endswith(".toml")
    ]
    if toml_files:
        cmd.extend(["-e"] + toml_files)

    # Parameter files
    parameters_dir = dirs["parameters_dir"]
    param_files = [
        os.path.join(parameters_dir, f)
        for f in os.listdir(parameters_dir)
        if f.endswith(".toml")
    ]
    if param_files:
        cmd.extend(["-p"] + param_files)

    # Method files (optional)
    methods_dir = dirs["methods_dir"]
    method_files = [
        os.path.join(methods_dir, f)
        for f in os.listdir(methods_dir)
        if f.endswith(".toml")
    ]
    if method_files:
        cmd.extend(["-m"] + method_files)

    # Kinetic model
    model = config.get("model", "2st")
    cmd.extend(["-d", model])

    return cmd


@celery_app.task(bind=True)
def run_cpmg_analysis_task(self, analysis_uuid: str, config: dict):
    """
    Celery task to run a ChemEx CPMG fitting job inside an ephemeral Podman container.
    Supports Global or Individual fitting.
    """
    db = next(database.get_db())
    analysis = db.query(models.Analysis).filter(
        models.Analysis.analysis_uuid == analysis_uuid
    ).first()

    if not analysis:
        logger.error(f"CPMG Analysis {analysis_uuid} not found")
        return

    analysis.status = "RUNNING"
    analysis.celery_task_id = self.request.id if self.request else None
    
    # Record ChemEx container image digest and version
    digest, ver = get_chemex_image_info()
    if digest:
        analysis.chemex_image_digest = digest
    if ver:
        analysis.chemex_version = ver

    db.commit()

    try:
        project = analysis.project
        run_dir = os.path.join(
            project.local_directory_path, "cpmg_fitting", analysis.analysis_uuid
        )
        os.makedirs(run_dir, exist_ok=True)

        log_path = os.path.join(run_dir, "chemex.log")
        results_path = os.path.join(run_dir, "results.json")

        analysis.log_path = log_path
        analysis.results_path = results_path
        db.commit()

        # Backup existing output before run
        _backup_output_directory(run_dir)

        # Setup directory structure and write config files
        dirs = _setup_cpmg_directory(run_dir, config)

        fit_mode = config.get("fit_mode", "global")
        include_list = config.get("include", [])

        if fit_mode == "individual":
            if include_list:
                residues_to_fit = [str(r) for r in include_list]
            else:
                profiles = config.get("profiles", [])
                residues_to_fit = [p.get("residue") for p in profiles if p.get("residue")]
                if not residues_to_fit:
                    residues_to_fit = [None]
        else:
            residues_to_fit = [None]

        # Initialize log file
        with open(log_path, "w") as log_file:
            log_file.write(f"CPMG Analysis Started: {datetime.now().isoformat()}\n")
            log_file.write(f"Fit Mode: {fit_mode.upper()}\n")
            if analysis.chemex_image_digest:
                log_file.write(f"ChemEx Image Digest: {analysis.chemex_image_digest}\n")
            if analysis.chemex_version:
                log_file.write(f"ChemEx Version: {analysis.chemex_version}\n")
            log_file.write("=" * 60 + "\n\n")

        for idx, residue in enumerate(residues_to_fit):
            run_config = config.copy()
            output_dir = dirs["output_dir"]

            if fit_mode == "individual" and residue:
                run_config["include"] = [residue]
                output_dir = os.path.join(dirs["output_dir"], residue)
                os.makedirs(output_dir, exist_ok=True)

                with open(log_path, "a") as log_file:
                    log_file.write(f"\n--- Fitting Residue {idx+1}/{len(residues_to_fit)}: {residue} ---\n")

            cmd = _build_cpmg_chemex_command(dirs, run_config)
            cmd.extend(["-o", output_dir])

            # Run ChemEx via ephemeral container runner
            return_code = run_chemex_job(
                job_id=analysis_uuid,
                work_dir=run_dir,
                cmd_args=cmd,
                log_file=log_path,
            )

            # Check for cancellation (SIGKILL=137, SIGTERM=143)
            if return_code in (137, 143):
                logger.info(f"CPMG Analysis {analysis_uuid} was cancelled by user (exit code {return_code})")
                analysis.status = "CANCELLED"
                analysis.error_message = "Cancelled by user"
                analysis.completed_at = datetime.now()
                db.commit()
                return

            if return_code != 0 and fit_mode == "global":
                raise RuntimeError(f"ChemEx exited with return code {return_code}. Check logs.")

        with open(log_path, "a") as log_file:
            log_file.write(f"\n{'=' * 60}\n")
            log_file.write(f"Completed at: {datetime.now().isoformat()}\n")

        # Parse output results
        output_results = _parse_chemex_output(run_dir)

        with open(results_path, "w") as f:
            json.dump(
                {
                    "analysis_uuid": analysis_uuid,
                    "timestamp": datetime.now().isoformat(),
                    "fit_mode": fit_mode,
                    **output_results,
                },
                f,
                indent=4,
                default=str,
            )

        analysis.status = "COMPLETED"
        analysis.completed_at = datetime.now()
        db.commit()

    except Exception as e:
        logger.exception(f"CPMG Analysis {analysis_uuid} failed")
        analysis.status = "FAILED"
        analysis.error_message = str(e)
        if analysis.log_path:
            try:
                with open(analysis.log_path, "a") as f:
                    f.write(f"\n\nERROR: {str(e)}\n")
            except Exception:
                pass
        db.commit()
    finally:
        pid_file = os.path.join(run_dir, "chemex.pid") if "run_dir" in locals() else None
        if pid_file and os.path.exists(pid_file):
            try:
                os.remove(pid_file)
            except Exception:
                pass
        db.close()
