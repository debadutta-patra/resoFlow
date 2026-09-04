# backend/app/services/reporting/report_generator.py
"""
Modern PDF and HTML report generator for resoFlow.
Thin coordination shim delegating data assembly to ReportModel and
document rendering to WeasyPrint per Phase D of the migration spec.
"""

from __future__ import annotations

import io
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

from .model import ReportModel, build_report_model
from .render import render_pdf, render_html

logger = logging.getLogger(__name__)


class ReportBuilder:
    """
    Thin coordinator shim connecting ReportModel to WeasyPrint rendering.
    Maintains backward compatibility with callers expecting ReportBuilder attributes.
    """

    def __init__(
        self,
        analysis_dir: Optional[Union[str, Path, ReportModel]] = None,
        analysis_name: Optional[str] = None,
        analysis_type: str = "CEST",
        style: str = "publication",
        style_name: Optional[str] = None,
        chemex_image_digest: Optional[str] = None,
        fixed_timestamp: Optional[str] = None,
        model: Optional[ReportModel] = None,
    ):
        if isinstance(analysis_dir, ReportModel):
            self.model = analysis_dir
        elif model is not None:
            self.model = model
        elif analysis_dir is not None:
            a_dir = Path(analysis_dir)
            a_name = analysis_name or a_dir.name
            self.model = build_report_model(
                analysis_dir=a_dir,
                analysis_name=a_name,
                analysis_type=analysis_type,
                chemex_image_digest=chemex_image_digest,
                fixed_timestamp=fixed_timestamp,
            )
        else:
            raise ValueError("Either analysis_dir or model must be provided to ReportBuilder.")

        self.analysis_dir = self.model.analysis_dir
        self.analysis_name = self.model.analysis_name
        self.analysis_type = self.model.analysis_type
        self.style_name = style_name or style

        # Backward compatibility aliases
        self.residue_records = self.model.residues
        self.provenance = self.model.provenance
        self.derived_kinetics = self.model.derived_kinetics
        self.results = self.model.results

    def render_pdf(self) -> io.BytesIO:
        """Render the complete PDF report in a single pass via WeasyPrint."""
        return render_pdf(self.model, style=self.style_name)

    def render_html(self) -> str:
        """Render the complete HTML report for web/screen display."""
        return render_html(self.model, style=self.style_name)


def generate_modern_pdf_report(
    analysis_dir: Union[str, Path],
    analysis_name: str,
    analysis_type: str = "CEST",
    style: str = "publication",
    chemex_image_digest: Optional[str] = None,
    fixed_timestamp: Optional[str] = None,
) -> io.BytesIO:
    """
    Main public entry point for generating modern, publication-usable PDF reports.
    Builds the ReportModel and renders directly to PDF via WeasyPrint.
    """
    model = build_report_model(
        analysis_dir=analysis_dir,
        analysis_name=analysis_name,
        analysis_type=analysis_type,
        chemex_image_digest=chemex_image_digest,
        fixed_timestamp=fixed_timestamp,
    )
    builder = ReportBuilder(model=model, style=style)
    return builder.render_pdf()


def generate_cest_pdf_report(
    analysis_dir: Union[str, Path],
    analysis_name: str,
    **kwargs,
) -> io.BytesIO:
    """Convenience wrapper for CEST relaxation dispersion reports."""
    return generate_modern_pdf_report(
        analysis_dir=analysis_dir,
        analysis_name=analysis_name,
        analysis_type="CEST",
        **kwargs,
    )


def generate_cpmg_pdf_report(
    analysis_dir: Union[str, Path],
    analysis_name: str,
    **kwargs,
) -> io.BytesIO:
    """Convenience wrapper for CPMG relaxation dispersion reports."""
    return generate_modern_pdf_report(
        analysis_dir=analysis_dir,
        analysis_name=analysis_name,
        analysis_type="CPMG",
        **kwargs,
    )
