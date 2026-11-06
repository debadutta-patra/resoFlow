"""
Celery task for asynchronous PDF report generation.
Dispatched to the 'stats' queue per WeasyPrint design spec §8.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
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
        atype = (analysis.analysis_type or "").upper()
        if atype == "CPMG":
            folder_name = "cpmg_fitting"
            analysis_type = "CPMG"
        elif atype == "EXCHANGE":
            folder_name = "exchange_fitting"
            analysis_type = "EXCHANGE"
        elif atype in ("R1", "R2", "HETNOE"):
            folder_name = f"{analysis.analysis_type.lower()}_fitting"
            analysis_type = atype
        else:
            folder_name = "cest_fitting"
            analysis_type = "CEST"

        if analysis.results_path and os.path.exists(analysis.results_path):
            run_dir = os.path.dirname(analysis.results_path)
        else:
            run_dir = os.path.join(project.local_directory_path, folder_name, analysis.analysis_uuid)

        palette = (options or {}).get("palette") or (options or {}).get("color")
        if palette and palette != "okabe_ito":
            safe_palette = "".join(c for c in palette if c.isalnum() or c in ("_", "-"))
            pdf_path = os.path.join(run_dir, f"report_{safe_palette}.pdf")
        else:
            pdf_path = os.path.join(run_dir, "report.pdf")

        logger.info(
            "Generating PDF report for analysis %s (type: %s) at %s (palette: %s)",
            analysis_uuid,
            analysis.analysis_type,
            pdf_path,
            palette,
        )

        excluded_residues = None
        if analysis.parameters:
            try:
                p_data = json.loads(analysis.parameters)
                excluded_residues = p_data.get("excludedResidues") or p_data.get("excluded_residues")
            except Exception:
                pass

        from ..results_bundle.artifacts import get_or_render_artifact

        artifact_path = get_or_render_artifact(
            run_dir=run_dir,
            kind="report",
            analysis_name=analysis.name,
            analysis_type=analysis_type,
            style=style,
            palette=palette or "okabe_ito",
            excluded_residues=excluded_residues,
            chemex_image_digest=analysis.chemex_image_digest,
        )

        file_size = os.path.getsize(artifact_path)
        # Compatibility copy at run_dir / report.pdf
        try:
            if str(artifact_path) != str(pdf_path):
                shutil.copyfile(str(artifact_path), str(pdf_path))
        except Exception as c_exc:
            logger.debug("Could not copy compatibility report PDF: %s", c_exc)

        logger.info("Report PDF generated successfully for %s: %d bytes", analysis_uuid, file_size)

        return {
            "status": "COMPLETED",
            "analysis_uuid": analysis_uuid,
            "pdf_path": str(artifact_path),
            "size_bytes": file_size,
        }
    except Exception as exc:
        logger.exception("Error generating PDF report for %s: %s", analysis_uuid, exc)
        raise
    finally:
        if close_db and db is not None:
            db.close()


@celery_app.task(bind=True, name="app.services.reporting.tasks.export_plots_zip_task")
def export_plots_zip_task(
    self,
    analysis_uuid: str,
    palette: Optional[str] = None,
    style: str = "publication",
    options: Optional[Dict[str, Any]] = None,
    db: Optional[Any] = None,
) -> Dict[str, Any]:
    """
    Celery task to generate all publication plots (300 DPI PNG and vector PDF) in a ZIP archive.
    Runs on the 'stats' queue.
    Saves the generated ZIP to run_dir / f"plots_{safe_palette}.zip" and returns metadata.
    """
    from ..export.plot_export import export_all_plots_zip

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
        atype = (analysis.analysis_type or "").upper()
        if atype == "CPMG":
            folder_name = "cpmg_fitting"
            analysis_type = "CPMG"
        elif atype == "EXCHANGE":
            folder_name = "exchange_fitting"
            analysis_type = "EXCHANGE"
        elif atype in ("R1", "R2", "HETNOE"):
            folder_name = f"{analysis.analysis_type.lower()}_fitting"
            analysis_type = atype
        else:
            folder_name = "cest_fitting"
            analysis_type = "CEST"

        if analysis.results_path and os.path.exists(analysis.results_path):
            run_dir = analysis.results_path if os.path.isdir(analysis.results_path) else os.path.dirname(analysis.results_path)
        else:
            run_dir = os.path.join(project.local_directory_path, folder_name, analysis.analysis_uuid)

        os.makedirs(run_dir, exist_ok=True)

        chosen_palette = palette or (options or {}).get("palette") or (options or {}).get("color") or "okabe_ito"

        from ..results_bundle.artifacts import get_or_render_artifact

        excluded_residues = None
        if analysis.parameters:
            try:
                p_data = json.loads(analysis.parameters)
                excluded_residues = p_data.get("excludedResidues") or p_data.get("excluded_residues")
            except Exception:
                pass

        artifact_path = get_or_render_artifact(
            run_dir=run_dir,
            kind="plots",
            analysis_name=analysis.name,
            analysis_type=analysis_type,
            style=style,
            palette=chosen_palette,
            excluded_residues=excluded_residues,
            chemex_image_digest=analysis.chemex_image_digest,
        )

        file_size = os.path.getsize(artifact_path)
        # Compatibility copy at run_dir / plots_<palette>.zip
        safe_palette = "".join(c for c in chosen_palette if c.isalnum() or c in ("_", "-"))
        legacy_zip = os.path.join(run_dir, f"plots_{safe_palette}.zip")
        try:
            if str(artifact_path) != str(legacy_zip):
                shutil.copyfile(str(artifact_path), str(legacy_zip))
        except Exception as c_exc:
            logger.debug("Could not copy compatibility plots ZIP: %s", c_exc)

        logger.info("Plots ZIP archive exported successfully for %s: %d bytes", analysis_uuid, file_size)

        return {
            "status": "COMPLETED",
            "analysis_uuid": analysis_uuid,
            "zip_path": str(artifact_path),
            "size_bytes": file_size,
            "palette": chosen_palette,
        }
    except Exception as exc:
        logger.exception("Error exporting plots ZIP archive for %s: %s", analysis_uuid, exc)
        raise
    finally:
        if close_db and db is not None:
            db.close()
