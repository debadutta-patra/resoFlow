import json
import os
from pathlib import Path
from typing import List, Dict, Any
from datetime import datetime
from sqlalchemy.orm import Session
from .. import models, schemas

from .path_utils import to_container_path, to_host_path, resolve_existing_path

def sync_project_to_json(db: Session, project: models.Project):
    """
    Serialize project and its spectra metadata to JSON files in the project directory.
    Project JSON acts as an index for all associated spectra and analyses.
    """
    if not project.local_directory_path or not os.path.isdir(project.local_directory_path):
        return

    # 1. Individual spectra metadata first to collect filenames
    spectra_files = []
    for spectrum in project.spectra:
        s_uuid = spectrum.spectrum_uuid or f"legacy_{spectrum.id}"
        spectrum_filename = f"spectrum_{s_uuid}.json"
        spectra_files.append(spectrum_filename)
        
        # Check for fitting result
        fitting_file = None
        if spectrum.is_fitted and spectrum.results_json_path:
            # Store relative path for portability
            try:
                fitting_file = os.path.relpath(spectrum.results_json_path, project.local_directory_path)
            except ValueError:
                fitting_file = spectrum.results_json_path

        # Check for peaktable file
        peaktable_file = None
        if spectrum.peaktable_json_path:
            try:
                peaktable_file = os.path.relpath(spectrum.peaktable_json_path, project.local_directory_path)
            except ValueError:
                peaktable_file = spectrum.peaktable_json_path
        else:
            default_pt = os.path.join(project.local_directory_path, "peaktables", f"peaktable_{s_uuid}.json")
            if os.path.exists(default_pt):
                peaktable_file = os.path.join("peaktables", f"peaktable_{s_uuid}.json")
                spectrum.peaktable_json_path = default_pt

        spectrum_data = {
            "spectrum_uuid": s_uuid,
            "project_uuid": project.project_uuid,
            "name": spectrum.name,
            "file_path": spectrum.file_path,
            "experiment_type": spectrum.experiment_type,
            "peaklist_path": spectrum.peaklist_path,
            "list_path": spectrum.list_path,
            "vclist_path": spectrum.vclist_path,
            "vdlist_path": spectrum.vdlist_path,
            "f3list_path": spectrum.f3list_path,
            "delay": spectrum.delay,
            "t_relax": spectrum.t_relax,
            "b1": spectrum.b1,
            "hetnoe_mode": spectrum.hetnoe_mode,
            "is_fitted": spectrum.is_fitted,
            "results_json_path": spectrum.results_json_path,
            "b0": spectrum.b0,
            "temperature": spectrum.temperature,
            "carrier": spectrum.carrier,
            "fitting_file": fitting_file,
            "peaktable_json_path": spectrum.peaktable_json_path,
            "peaktable_file": peaktable_file
        }
        spectrum_json_path = os.path.join(project.local_directory_path, spectrum_filename)
        with open(spectrum_json_path, "w") as f:
            json.dump(spectrum_data, f, indent=4)

    # Serialize analyses index
    analyses_data = []
    for a in project.analyses:
        rel_results = None
        if a.results_path:
            try:
                rel_results = os.path.relpath(a.results_path, project.local_directory_path)
            except ValueError:
                rel_results = a.results_path
        rel_log = None
        if a.log_path:
            try:
                rel_log = os.path.relpath(a.log_path, project.local_directory_path)
            except ValueError:
                rel_log = a.log_path

        analyses_data.append({
            "analysis_uuid": a.analysis_uuid,
            "name": a.name,
            "analysis_type": a.analysis_type,
            "status": a.status,
            "parameters": a.parameters,
            "use_height": a.use_height,
            "results_path": a.results_path,
            "results_file": rel_results,
            "log_path": a.log_path,
            "log_file": rel_log,
            "spectrum_uuids": [s.spectrum_uuid for s in a.spectra if s.spectrum_uuid]
        })

    # 2. Project metadata (the index)
    project_data = {
        "project_uuid": project.project_uuid,
        "name": project.name,
        "protein_sequence": project.protein_sequence,
        "molecular_weight": project.molecular_weight,
        "experiments": project.experiments,
        "created_at": project.created_at.isoformat() if project.created_at else None,
        "spectra_count": len(project.spectra),
        "spectra_files": spectra_files,
        "analyses": analyses_data
    }
    
    project_json_path = os.path.join(project.local_directory_path, "project.json")
    with open(project_json_path, "w") as f:
        json.dump(project_data, f, indent=4)


