# backend/app/services/export/plot_export.py
"""
Export all publication plots for a resoFlow analysis in 300 DPI PNG and vector PDF formats.
Packages all residue profiles, residuals, kinetics, distributions, and 1D scans into a
structured, deterministic ZIP archive using the user-selected color palette.
"""

from __future__ import annotations

import io
import logging
import os
import re
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.gridspec import GridSpec
import numpy as np

from ..reporting import figures
from ..reporting.uncertainty import ParameterStatus
from ..reporting.model import ReportModel, ResidueRecord, StepReportModel, build_report_model
from ..reporting.plot_styles import apply_report_style, get_plot_palette, PALETTE_METADATA, OKABE_ITO

logger = logging.getLogger(__name__)

# Deterministic timestamp for archive file headers
DETERMINISTIC_DATETIME: Tuple[int, int, int, int, int, int] = (2026, 1, 1, 0, 0, 0)


def _safe_name(name: str) -> str:
    """Sanitize string for safe filenames."""
    s = re.sub(r"[^A-Za-z0-9_.-]", "_", name.strip())
    return s.strip("_") or "plot"


def _render_fig_to_png_and_pdf(fig: plt.Figure, dpi: int = 300) -> Tuple[bytes, bytes]:
    """Render figure to both 300 DPI PNG and vector PDF bytes, closing the figure."""
    buf_png = io.BytesIO()
    fig.savefig(buf_png, format="png", dpi=dpi, bbox_inches="tight")
    png_bytes = buf_png.getvalue()

    buf_pdf = io.BytesIO()
    fig.savefig(buf_pdf, format="pdf", bbox_inches="tight")
    pdf_bytes = buf_pdf.getvalue()

    plt.close(fig)
    return png_bytes, pdf_bytes


def _add_to_zip(
    zf: zipfile.ZipFile,
    rel_path: str,
    data: bytes,
    fixed_mtime: bool = True,
):
    """Add a file entry to the zip archive with deterministic timestamp."""
    zinfo = zipfile.ZipInfo(filename=rel_path)
    if fixed_mtime:
        zinfo.date_time = DETERMINISTIC_DATETIME
    else:
        now = datetime.now(timezone.utc)
        zinfo.date_time = (now.year, now.month, now.day, now.hour, now.minute, now.second)
    zinfo.compress_type = zipfile.ZIP_DEFLATED
    zinfo.external_attr = 0o644 << 16  # standard file permissions
    zf.writestr(zinfo, data)


def _render_residue_plots(
    r: ResidueRecord,
    analysis_type: str,
) -> Dict[str, Tuple[bytes, bytes]]:
    """
    Render detailed composite, dispersion curve, and residuals strip for a single residue.
    Returns mapping of suffix -> (png_bytes, pdf_bytes).
    """
    results: Dict[str, Tuple[bytes, bytes]] = {}

    # 1. Detailed composite figure (Profile + Residuals)
    try:
        fig = plt.figure(figsize=(6.4, 4.4))
        gs = GridSpec(nrows=2, ncols=1, height_ratios=[0.70, 0.30], figure=fig, hspace=0.25)
        ax_profile = fig.add_subplot(gs[0])
        ax_residual = fig.add_subplot(gs[1], sharex=ax_profile)

        figures._draw_dispersion_curve(ax_profile, r, analysis_type=analysis_type, show_anchors=True, compact=False)
        ax_profile.set_xlabel("")
        figures._draw_residuals_strip(ax_residual, r, analysis_type=analysis_type)
        results["detailed"] = _render_fig_to_png_and_pdf(fig, dpi=300)
    except Exception as e:
        logger.warning("Error rendering detailed plot for residue %s: %s", r.display_name, e)

    # 2. Standalone dispersion curve
    try:
        fig, ax = plt.subplots(figsize=(6.4, 3.4))
        figures._draw_dispersion_curve(ax, r, analysis_type=analysis_type, show_anchors=True, compact=False)
        results["dispersion"] = _render_fig_to_png_and_pdf(fig, dpi=300)
    except Exception as e:
        logger.warning("Error rendering dispersion plot for residue %s: %s", r.display_name, e)

    # 3. Standalone residuals strip
    try:
        fig, ax = plt.subplots(figsize=(6.4, 1.8))
        figures._draw_residuals_strip(ax, r, analysis_type=analysis_type)
        results["residuals"] = _render_fig_to_png_and_pdf(fig, dpi=300)
    except Exception as e:
        logger.warning("Error rendering residuals plot for residue %s: %s", r.display_name, e)

    return results


