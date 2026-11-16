"""Rex with propagated error and pooled duplicate error (Inspect Dispersion screening)."""

import math
from types import SimpleNamespace

import pytest

from app.services.inspection.cpmg_screening import (
    group_by_nu,
    pooled_duplicate_error,
    rex_with_error,
    screen_profile,
)


def test_group_by_nu_groups_duplicates_in_ascending_order():
    assert group_by_nu([500.0, 50.0, 500.0, 1000.0, 50.0005]) == [[1, 4], [0, 2], [3]]


class TestRex:
    def test_means_at_extreme_nu_with_propagated_error(self):
        nu = [50, 50, 200, 1000, 1000, 1000]
        r2 = [20.0, 22.0, 15.0, 10.0, 11.0, 12.0]
        err = [0.6, 0.8, 0.5, 0.3, 0.3, 0.6]
        out = rex_with_error(nu, r2, err)
        assert out["rex"] == pytest.approx(21.0 - 11.0)
        # σ² = (0.36 + 0.64)/4 + (0.09 + 0.09 + 0.36)/9
        assert out["rex_err"] == pytest.approx(math.sqrt(1.0 / 4 + 0.54 / 9))
        assert (out["nu_low"], out["nu_high"], out["n_low"], out["n_high"]) == (50, 1000, 2, 3)

    def test_signed_not_clamped(self):
        out = rex_with_error([100, 1000], [10.0, 12.5], [0.3, 0.4])
        assert out["rex"] == pytest.approx(-2.5)
        assert out["rex_err"] == pytest.approx(0.5)

    def test_degenerate_inputs(self):
        assert rex_with_error([100], [10.0], [0.1])["rex"] is None
        assert rex_with_error([100, 100], [10.0, 11.0], [0.1, 0.1])["rex"] is None
        assert rex_with_error([100, 900], [10.0, 9.0], [0.0, 0.0])["rex_err"] is None


class TestPooledDuplicates:
    def test_pooled_sd_over_groups(self):
        # Group 1 (ν=50): 10, 12 → SS = 2, dof 1. Group 2 (ν=500): 5, 6, 7 → SS = 2, dof 2.
        nu = [50, 50, 200, 500, 500, 500]
        r2 = [10.0, 12.0, 8.0, 5.0, 6.0, 7.0]
        err = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5]
        out = pooled_duplicate_error(nu, r2, err)
        assert out["pooled_sd"] == pytest.approx(math.sqrt(4.0 / 3.0))
        assert (out["dof"], out["n_groups"]) == (3, 2)
        assert out["reported_rms"] == pytest.approx(0.5)
        assert out["ratio"] == pytest.approx(math.sqrt(4.0 / 3.0) / 0.5)

    def test_no_duplicates(self):
        out = pooled_duplicate_error([50, 100], [1.0, 2.0], [0.1, 0.1])
        assert out == {"pooled_sd": None, "dof": 0, "n_groups": 0, "reported_rms": None, "ratio": None}

    def test_identical_duplicates_give_zero_spread(self):
        assert pooled_duplicate_error([50, 50], [3.0, 3.0], [0.2, 0.2])["ratio"] == 0.0


class TestScreenProfile:
    def _exp(self, b0, spread, err=0.2):
        return {
            "b0": b0,
            "nu_cpmg": [50, 50, 100, 500, 1000, 1000],
            "r2eff": [20 + spread, 20 - spread, 18, 13, 10 + spread, 10 - spread],
            "r2eff_err": [err] * 6,
        }

    def test_flags_when_duplicate_spread_exceeds_factor_times_error(self):
        # spread ±1 → pooled SD = sqrt(4/2) = 1.414; ratio = 7.07 vs reported 0.2
        out = screen_profile([self._exp(600.26, 1.0), self._exp(800.0, 0.05)], factor=3)
        f600, f800 = out["fields"]
        assert f600["duplicates"]["ratio"] == pytest.approx(math.sqrt(2) / 0.2)
        assert f600["flagged"] and not f800["flagged"]
        assert out["flagged"] is True
        assert out["max_ratio"] == pytest.approx(math.sqrt(2) / 0.2)
        assert f600["rex"] == pytest.approx(10.0)
        assert f600["rex_err_pooled"] == pytest.approx(math.sqrt(2) * math.sqrt(1 / 2 + 1 / 2))
        assert out["rex_b0"] in (600.26, 800.0)

    def test_factor_is_configurable(self):
        assert screen_profile([self._exp(600, 1.0)], factor=10)["flagged"] is False

    def test_endpoint(self):
        from app.routers.inspection import CpmgScreeningRequest, cpmg_screening

        body = CpmgScreeningRequest(profiles=[{"residue": "5N", "experiments": [self._exp(600, 1.0)]}], factor=3)
        out = cpmg_screening(body, analysis=SimpleNamespace())
        assert out["residues"]["5N"]["flagged"] is True
        assert out["residues"]["5N"]["rex"] == pytest.approx(10.0)