def save_fitting_to_json(spectrum: models.Spectrum, project_path: str, results: list, summary: dict, fitting_dir: str = None):
    """
    Save peak fitting results and summary to a JSON file using spectrum UUID.
    Restructured into a nested format to reduce redundancy across planes.
    """
    if not project_path or not os.path.isdir(project_path):
        return None

    # Identify fields that vary by plane
    plane_varying_fields = {
        "plane", "amp", "amp_err", "height", "height_err", 
        "chisqr", "redchi", "residual_sum", "aic", "fit_status"
    }

    # Transform flat results into nested structure by assignment
    nested_results = []
    assignments = {} # map assignment -> result_object

    for row in results:
        assignment = row.get("assignment", "unassigned")
        
        if assignment not in assignments:
            # Create a new entry with static fields
            static_entry = {}
            for k, v in row.items():
                if k not in plane_varying_fields:
                    static_entry[k] = v
            
            static_entry["planes"] = []
            nested_results.append(static_entry)
            assignments[assignment] = static_entry
        
        # Add plane-specific data
        plane_data = {}
        for k in plane_varying_fields:
            if k in row:
                plane_data[k] = row[k]
        
        assignments[assignment]["planes"].append(plane_data)

    fitting_data = {
        "spectrum_uuid": spectrum.spectrum_uuid,
        "summary": summary,
        "results": nested_results, # Now nested
        "timestamp": datetime.now().isoformat(),
        "format_version": "2.0" # Indicating nested format
    }
    
    s_uuid = spectrum.spectrum_uuid or f"legacy_{spectrum.id}"
    
    # New organized folder structure
    if not fitting_dir:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        run_folder_name = f"run_{timestamp}"
        fitting_dir = os.path.join(project_path, "peak_fitting", run_folder_name)
    
    os.makedirs(fitting_dir, exist_ok=True)
    
    filename = f"peak_fitting_{s_uuid}.json"
    filepath = os.path.join(fitting_dir, filename)
    
    with open(filepath, "w") as f:
        json.dump(fitting_data, f, indent=4)
    
    return filepath


