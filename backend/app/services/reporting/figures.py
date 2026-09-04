# backend/app/services/reporting/figures.py
"""
Matplotlib figure generation for resoFlow reports per WeasyPrint design spec §4.
Each plotting routine provides:
1. An atomic _draw_*(ax, ...) helper shared with page builders.
2. A standalone figure wrapper returning an SVG string (or base64 PNG URI for dense artists).
"""

from __future__ import annotations

import base64
import io
import re
from typing import Any, Dict, List, Optional, Tuple, Union

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.gridspec import GridSpec
import numpy as np

from .plot_styles import OKABE_ITO
from ..fitting.statistics_engine import clean_param_name

# Configure matplotlib to convert text glyphs to vector path outlines in SVG
plt.rcParams["svg.fonttype"] = "path"


def format_param_label(p_raw: str) -> str:
    """Format ChemEx parameter key into clean publication-ready label."""
    s = p_raw.strip().strip("[]\"'")
    parts = [x.strip() for x in s.split(",")]
    base = parts[0].upper()
    nuc = ""
    b0 = ""
    for part in parts[1:]:
        if "NUC->" in part:
            nuc = part.replace("NUC->", "").strip()
        elif "B0->" in part:
            b0 = part.replace("B0->", "").strip()

    if base in ("KEX_AB", "KEX"):
        return "k_ex (s⁻¹)"
    elif base in ("PB", "P_B"):
        return "p_b (%)"
    elif base in ("PA", "P_A"):
        return "p_a (%)"
    elif base in ("DW_AB", "DW"):
        return f"Δω ({nuc})" if nuc else "Δω (ppm)"
    elif base in ("CS_A", "CSA"):
        return f"CS_A ({nuc})" if nuc else "CS_A (ppm)"
    elif base in ("CS_B", "CSB"):
        return f"CS_B ({nuc})" if nuc else "CS_B (ppm)"
    elif base in ("R1_A", "R1A"):
        return f"R₁A ({nuc})" if nuc else "R₁A (s⁻¹)"
    elif base in ("R2_A", "R2A"):
        suffix = [x for x in (nuc, b0) if x]
        return f"R₂A ({', '.join(suffix)})" if suffix else "R₂A (s⁻¹)"
    elif base in ("R2_B", "R2B"):
        suffix = [x for x in (nuc, b0) if x]
        return f"R₂B ({', '.join(suffix)})" if suffix else "R₂B (s⁻¹)"
    elif base.lower() == "lnprob":
        return "ln(Posterior)"
    return s


def _svg(fig: plt.Figure) -> str:
    """Render a figure to an SVG string, stripping XML header/DOCTYPE and closing the figure."""
    buf = io.StringIO()
    fig.savefig(buf, format="svg", bbox_inches="tight")
    plt.close(fig)
    s = buf.getvalue()
    idx = s.find("<svg")
    return s[idx:] if idx != -1 else s


def _png_base64(fig: plt.Figure, dpi: int = 300) -> str:
    """Render a figure to a base64-encoded PNG data URI and close the figure."""
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=dpi, bbox_inches="tight")
    plt.close(fig)
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{b64}"


# ==============================================================================
# Atomic Drawing Helpers (_draw_*)
# Shared between existing page builders and standalone SVG/PNG figure functions
# ==============================================================================

