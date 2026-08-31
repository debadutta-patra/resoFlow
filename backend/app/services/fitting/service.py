"""High-level peak fitting service.

Orchestrates: read peaklist → cluster → fit → return serializable results.
"""

import os
import logging
import json
import subprocess
import socket
from pathlib import Path
from typing import Optional, List, Any, Dict
from datetime import datetime
import numpy as np
import pandas as pd
import io
from celery import shared_task, group
from ...database import SessionLocal
from ... import models
from ..json_sync import save_peaktable_to_json, sync_project_to_json

logger = logging.getLogger(__name__)

from .io import Peaklist, PeaklistFormat, StrucEl
from .fitting import (
    FitPeaksArgs, FitPeaksInput, Config,
    fit_peak_clusters, FitPeaksResult,
    make_meshgrid, get_lineshape_function,
    make_masks_from_plane_data,
    get_limits_for_axis_in_points,
    deal_with_peaks_on_edge_of_spectrum,
    simulate_lineshapes_from_fitted_peak_parameters,
    simulate_pv_pv_lineshapes_from_fitted_peak_parameters,
    prepare_group_of_peaks_for_fitting,
    fit_cluster_of_peaks,
)
from .lineshapes import (
    Lineshape,
    calculate_lineshape_specific_height_and_fwhm,
    calculate_peak_centers_in_ppm,
    calculate_peak_linewidths_in_hz,
)


def _ensure_derived_columns(df: pd.DataFrame, peaklist: Any) -> pd.DataFrame:
    """Helper to compute derived columns safely across all fitting endpoints."""
    for col in ["X_PPM", "Y_PPM", "X_RADIUS", "Y_RADIUS", "INTENSITY"]:
        if col in df.columns:
            df[col] = df[col].astype(float)
    if "CLUSTID" in df.columns:
        df["CLUSTID"] = df["CLUSTID"].apply(lambda x: int(x) if pd.notnull(x) else np.nan)
    if "ASS" in df.columns:
        df["ASS"] = df["ASS"].astype(str)

    # Calculate necessary derived columns that update_df normally provides
    if "X_PPM" in df.columns:
        df["X_AXIS"] = df["X_PPM"].apply(lambda x: peaklist.uc_f2(x, "ppm"))
        df["X_AXISf"] = df["X_PPM"].apply(lambda x: peaklist.uc_f2.f(x, "ppm"))
    if "Y_PPM" in df.columns:
        df["Y_AXIS"] = df["Y_PPM"].apply(lambda x: peaklist.uc_f1(x, "ppm"))
        df["Y_AXISf"] = df["Y_PPM"].apply(lambda x: peaklist.uc_f1.f(x, "ppm"))
        
    # Default linewidths if missing
    if "XW_HZ" not in df.columns: df["XW_HZ"] = "20.0"
    if "YW_HZ" not in df.columns: df["YW_HZ"] = "20.0"
    df["XW_HZ"] = df["XW_HZ"].replace("None", "20.0").replace(np.nan, "20.0").astype(float)
    df["YW_HZ"] = df["YW_HZ"].replace("None", "20.0").replace(np.nan, "20.0").astype(float)
    df["XW"] = df["XW_HZ"].apply(lambda x: x * peaklist.pt_per_hz_f2)
    df["YW"] = df["YW_HZ"].apply(lambda x: x * peaklist.pt_per_hz_f1)
    
    # Handle missing height/vol
    if "HEIGHT" not in df.columns: df["HEIGHT"] = 0.0
    if "VOL" not in df.columns: df["VOL"] = 0.0
    df["HEIGHT"] = df["HEIGHT"].replace("None", 0.0).replace(np.nan, 0.0).astype(float)
    df["VOL"] = df["VOL"].replace("None", 0.0).replace(np.nan, 0.0).astype(float)

    # Radii in points
    if "X_RADIUS_PPM" not in df.columns: df["X_RADIUS_PPM"] = peaklist.f2_radius
    if "Y_RADIUS_PPM" not in df.columns: df["Y_RADIUS_PPM"] = peaklist.f1_radius
    df["X_RADIUS"] = df["X_RADIUS_PPM"].apply(lambda x: x * peaklist.pt_per_ppm_f2)
    df["Y_RADIUS"] = df["Y_RADIUS_PPM"].apply(lambda x: x * peaklist.pt_per_ppm_f1)
    
    if "include" not in df.columns:
        df["include"] = "yes"
        
    return df