def load_project_from_json(directory_path: str) -> Dict[str, Any]:
    """
    Read JSON files from a directory to reconstruct a project using the index in project.json.
    Translates host paths to container paths if running in a containerized environment.
    """
    # 1. Resolve directory path (try container path, host path, or direct)
    resolved_dir = to_container_path(directory_path)
    if not resolved_dir or not os.path.isdir(resolved_dir):
        resolved_dir = resolve_existing_path(directory_path) or directory_path
    
    if not os.path.isdir(resolved_dir):
        raise FileNotFoundError(f"Project directory not found: {directory_path}")

    project_json_path = os.path.join(resolved_dir, "project.json")
    if not os.path.exists(project_json_path):
        raise FileNotFoundError(f"Project JSON not found in {directory_path}")

    with open(project_json_path, "r") as f:
        project_data = json.load(f)

    project_data["local_directory_path"] = resolved_dir

    # Transform project_uuid to uuid for internal DB compatibility if needed
    if "project_uuid" in project_data:
        project_data["uuid"] = project_data["project_uuid"]

    # Load spectra based on the manifest in project.json
    spectra = []
    spectra_files = project_data.get("spectra_files", [])
    
    spectrum_json_files = []
    if spectra_files:
        spectrum_json_files = [os.path.join(resolved_dir, f) for f in spectra_files]
    else:
        # Fallback for legacy projects
        for filename in os.listdir(resolved_dir):
            if filename.startswith("spectrum_") and filename.endswith(".json"):
                spectrum_json_files.append(os.path.join(resolved_dir, filename))

    for file_path in spectrum_json_files:
        if os.path.exists(file_path):
            with open(file_path, "r") as f:
                s_data = json.load(f)
                if "spectrum_uuid" in s_data:
                    s_data["uuid"] = s_data["spectrum_uuid"]
                
                s_uuid = s_data.get("spectrum_uuid", "")
                
                # Resolve fitting file path
                fit_file = s_data.get("fitting_file")
                if fit_file:
                    if not os.path.isabs(fit_file):
                        s_data["results_json_path"] = os.path.join(resolved_dir, fit_file)
                    else:
                        s_data["results_json_path"] = resolve_existing_path(fit_file, resolved_dir)
                elif s_data.get("results_json_path"):
                    s_data["results_json_path"] = resolve_existing_path(s_data["results_json_path"], resolved_dir)
                
                # Resolve peaktable path
                peaktable_file = s_data.get("peaktable_file")
                if peaktable_file and not os.path.isabs(peaktable_file):
                    s_data["peaktable_json_path"] = os.path.join(resolved_dir, peaktable_file)
                elif s_data.get("peaktable_json_path"):
                    s_data["peaktable_json_path"] = resolve_existing_path(s_data["peaktable_json_path"], resolved_dir)
                else:
                    cand = os.path.join(resolved_dir, "peaktables", f"peaktable_{s_uuid}.json")
                    if os.path.exists(cand):
                        s_data["peaktable_json_path"] = cand

                # Resolve raw file_path and peaklist_path
                if s_data.get("file_path"):
                    s_data["file_path"] = resolve_existing_path(s_data["file_path"], resolved_dir)
                if s_data.get("peaklist_path"):
                    s_data["peaklist_path"] = resolve_existing_path(s_data["peaklist_path"], resolved_dir)

                spectra.append(s_data)
    
    project_data["spectra"] = spectra

    # Load / discover analyses
    analyses = project_data.get("analyses", [])
    known_analysis_uuids = {a.get("analysis_uuid") for a in analyses if a.get("analysis_uuid")}

    # Scan directory for existing analysis runs
    type_folders = [
        ("cest_fitting", "15N-CEST"),
        ("cpmg_fitting", "CPMG"),
        ("r1_fitting", "R1"),
        ("r2_fitting", "R2"),
    ]
    for folder_name, analysis_type in type_folders:
        parent_dir = os.path.join(resolved_dir, folder_name)
        if not os.path.isdir(parent_dir):
            continue
        for entry in os.listdir(parent_dir):
            analysis_dir = os.path.join(parent_dir, entry)
            if not os.path.isdir(analysis_dir):
                continue
            a_uuid = entry
            if a_uuid in known_analysis_uuids:
                continue

            results_json = os.path.join(analysis_dir, "results.json")
            has_results = os.path.exists(results_json)
            log_path = os.path.join(analysis_dir, "chemex.log")
            if not os.path.exists(log_path):
                log_path = None

            config_params = None
            for cfg_name in ["config.json", "cpmg_config.json"]:
                cfg_file = os.path.join(analysis_dir, cfg_name)
                if os.path.exists(cfg_file):
                    try:
                        with open(cfg_file, "r") as cf:
                            config_params = cf.read()
                        break
                    except Exception:
                        pass

            analyses.append({
                "analysis_uuid": a_uuid,
                "name": f"{folder_name.split('_')[0]}_{a_uuid[:8]}",
                "analysis_type": analysis_type,
                "status": "COMPLETED" if has_results else "PENDING",
                "parameters": config_params,
                "use_height": False,
                "results_path": results_json if has_results else None,
                "log_path": log_path,
                "spectrum_uuids": []
            })
            known_analysis_uuids.add(a_uuid)

    project_data["analyses"] = analyses
    return project_data

def save_peaktable_to_json(spectrum: models.Spectrum, project_path: str, peaks: list):
    """
    Save the current peaktable to a JSON file.
    """
    if not project_path or not os.path.isdir(project_path):
        return None

    s_uuid = spectrum.spectrum_uuid or f"legacy_{spectrum.id}"
    peaktable_dir = os.path.join(project_path, "peaktables")
    os.makedirs(peaktable_dir, exist_ok=True)

    filename = f"peaktable_{s_uuid}.json"
    filepath = os.path.join(peaktable_dir, filename)

    data = {
        "spectrum_uuid": s_uuid,
        "timestamp": datetime.now().isoformat(),
        "peaks": peaks
    }

    with open(filepath, "w") as f:
        json.dump(data, f, indent=4)

    return filepath
