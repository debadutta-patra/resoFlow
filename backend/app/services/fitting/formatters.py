"""
Significant-figure formatting utilities following Particle Data Group (PDG) / NIST conventions.
Used across table, derived-quantity cards, plot annotations, and PDF exports.
"""

from __future__ import annotations

import math
from typing import Optional, Tuple


def _superscript_exponent(exp: int) -> str:
    """Convert integer exponent to unicode superscript characters (e.g. -3 -> ⁻³)."""
    sup_map = {
        "-": "⁻",
        "+": "⁺",
        "0": "⁰",
        "1": "¹",
        "2": "²",
        "3": "³",
        "4": "⁴",
        "5": "⁵",
        "6": "⁶",
        "7": "⁷",
        "8": "⁸",
        "9": "⁹",
    }
    return "".join(sup_map.get(c, c) for c in str(exp))


def get_pdg_precision(error: float) -> Tuple[int, int]:
    """
    Given an uncertainty, determine the number of significant figures (1 or 2)
    and corresponding decimal places according to the Particle Data Group rule (cutoff: 355).
    Returns (decimals, sig_figs).
    """
    if error <= 0 or math.isnan(error) or math.isinf(error):
        return 2, 1

    exp = math.floor(math.log10(error))
    lead_two = error / (10.0 ** exp)
    # PDG rule: 2 sig figs if leading digits < 3.55 (i.e. 1.00..3.54), else 1 sig fig (3.55..9.99)
    sig_figs = 2 if lead_two < 3.55 else 1
    decimals = max(0, -exp + sig_figs - (0 if exp >= 1 else 1))
    return decimals, sig_figs


def format_uncertainty_pdg(
    val: Optional[float],
    err: Optional[float] = None,
    err_low: Optional[float] = None,
    err_high: Optional[float] = None,
    unit: str = "",
    use_unicode_superscript: bool = True,
    force_scientific: Optional[bool] = None,
) -> str:
    """
    Format value +/- error with NIST/PDG significant figure rounding and aligned precision.
    Supports grouped scientific notation: (3.60 +/- 0.06) x 10^-3
    and asymmetric intervals: 448.6 +18.2 / -15.4
    """
    if val is None or math.isnan(val):
        return "—"

    unit_str = f" {unit}" if unit else ""

    # Asymmetric Interval Case
    if err_low is not None and err_high is not None and not math.isnan(err_low) and not math.isnan(err_high):
        ref_err = max(abs(err_low), abs(err_high), 1e-15)
        is_sci = force_scientific if force_scientific is not None else (
            (abs(val) > 0 and (abs(val) < 0.001 or abs(val) >= 10000.0))
            or (ref_err < 0.001 or ref_err >= 10000.0)
        )

        if is_sci and abs(val) > 0:
            exp = math.floor(math.log10(abs(val)))
            scale = 10.0 ** exp
            v_s = val / scale
            el_s = err_low / scale
            eh_s = err_high / scale
            dec, _ = get_pdg_precision(ref_err / scale)
            exp_str = _superscript_exponent(exp) if use_unicode_superscript else f"^{exp}"
            return f"({v_s:.{dec}f} +{eh_s:.{dec}f} / -{el_s:.{dec}f}) × 10{exp_str}{unit_str}"
        else:
            dec, _ = get_pdg_precision(ref_err)
            return f"{val:.{dec}f} +{err_high:.{dec}f} / -{err_low:.{dec}f}{unit_str}"

    # Symmetric Error Case
    if err is not None and not math.isnan(err) and err > 0:
        is_sci = force_scientific if force_scientific is not None else (
            (abs(val) > 0 and (abs(val) < 0.001 or abs(val) >= 10000.0))
            or (err < 0.001 or err >= 10000.0)
        )

        if is_sci and abs(val) > 0:
            exp = math.floor(math.log10(abs(val)))
            scale = 10.0 ** exp
            v_s = val / scale
            e_s = err / scale
            dec, _ = get_pdg_precision(e_s)
            exp_str = _superscript_exponent(exp) if use_unicode_superscript else f"^{exp}"
            return f"({v_s:.{dec}f} ± {e_s:.{dec}f}) × 10{exp_str}{unit_str}"
        else:
            dec, _ = get_pdg_precision(err)
            return f"{val:.{dec}f} ± {err:.{dec}f}{unit_str}"

    # No Error Case
    is_sci = force_scientific if force_scientific is not None else (
        abs(val) > 0 and (abs(val) < 0.001 or abs(val) >= 10000.0)
    )
    if is_sci and abs(val) > 0:
        exp = math.floor(math.log10(abs(val)))
        scale = 10.0 ** exp
        v_s = val / scale
        exp_str = _superscript_exponent(exp) if use_unicode_superscript else f"^{exp}"
        return f"{v_s:.2f} × 10{exp_str}{unit_str}"
    else:
        if abs(val) >= 100:
            dec = 1
        elif abs(val) >= 10:
            dec = 2
        else:
            dec = 3
        return f"{val:.{dec}f}{unit_str}"
