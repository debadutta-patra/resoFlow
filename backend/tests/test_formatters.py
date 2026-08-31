import pytest
from app.services.fitting.formatters import format_uncertainty_pdg, get_pdg_precision


def test_pdg_sig_fig_rules():
    # 0.0091: leading is 9.1 >= 3.55 -> 1 sig fig -> 3 decimals
    dec, sigs = get_pdg_precision(0.0091)
    assert sigs == 1
    assert dec == 3

    # 16.5438: leading is 1.65 < 3.55 -> 2 sig figs -> 1 decimal
    dec, sigs = get_pdg_precision(16.5438)
    assert sigs == 2
    assert dec == 1


def test_prompt_table_examples():
    # Example 1: 113.6240 / 0.0091 -> 113.624 +/- 0.009
    res1 = format_uncertainty_pdg(113.6240, 0.0091)
    assert res1 == "113.624 ± 0.009"

    # Example 2: 448.6400 / 16.5438 -> 448.6 +/- 16.5
    res2 = format_uncertainty_pdg(448.6400, 16.5438)
    assert res2 == "448.6 ± 16.5"

    # Example 3: 0.0036 / 6.3330e-5 -> (3.60 +/- 0.06) x 10^-3
    res3 = format_uncertainty_pdg(0.0036, 6.3330e-5)
    assert res3 == "(3.60 ± 0.06) × 10⁻³"


def test_asymmetric_interval_formatting():
    res = format_uncertainty_pdg(448.64, err_low=15.4, err_high=18.2, unit="s⁻¹")
    assert res == "448.6 +18.2 / -15.4 s⁻¹"
