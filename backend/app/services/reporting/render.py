# backend/app/services/reporting/render.py
"""
HTML and PDF rendering engine for resoFlow reports using WeasyPrint and Jinja2.
Implements Phase C of the WeasyPrint reporting migration per docs/reporting/weasyprint-design.md.
"""

from __future__ import annotations

import io
import math
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

from jinja2 import Environment, FileSystemLoader, select_autoescape, StrictUndefined
from markupsafe import Markup
import pypdf
import weasyprint

from .model import ReportModel, ResidueRecord
from .formatting import format_with_error, SOURCE_SUPERSCRIPTS_HTML
from .uncertainty import ParameterStatus, UncertaintySource

TEMPLATE_DIR = Path(__file__).parent / "templates"
STATIC_DIR = Path(__file__).parent / "static"


def create_jinja_env(template_dir: Optional[Path] = None) -> Environment:
    """Instantiate strict Jinja2 environment with HTML autoescaping and domain filters."""
    t_dir = template_dir or TEMPLATE_DIR
    env = Environment(
        loader=FileSystemLoader(str(t_dir)),
        autoescape=select_autoescape(["html"]),
        undefined=StrictUndefined,
    )

    def _val_filter(p: Any) -> Markup:
        return Markup(format_with_error(p, style="html"))

    def _srcmk_filter(p: Any) -> Markup:
        if hasattr(p, "source"):
            s_val = p.source.value if hasattr(p.source, "value") else str(p.source)
            return Markup(SOURCE_SUPERSCRIPTS_HTML.get(s_val, ""))
        return Markup("")

    env.filters["val"] = _val_filter
    env.filters["srcmk"] = _srcmk_filter
    return env


def build_summary_data(model: ReportModel) -> Dict[str, Any]:
    """Prepare context variables for the executive summary table and derived kinetics."""
    global_rows = []

    # 1. Exchange rate
    kex_res = next((p for name, p in model.global_params if name == "kex_ab"), None)
    if kex_res:
        kex_html = format_with_error(kex_res, style="html")
        kex_src = kex_res.source.value if kex_res.status == ParameterStatus.FITTED else "—"
        global_rows.append({
            "name": "Exchange Rate",
            "symbol": "k_ex",
            "status": kex_res.status.value,
            "value_html": kex_html,
            "source_text": kex_src,
        })

    # 2. Excited state population
    pb_res = next((p for name, p in model.global_params if name == "pb"), None)
    if pb_res:
        pb_html = format_with_error(pb_res, style="html")
        pb_src = pb_res.source.value if pb_res.status == ParameterStatus.FITTED else "—"
        global_rows.append({
            "name": "Excited Population",
            "symbol": "p_b",
            "status": pb_res.status.value,
            "value_html": pb_html,
            "source_text": pb_src,
        })

        # 3. Major state population (derived 100 - pb)
        if pb_res.value is not None:
            pa_val = 100.0 - pb_res.value
            pa_html = f'<span class="v">{pa_val:.3f}</span> %'
        else:
            pa_html = "—"
        global_rows.append({
            "name": "Major State Pop.",
            "symbol": "p_a",
            "status": "DERIVED",
            "value_html": pa_html,
            "source_text": "Derived (1 − p_b)",
        })

    # 4. Correlation time (if present in model)
    tauc_res = next((p for name, p in model.global_params if name == "tauc_a"), None)
    if tauc_res and tauc_res.status != ParameterStatus.NOT_IN_MODEL:
        tauc_html = format_with_error(tauc_res, style="html")
        global_rows.append({
            "name": "Correlation Time",
            "symbol": "τ_c",
            "status": tauc_res.status.value,
            "value_html": tauc_html,
            "source_text": tauc_res.source.value,
        })

    # 5. Chi-square statistics
    dof_info = model.provenance.dof_accounting
    global_rows.append({
        "name": "Overall Chi-Square",
        "symbol": "χ²",
        "status": "STATISTIC",
        "value_html": f'<span class="v">{dof_info.chi2_global:.2f}</span>',
        "source_text": f"DOF = {dof_info.dof_global}",
    })
    global_rows.append({
        "name": "Reduced Chi-Square",
        "symbol": "χ²_red",
        "status": "STATISTIC",
        "value_html": f'<span class="v">{dof_info.chi2_red_global:.2f}</span>',
        "source_text": "Goodness of fit",
    })

    # 6. Derived Kinetics
    derived_rows = []
    if model.derived_kinetics:
        for k_key in ["kab", "kba", "tau_b", "tau_a"]:
            k_obj = model.derived_kinetics.get(k_key)
            if k_obj and k_obj.value is not None:
                val_html = format_with_error(k_obj.value, k_obj.err_low, k_obj.err_high, unit=k_obj.unit, source=k_obj.source.value, status="FITTED", style="html")
                derived_rows.append({
                    "name": k_obj.name.upper(),
                    "symbol": k_obj.symbol,
                    "expression": k_obj.expression,
                    "value_html": val_html,
                    "method": k_obj.propagation_method,
                })

    return {
        "global_rows": global_rows,
        "derived_rows": derived_rows,
    }


