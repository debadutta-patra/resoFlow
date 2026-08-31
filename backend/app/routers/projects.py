from fastapi import APIRouter, Depends, HTTPException, status, Query, Body
from sqlalchemy.orm import Session
import os
import uuid
import re
from typing import List
from .. import models, schemas, database, security
from ..services.json_sync import sync_project_to_json, load_project_from_json
from ..services.cleanup import delete_directory_safely, cleanup_spectrum_files
from .deps import get_project, get_spectrum
from ..services.spectrum import plotting
from ..services.fitting.io import BrukerUC

router = APIRouter(prefix="/api/projects", tags=["projects"])

def extract_b0(file_path: str):
    """Extract B0 (magnetic field) from FT2 or Bruker file using nmrglue."""
    if not file_path or not os.path.exists(file_path):
        return None
    try:
        import nmrglue as ng
        if os.path.isdir(file_path):
            # Potential Bruker pdata directory
            # Try to read pdata, then get SFO1 from acqus
            dic, _ = ng.bruker.read_pdata(file_path)
            b0 = dic.get('acqus', {}).get('SFO1')
            if b0 is not None:
                return float(b0)
        else:
            dic, _ = ng.pipe.read(file_path)
            # FDF2OBS is the usual location for spectrometer frequency (B0 in MHz)
            b0 = dic.get('FDF2OBS')
            if b0 is not None:
                return float(b0)
    except Exception as e:
        print(f"Error extracting B0 from {file_path}: {e}")
    return None

# Removed local estimate_noise_mad in favor of plotting.estimate_noise_mad

@router.get("", response_model=List[schemas.Project])
def list_projects(current_user: models.User = Depends(security.get_current_user), db: Session = Depends(database.get_db)):
    return db.query(models.Project).filter(models.Project.user_id == current_user.id).all()

@router.post("", response_model=schemas.Project)
def create_project(project: schemas.ProjectCreate, current_user: models.User = Depends(security.get_current_user), db: Session = Depends(database.get_db)):
    if not os.path.isdir(project.local_directory_path):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Directory not found on host machine"
        )
    
    # Sanitize project name for folder name
    sanitized_name = re.sub(r'[^\w\s-]', '', project.name).strip().lower()
    sanitized_name = re.sub(r'[-\s]+', '_', sanitized_name)
    
    # Create the project subfolder
    project_folder_path = os.path.join(project.local_directory_path, sanitized_name)
    
    # If folder already exists, append a unique suffix
    if os.path.exists(project_folder_path):
        project_folder_path = f"{project_folder_path}_{uuid.uuid4().hex[:8]}"
    
    try:
        os.makedirs(project_folder_path, exist_ok=True)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to create project folder: {str(e)}"
        )
    
    db_project = models.Project(
        name=project.name,
        local_directory_path=project_folder_path,
        user_id=current_user.id
    )
    db.add(db_project)
    db.commit()
    db.refresh(db_project)
    
    # Sync to JSON
    sync_project_to_json(db, db_project)
    
    return db_project

@router.get("/{project_uuid}", response_model=schemas.Project)
def get_project_details(project: models.Project = Depends(get_project)):
    return project

@router.put("/{project_uuid}", response_model=schemas.Project)
def update_project(project_update: schemas.ProjectUpdate, project: models.Project = Depends(get_project), db: Session = Depends(database.get_db)):
    
    update_data = project_update.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(project, key, value)
        
    db.commit()
    db.refresh(project)
    
    # Sync to JSON
    sync_project_to_json(db, project)
    
    return project

@router.post("/{project_uuid}/spectra", response_model=schemas.Spectrum)
def add_spectrum_to_project(spectrum: schemas.SpectrumCreate, project: models.Project = Depends(get_project), db: Session = Depends(database.get_db)):

    db_spectrum = models.Spectrum(
        **spectrum.model_dump(),
        project_id=project.id,
    )
    
    # Auto-extract B0 if not provided
    if db_spectrum.b0 is None:
        db_spectrum.b0 = extract_b0(db_spectrum.file_path)

    db.add(db_spectrum)
    db.commit()
    db.refresh(db_spectrum)
    
    # Sync to JSON
    sync_project_to_json(db, project)
    
    return db_spectrum

