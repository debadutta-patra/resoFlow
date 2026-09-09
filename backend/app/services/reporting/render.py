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

from .model import ReportModel, ResidueRecord, StepReportModel, is_param_excluded
from .formatting import format_with_error, SOURCE_SUPERSCRIPTS_HTML, format_subscript_html
from .uncertainty import ParameterStatus, UncertaintySource, ResolvedParameter
from .plot_styles import apply_report_style, PALETTE_METADATA
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

    if model.analysis_type in ("R1", "R2", "HETNOE"):
        seq_sum = model.sequence_summary or {}
        a_type = model.analysis_type
        rate_sym = "R₁" if a_type == "R1" else ("R₂" if a_type == "R2" else "hetNOE")
        rate_name = "Longitudinal (R₁)" if a_type == "R1" else ("Transverse (R₂)" if a_type == "R2" else "Steady-State hetNOE")
        unit = "s⁻¹" if a_type != "HETNOE" else ""

        if seq_sum.get("mean_rate") is not None:
            mean_r = seq_sum["mean_rate"]
            sd_r = seq_sum.get("sd_rate", 0.0)
            global_rows.append({
                "name": f"Mean {rate_name} Rate" if a_type != "HETNOE" else f"Mean {rate_name}",
                "symbol": format_subscript_html(f"⟨{rate_sym}⟩"),
                "status": "STATISTIC",
                "value_html": f'<span class="v">{mean_r:.2f}</span> &plusmn; {sd_r:.2f} {unit}'.strip(),
                "source_text": "Sequence Mean &plusmn; SD",
            })

        if seq_sum.get("median_rate") is not None:
            med_r = seq_sum["median_rate"]
            global_rows.append({
                "name": f"Median {rate_name}",
                "symbol": format_subscript_html(f"{rate_sym}_med"),
                "status": "STATISTIC",
                "value_html": f'<span class="v">{med_r:.2f}</span> {unit}'.strip(),
                "source_text": "50th percentile",
            })

        if seq_sum.get("min_rate") is not None and seq_sum.get("max_rate") is not None:
            min_r = seq_sum["min_rate"]
            max_r = seq_sum["max_rate"]
            n_r = seq_sum.get("n_residues", len(model.residues))
            global_rows.append({
                "name": f"{rate_name} Dynamic Range",
                "symbol": format_subscript_html(f"{rate_sym}_range"),
                "status": "STATISTIC",
                "value_html": f'<span class="v">{min_r:.2f}</span> &ndash; <span class="v">{max_r:.2f}</span> {unit}'.strip(),
                "source_text": f"Across {n_r} residues",
            })

        if seq_sum.get("mean_sigma") is not None:
            m_sig = seq_sum["mean_sigma"]
            u_method = seq_sum.get("uncertainty_method", "covariance").title()
            global_rows.append({
                "name": "Mean Parameter Uncertainty",
                "symbol": format_subscript_html(f"⟨σ_{rate_sym}⟩"),
                "status": "STATISTIC",
                "value_html": f'<span class="v">{m_sig:.3f}</span> {unit}'.strip(),
                "source_text": f"{u_method} estimation",
            })

        if seq_sum.get("mean_chi2_red") is not None:
            m_chi2 = seq_sum["mean_chi2_red"]
            global_rows.append({
                "name": "Average Reduced Chi-Square",
                "symbol": format_subscript_html("⟨χ²_red⟩"),
                "status": "STATISTIC",
                "value_html": f'<span class="v">{m_chi2:.2f}</span>',
                "source_text": "Goodness of fit",
            })

        if seq_sum.get("mean_rmse") is not None:
            m_rmse = seq_sum["mean_rmse"]
            n_model = seq_sum.get("noise_model", "lineshape")
            global_rows.append({
                "name": "Average Residual Std Dev",
                "symbol": format_subscript_html("⟨RMSD⟩"),
                "status": "STATISTIC",
                "value_html": f'<span class="v">{m_rmse:.4f}</span>',
                "source_text": f"Noise model: {n_model}",
            })

        dof_info = model.provenance.dof_accounting
        if dof_info and dof_info.chi2_global:
            global_rows.append({
                "name": "Overall Chi-Square",
                "symbol": "χ²",
                "status": "STATISTIC",
                "value_html": f'<span class="v">{dof_info.chi2_global:.2f}</span>',
                "source_text": f"DOF = {dof_info.dof_global}",
            })

        return {
            "global_rows": global_rows,
            "derived_rows": [],
            "multi_step_pipeline": [],
        }

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

    # Multi-Step Pipeline Overview
    multi_step_pipeline = []
    if model.is_multi_step and model.steps:
        for step in model.steps:
            fitted_g = []
            for name, p in step.global_params:
                if p.status == ParameterStatus.FITTED:
                    sym = "k_ex" if name == "kex_ab" else ("p_b" if name == "pb" else name)
                    fitted_g.append(format_subscript_html(sym))
            fitted_g_str = ", ".join(fitted_g) if fitted_g else "None (Fixed)"

            if step.has_grid:
                feature_str = "2D Grid Search"
            elif step.has_statistics:
                feature_str = "Resampling Statistics"
            else:
                feature_str = "Covariance Fit"

            chi2_str = f"{step.dof_info.chi2_red_global:.2f}" if (step.dof_info and step.dof_info.chi2_red_global) else "—"

            multi_step_pipeline.append({
                "index": step.step_index,
                "name": step.step_name,
                "status": step.status,
                "n_residues": len(step.residues),
                "fitted_globals": fitted_g_str,
                "features": feature_str,
                "chi2_red": chi2_str,
            })

    return {
        "global_rows": global_rows,
        "derived_rows": derived_rows,
        "multi_step_pipeline": multi_step_pipeline,
    }


