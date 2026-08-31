"""
Plotting styles and colorblind-safe palettes for resoFlow reports.
Implements Phase 3c specifications:
- Okabe-Ito color cycle (deuteranopia/protanopia/tritanopia safe)
- Two style modes: 'screen' and 'publication'
- Matplotlib context managers for thread-safe temporary styling
"""

import matplotlib as mpl
import matplotlib.pyplot as plt
from contextlib import contextmanager

# Okabe-Ito colorblind-safe cycle (Wong, Nature Methods 2011)
OKABE_ITO = [
    "#0072B2",  # Blue
    "#D55E00",  # Vermilion / Red-Orange
    "#009E73",  # Bluish Green
    "#E69F00",  # Orange
    "#56B4E9",  # Sky Blue
    "#CC79A7",  # Reddish Purple
    "#F0E442",  # Yellow
    "#000000",  # Black
]

SCREEN_RC_PARAMS = {
    "figure.facecolor": "#FFFFFF",
    "axes.facecolor": "#FAFAFA",
    "axes.edgecolor": "#CCCCCC",
    "axes.linewidth": 0.8,
    "axes.grid": True,
    "grid.color": "#E5E5E5",
    "grid.linestyle": "--",
    "grid.linewidth": 0.6,
    "grid.alpha": 0.8,
    "font.sans-serif": ["DejaVu Sans", "Helvetica", "Arial", "sans-serif"],
    "font.family": "sans-serif",
    "font.size": 9.0,
    "axes.titlesize": 11.0,
    "axes.titleweight": "bold",
    "axes.labelsize": 9.5,
    "axes.labelweight": "medium",
    "xtick.labelsize": 8.0,
    "ytick.labelsize": 8.0,
    "legend.fontsize": 8.5,
    "figure.dpi": 150,
    "savefig.dpi": 200,
    "axes.prop_cycle": mpl.cycler(color=OKABE_ITO),
}

PUBLICATION_RC_PARAMS = {
    "figure.facecolor": "#FFFFFF",
    "axes.facecolor": "#FFFFFF",
    "axes.edgecolor": "#222222",
    "axes.linewidth": 1.0,
    "axes.grid": True,
    "grid.color": "#EBEBEB",
    "grid.linestyle": ":",
    "grid.linewidth": 0.5,
    "grid.alpha": 0.7,
    "font.sans-serif": ["DejaVu Sans", "Arial", "Helvetica", "sans-serif"],
    "font.family": "sans-serif",
    "font.size": 9.5,
    "axes.titlesize": 11.5,
    "axes.titleweight": "bold",
    "axes.labelsize": 10.0,
    "axes.labelweight": "medium",
    "xtick.labelsize": 8.5,
    "ytick.labelsize": 8.5,
    "legend.fontsize": 8.5,
    "figure.dpi": 300,
    "savefig.dpi": 300,
    "axes.prop_cycle": mpl.cycler(color=OKABE_ITO),
}


@contextmanager
def apply_report_style(style_name: str = "publication"):
    """
    Context manager to apply screen or publication rcParams cleanly.
    """
    selected = PUBLICATION_RC_PARAMS if style_name.lower() == "publication" else SCREEN_RC_PARAMS
    with plt.style.context("default"):
        with mpl.rc_context(selected):
            yield
