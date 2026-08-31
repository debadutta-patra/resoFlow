import os
import json
import signal
from datetime import datetime, timezone
from typing import List, Optional, Dict, Any
from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.orm import Session
from sqlalchemy import func, case, or_

from .. import models, schemas, database, security
from ..celery_app import celery_app
from ..services.log_parser import extract_failure_reason, extract_current_step

router = APIRouter(prefix="/api/users/me", tags=["dashboard-and-runs"])


def reconcile_orphaned_runs(db: Session, user_id: int):
    """
    Detect and reconcile any runs left in 'RUNNING' state where the worker process has died.
    """
    # 1. Check running analyses
    running_analyses = (
        db.query(models.Analysis)
        .join(models.Project)
        .filter(
            models.Project.user_id == user_id,
            models.Analysis.status == "RUNNING",
        )
        .all()
    )

    for analysis in running_analyses:
        project = analysis.project
        run_dir = os.path.dirname(analysis.log_path) if analysis.log_path else None
        
        # Check if results already finished but status didn't update
        if analysis.results_path and os.path.exists(analysis.results_path):
            try:
                with open(analysis.results_path, "r") as rf:
                    res_data = json.load(rf)
                if res_data and (res_data.get("residues") or res_data.get("peak_results")):
                    analysis.status = "COMPLETED"
                    analysis.completed_at = analysis.completed_at or datetime.now(timezone.utc)
                    db.commit()
                    continue
            except Exception:
                pass

        # Check log file for completion or failure markers
        if analysis.log_path and os.path.exists(analysis.log_path):
            try:
                with open(analysis.log_path, "r", encoding="utf-8", errors="replace") as f:
                    log_text = f.read()
                if "Completed at:" in log_text:
                    analysis.status = "COMPLETED"
                    analysis.completed_at = analysis.completed_at or datetime.now(timezone.utc)
                    db.commit()
                    continue
                if "ERROR:" in log_text or "Traceback (most recent call last):" in log_text:
                    analysis.status = "FAILED"
                    analysis.error_message = extract_failure_reason(analysis.log_path, "Run failed in worker")
                    analysis.completed_at = analysis.completed_at or datetime.now(timezone.utc)
                    db.commit()
                    continue
            except Exception:
                pass

        # Check PID file liveness
        if run_dir:
            pid_file = os.path.join(run_dir, "chemex.pid")
            if os.path.exists(pid_file):
                try:
                    with open(pid_file, "r") as pf:
                        pid = int(pf.read().strip())
                    # Check if process is still running
                    os.kill(pid, 0)
                    # Process is alive, keep RUNNING
                    continue
                except (OSError, ValueError):
                    # Process is dead but status was still RUNNING
                    analysis.status = "FAILED"
                    analysis.error_message = extract_failure_reason(
                        analysis.log_path, "Worker process terminated unexpectedly (orphaned run)"
                    )
                    analysis.completed_at = datetime.now(timezone.utc)
                    try:
                        os.remove(pid_file)
                    except Exception:
                        pass
                    db.commit()
                    continue

        # If no PID file and task was created more than 90 seconds ago without logs being updated
        if analysis.created_at:
            created_tz = analysis.created_at.replace(tzinfo=timezone.utc) if analysis.created_at.tzinfo is None else analysis.created_at
            now_tz = datetime.now(timezone.utc)
            age_seconds = (now_tz - created_tz).total_seconds()
            
            # Check log file last modification time
            log_stale = True
            if analysis.log_path and os.path.exists(analysis.log_path):
                log_mtime = os.path.getmtime(analysis.log_path)
                if (now_tz.timestamp() - log_mtime) < 60:
                    log_stale = False

            if age_seconds > 120 and log_stale:
                analysis.status = "FAILED"
                analysis.error_message = extract_failure_reason(
                    analysis.log_path, "Worker process terminated unexpectedly (orphaned run)"
                )
                analysis.completed_at = datetime.now(timezone.utc)
                db.commit()

    # 2. Check running peak-fitting jobs
    running_jobs = (
        db.query(models.Job)
        .join(models.Project)
        .filter(
            models.Project.user_id == user_id,
            models.Job.status == "RUNNING",
        )
        .all()
    )

    for job in running_jobs:
        if job.log_path and os.path.exists(job.log_path):
            try:
                with open(job.log_path, "r", encoding="utf-8", errors="replace") as f:
                    log_text = f.read()
                if "FITTING COMPLETE" in log_text or "Final results saved to" in log_text:
                    job.status = "COMPLETED"
                    job.completed_at = job.completed_at or datetime.now(timezone.utc)
                    db.commit()
                    continue
                if "ERROR" in log_text or "Traceback" in log_text:
                    job.status = "FAILED"
                    job.error_message = extract_failure_reason(job.log_path, "Peak fitting failed in worker")
                    job.completed_at = job.completed_at or datetime.now(timezone.utc)
                    db.commit()
                    continue
            except Exception:
                pass

        if job.created_at:
            created_tz = job.created_at.replace(tzinfo=timezone.utc) if job.created_at.tzinfo is None else job.created_at
            now_tz = datetime.now(timezone.utc)
            age_seconds = (now_tz - created_tz).total_seconds()
            if age_seconds > 180:
                job.status = "FAILED"
                job.error_message = extract_failure_reason(job.log_path, "Peak fitting worker timed out or terminated")
                job.completed_at = datetime.now(timezone.utc)
                db.commit()


