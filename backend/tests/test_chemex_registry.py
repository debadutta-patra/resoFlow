import pytest
from app.services.fitting.chemex_registry import (
    get_chemex_module_registry,
    get_module_schema,
    resolve_module_name,
)

def test_registry_contains_expected_modules():
    registry = get_chemex_module_registry()
    assert "cest_15n" in registry
    assert "cpmg_15n_ip" in registry
    assert "cpmg_15n_tr" in registry
    assert "cpmg_15n_rc" in registry
    assert "cpmg_ch3_mq" in registry

def test_cest_15n_schema():
    schema = get_module_schema("cest_15n")
    assert schema is not None
    assert schema["family"] == "cest"
    assert schema["probe"] == "15N"
    assert schema["spin_system_format"]["format"] == "single_15n"
    
    sections = schema["sections"]
    assert "experiment" in sections
    assert "data" in sections
    assert "conditions" in sections

    exp_fields = sections["experiment"]["fields"]
    assert "time_t1" in exp_fields
    assert exp_fields["time_t1"]["required"] is True
    assert exp_fields["time_t1"]["unit"] == "s"

    assert "carrier" in exp_fields
    assert exp_fields["carrier"]["required"] is True

    # Nested b1_distribution subclasses
    assert "b1_distribution" in exp_fields
    b1_dist = exp_fields["b1_distribution"]
    assert "subclasses" in b1_dist
    assert "gaussian" in b1_dist["subclasses"]
    assert "beta" in b1_dist["subclasses"]

    # Allowed data errors for CEST
    assert "file" in schema["allowed_data_errors"]
    assert "scatter" in schema["allowed_data_errors"]

def test_cpmg_15n_ip_schema():
    schema = get_module_schema("cpmg_15n_ip")
    assert schema is not None
    assert schema["family"] == "cpmg"
    assert schema["spin_system_format"]["format"] == "single_15n"

    exp_fields = sections = schema["sections"]["experiment"]["fields"]
    assert "time_t2" in exp_fields
    assert exp_fields["time_t2"]["required"] is True
    assert "carrier" in exp_fields
    assert "pw90" in exp_fields
    assert exp_fields["pw90"]["required"] is True

    assert "duplicates" in schema["allowed_data_errors"]

def test_cpmg_15n_tr_schema():
    schema = get_module_schema("cpmg_15n_tr")
    assert schema is not None
    assert schema["family"] == "cpmg"
    assert schema["spin_system_format"]["format"] == "two_spin_15n_1h"

    exp_fields = schema["sections"]["experiment"]["fields"]
    assert "antitrosy" in exp_fields
    assert exp_fields["antitrosy"]["default"] is False
    assert "taub" in exp_fields
    assert exp_fields["taub"]["default"] == 0.00268

def test_cpmg_ch3_mq_schema():
    schema = get_module_schema("cpmg_ch3_mq")
    assert schema is not None
    assert schema["family"] == "cpmg"
    assert schema["probe"] == "13CH3"
    assert schema["spin_system_format"]["format"] == "methyl_mq"

    exp_fields = schema["sections"]["experiment"]["fields"]
    assert "time_t2" in exp_fields
    assert "t_zeta" in exp_fields

def test_variant_resolving():
    assert resolve_module_name("cpmg_15n_ip", {"phase_cycle": "0013"}) == "cpmg_15n_ip_0013"
    assert resolve_module_name("cpmg_15n_tr", {"phase_cycle": "0013"}) == "cpmg_15n_tr_0013"
    assert resolve_module_name("cpmg_15n_tr", {}) == "cpmg_15n_tr"


def test_cpmg_15n_rc_schema():
    schema = get_module_schema("cpmg_15n_rc")
    assert schema is not None
    assert schema["family"] == "cpmg"
    assert schema["probe"] == "15N"
    assert schema["spin_system_format"]["format"] == "two_spin_15n_1h"

    exp_fields = schema["sections"]["experiment"]["fields"]
    assert "time_t2" in exp_fields
    assert "carrier" in exp_fields
    assert "pw90" in exp_fields
    assert "ncyc_max" in exp_fields
    assert "taub" in exp_fields

