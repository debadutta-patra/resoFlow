"""
Celery task to run ChemEx CEST analysis.

This module manages the full lifecycle of a ChemEx fitting job:
  1. Creates the directory structure and TOML config files
  2. Launches `chemex fit` as a subprocess
  3. Captures stdout/stderr to a log file
  4. Parses results and updates the analysis record
"""

import os
import json
import logging
import subprocess
import shutil
from datetime import datetime

from ...celery_app import celery_app
from ... import models, database
from .chemex_runner import run_chemex_job, get_chemex_image_info

logger = logging.getLogger(__name__)


def _write_toml(path: str, content: str):
    """Write raw TOML string content to a file."""
    with open(path, "w") as f:
        f.write(content)


def _update_experiment_toml_exclusions(toml_content: str, excluded_residues: set) -> str:
    """Comment out excluded residues in [data.profiles] and uncomment active ones."""
    if not toml_content:
        return ""

    from .spin_system import SpinSystemKey
    parsed_exclusions = [SpinSystemKey.parse(str(r)) for r in excluded_residues]
    excluded_nums = {sp.res_num for sp in parsed_exclusions if sp.res_num > 0}
    excluded_canonical = {sp.canonical.upper() for sp in parsed_exclusions if sp.canonical}
    excluded_raw = {str(r).strip().upper() for r in excluded_residues}

    def is_excluded(res_str: str) -> bool:
        if res_str.upper() in excluded_raw:
            return True
        sp = SpinSystemKey.parse(res_str)
        if sp.canonical and sp.canonical.upper() in excluded_canonical:
            return True
        if sp.res_num and sp.res_num in excluded_nums:
            return True
        return False

    import re
    lines = toml_content.splitlines()
    out_lines = []
    in_profiles = False

    for line in lines:
        stripped = line.strip()
        sec_m = re.match(r"^\[([A-Za-z0-9_.-]+)\]$", stripped)
        if sec_m:
            sec_name = sec_m.group(1).strip().lower()
            in_profiles = (sec_name == "data.profiles")
            out_lines.append(line)
            continue

        if in_profiles:
            m = re.match(r"^(#\s*)?([A-Za-z0-9_.-]+)\s*=\s*(.+)$", stripped)
            if m:
                res_key = m.group(2).strip()
                val_part = m.group(3).strip()
                if is_excluded(res_key):
                    out_lines.append(f'# {res_key} = {val_part}')
                else:
                    out_lines.append(f'{res_key} = {val_part}')
                continue

        out_lines.append(line)

    return "\n".join(out_lines) + ("\n" if toml_content.endswith("\n") else "")


def _setup_cest_directory(run_dir: str, config: dict):
    """
    Create the ChemEx directory structure and write all config files.

    Expected config keys:
      - experiment_toml: str  (raw TOML content for the experiment file)
      - parameter_toml: str   (raw TOML content for parameters)
      - method_toml: str       (raw TOML content for methods, may be empty)
      - data_files: dict       (mapping of residue_name -> absolute path to .out file)
      - model: str             (kinetic model, default "2st")
      - include: list[int]     (residue numbers to include, optional)
      - exclude: list[int]     (residue numbers to exclude, optional)
    """
    experiments_dir = os.path.join(run_dir, "Experiments")
    parameters_dir = os.path.join(run_dir, "Parameters")
    methods_dir = os.path.join(run_dir, "Methods")
    data_dir = os.path.join(run_dir, "Data")
    output_dir = os.path.join(run_dir, "Output")

    for d in [experiments_dir, parameters_dir, methods_dir, data_dir, output_dir]:
        os.makedirs(d, exist_ok=True)

    # Extract excluded residues from config
    param_cfg = config.get("parameter_config") or {}
    excluded_residues = set(
        param_cfg.get("excludedResidues", [])
        or config.get("excluded_residues", [])
        or []
    )

    # Check for multi-experiment config: generatedExperiments or experiments list
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
    else:
        # Fallback to singular experiment_toml if provided
        exp_toml = config.get("experiment_toml", "")
        if exp_toml:
            exp_toml = _update_experiment_toml_exclusions(exp_toml, excluded_residues)
            _write_toml(os.path.join(experiments_dir, "cest_15n.toml"), exp_toml)

    # Write parameter TOML
    parameter_toml = config.get("parameter_toml", "")
    if parameter_toml:
        _write_toml(os.path.join(parameters_dir, "parameters.toml"), parameter_toml)

    # Write method TOML (optional)
    method_toml = config.get("method_toml", "")
    if method_toml.strip():
        _write_toml(os.path.join(methods_dir, "method.toml"), method_toml)

    # Symlink or copy data files into Data/ directory
    data_files = config.get("data_files", {})
    for residue_name, src_path in data_files.items():
        if os.path.exists(src_path):
            dest = os.path.join(data_dir, os.path.basename(src_path))
            if not os.path.exists(dest):
                try:
                    os.symlink(src_path, dest)
                except OSError:
                    # Fallback to copy if symlinks not supported
                    shutil.copy2(src_path, dest)

    return {
        "experiments_dir": experiments_dir,
        "parameters_dir": parameters_dir,
        "methods_dir": methods_dir,
        "data_dir": data_dir,
        "output_dir": output_dir,
    }


