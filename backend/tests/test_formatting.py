"""
Unit tests for scientific formatting module conforming to Phase 1c specifications.
Tests sig-fig rules, decimal place alignment, asymmetric errors, source tags,
fixed parameters, and non-finite edge cases.
"""

import math
import pytest
from app.services.reporting.formatting import (
    format_with_error,
    format_value_with_error_latex,
    format_defensible_value,
    _get_error_sig_figs_and_precision,
    to_superscript,
    to_subscript,
)


class TestScientificFormatting:
    """Test suite for format_with_error and precision alignment rules."""

    @pytest.mark.parametrize(
        "err, expected_rounded, expected_decimals",
        [
            # Leading digit 1 -> 2 sig figs
            (15.3, 15.0, 0),
            (0.0143, 0.014, 3),
            (0.1046, 0.10, 2),
            (0.00192, 0.0019, 4),
            # Leading digit 2 -> 2 sig figs
            (25.4, 25.0, 0),
            (0.28, 0.28, 2),
            (0.0211, 0.021, 3),
            # Leading digit 3..9 -> 1 sig fig
            (45.2, 50.0, -1),
            (0.0436, 0.04, 2),
            (0.0691, 0.07, 2),
            (0.00707, 0.007, 3),
            (8.76, 9.0, 0),
            (0.00034, 0.0003, 4),
        ],
    )
    def test_error_sig_figs_and_precision(self, err, expected_rounded, expected_decimals):
        rounded, decimals = _get_error_sig_figs_and_precision(err)
        assert decimals == expected_decimals
        assert abs(rounded - expected_rounded) < 1e-6

    @pytest.mark.parametrize(
        "value, err, unit, source, status, expected",
        [
            # Case 1: Prompt example: 451.28 ± 15.3 -> 451 ± 15
            (451.28, 15.3, None, None, "FITTED", "451 ± 15"),
            # Case 2: Prompt example with unit
            (451.28, 15.3, "s⁻¹", None, "FITTED", "451 ± 15 s⁻¹"),
            # Case 3: Leading digit 1 in decimals (R1_A style)
            (1.96616, 0.0143, "s⁻¹", None, "FITTED", "1.966 ± 0.014 s⁻¹"),
            # Case 4: Leading digit 4 (DW_AB style)
            (4.70659, 0.0436, "ppm", None, "FITTED", "4.71 ± 0.04 ppm"),
            # Case 5: Leading digit 6 (DW_AB style)
            (6.62457, 0.0691, "ppm", None, "FITTED", "6.62 ± 0.07 ppm"),
            # Case 6: Leading digit 1 in R2_A style
            (9.97899, 0.1046, "s⁻¹", None, "FITTED", "9.98 ± 0.10 s⁻¹"),
            # Case 7: Leading digit 2 in R2_B style
            (5.40871, 0.28, "s⁻¹", None, "FITTED", "5.41 ± 0.28 s⁻¹"),
            # Case 8: Leading digit 7 in small error
            (1.60494, 0.00707, "s⁻¹", None, "FITTED", "1.605 ± 0.007 s⁻¹"),
            # Case 9: Source tag COVARIANCE (superscript c)
            (451.28, 15.3, "s⁻¹", "COVARIANCE", "FITTED", "451 ± 15ᶜ s⁻¹"),
            # Case 10: Source tag GRID (superscript g)
            (451.28, 15.3, "s⁻¹", "GRID", "FITTED", "451 ± 15ᵍ s⁻¹"),
            # Case 11: Source tag RESAMPLED (superscript m)
            (451.28, 15.3, "s⁻¹", "RESAMPLED", "FITTED", "451 ± 15ᵐ s⁻¹"),
            # Case 12: Source NONE -> defensible precision + footnote marker
            (1.96442, None, "s⁻¹", "NONE", "FITTED", "1.96* s⁻¹"),
            # Case 13: Source NONE with large value
            (451.28, None, "s⁻¹", "NONE", "FITTED", "451* s⁻¹"),
            # Case 14: FIXED status -> "fixed at <val> <unit>"
            (1.5, None, "ns", None, "FIXED", "fixed at 1.5 ns"),
            # Case 15: FIXED status for chemical shift
            (113.589, None, "ppm", None, "FIXED", "fixed at 114 ppm"),
            # Case 16: NOT_IN_MODEL status -> omitted entirely
            (0.0, None, "ns", None, "NOT_IN_MODEL", "—"),
            # Case 17: value >> sigma
            (100000.0, 0.014, None, None, "FITTED", "100000.000 ± 0.014"),
            # Case 18: value << sigma
            (0.0012, 50.0, None, None, "FITTED", "0 ± 50"),
            # Case 19: sigma is zero -> fallback to footnote
            (451.28, 0.0, "s⁻¹", None, "FITTED", "451* s⁻¹"),
            # Case 20: sigma is negative -> fallback to footnote
            (451.28, -5.0, "s⁻¹", None, "FITTED", "451* s⁻¹"),
            # Case 21: value is NaN
            (float("nan"), 1.0, "ppm", None, "FITTED", "NaN ppm"),
            # Case 22: value is Inf
            (float("inf"), 1.0, "s⁻¹", None, "FITTED", "∞ s⁻¹"),
            # Case 23: value is None
            (None, 1.0, "s⁻¹", None, "FITTED", "—"),
        ],
    )
    def test_format_with_error_symmetric_and_special(self, value, err, unit, source, status, expected):
        result = format_with_error(value, err_low=err, unit=unit, source=source, status=status)
        assert result == expected

    def test_asymmetric_error_formatting(self):
        """Test asymmetric confidence intervals with unicode superscripts and subscripts."""
        # 451.28 with err_low=14.2, err_high=16.1
        # high: 16.1 -> 16 (leading 1, 2 sig figs, units place)
        # low: 14.2 -> 14 (leading 1, 2 sig figs, units place)
        res = format_with_error(451.28, err_low=14.2, err_high=16.1, unit="s⁻¹", source="GRID")
        assert "451" in res
        assert to_superscript("+16") in res
        assert to_subscript("-14") in res
        assert "ᵍ" in res
        assert "s⁻¹" in res

    def test_asymmetric_error_latex(self):
        """Test asymmetric error formatting in LaTeX style."""
        res = format_value_with_error_latex(451.28, err_low=14.2, err_high=16.1, unit="s^{-1}")
        assert res == "451^{+16}_{-14} s^{-1}"

    def test_defensible_value_precision(self):
        """Verify format_defensible_value caps precision at 3 significant figures."""
        assert format_defensible_value(1.96442, max_sig_figs=3) == "1.96"
        assert format_defensible_value(451.28, max_sig_figs=3) == "451"
        assert format_defensible_value(0.00353022, max_sig_figs=3) == "0.00353"
        assert format_defensible_value(0.0, max_sig_figs=3) == "0"
