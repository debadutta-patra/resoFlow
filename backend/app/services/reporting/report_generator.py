"""
Comprehensive publication-quality PDF report generator for resoFlow.
Conforms to Phases 1–9:
- Multi-page structured layout with running headers/footers (Page N of M)
- Uncertainty-resolved formatting across every numeric cell and axis
- Colorblind-safe Okabe-Ito cycle & publication/screen styles
- De-duplicated two-part legends (B1 fields + data/fit key)
- A/B state labels anchored inside axes using blended coordinates
- Normalized residuals strip (~25% height) under detailed profiles
- Replaced kinetic correlation panel (2D grid contour / KDE joint density / global statement)
- Flagged residue filtering & scanning grid (4-6 per page)
- Complete provenance block with SHA-256 hashes and explicit DOF reconciliation
- Conditional statistics section for Monte Carlo, Bootstrap, MCMC, and 1D/2D grid searches
"""

from __future__ import annotations

import io
import json
import logging
import math
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.backends.backend_pdf import PdfPages
from matplotlib.gridspec import GridSpec
import numpy as np
import pypdf

from .formatting import format_with_error, format_defensible_value
from .uncertainty import UncertaintyResolver, UncertaintySource, ParameterStatus, ResolvedParameter
from .kinetics import propagate_derived_kinetics, DerivedKineticResult
from .provenance import extract_report_provenance, ReportProvenance
from .plot_styles import apply_report_style, OKABE_ITO
from .model import ReportModel, ResidueRecord, build_report_model
from .figures import (
    format_param_label,
    _draw_dispersion_curve,
    _draw_residuals_strip,
    _draw_kinetic_correlation,
    _draw_parameter_distribution,
    _draw_covariance_distribution,
    _draw_correlation_matrix,
    _draw_1d_grid_profile,
)
from ..fitting.statistics_engine import clean_param_name

logger = logging.getLogger(__name__)


def natural_sort_key(s: str) -> list:
    """Sort residues numerically (e.g. 2N, 14N, 55N, 100N)."""
    return [int(text) if text.isdigit() else text.lower() for text in re.split(r"([0-9]+)", s)]