@router.delete("/{project_uuid}/spectra/{spectrum_uuid}")
def remove_spectrum_from_project(spectrum: models.Spectrum = Depends(get_spectrum), db: Session = Depends(database.get_db)):
    project = spectrum.project

    # Clean up files before deleting from DB
    if project.local_directory_path:
        cleanup_spectrum_files(spectrum, project.local_directory_path)
    
    db.delete(spectrum)
    db.commit()
    
    # Sync project JSON to remove the spectrum from index
    sync_project_to_json(db, project)
    
    return {"detail": "Spectrum removed successfully"}

@router.put("/{project_uuid}/spectra/{spectrum_uuid}", response_model=schemas.Spectrum)
def update_spectrum_in_project(spectrum_update: schemas.SpectrumUpdate, spectrum: models.Spectrum = Depends(get_spectrum), db: Session = Depends(database.get_db)):
    project = spectrum.project

    update_data = spectrum_update.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(spectrum, key, value)
    
    # If file_path was updated but b0 was not, try to re-extract
    if "file_path" in update_data and "b0" not in update_data:
        spectrum.b0 = extract_b0(spectrum.file_path)
        
    db.commit()
    db.refresh(spectrum)
    
    # Sync to JSON
    sync_project_to_json(db, project)
    
    return spectrum