def _draw_dispersion_curve(
    ax: plt.Axes,
    rec: Any,
    analysis_type: str = "CEST",
    show_anchors: bool = True,
    compact: bool = False,
):
    """Render CEST or CPMG profile curves with deduplicated legends and non-colliding A/B markers."""
    experiments = rec.get("experiments", [])
    handles = []
    labels = []

    for i, exp in enumerate(experiments):
        color = OKABE_ITO[i % len(OKABE_ITO)]
        b1_lbl = exp.get("b1_label", f"Field {i + 1}")
        ep = exp.get("exp_points", {})
        fc = exp.get("fit_curve", {})

        # Data points
        if ep.get("x") and ep.get("y"):
            h_data = ax.errorbar(
                ep["x"], ep["y"], yerr=ep.get("y_err"),
                fmt="o", color=color, markersize=3.5 if compact else 4.5,
                alpha=0.8, capsize=1.5, label=f"{b1_lbl} (Data)", zorder=3
            )
            handles.append(h_data)
            labels.append(f"{b1_lbl}")

        # Fit curve
        if fc.get("x") and fc.get("y"):
            h_fit, = ax.plot(fc["x"], fc["y"], "-", color=color, linewidth=1.5, label=f"{b1_lbl} (Fit)", zorder=2)

    # De-duplicate legend entries (Phase 3b)
    unique_handles_labels = {}
    for h, l in zip(handles, labels):
        if l not in unique_handles_labels:
            unique_handles_labels[l] = h

    if unique_handles_labels:
        ax.legend(
            unique_handles_labels.values(), unique_handles_labels.keys(),
            loc="lower left" if analysis_type != "CPMG" else "upper right",
            fontsize=7.5 if compact else 8.5, frameon=True, facecolor="white", edgecolor="#E5E7EB"
        )

    # Axis labeling and limits
    dw_status = rec["dw"].status.value if hasattr(rec["dw"].status, "value") else str(rec["dw"].status)
    ax.set_title(f"Residue: {rec['display_name']} ({dw_status})", fontsize=9.5 if compact else 11.5, fontweight="bold")
    if analysis_type != "CPMG":
        ax.set_xlabel("Offset (ppm)", fontsize=8.5 if compact else 9.5)
        ax.set_ylabel("I / I₀", fontsize=8.5 if compact else 9.5)
        ax.invert_xaxis()
    else:
        ax.set_xlabel(r"$\nu_{\mathrm{CPMG}}$ (Hz)", fontsize=8.5 if compact else 9.5)
        ax.set_ylabel(r"$R_{2,\mathrm{eff}}$ ($\mathrm{s}^{-1}$)", fontsize=8.5 if compact else 9.5)

    # Non-colliding A and B State Markers in Blended Coordinates (Phase 3a)
    if show_anchors and analysis_type != "CPMG":
        csa_val = rec["csa"].value
        csb_val = rec["csb"].value

        if csa_val is not None:
            ax.axvline(csa_val, color="#6B7280", linestyle="--", linewidth=0.8, alpha=0.6, zorder=1)
            ax.text(
                csa_val, 0.96, " A",
                transform=ax.get_xaxis_transform(),
                color="#4B5563", fontsize=8.5, fontweight="bold",
                va="top", ha="left", clip_on=True
            )

        if csb_val is not None:
            ax.axvline(csb_val, color="#DC2626", linestyle="--", linewidth=0.8, alpha=0.6, zorder=1)
            ax.text(
                csb_val, 0.96, " B",
                transform=ax.get_xaxis_transform(),
                color="#DC2626", fontsize=8.5, fontweight="bold",
                va="top", ha="left", clip_on=True
            )


def _draw_residuals_strip(
    ax: plt.Axes,
    rec: Any,
    analysis_type: str = "CEST",
):
    """Render normalized residuals (y - fit) / sigma strip."""
    experiments = rec.get("experiments", [])
    has_residuals = False

    for exp_i, exp in enumerate(experiments):
        color = OKABE_ITO[exp_i % len(OKABE_ITO)]
        ep = exp.get("exp_points", {})
        fc = exp.get("fit_curve", {})

        if ep.get("x") and ep.get("y"):
            x_pts = np.array(ep["x"])
            y_pts = np.array(ep["y"])
            y_errs = np.array(ep.get("y_err") or [1.0] * len(y_pts))
            y_errs = np.where(y_errs > 0, y_errs, 1.0)

            if fc.get("x") and fc.get("y"):
                fc_x = np.array(fc["x"])
                fc_y = np.array(fc["y"])
                sort_idx = np.argsort(fc_x)
                calc_interp = np.interp(x_pts, fc_x[sort_idx], fc_y[sort_idx])
                norm_residuals = (y_pts - calc_interp) / y_errs

                ax.scatter(x_pts, norm_residuals, color=color, s=20, alpha=0.8, edgecolors="none")
                has_residuals = True

    if has_residuals:
        ax.axhline(0.0, color="#666666", linestyle="-", linewidth=0.8)
        ax.axhline(1.0, color="#999999", linestyle="--", linewidth=0.6)
        ax.axhline(-1.0, color="#999999", linestyle="--", linewidth=0.6)
        ax.axhline(2.0, color="#E11D48", linestyle=":", linewidth=0.6)
        ax.axhline(-2.0, color="#E11D48", linestyle=":", linewidth=0.6)
        ax.set_ylabel(r"Residuals ($\sigma$)", fontsize=8.5)
        ax.set_ylim(-3.5, 3.5)
        if analysis_type != "CPMG":
            ax.set_xlabel("Offset / Chemical Shift (ppm)", fontsize=9.0)
        else:
            ax.set_xlabel(r"$\nu_{\mathrm{CPMG}}$ (Hz)", fontsize=9.0)
    else:
        ax.text(0.5, 0.5, "Residuals unavailable", ha="center", va="center", color="gray")


