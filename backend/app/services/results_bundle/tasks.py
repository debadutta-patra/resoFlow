"""Celery Tasks for Results Bundle Ingestion and Artifact Prebuilding (§3.11).

Dispatched on the 'stats' queue after collect() completes.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

from ...celery_app import celery_app
from ... import models, database
from .ingest import ingest_results
from .artifacts import get_or_render_artifact
from .store import is_bundle_valid

logger = logging.getLogger(__name__)


def _resolve_run_dir(analysis: models.Analysis) -> Path:
    if analysis.results_path and os.path.exists(analysis.results_path):
        return Path(os.path.dirname(analysis.results_path)).resolve()
    project = analysis.project
    atype = (analysis.analysis_type or "").upper()
    if atype == "CPMG":
        folder = "cpmg_fitting"
    elif atype == "EXCHANGE":
        folder = "exchange_fitting"
    elif atype in ("R1", "R2", "HETNOE"):
        folder = f"{atype.lower()}_fitting"
    else:
        folder = "cest_fitting"
    return (Path(project.local_directory_path) / folder / analysis.analysis_uuid).resolve()


@celery_app.task(bind=True, name="app.services.results_bundle.tasks.ingest_results_task")
def ingest_results_task(self, analysis_uuid: str) -> Dict[str, Any]:
    """
    Celery task to ingest the ChemEx output tree into a results bundle.
    Updates DB status to COMPLETED on success, or COMPLETED_WITH_ERRORS on failure.
    """
    db = next(database.get_db())
    try:
        analysis = db.query(models.Analysis).filter(
            models.Analysis.analysis_uuid == analysis_uuid
        ).first()
        if not analysis:
            raise ValueError(f"Analysis {analysis_uuid} not found")

        run_dir = _resolve_run_dir(analysis)
        logger.info("Ingesting results bundle for analysis %s at %s", analysis_uuid, run_dir)

        meta = ingest_results(
            run_dir=run_dir,
            analysis_uuid=analysis_uuid,
            chemex_version=analysis.chemex_version,
            analysis_name=analysis.name,
            analysis_type=analysis.analysis_type or "CEST",
        )

        analysis.bundle_status = "VALID"
        analysis.summary_redchi = meta.get("summary_redchi")
        analysis.summary_n_residues = meta.get("summary_n_residues")
        analysis.status = "COMPLETED"
        analysis.completed_at = datetime.now()
        analysis.error_message = None
        db.commit()
        return meta

    except Exception as exc:
        logger.exception("Ingest failed for analysis %s: %s", analysis_uuid, exc)
        try:
            analysis = db.query(models.Analysis).filter(
                models.Analysis.analysis_uuid == analysis_uuid
            ).first()
            if analysis:
                analysis.status = "COMPLETED_WITH_ERRORS"
                analysis.bundle_status = "ERROR"
                analysis.error_message = f"Fit finished, but bundle ingest failed: {exc}"
                analysis.completed_at = datetime.now()
                db.commit()
        except Exception:
            pass
        raise
    finally:
        db.close()


@celery_app.task(bind=True, name="app.services.results_bundle.tasks.prebuild_artifacts_task")
def prebuild_artifacts_task(self, analysis_uuid: str) -> Dict[str, Any]:
    """
    Celery task to prebuild default publication report PDF and plots ZIP.
    Runs on the 'stats' queue chained after ingest.
    """
    db = next(database.get_db())
    try:
        analysis = db.query(models.Analysis).filter(
            models.Analysis.analysis_uuid == analysis_uuid
        ).first()
        if not analysis:
            raise ValueError(f"Analysis {analysis_uuid} not found")

        run_dir = _resolve_run_dir(analysis)
        if not is_bundle_valid(run_dir):
            logger.info("Bundle not ready or invalid for %s, skipping prebuild", analysis_uuid)
            return {"status": "skipped", "reason": "bundle_not_valid"}

        excluded = None
        if analysis.parameters:
            try:
                p_data = json.loads(analysis.parameters)
                excluded = p_data.get("excludedResidues") or p_data.get("excluded_residues")
            except Exception:
                pass

        logger.info("Prebuilding default artifacts for %s", analysis_uuid)
        report_path = get_or_render_artifact(
            run_dir=run_dir,
            kind="report",
            analysis_name=analysis.name,
            analysis_type=analysis.analysis_type or "CEST",
            style="publication",
            palette="okabe_ito",
            excluded_residues=excluded,
            chemex_image_digest=analysis.chemex_image_digest,
        )

        plots_path = get_or_render_artifact(
            run_dir=run_dir,
            kind="plots",
            analysis_name=analysis.name,
            analysis_type=analysis.analysis_type or "CEST",
            style="publication",
            palette="okabe_ito",
            excluded_residues=excluded,
            chemex_image_digest=analysis.chemex_image_digest,
        )

        return {
            "status": "ready",
            "report_pdf": str(report_path),
            "plots_zip": str(plots_path),
        }
    except Exception as exc:
        logger.warning("Artifact prebuilding encountered an issue for %s: %s", analysis_uuid, exc)
        return {"status": "failed", "error": str(exc)}
    finally:
        db.close()
