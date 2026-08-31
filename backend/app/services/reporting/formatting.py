"""
Scientific formatting utilities for resoFlow report generator.
Conforms to Phase 1c rules:
- Rounds sigma to 1 significant figure, except 2 when leading digit is 1 or 2.
- Rounds value to the decimal place of sigma.
- Formats asymmetric errors as unicode superscript/subscript (e.g. 451 ⁺¹⁶₋₁₄) or LaTeX.
- Formats NONE source values at defensible precision with a footnote marker.
- Handles fixed parameters, derived quantities, non-finite values, and edge cases.
"""

from __future__ import annotations

import math
from typing import Optional, Union, Tuple


SUPERSCRIPT_MAP = {
    "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
    "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
    "+": "⁺", "-": "⁻", ".": "˙", " ": " ",
}

SUBSCRIPT_MAP = {
    "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄",
    "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
    "+": "₊", "-": "₋", ".": ".", " ": " ",
}

SOURCE_SUPERSCRIPTS = {
    "GRID": "ᵍ",
    "grid": "ᵍ",
    "RESAMPLED": "ᵐ",
    "resampled": "ᵐ",
    "MC": "ᵐ",
    "mc": "ᵐ",
    "BOOTSTRAP": "ᵇ",
    "bootstrap": "ᵇ",
    "BS": "ᵇ",
    "COVARIANCE": "ᶜ",
    "covariance": "ᶜ",
    "COV": "ᶜ",
    "NONE": "*",
    "none": "*",
}


def to_superscript(text: str) -> str:
    """Convert ASCII numbers/signs to unicode superscripts."""
    return "".join(SUPERSCRIPT_MAP.get(c, c) for c in text)


def to_subscript(text: str) -> str:
    """Convert ASCII numbers/signs to unicode subscripts."""
    return "".join(SUBSCRIPT_MAP.get(c, c) for c in text)


def _get_error_sig_figs_and_precision(err: float) -> Tuple[float, int]:
    """
    Determine rounded error and the number of decimal places (precision).
    Rule: 1 significant figure, except 2 when leading digit is 1 or 2.
    Returns (rounded_err, decimal_places).
    decimal_places > 0 means digits after decimal point (e.g. 2 for 0.01).
    decimal_places <= 0 means rounding to 10^(-decimal_places) (e.g. -1 for tens).
    """
    if err <= 0 or not math.isfinite(err):
        return 0.0, 0

    # Robust scientific notation parsing immune to IEEE-754 floor glitches
    sci_str = f"{err:.14e}"
    coeff_str, exp_str = sci_str.split("e")
    exponent = int(exp_str)
    # First non-zero character of coeff_str
    leading_digit = int(coeff_str.replace(".", "").lstrip("0")[0])

    sig_figs = 2 if leading_digit in (1, 2) else 1
    p = exponent - (sig_figs - 1)  # Power of 10 for least significant digit
    decimals = -p

    # Round error to precision
    if decimals >= 0:
        rounded_err = round(err, decimals)
    else:
        rounded_err = round(err, decimals)

    # Check if rounding caused a transition (e.g. 0.096 -> 0.10)
    if rounded_err > 0 and math.isfinite(rounded_err):
        new_sci = f"{rounded_err:.14e}"
        new_coeff, new_exp_str = new_sci.split("e")
        new_exp = int(new_exp_str)
        new_leading = int(new_coeff.replace(".", "").lstrip("0")[0])
        new_sig_figs = 2 if new_leading in (1, 2) else 1
        new_p = new_exp - (new_sig_figs - 1)
        new_decimals = -new_p
        decimals = max(decimals, new_decimals)
        if decimals >= 0:
            rounded_err = round(err, decimals)

    return rounded_err, decimals


def _format_number_to_decimals(val: float, decimals: int) -> str:
    """Format a float to exact decimal places (or integer if decimals <= 0)."""
    if not math.isfinite(val):
        if math.isnan(val):
            return "NaN"
        return "∞" if val > 0 else "-∞"

    if decimals > 0:
        return f"{val:.{decimals}f}"
    elif decimals == 0:
        return f"{round(val):.0f}"
    else:
        # e.g. decimals = -1 -> round to nearest 10
        factor = 10.0 ** (-decimals)
        rounded = round(val / factor) * factor
        return f"{rounded:.0f}"


def format_defensible_value(val: float, max_sig_figs: int = 3) -> str:
    """
    Format a bare value with defensible precision (default max 3 significant figures).
    Avoids leaking 6-decimal unrounded floats when uncertainty is unavailable.
    """
    if not math.isfinite(val):
        if math.isnan(val):
            return "NaN"
        return "∞" if val > 0 else "-∞"

    if val == 0.0:
        return "0"

    abs_val = abs(val)
    exponent = math.floor(math.log10(abs_val))
    decimals = max_sig_figs - 1 - exponent

    if -3 <= exponent <= 4:
        if decimals > 0:
            s = f"{val:.{decimals}f}".rstrip("0").rstrip(".")
            return s if s else "0"
        else:
            return f"{val:.0f}"
    else:
        # Scientific notation for very large / very small numbers
        return f"{val:.{max_sig_figs - 1}e}"


