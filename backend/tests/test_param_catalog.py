"""The method-parameters catalogue is derived from the installed ChemEx."""

from __future__ import annotations

import pytest

from app.services.fitting.param_catalog import get_method_parameter_catalog, method_parameters_response
from resoflow.chemex_api.compat import verify_hooks
from resoflow.chemex_api.defaults import parameter_defaults

LEGACY_KEYS = {"name", "gloss", "scope", "default_mode", "category", "is_primary"}


def _by_name(model: str) -> dict[str, dict]:
    return {p["name"]: p for p in get_method_parameter_catalog(model)}


def test_defaults_hook_verified() -> None:
    assert verify_hooks() is True


def test_2st_matches_chemex_defaults_and_keeps_legacy_order() -> None:
    rows = get_method_parameter_catalog("2st")
    assert [r["name"] for r in rows] == ["PB", "KEX_AB", "CS_A", "DW_AB", "R1_A", "R2_A", "R1_B", "R2_B", "TAUC_A"]
    by = {r["name"]: r for r in rows}
    assert (by["PB"]["default_value"], by["PB"]["lower"], by["PB"]["upper"]) == (0.05, 0.0, 1.0)
    assert by["PB"]["default_role"] == "fit"
    assert "0 - 1" in by["PB"]["gloss"] and by["PB"]["hint"] == "typically < 0.5"
    assert (by["KEX_AB"]["default_value"], by["KEX_AB"]["upper"]) == (200.0, 1e6)
    assert (by["CS_A"]["default_value"], by["CS_A"]["lower"], by["CS_A"]["upper"]) == (0.0, -100.0, 300.0)
    assert (by["DW_AB"]["lower"], by["DW_AB"]["upper"], by["DW_AB"]["default_role"]) == (-100.0, 100.0, "fit")
    assert by["R2_B"]["default_expression"] == "[R2_A]" and by["R2_B"]["derived"] is True
    assert by["TAUC_A"]["scope"] == "global" and by["TAUC_A"]["is_primary"] is False


def test_endpoint_shape_is_a_superset_of_the_legacy_one() -> None:
    body = method_parameters_response("2st")
    assert body["model"] == "2st" and body["source"] == "chemex" and body["chemex_version"]
    for row in body["parameters"]:
        assert LEGACY_KEYS <= set(row)
        # Never a v1 inequality: the Methods tab would flag it as an ignored legacy bound.
        assert row["default_bounds"] is None


def test_3st_has_second_population_and_all_kex() -> None:
    by = _by_name("3st")
    assert by["PC"]["default_value"] == 0.02 and by["PB"]["default_value"] == 0.02
    assert {"KEX_AB", "KEX_AC", "KEX_BC", "DW_AC", "R2_C"} <= set(by)


def test_binding_model_has_kd_koff_and_no_free_pb() -> None:
    by = _by_name("2st_binding")
    assert {"KD", "KOFF"} <= set(by)
    assert "PB" not in by  # PB is derived from KD in binding models


def test_tc_model_exposes_tref_and_coefficients() -> None:
    by = _by_name("2st.tc")
    tref = by["TREF"]
    assert tref["protected"] is True and tref["default_role"] == "protected"
    assert (tref["default_value"], tref["lower"], tref["upper"]) == (25.0, None, None)
    assert (by["CS1_A"]["lower"], by["CS1_A"]["upper"]) == (-1.0, 1.0)
    assert by["DW0_AB"]["default_role"] == "fit" and by["DW1_AB"]["default_role"] == "fit"
    # CS_A and DW_AB are model-owned expressions under .tc, so they are not editable rows.
    assert "CS_A" not in by and "DW_AB" not in by


def test_condition_dependent_models_are_flagged() -> None:
    assert any(d.condition_dependent for d in parameter_defaults("2st_eyring"))
    assert not any(d.condition_dependent for d in parameter_defaults("2st"))


def test_unknown_model_falls_back_without_error() -> None:
    body = method_parameters_response("not_a_model")
    assert body["source"] == "fallback"
    assert {r["name"] for r in body["parameters"]} >= {"PB", "KEX_AB"}


@pytest.mark.parametrize("model", ["1st", "2st", "3st", "4st", "2st_hd", "2st_eyring", "3st_binding_cs", "2st.mf", "3st.tc"])
def test_every_model_builds(model: str) -> None:
    rows = get_method_parameter_catalog(model)
    assert rows and all(r["scope"] in ("global", "residue") for r in rows)