def _draw_kinetic_correlation(
    ax: plt.Axes,
    fig: Optional[plt.Figure] = None,
    grid_prof_2d: Optional[Tuple[Dict[str, Any], Optional[Dict[str, Any]]]] = None,
    samples_2d: Optional[Tuple[np.ndarray, np.ndarray]] = None,
    best_fit: Optional[Tuple[Optional[float], Optional[float]]] = None,
) -> bool:
    """Render 2D Grid Chi2 Confidence Contour or 2D Joint Density."""
    if grid_prof_2d is not None:
        surf, min_pt = grid_prof_2d
        X = np.array(surf["x"])
        Y = np.array(surf["y"])
        Z = np.array(surf["z_delta"])

        cs = ax.contourf(X, Y, Z, levels=[0, 2.30, 6.17, 11.83, 30.0], cmap="Blues_r", alpha=0.85)
        if fig is not None:
            cbar = fig.colorbar(cs, ax=ax, pad=0.02)
            cbar.set_label(r"$\Delta \chi^2$ from grid minimum", fontsize=9.5)

        ax.contour(X, Y, Z, levels=[2.30, 6.17, 11.83], colors=["#0072B2", "#00497A", "#00243D"], linewidths=[1.5, 1.2, 1.0])

        if min_pt and min_pt.get("coordinates"):
            mx = min_pt["coordinates"].get(surf["x_param"])
            my = min_pt["coordinates"].get(surf["y_param"])
            if mx is not None and my is not None:
                ax.scatter([mx], [my], color="#D55E00", marker="*", s=180, label="Grid Minimum (Best Fit)", zorder=10)
                ax.legend(loc="upper right", frameon=True, facecolor="white", edgecolor="#CCCCCC")

        ax.set_title(f"Kinetic Likelihood Surface: {surf['x_param']} vs {surf['y_param']} (2D Grid Search)", fontsize=12, fontweight="bold", pad=10)
        ax.set_xlabel(surf["x_param"], fontsize=10.0)
        ax.set_ylabel(surf["y_param"], fontsize=10.0)
        return True

    elif samples_2d is not None:
        pb_s, kex_s = samples_2d
        hb = ax.hexbin(pb_s * 100.0, kex_s, gridsize=30, cmap="Blues", mincnt=1)
        if fig is not None:
            fig.colorbar(hb, ax=ax, label="Sample Density")

        if best_fit is not None:
            pb_val, kex_val = best_fit
            if pb_val is not None and kex_val is not None:
                ax.scatter([pb_val], [kex_val], color="#D55E00", marker="*", s=160, label="Best Fit", zorder=10)
                ax.legend(loc="upper right")

        ax.set_title("Joint Posterior Density (Monte Carlo / Bootstrap Resampling)", fontsize=12, fontweight="bold", pad=10)
        ax.set_xlabel("Excited State Population p_b (%)", fontsize=10.0)
        ax.set_ylabel("Exchange Rate k_ex (s⁻¹)", fontsize=10.0)
        return True

    return False