@router.get("/{project_uuid}/spectra/{spectrum_uuid}/data", response_model=schemas.SpectrumDataResponse)
def get_spectrum_data(
    base_level: float = Query(0.0),
    multiplier: float = Query(1.8),
    number_contours: int = Query(10),
    spectrum: models.Spectrum = Depends(get_spectrum)
):
    if not spectrum.file_path or not os.path.exists(spectrum.file_path):
        raise HTTPException(status_code=404, detail="Spectrum file does not exist on host")
        
    try:
        import nmrglue as ng
        import numpy as np
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        from matplotlib.path import Path
        
        # Handle different formats
        if os.path.isdir(spectrum.file_path):
            # Bruker processed data
            dic, data = ng.bruker.read_pdata(spectrum.file_path)
            
            if data.ndim == 3:
                # Drop planes where max intensity is very small (near 0)
                mask = np.array([np.max(np.abs(data[i])) > 1e-6 for i in range(data.shape[0])])
                if not np.all(mask):
                    data = data[mask]
            
            uc_f2 = BrukerUC.from_dic(dic, 'f2')
            uc_f1 = BrukerUC.from_dic(dic, 'f1')
            
            x0, x1 = uc_f2.ppm_limits()
            y0, y1 = uc_f1.ppm_limits()
            
            xlabel = str(dic.get('procs', {}).get('AXNNAME', 'F2 (ppm)'))
            ylabel = str(dic.get('proc2s', {}).get('AXNNAME', 'F1 (ppm)'))
            
            # Bruker pdata usually (F1, F2). If Pseudo3D, (Planes, F1, F2)
            # data[0] if 3D, else data if 2D
        else:
            # Load the ft2 file
            dic, data = ng.pipe.read(spectrum.file_path)
            
            # Extract the limits
            uc_f2 = ng.pipe.make_uc(dic, data, 1)
            uc_f1 = ng.pipe.make_uc(dic, data, 2)
            x0, x1 = uc_f1.ppm_limits()
            y0, y1 = uc_f2.ppm_limits()
            
            xlabel = str(dic.get('FDF2LABEL', 'F1 (ppm)'))
            ylabel = str(dic.get('FDF1LABEL', 'F2 (ppm)'))

        # We only want to plot the first plane of pseudo-3d
        plane = data[0] if data.ndim >= 3 else data
        
        # Ensure no NaNs or Infs in data
        plane = np.nan_to_num(plane)
        
        # Estimate noise
        estimated_noise = float(plotting.estimate_noise_mad(plane))
        
        # If base_level is 0 or too low, use auto-threshold
        if base_level <= 0:
            base_level = estimated_noise * 6.0

        # Build coordinate arrays
        rows, cols = plane.shape
        x_axis = np.linspace(x0, x1, cols)
        y_axis = np.linspace(y0, y1, rows)
        
        # Delegate contour generation to service
        contours = plotting.generate_contours(
            x_axis, y_axis, plane, base_level, multiplier, number_contours
        )
        
        xlabel = str(dic.get('FDF2LABEL', 'F2 (ppm)'))
        ylabel = str(dic.get('FDF1LABEL', 'F1 (ppm)'))

        return {
            **contours,
            "xlabel": "F1 (ppm)",
            "ylabel": "F2 (ppm)",
            "estimated_noise": estimated_noise,
            "base_level": base_level
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to process spectrum contours: {str(e)}")
@router.delete("/{project_uuid}")
def delete_project(
    delete_files: bool = True,
    project: models.Project = Depends(get_project), 
    db: Session = Depends(database.get_db)
):
    """Delete a project and all its associated spectra."""
    # Clean up project directory if requested
    if delete_files and project.local_directory_path:
        delete_directory_safely(project.local_directory_path)
    
    db.delete(project)
    db.commit()
    return {"detail": "Project deleted successfully"}


@router.post("/import", response_model=schemas.Project)
def import_project(
    request: schemas.ProjectImportRequest,
    current_user: models.User = Depends(security.get_current_user),
    db: Session = Depends(database.get_db)
):
    """
    Import a project from a local directory by reading its JSON files.
    """
    # 1. Load data from JSON
    try:
        project_data = load_project_from_json(request.directory_path)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to load project from JSON: {str(e)}")

    # 2. Check if project already exists in DB for this user
    p_uuid = project_data.get("project_uuid")
    existing_project = None
    
    if p_uuid:
        existing_project = db.query(models.Project).filter(
            models.Project.project_uuid == p_uuid,
            models.Project.user_id == current_user.id
        ).first()
    
    if not existing_project:
        existing_project = db.query(models.Project).filter(
            models.Project.name == project_data["name"],
            models.Project.local_directory_path == request.directory_path,
            models.Project.user_id == current_user.id
        ).first()

    if existing_project:
        # Update existing project metadata
        existing_project.protein_sequence = project_data.get("protein_sequence")
        existing_project.molecular_weight = project_data.get("molecular_weight")
        existing_project.experiments = project_data.get("experiments")
        if p_uuid and not existing_project.project_uuid:
            existing_project.project_uuid = p_uuid
        db_project = existing_project
    else:
        # Create new project
        db_project = models.Project(
            project_uuid=p_uuid or uuid.uuid4().hex,
            name=project_data["name"],
            local_directory_path=request.directory_path,
            protein_sequence=project_data.get("protein_sequence"),
            molecular_weight=project_data.get("molecular_weight"),
            experiments=project_data.get("experiments"),
            user_id=current_user.id
        )
        db.add(db_project)
    
    db.commit()
    db.refresh(db_project)

    # 3. Import spectra
    for s_data in project_data.get("spectra", []):
        s_uuid = s_data.get("spectrum_uuid")
        existing_spectrum = None
        
        if s_uuid:
            existing_spectrum = db.query(models.Spectrum).filter(
                models.Spectrum.project_id == db_project.id,
                models.Spectrum.spectrum_uuid == s_uuid
            ).first()
            
        if not existing_spectrum:
            existing_spectrum = db.query(models.Spectrum).filter(
                models.Spectrum.project_id == db_project.id,
                models.Spectrum.name == s_data["name"]
            ).first()

        if existing_spectrum:
            existing_spectrum.file_path = s_data["file_path"]
            existing_spectrum.experiment_type = s_data["experiment_type"]
            existing_spectrum.peaklist_path = s_data["peaklist_path"]
            existing_spectrum.list_path = s_data["list_path"]
            existing_spectrum.is_fitted = s_data.get("is_fitted", False)
            existing_spectrum.results_json_path = s_data.get("results_json_path")
            existing_spectrum.b0 = s_data.get("b0")
            existing_spectrum.temperature = s_data.get("temperature")
            if s_uuid and not existing_spectrum.spectrum_uuid:
                existing_spectrum.spectrum_uuid = s_uuid
        else:
            db_spectrum = models.Spectrum(
                spectrum_uuid=s_uuid or uuid.uuid4().hex,
                name=s_data["name"],
                file_path=s_data["file_path"],
                experiment_type=s_data["experiment_type"],
                peaklist_path=s_data["peaklist_path"],
                list_path=s_data["list_path"],
                project_id=db_project.id,
                is_fitted=s_data.get("is_fitted", False),
                results_json_path=s_data.get("results_json_path"),
                b0=s_data.get("b0"),
                temperature=s_data.get("temperature")
            )
            db.add(db_spectrum)

    db.commit()
    db.refresh(db_project)
    
    # Sync back to JSON to ensure referencing is correct
    sync_project_to_json(db, db_project)
    
    return db_project