def format_with_error(
    value: Optional[float],
    err_low: Optional[float] = None,
    err_high: Optional[float] = None,
    unit: Optional[str] = None,
    source: Optional[str] = None,
    status: str = "FITTED",
    style: str = "unicode",  # "unicode" | "latex" | "ascii"
) -> str:
    """
    Primary scientific formatting function for resoFlow reports and tables.

    Parameters:
      value: The central measured or calculated parameter value.
      err_low: Lower uncertainty bound (positive float or None). If err_high is None,
               err_low is treated as symmetric error sigma.
      err_high: Upper uncertainty bound (positive float or None). If provided and
                differs from err_low, formats as asymmetric error.
      unit: Optional unit string (e.g. "s⁻¹", "ppm", "ns", "%", "Hz").
      source: Source tag ('GRID', 'RESAMPLED', 'COVARIANCE', 'NONE').
      status: Parameter status ('FITTED', 'FIXED', 'DERIVED', 'AT_BOUND', 'NOT_IN_MODEL').
      style: Output format ('unicode', 'latex', 'ascii').

    Returns:
      Formatted scientific string adhering to strict sig-fig and precision rules.
    """
    status_upper = status.upper().strip() if status else "FITTED"
    unit_str = f" {unit}" if unit else ""

    # 1. NOT_IN_MODEL -> omit
    if status_upper == "NOT_IN_MODEL":
        return "—"

    # 2. None / Missing value
    if value is None:
        return "—"

    # 3. Non-finite values
    if not math.isfinite(value):
        nan_str = "NaN" if math.isnan(value) else ("∞" if value > 0 else "-∞")
        return f"{nan_str}{unit_str}"

    # 4. FIXED status
    if status_upper == "FIXED":
        val_formatted = format_defensible_value(value, max_sig_figs=3)
        if unit:
            return f"fixed at {val_formatted} {unit}"
        return f"fixed at {val_formatted}"

    # 5. Determine uncertainty structure
    # Check if symmetric error was passed in err_low alone
    if err_low is not None and err_high is None:
        sigma = err_low
        is_asymmetric = False
    elif err_low is None and err_high is not None:
        sigma = err_high
        is_asymmetric = False
    elif err_low is not None and err_high is not None:
        # Check if symmetric within floating point precision
        if math.isfinite(err_low) and math.isfinite(err_high) and abs(err_low - err_high) < 1e-12 * max(abs(err_low), 1.0):
            sigma = err_low
            is_asymmetric = False
        else:
            sigma = None
            is_asymmetric = True
    else:
        sigma = None
        is_asymmetric = False

    src_upper = source.upper().strip() if source else None
    src_badge = SOURCE_SUPERSCRIPTS.get(src_upper, "") if src_upper else ""

    # 6. Case A: NO Uncertainty Available (source == NONE or sigma is None / non-finite / <= 0)
    has_valid_error = (
        (sigma is not None and math.isfinite(sigma) and sigma > 0)
        or (is_asymmetric and err_low is not None and err_high is not None and
            math.isfinite(err_low) and math.isfinite(err_high) and (err_low > 0 or err_high > 0))
    )

    if not has_valid_error:
        val_str = format_defensible_value(value, max_sig_figs=3)
        # Add footnote badge if source is NONE or unspecified
        badge = src_badge if src_badge else "*"
        return f"{val_str}{badge}{unit_str}"

    # 7. Case B: Symmetric Uncertainty (value ± sigma)
    if not is_asymmetric and sigma is not None:
        rounded_sigma, decimals = _get_error_sig_figs_and_precision(sigma)
        val_str = _format_number_to_decimals(value, decimals)
        sig_str = _format_number_to_decimals(rounded_sigma, decimals)

        if style == "latex":
            res = f"{val_str} \\pm {sig_str}"
        else:
            res = f"{val_str} ± {sig_str}"

        if src_badge and src_badge != "*":
            res = f"{res}{src_badge}"

        return f"{res}{unit_str}"

    # 8. Case C: Asymmetric Uncertainty (value ⁺err_high₋err_low)
    if is_asymmetric and err_low is not None and err_high is not None:
        _, dec_low = _get_error_sig_figs_and_precision(err_low)
        _, dec_high = _get_error_sig_figs_and_precision(err_high)
        # Use the finer decimal place of the two
        decimals = max(dec_low, dec_high)

        val_str = _format_number_to_decimals(value, decimals)
        err_h_str = _format_number_to_decimals(err_high, decimals)
        err_l_str = _format_number_to_decimals(err_low, decimals)

        if style == "latex":
            res = f"{val_str}^{{+{err_h_str}}}_{{-{err_l_str}}}"
        elif style == "ascii":
            res = f"{val_str} (+{err_h_str}/-{err_l_str})"
        else:
            # Unicode superscript and subscript
            sup_part = to_superscript(f"+{err_h_str}")
            sub_part = to_subscript(f"-{err_l_str}")
            res = f"{val_str} {sup_part}{sub_part}"

        if src_badge and src_badge != "*":
            res = f"{res}{src_badge}"

        return f"{res}{unit_str}"

    # Fallback
    val_str = format_defensible_value(value, max_sig_figs=3)
    return f"{val_str}{unit_str}"


def format_value_with_error_latex(
    value: Optional[float],
    err_low: Optional[float] = None,
    err_high: Optional[float] = None,
    unit: Optional[str] = None,
    source: Optional[str] = None,
    status: str = "FITTED",
) -> str:
    """Convenience wrapper for LaTeX formatted error output."""
    return format_with_error(
        value,
        err_low=err_low,
        err_high=err_high,
        unit=unit,
        source=source,
        status=status,
        style="latex",
    )