def _get_analysis_reduced_chi2(analysis: models.Analysis) -> Optional[float]:
    """Extract reduced chi2 from results.json if available."""
    if not analysis.results_path or not os.path.exists(analysis.results_path):
        return None
    try:
        with open(analysis.results_path, "r") as f:
            data = json.load(f)
        if "global" in data and "chi2_red" in data["global"]:
            return float(data["global"]["chi2_red"])
        if "summary" in data and "avg_redchi" in data["summary"]:
            return float(data["summary"]["avg_redchi"])
        if "peak_results" in data and isinstance(data["peak_results"], list) and len(data["peak_results"]) > 0:
            redchis = [r["redchi"] for r in data["peak_results"] if "redchi" in r and r["redchi"] is not None]
            if redchis:
                return float(sum(redchis) / len(redchis))
    except Exception:
        pass
    return None


def _get_analysis_fit_mode(analysis: models.Analysis) -> Optional[str]:
    """Extract fit mode from parameters or results."""
    if analysis.parameters:
        try:
            params = json.loads(analysis.parameters)
            if "fit_mode" in params:
                return str(params["fit_mode"]).capitalize()
        except Exception:
            pass
    if analysis.results_path and os.path.exists(analysis.results_path):
        try:
            with open(analysis.results_path, "r") as f:
                data = json.load(f)
            if "fit_mode" in data:
                return str(data["fit_mode"]).capitalize()
        except Exception:
            pass
    return "Global" if analysis.analysis_type in ["15N-CEST", "CPMG"] else None


def _build_run_item_from_analysis(analysis: models.Analysis) -> schemas.RunItem:
    now_tz = datetime.now(timezone.utc)
    created_tz = analysis.created_at.replace(tzinfo=timezone.utc) if analysis.created_at and analysis.created_at.tzinfo is None else analysis.created_at
    completed_tz = analysis.completed_at.replace(tzinfo=timezone.utc) if analysis.completed_at and analysis.completed_at.tzinfo is None else analysis.completed_at

    elapsed = None
    if created_tz:
        end_time = completed_tz if completed_tz else now_tz
        elapsed = max(0.0, (end_time - created_tz).total_seconds())

    error_reason = None
    if analysis.status == "FAILED":
        error_reason = extract_failure_reason(analysis.log_path, analysis.error_message)

    current_step = None
    if analysis.status == "RUNNING":
        current_step = extract_current_step(analysis.log_path, analysis.status)

    return schemas.RunItem(
        id=analysis.id,
        uuid=analysis.analysis_uuid,
        name=analysis.name,
        kind="analysis",
        analysis_type=analysis.analysis_type,
        status=analysis.status,
        project_id=analysis.project_id,
        project_uuid=analysis.project.project_uuid if analysis.project else "",
        project_name=analysis.project.name if analysis.project else "Unknown",
        created_at=analysis.created_at,
        completed_at=analysis.completed_at,
        elapsed_seconds=elapsed,
        error_reason=error_reason,
        current_step=current_step,
        log_path=analysis.log_path,
        fit_mode=_get_analysis_fit_mode(analysis),
    )


