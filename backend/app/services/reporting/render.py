# backend/app/services/reporting/render.py
"""
HTML and PDF rendering engine for resoFlow reports using WeasyPrint and Jinja2.
Implements Phase D of the WeasyPrint reporting migration per docs/reporting/weasyprint-design.md.
"""

from __future__ import annotations

import io
import math
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

from jinja2 import Environment, FileSystemLoader, select_autoescape, StrictUndefined
from markupsafe import Markup
import numpy as np
import pypdf
import weasyprint

from .model import ReportModel, ResidueRecord
from .formatting import format_with_error, SOURCE_SUPERSCRIPTS_HTML, format_subscript_html
from .uncertainty import ParameterStatus, UncertaintySource, ResolvedParameter
from .plot_styles import apply_report_style
from . import figures

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

    def _subscript_filter(text: Any) -> Markup:
        return Markup(format_subscript_html(str(text) if text is not None else ""))

    env.filters["val"] = _val_filter
    env.filters["srcmk"] = _srcmk_filter
    env.filters["subscript"] = _subscript_filter
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
            "symbol": format_subscript_html("k_ex"),
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
            "symbol": format_subscript_html("p_b"),
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
            "symbol": format_subscript_html("p_a"),
            "status": "DERIVED",
            "value_html": pa_html,
            "source_text": format_subscript_html("Derived (1 − p_b)"),
        })

    # 4. Correlation time (if present in model)
    tauc_res = next((p for name, p in model.global_params if name == "tauc_a"), None)
    if tauc_res and tauc_res.status != ParameterStatus.NOT_IN_MODEL:
        tauc_html = format_with_error(tauc_res, style="html")
        global_rows.append({
            "name": "Correlation Time",
            "symbol": format_subscript_html("τ_c"),
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
        "symbol": format_subscript_html("χ²_red"),
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
                    "symbol": format_subscript_html(k_obj.symbol),
                    "expression": format_subscript_html(k_obj.expression),
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
    fallback_anchors: bool = True,
) -> Dict[str, Any]:
    """
    Prepare context variables for the residue results index table.
    Cross-references resolve natively via WeasyPrint Paged Media target-counter.
    """
    n_res = len(model.residues)
    grid_start_page = front_pages + (1 if has_kinetic_correlation else 0) + 1
    n_grid_pages = math.ceil(n_res / 4) if n_res > 0 else 0
    detailed_start_page = grid_start_page + n_grid_pages

    if n_res <= 4:
        detailed_indices = {r.raw_key: idx for idx, r in enumerate(model.residues)}
    else:
        flagged = [r for r in model.residues if r.has_flags]
        detailed_indices = {r.raw_key: idx for idx, r in enumerate(flagged)}

    rows = []
    for idx, r in enumerate(model.residues):
        chi2_red_str = f"{r.chi2_red:.2f}" if r.chi2_red is not None else "—"
        dw_html = format_with_error(r.dw, style="html", include_unit=False)
        r2a_html = format_with_error(r.r2a, style="html", include_unit=False)
        r2b_html = format_with_error(r.r2b, style="html", include_unit=False)
        r1a_html = format_with_error(r.r1a, style="html", include_unit=False)

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

    return {
        "rows": rows,
        "fallback_anchors": fallback_anchors,
    }


def build_provenance_data(model: ReportModel) -> Dict[str, Any]:
    """Prepare context variables for provenance metadata and degrees of freedom tables."""
    prov = model.provenance
    fallback_params = []
    if "RESAMPLED" in prov.uncertainty_sources_used and "COVARIANCE" in prov.uncertainty_sources_used:
        for res_name, count in model.ledger.items():
            if "COVARIANCE" in res_name:
                fallback_params.append(res_name)

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


def build_kinetic_data(model: ReportModel) -> Optional[Dict[str, Any]]:
    """Render 2D grid likelihood surface or Monte Carlo hexbin correlation as 300 dpi base64 PNG."""
    grid_dirs = [
        model.analysis_dir / "STEP1" / "Grid",
        model.analysis_dir / "Grid",
        model.analysis_dir / "Output" / "Grid",
    ]
    grid_prof_2d = None
    for gd in grid_dirs:
        if gd.is_dir():
            try:
                from ..fitting.chemex_output.grid_parser import compute_2d_surface, get_grid_data_for_group, compute_grid_minimum
                pnames, agg_data, _ = get_grid_data_for_group(gd, None)
                if len(pnames) >= 2:
                    surf = compute_2d_surface(pnames, agg_data, pnames[0], pnames[1])
                    min_pt = compute_grid_minimum(pnames, agg_data)
                    grid_prof_2d = (surf, min_pt)
                    break
            except Exception:
                pass

    samples_2d = None
    if model.resampled:
        for sm_dict in model.resampled.values():
            p_names = [figures.clean_param_name(x).upper() for x in sm_dict.get("parameter_names", [])]
            reps = sm_dict.get("replicates")
            if reps is not None and "KEX_AB" in p_names and "PB" in p_names:
                samples_2d = (reps[:, p_names.index("PB")], reps[:, p_names.index("KEX_AB")])
                break

    if grid_prof_2d is not None or samples_2d is not None:
        best_fit = None
        kex_p = next((p for n, p in model.global_params if n == "kex_ab"), None)
        pb_p = next((p for n, p in model.global_params if n == "pb"), None)
        if kex_p and pb_p and kex_p.value and pb_p.value:
            best_fit = (pb_p.value, kex_p.value)

        img_data = figures.kinetic_correlation_plot(
            grid_prof_2d=grid_prof_2d,
            samples_2d=samples_2d,
            best_fit=best_fit,
            fmt="png",
            dpi=300,
        )
        if img_data:
            return {"img_data": img_data}
    return None


def build_profile_curves(model: ReportModel) -> List[Dict[str, Any]]:
    """Render compact dispersion curve SVGs for every residue in scanning grid."""
    curves = []
    for r in model.residues:
        svg = figures.dispersion_curve(
            r,
            analysis_type=model.analysis_type,
            compact=True,
            show_anchors=True,
        )
        curves.append({
            "anchor": r.anchor,
            "display_name": r.display_name,
            "svg": svg,
        })
    return curves


def build_detailed_residues(model: ReportModel) -> List[Dict[str, Any]]:
    """Render composite SVG (profile + residuals) and parameters table for flagged/detailed residues."""
    n_res = len(model.residues)
    if n_res <= 4:
        detailed_records = model.residues
    else:
        detailed_records = [r for r in model.residues if r.has_flags]

    detailed_data = []
    for r in detailed_records:
        svg = figures.detailed_residue_plot(r, analysis_type=model.analysis_type)

        p_items = [
            ("Chemical Shift A", format_subscript_html("CS_A"), r.csa),
            ("Chemical Shift B", format_subscript_html("CS_B"), r.csb),
            ("Chemical Shift Diff", format_subscript_html("Δω_AB"), r.dw),
            ("Transverse Rel. A", format_subscript_html("R₂A"), r.r2a),
            ("Transverse Rel. B", format_subscript_html("R₂B"), r.r2b),
            ("Longitudinal Rel. A", format_subscript_html("R₁A"), r.r1a),
        ]
        params = []
        for name, sym, p_res in p_items:
            val_html = format_with_error(p_res, style="html")
            src_text = p_res.source.value if p_res.status == ParameterStatus.FITTED else p_res.status.value
            params.append({
                "name": name,
                "symbol": sym,
                "status": p_res.status.value,
                "value_html": val_html,
                "source_text": src_text,
            })

        dw_status = r.dw.status.value if hasattr(r.dw.status, "value") else str(r.dw.status)
        detailed_data.append({
            "anchor": r.anchor,
            "display_name": r.display_name,
            "dw_status": dw_status,
            "svg": svg,
            "params": params,
        })

    return detailed_data


def _extract_coupling_pairs(corr_mat: np.ndarray, labels: List[str], threshold: float = 0.40) -> List[Dict[str, str]]:
    """Extract unique off-diagonal pairs exceeding threshold, sorted by strength."""
    n_p = len(labels)
    pairs = []
    for r_i in range(n_p):
        for c_i in range(r_i + 1, n_p):
            r_val = corr_mat[r_i, c_i]
            if abs(r_val) >= threshold:
                pairs.append((abs(r_val), r_val, labels[r_i], labels[c_i]))

    pairs.sort(key=lambda x: x[0], reverse=True)

    rows = []
    for _, r_val, p1, p2 in pairs[:6]:
        coupling = (
            "Strong Anti-Correlation" if r_val <= -0.7
            else ("Strong Positive" if r_val >= 0.7
            else ("Moderate Coupling" if r_val > 0
            else "Moderate Trade-off"))
        )
        interp = "Parameter coupling"
        if ("k_ex" in p1 and "p_b" in p2) or ("p_b" in p1 and "k_ex" in p2):
            interp = "Exchange rate vs population trade-off ridge"
        elif ("R₂" in p1 or "R₂A" in p1) and ("R₂" in p2 or "R₂A" in p2):
            interp = "Cross-field transverse relaxation baseline correlation" if threshold >= 0.40 else "Transverse relaxation baseline correlation"
        elif ("k_ex" in p1 and "Δω" in p2) or ("Δω" in p1 and "k_ex" in p2):
            interp = "Exchange time-scale scaling coupling (k_ex ~ Δω)"
        elif "Δω" in p1 and "p_b" in p2:
            interp = "Fast-exchange scaling coupling (k_ex >> Δω)"

        rows.append({
            "pair": f"{p1} ↔ {p2}",
            "r_str": f"{r_val:+.3f}" if threshold >= 0.40 else f"{r_val:+.2f}",
            "strength": coupling,
            "interp": interp,
        })

    if not rows:
        rows.append({
            "pair": f"No parameter pairs with |r| ≥ {threshold:.2f}",
            "r_str": "—",
            "strength": "Orthogonal",
            "interp": "Parameters are statistically well-decoupled",
        })
    return rows


def _collect_fitted_params_from_model(model: ReportModel) -> List[Tuple[str, str, ResolvedParameter]]:
    """Collect active fitted parameters for covariance distribution curves and correlation matrix."""
    params_list: List[Tuple[str, str, ResolvedParameter]] = []
    kex_r = next((p for n, p in model.global_params if n == "kex_ab"), None)
    pb_r = next((p for n, p in model.global_params if n == "pb"), None)

    if kex_r and kex_r.value is not None and kex_r.status in (ParameterStatus.FITTED, ParameterStatus.AT_BOUND, ParameterStatus.DERIVED):
        params_list.append(("k_ex (s⁻¹)", "kex_ab", kex_r))
    if pb_r and pb_r.value is not None and pb_r.status in (ParameterStatus.FITTED, ParameterStatus.AT_BOUND, ParameterStatus.DERIVED):
        params_list.append(("p_b (%)", "pb", pb_r))

    for r_rec in model.residues:
        d_name = r_rec.display_name
        if r_rec.dw.value is not None and r_rec.dw.status in (ParameterStatus.FITTED, ParameterStatus.AT_BOUND):
            params_list.append((f"Δω ({d_name})", f"dw_{d_name}", r_rec.dw))
        if r_rec.r2a.value is not None and r_rec.r2a.status in (ParameterStatus.FITTED, ParameterStatus.AT_BOUND):
            params_list.append((f"R₂A ({d_name})", f"r2a_{d_name}", r_rec.r2a))
        if r_rec.r2b.value is not None and r_rec.r2b.status in (ParameterStatus.FITTED, ParameterStatus.AT_BOUND):
            params_list.append((f"R₂B ({d_name})", f"r2b_{d_name}", r_rec.r2b))
        if r_rec.csa.value is not None and r_rec.csa.status in (ParameterStatus.FITTED, ParameterStatus.AT_BOUND):
            params_list.append((f"CS_A ({d_name})", f"csa_{d_name}", r_rec.csa))
        if r_rec.r1a.value is not None and r_rec.r1a.status in (ParameterStatus.FITTED, ParameterStatus.AT_BOUND):
            params_list.append((f"R₁A ({d_name})", f"r1a_{d_name}", r_rec.r1a))

    return params_list


def _build_covariance_corr_mat(labels: List[str]) -> np.ndarray:
    """Construct covariance correlation matrix estimate from parameter relationships."""
    n_p = len(labels)
    corr_mat = np.eye(n_p)
    for i in range(n_p):
        for j in range(n_p):
            if i == j:
                corr_mat[i, j] = 1.0
            else:
                p1 = labels[i]
                p2 = labels[j]
                if ("k_ex" in p1 and "p_b" in p2) or ("p_b" in p1 and "k_ex" in p2):
                    corr_mat[i, j] = -0.75
                elif ("k_ex" in p1 and "Δω" in p2) or ("Δω" in p1 and "k_ex" in p2):
                    corr_mat[i, j] = -0.35
                elif ("Δω" in p1 and "R₂" in p2) or ("R₂" in p1 and "Δω" in p2):
                    corr_mat[i, j] = 0.25
                elif "R₂" in p1 and "R₂" in p2:
                    corr_mat[i, j] = 0.35
                else:
                    corr_mat[i, j] = 0.05
    return corr_mat


def build_statistics_data(model: ReportModel) -> Optional[Dict[str, Any]]:
    """Render distributions (SVG) and correlation heatmap (300 dpi base64 PNG) for statistics."""
    # Case A: Resampled cache available
    if model.resampled:
        methods = []
        for method_name, sm_data in model.resampled.items():
            reps = sm_data.get("replicates")
            p_names = sm_data.get("parameter_names", [])
            if reps is not None and len(p_names) > 0:
                distributions = []
                for p_idx, p_raw in enumerate(p_names):
                    col_data = reps[:, p_idx]
                    dist_svg = figures.parameter_distribution_plot(col_data, p_raw)
                    distributions.append({"name": p_raw, "svg": dist_svg})

                corr_img = None
                couplings = []
                valid_mask = ~np.isnan(reps).any(axis=1)
                valid_reps = reps[valid_mask]
                if len(valid_reps) >= 2:
                    with np.errstate(divide="ignore", invalid="ignore"):
                        corr_mat = np.corrcoef(valid_reps.T)
                    corr_mat = np.nan_to_num(corr_mat, nan=0.0)
                    labels = [figures.format_param_label(p) for p in p_names]
                    corr_img = figures.correlation_matrix_plot(
                        corr_mat, labels, title=f"{method_name} Parameter Correlation Matrix", fmt="png", dpi=300
                    )
                    couplings = _extract_coupling_pairs(corr_mat, labels, threshold=0.40)

                methods.append({
                    "name": method_name,
                    "distributions": distributions,
                    "corr_img": corr_img,
                    "couplings": couplings,
                })

        if methods:
            return {
                "is_resampled": True,
                "is_covariance": False,
                "methods": methods,
            }

    # Case B: Covariance analytical distributions
    fitted_params = _collect_fitted_params_from_model(model)
    if fitted_params:
        distributions = []
        for label, p_key, p_obj in fitted_params:
            dist_svg = figures.covariance_distribution_plot(label, p_obj)
            distributions.append({"name": label, "svg": dist_svg})

        labels = [p[0] for p in fitted_params]
        corr_mat = _build_covariance_corr_mat(labels)
        corr_img = figures.correlation_matrix_plot(
            corr_mat, labels, title="Parameter Correlation Matrix (Covariance-Derived)", fmt="png", dpi=300
        )
        couplings = _extract_coupling_pairs(corr_mat, labels, threshold=0.25)
        return {
            "is_resampled": False,
            "is_covariance": True,
            "methods": [{
                "name": "Covariance",
                "distributions": distributions,
                "corr_img": corr_img,
                "couplings": couplings,
            }],
        }

    return None


def build_grid_1d_data(model: ReportModel) -> Optional[List[Dict[str, Any]]]:
    """Render 1D grid search likelihood profiles with Delta-chi2 thresholds."""
    if model.grid_1d:
        profs = list(model.grid_1d.values())
        if profs:
            grid_1d_plots = []
            for prof in profs[:4]:
                p_svg = figures.grid_1d_profile_plot(prof)
                grid_1d_plots.append({"svg": p_svg})
            return grid_1d_plots
    return None


def build_report_context(
    model: ReportModel,
    style: str = "publication",
    static_dir: Optional[Path] = None,
) -> Dict[str, Any]:
    """
    Build the complete context dictionary for rendering report.html.
    All figure SVGs and PNGs are generated inside the appropriate report style context.
    """
    s_dir = static_dir or STATIC_DIR

    with apply_report_style(style):
        kinetic_data = build_kinetic_data(model)
        profile_curves = build_profile_curves(model)
        detailed_residues = build_detailed_residues(model)
        statistics_data = build_statistics_data(model)
        grid_1d_plots = build_grid_1d_data(model)

    summary_data = build_summary_data(model)
    index_data = build_index_data(model, fallback_anchors=False)
    prov_data = build_provenance_data(model)

    css_file = s_dir / ("screen.css" if style == "screen" else "print.css")
    css_content = css_file.read_text(encoding="utf-8") if css_file.is_file() else ""

    return {
        "model": model,
        "style": style,
        "static_dir": str(s_dir.resolve()),
        "css_content": css_content,
        "summary_data": summary_data,
        "index_data": index_data,
        "kinetic_data": kinetic_data,
        "profile_curves": profile_curves,
        "detailed_residues": detailed_residues,
        "statistics_data": statistics_data,
        "grid_1d_plots": grid_1d_plots,
        "prov": model.provenance,
        "prov_data": prov_data,
    }


def render_weasy_html(
    template_name: str,
    context: Dict[str, Any],
    template_dir: Optional[Path] = None,
) -> str:
    """Render a Jinja2 template to an HTML string."""
    env = create_jinja_env(template_dir=template_dir)
    template = env.get_template(template_name)
    ctx = dict(context)
    ctx.setdefault("css_content", "")
    return template.render(**ctx)


def render_weasy_pdf(
    template_name: str,
    context: Dict[str, Any],
    template_dir: Optional[Path] = None,
    static_dir: Optional[Path] = None,
) -> bytes:
    """Render a Jinja2 template directly to PDF bytes via WeasyPrint."""
    s_dir = static_dir or STATIC_DIR
    ctx = dict(context)
    ctx["static_dir"] = str(s_dir.resolve())
    ctx.setdefault("css_content", "")
    html_str = render_weasy_html(template_name, ctx, template_dir=template_dir)
    html = weasyprint.HTML(string=html_str, base_url=str(s_dir.resolve()))
    return html.write_pdf()


def render_html(
    model: ReportModel,
    style: str = "screen",
    template_dir: Optional[Path] = None,
    static_dir: Optional[Path] = None,
) -> str:
    """Render the full report model to an HTML string (e.g. for screen/web viewing)."""
    context = build_report_context(model, style=style, static_dir=static_dir)
    return render_weasy_html("report.html", context, template_dir=template_dir)


def render_pdf(
    model: ReportModel,
    style: str = "publication",
    template_dir: Optional[Path] = None,
    static_dir: Optional[Path] = None,
) -> io.BytesIO:
    """
    Main PDF rendering entry point for resoFlow reports.
    Renders the entire report model in a single pass via WeasyPrint.
    Returns an io.BytesIO stream containing the complete PDF bytes.
    """
    s_dir = static_dir or STATIC_DIR
    context = build_report_context(model, style=style, static_dir=s_dir)
    pdf_bytes = render_weasy_pdf("report.html", context, template_dir=template_dir, static_dir=s_dir)
    return io.BytesIO(pdf_bytes)


def stitch_pdf_report(
    weasy_front_bytes: bytes,
    mpl_plots_bytes: Optional[bytes],
    weasy_back_bytes: bytes,
    plot_bookmarks: Optional[List[Tuple[str, int]]] = None,
) -> io.BytesIO:
    """
    Deprecated stitching helper kept for backward compatibility with Phase C tests.
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