def _render_kinetic_correlation(
    item: Union[ReportModel, StepReportModel],
) -> Optional[Tuple[bytes, bytes]]:
    """Render 2D grid Chi2 confidence contour or joint posterior density."""
    grid_prof_2d = getattr(item, "grid_2d", None)
    if grid_prof_2d is None and hasattr(item, "analysis_dir") and item.analysis_dir:
        a_dir = Path(item.analysis_dir)
        step_name = getattr(item, "step_name", None)
        grid_dirs = []
        if step_name:
            grid_dirs.append(a_dir / step_name / "Grid")
            grid_dirs.append(a_dir / "Output" / step_name / "Grid")
        grid_dirs.extend([
            a_dir / "STEP1" / "Grid",
            a_dir / "Grid",
            a_dir / "Output" / "Grid",
        ])
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
    if getattr(item, "resampled", None):
        for sm_dict in item.resampled.values():
            p_names = [figures.clean_param_name(x).upper() for x in sm_dict.get("parameter_names", [])]
            reps = sm_dict.get("replicates")
            if reps is not None and "KEX_AB" in p_names and "PB" in p_names:
                samples_2d = (reps[:, p_names.index("PB")], reps[:, p_names.index("KEX_AB")])
                break

    if grid_prof_2d is not None or samples_2d is not None:
        best_fit = None
        kex_p = next((p for n, p in item.global_params if n == "kex_ab"), None)
        pb_p = next((p for n, p in item.global_params if n == "pb"), None)
        if kex_p and pb_p and kex_p.value and pb_p.value:
            best_fit = (pb_p.value, kex_p.value)

        try:
            fig, ax = plt.subplots(figsize=(6.4, 4.8))
            rendered = figures._draw_kinetic_correlation(
                ax, fig=fig, grid_prof_2d=grid_prof_2d, samples_2d=samples_2d, best_fit=best_fit
            )
            if rendered:
                return _render_fig_to_png_and_pdf(fig, dpi=300)
            plt.close(fig)
        except Exception as e:
            logger.warning("Error rendering kinetic correlation plot: %s", e)
    return None


def _render_statistics_plots(
    item: Union[ReportModel, StepReportModel],
) -> Dict[str, Tuple[bytes, bytes]]:
    """Render parameter error distribution histograms and correlation matrices."""
    results: Dict[str, Tuple[bytes, bytes]] = {}

    if getattr(item, "resampled", None):
        for method_key, sm_dict in item.resampled.items():
            method_label = method_key.replace("_", " ").title()
            p_names = sm_dict.get("parameter_names", [])
            reps = sm_dict.get("replicates")
            corr_mat = sm_dict.get("correlation_matrix")

            # Parameter distributions
            if reps is not None and len(p_names) > 0:
                for idx, p_raw in enumerate(p_names):
                    if idx < reps.shape[1]:
                        col_data = reps[:, idx]
                        try:
                            fig, ax = plt.subplots(figsize=(4.5, 3.2))
                            figures._draw_parameter_distribution(ax, col_data, str(p_raw))
                            p_clean = _safe_name(figures.clean_param_name(str(p_raw)).lower())
                            results[f"{p_clean}_distribution_{method_key}"] = _render_fig_to_png_and_pdf(fig, dpi=300)
                        except Exception as e:
                            logger.warning("Error rendering distribution for %s: %s", p_raw, e)

            # Correlation matrix
            if corr_mat is not None and len(p_names) > 1:
                try:
                    clean_labels = [figures.format_param_label(x) for x in p_names]
                    fig, ax = plt.subplots(figsize=(6.0, 5.0))
                    figures._draw_correlation_matrix(
                        ax, fig=fig, corr_mat=corr_mat, labels=clean_labels,
                        title=f"Parameter Correlation ({method_label})"
                    )
                    results[f"correlation_matrix_{method_key}"] = _render_fig_to_png_and_pdf(fig, dpi=300)
                except Exception as e:
                    logger.warning("Error rendering correlation matrix for %s: %s", method_key, e)

    elif getattr(item, "global_params", None):
        # Covariance fallback
        for name, p_obj in item.global_params:
            if p_obj.status == ParameterStatus.FITTED and p_obj.value is not None:
                try:
                    label = figures.format_param_label(name)
                    fig, ax = plt.subplots(figsize=(4.5, 2.5))
                    figures._draw_covariance_distribution(ax, label, p_obj)
                    p_clean = _safe_name(name.lower())
                    results[f"{p_clean}_covariance_interval"] = _render_fig_to_png_and_pdf(fig, dpi=300)
                except Exception as e:
                    logger.warning("Error rendering covariance interval for %s: %s", name, e)

    return results


