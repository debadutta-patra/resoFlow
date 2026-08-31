from fastapi import Depends, HTTPException, status
from sqlalchemy.orm import Session
from .. import models, security, database

def get_project(
    project_uuid: str,
    current_user: models.User = Depends(security.get_current_user),
    db: Session = Depends(database.get_db)
) -> models.Project:
    """Dependency to fetch a project and verify ownership/permissions."""
    project = db.query(models.Project).filter(models.Project.project_uuid == project_uuid).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project.user_id != current_user.id and not current_user.is_superuser:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    return project

def get_spectrum(
    project_uuid: str,
    spectrum_uuid: str,
    current_user: models.User = Depends(security.get_current_user),
    db: Session = Depends(database.get_db)
) -> models.Spectrum:
    """Dependency to fetch a spectrum within a project and verify permissions."""
    project = get_project(project_uuid, current_user, db)
    
    spectrum = db.query(models.Spectrum).filter(
        models.Spectrum.spectrum_uuid == spectrum_uuid,
        models.Spectrum.project_id == project.id
    ).first()
    
    if not spectrum:
        raise HTTPException(status_code=404, detail="Spectrum not found in this project")
    return spectrum

def get_analysis(
    project_uuid: str,
    analysis_uuid: str,
    current_user: models.User = Depends(security.get_current_user),
    db: Session = Depends(database.get_db)
) -> models.Analysis:
    """Dependency to fetch an analysis within a project and verify permissions."""
    project = get_project(project_uuid, current_user, db) # Permission & existence check
    
    analysis = db.query(models.Analysis).filter(
        models.Analysis.analysis_uuid == analysis_uuid,
        models.Analysis.project_id == project.id
    ).first()
    
    if not analysis:
        raise HTTPException(status_code=404, detail="Analysis not found in this project")
    return analysis

