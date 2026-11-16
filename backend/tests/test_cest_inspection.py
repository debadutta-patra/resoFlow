"""One-state CEST fit (detection aid) and offset masks written into experiment TOML."""

import json
import math

import numpy as np
import pytest

from app.services.inspection.cest_one_state import (
    CestExperimentInput,
    fit_one_state,
    flag_high_r2,
    one_state_mz,
)
from app.services.inspection.cest_sources import (
    apply_plane_filter,
    cest_profiles_from_config,
    experiment_inputs,
    normalize_masks,
    sync_masks_into_experiments,
    time_t1_by_label,
)

XI = 0.101329118
B0 = 600.0
CARRIER = 118.0
T1 = 0.4


def _offsets(n=81, span_hz=1500.0):
    return np.linspace(-span_hz, span_hz, n)


def _synthetic(cs, r2, r1, b1, scale=1.0, noise=0.0, minor=None, seed=0):
    """I/I0 profile with a reference plane first; optional extra Lorentzian minor dip."""
    offs = _offsets()
    y = scale * one_state_mz(offs, cs, r2, r1, B0, b1, CARRIER, T1, XI)
    if minor:
        cs_b, depth, width_hz = minor
        hz_b = (cs_b - CARRIER) * B0 * XI
        y = y * (1 - depth / (1 + ((offs - hz_b) / width_hz) ** 2))
    rng = np.random.default_rng(seed)
    y = y + rng.normal(0, noise, y.size) if noise else y
    return [-100000.0] + offs.tolist(), [1.0] + y.tolist(), [0.005] * (offs.size + 1)


def _inputs(profile_kw, b1s=(25.0, 50.0)):
    out = []
    for b1 in b1s:
        offs, inten, unc = _synthetic(b1=b1, **profile_kw)
        out.append(CestExperimentInput(f"{B0:.0f}MHz_{b1:.0f}hz", B0, b1, CARRIER, T1, offs, inten, unc))
    return out


class TestOneStateModel:
    def test_no_b1_is_pure_r1_decay(self):
        mz = one_state_mz(np.array([0.0, 500.0]), 118.0, 12.0, 1.7, B0, 0.0, CARRIER, T1, XI)
        assert mz == pytest.approx([math.exp(-1.7 * T1)] * 2, rel=1e-9)

    def test_far_off_resonance_returns_to_r1_decay(self):
        mz = one_state_mz(np.array([-1500.0]), 119.0, 12.0, 1.5, B0, 30.0, CARRIER, T1, XI)
        assert mz[0] == pytest.approx(math.exp(-1.5 * T1), rel=5e-3)

    def test_profile_is_symmetric_about_cs(self):
        cs_hz = (119.0 - CARRIER) * B0 * XI
        d = np.array([3.0, 17.0, 60.0, 250.0])
        left = one_state_mz(cs_hz - d, 119.0, 12.0, 1.5, B0, 30.0, CARRIER, T1, XI)
        right = one_state_mz(cs_hz + d, 119.0, 12.0, 1.5, B0, 30.0, CARRIER, T1, XI)
        assert left == pytest.approx(right, abs=1e-12)

    def test_dip_broadens_with_b1(self):
        offs = _offsets(1201)
        def width(b1):
            mz = one_state_mz(offs, 118.0, 10.0, 1.5, B0, b1, CARRIER, T1, XI)
            half = (mz.min() + mz.max()) / 2
            return np.ptp(offs[mz < half])
        assert width(10.0) < width(25.0) < width(50.0)