def _backup_output_directory(run_dir: str):
    """Backup any existing Output, results.json, and chemex.log."""
    output_dir = os.path.join(run_dir, "Output")
    output_bak = os.path.join(run_dir, "Output_bak")
    
    results_path = os.path.join(run_dir, "results.json")
    results_bak = os.path.join(run_dir, "results_bak.json")
    
    log_path = os.path.join(run_dir, "chemex.log")
    log_bak = os.path.join(run_dir, "chemex_bak.log")

    # Backup Output folder
    if os.path.exists(output_dir):
        try:
            if os.path.exists(output_bak):
                shutil.rmtree(output_bak, ignore_errors=True)
            shutil.move(output_dir, output_bak)
        except Exception as e:
            logger.warning(f"Failed to backup Output directory: {e}")

    # Backup results.json
    if os.path.exists(results_path):
        try:
            if os.path.exists(results_bak):
                os.remove(results_bak)
            shutil.move(results_path, results_bak)
        except Exception as e:
            logger.warning(f"Failed to backup results.json: {e}")

    # Backup chemex.log
    if os.path.exists(log_path):
        try:
            if os.path.exists(log_bak):
                os.remove(log_bak)
            shutil.move(log_path, log_bak)
        except Exception as e:
            logger.warning(f"Failed to backup chemex.log: {e}")



def _build_chemex_command(dirs: dict, config: dict) -> list:
    """Build the chemex fit command line arguments."""
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


def parse_individual_plot(filepath):
    """Parse a plot file that lacks [residue] headers (simple XY format)."""
    import math
    pts = {"x": [], "y": [], "y_err": []}
    try:
        with open(filepath, "r") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or line.startswith("["):
                    continue
                parts = line.split()
                if len(parts) >= 2:
                    try:
                        x_val = float(parts[0])
                        y_val = float(parts[1])
                        y_err = float(parts[2]) if len(parts) >= 3 else 0.0
                        if math.isinf(x_val) or math.isnan(x_val):
                            continue
                        if math.isinf(y_val) or math.isnan(y_val):
                            continue
                        if math.isinf(y_err) or math.isnan(y_err):
                            y_err = 0.0
                        pts["x"].append(x_val)
                        pts["y"].append(y_val)
                        pts["y_err"].append(y_err)
                    except (ValueError, IndexError):
                        continue
    except Exception:
        pass
    return pts



def _parse_chemex_output(output_dir: str) -> dict:
    """
    Parse ChemEx output tree using the conforming chemex_output protocol parser (§1.1–§1.13).
    Returns a step-aware, typed dictionary with backward-compatible global/residues access.
    """
    from .chemex_output import parse_output_tree

    target_dir = os.path.join(output_dir, "Output") if os.path.isdir(os.path.join(output_dir, "Output")) else output_dir
    run_res = parse_output_tree(target_dir)

    primary_step = run_res.primary_step
    if primary_step is None and run_res.step_order:
        primary_step = run_res.steps.get(run_res.step_order[-1])

    global_dict: dict = {}
    residues_dict: dict = {}

    if primary_step is not None:
        # Populate globals with both lower and upper case keys for compatibility
        for g_key, g_val in primary_step.globals.items():
            k_lower = g_key.lower()
            global_dict[k_lower] = g_val.value
            global_dict[g_key] = g_val.value
            if g_val.has_stderr and g_val.stderr is not None:
                global_dict[f"{k_lower}_err"] = g_val.stderr
                global_dict[f"{g_key}_err"] = g_val.stderr

        if primary_step.statistics is not None:
            st = primary_step.statistics
            global_dict["chisqr"] = st.chisqr
            global_dict["chi2"] = st.chisqr
            global_dict["redchi"] = st.redchi
            global_dict["chi2_red"] = st.redchi
            global_dict["ndata"] = st.ndata
            global_dict["nvarys"] = st.nvarys
            global_dict["pvalue"] = st.pvalue
            global_dict["ks_pvalue"] = st.ks_pvalue
            global_dict["aic"] = st.aic
            global_dict["bic"] = st.bic

        # Populate residues
        for res_key, res_model in primary_step.residues.items():
            params: dict = {}
            for p_sec, p_val in res_model.parameters.items():
                sec_name = p_sec.split(",")[0].lower().strip().strip('"')
                params[sec_name] = p_val.value
                if p_val.has_stderr and p_val.stderr is not None:
                    params[f"{sec_name}_err"] = p_val.stderr

            if res_model.cs_a is not None:
                params["cs_a"] = res_model.cs_a.value
                if res_model.cs_a.has_stderr and res_model.cs_a.stderr is not None:
                    params["cs_a_err"] = res_model.cs_a.stderr
            if res_model.cs_b is not None:
                params["cs_b"] = res_model.cs_b.value
                if res_model.cs_b.has_stderr and res_model.cs_b.stderr is not None:
                    params["cs_b_err"] = res_model.cs_b.stderr
            if res_model.dw_ab is not None:
                params["dw_ab"] = res_model.dw_ab.value
                params["dw"] = res_model.dw_ab.value
                if res_model.dw_ab.has_stderr and res_model.dw_ab.stderr is not None:
                    params["dw_ab_err"] = res_model.dw_ab.stderr
            if res_model.r1_a is not None:
                params["r1_a"] = res_model.r1_a.value
            if res_model.r2_a is not None:
                params["r2_a"] = res_model.r2_a.value
            if res_model.r2_b is not None:
                params["r2_b"] = res_model.r2_b.value

            if res_model.chi2 is not None:
                params["chi2"] = res_model.chi2
            elif global_dict.get("chi2"):
                params["chi2"] = global_dict["chi2"]

            if res_model.chi2_red is not None:
                params["chi2_red"] = res_model.chi2_red
            elif global_dict.get("chi2_red"):
                params["chi2_red"] = global_dict["chi2_red"]

            residues_dict[res_key] = {
                "parameters": params,
                "experiments": res_model.experiments,
                "chi2": res_model.chi2,
                "chi2_red": res_model.chi2_red,
                "ndata": res_model.ndata,
                "nvarys": res_model.nvarys,
            }

    output_files: list[str] = []
    if os.path.exists(output_dir):
        for root_dir, _, files in os.walk(output_dir):
            for f in files:
                output_files.append(os.path.relpath(os.path.join(root_dir, f), output_dir))

    return {
        "global": global_dict,
        "residues": residues_dict,
        "steps": {sname: s.model_dump(mode="json") for sname, s in run_res.steps.items()},
        "step_order": run_res.step_order,
        "is_multi_step": run_res.is_multi_step,
        "primary_step": primary_step.name if primary_step else "",
        "state": run_res.state.value if hasattr(run_res.state, "value") else str(run_res.state),
        "is_provisional": run_res.is_provisional,
        "can_continue_fit": run_res.can_continue_fit,
        "continue_explanation": run_res.continue_explanation,
        "restart_file_path": run_res.restart_file_path,
        "provenance": run_res.provenance.model_dump(mode="json") if run_res.provenance else None,
        "outcome": run_res.outcome.model_dump(mode="json") if run_res.outcome else None,
        "warnings": [w.model_dump(mode="json") for w in run_res.warnings],
        "output_files": output_files,
        "fit_mode": "global",
    }


