"""Peak fitting API endpoints."""

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy.orm import Session
import os
import io
import tempfile
import logging
import traceback

from .. import models, schemas, database
from ..services.fitting.service import (
    run_peak_fitting, 
    preview_clusters, 
    fit_single_cluster,
    export_clusters_pdf,
    dispatch_fitting_job
)
from .. services.json_sync import save_fitting_to_json, sync_project_to_json
from .deps import get_spectrum

router = APIRouter(
    prefix="/api/projects/{project_uuid}/spectra/{spectrum_uuid}/fitting",
    tags=["peak-fitting"],
)


# Removed local _get_spectrum in favor of deps.get_spectrum


@router.post("/run", response_model=schemas.JobStatus)
def run_fitting(
    request: schemas.PeakFittingRequest,
    spectrum: models.Spectrum = Depends(get_spectrum),
    db: Session = Depends(database.get_db),
):
    """Execute peak fitting on a spectrum as a background job."""

    # Validate file paths exist
    if not spectrum.file_path or not os.path.exists(spectrum.file_path):
        raise HTTPException(
            status_code=400,
            detail="Spectrum .ft2 file not found on disk.",
        )
    if not spectrum.peaklist_path or not os.path.exists(spectrum.peaklist_path):
        raise HTTPException(
            status_code=400,
            detail="Peaklist file not found on disk.",
        )

    try:
        job = dispatch_fitting_job(
            spectrum_id=spectrum.id,
            project_id=spectrum.project_id,
            request_params=request.model_dump(),
            db=db
        )
        return job
    except Exception as e:
        logging.error(f"Dispatch failed: {str(e)}\n{traceback.format_exc()}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to start background job: {str(e)}",
        )