def _build_run_item_from_job(job: models.Job) -> schemas.RunItem:
    now_tz = datetime.now(timezone.utc)
    created_tz = job.created_at.replace(tzinfo=timezone.utc) if job.created_at and job.created_at.tzinfo is None else job.created_at
    completed_tz = job.completed_at.replace(tzinfo=timezone.utc) if job.completed_at and job.completed_at.tzinfo is None else job.completed_at

    elapsed = None
    if created_tz:
        end_time = completed_tz if completed_tz else now_tz
        elapsed = max(0.0, (end_time - created_tz).total_seconds())

    error_reason = None
    if job.status == "FAILED":
        error_reason = extract_failure_reason(job.log_path, job.error_message)

    current_step = None
    if job.status == "RUNNING":
        current_step = extract_current_step(
            job.log_path, job.status, total_items=job.total_clusters, completed_items=job.completed_clusters
        )

    spec_name = job.spectrum.name if job.spectrum else f"Spectrum #{job.spectrum_id}"
    return schemas.RunItem(
        id=job.id,
        uuid=job.job_uuid,
        name=f"Peak Fitting ({spec_name})",
        kind="peak_fitting",
        analysis_type="Peak Fitting",
        status=job.status,
        project_id=job.project_id,
        project_uuid=job.project.project_uuid if job.project else "",
        project_name=job.project.name if job.project else "Unknown",
        created_at=job.created_at,
        completed_at=job.completed_at,
        elapsed_seconds=elapsed,
        error_reason=error_reason,
        current_step=current_step,
        log_path=job.log_path,
        fit_mode=None,
    )