def _draw_parameter_distribution(
    ax: plt.Axes,
    col_data: np.ndarray,
    p_raw: str,
):
    """Render marginal error distribution histogram and credible intervals for a single parameter."""
    valid = col_data[~np.isnan(col_data)]
    label = format_param_label(p_raw)
    is_pb = "PB" in p_raw.upper()
    if is_pb and np.nanmedian(valid) <= 1.0:
        valid = valid * 100.0

    if len(valid) >= 2:
        n_samples = len(valid)
        mean_val = float(np.mean(valid))
        std_val = float(np.std(valid))
        med_val = float(np.median(valid))
        p16, p84 = np.percentile(valid, [15.8655, 84.1345])
        p2_5, p97_5 = np.percentile(valid, [2.5, 97.5])
        skew_val = float(np.mean(((valid - mean_val) / std_val) ** 3)) if std_val > 0 else 0.0

        n_bins = min(30, max(10, int(np.sqrt(n_samples))))
        counts, bins, _ = ax.hist(
            valid, bins=n_bins, density=True, color="#0072B2",
            alpha=0.60, edgecolor="white", linewidth=0.6, zorder=2
        )

        ax.axvline(med_val, color="#D55E00", linestyle="-", linewidth=1.8, label=f"Median: {med_val:.3g}", zorder=4)
        ax.axvline(p16, color="#D55E00", linestyle="--", linewidth=1.1, label=f"68% CI: [{p16:.3g}, {p84:.3g}]", zorder=3)
        ax.axvline(p84, color="#D55E00", linestyle="--", linewidth=1.1, zorder=3)
        ax.axvline(p2_5, color="#CC79A7", linestyle=":", linewidth=1.0, label=f"95% CI: [{p2_5:.3g}, {p97_5:.3g}]", zorder=3)
        ax.axvline(p97_5, color="#CC79A7", linestyle=":", linewidth=1.0, zorder=3)

        ax.set_title(label, fontsize=9.5, fontweight="bold")
        ax.set_xlabel(label, fontsize=8.5)
        ax.set_ylabel("Probability Density", fontsize=8.0)
        ax.legend(loc="upper right", fontsize=6.8, frameon=True, facecolor="white", edgecolor="#E5E7EB", framealpha=0.9)

        stats_str = f"N={n_samples} | μ={mean_val:.3g} | σ={std_val:.3g} | Skew={skew_val:.2f}"
        ax.text(
            0.03, 0.95, stats_str,
            transform=ax.transAxes, fontsize=6.5, color="#374151",
            va="top", ha="left",
            bbox=dict(boxstyle="round,pad=0.3", facecolor="#F9FAFB", edgecolor="#E5E7EB", alpha=0.85)
        )
    else:
        ax.text(0.5, 0.5, f"Insufficient replicates\nfor {label}", ha="center", va="center", color="gray", fontsize=9.0)


def _draw_covariance_distribution(
    ax: plt.Axes,
    label: str,
    p_obj: Any,
):
    """Render analytical error distribution intervals from covariance uncertainties."""
    mu = float(p_obj.value or 0.0)
    sig = float(p_obj.sigma or (abs(mu) * 0.10 if abs(mu) > 0 else 1.0))

    if "p_b" in label and p_obj.unit == "%" and mu <= 1.0:
        mu = mu * 100.0
        sig = sig * 100.0

    bound_low = 0.0 if "k_ex" in label or "R₂" in label or "R₁" in label or ("p_b" in label and p_obj.unit == "%") else -np.inf
    sig1_l, sig1_r = max(bound_low, mu - sig), mu + sig
    sig2_l, sig2_r = max(bound_low, mu - 1.96 * sig), mu + 1.96 * sig

    ax.plot([sig2_l, sig2_r], [0, 0], color="#56B4E9", linewidth=3, solid_capstyle="round", label="95% CI (±1.96σ)")
    ax.plot([sig1_l, sig1_r], [0, 0], color="#0072B2", linewidth=6, solid_capstyle="round", label="68% CI (±1σ)")
    ax.scatter([mu], [0], color="#D55E00", marker="o", s=80, zorder=10, label=f"Best Fit: {mu:.3g}")

    if mu - sig < bound_low:
        ax.text(0.05, 0.90, "⚠ 1σ interval crosses physical bound\n(Parameter poorly constrained)", transform=ax.transAxes, color="#B91C1C", fontsize=9, fontweight="bold", va="top")

    ax.set_ylim(-1, 1)
    ax.set_yticks([])

    ax.set_title(f"{label} (Covariance ±1σ/±2σ)", fontsize=10, fontweight="bold", color="#111827", pad=8)
    ax.set_xlabel(f"Value [{p_obj.unit}]" if p_obj.unit else "Value", fontsize=9)
    ax.legend(loc="upper left" if mu < (sig1_l + sig1_r) / 2 else "upper right", fontsize=8, framealpha=0.9)

    stats_str = f"Fit={mu:.3g} | σ={sig:.3g} | 68% CI: [{sig1_l:.3g}, {sig1_r:.3g}] | Covariance"
    ax.text(
        0.02, -0.15, stats_str,
        transform=ax.transAxes, fontsize=6.5, color="#374151",
        va="top", ha="left",
        bbox=dict(boxstyle="round,pad=0.3", facecolor="#F9FAFB", edgecolor="#E5E7EB", alpha=0.85)
    )


