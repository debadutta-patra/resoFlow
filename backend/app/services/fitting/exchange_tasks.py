"""
Celery task to run ChemEx Exchange (Combined CEST + CPMG) analysis.

Manages the full lifecycle of a ChemEx combined fitting job:
  1. Sets up directory structure and writes TOML config files
  2. Launches `chemex fit` via ephemeral container runner
  3. Captures stdout/stderr to a log file
  4. Parses results using chemex_output protocol parser and updates the analysis record
"""

import os
import json
import logging
import shutil
from datetime import datetime
from pathlib import Path

from ...celery_app import celery_app
from ... import models, database
from .cest_tasks import _update_experiment_toml_exclusions, _backup_output_directory, _parse_chemex_output
from .chemex_runner import run_chemex_job, get_chemex_image_info
from .chemex_jobs import build_fit_spec
from ..path_utils import to_container_path, resolve_existing_path

logger = logging.getLogger(__name__)


def _write_toml(path: str, content: str):
    """Write raw TOML string content to a file."""
    with open(path, "w") as f:
        f.write(content)


def _setup_exchange_directory(run_dir: str, config: dict) -> dict:
    """
    Create the ChemEx directory structure and write all config files for Combined Exchange.
    """
    experiments_dir = os.path.join(run_dir, "Experiments")
    experiments_dir_lower = os.path.join(run_dir, "experiments")
    parameters_dir = os.path.join(run_dir, "Parameters")
    methods_dir = os.path.join(run_dir, "Methods")
    data_dir = os.path.join(run_dir, "Data")
    data_dir_lower = os.path.join(run_dir, "data")
    output_dir = os.path.join(run_dir, "Output")

    for d in [experiments_dir, experiments_dir_lower, parameters_dir, methods_dir, data_dir, data_dir_lower, output_dir]:
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
        # Clear existing toml files in experiments_dir to avoid mixing stale runs
        for exp_d in [experiments_dir, experiments_dir_lower]:
            if os.path.exists(exp_d):
                for f in os.listdir(exp_d):
                    if f.endswith(".toml"):
                        try:
                            os.remove(os.path.join(exp_d, f))
                        except Exception:
                            pass

        for i, exp_entry in enumerate(generated_experiments):
            fname = exp_entry.get("filename") if isinstance(exp_entry, dict) else f"exp_{i}.toml"
            exp_toml = exp_entry.get("toml_content", "") if isinstance(exp_entry, dict) else str(exp_entry)
            if not exp_toml and isinstance(exp_entry, dict) and exp_entry.get("path"):
                p = resolve_existing_path(exp_entry["path"], run_dir) or exp_entry["path"]
                if os.path.exists(p):
                    try:
                        with open(p, "r") as f:
                            exp_toml = f.read()
                    except Exception:
                        pass
            exp_toml = _update_experiment_toml_exclusions(exp_toml, excluded_residues)
            _write_toml(os.path.join(experiments_dir, fname), exp_toml)
            _write_toml(os.path.join(experiments_dir_lower, fname), exp_toml)
    else:
        # Check existing tomls in experiments_dir_lower or experiments_dir
        src_dir = experiments_dir_lower if os.path.exists(experiments_dir_lower) else experiments_dir
        if os.path.exists(src_dir):
            for f in os.listdir(src_dir):
                if f.endswith(".toml"):
                    try:
                        with open(os.path.join(src_dir, f), "r") as tf:
                            content = _update_experiment_toml_exclusions(tf.read(), excluded_residues)
                        _write_toml(os.path.join(experiments_dir, f), content)
                        _write_toml(os.path.join(experiments_dir_lower, f), content)
                    except Exception:
                        pass

    # Clean parameters_dir of existing .toml files to avoid mixing stale/output files (e.g. constrained.toml, fitted.toml, fixed.toml)
    if os.path.exists(parameters_dir):
        for f in os.listdir(parameters_dir):
            if f.endswith(".toml"):
                try:
                    os.remove(os.path.join(parameters_dir, f))
                except Exception:
                    pass

    # Clean methods_dir of existing .toml files
    if os.path.exists(methods_dir):
        for f in os.listdir(methods_dir):
            if f.endswith(".toml"):
                try:
                    os.remove(os.path.join(methods_dir, f))
                except Exception:
                    pass

    # Write parameter TOML
    parameter_toml = config.get("parameters_toml") or config.get("parameter_toml", "")
    if parameter_toml:
        _write_toml(os.path.join(parameters_dir, "parameters.toml"), parameter_toml)

    # Write method TOML (optional)
    method_toml = config.get("method_toml", "")
    if method_toml and method_toml.strip():
        _write_toml(os.path.join(methods_dir, "method.toml"), method_toml)

    # Sync data files into Data/ and data/
    data_files = config.get("data_files", {})
    if isinstance(data_files, dict):
        for residue_name, src_path in data_files.items():
            actual_src = resolve_existing_path(src_path, run_dir) or src_path
            if os.path.exists(actual_src):
                dest = os.path.join(data_dir, os.path.basename(actual_src))
                if not os.path.exists(dest):
                    try:
                        shutil.copy2(actual_src, dest)
                    except Exception:
                        pass

    if os.path.exists(data_dir_lower):
        for df in os.listdir(data_dir_lower):
            src = os.path.join(data_dir_lower, df)
            dst = os.path.join(data_dir, df)
            if not os.path.exists(dst):
                try:
                    if os.path.isdir(src):
                        shutil.copytree(src, dst, dirs_exist_ok=True)
                    else:
                        shutil.copy2(src, dst)
                except Exception:
                    pass

    return {
        "experiments_dir": experiments_dir,
        "parameters_dir": parameters_dir,
        "methods_dir": methods_dir,
        "data_dir": data_dir,
        "output_dir": output_dir,
    }