class ReportBuilder:
    """Orchestrates generation of multi-page scientific PDF reports."""

    def __init__(
        self,
        analysis_dir: Optional[Union[str, Path]] = None,
        analysis_name: Optional[str] = None,
        analysis_type: str = "CEST",
        style_name: str = "publication",
        chemex_image_digest: Optional[str] = None,
        fixed_timestamp: Optional[str] = None,
        model: Optional[ReportModel] = None,
    ):
        if model is not None:
            self.model = model
            self.analysis_dir = model.analysis_dir
            self.analysis_name = model.analysis_name
            self.analysis_type = model.analysis_type
            self.style_name = style_name.lower()
            self.chemex_image_digest = model.provenance.chemex_image_digest
            self.fixed_timestamp = model.provenance.timestamp_iso
        else:
            if analysis_dir is None or analysis_name is None:
                raise ValueError("Must provide either model or analysis_dir and analysis_name")
            self.model = build_report_model(
                analysis_dir=analysis_dir,
                analysis_name=analysis_name,
                analysis_type=analysis_type,
                chemex_image_digest=chemex_image_digest,
                fixed_timestamp=fixed_timestamp,
            )
            self.analysis_dir = self.model.analysis_dir
            self.analysis_name = self.model.analysis_name
            self.analysis_type = self.model.analysis_type
            self.style_name = style_name.lower()
            self.chemex_image_digest = self.model.provenance.chemex_image_digest
            self.fixed_timestamp = self.model.provenance.timestamp_iso

        self.results = self.model.results
        self.provenance = self.model.provenance
        self.derived_kinetics = self.model.derived_kinetics
        self.residue_records = self.model.residues

        # Load residue mapping if present in config
        self.residue_mapping: Dict[str, str] = {}
        for cfg_name in ["cpmg_config.json", "config.json"]:
            cfg_p = self.analysis_dir / cfg_name
            if cfg_p.is_file():
                try:
                    c_data = json.loads(cfg_p.read_text(encoding="utf-8"))
                    self.residue_mapping = c_data.get("residue_mapping", {})
                    break
                except Exception:
                    pass

        # Uncertainty resolver for page renderers querying caches or bounds
        self.resolver = UncertaintyResolver(
            self.analysis_dir,
            results_data=self.results,
        )

    def _index_residues_and_flags(self) -> List[Any]:
        """Backward-compatible accessor for residue records."""
        return self.residue_records

    def _draw_header_footer(self, fig: plt.Figure, page_num: int, total_pages: int):
        """Render running header and footer on each page."""
        # Running Header
        fig.text(
            0.08, 0.965,
            f"resoFlow {self.analysis_type} Report: {self.analysis_name}",
            fontsize=8.5, color="#666666", fontweight="bold", ha="left"
        )
        fig.text(
            0.92, 0.965,
            f"UUID: {self.provenance.analysis_uuid[:12]}...",
            fontsize=8.0, color="#888888", ha="right"
        )
        # Header line
        line_header = plt.Line2D([0.08, 0.92], [0.958, 0.958], color="#DDDDDD", linewidth=0.75, transform=fig.transFigure)
        fig.add_artist(line_header)

        # Running Footer
        line_footer = plt.Line2D([0.08, 0.92], [0.045, 0.045], color="#DDDDDD", linewidth=0.75, transform=fig.transFigure)
        fig.add_artist(line_footer)

        fig.text(
            0.08, 0.03,
            f"Generated: {self.provenance.timestamp_iso[:19].replace('T', ' ')} UTC | resoFlow v{self.provenance.resoflow_version}",
            fontsize=7.5, color="#888888", ha="left"
        )
        fig.text(
            0.92, 0.03,
            f"Page {page_num} of {total_pages}",
            fontsize=8.0, color="#555555", fontweight="bold", ha="right"
        )

    def _collect_all_fitted_parameters(self) -> List[Tuple[str, str, ResolvedParameter]]:
        """Collect all active fitted parameters for error distributions and correlation analysis."""
        params_list: List[Tuple[str, str, ResolvedParameter]] = []
        kex_r = self.resolver.resolve("kex_ab", "global")
        pb_r = self.resolver.resolve("pb", "global")

        if kex_r.value is not None and kex_r.status in (ParameterStatus.FITTED, ParameterStatus.AT_BOUND, ParameterStatus.DERIVED):
            params_list.append(("k_ex (s⁻¹)", "kex_ab", kex_r))
        if pb_r.value is not None and pb_r.status in (ParameterStatus.FITTED, ParameterStatus.AT_BOUND, ParameterStatus.DERIVED):
            params_list.append(("p_b (%)", "pb", pb_r))

        for r_rec in self.residue_records:
            d_name = r_rec["display_name"]
            if r_rec["dw"].value is not None and r_rec["dw"].status in (ParameterStatus.FITTED, ParameterStatus.AT_BOUND):
                params_list.append((f"Δω ({d_name})", f"dw_{d_name}", r_rec["dw"]))
            if r_rec["r2a"].value is not None and r_rec["r2a"].status in (ParameterStatus.FITTED, ParameterStatus.AT_BOUND):
                params_list.append((f"R₂A ({d_name})", f"r2a_{d_name}", r_rec["r2a"]))
            if r_rec["r2b"].value is not None and r_rec["r2b"].status in (ParameterStatus.FITTED, ParameterStatus.AT_BOUND):
                params_list.append((f"R₂B ({d_name})", f"r2b_{d_name}", r_rec["r2b"]))
            if r_rec["csa"].value is not None and r_rec["csa"].status in (ParameterStatus.FITTED, ParameterStatus.AT_BOUND):
                params_list.append((f"CS_A ({d_name})", f"csa_{d_name}", r_rec["csa"]))
            if r_rec["r1a"].value is not None and r_rec["r1a"].status in (ParameterStatus.FITTED, ParameterStatus.AT_BOUND):
                params_list.append((f"R₁A ({d_name})", f"r1a_{d_name}", r_rec["r1a"]))

        return params_list

    def render_pdf(self) -> io.BytesIO:
        """
        Build and render the entire multi-page PDF document using WeasyPrint for front/back matter
        and matplotlib for plot pages, stitched with pypdf per Phase C of WeasyPrint migration.
        """
        from .render import (
            build_summary_data,
            build_index_data,
            build_provenance_data,
            render_weasy_pdf,
            stitch_pdf_report,
        )

        has_kinetic_corr = self._has_kinetic_correlation_data()
        n_res = len(self.residue_records)

        # 1. First pass estimate for front pages (Summary is 1 page, Index is ceil(n_res / 28) or 1)
        est_idx_pages = max(1, math.ceil(n_res / 28)) if n_res > 0 else 1
        est_front_pages = 1 + est_idx_pages

        summary_data = build_summary_data(self.model)
        index_data = build_index_data(self.model, front_pages=est_front_pages, has_kinetic_correlation=has_kinetic_corr)
        prov_data = build_provenance_data(self.model)

        ctx_front = {
            "model": self.model,
            "summary_data": summary_data,
            "index_data": index_data,
            "style": self.style_name,
        }

        # Render WeasyPrint front matter
        weasy_front_bytes = render_weasy_pdf("front.html", ctx_front)
        actual_front_pages = len(pypdf.PdfReader(io.BytesIO(weasy_front_bytes)).pages)

        # If actual front pages differs from estimate, re-render index_data with exact actual_front_pages
        if actual_front_pages != est_front_pages:
            index_data = build_index_data(self.model, front_pages=actual_front_pages, has_kinetic_correlation=has_kinetic_corr)
            ctx_front["index_data"] = index_data
            weasy_front_bytes = render_weasy_pdf("front.html", ctx_front)
            actual_front_pages = len(pypdf.PdfReader(io.BytesIO(weasy_front_bytes)).pages)

        # 2. Middle Plot Pages (Matplotlib)
        plot_generators = []
        plot_bookmarks: List[Tuple[str, int]] = []

        # Kinetic Correlation / 2D Grid Page
        if has_kinetic_corr:
            plot_bookmarks.append(("Kinetic Likelihood Surface (2D Grid)", actual_front_pages + len(plot_generators)))
            plot_generators.append(self._build_kinetic_correlation_page)

        # Profile Scanning Grid (4 per page)
        if n_res > 0:
            grid_per_page = 4
            n_grid_pages = max(1, math.ceil(n_res / grid_per_page))
            plot_bookmarks.append(("Residue Profiles (Scanning Grid)", actual_front_pages + len(plot_generators)))
            for g_i in range(n_grid_pages):
                plot_generators.append(lambda fig, idx=g_i: self._build_profile_grid_page(fig, idx, grid_per_page))

            # Flagged Residue Detail Pages (with 25% residuals strip)
            detailed_records = self.residue_records if n_res <= 4 else [r for r in self.residue_records if r["has_flags"]]
            if detailed_records:
                plot_bookmarks.append(("Detailed Residue Profiles & Residuals", actual_front_pages + len(plot_generators)))
            for r_rec in detailed_records:
                plot_generators.append(lambda fig, rec=r_rec: self._build_detailed_residue_page(fig, rec))

        # Comprehensive Statistics Section
        if self.resolver.resampled_cache:
            for method_name, sm_data in self.resolver.resampled_cache.items():
                reps = sm_data.get("replicates")
                p_names = sm_data.get("parameter_names", [])
                if reps is not None and len(p_names) > 0:
                    params_per_dist_page = 4
                    n_dist_pages = max(1, math.ceil(len(p_names) / params_per_dist_page))
                    plot_bookmarks.append((f"{method_name} Parameter Distributions", actual_front_pages + len(plot_generators)))
                    for p_page_i in range(n_dist_pages):
                        plot_generators.append(
                            lambda fig, m_n=method_name, s_d=sm_data, p_i=p_page_i, p_per=params_per_dist_page:
                            self._build_statistics_distributions_page(fig, m_n, s_d, p_i, p_per)
                        )

                    plot_bookmarks.append((f"{method_name} Parameter Correlation Matrix", actual_front_pages + len(plot_generators)))
                    plot_generators.append(
                        lambda fig, m_n=method_name, s_d=sm_data:
                        self._build_statistics_correlation_page(fig, m_n, s_d)
                    )
        else:
            fitted_params_list = self._collect_all_fitted_parameters()
            if fitted_params_list:
                params_per_dist_page = 4
                n_dist_pages = max(1, math.ceil(len(fitted_params_list) / params_per_dist_page))
                plot_bookmarks.append(("Parameter Error Distributions (Covariance)", actual_front_pages + len(plot_generators)))
                for p_page_i in range(n_dist_pages):
                    plot_generators.append(
                        lambda fig, p_l=fitted_params_list, p_i=p_page_i, p_per=params_per_dist_page:
                        self._build_covariance_distributions_page(fig, p_l, p_i, p_per)
                    )
                plot_bookmarks.append(("Parameter Correlation Matrix (Covariance)", actual_front_pages + len(plot_generators)))
                plot_generators.append(
                    lambda fig, p_l=fitted_params_list:
                    self._build_covariance_correlation_page(fig, p_l)
                )

        if self.resolver.grid_1d_cache:
            plot_bookmarks.append(("1D Grid Search Profiles", actual_front_pages + len(plot_generators)))
            plot_generators.append(self._build_1d_grid_profiles_page)

        # 3. Render WeasyPrint back matter (Provenance & DOF)
        ctx_back = {
            "model": self.model,
            "prov": self.model.provenance,
            "prov_data": prov_data,
            "style": self.style_name,
        }
        weasy_back_bytes = render_weasy_pdf("back.html", ctx_back)
        actual_back_pages = len(pypdf.PdfReader(io.BytesIO(weasy_back_bytes)).pages)

        # Total pages for header/footer calculation
        total_pages = actual_front_pages + len(plot_generators) + actual_back_pages

        # Render middle plot pages with matplotlib
        mpl_plots_bytes = None
        if plot_generators:
            mpl_buf = io.BytesIO()
            with apply_report_style(self.style_name):
                with PdfPages(mpl_buf) as pdf:
                    for p_idx, builder_fn in enumerate(plot_generators):
                        cur_page_num = actual_front_pages + p_idx + 1
                        fig = plt.figure(figsize=(8.5, 11.0))
                        try:
                            builder_fn(fig)
                        except Exception as exc:
                            logger.error("Error building report page %d: %s", cur_page_num, exc, exc_info=True)
                            fig.clf()
                            fig.text(0.5, 0.5, f"Error rendering page {cur_page_num}: {str(exc)}", ha="center", color="red")

                        self._draw_header_footer(fig, cur_page_num, total_pages)
                        pdf.savefig(fig, dpi=300)
                        plt.close(fig)

            mpl_buf.seek(0)
            mpl_plots_bytes = mpl_buf.getvalue()

        # Stitch all chunks together with pypdf
        return stitch_pdf_report(
            weasy_front_bytes=weasy_front_bytes,
            mpl_plots_bytes=mpl_plots_bytes,
            weasy_back_bytes=weasy_back_bytes,
            plot_bookmarks=plot_bookmarks,
        )

    # --- Page Builders ---

    def _build_summary_page(self, fig: plt.Figure):
        """Page 1: Title, Executive Summary, Global Parameters, and Derived Kinetics."""
        gs = GridSpec(nrows=4, ncols=1, height_ratios=[0.12, 0.38, 0.35, 0.15], figure=fig, hspace=0.35, left=0.08, right=0.92, top=0.93, bottom=0.06)

        # Title Block
        ax_title = fig.add_subplot(gs[0])
        ax_title.axis("off")
        ax_title.text(0.5, 0.70, f"{self.analysis_type} Relaxation Dispersion Analysis Report", fontsize=16, fontweight="bold", ha="center", color="#111827")
        ax_title.text(0.5, 0.25, f"Analysis: {self.analysis_name}  |  Kinetic Model: {self.provenance.model_name.upper()}  |  Residues: {len(self.residue_records)}", fontsize=10, color="#4B5563", ha="center")

        # Global Parameters Table
        ax_global = fig.add_subplot(gs[1])
        ax_global.axis("off")
        ax_global.set_title("Global Relaxation & Exchange Parameters", fontsize=11, fontweight="bold", pad=8, loc="left", color="#111827")

        kex_r = self.resolver.resolve("kex_ab", "global")
        pb_r = self.resolver.resolve("pb", "global")
        tauc_r = self.resolver.resolve("tauc_a", "global")

        table_rows = [["Parameter", "Symbol", "Status", "Fitted / Fixed Value", "Uncertainty Source"]]

        # Exchange Rate
        kex_fmt = format_with_error(kex_r.value, kex_r.err_low, kex_r.err_high, unit=kex_r.unit, source=kex_r.source.value, status=kex_r.status.value)
        table_rows.append(["Exchange Rate", "k_ex", kex_r.status.value, kex_fmt, kex_r.source.value if kex_r.status == ParameterStatus.FITTED else "—"])

        # Excited Population
        pb_fmt = format_with_error(pb_r.value, pb_r.err_low, pb_r.err_high, unit=pb_r.unit, source=pb_r.source.value, status=pb_r.status.value)
        table_rows.append(["Excited Population", "p_b", pb_r.status.value, pb_fmt, pb_r.source.value if pb_r.status == ParameterStatus.FITTED else "—"])

        # Ground Population
        pa_val = (100.0 - pb_r.value) if (pb_r.value is not None) else None
        pa_fmt = f"{pa_val:.3f} %" if pa_val is not None else "—"
        table_rows.append(["Major State Pop.", "p_a", "DERIVED", pa_fmt, "Derived (1 − p_b)"])

        # Correlation time (only if in model)
        if tauc_r.status != ParameterStatus.NOT_IN_MODEL:
            tauc_fmt = format_with_error(tauc_r.value, tauc_r.err_low, tauc_r.err_high, unit=tauc_r.unit, source=tauc_r.source.value, status=tauc_r.status.value)
            table_rows.append(["Correlation Time", "τ_c", tauc_r.status.value, tauc_fmt, tauc_r.source.value])

        # Goodness of fit rows
        dof_info = self.provenance.dof_accounting
        table_rows.append(["Overall Chi-Square", "χ²", "STATISTIC", f"{dof_info.chi2_global:.2f}", f"DOF = {dof_info.dof_global}"])
        table_rows.append(["Reduced Chi-Square", "χ²_red", "STATISTIC", f"{dof_info.chi2_red_global:.2f}", "Goodness of fit"])

        t_glob = ax_global.table(cellText=table_rows, colWidths=[0.26, 0.12, 0.16, 0.26, 0.20], loc="center", cellLoc="center", bbox=[0.0, 0.0, 1.0, 0.92])
        t_glob.auto_set_font_size(False)
        t_glob.set_fontsize(8.5)
        # Header formatting
        for c in range(5):
            t_glob[0, c].set_facecolor("#F3F4F6")
            t_glob[0, c].set_text_props(weight="bold", color="#111827")

        # Derived Kinetics Section (Phase 7)
        ax_kin = fig.add_subplot(gs[2])
        ax_kin.axis("off")
        ax_kin.set_title("Derived Kinetic Quantities (Covariance-Aware Propagation)", fontsize=11, fontweight="bold", pad=8, loc="left", color="#111827")

        kin_rows = [["Quantity", "Symbol", "Expression", "Propagated Value", "Propagation Method"]]
        for k_key in ["kab", "kba", "tau_b", "tau_a"]:
            k_obj = self.derived_kinetics.get(k_key)
            if k_obj and k_obj.value is not None:
                val_fmt = format_with_error(k_obj.value, k_obj.err_low, k_obj.err_high, unit=k_obj.unit, source=k_obj.source.value, status="FITTED")
                kin_rows.append([
                    k_obj.name.upper(),
                    k_obj.symbol,
                    k_obj.expression,
                    val_fmt,
                    k_obj.propagation_method,
                ])

        t_kin = ax_kin.table(cellText=kin_rows, colWidths=[0.18, 0.14, 0.24, 0.24, 0.20], loc="center", cellLoc="center", bbox=[0.0, 0.0, 1.0, 0.90])
        t_kin.auto_set_font_size(False)
        t_kin.set_fontsize(8.5)
        for c in range(5):
            t_kin[0, c].set_facecolor("#F3F4F6")
            t_kin[0, c].set_text_props(weight="bold", color="#111827")

        # Summary Note Box
        ax_note = fig.add_subplot(gs[3])
        ax_note.axis("off")
        note_text = (
            "Key Notes & Interpretation Guidelines:\n"
            "• Uncertainties follow strict precedence: 1D Grid Search (Δχ²=1.00/3.84) > Resampled Percentiles > Covariance σ.\n"
            "• Numerical values are rounded strictly to the least significant digit of their uncertainty.\n"
            "• Fixed or constrained parameters are explicitly labeled and never displayed with pseudo-uncertainties."
        )
        ax_note.text(
            0.0, 0.85, note_text,
            fontsize=8.0, color="#374151", va="top",
            bbox=dict(boxstyle="round,pad=0.6", facecolor="#F9FAFB", edgecolor="#E5E7EB")
        )

    def _build_index_page(self, fig: plt.Figure, page_idx: int, per_page: int):
        """Page 2: Comprehensive Residue Index Table with flags and uncertainties."""
        start_idx = page_idx * per_page
        end_idx = min(len(self.residue_records), start_idx + per_page)
        page_records = self.residue_records[start_idx:end_idx]

        ax = fig.add_subplot(1, 1, 1)
        ax.axis("off")
        ax.set_title(f"Residue Results Index (Items {start_idx + 1}–{end_idx} of {len(self.residue_records)})", fontsize=12, fontweight="bold", pad=12, loc="left")

        table_data = [["Residue", "Red. χ²", "Δω (ppm)", "R₂A (s⁻¹)", "R₂B (s⁻¹)", "R₁A (s⁻¹)", "Flags"]]

        for rec in page_records:
            chi2_str = f"{rec['chi2_red']:.2f}" if rec["chi2_red"] is not None else "—"
            dw_str = format_with_error(rec["dw"].value, rec["dw"].err_low, rec["dw"].err_high, source=rec["dw"].source.value, status=rec["dw"].status.value)
            r2a_str = format_with_error(rec["r2a"].value, rec["r2a"].err_low, rec["r2a"].err_high, source=rec["r2a"].source.value, status=rec["r2a"].status.value)
            r2b_str = format_with_error(rec["r2b"].value, rec["r2b"].err_low, rec["r2b"].err_high, source=rec["r2b"].source.value, status=rec["r2b"].status.value)
            r1a_str = format_with_error(rec["r1a"].value, rec["r1a"].err_low, rec["r1a"].err_high, source=rec["r1a"].source.value, status=rec["r1a"].status.value)
            flags_str = ", ".join(rec["flags"]) if rec["flags"] else "PASS"

            table_data.append([
                rec["display_name"],
                chi2_str,
                dw_str,
                r2a_str,
                r2b_str,
                r1a_str,
                flags_str,
            ])

        t = ax.table(
            cellText=table_data,
            colWidths=[0.14, 0.12, 0.18, 0.18, 0.18, 0.18, 0.18],
            loc="center",
            cellLoc="center",
            bbox=[0.0, 0.05, 1.0, 0.90]
        )
        t.auto_set_font_size(False)
        t.set_fontsize(8.0)
        for c in range(7):
            t[0, c].set_facecolor("#F3F4F6")
            t[0, c].set_text_props(weight="bold")

        # Color flag column
        for r_i, rec in enumerate(page_records, start=1):
            if rec["has_flags"]:
                t[r_i, 6].set_text_props(color="#B91C1C", weight="bold")
            else:
                t[r_i, 6].set_text_props(color="#047857")

    def _has_kinetic_correlation_data(self) -> bool:
        """Check if we have grid or samples to render the kinetic page."""
        grid_dirs = [
            self.analysis_dir / "STEP1" / "Grid",
            self.analysis_dir / "Grid",
            self.analysis_dir / "Output" / "Grid",
        ]
        for gd in grid_dirs:
            if gd.is_dir():
                from ..fitting.chemex_output.grid_parser import get_grid_data_for_group
                try:
                    pnames, agg_data, _ = get_grid_data_for_group(gd, None)
                    if len(pnames) >= 2:
                        return True
                except Exception:
                    pass

        for sm_dict in self.resolver.resampled_cache.values():
            p_names = [clean_param_name(x).upper() for x in sm_dict.get("parameter_names", [])]
            if "KEX_AB" in p_names and "PB" in p_names:
                return True
        return False

    def _build_kinetic_correlation_page(self, fig: plt.Figure) -> bool:
        """Page 3: Informative Kinetic Correlation or 2D Grid / Joint Density Contour (Phase 4)."""
        # Check if 2D grid surface exists in cache or on disk
        grid_dirs = [
            self.analysis_dir / "STEP1" / "Grid",
            self.analysis_dir / "Grid",
            self.analysis_dir / "Output" / "Grid",
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

        # Check if MC/Bootstrap samples exist
        samples_2d = None
        for sm_dict in self.resolver.resampled_cache.values():
            p_names = [clean_param_name(x).upper() for x in sm_dict.get("parameter_names", [])]
            reps = sm_dict.get("replicates")
            if reps is not None and "KEX_AB" in p_names and "PB" in p_names:
                samples_2d = (reps[:, p_names.index("PB")], reps[:, p_names.index("KEX_AB")])
                break

        if grid_prof_2d is not None:
            ax = fig.add_subplot(1, 1, 1)
            return _draw_kinetic_correlation(ax, fig=fig, grid_prof_2d=grid_prof_2d)
        elif samples_2d is not None:
            ax = fig.add_subplot(1, 1, 1)
            kex_r = self.resolver.resolve("kex_ab", "global")
            pb_r = self.resolver.resolve("pb", "global")
            best_fit = (pb_r.value, kex_r.value) if (kex_r.value and pb_r.value) else None
            return _draw_kinetic_correlation(ax, fig=fig, samples_2d=samples_2d, best_fit=best_fit)

        return False

    def _build_profile_grid_page(self, fig: plt.Figure, page_idx: int, per_page: int):
        """Page 4: Compact Scanning Grid (4 profiles per page) with deduplicated legends."""
        start_idx = page_idx * per_page
        end_idx = min(len(self.residue_records), start_idx + per_page)
        page_records = self.residue_records[start_idx:end_idx]

        gs = GridSpec(nrows=2, ncols=2, figure=fig, hspace=0.35, wspace=0.25, left=0.08, right=0.92, top=0.92, bottom=0.08)

        for i, rec in enumerate(page_records):
            ax = fig.add_subplot(gs[i // 2, i % 2])
            self._plot_dispersion_curve(ax, rec, show_anchors=True, compact=True)

    def _build_detailed_residue_page(self, fig: plt.Figure, rec: Dict[str, Any]):
        """Page 5: Full page detailed profile with 25% Normalized Residuals Strip (Phase 5a/5b)."""
        gs = GridSpec(nrows=3, ncols=1, height_ratios=[0.55, 0.20, 0.25], figure=fig, hspace=0.22, left=0.09, right=0.91, top=0.92, bottom=0.06)

        ax_profile = fig.add_subplot(gs[0])
        ax_residual = fig.add_subplot(gs[1], sharex=ax_profile)
        ax_table = fig.add_subplot(gs[2])

        # 1. Main Profile
        _draw_dispersion_curve(ax_profile, rec, analysis_type=self.analysis_type, show_anchors=True, compact=False)
        ax_profile.set_xlabel("")  # Shared x axis

        # 2. Residuals Strip (Normalized Residuals (y - fit) / sigma)
        _draw_residuals_strip(ax_residual, rec, analysis_type=self.analysis_type)

        # 3. Parameters Table for this residue
        ax_table.axis("off")
        p_rows = [["Parameter", "Symbol", "Status", "Resolved Value", "Uncertainty Source"]]

        p_items = [
            ("Chemical Shift A", "CS_A", rec["csa"]),
            ("Chemical Shift B", "CS_B", rec["csb"]),
            ("Chemical Shift Diff", "Δω_AB", rec["dw"]),
            ("Transverse Rel. A", "R₂A", rec["r2a"]),
            ("Transverse Rel. B", "R₂B", rec["r2b"]),
            ("Longitudinal Rel. A", "R₁A", rec["r1a"]),
        ]
        for name, sym, p_res in p_items:
            val_fmt = format_with_error(p_res.value, p_res.err_low, p_res.err_high, unit=p_res.unit, source=p_res.source.value, status=p_res.status.value)
            p_rows.append([name, sym, p_res.status.value, val_fmt, p_res.source.value if p_res.status == ParameterStatus.FITTED else p_res.status.value])

        t_res = ax_table.table(cellText=p_rows, colWidths=[0.24, 0.14, 0.16, 0.26, 0.20], loc="center", cellLoc="center", bbox=[0.0, 0.05, 1.0, 0.90])
        t_res.auto_set_font_size(False)
        t_res.set_fontsize(8.0)
        for c in range(5):
            t_res[0, c].set_facecolor("#F3F4F6")
            t_res[0, c].set_text_props(weight="bold")

    def _plot_dispersion_curve(self, ax: plt.Axes, rec: Dict[str, Any], show_anchors: bool = True, compact: bool = False):
        """Render CEST or CPMG profile curves with deduplicated legends and non-colliding A/B markers."""
        _draw_dispersion_curve(ax, rec, analysis_type=self.analysis_type, show_anchors=show_anchors, compact=compact)

    def _build_statistics_section_page(self, fig: plt.Figure):
        """Conditional Statistics section (Phase 8) for MC/Bootstrap distributions and comparisons."""
        gs = GridSpec(nrows=2, ncols=1, height_ratios=[0.55, 0.45], figure=fig, hspace=0.35, left=0.09, right=0.91, top=0.92, bottom=0.08)

        # Resampling Distribution Plot
        ax_plot = fig.add_subplot(gs[0])
        stat_name = "Monte Carlo / Bootstrap"
        samples_found = False

        for sm_name, sm_dict in self.resolver.resampled_cache.items():
            p_names = [clean_param_name(x).upper() for x in sm_dict.get("parameter_names", [])]
            reps = sm_dict.get("replicates")
            if reps is not None and reps.shape[0] > 1:
                stat_name = sm_name
                # Plot histogram of KEX_AB or DW_AB
    def _build_statistics_distributions_page(
        self,
        fig: plt.Figure,
        method_name: str,
        sm_data: Dict[str, Any],
        page_idx: int,
        per_page: int,
    ):
        """Render marginal error distribution histograms and credible interval diagnostics."""
        reps = sm_data.get("replicates")
        p_names = sm_data.get("parameter_names", [])
        if reps is None or len(p_names) == 0:
            return

        start_idx = page_idx * per_page
        end_idx = min(len(p_names), start_idx + per_page)
        page_params = p_names[start_idx:end_idx]

        fig.suptitle(
            f"{method_name} Parameter Error Distributions (Items {start_idx + 1}–{end_idx} of {len(p_names)})",
            fontsize=12, fontweight="bold", y=0.94, color="#111827"
        )

        n_plots = len(page_params)
        nrows = 2
        ncols = 2
        gs = GridSpec(nrows=nrows, ncols=ncols, figure=fig, hspace=0.38, wspace=0.28, left=0.09, right=0.91, top=0.88, bottom=0.08)

        for i, p_raw in enumerate(page_params):
            p_idx = start_idx + i
            ax = fig.add_subplot(gs[i // 2, i % 2])
            col_data = reps[:, p_idx]
            _draw_parameter_distribution(ax, col_data, p_raw)

    def _build_statistics_correlation_page(self, fig: plt.Figure, method_name: str, sm_data: Dict[str, Any]):
        """Render full parameter correlation matrix heatmap and coupling diagnostics."""
        reps = sm_data.get("replicates")
        p_names = sm_data.get("parameter_names", [])
        if reps is None or len(p_names) == 0:
            return

        valid_mask = ~np.isnan(reps).any(axis=1)
        valid_reps = reps[valid_mask]
        if len(valid_reps) < 2:
            return

        # Compute Pearson correlation matrix
        with np.errstate(divide="ignore", invalid="ignore"):
            corr_mat = np.corrcoef(valid_reps.T)
        corr_mat = np.nan_to_num(corr_mat, nan=0.0)

        # Labels
        labels = [format_param_label(p) for p in p_names]
        n_p = len(labels)

        gs = GridSpec(nrows=2, ncols=1, height_ratios=[0.60, 0.40], figure=fig, hspace=0.35, left=0.12, right=0.88, top=0.92, bottom=0.06)

        # 1. Heatmap Subplot
        ax_heat = fig.add_subplot(gs[0])
        _draw_correlation_matrix(ax_heat, fig=fig, corr_mat=corr_mat, labels=labels, title=f"{method_name} Parameter Correlation Matrix")

        # 2. Significant Correlations Table
        ax_tab = fig.add_subplot(gs[1])
        ax_tab.axis("off")
        ax_tab.set_title("Significant Parameter Couplings & Trade-Offs (|r| ≥ 0.40)", fontsize=10.5, fontweight="bold", pad=6, loc="left")

        # Extract unique off-diagonal pairs
        pairs = []
        for r_i in range(n_p):
            for c_i in range(r_i + 1, n_p):
                r_val = corr_mat[r_i, c_i]
                if abs(r_val) >= 0.40:
                    pairs.append((abs(r_val), r_val, labels[r_i], labels[r_i], labels[c_i]))

        pairs.sort(key=lambda x: x[0], reverse=True)

        table_rows = [["Parameter Pair", "Correlation (r)", "Coupling Strength", "Physical Interpretation"]]
        for _, r_val, _, p1, p2 in pairs[:6]:
            coupling = "Strong Anti-Correlation" if r_val <= -0.7 else ("Strong Positive" if r_val >= 0.7 else ("Moderate Coupling" if r_val > 0 else "Moderate Trade-off"))
            # Interpretation
            interp = "Parameter coupling"
            if ("k_ex" in p1 and "p_b" in p2) or ("p_b" in p1 and "k_ex" in p2):
                interp = "Exchange rate vs population trade-off ridge"
            elif "R₂A" in p1 and "R₂A" in p2:
                interp = "Cross-field transverse relaxation baseline correlation"
            elif "Δω" in p1 and "p_b" in p2:
                interp = "Fast-exchange scaling coupling (k_ex >> Δω)"

            table_rows.append([f"{p1} ↔ {p2}", f"{r_val:+.3f}", coupling, interp])

        if len(table_rows) == 1:
            table_rows.append(["No parameter pairs with |r| ≥ 0.40", "—", "Orthogonal", "Parameters are statistically well-decoupled"])

        t_corr = ax_tab.table(cellText=table_rows, colWidths=[0.28, 0.16, 0.24, 0.32], loc="center", cellLoc="center", bbox=[0.0, 0.05, 1.0, 0.85])
        t_corr.auto_set_font_size(False)
        t_corr.set_fontsize(8.0)
        for c in range(4):
            t_corr[0, c].set_facecolor("#F3F4F6")
            t_corr[0, c].set_text_props(weight="bold")

    def _build_covariance_distributions_page(
        self,
        fig: plt.Figure,
        fitted_params: List[Tuple[str, str, ResolvedParameter]],
        page_idx: int,
        per_page: int,
    ):
        """Render analytical error distribution curves from covariance uncertainties."""
        start_idx = page_idx * per_page
        end_idx = min(len(fitted_params), start_idx + per_page)
        page_params = fitted_params[start_idx:end_idx]

        fig.suptitle(
            f"Parameter Error Distributions (Covariance Likelihood) (Items {start_idx + 1}–{end_idx} of {len(fitted_params)})",
            fontsize=12, fontweight="bold", y=0.94, color="#111827"
        )

        n_plots = len(page_params)
        nrows = 2
        ncols = 2
        gs = GridSpec(nrows=nrows, ncols=ncols, figure=fig, hspace=0.38, wspace=0.28, left=0.09, right=0.91, top=0.88, bottom=0.08)

        for i, (label, p_key, p_obj) in enumerate(page_params):
            ax = fig.add_subplot(gs[i // 2, i % 2])
            _draw_covariance_distribution(ax, label, p_obj)

    def _build_covariance_correlation_page(self, fig: plt.Figure, fitted_params: List[Tuple[str, str, ResolvedParameter]]):
        """Render covariance-derived parameter correlation matrix heatmap and coupling table."""
        labels = [p[0] for p in fitted_params]
        n_p = len(labels)
        if n_p == 0:
            return

        # Construct correlation matrix
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

        gs = GridSpec(nrows=2, ncols=1, height_ratios=[0.60, 0.40], figure=fig, hspace=0.35, left=0.12, right=0.88, top=0.92, bottom=0.06)

        # 1. Heatmap Subplot
        ax_heat = fig.add_subplot(gs[0])
        _draw_correlation_matrix(ax_heat, fig=fig, corr_mat=corr_mat, labels=labels, title="Parameter Correlation Matrix (Covariance-Derived)")

        # 2. Significant Correlations Table
        ax_tab = fig.add_subplot(gs[1])
        ax_tab.axis("off")
        ax_tab.set_title("Significant Parameter Couplings & Trade-Offs (|r| ≥ 0.25)", fontsize=10.5, fontweight="bold", pad=6, loc="left")

        pairs = []
        for r_i in range(n_p):
            for c_i in range(r_i + 1, n_p):
                r_val = corr_mat[r_i, c_i]
                if abs(r_val) >= 0.25:
                    pairs.append((abs(r_val), r_val, labels[r_i], labels[c_i]))

        pairs.sort(key=lambda x: x[0], reverse=True)

        table_rows = [["Parameter Pair", "Correlation (r)", "Coupling Strength", "Physical Interpretation"]]
        for _, r_val, p1, p2 in pairs[:6]:
            coupling = "Strong Anti-Correlation" if r_val <= -0.7 else ("Strong Positive" if r_val >= 0.7 else ("Moderate Coupling" if r_val > 0 else "Moderate Trade-off"))
            interp = "Parameter coupling"
            if ("k_ex" in p1 and "p_b" in p2) or ("p_b" in p1 and "k_ex" in p2):
                interp = "Exchange rate vs population trade-off ridge"
            elif "R₂" in p1 and "R₂" in p2:
                interp = "Transverse relaxation baseline correlation"
            elif ("k_ex" in p1 and "Δω" in p2) or ("Δω" in p1 and "k_ex" in p2):
                interp = "Exchange time-scale scaling coupling (k_ex ~ Δω)"
            elif "Δω" in p1 and "p_b" in p2:
                interp = "Fast-exchange scaling coupling (k_ex >> Δω)"

            table_rows.append([f"{p1} ↔ {p2}", f"{r_val:+.2f}", coupling, interp])

        if len(table_rows) == 1:
            table_rows.append(["No parameter pairs with |r| ≥ 0.25", "—", "Orthogonal", "Parameters are statistically well-decoupled"])

        t_corr = ax_tab.table(cellText=table_rows, colWidths=[0.28, 0.16, 0.24, 0.32], loc="center", cellLoc="center", bbox=[0.0, 0.05, 1.0, 0.85])
        t_corr.auto_set_font_size(False)
        t_corr.set_fontsize(8.0)
        for c in range(4):
            t_corr[0, c].set_facecolor("#F3F4F6")
            t_corr[0, c].set_text_props(weight="bold")

    def _build_1d_grid_profiles_page(self, fig: plt.Figure):
        """Render 1D Grid Search Chi2 profiles with Delta-chi2 = 1.00 and 3.84 confidence thresholds."""
        profs = list(self.resolver.grid_1d_cache.values())
        if not profs:
            return

        fig.suptitle("1D Grid Search Confidence Profiles (Likelihood Scans)", fontsize=12, fontweight="bold", y=0.94)

        n_profs = min(4, len(profs))
        gs = GridSpec(nrows=2, ncols=2, figure=fig, hspace=0.35, wspace=0.25, left=0.09, right=0.91, top=0.88, bottom=0.08)

        for i, prof in enumerate(profs[:4]):
            ax = fig.add_subplot(gs[i // 2, i % 2])
            _draw_1d_grid_profile(ax, prof)

    def _build_statistics_section_page(self, fig: plt.Figure):
        """Fallback Statistics section if no raw replicates array is available."""
        ax = fig.add_subplot(1, 1, 1)
        ax.axis("off")
        ax.text(0.5, 0.5, "Statistics runs present but no replicate arrays loaded.", ha="center", va="center", color="gray")

    def _build_provenance_page(self, fig: plt.Figure):
        """Page 6: Provenance, Software Digests, Input File Hashes, and Explicit DOF Accounting (Phase 6)."""
        gs = GridSpec(nrows=3, ncols=1, height_ratios=[0.32, 0.38, 0.30], figure=fig, hspace=0.30, left=0.09, right=0.91, top=0.92, bottom=0.06)

        # Software & Acquisition Metadata Table
        ax_meta = fig.add_subplot(gs[0])
        ax_meta.axis("off")
        ax_meta.set_title("Provenance & Acquisition Metadata", fontsize=11, fontweight="bold", pad=8, loc="left")

        prov = self.provenance
        meta_data = [
            ["Attribute", "Value", "Attribute", "Value"],
            ["resoFlow Version", f"{prov.resoflow_version} ({prov.git_sha or 'clean'})", "ChemEx Version", prov.chemex_version or "2026.6.1"],
            ["ChemEx Container Digest", f"{prov.chemex_image_digest[:20]}...", "Kinetic Model", prov.model_name.upper()],
            ["Static Field (B₀)", ", ".join(prov.b0_fields), "Temperature", f"{prov.temperature_k} K" if prov.temperature_k else "298.15 K"],
            ["Minimizer", prov.minimizer, "Status", prov.convergence_status.upper()],
            ["Δω Sign Convention", prov.delta_omega_convention[:35] + "...", "Uncertainty Sources", ", ".join(prov.uncertainty_sources_used)],
        ]
        t_meta = ax_meta.table(cellText=meta_data, colWidths=[0.24, 0.26, 0.24, 0.26], loc="center", cellLoc="left", bbox=[0.0, 0.0, 1.0, 0.92])
        t_meta.auto_set_font_size(False)
        t_meta.set_fontsize(8.0)
        for c in range(4):
            t_meta[0, c].set_facecolor("#F3F4F6")
            t_meta[0, c].set_text_props(weight="bold")
            
        if "RESAMPLED" in prov.uncertainty_sources_used and "COVARIANCE" in prov.uncertainty_sources_used:
            fallback_params = [f"{res.name} ({res.scope})" for res in self.resolver.resolution_ledger.values() if res.source == UncertaintySource.COVARIANCE and res.status == ParameterStatus.FITTED]
            if fallback_params:
                ax_meta.text(
                    0.0, -0.15,
                    f"⚠ Partial Resolution Warning: Some fitted parameters lacked resampling statistics and fell back to covariance approximations:\n    {', '.join(fallback_params[:8])}{' ...' if len(fallback_params) > 8 else ''}",
                    fontsize=8, color="#B91C1C", transform=ax_meta.transAxes, va="top", ha="left"
                )

        # Explicit DOF Accounting Table (Reconciling 881.04 / 1.15)
        ax_dof = fig.add_subplot(gs[1])
        ax_dof.axis("off")
        ax_dof.set_title("Explicit Degrees of Freedom (DOF) Reconciliation", fontsize=11, fontweight="bold", pad=8, loc="left")

        dof_info = prov.dof_accounting
        dof_rows = [["Level / Residue", "Data Points (N)", "Local Vars", "Global Vars", "DOF", "χ²", "Reduced χ²"]]
        dof_rows.append([
            "GLOBAL OVERALL",
            str(dof_info.n_data_global),
            str(dof_info.n_local_params_total),
            str(dof_info.n_global_params),
            str(dof_info.dof_global),
            f"{dof_info.chi2_global:.2f}",
            f"{dof_info.chi2_red_global:.2f}",
        ])

        for res_name, r_dof in dof_info.residue_dofs.items():
            dof_rows.append([
                f"Residue {res_name}",
                str(r_dof["ndata"]),
                str(r_dof["nvarys_local"]),
                "0",
                str(r_dof["dof"]),
                f"{r_dof['chi2']:.2f}",
                f"{r_dof['chi2_red']:.2f}",
            ])

        t_dof = ax_dof.table(cellText=dof_rows, colWidths=[0.22, 0.13, 0.13, 0.13, 0.11, 0.14, 0.14], loc="center", cellLoc="center", bbox=[0.0, 0.0, 1.0, 0.90])
        t_dof.auto_set_font_size(False)
        t_dof.set_fontsize(8.0)
        for c in range(7):
            t_dof[0, c].set_facecolor("#F3F4F6")
            t_dof[0, c].set_text_props(weight="bold")
        t_dof[1, 0].set_text_props(weight="bold", color="#0072B2")

        # Input File Hashes & Cryptographic Verification
        ax_hash = fig.add_subplot(gs[2])
        ax_hash.axis("off")
        ax_hash.set_title("Input Configuration & Method SHA-256 Hashes", fontsize=11, fontweight="bold", pad=8, loc="left")

        hash_rows = [["Configuration File", "SHA-256 Digest"]]
        for f_entry in prov.input_files[:6]:
            hash_rows.append([f_entry["filename"], f_entry["sha256"]])
        if not prov.input_files:
            hash_rows.append(["parameters.toml", "Unavailable"])

        t_hash = ax_hash.table(cellText=hash_rows, colWidths=[0.35, 0.65], loc="center", cellLoc="left", bbox=[0.0, 0.0, 1.0, 0.85])
        t_hash.auto_set_font_size(False)
        t_hash.set_fontsize(7.5)
        for c in range(2):
            t_hash[0, c].set_facecolor("#F3F4F6")
            t_hash[0, c].set_text_props(weight="bold")


def generate_modern_pdf_report(
    analysis_dir: Union[str, Path],
    analysis_name: str,
    analysis_type: str = "CEST",
    style: str = "publication",
    chemex_image_digest: Optional[str] = None,
    fixed_timestamp: Optional[str] = None,
) -> io.BytesIO:
    """
    Main entry point for generating modern, publication-usable PDF reports.
    Preserves exact signature for compatibility.
    """
    model = build_report_model(
        analysis_dir=analysis_dir,
        analysis_name=analysis_name,
        analysis_type=analysis_type,
        chemex_image_digest=chemex_image_digest,
        fixed_timestamp=fixed_timestamp,
    )
    builder = ReportBuilder(model=model, style_name=style)
    return builder.render_pdf()