def _render_grid_1d_plots(
    item: Union[ReportModel, StepReportModel],
) -> Dict[str, Tuple[bytes, bytes]]:
    """Render 1D Grid Search likelihood profiles."""
    results: Dict[str, Tuple[bytes, bytes]] = {}
    grid_dict = getattr(item, "grid_1d", None)
    if grid_dict:
        for p_key, prof in grid_dict.items():
            try:
                fig, ax = plt.subplots(figsize=(4.5, 3.2))
                figures._draw_1d_grid_profile(ax, prof)
                p_clean = _safe_name(figures.clean_param_name(str(p_key)).lower())
                results[f"{p_clean}_profile_1d"] = _render_fig_to_png_and_pdf(fig, dpi=300)
            except Exception as e:
                logger.warning("Error rendering 1D grid profile for %s: %s", p_key, e)
    return results


def export_all_plots_zip(
    analysis_dir: Union[str, Path, ReportModel],
    analysis_name: Optional[str] = None,
    analysis_type: str = "CEST",
    palette: Optional[str] = None,
    style: str = "publication",
    chemex_image_digest: Optional[str] = None,
    output_path: Optional[Union[str, Path]] = None,
) -> io.BytesIO:
    """
    Generate all publication plots in 300 DPI PNG and vector PDF formats using the active palette,
    packaged into a structured ZIP archive.
    """
    # 1. Resolve ReportModel
    if isinstance(analysis_dir, ReportModel):
        model = analysis_dir
    else:
        a_dir = Path(analysis_dir)
        a_name = analysis_name or a_dir.name
        model = build_report_model(
            analysis_dir=a_dir,
            analysis_name=a_name,
            analysis_type=analysis_type,
            chemex_image_digest=chemex_image_digest,
        )

    # 2. Setup palette metadata and archive root name
    active_palette_id = palette or "okabe_ito"
    palette_meta = next((p for p in PALETTE_METADATA if p["id"] == active_palette_id), None)
    palette_title = palette_meta["name"] if palette_meta else f"Custom ({active_palette_id})"

    clean_name = _safe_name(model.analysis_name).lower()
    short_uuid = model.analysis_dir.name[:8] if model.analysis_dir else "plots"
    root_folder = f"{clean_name}_{short_uuid}_plots_{_safe_name(active_palette_id)}"

    zip_buffer = io.BytesIO()
    total_plot_types = 0

    with zipfile.ZipFile(zip_buffer, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        # Wrap all matplotlib drawing in publication style and the requested palette
        with apply_report_style(style, palette=palette):

            # Helper to add both png and pdf
            def add_plot(category_path: str, base_name: str, pair: Tuple[bytes, bytes]):
                nonlocal total_plot_types
                png_bytes, pdf_bytes = pair
                zf_png_path = f"{root_folder}/png/{category_path}/{base_name}.png"
                zf_pdf_path = f"{root_folder}/pdf/{category_path}/{base_name}.pdf"
                _add_to_zip(zf, zf_png_path, png_bytes)
                _add_to_zip(zf, zf_pdf_path, pdf_bytes)
                total_plot_types += 1

            if model.is_multi_step and model.steps:
                for step_idx, step in enumerate(model.steps):
                    step_folder = f"step_{step_idx + 1}_{_safe_name(step.step_name)}"

                    # Residues
                    for r in step.residues:
                        r_name = _safe_name(r.display_name or r.raw_key)
                        res_plots = _render_residue_plots(r, model.analysis_type)
                        for suffix, pair in res_plots.items():
                            add_plot(f"{step_folder}/residues/{suffix}", r_name, pair)

                    # Kinetics
                    kin_pair = _render_kinetic_correlation(step)
                    if kin_pair:
                        add_plot(f"{step_folder}/kinetics", "kinetic_surface", kin_pair)

                    # Statistics
                    stat_plots = _render_statistics_plots(step)
                    for base_name, pair in stat_plots.items():
                        add_plot(f"{step_folder}/statistics", base_name, pair)

                    # 1D Grid
                    grid_plots = _render_grid_1d_plots(step)
                    for base_name, pair in grid_plots.items():
                        add_plot(f"{step_folder}/grid_1d", base_name, pair)
            else:
                # Single-step analysis
                for r in model.residues:
                    r_name = _safe_name(r.display_name or r.raw_key)
                    res_plots = _render_residue_plots(r, model.analysis_type)
                    for suffix, pair in res_plots.items():
                        add_plot(f"residues/{suffix}", r_name, pair)

                # Kinetics
                kin_pair = _render_kinetic_correlation(model)
                if kin_pair:
                    add_plot("kinetics", "kinetic_surface", kin_pair)

                # Statistics
                stat_plots = _render_statistics_plots(model)
                for base_name, pair in stat_plots.items():
                    add_plot("statistics", base_name, pair)

                # 1D Grid
                grid_plots = _render_grid_1d_plots(model)
                for base_name, pair in grid_plots.items():
                    add_plot("grid_1d", base_name, pair)

        # 3. Generate README.txt
        now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        analysis_id = model.analysis_dir.name if model.analysis_dir else "N/A"
        readme_text = f"""================================================================================
resoFlow - Publication Plots Export
================================================================================
Analysis Name   : {model.analysis_name}
Analysis ID     : {analysis_id}
Analysis Type   : {model.analysis_type}
Color Scheme    : {palette_title} ({active_palette_id})
Export Date     : {now_str}
resoFlow Version: {model.provenance.resoflow_version}
ChemEx Version  : {model.provenance.chemex_version}

CONTENTS & STRUCTURE:
--------------------------------------------------------------------------------
This archive contains publication-grade figures exported in two formats:
  - png/ : 300 DPI high-resolution raster images (ideal for slides, preprints, and web)
  - pdf/ : Publication-grade vector PDF figures (ideal for manuscript submissions)

DIRECTORY OVERVIEW:
  - residues/   : Dispersion profile curves, normalized residuals strips, and composite figures.
  - kinetics/   : 2D kinetic correlation likelihood surfaces and confidence contours.
  - statistics/ : Parameter marginal error distribution histograms and correlation matrices.
  - grid_1d/    : 1D parameter likelihood scanning profiles with 1-sigma and 2-sigma thresholds.

Total Unique Figures Exported: {total_plot_types} ({total_plot_types} PNGs + {total_plot_types} PDFs = {total_plot_types * 2} files)
================================================================================
"""
        _add_to_zip(zf, f"{root_folder}/README.txt", readme_text.encode("utf-8"))

    zip_buffer.seek(0)

    # If output path is requested, save to disk
    if output_path:
        out_p = Path(output_path)
        out_p.parent.mkdir(parents=True, exist_ok=True)
        with open(out_p, "wb") as f:
            f.write(zip_buffer.getvalue())
        zip_buffer.seek(0)

    return zip_buffer
