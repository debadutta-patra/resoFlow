"""
Celery task for asynchronous PDF report generation.
Dispatched to the 'stats' queue per WeasyPrint design spec §8.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Dict, Optional

from ...celery_app import celery_app
from ... import models, database
from .report_generator import generate_modern_pdf_report

logger = logging.getLogger(__name__)


@celery_app.task(bind=True, name="app.services.reporting.tasks.generate_report_pdf_task")
def generate_report_pdf_task(
    self,
    analysis_uuid: str,
    style: str = "publication",
    options: Optional[Dict[str, Any]] = None,
    db: Optional[Any] = None,
) -> Dict[str, Any]:
    """
    Celery task to generate a publication-ready PDF report for an analysis.
    Runs on the 'stats' queue.
    Saves the generated PDF to run_dir / 'report.pdf' and returns metadata.
    """
    close_db = False
    if db is None:
        db = next(database.get_db())
        close_db = True

    try:
        analysis = db.query(models.Analysis).filter(
            models.Analysis.analysis_uuid == analysis_uuid
        ).first()

        if not analysis:
            raise ValueError(f"Analysis {analysis_uuid} not found")

        project = analysis.project
        is_cpmg = (analysis.analysis_type or "").upper() == "CPMG"
        folder_name = "cpmg_fitting" if is_cpmg else "cest_fitting"

        if analysis.results_path and os.path.exists(analysis.results_path):
            run_dir = os.path.dirname(analysis.results_path)
        else:
            run_dir = os.path.join(project.local_directory_path, folder_name, analysis.analysis_uuid)

        os.makedirs(run_dir, exist_ok=True)
        pdf_path = os.path.join(run_dir, "report.pdf")

        logger.info("Generating PDF report for analysis %s (type: %s) at %s", analysis_uuid, analysis.analysis_type, pdf_path)

        analysis_type = "CPMG" if is_cpmg else "CEST"
        pdf_buf = generate_modern_pdf_report(
            analysis_dir=run_dir,
            analysis_name=analysis.name,
            analysis_type=analysis_type,
            style=style,
            chemex_image_digest=analysis.chemex_image_digest,
        )

        with open(pdf_path, "wb") as f:
            f.write(pdf_buf.getvalue())

        file_size = os.path.getsize(pdf_path)
        logger.info("Report PDF generated successfully for %s: %d bytes", analysis_uuid, file_size)

        return {
            "status": "COMPLETED",
            "analysis_uuid": analysis_uuid,
            "pdf_path": pdf_path,
            "size_bytes": file_size,
        }
    except Exception as exc:
        logger.exception("Error generating PDF report for %s: %s", analysis_uuid, exc)
        raise
    finally:
        if close_db and db is not None:
            db.close()