class TestOneStateFit:
    def test_recovers_known_parameters_from_noiseless_data(self):
        fit = fit_one_state(_inputs(dict(cs=118.7, r2=11.0, r1=1.4, scale=0.98)), xi=XI, r1=1.4)
        assert fit["success"]
        assert fit["cs_a"] == pytest.approx(118.7, abs=1e-4)
        assert fit["r2"] == pytest.approx(11.0, rel=1e-4)
        assert fit["experiments"][0]["scale"] == pytest.approx(0.98, rel=1e-4)
        exp0 = fit["experiments"][0]
        assert max(abs(r) for r in exp0["residuals"]) < 1e-4
        assert len(exp0["curve"]["x_ppm"]) == 400
        # Reference plane is not part of the profile; x is in ppm around the carrier.
        assert len(exp0["x_ppm"]) == 81
        assert exp0["x_ppm"][40] == pytest.approx(CARRIER, abs=1e-9)

    def test_only_r2_minus_r1_is_identifiable(self):
        # Same data, different fixed R1: CS_A identical, R2 shifts by the R1 difference.
        inputs = _inputs(dict(cs=118.2, r2=12.0, r1=1.5))
        a = fit_one_state(inputs, xi=XI, r1=1.5)
        b = fit_one_state(inputs, xi=XI, r1=2.5)
        assert a["cs_a"] == pytest.approx(b["cs_a"], abs=1e-4)
        assert b["r2"] - a["r2"] == pytest.approx(1.0, rel=1e-3)
        assert b["chisqr"] == pytest.approx(a["chisqr"], abs=1e-12)

    def test_noisy_data_within_uncertainty(self):
        fit = fit_one_state(_inputs(dict(cs=117.4, r2=14.0, r1=1.6, noise=0.005, seed=3)), xi=XI)
        assert abs(fit["cs_a"] - 117.4) < 4 * fit["cs_a_err"] + 1e-3
        assert abs(fit["r2"] - 14.0) < 4 * fit["r2_err"] + 0.05
        assert fit["redchi"] == pytest.approx(1.0, abs=0.5)

    def test_unfit_minor_dip_inflates_r2_and_leaves_residual_structure(self):
        base = dict(cs=118.0, r2=10.0, r1=1.5)
        clean = fit_one_state(_inputs(base), xi=XI)
        minor = fit_one_state(_inputs({**base, "minor": (119.5, 0.25, 60.0)}), xi=XI)
        assert clean["r2"] == pytest.approx(10.0, rel=1e-4)
        assert minor["r2"] > clean["r2"] + 1.0
        res = np.array(minor["experiments"][0]["residuals"])
        x = np.array(minor["experiments"][0]["x_ppm"])
        # Most negative residual near the minor state.
        assert x[np.argmin(res)] == pytest.approx(119.5, abs=0.5)

    def test_masked_planes_are_excluded_from_the_fit(self):
        inputs = _inputs(dict(cs=118.0, r2=10.0, r1=1.5))
        # Corrupt one point, then mask its plane: the fit must be unaffected.
        bad_plane = 30
        for e in inputs:
            e.intensities = list(e.intensities)
            e.intensities[bad_plane] = 0.0
            e.masked_planes = [bad_plane]
        fit = fit_one_state(inputs, xi=XI)
        assert fit["r2"] == pytest.approx(10.0, rel=1e-3)
        used = fit["experiments"][0]["used"]
        planes = fit["experiments"][0]["planes"]
        assert used[planes.index(bad_plane)] is False

    def test_nothing_to_fit(self):
        assert fit_one_state([], xi=XI) is None
        e = CestExperimentInput("x", B0, 25.0, CARRIER, T1, [1.0, 2.0], [1.0, 1.0])
        assert fit_one_state([e], xi=XI) is None


class TestHighR2Flag:
    def test_robust_outlier(self):
        r2 = {f"{i}N": v for i, v in enumerate([10, 11, 9.5, 10.5, 10.2, 9.8, 25.0], start=1)}
        out = flag_high_r2(r2)
        assert out["median"] == pytest.approx(10.2)
        assert out["flagged"] == ["7N"]

    def test_needs_enough_residues_and_ignores_missing(self):
        assert flag_high_r2({"1N": 10, "2N": 50, "3N": None})["flagged"] == []

    def test_zero_mad_falls_back_to_ten_percent(self):
        out = flag_high_r2({f"{i}N": 10.0 for i in range(6)} | {"9N": 12.0})
        assert out["threshold"] == pytest.approx(11.0)
        assert out["flagged"] == ["9N"]


TOML = """[experiment]
name         = "cest_15n"
time_t1      = 0.4
carrier      = 118.0
b1_frq       = 25.0

[conditions]
h_larmor_frq = 600.0

[data]
path           = "../data/600MHz_25hz"
error          = "scatter"
filter_offsets = [[0.0, 25.0]]
  [data.profiles]
10N = "10N-HN.out"
"""


