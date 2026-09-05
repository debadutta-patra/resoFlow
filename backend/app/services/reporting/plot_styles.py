"""
Plotting styles and colorblind-safe palettes for resoFlow reports.
Implements Phase 3c specifications:
- Okabe-Ito color cycle (deuteranopia/protanopia/tritanopia safe)
- Two style modes: 'screen' and 'publication'
- Matplotlib context managers for thread-safe temporary styling
"""

import re
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any, Dict, List, Optional
import matplotlib as mpl
import matplotlib.pyplot as plt

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

PALETTES: Dict[str, List[str]] = {
    "okabe_ito": OKABE_ITO,
    "classic_blue": [
        "#1E40AF",  # Deep Navy
        "#0284C7",  # Sky Blue
        "#0D9488",  # Teal
        "#4F46E5",  # Indigo
        "#D97706",  # Amber
        "#DC2626",  # Red
        "#64748B",  # Slate
        "#1E293B",  # Dark Slate
    ],
    "emerald_green": [
        "#047857",  # Emerald
        "#059669",  # Mint Green
        "#0D9488",  # Teal
        "#10B981",  # Light Emerald
        "#D97706",  # Amber
        "#DC2626",  # Crimson
        "#475569",  # Slate
        "#1E293B",  # Dark Slate
    ],
    "crimson_rose": [
        "#BE123C",  # Crimson
        "#E11D48",  # Rose
        "#EA580C",  # Burnt Orange
        "#7C3AED",  # Purple
        "#4338CA",  # Indigo
        "#059669",  # Emerald
        "#475569",  # Slate
        "#1E293B",  # Dark Slate
    ],
    "amber_sunset": [
        "#C2410C",  # Burnt Orange
        "#D97706",  # Amber
        "#F59E0B",  # Golden
        "#7C3AED",  # Violet
        "#2563EB",  # Blue
        "#059669",  # Green
        "#4B5563",  # Cool Gray
        "#1F2937",  # Charcoal
    ],
    "deep_violet": [
        "#6D28D9",  # Violet
        "#7C3AED",  # Purple
        "#2563EB",  # Royal Blue
        "#059669",  # Emerald
        "#D97706",  # Amber
        "#DC2626",  # Red
        "#475569",  # Slate
        "#1E293B",  # Dark Slate
    ],
    "monochrome": [
        "#18181B",  # Charcoal
        "#3F3F46",  # Zinc Gray
        "#71717A",  # Neutral Gray
        "#A1A1AA",  # Light Zinc
        "#27272A",  # Dark Zinc
        "#52525B",  # Medium Zinc
        "#09090B",  # Near Black
        "#52525B",  # Mid Gray
    ],
}

PALETTE_METADATA: List[Dict[str, Any]] = [
    {
        "id": "okabe_ito",
        "name": "Colorblind-Safe",
        "description": "Accessible colorblind-safe palette (Nature Methods standard)",
        "primary": "#0072B2",
        "colors": PALETTES["okabe_ito"],
    },
    {
        "id": "classic_blue",
        "name": "Classic Navy",
        "description": "Traditional royal and navy blues with contrasting accents",
        "primary": "#1E40AF",
        "colors": PALETTES["classic_blue"],
    },
    {
        "id": "emerald_green",
        "name": "Emerald Green",
        "description": "Botanical viridian and forest greens",
        "primary": "#047857",
        "colors": PALETTES["emerald_green"],
    },
    {
        "id": "crimson_rose",
        "name": "Crimson Rose",
        "description": "Deep crimson, ruby red, and warm accents",
        "primary": "#BE123C",
        "colors": PALETTES["crimson_rose"],
    },
    {
        "id": "amber_sunset",
        "name": "Amber Sunset",
        "description": "Warm sunset amber, burnt orange, and violet accents",
        "primary": "#C2410C",
        "colors": PALETTES["amber_sunset"],
    },
    {
        "id": "deep_violet",
        "name": "Deep Violet",
        "description": "Rich violet, purple, and royal blue accents",
        "primary": "#6D28D9",
        "colors": PALETTES["deep_violet"],
    },
    {
        "id": "monochrome",
        "name": "Charcoal Monochrome",
        "description": "High-contrast slate and grayscale tones",
        "primary": "#18181B",
        "colors": PALETTES["monochrome"],
    },
]

HEX_COLOR_REGEX = re.compile(r"^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")

current_palette_var: ContextVar[List[str]] = ContextVar("current_palette_var", default=OKABE_ITO)


def get_current_palette() -> List[str]:
    """Return the active color cycle list from the current execution context."""
    return current_palette_var.get()


def get_plot_palette(palette_or_hex: Optional[str] = None) -> List[str]:
    """
    Resolve a palette name or custom hex color to a list of hex color strings.
    If a custom hex color is provided, it becomes the primary curve color.
    """
    if not palette_or_hex:
        return list(OKABE_ITO)

    raw = palette_or_hex.strip()
    norm = raw.lower().replace("-", "_").replace(" ", "_")

    if norm in PALETTES:
        return list(PALETTES[norm])

    # Check if raw string is a valid hex color (e.g. #10B981, 10b981, #0ea)
    if HEX_COLOR_REGEX.match(raw):
        hex_val = raw if raw.startswith("#") else f"#{raw}"
        # Expand 3-digit hex if needed
        if len(hex_val) == 4:
            hex_val = f"#{hex_val[1]*2}{hex_val[2]*2}{hex_val[3]*2}".upper()
        else:
            hex_val = hex_val.upper()

        # Build custom cycle with chosen hex as primary color
        cycle = [hex_val] + [c for c in OKABE_ITO if c.upper() != hex_val][:7]
        return cycle

    return list(OKABE_ITO)


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
def apply_report_style(style_name: str = "publication", palette: Optional[str] = None):
    """
    Context manager to apply screen or publication rcParams cleanly with optional color palette.
    Sets both matplotlib's axes.prop_cycle and current_palette_var for the duration of the context.
    """
    base_params = PUBLICATION_RC_PARAMS if style_name.lower() == "publication" else SCREEN_RC_PARAMS
    selected = dict(base_params)

    active_palette = get_plot_palette(palette)
    selected["axes.prop_cycle"] = mpl.cycler(color=active_palette)

    token = current_palette_var.set(active_palette)
    try:
        with plt.style.context("default"):
            with mpl.rc_context(selected):
                yield
    finally:
        current_palette_var.reset(token)