@router.get("/jobs/{job_id}", response_model=schemas.JobStatus)
def get_job_status(
    job_id: int,
    spectrum: models.Spectrum = Depends(get_spectrum),
    db: Session = Depends(database.get_db),
):
    """Get the status of a specific background job."""
    job = db.query(models.Job).filter(models.Job.id == job_id, models.Job.spectrum_id == spectrum.id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found in this spectrum")
    return job

@router.get("/jobs/{job_id}/logs")
def get_job_logs(
    job_id: int,
    spectrum: models.Spectrum = Depends(get_spectrum),
    db: Session = Depends(database.get_db),
):
    """Retrieve logs for a specific background job."""
    job = db.query(models.Job).filter(models.Job.id == job_id, models.Job.spectrum_id == spectrum.id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found in this spectrum")
    
    if not job.log_path or not os.path.exists(job.log_path):
        return {"logs": "No logs found for this job yet."}
        
    try:
        with open(job.log_path, 'r') as f:
            logs = f.read()
        return {"logs": logs}
    except Exception as e:
        return {"logs": f"Error reading logs: {str(e)}"}


@router.get("/latest-job", response_model=schemas.JobStatus)
def get_latest_job(
    spectrum: models.Spectrum = Depends(get_spectrum),
    db: Session = Depends(database.get_db),
):
    """Retrieve the latest job for this spectrum."""
    job = (
        db.query(models.Job)
        .filter(models.Job.spectrum_id == spectrum.id)
        .order_by(models.Job.id.desc())
        .first()
    )
    if not job:
        raise HTTPException(status_code=404, detail="No jobs found for this spectrum")
    return job


@router.post("/preview-clusters", response_model=schemas.ClusterPreviewResponse)
def cluster_preview(
    request: schemas.ClusterPreviewRequest,
    spectrum: models.Spectrum = Depends(get_spectrum),
    db: Session = Depends(database.get_db),
):
    """Run clustering only (no fitting) for preview."""

    if not spectrum.file_path or not os.path.exists(spectrum.file_path):
        raise HTTPException(
            status_code=400, 
            detail="Spectrum .ft2 file not found on disk. Check the file_path in General Information."
        )
    if not spectrum.peaklist_path or not os.path.exists(spectrum.peaklist_path):
        raise HTTPException(
            status_code=400, 
            detail="Peaklist file not found on disk. Set the peaklist_path in General Information first."
        )

    try:
        result = preview_clusters(
            spectrum_path=spectrum.file_path,
            peaklist_path=spectrum.peaklist_path,
            peaklist_format=request.peaklist_format,
            dims=request.dims,
            x_radius_ppm=request.x_radius_ppm,
            y_radius_ppm=request.y_radius_ppm,
            clustering_method=request.clustering_method,
            struc_el=request.struc_el,
            struc_size=request.struc_size,
            noise=request.noise,
            use_persistent_peaktable=request.use_persistent_peaktable,
        )
        # Attempt to create the response manually to catch Pydantic validation errors inside our try block
        validated_response = schemas.ClusterPreviewResponse(**result)
        return validated_response
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        raise HTTPException(
            status_code=500,
            detail=f"Cluster preview failed: {str(e)}\n\nTraceback:\n{tb}",
        )


@router.post("/recluster", response_model=schemas.ClusterPreviewResponse)
def recluster(
    request: schemas.ReclusterRequest,
    spectrum: models.Spectrum = Depends(get_spectrum),
    db: Session = Depends(database.get_db),
):
    """Recluster peaks using specific frontend-provided peaks (preserves custom individual radii)."""

    if not spectrum.file_path or not os.path.exists(spectrum.file_path):
        raise HTTPException(status_code=400, detail="Spectrum file not found on disk.")
    if not spectrum.peaklist_path or not os.path.exists(spectrum.peaklist_path):
        raise HTTPException(status_code=400, detail="Peaklist file not found on disk.")

    from ..services.fitting.service import recluster_peaks
    try:
        result = recluster_peaks(
            spectrum_path=spectrum.file_path,
            peaklist_path=spectrum.peaklist_path,
            peaks=request.peaks,
            peaklist_format=request.peaklist_format,
            dims=request.dims,
            clustering_method=request.clustering_method,
            struc_el=request.struc_el,
            struc_size=request.struc_size,
            noise=request.noise,
            use_persistent_peaktable=request.use_persistent_peaktable,
        )
        validated_response = schemas.ClusterPreviewResponse(**result)
        return validated_response
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        print(f"ERROR: {str(e)}\n{tb}")
        raise HTTPException(status_code=500, detail=f"Reclustering failed: {str(e)}\n\nTraceback:\n{tb}")


@router.post("/fit-cluster", response_model=schemas.SingleClusterFitResponse)
def fit_cluster(
    request: schemas.SingleClusterFitRequest,
    spectrum: models.Spectrum = Depends(get_spectrum),
    db: Session = Depends(database.get_db),
):
    """Fit a single cluster on the first plane and return 3D surface data."""

    if not spectrum.file_path or not os.path.exists(spectrum.file_path):
        raise HTTPException(status_code=400, detail="Spectrum file not found on disk.")
    if not spectrum.peaklist_path or not os.path.exists(spectrum.peaklist_path):
        raise HTTPException(status_code=400, detail="Peaklist file not found on disk.")

    try:
        result = fit_single_cluster(
            spectrum_path=spectrum.file_path,
            peaklist_path=spectrum.peaklist_path,
            cluster_id=request.cluster_id,
            peaks=request.peaks,
            peaklist_format=request.peaklist_format,
            dims=request.dims,
            x_radius_ppm=request.x_radius_ppm,
            y_radius_ppm=request.y_radius_ppm,
            lineshape=request.lineshape,
            fit_method=request.fit_method,
            clustering_method=request.clustering_method,
            struc_el=request.struc_el,
            struc_size=request.struc_size,
            noise=request.noise,
            to_fix=request.to_fix,
            use_persistent_peaktable=request.use_persistent_peaktable,
        )
        return result
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        raise HTTPException(
            status_code=500,
            detail=f"Cluster fitting failed: {str(e)}\n\nTraceback:\n{tb}",
        )

@router.post("/plot-fitted-cluster", response_model=schemas.SingleClusterFitResponse)
def plot_fitted_cluster(
    request: schemas.PlotFittedClusterRequest,
    spectrum: models.Spectrum = Depends(get_spectrum),
    db: Session = Depends(database.get_db),
):
    """Plot an already-fitted cluster on the first plane using existing parameters."""

    if not spectrum.file_path or not os.path.exists(spectrum.file_path):
        raise HTTPException(status_code=400, detail="Spectrum file not found on disk.")
    if not spectrum.peaklist_path or not os.path.exists(spectrum.peaklist_path):
        raise HTTPException(status_code=400, detail="Peaklist file not found on disk.")

    from ..services.fitting.service import generate_fitted_cluster_surfaces
    try:
        result = generate_fitted_cluster_surfaces(
            spectrum_path=spectrum.file_path,
            peaklist_path=spectrum.peaklist_path,
            cluster_id=request.cluster_id,
            fitted_peaks=request.fitted_peaks,
            plane_idx=request.plane,
            peaklist_format=request.peaklist_format,
            dims=request.dims,
            lineshape=request.lineshape,
            clustering_method=request.clustering_method,
            struc_el=request.struc_el,
            struc_size=request.struc_size,
        )
        return result
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Plotting fitted cluster failed: {str(e)}",
        )


@router.get("/results", response_model=schemas.PeakFittingResponse)
def get_fitting_results(
    spectrum: models.Spectrum = Depends(get_spectrum),
    db: Session = Depends(database.get_db),
):
    """Load previously saved fitting results from JSON."""
    
    if not spectrum.is_fitted or not spectrum.results_json_path:
        raise HTTPException(status_code=404, detail="Fitting results not found for this spectrum")
        
    if not os.path.exists(spectrum.results_json_path):
        raise HTTPException(status_code=404, detail="Fitting results JSON file not found on disk")
        
    try:
        import json
        with open(spectrum.results_json_path, 'r') as f:
            data = json.load(f)
        return data
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load fitting results: {str(e)}")


@router.post("/export-pdf")
def export_pdf_report(
    request: schemas.ExportPDFRequest,
    spectrum: models.Spectrum = Depends(get_spectrum),
    db: Session = Depends(database.get_db),
):
    """Export all fitted clusters as a multi-page PDF report."""

    if not spectrum.file_path or not os.path.exists(spectrum.file_path):
        raise HTTPException(status_code=400, detail="Spectrum file not found on disk.")
    if not spectrum.peaklist_path or not os.path.exists(spectrum.peaklist_path):
        raise HTTPException(status_code=400, detail="Peaklist file not found on disk.")

    try:
        pdf_buffer = export_clusters_pdf(
            spectrum_path=spectrum.file_path,
            peaklist_path=spectrum.peaklist_path,
            results=request.results,
            peaklist_format=request.peaklist_format,
            dims=request.dims,
            lineshape=request.lineshape,
        )
        return StreamingResponse(
            pdf_buffer,
            media_type="application/pdf",
            headers={
                "Content-Disposition": f"attachment; filename=spectrum_{spectrum.spectrum_uuid}_report.pdf"
            }
        )
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        raise HTTPException(
            status_code=500,
            detail=f"PDF Export failed: {str(e)}\n\n{tb}",
        )


@router.post("/restore", response_model=schemas.PeakFittingResponse)
def restore_fitting(
    spectrum: models.Spectrum = Depends(get_spectrum),
    db: Session = Depends(database.get_db),
):
    """Restore the previous fitting result from backup."""
    
    if not spectrum.results_json_path:
        raise HTTPException(status_code=400, detail="No fitting results path defined for this spectrum")
        
    bak_path = spectrum.results_json_path.replace(".json", "_bak.json")
    if not os.path.exists(bak_path):
        raise HTTPException(status_code=404, detail="Backup file not found")
        
    import shutil
    try:
        # Swap current and backup
        if os.path.exists(spectrum.results_json_path):
            temp_path = spectrum.results_json_path.replace(".json", "_tmp.json")
            shutil.move(spectrum.results_json_path, temp_path)
            shutil.move(bak_path, spectrum.results_json_path)
            shutil.move(temp_path, bak_path)
            
            # Swap logs too
            fitting_dir = os.path.dirname(spectrum.results_json_path)
            log_path = os.path.join(fitting_dir, "fitting.log")
            if os.path.exists(log_path):
                bak_log = log_path.replace(".log", "_bak.log")
                if os.path.exists(bak_log):
                    tmp_log = log_path.replace(".log", "_tmp.log")
                    shutil.move(log_path, tmp_log)
                    shutil.move(bak_log, log_path)
                    shutil.move(tmp_log, bak_log)
        else:
            shutil.move(bak_path, spectrum.results_json_path)
            fitting_dir = os.path.dirname(spectrum.results_json_path)
            bak_log = os.path.join(fitting_dir, "fitting_bak.log")
            if os.path.exists(bak_log):
                shutil.move(bak_log, os.path.join(fitting_dir, "fitting.log"))
                
        spectrum.is_fitted = True
        db.commit()
        
        # Load and return the restored results
        import json
        with open(spectrum.results_json_path, 'r') as f:
            data = json.load(f)
        return data
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Restore failed: {str(e)}")