def run_peak_fitting(
    spectrum_path: str,
    peaklist_path: str,
    peaklist_format: str = "pipe",
    dims: Optional[List[int]] = None,
    x_radius_ppm: float = 0.04,
    y_radius_ppm: float = 0.4,
    lineshape: str = "PV",
    fit_method: str = "leastsq",
    clustering_method: str = "auto",
    struc_el: str = "disk",
    struc_size: Optional[List[int]] = None,
    noise: Optional[float] = None,
    max_cluster_size: Optional[int] = None,
    to_fix: Optional[List[str]] = None,
    peaks: Optional[List[dict]] = None,
    use_persistent_peaktable: bool = False,
) -> dict:
    """Run the full peak fitting pipeline.

    Returns
    -------
    dict with keys:
        - results: list of dicts (one per fit row)
        - summary: dict with summary statistics
        - log: warning messages
    """
    if dims is None:
        dims = [0, 1, 2]
    if struc_size is None:
        struc_size = [3]
    if to_fix is None:
        to_fix = ["fraction", "sigma", "center"]

    # Parse enums
    fmt = PeaklistFormat(peaklist_format)
    ls = Lineshape(lineshape)
    se = StrucEl(struc_el)

    # 1. Read peaklist + spectrum
    peaklist = Peaklist(
        path=peaklist_path,
        data_path=spectrum_path,
        fmt=fmt,
        dims=dims,
        radii=[x_radius_ppm, y_radius_ppm],
    )
    
    if use_persistent_peaktable and peaks is None:
        db = SessionLocal()
        try:
            spectrum = db.query(models.Spectrum).filter(models.Spectrum.file_path == spectrum_path).first()
            if spectrum and spectrum.peaktable_json_path and os.path.exists(spectrum.peaktable_json_path):
                with open(spectrum.peaktable_json_path, 'r') as f:
                    p_data = json.load(f)
                    peaks = p_data.get("peaks")
                    logger.info(f"Loaded {len(peaks)} peaks from persistent JSON: {spectrum.peaktable_json_path}")
        except Exception as e:
            logger.error(f"Failed to load persistent peaktable: {e}")
        finally:
            db.close()

    if peaks is not None and len(peaks) > 0:
        peaklist._df = pd.DataFrame(peaks)
        
    peaklist.update_df()
    peaklist._df = _ensure_derived_columns(peaklist.df, peaklist)
    
    if peaks is None or len(peaks) == 0:
        # 2. Cluster peaks
        if clustering_method == "mask":
            peaklist.mask_method()
        else:
            peaklist.clusters(struc_el=se, struc_size=tuple(struc_size))

    # SAVE current peaktable to JSON if not already source-of-truth or if it's a new state
    db = SessionLocal()
    try:
        spectrum = db.query(models.Spectrum).filter(models.Spectrum.file_path == spectrum_path).first()
        if spectrum:
            p_json_path = save_peaktable_to_json(spectrum, spectrum.project.local_directory_path, results_to_serializable(peaklist.df))
            spectrum.peaktable_json_path = p_json_path
            db.commit()
    except Exception as e:
        logger.error(f"Failed to save peaktable to JSON: {e}")
    finally:
        db.close()

    # 3. Auto-detect noise if not provided
    if noise is None:
        noise = float(peaklist.thres)

    # 4. Set up fitting input
    plane_numbers = list(range(peaklist.n_planes))
    uc_dics = {
        "f1": peaklist.uc_f1,
        "f2": peaklist.uc_f2,
    }

    args = FitPeaksArgs(
        noise=noise,
        uc_dics=uc_dics,
        lineshape=ls,
        dims=dims,
        max_cluster_size=max_cluster_size,
        to_fix=to_fix,
    )

    config = Config(fit_method=fit_method)

    fit_input = FitPeaksInput(
        args=args,
        data=peaklist.data,
        config=config,
        plane_numbers=plane_numbers,
    )

    # 5. Run fitting
    # unique lmfit prefixes are handled internally in fitting.py's make_models 
    # using the dataframe index, so we DON'T need to modify the ASS column here.
    result = fit_peak_clusters(peaklist.df, fit_input)
    df = result.df

    # 6. Post-process: compute height, FWHM, convert to ppm/Hz
    df = calculate_lineshape_specific_height_and_fwhm(ls, df)
    df = calculate_peak_centers_in_ppm(df, peaklist)
    df = calculate_peak_linewidths_in_hz(df, peaklist)

    # 7. Build summary
    summary = {
        "total_peaks_fitted": int(df["assignment"].nunique()) if "assignment" in df.columns else 0,
        "total_clusters": int(df["clustid"].nunique()) if "clustid" in df.columns else 0,
        "total_planes": int(df["plane"].nunique()) if "plane" in df.columns else 0,
        "avg_chisqr": float(df["chisqr"].mean()) if "chisqr" in df.columns else 0.0,
        "avg_redchi": float(df["redchi"].mean()) if "redchi" in df.columns else 0.0,
        "redchi_plane0": float(df[df["plane"] == 0]["redchi"].mean()) if "redchi" in df.columns and 0 in df["plane"].values else 0.0,
        "lineshape_used": lineshape,
        "fit_method_used": fit_method,
    }

    return {
        "results": results_to_serializable(df),
        "summary": summary,
        "log": result.log,
    }

@shared_task(bind=True)
def fit_cluster_task(self, cluster_data: dict, fit_input_dict: dict, job_id: int):
    """Celery task to fit a single cluster."""
    import logging
    import os
    
    # 1. Setup logging for this task
    db = SessionLocal()
    job = db.query(models.Job).filter(models.Job.id == job_id).first()
    log_file = job.log_path if job else None
    
    logger = logging.getLogger(f"job_{job_id}")
    if log_file:
        file_handler = logging.FileHandler(log_file)
        file_handler.setFormatter(logging.Formatter('%(asctime)s - %(levelname)s - %(message)s'))
        logger.addHandler(file_handler)
    
    cluster_id = cluster_data.get('CLUSTID')
    peak_count = len(cluster_data.get('peaks', []))
    logger.info(f"--- Cluster {cluster_id} ---")
    logger.info(f"Starting fitting with {peak_count} peaks...")
    
    try:
        from .fitting import (
            FitPeaksArgs, FitPeaksInput, Config,
            prepare_group_of_peaks_for_fitting,
            fit_cluster_of_peaks,
            rename_columns_for_compatibility
        )
        from .lineshapes import (
            calculate_lineshape_specific_height_and_fwhm,
            calculate_peak_centers_in_ppm,
            calculate_peak_linewidths_in_hz,
            Lineshape
        )
        from .io import Peaklist, PeaklistFormat

        # Reconstruct objects
        args_dict = fit_input_dict["args"]
        ls = Lineshape(args_dict["lineshape"])
        
        # We need a Peaklist object to get unit converters
        peaklist = Peaklist(
            path=fit_input_dict["peaklist_path"],
            data_path=fit_input_dict["spectrum_path"],
            fmt=PeaklistFormat(fit_input_dict["peaklist_format"]),
            dims=args_dict["dims"],
        )
        # peaklist.update_df()  # Optimized: Avoid full re-validation of original file in worker

        args = FitPeaksArgs(
            noise=args_dict["noise"],
            uc_dics={"f1": peaklist.uc_f1, "f2": peaklist.uc_f2},
            lineshape=ls,
            dims=args_dict["dims"],
            to_fix=args_dict["to_fix"],
            verbose=False,
        )
        config = Config(fit_method=fit_input_dict["config"]["fit_method"])
        
        # Load spectrum data for this cluster
        fit_input = FitPeaksInput(
            args=args,
            data=peaklist.data,
            config=config,
            plane_numbers=fit_input_dict["plane_numbers"],
        )
        
        group_df = pd.DataFrame(cluster_data["peaks"])
        cluster_id = cluster_data["CLUSTID"]
        
        # unique prefixes are handled in make_models
        data_for_fitting = prepare_group_of_peaks_for_fitting(cluster_id, group_df, fit_input)
        cluster_df = fit_cluster_of_peaks(data_for_fitting)
        
        cluster_df["lineshape"] = ls.value
        cluster_df["fit_method"] = config.fit_method
        cluster_df = rename_columns_for_compatibility(cluster_df)
        cluster_df = calculate_lineshape_specific_height_and_fwhm(ls, cluster_df)
        cluster_df = calculate_peak_centers_in_ppm(cluster_df, peaklist)
        cluster_df = calculate_peak_linewidths_in_hz(cluster_df, peaklist)
        
        # Update X_PPM and Y_PPM with fitted values
        if "center_x_ppm" in cluster_df.columns and "center_y_ppm" in cluster_df.columns:
            cluster_df["X_PPM"] = cluster_df["center_x_ppm"]
            cluster_df["Y_PPM"] = cluster_df["center_y_ppm"]
        
        # Update progress in DB
        if job:
            from sqlalchemy import update
            db.execute(
                update(models.Job)
                .where(models.Job.id == job_id)
                .values(completed_clusters=models.Job.completed_clusters + 1)
            )
            db.commit()
            
        # Log result summary
        avg_redchi = float(cluster_df["redchi"].mean()) if "redchi" in cluster_df.columns else 0.0
        logger.info(f"Completed cluster {cluster_id}. Avg RedChi: {avg_redchi:.4f}")
        return results_to_serializable(cluster_df)
        
    except Exception as e:
        logger.error(f"Error fitting cluster {cluster_data.get('CLUSTID')}: {str(e)}")
        if job:
            job.status = "FAILED"
            db.commit()
        raise e
    finally:
        db.close()