def build_index_data(
    model: ReportModel,
    front_pages: int = 2,
    has_kinetic_correlation: bool = False,
) -> Dict[str, Any]:
    """
    Prepare context variables for the residue results index table and target-counter anchor pagination.
    """
    n_res = len(model.residues)
    grid_start_page = front_pages + (1 if has_kinetic_correlation else 0) + 1
    n_grid_pages = math.ceil(n_res / 4) if n_res > 0 else 0
    detailed_start_page = grid_start_page + n_grid_pages

    # Determine which residues get detail pages in mpl_plots (Phase 5a/5b rule)
    if n_res <= 4:
        detailed_indices = {r.raw_key: idx for idx, r in enumerate(model.residues)}
    else:
        flagged = [r for r in model.residues if r.has_flags]
        detailed_indices = {r.raw_key: idx for idx, r in enumerate(flagged)}

    rows = []
    for idx, r in enumerate(model.residues):
        chi2_red_str = f"{r.chi2_red:.2f}" if r.chi2_red is not None else "—"
        dw_html = format_with_error(r.dw, style="html")
        r2a_html = format_with_error(r.r2a, style="html")
        r2b_html = format_with_error(r.r2b, style="html")
        r1a_html = format_with_error(r.r1a, style="html")

        # Determine target page for a.xref pagination
        if r.raw_key in detailed_indices:
            target_page = detailed_start_page + detailed_indices[r.raw_key]
        else:
            target_page = grid_start_page + (idx // 4)

        rows.append({
            "raw_key": r.raw_key,
            "anchor": r.anchor,
            "display_name": r.display_name,
            "chi2_red_str": chi2_red_str,
            "dw_html": dw_html,
            "r2a_html": r2a_html,
            "r2b_html": r2b_html,
            "r1a_html": r1a_html,
            "flags": r.flags,
            "target_page": target_page,
        })

    return {"rows": rows}


def build_provenance_data(model: ReportModel) -> Dict[str, Any]:
    """Prepare context variables for provenance metadata and degrees of freedom tables."""
    prov = model.provenance
    fallback_params = []
    if "RESAMPLED" in prov.uncertainty_sources_used and "COVARIANCE" in prov.uncertainty_sources_used:
        # Check for covariance fallbacks
        for res_name, count in model.ledger.items():
            if "COVARIANCE" in res_name:
                fallback_params.append(res_name)

    # Residue DOF pairs normalized
    norm_residue_dofs = []
    for r_name, r_dof in list(prov.dof_accounting.residue_dofs.items())[:24]:
        norm_residue_dofs.append({
            "name": r_name,
            "n_points": r_dof.get("ndata", r_dof.get("n_points", 0)),
            "n_local": r_dof.get("nvarys_local", r_dof.get("n_local", 0)),
            "dof": r_dof.get("dof", 0),
            "chi2": r_dof.get("chi2", 0.0),
            "chi2_red": r_dof.get("chi2_red", 0.0),
        })

    return {
        "fallback_params": fallback_params,
        "residue_dofs": norm_residue_dofs,
    }


def render_weasy_html(
    template_name: str,
    context: Dict[str, Any],
    template_dir: Optional[Path] = None,
) -> str:
    """Render a Jinja2 template to an HTML string."""
    env = create_jinja_env(template_dir=template_dir)
    template = env.get_template(template_name)
    return template.render(**context)


def render_weasy_pdf(
    template_name: str,
    context: Dict[str, Any],
    template_dir: Optional[Path] = None,
    static_dir: Optional[Path] = None,
) -> bytes:
    """Render a Jinja2 template directly to PDF bytes via WeasyPrint."""
    s_dir = static_dir or STATIC_DIR
    context["static_dir"] = str(s_dir.resolve())
    html_str = render_weasy_html(template_name, context, template_dir=template_dir)
    html = weasyprint.HTML(string=html_str, base_url=str(s_dir.resolve()))
    return html.write_pdf()


def stitch_pdf_report(
    weasy_front_bytes: bytes,
    mpl_plots_bytes: Optional[bytes],
    weasy_back_bytes: bytes,
    plot_bookmarks: Optional[List[Tuple[str, int]]] = None,
) -> io.BytesIO:
    """
    Merge WeasyPrint front matter, matplotlib middle plots, and WeasyPrint back matter
    into a unified publication-ready PDF using pypdf, preserving outlines and metadata.
    """
    writer = pypdf.PdfWriter()

    for chunk in (weasy_front_bytes, mpl_plots_bytes, weasy_back_bytes):
        if chunk:
            reader = pypdf.PdfReader(io.BytesIO(chunk))
            writer.append(reader)

    if plot_bookmarks:
        for title, page_idx in plot_bookmarks:
            if 0 <= page_idx < len(writer.pages):
                writer.add_outline_item(title, page_idx)

    buf = io.BytesIO()
    writer.write(buf)
    buf.seek(0)
    return buf

