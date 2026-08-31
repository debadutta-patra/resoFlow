import pytest
import math
from app.services.fitting.cpmg_reduction import (
    compute_r2eff_profile,
    compute_rex_and_flatness,
    estimate_delta_omega_fast_exchange,
)
from app.services.fitting.cpmg_diagnostics import evaluate_cpmg_identifiability


def test_compute_r2eff_profile_valid():
    ncycs = [0.0, 2.0, 4.0, 8.0, 16.0]
    intensities = [1000.0, 800.0, 850.0, 900.0, 950.0]
    uncertainties = [20.0, 16.0, 17.0, 18.0, 19.0]
    time_t2 = 0.04

    res = compute_r2eff_profile(ncycs, intensities, uncertainties, time_t2)
    assert res["valid"] is True
    assert len(res["nu_cpmg"]) == 4
    assert res["nu_cpmg"][0] == 2.0 / 0.04  # 50.0 Hz
    assert res["nu_cpmg"][-1] == 16.0 / 0.04  # 400.0 Hz
    # R2eff = -ln(800/1000) / 0.04 = -(-0.22314) / 0.04 = 5.5786
    assert abs(res["r2eff"][0] - 5.5786) < 0.01
    assert len(res["r2eff_err"]) == 4
    assert all(e > 0 for e in res["r2eff_err"])


def test_compute_r2eff_profile_missing_reference():
    ncycs = [2.0, 4.0, 8.0]
    intensities = [800.0, 850.0, 900.0]
    res = compute_r2eff_profile(ncycs, intensities, None, 0.04)
    assert res["valid"] is False
    assert "Missing reference plane" in res["error"]


def test_compute_rex_and_flatness():
    nu_cpmg = [50.0, 100.0, 200.0, 400.0]
    # Dispersing curve: R2eff decreases from 15.0 to 10.0 => Rex = 5.0
    r2eff = [15.0, 13.5, 11.2, 10.0]
    r2eff_err = [0.2, 0.2, 0.2, 0.2]

    res = compute_rex_and_flatness(nu_cpmg, r2eff, r2eff_err)
    assert abs(res["rex"] - 5.0) < 0.01
    assert res["is_flat"] is False
    assert res["chi2_red"] > 2.0

    # Flat curve: R2eff ~ 10.0 across all frequencies
    r2eff_flat = [10.0, 10.05, 9.98, 10.02]
    res_flat = compute_rex_and_flatness(nu_cpmg, r2eff_flat, r2eff_err)
    assert abs(res_flat["rex"] - 0.0) < 0.1
    assert res_flat["is_flat"] is True
    assert res_flat["chi2_red"] < 1.0


def test_estimate_delta_omega_fast_exchange():
    # Rex = 5.0 s-1, kex = 1000 s-1, pb = 0.05, B0 = 600 MHz, xi = 0.101329 (15N)
    # pa = 0.95, pa*pb = 0.0475
    # dw_rad_s = sqrt(5.0 * 1000 / 0.0475) = sqrt(105263.15) = 324.44 rad/s
    # nu0 = 600 * 0.101329118 = 60.79747 MHz
    # dw_ppm = 324.44 / (2 * pi * 60.79747) = 0.849 ppm
    dw = estimate_delta_omega_fast_exchange(
        rex=5.0,
        kex=1000.0,
        pb=0.05,
        b0_mhz=600.0,
        xi_ratio=0.101329118,
    )
    assert abs(dw - 0.849) < 0.02


def test_evaluate_cpmg_identifiability():
    global_params = {
        "kex_ab": {"value": 80.0, "error": 10.0},
        "pb": {"value": 0.05, "error": 0.02},
    }
    residue_params = {
        "2N": {"dw_ab": {"value": 2.5, "error": 0.8}},
    }
    diag = evaluate_cpmg_identifiability(global_params, residue_params, num_fields=1)
    warning_codes = [w["code"] for w in diag["warnings"]]
    assert "SINGLE_FIELD" in warning_codes
    assert "KEX_TOO_SLOW" in warning_codes


def test_rc_cpmg_odd_cycle_filtering():
    # Simulating raw ncyc series with both even and odd cycles
    raw_ncycs = [0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0]
    intensities = [1000.0, 950.0, 900.0, 850.0, 800.0, 750.0, 700.0]
    uncertainties = [10.0] * 7

    filtered_points = [
        (n, i, e)
        for n, i, e in zip(raw_ncycs, intensities, uncertainties)
        if int(round(n)) % 2 == 0
    ]
    even_ncycs = [p[0] for p in filtered_points]
    even_ints = [p[1] for p in filtered_points]
    even_errs = [p[2] for p in filtered_points]

    assert even_ncycs == [0.0, 2.0, 4.0, 6.0]
    assert len(even_ints) == 4
    res = compute_r2eff_profile(even_ncycs, even_ints, even_errs, 0.04)
    assert res["valid"] is True
    assert len(res["nu_cpmg"]) == 3
    assert res["nu_cpmg"] == [50.0, 100.0, 150.0]