@shared_task
def compile_results_task(results_list, job_id: int):
    """Callback task to compile all cluster results and save to JSON."""
    db = SessionLocal()
    try:
        job = db.query(models.Job).filter(models.Job.id == job_id).first()
        if not job:
            return
            
        logger = logging.getLogger(f"job_{job_id}")
        logger.info("==========================================")
        logger.info("FITTING COMPLETE. Compiling final results...")
        
        # Flatten results_list (it's a list of lists of dicts)
        all_results = [item for sublist in results_list for item in sublist]
        df = pd.DataFrame(all_results)
        
        summary = {
            "total_peaks_fitted": int(df["assignment"].nunique()) if "assignment" in df.columns else 0,
            "total_clusters": int(df["clustid"].nunique()) if "clustid" in df.columns else 0,
            "total_planes": int(df["plane"].nunique()) if "plane" in df.columns else 0,
            "avg_chisqr": float(df["chisqr"].mean()) if "chisqr" in df.columns else 0.0,
            "avg_redchi": float(df["redchi"].mean()) if "redchi" in df.columns else 0.0,
            "lineshape_used": df["lineshape"].iloc[0] if not df.empty and "lineshape" in df.columns else "unknown",
            "fit_method_used": df["fit_method"].iloc[0] if not df.empty and "fit_method" in df.columns else "unknown",
        }
        
        # Save to JSON
        from ..json_sync import save_fitting_to_json
        spectrum = job.spectrum
        # Re-use the run directory from dispatch_fitting_job
        if job.log_path and os.path.exists(job.log_path):
            fitting_dir = os.path.dirname(job.log_path)
            json_filename = f"peak_fitting_{spectrum.spectrum_uuid}.json"
            json_path = os.path.join(fitting_dir, json_filename)
            
            # Backup existing results before overwrite
            if os.path.exists(json_path):
                import shutil
                bak_path = json_path.replace(".json", "_bak.json")
                try:
                    shutil.move(json_path, bak_path)
                    # Also backup log
                    if os.path.exists(job.log_path):
                        shutil.copy(job.log_path, job.log_path.replace(".log", "_bak.log"))
                except Exception as e:
                    logger.warning(f"Could not create backup: {e}")

        json_path = save_fitting_to_json(
            spectrum=spectrum,
            project_path=spectrum.project.local_directory_path,
            results=all_results,
            summary=summary,
            fitting_dir=fitting_dir
        )
        
        # Update spectrum and job
        spectrum.is_fitted = True
        spectrum.results_json_path = json_path
        if job:
            job.status = "COMPLETED"
            job.completed_clusters = job.total_clusters # Force 100%
            job.completed_at = datetime.utcnow()
            db.commit()
            # Refresh to ensure we have the absolute latest state
            db.refresh(job)

        # Filter to plane 0 for the persistent peaktable
        persistent_results = all_results
        if "plane" in df.columns:
            persistent_results = results_to_serializable(df[df["plane"] == 0])

        # Also update the persistent peaktable JSON with fitted results
        try:
            p_json_path = save_peaktable_to_json(spectrum, spectrum.project.local_directory_path, persistent_results)
            spectrum.peaktable_json_path = p_json_path
            db.commit()
            sync_project_to_json(db, spectrum.project)
            logger.info(f"Updated persistent peaktable at {p_json_path}")
        except Exception as e:
            logger.error(f"Failed to update persistent peaktable: {e}")

        logger.info(f"Final results saved to {json_path}")
        return {"status": "success", "json_path": json_path}
        
    except Exception as e:
        if job:
            job.status = "FAILED"
            db.commit()
        raise e
    finally:
        db.close()