class TestMasksInToml:
    def test_inserts_replaces_and_removes_filter_planes(self):
        added = apply_plane_filter(TOML, [5, 2, 5])
        assert 'filter_offsets = [[0.0, 25.0]]\nfilter_planes  = [2, 5]\n  [data.profiles]' in added
        replaced = apply_plane_filter(added, [7])
        assert replaced.count("filter_planes") == 1 and "filter_planes  = [7]" in replaced
        assert apply_plane_filter(replaced, []) == TOML

    def test_does_not_touch_other_sections(self):
        toml = TOML.replace("[conditions]", "[conditions]\nfilter_planes = [1]")
        out = apply_plane_filter(toml, [3])
        assert "[conditions]\nfilter_planes = [1]" in out
        assert "filter_planes  = [3]" in out

    def test_sync_merges_global_planes_and_per_experiment_masks(self):
        cfg = {
            "filter_planes": [0],
            "cest_masks": {"600MHz_25hz": [4, 9], "600MHz_50hz": [1]},
            "generatedExperiments": [
                {"b1_label": "600MHz_25hz", "toml_content": TOML},
                {"b1_label": "600MHz_50hz", "type": "CEST", "toml_content": TOML},
                {"label": "600MHz_spec_3", "type": "CPMG", "toml_content": TOML},
            ],
        }
        exps = sync_masks_into_experiments(cfg)
        assert "filter_planes  = [0, 4, 9]" in exps[0]["toml_content"]
        assert "filter_planes  = [0, 1]" in exps[1]["toml_content"]
        assert "filter_planes" not in exps[2]["toml_content"]  # CPMG untouched

    def test_normalize_masks(self):
        assert normalize_masks({"a": [3, 1, 3, -1, 2.5, "x"], "b": [], "c": "no"}) == {"a": [1, 3]}
        assert normalize_masks(None) == {}


class TestSources:
    def test_time_t1_and_inputs_from_config(self, tmp_path):
        offs, inten, unc = _synthetic(cs=118.0, r2=10.0, r1=1.5, b1=25.0)
        data = tmp_path / "10N-HN.out"
        data.write_text("#Offset Intensity Unc\n" + "\n".join(f"{o} {i} {u}" for o, i, u in zip(offs, inten, unc)))
        cfg = {
            "data_files": {"10N:600MHz_25hz": str(data), "11N:600MHz_25hz": str(tmp_path / "missing.out")},
            "metadata": {"600MHz_25hz": {"b1": 25.0, "b0": 600.0, "carrier": 118.0}},
            "generatedExperiments": [{"b1_label": "600MHz_25hz", "toml_content": TOML}],
            "cest_masks": {"600MHz_25hz": [2]},
        }
        profiles = cest_profiles_from_config(cfg)
        assert [p["residue"] for p in profiles] == ["10N"]
        t1 = time_t1_by_label(cfg)
        assert t1 == {"600MHz_25hz": 0.4}
        inputs = experiment_inputs(profiles[0], t1, normalize_masks(cfg["cest_masks"]))
        assert inputs[0].time_t1 == 0.4 and list(inputs[0].masked_planes) == [2]
        fit = fit_one_state(inputs, xi=XI)
        assert fit["r2"] == pytest.approx(10.0, rel=1e-2)

    def test_exchange_layout_uses_stored_profiles(self):
        cfg = {"cest_profiles": [{"residue": "5N", "experiments": []}]}
        assert cest_profiles_from_config(cfg) == cfg["cest_profiles"]


def test_mask_state_survives_config_merge():
    from app.services.fitting.config_normalizer import merge_chemex_config

    merged = merge_chemex_config({"cest_masks": {"a": [1]}}, {"residue_review": {"pick_cest": {}}})
    assert merged["cest_masks"] == {"a": [1]}
    assert json.loads(json.dumps(merged))["residue_review"] == {"pick_cest": {}}


def test_one_state_endpoint_on_exchange_layout(tmp_path):
    """The router reads the Exchange config (stored profiles + generated TOML) and flags nothing
    with fewer than five residues."""
    from types import SimpleNamespace

    from app.routers.inspection import OneStateRequest, cest_one_state_fits

    run_dir = tmp_path / "exchange_fitting" / "an-1"
    run_dir.mkdir(parents=True)
    offs, inten, unc = _synthetic(cs=118.3, r2=9.0, r1=1.5, b1=25.0)
    cfg = {
        "cest_profiles": [{
            "residue": "7N",
            "experiments": [{"b1": "600MHz_25hz", "b1_actual": 25.0, "b0": 600.0, "carrier": 118.0,
                             "offsets": offs, "intensities": inten, "uncertainties": unc}],
        }],
        "generatedExperiments": [{"b1_label": "600MHz_25hz", "type": "CEST", "toml_content": TOML}],
    }
    (run_dir / "config.json").write_text(json.dumps(cfg))
    analysis = SimpleNamespace(
        analysis_type="EXCHANGE", analysis_uuid="an-1",
        project=SimpleNamespace(local_directory_path=str(tmp_path)),
    )
    out = cest_one_state_fits(OneStateRequest(), analysis=analysis)
    assert out["time_t1"] == {"600MHz_25hz": 0.4}
    assert out["fits"]["7N"]["cs_a"] == pytest.approx(118.3, abs=1e-3)
    assert out["fits"]["7N"]["r2"] == pytest.approx(9.0, rel=1e-3)
    assert out["r2_stats"]["flagged"] == []
