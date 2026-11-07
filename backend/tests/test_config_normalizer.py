"""Unified Parameters/Methods config schema across CEST, CPMG and EXCHANGE."""

from app.services.fitting.config_normalizer import merge_chemex_config, normalize_chemex_config
from app.services.fitting.param_catalog import get_method_parameter_catalog, method_parameters_response


def test_legacy_cpmg_keys_are_promoted_to_canonical():
    legacy = {
        "parameterConfig": {"globals": {"pb": {"value": 0.1}}},
        "methodConfig": {"steps": [{"name": "S1"}]},
        "fitMode": "individual",
    }
    out = normalize_chemex_config(legacy)
    assert out["parameter_config"] == legacy["parameterConfig"]
    assert out["method_config"] == legacy["methodConfig"]
    assert out["fit_mode"] == "individual"
    # input is not mutated
    assert "parameter_config" not in legacy


def test_canonical_value_wins_over_alias():
    out = normalize_chemex_config(
        {"method_config": {"steps": [{"name": "NEW"}]}, "methodConfig": {"steps": [{"name": "OLD"}]}}
    )
    assert out["method_config"]["steps"][0]["name"] == "NEW"


def test_exchange_parameters_toml_alias_round_trips():
    out = normalize_chemex_config({"parameters_toml": "[GLOBAL]\nPB = 0.1\n"})
    assert out["parameter_toml"] == "[GLOBAL]\nPB = 0.1\n"
    # canonical value is mirrored back for older readers
    out2 = normalize_chemex_config({"parameter_toml": "X"})
    assert out2["parameters_toml"] == "X"


def test_merge_legacy_update_replaces_stale_canonical():
    existing = {"parameter_config": {"globals": {"pb": {"value": 0.05}}}, "spectrum_ids": [1]}
    merged = merge_chemex_config(existing, {"parameterConfig": {"globals": {"pb": {"value": 0.2}}}})
    assert merged["parameter_config"]["globals"]["pb"]["value"] == 0.2
    assert "parameterConfig" not in merged
    assert merged["spectrum_ids"] == [1]


def test_merge_preserves_unrelated_keys():
    merged = merge_chemex_config({"picks": {"1N": {}}, "model": "2st"}, {"model": "3st_binding"})
    assert merged == {"picks": {"1N": {}}, "model": "3st_binding"}


def test_catalog_is_shared_and_model_aware():
    two = [p["name"] for p in get_method_parameter_catalog("2st")]
    three = [p["name"] for p in get_method_parameter_catalog("3st_binding")]
    assert two == ["PB", "KEX_AB", "CS_A", "DW_AB", "R1_A", "R2_A", "R1_B", "R2_B", "TAUC_A"]
    assert {"PC", "KEX_AC", "KEX_BC", "DW_AC"} <= set(three)
    tauc = next(p for p in get_method_parameter_catalog("2st") if p["name"] == "TAUC_A")
    assert "(ns)" in tauc["gloss"]


def test_catalog_returns_copies():
    a = get_method_parameter_catalog("2st")
    a[0]["name"] = "MUTATED"
    assert get_method_parameter_catalog("2st")[0]["name"] == "PB"


def test_all_endpoints_serve_the_same_catalog():
    from app.routers import analysis, cpmg, exchange

    expected = method_parameters_response("2st")
    assert analysis.get_cest_method_parameters(model="2st", analysis=None) == expected
    assert cpmg.get_cpmg_method_parameters(model="2st", analysis=None, current_user=None) == expected
    assert exchange.get_exchange_method_parameters(model="2st", analysis=None, current_user=None) == expected


def test_chemex_sources_of_any_type_are_inheritable():
    from app.services.fitting.chemex_parser import evaluate_source_compatibility

    target = {"analysis_type": "CPMG", "model": "2st", "nucleus": "15N", "temperature": 298.15}
    for src_type in ["15N-CEST", "CEST", "CPMG", "EXCHANGE"]:
        ok, block, _ = evaluate_source_compatibility({**target, "analysis_type": src_type}, target)
        assert ok, (src_type, block)
    ok, block, _ = evaluate_source_compatibility({**target, "analysis_type": "R1"}, target)
    assert not ok and any("experiment type" in b for b in block)


def test_run_dirs_resolve_per_experiment(tmp_path):
    import json
    from types import SimpleNamespace

    from app.services.fitting.run_dirs import chemex_run_dir, load_chemex_config

    project = SimpleNamespace(local_directory_path=str(tmp_path))
    cpmg = SimpleNamespace(analysis_type="CPMG", analysis_uuid="u1", project=project)
    cest = SimpleNamespace(analysis_type="15N-CEST", analysis_uuid="u2", project=project)
    assert chemex_run_dir(cpmg).endswith("cpmg_fitting/u1")
    assert chemex_run_dir(cest).endswith("cest_fitting/u2")

    run_dir = tmp_path / "cpmg_fitting" / "u1"
    run_dir.mkdir(parents=True)
    (run_dir / "cpmg_config.json").write_text(json.dumps({"fitMode": "individual"}))
    assert load_chemex_config(cpmg)["fit_mode"] == "individual"
    assert load_chemex_config(cest) == {}