def dispatch_fitting_job(
    spectrum_id: int,
    project_id: int,
    request_params: dict,
    db: SessionLocal
) -> models.Job:
    """Initialize a Job and dispatch cluster fitting tasks to Celery."""
    spectrum = db.query(models.Spectrum).filter(models.Spectrum.id == spectrum_id).first()
    
    # 1. Perform clustering (sync) to see how many jobs we need
    peaklist_format = request_params.get("peaklist_format", "pipe")
    dims = request_params.get("dims", [0, 1, 2])
    x_radius_ppm = request_params.get("x_radius_ppm", 0.04)
    y_radius_ppm = request_params.get("y_radius_ppm", 0.4)
    clustering_method = request_params.get("clustering_method", "auto")
    struc_el = request_params.get("struc_el", "disk")
    struc_size = request_params.get("struc_size", [3])
    noise = request_params.get("noise")
    
    from .io import Peaklist, PeaklistFormat, StrucEl
    fmt = PeaklistFormat(peaklist_format)
    se = StrucEl(struc_el)
    
    peaklist = Peaklist(
        path=spectrum.peaklist_path,
        data_path=spectrum.file_path,
        fmt=fmt,
        dims=dims,
        radii=[x_radius_ppm, y_radius_ppm],
    )
    
    if request_params.get("peaks"):
        peaklist._df = pd.DataFrame(request_params["peaks"])
    elif request_params.get("use_persistent_peaktable"):
        if spectrum.peaktable_json_path and os.path.exists(spectrum.peaktable_json_path):
            with open(spectrum.peaktable_json_path, 'r') as f:
                p_data = json.load(f)
                peaks = p_data.get("peaks")
                if peaks:
                    peaklist._df = pd.DataFrame(peaks)
                    logger.info(f"Loaded {len(peaks)} peaks from persistent JSON for fitting dispatch")
    
    peaklist.update_df()
    peaklist._df = _ensure_derived_columns(peaklist.df, peaklist)
        
    # Ensure CLUSTID is present. If missing or all null, run clustering.
    if "CLUSTID" not in peaklist.df.columns or peaklist.df["CLUSTID"].isnull().all():
        if clustering_method == "mask":
            peaklist.mask_method()
        else:
            peaklist.clusters(struc_el=se, struc_size=tuple(struc_size))
            
    clusters = peaklist.df.groupby("CLUSTID")
    total_clusters = len(clusters)
    
    # 2. Create Job record in a stable directory
    s_uuid = spectrum.spectrum_uuid or f"legacy_{spectrum.id}"
    run_dir = os.path.join(spectrum.project.local_directory_path, "peak_fitting", f"spectrum_{s_uuid}")
    os.makedirs(run_dir, exist_ok=True)
    log_path = os.path.join(run_dir, "fitting.log")
    
    job = models.Job(
        project_id=project_id,
        spectrum_id=spectrum_id,
        status="RUNNING",
        total_clusters=total_clusters,
        completed_clusters=0,
        processors=request_params.get("processors", 1),
        log_path=log_path,
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    
    # 3. Prepare task inputs
    p_path = spectrum.peaklist_path
    p_fmt = peaklist_format
    if request_params.get("use_persistent_peaktable") and spectrum.peaktable_json_path:
        p_path = spectrum.peaktable_json_path
        p_fmt = "peakipy"

    fit_input_dict = {
        "spectrum_path": spectrum.file_path,
        "peaklist_path": p_path,
        "peaklist_format": p_fmt,
        "plane_numbers": list(range(peaklist.n_planes)),
        "config": {"fit_method": request_params.get("fit_method", "leastsq")},
        "args": {
            "noise": noise if noise is not None else float(peaklist.thres),
            "lineshape": request_params.get("lineshape", "PV"),
            "dims": dims,
            "to_fix": request_params.get("to_fix", ["fraction", "sigma", "center"]),
        }
    }
    
    queue_name = "peakfit"
    tasks = []
    for cluster_id, group_df in clusters:
        cluster_data = {
            "CLUSTID": int(cluster_id),
            "peaks": results_to_serializable(group_df)
        }
        tasks.append(fit_cluster_task.s(cluster_data, fit_input_dict, job.id).set(queue=queue_name))

    # 4. Dispatch using group | task (chord) to peakfit queue
    from celery import group
    from ...celery_app import celery_app
    
    workflow = (group(tasks, app=celery_app) | compile_results_task.s(job.id).set(queue=queue_name))
    
    result = workflow.apply_async()
    job.celery_task_id = result.id
    db.commit()
    
    return job


def preview_clusters(
    spectrum_path: str,
    peaklist_path: str,
    peaklist_format: str = "pipe",
    dims: Optional[List[int]] = None,
    x_radius_ppm: float = 0.04,
    y_radius_ppm: float = 0.4,
    clustering_method: str = "auto",
    struc_el: str = "disk",
    struc_size: Optional[List[int]] = None,
    noise: Optional[float] = None,
    use_persistent_peaktable: bool = False,
) -> dict:
    """Read peaklist and run clustering only (no fitting)."""
    if dims is None:
        dims = [0, 1, 2]
    if struc_size is None:
        struc_size = [3]

    fmt = PeaklistFormat(peaklist_format)
    se = StrucEl(struc_el)

    peaklist = Peaklist(
        path=peaklist_path,
        data_path=spectrum_path,
        fmt=fmt,
        dims=dims,
        radii=[x_radius_ppm, y_radius_ppm],
    )
    
    if use_persistent_peaktable:
        db = SessionLocal()
        try:
            spectrum = db.query(models.Spectrum).filter(models.Spectrum.file_path == spectrum_path).first()
            if spectrum and spectrum.peaktable_json_path and os.path.exists(spectrum.peaktable_json_path):
                with open(spectrum.peaktable_json_path, 'r') as f:
                    p_data = json.load(f)
                    peaklist._df = pd.DataFrame(p_data.get("peaks"))
                    logger.info(f"Loaded {len(peaklist.df)} peaks from persistent JSON for preview")
        except Exception as e:
            logger.error(f"Failed to load persistent peaktable for preview: {e}")
        finally:
            db.close()

    peaklist.update_df()
    peaklist._df = _ensure_derived_columns(peaklist.df, peaklist)

    if clustering_method == "mask":
        cluster_result = peaklist.mask_method()
    else:
        thres = noise if noise is not None else float(peaklist.thres)
        cluster_result = peaklist.clusters(thres=thres, struc_el=se, struc_size=tuple(struc_size))

    # SAVE current peaktable to JSON
    db = SessionLocal()
    try:
        spectrum = db.query(models.Spectrum).filter(models.Spectrum.file_path == spectrum_path).first()
        if spectrum:
            p_json_path = save_peaktable_to_json(spectrum, spectrum.project.local_directory_path, results_to_serializable(peaklist.df))
            spectrum.peaktable_json_path = p_json_path
            db.commit()
            sync_project_to_json(db, spectrum.project)
    except Exception as e:
        logger.error(f"Failed to save peaktable to JSON during preview: {e}")
    finally:
        db.close()

    # Return all columns to ensure subsequent fitting jobs have necessary derived data
    return {
        "peaks": results_to_serializable(peaklist.df),
        "total_peaks": len(peaklist.df),
        "total_clusters": peaklist.df["CLUSTID"].nunique() if not peaklist.df.empty else 0,
    }


def recluster_peaks(
    spectrum_path: str,
    peaklist_path: str,
    peaks: list,
    peaklist_format: str = "pipe",
    dims: Optional[List[int]] = None,
    clustering_method: str = "auto",
    struc_el: str = "disk",
    struc_size: Optional[List[int]] = None,
    noise: Optional[float] = None,
    use_persistent_peaktable: bool = False,
) -> dict:
    """Recluster peaks using specific frontend-provided peaks (preserves custom individual radii)."""
    if dims is None:
        dims = [0, 1, 2]
    if struc_size is None:
        struc_size = [3]

    fmt = PeaklistFormat(peaklist_format)
    se = StrucEl(struc_el)

    # Initialize a Peaklist object to get the Data object and unit converters
    # We pass dummy radii; the real radii are in the DataFrame
    peaklist = Peaklist(
        path=peaklist_path,
        data_path=spectrum_path,
        fmt=fmt,
        dims=dims,
        radii=[0.1, 0.1], 
    )
    
    if use_persistent_peaktable and peaks is None:
        db = SessionLocal()
        try:
            spectrum = db.query(models.Spectrum).filter(models.Spectrum.file_path == spectrum_path).first()
            if spectrum and spectrum.peaktable_json_path and os.path.exists(spectrum.peaktable_json_path):
                with open(spectrum.peaktable_json_path, 'r') as f:
                    p_data = json.load(f)
                    peaks = p_data.get("peaks")
                    logger.info(f"Loaded {len(peaks)} peaks from persistent JSON for reclustering")
        except Exception as e:
            logger.error(f"Failed to load persistent peaktable for reclustering: {e}")
        finally:
            db.close()

    # Overwrite the default DataFrame with the caller's peaks
    peaklist._df = pd.DataFrame(peaks)
    peaklist.update_df()
    peaklist._df = _ensure_derived_columns(peaklist.df, peaklist)

    # Perform clustering
    if len(peaklist.df) > 0:
        if clustering_method == "mask":
            peaklist.mask_method()
        else:
            thres = noise if noise is not None else float(peaklist.thres)
            peaklist.clusters(thres=thres, struc_el=se, struc_size=tuple(struc_size))

    # SAVE current peaktable to JSON
    db = SessionLocal()
    try:
        spectrum = db.query(models.Spectrum).filter(models.Spectrum.file_path == spectrum_path).first()
        if spectrum:
            p_json_path = save_peaktable_to_json(spectrum, spectrum.project.local_directory_path, results_to_serializable(peaklist.df))
            spectrum.peaktable_json_path = p_json_path
            db.commit()
            sync_project_to_json(db, spectrum.project)
    except Exception as e:
        logger.error(f"Failed to save peaktable to JSON during reclustering: {e}")
    finally:
        db.close()

    return {
        "peaks": results_to_serializable(peaklist.df),
        "total_peaks": int(len(peaklist.df)),
        "total_clusters": int(peaklist.df["CLUSTID"].nunique()) if not peaklist.df.empty else 0,
    }


def results_to_serializable(df: pd.DataFrame) -> list:
    """Convert DataFrame to list of JSON-safe dicts."""
    records = df.to_dict(orient="records")
    clean = []
    for row in records:
        cleaned_row = {}
        for k, v in row.items():
            if isinstance(v, float) and (np.isnan(v) or np.isinf(v)):
                cleaned_row[k] = None
            elif isinstance(v, np.integer):
                cleaned_row[k] = int(v)
            elif isinstance(v, np.floating):
                cleaned_row[k] = float(v)
            elif isinstance(v, (list, tuple)):
                cleaned_row[k] = list(v)
            elif hasattr(v, "tolist"):
                cleaned_row[k] = v.tolist()
            else:
                cleaned_row[k] = v
        clean.append(cleaned_row)
    return clean


def _generate_plotting_data(
    peaklist: Peaklist,
    cluster_df: pd.DataFrame,
    cluster_id: int,
    lineshape: str,
    plane_idx: int = 0,
) -> dict:
    """Generate 2D contour data for plotting using peakipy logic.
    
    Mirrors logic from .plotting.PlottingDataForPlane and peakipy check.
    """
    if cluster_df.empty:
        return {
            "x_ppm": [], "y_ppm": [], "model_x_ppm": [], "model_y_ppm": [],
            "experimental": [], "model": [], "residuals": [],
            "fit_params": [], "fit_stats": {}, "cluster_id": cluster_id,
            "peaks_in_cluster": 0, "peak_annotations": []
        }

    # Ensure amp column exists (alias for amplitude)
    if "amp" not in cluster_df.columns and "amplitude" in cluster_df.columns:
        cluster_df["amp"] = cluster_df["amplitude"]

    # Ensure lineshape column exists
    if "lineshape" not in cluster_df.columns:
        cluster_df["lineshape"] = lineshape

    # Ensure assignment column exists for mask generation
    if "assignment" not in cluster_df.columns:
        cluster_df["assignment"] = [f"peak_{i}" for i in range(len(cluster_df))]

    # 1. Get data
    # Ensure plane_idx is within bounds
    plane_idx = max(0, min(plane_idx, peaklist.n_planes - 1))
    plane_data = peaklist.data[plane_idx]
    
    # 2. Calculate bounds based on cluster extent and radii
    # Ensure radii are present
    if "x_radius" not in cluster_df.columns:
        if "X_RADIUS" in cluster_df.columns:
            cluster_df["x_radius"] = cluster_df["X_RADIUS"]
        else:
            cluster_df["x_radius"] = peaklist.f2_radius
            
    if "y_radius" not in cluster_df.columns:
        if "Y_RADIUS" in cluster_df.columns:
            cluster_df["y_radius"] = cluster_df["Y_RADIUS"]
        else:
            cluster_df["y_radius"] = peaklist.f1_radius
        
    x_radius = cluster_df.x_radius.max()
    y_radius = cluster_df.y_radius.max()
    
    max_x, min_x = get_limits_for_axis_in_points(
        group_axis_points=cluster_df.center_x, mask_radius_in_points=x_radius
    )
    max_y, min_y = get_limits_for_axis_in_points(
        group_axis_points=cluster_df.center_y, mask_radius_in_points=y_radius
    )
    max_x, min_x, max_y, min_y = deal_with_peaks_on_edge_of_spectrum(
        plane_data.shape, max_x, min_x, max_y, min_y
    )
    
    # 3. Create local Subgrid (Optimization)
    # Previously we simulated on full grid (e.g. 1024x1024), now only on relevant box.
    x_pts = np.arange(min_x, max_x)
    y_pts = np.arange(min_y, max_y)
    X, Y = np.meshgrid(x_pts, y_pts)
    XY = np.array([X, Y])
    
    subgrid_shape = X.shape  # (rows, cols) where rows = height, cols = width
    
    # 4. Generate Masks on subgrid
    mask = np.zeros(subgrid_shape, dtype=bool)
    for _, peak in cluster_df.iterrows():
        # make_mask logic but localized
        a, b = peak.center_y, peak.center_x
        rx = peak.x_radius if peak.x_radius > 0 else 1.0
        ry = peak.y_radius if peak.y_radius > 0 else 1.0
        # ogrid values must be relative to subgrid indices
        # but we can just use the X, Y meshgrid values which are absolute
        peak_mask = (X - b)**2.0 / rx**2.0 + (Y - a)**2.0 / ry**2.0 <= 1.0
        mask |= peak_mask
    
    # 5. Simulation on subgrid
    sim_data = np.zeros(subgrid_shape)
    sim_data_singles = []
    
    # We can't use simulate_lineshapes_from_fitted_peak_parameters directly easily if we want to avoid extra overhead,
    # but let's see if we can adapt the subgrid XY.
    # The original functions use XY[0] and XY[1] as coordinates. 
    # Shape of subgrid XY is (2, height, width).
    
    if lineshape == "PV_PV":
        from .fitting import pv_pv
        for _, p in cluster_df.iterrows():
             sd_i = pv_pv(XY, p.amp, p.center_x, p.center_y, p.sigma_x, p.sigma_y, p.fraction_x, p.fraction_y).reshape(subgrid_shape)
             sim_data += sd_i
    else:
        from .fitting import pvoigt2d, pv_l, pv_g, gaussian_lorentzian, voigt2d, pv_pv
        for _, p in cluster_df.iterrows():
            ls = p.lineshape
            if ls in ["G", "L", "PV"]:
                sd_i = pvoigt2d(XY, p.amp, p.center_x, p.center_y, p.sigma_x, p.sigma_y, p.fraction).reshape(subgrid_shape)
            elif ls == "PV_PV":
                sd_i = pv_pv(XY, p.amp, p.center_x, p.center_y, p.sigma_x, p.sigma_y, p.fraction_x, p.fraction_y).reshape(subgrid_shape)
            elif ls == "PV_L":
                sd_i = pv_l(XY, p.amp, p.center_x, p.center_y, p.sigma_x, p.sigma_y, p.fraction).reshape(subgrid_shape)
            elif ls == "PV_G":
                sd_i = pv_g(XY, p.amp, p.center_x, p.center_y, p.sigma_x, p.sigma_y, p.fraction).reshape(subgrid_shape)
            elif ls == "G_L":
                sd_i = gaussian_lorentzian(XY, p.amp, p.center_x, p.center_y, p.sigma_x, p.sigma_y, p.fraction).reshape(subgrid_shape)
            elif ls == "V":
                sd_i = voigt2d(XY, p.amp, p.center_x, p.center_y, p.sigma_x, p.sigma_y, p.fraction).reshape(subgrid_shape)
            else:
                sd_i = np.zeros(subgrid_shape)
            sim_data += sd_i

    # 6. Apply Masking and Slicing
    # Sliced experimental data
    sliced_exp = plane_data[min_y:max_y, min_x:max_x].copy()
    sliced_exp[~mask] = np.nan
    
    sliced_sim = sim_data.copy()
    sliced_sim[~mask] = np.nan
    
    sliced_residual = sliced_exp - sliced_sim
    
    logger.info(f"Generated plotting data for cluster {cluster_id}: subgrid={subgrid_shape}, masked_pts={np.sum(mask)}")
    
    # 6. Prepare axes
    x_pts = np.arange(min_x, max_x)
    y_pts = np.arange(min_y, max_y)
    x_ppm = [float(peaklist.uc_f2.ppm(p)) for p in x_pts]
    y_ppm = [float(peaklist.uc_f1.ppm(p)) for p in y_pts]
    
    # Get actual labels from peaklist
    xlabel = f"{peaklist.f2_label} (ppm)"
    ylabel = f"{peaklist.f1_label} (ppm)"
    
    # Debug log for simulation scale
    sim_max = np.nanmax(sliced_sim) if np.any(~np.isnan(sliced_sim)) else 0
    exp_max = np.nanmax(sliced_exp) if np.any(~np.isnan(sliced_exp)) else 0
    logger.info(f"Cluster {cluster_id} - Exp Max: {exp_max:.2e}, Sim Max: {sim_max:.2e}")
    
    # 7. Helper for JSON serialization
    def clean_grid(grid):
        if not hasattr(grid, "tolist"):
            return grid
        # Faster way to replace nan/inf with None for JSON
        cleaned = np.where(np.isnan(grid) | np.isinf(grid), None, grid)
        return cleaned.tolist()

    # 8. Annotations
    peak_annotations = []
    for _, row in cluster_df.iterrows():
        # Robustly determine position
        x_val = row.get("center_x_ppm")
        if x_val is None: x_val = row.get("x_ppm")
        if x_val is None: x_val = row.get("X_PPM")
        
        y_val = row.get("center_y_ppm")
        if y_val is None: y_val = row.get("y_ppm")
        if y_val is None: y_val = row.get("Y_PPM")

        peak_annotations.append({
            "label": str(row.get("assignment", row.get("ASS", ""))),
            "res_num": str(row.get("res_num", row.get("RES_NUM", ""))),
            "res_name": str(row.get("res_name", row.get("RES_NAME", ""))),
            "x_ppm": float(x_val) if x_val is not None else 0.0,
            "y_ppm": float(y_val) if y_val is not None else 0.0,
            "z_intensity": float(row.get("height", 0.0)) if row.get("height") is not None else 0.0,
            "volume": float(row.get("amp", row.get("amplitude", 0.0))) if row.get("amp") is not None or row.get("amplitude") is not None else 0.0,
            "height": float(row.get("height", 0.0)) if row.get("height") is not None else 0.0,
        })

    return {
        "x_ppm": x_ppm,
        "y_ppm": y_ppm,
        "model_x_ppm": x_ppm,
        "model_y_ppm": y_ppm,
        "experimental": clean_grid(sliced_exp),
        "model": clean_grid(sliced_sim),
        "residuals": clean_grid(sliced_residual),
        "fit_params": results_to_serializable(cluster_df),
        "cluster_id": cluster_id,
        "peaks_in_cluster": len(cluster_df),
        "peak_annotations": peak_annotations,
        "plane_idx": plane_idx,
        "xlabel": xlabel,
        "ylabel": ylabel,
    }

def fit_single_cluster(
    spectrum_path: str,
    peaklist_path: str,
    cluster_id: int,
    peaks: Optional[list] = None,
    peaklist_format: str = "pipe",
    dims: Optional[List[int]] = None,
    x_radius_ppm: float = 0.04,
    y_radius_ppm: float = 0.4,
    lineshape: str = "PV",
    fit_method: str = "leastsq",
    clustering_method: str = "auto",
    struc_el: str = "disk",
    struc_size: Optional[List[int]] = None,
    noise: Optional[float] = None,
    to_fix: Optional[List[str]] = None,
    use_persistent_peaktable: bool = False,
) -> dict:
    """Fit a single cluster on the first plane and return data for 3D plotting.

    Returns dict with x_ppm, y_ppm, experimental, model, residuals (2D grids),
    fit_params, fit_stats, cluster_id, peaks_in_cluster.
    """
    if dims is None:
        dims = [0, 1, 2]
    if struc_size is None:
        struc_size = [3]
    if to_fix is None:
        to_fix = ["fraction", "sigma", "center"]

    fmt = PeaklistFormat(peaklist_format)
    ls = Lineshape(lineshape)
    se = StrucEl(struc_el)

    # 1. Read peaklist + spectrum
    peaklist = Peaklist(
        path=peaklist_path,
        data_path=spectrum_path,
        fmt=fmt,
        dims=dims,
        radii=[x_radius_ppm, y_radius_ppm],
    )
    
    if use_persistent_peaktable and peaks is None:
        db = SessionLocal()
        try:
            spectrum = db.query(models.Spectrum).filter(models.Spectrum.file_path == spectrum_path).first()
            if spectrum and spectrum.peaktable_json_path and os.path.exists(spectrum.peaktable_json_path):
                with open(spectrum.peaktable_json_path, 'r') as f:
                    p_data = json.load(f)
                    peaks = p_data.get("peaks")
                    logger.info(f"Loaded {len(peaks)} peaks from persistent JSON for single cluster fit")
        except Exception as e:
            logger.error(f"Failed to load persistent peaktable for single cluster fit: {e}")
        finally:
            db.close()

    if peaks is not None and len(peaks) > 0:
        peaklist._df = pd.DataFrame(peaks)
        
    peaklist.update_df()
    peaklist._df = _ensure_derived_columns(peaklist.df, peaklist)
    
    if peaks is None or len(peaks) == 0:
        # 2. Cluster peaks
        if clustering_method == "mask":
            peaklist.mask_method()
        else:
            thres = noise if noise is not None else float(peaklist.thres)
            peaklist.clusters(thres=thres, struc_el=se, struc_size=tuple(struc_size))

    # SAVE current peaktable to JSON if clustering was performed
    if peaks is None or len(peaks) == 0:
        db = SessionLocal()
        try:
            spectrum = db.query(models.Spectrum).filter(models.Spectrum.file_path == spectrum_path).first()
            if spectrum:
                p_json_path = save_peaktable_to_json(spectrum, spectrum.project.local_directory_path, results_to_serializable(peaklist.df))
                spectrum.peaktable_json_path = p_json_path
                db.commit()
                sync_project_to_json(db, spectrum.project)
        except Exception as e:
            logger.error(f"Failed to save peaktable to JSON during single fit: {e}")
        finally:
            db.close()

    # 3. Filter to the requested cluster
    group = peaklist.df[peaklist.df["CLUSTID"] == cluster_id].copy()
    if len(group) == 0:
        raise ValueError(f"Cluster ID {cluster_id} not found in peaks.")

    # Assignments are now handled with unique prefixes internally in fitting.py

    n_peaks = len(group)

    # 4. Auto-detect noise if not provided
    if noise is None:
        noise = float(peaklist.thres)

    # 5. Prepare fitting input
    args = FitPeaksArgs(
        noise=noise,
        uc_dics={"f1": peaklist.uc_f1, "f2": peaklist.uc_f2},
        lineshape=ls,
        dims=dims,
        to_fix=to_fix,
        verbose=False,
    )
    config = Config(fit_method=fit_method)
    # Only fit plane 0
    fit_input = FitPeaksInput(
        args=args,
        data=peaklist.data[0:1],
        config=config,
        plane_numbers=[0],
    )

    # 6. Run fit using standard peakipy logic
    data_for_fitting = prepare_group_of_peaks_for_fitting(cluster_id, group, fit_input)
    cluster_df = fit_cluster_of_peaks(data_for_fitting)
    
    # 7. Post-process: compute height, FWHM, convert to ppm/Hz
    # (These are normally done in fit_peak_clusters for batch fitting)
    from .fitting import rename_columns_for_compatibility
    from .lineshapes import (
        calculate_lineshape_specific_height_and_fwhm,
        calculate_peak_centers_in_ppm,
        calculate_peak_linewidths_in_hz
    )
    
    cluster_df["lineshape"] = ls.value
    cluster_df = rename_columns_for_compatibility(cluster_df)
    cluster_df = calculate_lineshape_specific_height_and_fwhm(ls, cluster_df)
    cluster_df = calculate_peak_centers_in_ppm(cluster_df, peaklist)
    cluster_df = calculate_peak_linewidths_in_hz(cluster_df, peaklist)
    
    # Update X_PPM and Y_PPM with fitted values
    if "center_x_ppm" in cluster_df.columns and "center_y_ppm" in cluster_df.columns:
        cluster_df["X_PPM"] = cluster_df["center_x_ppm"]
        cluster_df["Y_PPM"] = cluster_df["center_y_ppm"]
        
        # Update the in-memory peaklist dataframe with fitted positions (Plane 0 only)
        if "plane" in cluster_df.columns:
            p0_results = cluster_df[cluster_df["plane"] == 0]
            for _, row in p0_results.iterrows():
                # assignments are unique in this context
                mask = peaklist.df["ASS"] == row["assignment"]
                if mask.any():
                    peaklist.df.loc[mask, "X_PPM"] = row["center_x_ppm"]
                    peaklist.df.loc[mask, "Y_PPM"] = row["center_y_ppm"]

        # 7.5 Save the updated peaktable to JSON sidecar
        db = SessionLocal()
        try:
            spectrum = db.query(models.Spectrum).filter(models.Spectrum.file_path == spectrum_path).first()
            if spectrum:
                p_json_path = save_peaktable_to_json(spectrum, spectrum.project.local_directory_path, results_to_serializable(peaklist.df))
                spectrum.peaktable_json_path = p_json_path
                db.commit()
                # sync_project_to_json(db, spectrum.project) # Optional but good
        except Exception as e:
            logger.error(f"Failed to auto-save peaktable after single fit: {e}")
        finally:
            db.close()
    
    # 8. Generate plotting data
    result = _generate_plotting_data(peaklist, cluster_df, cluster_id, lineshape, plane_idx=0)
    
    # Add fit stats if available (fit_cluster_of_peaks adds them to DF)
    result["fit_stats"] = {
        "chisqr": float(cluster_df["chisqr"].iloc[0]) if "chisqr" in cluster_df.columns else 0.0,
        "redchi": float(cluster_df["redchi"].iloc[0]) if "redchi" in cluster_df.columns else 0.0,
        "aic": float(cluster_df["aic"].iloc[0]) if "aic" in cluster_df.columns else 0.0,
    }
    
    return result


def generate_fitted_cluster_surfaces(
    spectrum_path: str,
    peaklist_path: str,
    cluster_id: int,
    fitted_peaks: list,
    plane_idx: int = 0,
    peaklist_format: str = "pipe",
    dims: list = [0, 1, 2],
    lineshape: str = "PV",
    clustering_method: str = "auto",
    struc_el: str = "disk",
    struc_size: list = [3],
):
    fmt = PeaklistFormat(peaklist_format)
    peaklist = Peaklist(
        path=peaklist_path,
        data_path=spectrum_path,
        fmt=fmt,
        dims=dims,
    )
    peaklist.update_df()

    # Get data
    # Ensure plane_idx is within bounds
    plane_idx = max(0, min(plane_idx, peaklist.n_planes - 1))
    plane_data = peaklist.data[plane_idx]
    uc_f1 = peaklist.uc_f1
    uc_f2 = peaklist.uc_f2

    # Convert fitted_peaks to DataFrame for processing
    cluster_df = pd.DataFrame(fitted_peaks)
    
    # Filter by plane if we are in 3D
    if "plane" in cluster_df.columns and peaklist.ndim == 3:
        cluster_df = cluster_df[cluster_df["plane"] == plane_idx]
    
    # Ensure necessary columns for plotting logic
    # (center_x/y, radii, sigma/fraction)

    if "center_x" not in cluster_df.columns:
        cluster_df["center_x"] = cluster_df["center_x_ppm"].apply(lambda x: uc_f2.f(x, "ppm"))
    if "center_y" not in cluster_df.columns:
        cluster_df["center_y"] = cluster_df["center_y_ppm"].apply(lambda x: uc_f1.f(x, "ppm"))
    
    if "x_radius" not in cluster_df.columns:
        if "x_radius_ppm" in cluster_df.columns:
            cluster_df["x_radius"] = cluster_df["x_radius_ppm"].apply(lambda x: x * peaklist.pt_per_ppm_f2)
        else:
            cluster_df["x_radius"] = peaklist.f2_radius
            
    if "y_radius" not in cluster_df.columns:
        if "y_radius_ppm" in cluster_df.columns:
            cluster_df["y_radius"] = cluster_df["y_radius_ppm"].apply(lambda x: x * peaklist.pt_per_ppm_f1)
        else:
            cluster_df["y_radius"] = peaklist.f1_radius

    if "assignment" not in cluster_df.columns:
        cluster_df["assignment"] = [f"peak_{i}" for i in range(len(cluster_df))]
    
    if "amp" not in cluster_df.columns and "amplitude" in cluster_df.columns:
        cluster_df["amp"] = cluster_df["amplitude"]
        
    if "lineshape" not in cluster_df.columns:
        cluster_df["lineshape"] = lineshape

    # Ensure sigma/fraction columns for simulation
    if "sigma_x" not in cluster_df.columns:
        if "fwhm_x_hz" in cluster_df.columns:
            cluster_df["sigma_x"] = (cluster_df["fwhm_x_hz"] / peaklist.hz_per_pt_f2) / 2.0
        else:
            cluster_df["sigma_x"] = 1.0
    if "sigma_y" not in cluster_df.columns:
        if "fwhm_y_hz" in cluster_df.columns:
            cluster_df["sigma_y"] = (cluster_df["fwhm_y_hz"] / peaklist.hz_per_pt_f1) / 2.0
        else:
            cluster_df["sigma_y"] = 1.0
            
    for col in ["fraction", "fraction_x", "fraction_y"]:
        if col not in cluster_df.columns:
            cluster_df[col] = 0.5

    # Add fit stats if available
    fit_stats = {}
    if not cluster_df.empty:
        for stat in ["chisqr", "redchi", "aic"]:
            if stat in cluster_df.columns:
                fit_stats[stat] = float(cluster_df[stat].iloc[0])
                
    result = _generate_plotting_data(peaklist, cluster_df, cluster_id, lineshape, plane_idx=plane_idx)
    result["fit_stats"] = fit_stats
    return result


def export_clusters_pdf(
    spectrum_path: str,
    peaklist_path: str,
    results: List[dict],
    peaklist_format: str = "pipe",
    dims: List[int] = [0, 1, 2],
    lineshape: str = "PV",
) -> io.BytesIO:
    """Generate a multi-page PDF report for all cluster fits into a buffer."""
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from matplotlib.backends.backend_pdf import PdfPages
    import io
    import logging
    
    logger = logging.getLogger("uvicorn.error")
    
    fmt = PeaklistFormat(peaklist_format)
    peaklist = Peaklist(
        path=peaklist_path,
        data_path=spectrum_path,
        fmt=fmt,
        dims=dims,
    )
    peaklist.update_df()
    
    # Group results by cluster
    df_results = pd.DataFrame(results)
    if df_results.empty:
        raise ValueError("No results provided for PDF export.")
        
    cluster_ids = sorted(df_results["clustid"].unique())
    logger.info(f"Exporting PDF for {len(cluster_ids)} clusters.")
    
    buf = io.BytesIO()
    with PdfPages(buf) as pdf:
        for i, cid in enumerate(cluster_ids):
            if i % 10 == 0:
                logger.info(f"Processing cluster {i}/{len(cluster_ids)}...")
            cluster_df = df_results[df_results["clustid"] == cid]
            
            # Identify columns for amplitude and plane
            amp_col = next((c for c in ["amplitude", "Amplitude", "amp"] if c in cluster_df.columns), None)
            plane_col = next((c for c in ["plane", "Plane"] if c in cluster_df.columns), None)

            # Use the plane with the maximum total amplitude for this cluster
            # This ensures we plot a representative slice (especially for CEST/Relaxation)
            if plane_col:
                if amp_col:
                    plane_sums = cluster_df.groupby(plane_col)[amp_col].sum()
                    plane_idx = int(plane_sums.idxmax()) if not plane_sums.empty else 0
                else:
                    plane_idx = int(cluster_df[plane_col].iloc[0])
            else:
                plane_idx = 0
            
            # Generate plotting data for this cluster
            plot_data = generate_fitted_cluster_surfaces(
                spectrum_path=spectrum_path,
                peaklist_path=peaklist_path,
                cluster_id=int(cid),
                fitted_peaks=cluster_df.to_dict(orient="records"),
                plane_idx=plane_idx,
                peaklist_format=peaklist_format,
                dims=dims,
                lineshape=lineshape
            )
            
            fig, axes = plt.subplots(1, 3, figsize=(15, 5))
            _plot_cluster_to_axes(axes, plot_data, cid)
            
            plt.tight_layout()
            pdf.savefig(fig)
            plt.close(fig)
            
    buf.seek(0)
    return buf


def _plot_cluster_to_axes(axes, data, cluster_id):
    """Helper to plot cluster data to matplotlib axes."""
    import matplotlib.pyplot as plt
    
    titles = ["Experimental", "Model", "Residuals"]
    keys = ["experimental", "model", "residuals"]
    
    # Calculate zmin/zmax globaly across Experimental and Model for consistent colors
    # Handle None/NaN by filtering them out first
    def get_z_min_max(key):
        z_data = data.get(key)
        if not z_data: return None, None
        flat = [v for row in z_data for v in row if v is not None and not np.isnan(v)]
        return (min(flat), max(flat)) if flat else (None, None)

    e_min, e_max = get_z_min_max("experimental")
    m_min, m_max = get_z_min_max("model")
    
    # Filter out Nones for final comparison
    mins = [v for v in [e_min, m_min] if v is not None]
    maxs = [v for v in [e_max, m_max] if v is not None]
    
    zmin = min(mins) if mins else 0.0
    zmax = max(maxs) if maxs else 1.0
    
    # Ensure a minimum range for color scale
    if zmin == zmax:
        zmin -= 0.1
        zmax += 0.1
        
    x_ppm = np.array(data["x_ppm"], dtype=float)
    y_ppm = np.array(data["y_ppm"], dtype=float)
    
    # Add a figure title
    plane_idx = data.get("plane_idx", 0)
    axes[0].get_figure().suptitle(f"Cluster {cluster_id} (Plane {plane_idx})", fontsize=16, fontweight='bold')
    
    for i, (ax, title, key) in enumerate(zip(axes, titles, keys)):
        # Ensure z is a float array with NaNs for None
        z_raw = data[key]
        if not z_raw:
            ax.text(0.5, 0.5, "No Data", ha='center', va='center', transform=ax.transAxes)
            continue
            
        z = np.array([[v if v is not None else np.nan for v in row] for row in z_raw], dtype=float)
        
        # Check if all NaN
        if np.isnan(z).all():
            ax.text(0.5, 0.5, "Empty Data", ha='center', va='center', transform=ax.transAxes)
            continue

        # Plot contours
        try:
            levels = np.linspace(zmin, zmax, 15) if key != "residuals" else 15
            im = ax.contourf(x_ppm, y_ppm, z, levels=levels, cmap="viridis" if key != "residuals" else "RdBu_r",
                             vmin=zmin if key != "residuals" else None, 
                             vmax=zmax if key != "residuals" else None)
            plt.colorbar(im, ax=ax, fraction=0.046, pad=0.04)
        except Exception as e:
            ax.text(0.5, 0.5, f"Plot Error: {str(e)}", ha='center', va='center', transform=ax.transAxes)

        ax.set_title(title)
        ax.invert_xaxis()
        ax.invert_yaxis()
        
        # Get labels from data (populated in _generate_plotting_data)
        xlabel = data.get("xlabel", "F2 (ppm)")
        ylabel = data.get("ylabel", "F1 (ppm)")
        
        ax.set_xlabel(xlabel)
        ax.set_ylabel(ylabel)
        
        # Add 'x' markers and labels for peak positions in Experimental and Model
        if i < 2 and data.get("peak_annotations"):
            for p in data["peak_annotations"]:
                ax.scatter(p["x_ppm"], p["y_ppm"], marker="x", color="red", s=30, linewidths=1)
                ax.text(p["x_ppm"], p["y_ppm"], f" {p['label']}", color='red', fontsize=8, 
                        verticalalignment='bottom', horizontalalignment='left')