@celery_app.task(bind=True)
def run_cest_analysis_task(self, analysis_uuid: str, config: dict):
    """
    Celery task to run a ChemEx CEST fitting job.
    Supports Global (all residues together) or Individual (one run per residue) fitting.
    """
    db = next(database.get_db())
    analysis = db.query(models.Analysis).filter(
        models.Analysis.analysis_uuid == analysis_uuid
    ).first()

    if not analysis:
        logger.error(f"CEST Analysis {analysis_uuid} not found")
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
            project.local_directory_path, "cest_fitting", analysis.analysis_uuid
        )
        os.makedirs(run_dir, exist_ok=True)

        log_path = os.path.join(run_dir, "chemex.log")
        results_path = os.path.join(run_dir, "results.json")

        analysis.log_path = log_path
        analysis.results_path = results_path
        db.commit()

        # Backup existing results before creating new ones
        _backup_output_directory(run_dir)

        # Setup directory structure and write config files
        dirs = _setup_cest_directory(run_dir, config)
        
        fit_mode = config.get("fit_mode", "global")
        
        # Determine residues to fit
        include_list = config.get("include", [])
        if fit_mode == "individual":
            # Extract set of residues from data_files or include list
            if include_list:
                # Standardize to {num}N format
                residues_to_fit = [str(r) + "N" if str(r).isdigit() else str(r) for r in include_list]
            else:
                data_files = config.get("data_files", {})
                residues_to_fit = sorted(list(set(k.split(":")[0] for k in data_files.keys())))
        else:
            residues_to_fit = [None] # Single global run

        # Clear/Create log file
        with open(log_path, "w") as log_file:
            log_file.write(f"CEST Analysis Started: {datetime.now().isoformat()}\n")
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

            # Build command
            cmd = _build_chemex_command(dirs, run_config)
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
                logger.info(f"CEST Analysis {analysis_uuid} was cancelled by user (exit code {return_code})")
                analysis.status = "CANCELLED"
                analysis.error_message = "Cancelled by user"
                analysis.completed_at = datetime.now()
                db.commit()
                return

            if return_code != 0 and fit_mode == "global":
                raise RuntimeError(f"ChemEx exited with return code {return_code}. Check logs.")

        # Finalize
        with open(log_path, "a") as log_file:
            log_file.write(f"\n{'=' * 60}\n")
            log_file.write(f"Completed at: {datetime.now().isoformat()}\n")

        # Parse ALL output directories using the main run_dir (parent of Output)
        output_results = _parse_chemex_output(run_dir)

        # Save results
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
        logger.exception(f"CEST Analysis {analysis_uuid} failed")
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
        pid_file = os.path.join(run_dir, "chemex.pid") if 'run_dir' in locals() else None
        if pid_file and os.path.exists(pid_file):
            try:
                os.remove(pid_file)
            except Exception:
                pass
        db.close()