@celery_app.task(bind=True)
def run_exchange_analysis_task(self, analysis_uuid: str, config: dict):
    db = next(database.get_db())
    try:
        analysis = db.query(models.Analysis).filter_by(analysis_uuid=analysis_uuid).first()
        if not analysis:
            return

        project = analysis.project
        container_project_dir = to_container_path(project.local_directory_path) or project.local_directory_path
        run_dir = os.path.join(container_project_dir, "exchange_fitting", analysis.analysis_uuid)
        os.makedirs(run_dir, exist_ok=True)

        # Merge existing config if present
        cfg_path = os.path.join(run_dir, "config.json")
        if not os.path.exists(cfg_path):
            cfg_path = os.path.join(run_dir, "exchange_config.json")
        if os.path.exists(cfg_path):
            try:
                with open(cfg_path, "r") as f:
                    saved_cfg = json.load(f)
                    saved_cfg.update(config)
                    config = saved_cfg
            except Exception:
                pass

        analysis.status = "RUNNING"
        analysis.celery_task_id = self.request.id

        # Record ChemEx container image digest and version
        digest, ver = get_chemex_image_info()
        if digest:
            analysis.chemex_image_digest = digest
        if ver:
            analysis.chemex_version = ver
        db.commit()

        # Backup Output, results.json, and chemex.log
        _backup_output_directory(run_dir)

        # Setup directory structure & write TOML files
        dirs = _setup_exchange_directory(run_dir, config)

        log_path = os.path.join(run_dir, "chemex.log")
        results_path = os.path.join(run_dir, "results.json")

        analysis.log_path = log_path
        analysis.results_path = results_path
        db.commit()

        with open(log_path, "w") as log_file:
            log_file.write(f"Exchange (Combined CEST+CPMG) Analysis Started: {datetime.now().isoformat()}\n")
            if analysis.chemex_image_digest:
                log_file.write(f"ChemEx Image Digest: {analysis.chemex_image_digest}\n")
            if analysis.chemex_version:
                log_file.write(f"ChemEx Version: {analysis.chemex_version}\n")
            log_file.write("=" * 60 + "\n\n")

        spec = build_fit_spec(dirs, config, job_dir=run_dir)

        return_code = run_chemex_job(
            job_id=analysis_uuid,
            work_dir=run_dir,
            spec=spec,
            log_file=log_path,
        )

        db.refresh(analysis)
        if return_code in (130, 137, 143) or analysis.cancel_requested:
            logger.info(f"Exchange Analysis {analysis_uuid} was cancelled by user (exit code {return_code})")
            analysis.status = "CANCELLED"
            analysis.error_message = "Cancelled by user"
            analysis.completed_at = datetime.now()
            db.commit()
            return

        if return_code != 0:
            raise RuntimeError(f"ChemEx exited with return code {return_code}. Check logs.")

        with open(log_path, "a") as log_file:
            log_file.write(f"\n{'=' * 60}\n")
            log_file.write(f"Completed at: {datetime.now().isoformat()}\n")

        # Ingest results bundle and chain artifact prebuilding
        analysis.results_path = results_path
        try:
            from celery import chain
            from app.services.results_bundle.tasks import ingest_results_task, prebuild_artifacts_task

            chain(
                ingest_results_task.si(analysis_uuid),
                prebuild_artifacts_task.si(analysis_uuid),
            ).apply_async()
        except Exception as queue_exc:
            logger.warning(f"Could not queue ingest chain for {analysis_uuid}, executing directly: {queue_exc}")
            from app.services.results_bundle.ingest import ingest_results
            meta = ingest_results(
                run_dir=run_dir,
                analysis_uuid=analysis_uuid,
                chemex_version=analysis.chemex_version,
                analysis_name=analysis.name,
                analysis_type="EXCHANGE",
            )
            analysis.status = "COMPLETED"
            analysis.bundle_status = "VALID"
            analysis.summary_redchi = meta.get("summary_redchi")
            analysis.summary_n_residues = meta.get("summary_n_residues")
            analysis.completed_at = datetime.now()
            db.commit()

    except Exception as e:
        logger.exception(f"Exchange Analysis {analysis_uuid} failed")
        db.refresh(analysis)
        analysis.status = "FAILED"
        analysis.error_message = str(e)
        if analysis.log_path:
            try:
                with open(analysis.log_path, "a") as f:
                    f.write(f"\n\nERROR: {str(e)}\n")
            except Exception:
                pass
        analysis.completed_at = datetime.now()
        db.commit()
    finally:
        pid_file = os.path.join(run_dir, "chemex.pid") if "run_dir" in locals() else None
        if pid_file and os.path.exists(pid_file):
            try:
                os.remove(pid_file)
            except Exception:
                pass
        db.close()