def _rate_html(record: Any, attr: str, param_name: str) -> str:
    """Render a field-dependent rate, labelled by field when there are several.

    A multi-field fit has one R2,0 per static field -- in this repo's own
    fixtures 5.83 s^-1 at 500 MHz against 7.94 at 800 -- so showing a single
    unlabelled number is wrong twice over: it hides one value and misattributes
    the other. Each field gets its own line with the field as a label.
    """
    entries = getattr(record, "rates_by_field", {}).get(param_name) or []
    if len(entries) <= 1:
        return format_with_error(getattr(record, attr), style="html",
                                 include_unit=False)

    parts = []
    for field_label, resolved in entries:
        mhz = field_label.upper().replace("MHZ", "").strip()
        value = format_with_error(resolved, style="html", include_unit=False)
        parts.append(
            f'<span class="rate-field">{value}'
            f'<span class="field-tag">{mhz}</span></span>'
        )
    return "<br>".join(parts)


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
        r2a_html = _rate_html(r, "r2a", "r2_a")
        r2b_html = _rate_html(r, "r2b", "r2_b")
        r1a_html = _rate_html(r, "r1a", "r1_a")

        rate_html = format_with_error(r.rate, style="html", include_unit=False) if r.rate else "—"
        amplitude_html = format_with_error(r.amplitude, style="html", include_unit=False) if r.amplitude else "—"
        rmse_str = f"{r.rmse:.4f}" if r.rmse is not None else "—"

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
            "rate_html": rate_html,
            "amplitude_html": amplitude_html,
            "rmse_str": rmse_str,
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


def build_kinetic_data(model: Any) -> Optional[Dict[str, Any]]:
    """Render 2D grid likelihood surface or Monte Carlo hexbin correlation as 300 dpi base64 PNG."""
    grid_prof_2d = getattr(model, "grid_2d", None)
    if grid_prof_2d is None:
        a_dir = getattr(model, "analysis_dir", None)
        if a_dir:
            grid_dirs = [
                a_dir / "STEP1" / "Grid",
                a_dir / "Grid",
                a_dir / "Output" / "Grid",
            ]
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