@router.get("/dashboard", response_model=schemas.DashboardResponse)
def get_dashboard(
    current_user: models.User = Depends(security.get_current_user),
    db: Session = Depends(database.get_db),
):
    """
    Main user-scoped dashboard endpoint providing aggregated project summaries,
    active/recent runs, and recent analyses in a single database round trip.
    """
    # 1. Reconcile any orphaned runs for this user
    reconcile_orphaned_runs(db, current_user.id)

    # 2. Fetch user's projects with aggregated stats
    projects = (
        db.query(models.Project)
        .filter(models.Project.user_id == current_user.id)
        .order_by(models.Project.created_at.desc())
        .all()
    )

    enriched_projects: List[schemas.EnrichedProject] = []
    total_spectra = 0

    for p in projects:
        spec_count = len(p.spectra) if p.spectra else 0
        total_spectra += spec_count
        analysis_count = len(p.analyses) if p.analyses else 0

        # Calculate status breakdown
        status_counts = {"completed": 0, "running": 0, "failed": 0, "pending": 0}
        last_activity_dates = [p.created_at] if p.created_at else []

        if p.analyses:
            for a in p.analyses:
                st = (a.status or "").lower()
                if st in status_counts:
                    status_counts[st] += 1
                if a.completed_at:
                    last_activity_dates.append(a.completed_at)
                elif a.created_at:
                    last_activity_dates.append(a.created_at)

        if p.jobs:
            for j in p.jobs:
                st = (j.status or "").lower()
                if st in status_counts:
                    status_counts[st] += 1
                if j.completed_at:
                    last_activity_dates.append(j.completed_at)
                elif j.created_at:
                    last_activity_dates.append(j.created_at)

        last_run_at = max(last_activity_dates) if last_activity_dates else p.created_at

        enriched_projects.append(
            schemas.EnrichedProject(
                id=p.id,
                project_uuid=p.project_uuid,
                name=p.name,
                local_directory_path=p.local_directory_path,
                protein_sequence=p.protein_sequence,
                molecular_weight=p.molecular_weight,
                experiments=p.experiments,
                is_archived=bool(getattr(p, "is_archived", False)),
                user_id=p.user_id,
                created_at=p.created_at,
                last_run_at=last_run_at,
                spectra_count=spec_count,
                analysis_count=analysis_count,
                status_counts=status_counts,
            )
        )

    # 3. Fetch active & recent runs (strictly user-scoped)
    all_runs: List[schemas.RunItem] = []

    user_analyses = (
        db.query(models.Analysis)
        .join(models.Project)
        .filter(models.Project.user_id == current_user.id)
        .order_by(models.Analysis.created_at.desc())
        .all()
    )

    for a in user_analyses:
        # Include non-terminal runs or recently terminal runs (last 10)
        all_runs.append(_build_run_item_from_analysis(a))

    user_jobs = (
        db.query(models.Job)
        .join(models.Project)
        .filter(models.Project.user_id == current_user.id)
        .order_by(models.Job.created_at.desc())
        .all()
    )

    for j in user_jobs:
        all_runs.append(_build_run_item_from_job(j))

    # Sort runs: active first (RUNNING, PENDING), then latest completed/failed
    status_order = {"RUNNING": 0, "PENDING": 1, "FAILED": 2, "COMPLETED": 3}
    all_runs.sort(
        key=lambda r: (
            status_order.get(r.status, 9),
            -(r.created_at.timestamp() if r.created_at else 0),
        )
    )

    # Filter to active runs + up to 10 recent terminal runs
    active_runs_list = [r for r in all_runs if r.status in ["RUNNING", "PENDING"]]
    terminal_runs_list = [r for r in all_runs if r.status in ["COMPLETED", "FAILED"]][:10]
    display_runs = active_runs_list + terminal_runs_list

    # 4. Fetch recent analyses (top 10 user analyses)
    recent_analyses: List[schemas.RecentAnalysisItem] = []
    for a in user_analyses[:15]:
        recent_analyses.append(
            schemas.RecentAnalysisItem(
                id=a.id,
                analysis_uuid=a.analysis_uuid,
                name=a.name,
                analysis_type=a.analysis_type,
                status=a.status,
                project_id=a.project_id,
                project_uuid=a.project.project_uuid if a.project else "",
                project_name=a.project.name if a.project else "Unknown",
                fit_mode=_get_analysis_fit_mode(a),
                reduced_chi2=_get_analysis_reduced_chi2(a),
                created_at=a.created_at,
                completed_at=a.completed_at,
            )
        )

    # 5. Calculate statistics
    active_count = len([r for r in all_runs if r.status == "RUNNING"])
    queued_count = len([r for r in all_runs if r.status == "PENDING"])
    failed_count = len([r for r in all_runs if r.status == "FAILED"])
    completed_count = len([r for r in all_runs if r.status == "COMPLETED"])

    stats = schemas.DashboardStats(
        total_projects=len(projects),
        total_spectra=total_spectra,
        total_jobs=len(all_runs),
        active_runs=active_count,
        queued_runs=queued_count,
        failed_runs=failed_count,
        completed_runs=completed_count,
    )

    recent_activity = [
        {"id": 1, "action": f"Active Runs: {active_count}", "timestamp": datetime.now(timezone.utc)}
    ]

    return {
        "user": current_user,
        "stats": stats,
        "runs": display_runs,
        "recent_analyses": recent_analyses,
        "projects": enriched_projects,
        "recent_activity": recent_activity,
    }