def _draw_correlation_matrix(
    ax: plt.Axes,
    fig: Optional[plt.Figure],
    corr_mat: np.ndarray,
    labels: List[str],
    title: str = "Parameter Correlation Matrix",
):
    """Render correlation heatmap matrix with cell values and colorbar."""
    n_p = len(labels)
    im = ax.imshow(corr_mat, cmap="RdBu_r", vmin=-1.0, vmax=1.0, aspect="auto")

    if fig is not None:
        cbar = fig.colorbar(im, ax=ax, pad=0.03, fraction=0.046)
        cbar.set_label("Pearson Correlation Coefficient (r)", fontsize=8.5)
        cbar.set_ticks([-1.0, -0.5, 0.0, 0.5, 1.0])

    ax.set_xticks(range(n_p))
    ax.set_yticks(range(n_p))
    ax.set_xticklabels(labels, rotation=35, ha="right", fontsize=8.0)
    ax.set_yticklabels(labels, fontsize=8.0)
    ax.set_title(title, fontsize=11, fontweight="bold", pad=10)

    for r_i in range(n_p):
        for c_i in range(n_p):
            val = corr_mat[r_i, c_i]
            txt_color = "white" if abs(val) >= 0.55 else "black"
            ax.text(
                c_i, r_i, f"{val:.2f}",
                ha="center", va="center", color=txt_color,
                fontsize=7.5 if n_p > 6 else 8.5,
                fontweight="bold" if abs(val) >= 0.5 else "normal",
            )


def _draw_1d_grid_profile(
    ax: plt.Axes,
    prof: Dict[str, Any],
):
    """Render 1D Grid Search Chi2 profile with 1-sigma and 2-sigma thresholds."""
    x_pts = np.array(prof.get("x", []))
    dchi_pts = np.array(prof.get("delta_chisqr", []))
    p_name = format_param_label(prof.get("parameter", "Param"))

    if len(x_pts) > 0 and len(dchi_pts) > 0:
        ax.plot(x_pts, dchi_pts, "-", color="#0072B2", linewidth=1.8, label=r"$\Delta \chi^2$ Profile")
        ax.axhline(1.00, color="#D55E00", linestyle="--", linewidth=1.0, label=r"$\Delta\chi^2 = 1.00$ ($1\sigma$)")
        ax.axhline(3.84, color="#CC79A7", linestyle=":", linewidth=1.0, label=r"$\Delta\chi^2 = 3.84$ ($2\sigma$)")

        ax.set_title(p_name, fontsize=9.5, fontweight="bold")
        ax.set_xlabel(p_name, fontsize=8.5)
        ax.set_ylabel(r"$\Delta \chi^2$", fontsize=8.5)
        ax.set_ylim(0, max(10.0, min(50.0, np.nanmax(dchi_pts) if len(dchi_pts) else 10.0)))
        ax.legend(loc="upper right", fontsize=7.0, frameon=True, facecolor="white", edgecolor="#E5E7EB")
    else:
        ax.text(0.5, 0.5, f"No grid scan for {p_name}", ha="center", va="center", color="gray")


# ==============================================================================
# Standalone Figure Generation Functions (SVG / PNG Base64)
# ==============================================================================