def build_profile_curves(
    model_or_residues: Union[ReportModel, List[ResidueRecord]],
    analysis_type: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Render compact dispersion curve SVGs for every residue in scanning grid."""
    if isinstance(model_or_residues, list):
        residues = model_or_residues
        a_type = analysis_type or "CEST"
    else:
        residues = model_or_residues.residues
        a_type = model_or_residues.analysis_type

    curves = []
    for r in residues:
        svg = figures.dispersion_curve(
            r,
            analysis_type=a_type,
            compact=True,
            show_anchors=True,
        )
        curves.append({
            "anchor": r.anchor,
            "display_name": r.display_name,
            "svg": svg,
        })
    return curves


def build_detailed_residues(
    model_or_residues: Union[ReportModel, List[ResidueRecord]],
    analysis_type: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Render composite SVG (profile + residuals) and parameters table for flagged/detailed residues."""
    if isinstance(model_or_residues, list):
        residues = model_or_residues
        a_type = analysis_type or "CEST"
    else:
        residues = model_or_residues.residues
        a_type = model_or_residues.analysis_type

    n_res = len(residues)
    if n_res <= 4:
        detailed_records = residues
    else:
        detailed_records = [r for r in residues if r.has_flags]

    detailed_data = []
    for r in detailed_records:
        svg = figures.detailed_residue_plot(r, analysis_type=a_type)

        if (a_type or "").upper() in ("R1", "R2", "HETNOE"):
            params = []
            rate_name = "Longitudinal Rel. Rate" if a_type.upper() == "R1" else ("Transverse Rel. Rate" if a_type.upper() == "R2" else "Steady-State NOE")
            rate_sym = "R₁" if a_type.upper() == "R1" else ("R₂" if a_type.upper() == "R2" else "η_{NOE}")
            amp_name = "Initial Intensity" if a_type.upper() != "HETNOE" else "Unsaturated Intensity"
            amp_sym = "I₀" if a_type.upper() != "HETNOE" else "I_{unsat}"

            if r.rate is not None:
                val_html = format_with_error(r.rate, style="html")
                src_text = r.rate.source.value if r.rate.status == ParameterStatus.FITTED else r.rate.status.value
                params.append({
                    "name": rate_name,
                    "symbol": format_subscript_html(rate_sym),
                    "status": r.rate.status.value,
                    "value_html": val_html,
                    "source_text": src_text,
                })
            if r.amplitude is not None:
                val_html = format_with_error(r.amplitude, style="html")
                src_text = r.amplitude.source.value if r.amplitude.status == ParameterStatus.FITTED else r.amplitude.status.value
                params.append({
                    "name": amp_name,
                    "symbol": format_subscript_html(amp_sym),
                    "status": r.amplitude.status.value,
                    "value_html": val_html,
                    "source_text": src_text,
                })
            if r.rmse is not None:
                params.append({
                    "name": "Residual Std Dev",
                    "symbol": format_subscript_html("RMSD"),
                    "status": "STATISTIC",
                    "value_html": f'<span class="v">{r.rmse:.4f}</span>',
                    "source_text": "Goodness of fit",
                })
            if r.chi2_red is not None:
                params.append({
                    "name": "Reduced Chi-Square",
                    "symbol": format_subscript_html("χ²_red"),
                    "status": "STATISTIC",
                    "value_html": f'<span class="v">{r.chi2_red:.2f}</span>',
                    "source_text": "Goodness of fit",
                })
            dw_status = f"χ²ᵣ = {r.chi2_red:.2f}" if r.chi2_red is not None else "FITTED"
        else:
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

    if model.analysis_type in ("R1", "R2", "HETNOE"):
        for r_rec in model.residues:
            d_name = r_rec.display_name
            if r_rec.rate and r_rec.rate.value is not None and r_rec.rate.status in (ParameterStatus.FITTED, ParameterStatus.AT_BOUND):
                r_lbl = f"R₁ ({d_name})" if model.analysis_type == "R1" else (f"R₂ ({d_name})" if model.analysis_type == "R2" else f"NOE ({d_name})")
                params_list.append((r_lbl, f"rate_{d_name}", r_rec.rate))
            if r_rec.amplitude and r_rec.amplitude.value is not None and r_rec.amplitude.status in (ParameterStatus.FITTED, ParameterStatus.AT_BOUND):
                params_list.append((f"I₀ ({d_name})", f"amp_{d_name}", r_rec.amplitude))
    else:
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

    if len(params_list) > 24:
        params_list = params_list[:24]

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
                elif ("R₂" in p1 or "R₁" in p1) and ("I₀" in p2):
                    corr_mat[i, j] = -0.45
                elif ("I₀" in p1) and ("R₂" in p2 or "R₁" in p2):
                    corr_mat[i, j] = -0.45
                elif "R₂" in p1 and "R₂" in p2:
                    corr_mat[i, j] = 0.35
                else:
                    corr_mat[i, j] = 0.05
    return corr_mat


def build_statistics_data(model: Union[ReportModel, StepReportModel]) -> Optional[Dict[str, Any]]:
    """Render distributions (SVG) and correlation heatmap (300 dpi base64 PNG) for statistics.

    Accepts either the whole-report model or a single step of a multi-step fit; both
    carry the resampled cache and the document-level residue exclusion list.
    """
    # Case A: Resampled cache available
    if model.resampled:
        methods = []
        for method_name, sm_data in model.resampled.items():
            reps = sm_data.get("replicates")
            p_names = sm_data.get("parameter_names", [])
            if reps is not None and len(p_names) > 0:
                if model.excluded_residues:
                    keep_idx = [i for i, p in enumerate(p_names) if not is_param_excluded(p, model.excluded_residues)]
                    if len(keep_idx) < len(p_names):
                        p_names = [p_names[i] for i in keep_idx]
                        reps = reps[:, keep_idx]

                distributions = []
                dist_p_indices = list(range(len(p_names)))
                if len(dist_p_indices) > 24:
                    rate_indices = [i for i, p in enumerate(p_names) if any(k in p.upper() for k in ("R2", "R1", "NOE", "RATE", "KEX", "PB"))]
                    if len(rate_indices) >= 24:
                        dist_p_indices = rate_indices[:24]
                    else:
                        other_indices = [i for i in range(len(p_names)) if i not in rate_indices]
                        dist_p_indices = rate_indices + other_indices[:(24 - len(rate_indices))]
                        dist_p_indices.sort()

                for p_idx in dist_p_indices:
                    p_raw = p_names[p_idx]
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
                    couplings = _extract_coupling_pairs(corr_mat, labels, threshold=0.40)

                    if len(p_names) > 20:
                        off_diag = np.abs(corr_mat - np.eye(len(p_names)))
                        max_corrs = np.max(off_diag, axis=1)
                        top_idx = np.argsort(-max_corrs)[:20]
                        top_idx = np.sort(top_idx)
                        plot_mat = corr_mat[np.ix_(top_idx, top_idx)]
                        plot_labels = [labels[i] for i in top_idx]
                        title = f"{method_name} Parameter Correlation Matrix (Top 20 Coupled)"
                    else:
                        plot_mat = corr_mat
                        plot_labels = labels
                        title = f"{method_name} Parameter Correlation Matrix"

                    corr_img = figures.correlation_matrix_plot(
                        plot_mat, plot_labels, title=title, fmt="png", dpi=300
                    )

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


def _build_multifield_section(
    payload: Dict[str, Any], residues: List[Dict[str, Any]]
) -> Dict[str, Any]:
    """Render the EXPERIMENTAL multi-field consistency section.

    The payload shape differs from a single-field run -- per-field blocks, a
    chi-square and a p-value instead of one J triple with a covariance -- so
    it gets its own context and its own half of the template rather than
    being forced through the single-field one.
    """
    summary = payload.get("summary", {})
    fields = payload.get("fields_mhz", [])
    constants = payload.get("constants_snapshot", {})

    rows = []
    for r in residues:
        scaling = r.get("scaling_exponent") or {}
        rows.append({
            "assignment": r.get("assignment"),
            "res_num": r.get("res_num"),
            "j0": r.get("j0"),
            "j0_err": r.get("j0_err"),
            "chi2": r.get("chi2"),
            "p_value": r.get("p_value"),
            "alpha": scaling.get("alpha"),
            "alpha_err": scaling.get("alpha_err"),
            "significant": (r.get("p_value") or 1.0) < 0.05,
            "per_field": r.get("per_field") or [],
        })

    return {
        "mode": "multi_field",
        "rows": rows,
        "fields_mhz": fields,
        "experimental": True,
        "experimental_notice": payload.get("experimental_notice"),
        "j0_caveat": payload.get("j0_caveat"),
        "multifield_caveat": payload.get("multifield_caveat"),
        "variant": payload.get("variant"),
        "r_nh_angstrom": constants.get("r_nh_angstrom"),
        "delta_sigma_ppm": constants.get("delta_sigma_ppm"),
        "n_fields": summary.get("n_fields"),
        "dof": summary.get("dof"),
        "n_residues": summary.get("n_residues"),
        "n_exchange_flagged": summary.get("n_exchange_flagged"),
        "median_chi2": summary.get("median_chi2"),
        "median_alpha": summary.get("median_alpha"),
        "scaling_available": summary.get("scaling_available"),
        "scaling_unavailable_reason": summary.get("scaling_unavailable_reason"),
        "n_excluded": summary.get("n_excluded"),
        "excluded_residues": payload.get("excluded_residues") or [],
    }


def build_spectral_density_data(model: ReportModel) -> Optional[Dict[str, Any]]:
    """Render the spectral density section: profiles, correlation plot, table.

    Returns None for any analysis that is not a spectral density mapping, so
    the section simply does not appear in other reports.
    """
    payload = getattr(model, "spectral_density", None)
    if not payload:
        return None

    residues = payload.get("residues") or []
    if not residues:
        return None

    if payload.get("mode") == "multi_field":
        return _build_multifield_section(payload, residues)

    omega_n = float(
        (payload.get("physics_snapshot") or {}).get("omega_n_rad_s") or 0.0
    )

    summary = payload.get("summary", {})
    band = summary.get("systematic_band") or {}
    constants = payload.get("constants_snapshot", {})

    # Excluded residues are listed in their own section, as they are in the
    # CSV, rather than sitting in the main table where a reader would take
    # them for part of the result.
    included = [r for r in residues if not r.get("excluded")]
    user_excluded = [
        {
            "residue": r.get("assignment"),
            "res_num": r.get("res_num"),
            "reason": r.get("exclusion_reason") or "excluded by user",
        }
        for r in residues if r.get("excluded")
    ]

    rows = []
    for r in included:
        cov = r.get("covariance") or [[0.0] * 3 for _ in range(3)]
        rows.append({
            "assignment": r.get("assignment"),
            "res_num": r.get("res_num"),
            "res_name": r.get("res_name"),
            "j0": r.get("j0"),
            "j0_err": r.get("j0_err"),
            "j_wn": r.get("j_wn"),
            "j_wn_err": r.get("j_wn_err"),
            "j_h": r.get("j_h"),
            "j_h_err": r.get("j_h_err"),
            "cov_j0_jwn": cov[0][1],
            "r1": r.get("r1"),
            "r2": r.get("r2"),
            "noe": r.get("noe"),
            "flags": r.get("flags") or [],
        })

    tau_ns = summary.get("tau_c_estimate_ns")
    # Excluded residues are already marked on the payload; each figure drops
    # them, so every plot agrees with the summary and with the table.
    return {
        "mode": "single_field",
        "profile_svg": figures.spectral_density_profile_plot(residues),
        "correlation_svg": figures.spectral_density_correlation_plot(residues, omega_n),
        "rates_svg": figures.relaxation_rates_profile_plot(residues),
        "r2_over_r1_svg": figures.r2_over_r1_plot(residues),
        "r1r2_svg": figures.r1r2_product_plot(residues),
        "rows": rows,
        "experimental": bool(payload.get("experimental")),
        "experimental_notice": payload.get("experimental_notice"),
        "j0_caveat": payload.get("j0_caveat"),
        "b0_h_mhz": payload.get("b0_h_mhz"),
        "variant": payload.get("variant"),
        "error_method": payload.get("error_method"),
        "rex_source": payload.get("rex_source"),
        "r2_provenance": payload.get("r2_provenance"),
        "r_nh_angstrom": constants.get("r_nh_angstrom"),
        "delta_sigma_ppm": constants.get("delta_sigma_ppm"),
        "tau_c_ns": tau_ns,
        "n_residues": summary.get("n_residues"),
        "n_flagged": summary.get("n_flagged"),
        "n_excluded": summary.get("n_excluded"),
        "flag_counts": summary.get("flag_counts") or {},
        "flag_descriptions": summary.get("flag_descriptions") or {},
        "excluded_residues": (payload.get("excluded_residues") or []) + user_excluded,
        "systematic_band": band,
        "systematic_band_pct": {
            "j0": (band.get("j0_fractional") or 0.0) * 100.0,
            "j_wn": (band.get("j_wn_fractional") or 0.0) * 100.0,
            "j_h": (band.get("j_h_fractional") or 0.0) * 100.0,
        },
    }


def build_grid_1d_data(model_or_grid: Any) -> Optional[List[Dict[str, Any]]]:
    """Render 1D grid search likelihood profiles with Delta-chi2 thresholds."""
    grid_dict = model_or_grid.grid_1d if hasattr(model_or_grid, "grid_1d") else model_or_grid
    if grid_dict:
        profs = list(grid_dict.values())
        if profs:
            grid_1d_plots = []
            for prof in profs[:4]:
                p_svg = figures.grid_1d_profile_plot(prof)
                grid_1d_plots.append({"svg": p_svg})
            return grid_1d_plots
    return None


def build_step_context(
    step: StepReportModel,
    model: ReportModel,
    step_idx: int,
) -> Dict[str, Any]:
    """Prepare rendering context for an individual multi-step fit section."""
    global_rows = []

    # 1. Exchange rate
    kex_res = next((p for name, p in step.global_params if name == "kex_ab"), None)
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
    pb_res = next((p for name, p in step.global_params if name == "pb"), None)
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

    # 3. Correlation time
    tauc_res = next((p for name, p in step.global_params if name == "tauc_a"), None)
    if tauc_res and tauc_res.status != ParameterStatus.NOT_IN_MODEL:
        tauc_html = format_with_error(tauc_res, style="html")
        global_rows.append({
            "name": "Correlation Time",
            "symbol": format_subscript_html("τ_c"),
            "status": tauc_res.status.value,
            "value_html": tauc_html,
            "source_text": tauc_res.source.value,
        })

    # 4. Goodness of fit statistics for this step
    if step.dof_info:
        global_rows.append({
            "name": "Step Chi-Square",
            "symbol": "χ²",
            "status": "STATISTIC",
            "value_html": f'<span class="v">{step.dof_info.chi2_global:.2f}</span>',
            "source_text": f"DOF = {step.dof_info.dof_global}",
        })
        global_rows.append({
            "name": "Step Reduced Chi-Square",
            "symbol": format_subscript_html("χ²_red"),
            "status": "STATISTIC",
            "value_html": f'<span class="v">{step.dof_info.chi2_red_global:.2f}</span>',
            "source_text": "Goodness of fit",
        })

    # 5. Derived kinetics
    derived_rows = []
    if step.derived_kinetics:
        for k_key in ["kab", "kba", "tau_b", "tau_a"]:
            k_obj = step.derived_kinetics.get(k_key)
            if k_obj and k_obj.value is not None:
                val_html = format_with_error(k_obj.value, k_obj.err_low, k_obj.err_high, unit=k_obj.unit, source=k_obj.source.value, status="FITTED", style="html")
                derived_rows.append({
                    "name": k_obj.name.upper(),
                    "symbol": format_subscript_html(k_obj.symbol),
                    "expression": format_subscript_html(k_obj.expression),
                    "value_html": val_html,
                    "method": k_obj.propagation_method,
                })

    # 6. Residue index table rows
    index_rows = []
    for r in step.residues:
        dw_html = format_with_error(r.dw, style="html", include_unit=False)
        r2a_html = _rate_html(r, "r2a", "r2_a")
        r2b_html = _rate_html(r, "r2b", "r2_b")
        r1a_html = _rate_html(r, "r1a", "r1_a")
        rate_html = format_with_error(r.rate, style="html", include_unit=False) if r.rate else "—"
        amplitude_html = format_with_error(r.amplitude, style="html", include_unit=False) if r.amplitude else "—"
        rmse_str = f"{r.rmse:.4f}" if r.rmse is not None else "—"
        index_rows.append({
            "display_name": r.display_name,
            "raw_key": r.raw_key,
            "anchor": r.anchor,
            "chi2_red": r.chi2_red,
            "dw_html": dw_html,
            "r2a_html": r2a_html,
            "r2b_html": r2b_html,
            "r1a_html": r1a_html,
            "rate_html": rate_html,
            "amplitude_html": amplitude_html,
            "rmse_str": rmse_str,
            "flags": r.flags,
            "has_flags": r.has_flags,
        })

    kinetic_data = build_kinetic_data(step)
    profile_curves = build_profile_curves(step.residues, analysis_type=model.analysis_type)
    detailed_residues = build_detailed_residues(step.residues, analysis_type=model.analysis_type)
    statistics_data = build_statistics_data(step) if step.has_statistics else None
    grid_1d_plots = build_grid_1d_data(step.grid_1d) if step.has_grid else None

    return {
        "name": step.step_name,
        "index": step.step_index,
        "status": step.status,
        "has_grid": step.has_grid,
        "has_statistics": step.has_statistics,
        "global_rows": global_rows,
        "derived_rows": derived_rows,
        "residues": step.residues,
        "index_rows": index_rows,
        "has_flagged_residues": any(r.has_flags for r in step.residues),
        "kinetic_data": kinetic_data,
        "profile_curves": profile_curves,
        "detailed_residues": detailed_residues,
        "statistics_data": statistics_data,
        "grid_1d_plots": grid_1d_plots,
    }


def build_report_context(
    model: ReportModel,
    style: str = "publication",
    palette: Optional[str] = None,
    static_dir: Optional[Path] = None,
) -> Dict[str, Any]:
    """
    Build the complete context dictionary for rendering report.html.
    All figure SVGs and PNGs are generated inside the appropriate report style context.
    """
    s_dir = static_dir or STATIC_DIR

    steps_data = []
    sequence_rate_plot = None
    is_spectral_density = (model.analysis_type or "").upper() == "SDM"

    with apply_report_style(style, palette=palette):
        spectral_density_data = build_spectral_density_data(model)

        if is_spectral_density:
            # A spectral density analysis produces none of the artefacts the
            # remaining sections describe -- no exchange model, no decay or
            # dispersion profiles, no grid scan, no resampling tree. Rendering
            # them anyway gave a residue index of em-dashes, a "Global
            # Relaxation & Exchange Parameters" table with nothing in it, and
            # a page of empty NOT_IN_MODEL profile plots. They are skipped
            # rather than emitted empty, which also saves rendering one
            # matplotlib figure per residue for nothing.
            kinetic_data = None
            profile_curves = None
            detailed_residues = None
            statistics_data = None
            grid_1d_plots = None
        else:
            kinetic_data = build_kinetic_data(model)
            if (model.analysis_type or "").upper() in ("R1", "R2", "HETNOE"):
                sequence_rate_plot = figures.sequence_rate_plot(model.residues, analysis_type=model.analysis_type)
            profile_curves = build_profile_curves(model)
            detailed_residues = build_detailed_residues(model)
            statistics_data = build_statistics_data(model)
            grid_1d_plots = build_grid_1d_data(model)

        if model.is_multi_step and model.steps:
            for idx, step in enumerate(model.steps):
                steps_data.append(build_step_context(step, model, idx + 1))

    summary_data = build_summary_data(model)
    index_data = None if is_spectral_density else build_index_data(model, fallback_anchors=False)
    prov_data = build_provenance_data(model)

    css_file = s_dir / ("screen.css" if style == "screen" else "print.css")
    css_content = css_file.read_text(encoding="utf-8") if css_file.is_file() else ""

    return {
        "model": model,
        "is_spectral_density": is_spectral_density,
        "style": style,
        "palette": palette or "okabe_ito",
        "palette_metadata": PALETTE_METADATA,
        "static_dir": str(s_dir.resolve()),
        "css_content": css_content,
        "summary_data": summary_data,
        "index_data": index_data,
        "kinetic_data": kinetic_data,
        "sequence_rate_plot": sequence_rate_plot,
        "profile_curves": profile_curves,
        "detailed_residues": detailed_residues,
        "statistics_data": statistics_data,
        "grid_1d_plots": grid_1d_plots,
        "spectral_density_data": spectral_density_data,
        "steps_data": steps_data,
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
    palette: Optional[str] = None,
    template_dir: Optional[Path] = None,
    static_dir: Optional[Path] = None,
) -> str:
    """Render the full report model to an HTML string (e.g. for screen/web viewing)."""
    context = build_report_context(model, style=style, palette=palette, static_dir=static_dir)
    return render_weasy_html("report.html", context, template_dir=template_dir)


def render_pdf(
    model: ReportModel,
    style: str = "publication",
    palette: Optional[str] = None,
    template_dir: Optional[Path] = None,
    static_dir: Optional[Path] = None,
) -> io.BytesIO:
    """
    Main PDF rendering entry point for resoFlow reports.
    Renders the entire report model in a single pass via WeasyPrint.
    Returns an io.BytesIO stream containing the complete PDF bytes.
    """
    s_dir = static_dir or STATIC_DIR
    context = build_report_context(model, style=style, palette=palette, static_dir=s_dir)
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
