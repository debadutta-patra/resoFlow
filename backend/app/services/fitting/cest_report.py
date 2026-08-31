"""
PDF Report generation entry point for resoFlow fitting services.
Delegates to the modern publication-ready reporting engine in app.services.reporting.
"""

import os
import json
import io
from typing import Optional
from ..reporting import generate_modern_pdf_report


def generate_cest_pdf_report(
    analysis_dir: str,
    analysis_name: str,
    analysis_type: str = "CEST",
    style: str = "publication",
    chemex_image_digest: Optional[str] = None,
) -> io.BytesIO:
    """
    Generate a multi-page publication-quality PDF report for a CEST or CPMG analysis.
    """
    # Dynamically re-parse to ensure report uses latest format
    try:
        from .cest_tasks import _parse_chemex_output
        parsed = _parse_chemex_output(analysis_dir)
        if parsed and parsed.get("residues"):
            from datetime import datetime
            with open(os.path.join(analysis_dir, "results.json"), "w") as f:
                json.dump({
                    "analysis_uuid": os.path.basename(analysis_dir),
                    "timestamp": datetime.now().isoformat(),
                    "fit_mode": parsed.get("fit_mode", "global"),
                    **parsed
                }, f, indent=2)
    except Exception:
        pass

    return generate_modern_pdf_report(
        analysis_dir=analysis_dir,
        analysis_name=analysis_name,
        analysis_type=analysis_type,
        style=style,
        chemex_image_digest=chemex_image_digest,
    )