def dispersion_curve(
    rec: Any,
    analysis_type: str = "CEST",
    compact: bool = False,
    show_anchors: bool = True,
) -> str:
    """Generate standalone SVG for CEST or CPMG dispersion profile."""
    fig, ax = plt.subplots(figsize=(3.2, 2.2) if compact else (6.4, 3.4))
    _draw_dispersion_curve(ax, rec, analysis_type=analysis_type, show_anchors=show_anchors, compact=compact)
    return _svg(fig)


def residuals_strip(
    rec: Any,
    analysis_type: str = "CEST",
) -> str:
    """Generate standalone SVG for normalized residuals strip."""
    fig, ax = plt.subplots(figsize=(6.4, 1.8))
    _draw_residuals_strip(ax, rec, analysis_type=analysis_type)
    return _svg(fig)


def detailed_residue_plot(
    rec: Any,
    analysis_type: str = "CEST",
) -> str:
    """Generate composite SVG containing both profile and residuals strip."""
    fig = plt.figure(figsize=(6.4, 4.4))
    gs = GridSpec(nrows=2, ncols=1, height_ratios=[0.70, 0.30], figure=fig, hspace=0.25)
    ax_profile = fig.add_subplot(gs[0])
    ax_residual = fig.add_subplot(gs[1], sharex=ax_profile)

    _draw_dispersion_curve(ax_profile, rec, analysis_type=analysis_type, show_anchors=True, compact=False)
    ax_profile.set_xlabel("")
    _draw_residuals_strip(ax_residual, rec, analysis_type=analysis_type)
    return _svg(fig)


def kinetic_correlation_plot(
    grid_prof_2d: Optional[Tuple[Dict[str, Any], Optional[Dict[str, Any]]]] = None,
    samples_2d: Optional[Tuple[np.ndarray, np.ndarray]] = None,
    best_fit: Optional[Tuple[Optional[float], Optional[float]]] = None,
    fmt: str = "png",
    dpi: int = 300,
) -> str:
    """
    Generate kinetic correlation / 2D likelihood contour figure.
    Defaults to 300 dpi base64 PNG data URI to avoid SVG bloat from dense contour paths.
    """
    fig, ax = plt.subplots(figsize=(6.4, 4.8))
    rendered = _draw_kinetic_correlation(ax, fig=fig, grid_prof_2d=grid_prof_2d, samples_2d=samples_2d, best_fit=best_fit)
    if not rendered:
        plt.close(fig)
        return ""
    if fmt.lower() == "svg":
        return _svg(fig)
    return _png_base64(fig, dpi=dpi)


def parameter_distribution_plot(
    col_data: np.ndarray,
    p_raw: str,
) -> str:
    """Generate standalone SVG for a parameter error distribution histogram."""
    fig, ax = plt.subplots(figsize=(4.0, 3.0))
    _draw_parameter_distribution(ax, col_data, p_raw)
    return _svg(fig)


def covariance_distribution_plot(
    label: str,
    p_obj: Any,
) -> str:
    """Generate standalone SVG for a covariance-derived confidence interval bar."""
    fig, ax = plt.subplots(figsize=(4.0, 2.5))
    _draw_covariance_distribution(ax, label, p_obj)
    return _svg(fig)


def correlation_matrix_plot(
    corr_mat: np.ndarray,
    labels: List[str],
    title: str = "Parameter Correlation Matrix",
    fmt: str = "png",
    dpi: int = 300,
) -> str:
    """
    Generate correlation matrix heatmap.
    Defaults to 300 dpi base64 PNG data URI to prevent dense artist SVG bloat.
    """
    fig, ax = plt.subplots(figsize=(6.0, 5.0))
    _draw_correlation_matrix(ax, fig=fig, corr_mat=corr_mat, labels=labels, title=title)
    if fmt.lower() == "svg":
        return _svg(fig)
    return _png_base64(fig, dpi=dpi)


def grid_1d_profile_plot(
    prof: Dict[str, Any],
) -> str:
    """Generate standalone SVG for a 1D grid search likelihood profile."""
    fig, ax = plt.subplots(figsize=(4.0, 3.0))
    _draw_1d_grid_profile(ax, prof)
    return _svg(fig)