@router.get("/runs/active", response_model=schemas.ActiveRunsResponse)
def get_active_runs(
    current_user: models.User = Depends(security.get_current_user),
    db: Session = Depends(database.get_db),
):
    """
    Lightweight endpoint for polling active and queued runs from the header indicator.
    """
    reconcile_orphaned_runs(db, current_user.id)

    analyses = (
        db.query(models.Analysis)
        .join(models.Project)
        .filter(
            models.Project.user_id == current_user.id,
            models.Analysis.status.in_(["RUNNING", "PENDING"]),
        )
        .all()
    )

    jobs = (
        db.query(models.Job)
        .join(models.Project)
        .filter(
            models.Project.user_id == current_user.id,
            models.Job.status.in_(["RUNNING", "PENDING"]),
        )
        .all()
    )

    runs = [_build_run_item_from_analysis(a) for a in analyses] + [_build_run_item_from_job(j) for j in jobs]
    
    active_count = len([r for r in runs if r.status == "RUNNING"])
    queued_count = len([r for r in runs if r.status == "PENDING"])

    return schemas.ActiveRunsResponse(
        active_count=active_count,
        queued_count=queued_count,
        runs=runs,
    )


@router.post("/runs/{run_uuid}/cancel")
def cancel_user_run(
    run_uuid: str,
    current_user: models.User = Depends(security.get_current_user),
    db: Session = Depends(database.get_db),
):
    """
    Cancel an active run (Analysis or Peak Fitting Job) and terminate underlying worker processes.
    """
    # 1. Check if it's an Analysis
    analysis = (
        db.query(models.Analysis)
        .join(models.Project)
        .filter(
            models.Project.user_id == current_user.id,
            models.Analysis.analysis_uuid == run_uuid,
        )
        .first()
    )

    if analysis:
        if analysis.status not in ["RUNNING", "PENDING"]:
            return {"message": f"Analysis is already in {analysis.status} state"}

        # Terminate Celery task if task_id recorded
        task_id = analysis.celery_task_id
        if not task_id and analysis.parameters:
            try:
                params = json.loads(analysis.parameters)
                task_id = params.get("task_id")
            except Exception:
                pass
        if task_id:
            try:
                celery_app.control.revoke(task_id, terminate=True, signal="SIGTERM")
            except Exception:
                pass

        # Terminate ChemEx ephemeral container
        from ..services.fitting.chemex_runner import cancel_chemex_job
        cancel_chemex_job(analysis.analysis_uuid)

        analysis.cancel_requested = True
        analysis.status = "CANCELLED"
        analysis.error_message = "Cancelled by user"
        analysis.completed_at = datetime.now(timezone.utc)

        if analysis.log_path and os.path.exists(analysis.log_path):
            try:
                with open(analysis.log_path, "a") as f:
                    f.write(f"\n\n{'=' * 60}\nCANCELLED BY USER AT: {datetime.now().isoformat()}\n{'=' * 60}\n")
            except Exception:
                pass

        db.commit()
        return {"message": "Analysis cancelled successfully", "status": "CANCELLED"}

    # 2. Check if it's a Job
    job = (
        db.query(models.Job)
        .join(models.Project)
        .filter(
            models.Project.user_id == current_user.id,
            models.Job.job_uuid == run_uuid,
        )
        .first()
    )

    if job:
        if job.status not in ["RUNNING", "PENDING"]:
            return {"message": f"Job is already in {job.status} state"}

        if job.celery_task_id:
            try:
                celery_app.control.revoke(job.celery_task_id, terminate=True, signal="SIGKILL")
            except Exception:
                pass

        # Broadcast shutdown to worker node
        try:
            worker_node = f"celery@worker_job_{job.id}"
            celery_app.control.broadcast("shutdown", destination=[worker_node])
        except Exception:
            pass

        job.status = "FAILED"
        job.error_message = "Cancelled by user"
        job.completed_at = datetime.now(timezone.utc)
        db.commit()
        return {"message": "Job cancelled successfully", "status": "FAILED"}

    raise HTTPException(status_code=404, detail="Run not found or access denied")
