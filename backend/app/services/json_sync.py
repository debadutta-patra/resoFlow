import json
import os
from pathlib import Path
from typing import List, Dict, Any
from datetime import datetime
from sqlalchemy.orm import Session
from .. import models, schemas

def sync_project_to_json(db: Session, project: models.Project):
    """
    Serialize project and its spectra metadata to JSON files in the project directory.
    Project JSON acts as an index for all associated spectra.
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
            fitting_file = os.path.relpath(spectrum.results_json_path, project.local_directory_path)

        spectrum_data = {
            "spectrum_uuid": s_uuid,
            "project_uuid": project.project_uuid,
            "name": spectrum.name,
            "file_path": spectrum.file_path,
            "experiment_type": spectrum.experiment_type,
            "peaklist_path": spectrum.peaklist_path,
            "list_path": spectrum.list_path,
            "is_fitted": spectrum.is_fitted,
            "results_json_path": spectrum.results_json_path,
            "b0": spectrum.b0,
            "temperature": spectrum.temperature,
            "fitting_file": fitting_file,
            "peaktable_json_path": spectrum.peaktable_json_path
        }
        spectrum_json_path = os.path.join(project.local_directory_path, spectrum_filename)
        with open(spectrum_json_path, "w") as f:
            json.dump(spectrum_data, f, indent=4)

    # 2. Project metadata (the index)
    project_data = {
        "project_uuid": project.project_uuid,
        "name": project.name,
        "protein_sequence": project.protein_sequence,
        "molecular_weight": project.molecular_weight,
        "experiments": project.experiments,
        "created_at": project.created_at.isoformat() if project.created_at else None,
        "spectra_count": len(project.spectra),
        "spectra_files": spectra_files
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
    """
    project_json_path = os.path.join(directory_path, "project.json")
    if not os.path.exists(project_json_path):
        raise FileNotFoundError(f"Project JSON not found in {directory_path}")

    with open(project_json_path, "r") as f:
        project_data = json.load(f)

    # Transform project_uuid to uuid for internal DB compatibility if needed
    if "project_uuid" in project_data:
        project_data["uuid"] = project_data["project_uuid"]

    # Load spectra based on the manifest in project.json
    spectra = []
    spectra_files = project_data.get("spectra_files", [])
    
    if spectra_files:
        for filename in spectra_files:
            file_path = os.path.join(directory_path, filename)
            if os.path.exists(file_path):
                with open(file_path, "r") as f:
                    s_data = json.load(f)
                    if "spectrum_uuid" in s_data:
                        s_data["uuid"] = s_data["spectrum_uuid"]
                    
                    # Resolve fitting file path if it's relative
                    if s_data.get("fitting_file"):
                        fit_file = s_data["fitting_file"]
                        if not os.path.isabs(fit_file):
                            s_data["results_json_path"] = os.path.join(directory_path, fit_file)
                        else:
                            s_data["results_json_path"] = fit_file
                            
                    spectra.append(s_data)
    else:
        # Fallback for legacy projects
        for filename in os.listdir(directory_path):
            if filename.startswith("spectrum_") and filename.endswith(".json"):
                with open(os.path.join(directory_path, filename), "r") as f:
                    s_data = json.load(f)
                    if "spectrum_uuid" in s_data:
                        s_data["uuid"] = s_data["spectrum_uuid"]
                    
                    # Resolve fitting file path if it's relative
                    if s_data.get("fitting_file"):
                        fit_file = s_data["fitting_file"]
                        if not os.path.isabs(fit_file):
                            s_data["results_json_path"] = os.path.join(directory_path, fit_file)
                        else:
                            s_data["results_json_path"] = fit_file

                    spectra.append(s_data)
    
    project_data["spectra"] = spectra
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
