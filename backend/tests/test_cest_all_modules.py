import pytest
import tomllib
from app.services.fitting.chemex_registry import get_chemex_module_registry, get_module_schema
from chemex.experiments.catalog import (
    cest_15n,
    cest_15n_cw,
    cest_15n_tr,
    cest_13c,
    cest_1hn_ap,
    cest_1hn_ip_ap,
    cest_ch3_1h_ip_ap,
)

MODULE_CLASSES = {
    "cest_15n": cest_15n.Cest15NConfig,
    "cest_15n_cw": cest_15n_cw.Cest15NCwConfig,
    "cest_15n_tr": cest_15n_tr.Cest15NTrConfig,
    "cest_13c": cest_13c.Cest13CConfig,
    "cest_1hn_ap": cest_1hn_ap.Cest1HnApConfig,
    "cest_1hn_ip_ap": cest_1hn_ip_ap.Cest1HnIpApConfig,
    "cest_ch3_1h_ip_ap": cest_ch3_1h_ip_ap.CestCh31HIpApConfig,
}

SAMPLE_TOML_STRINGS = {
    "cest_15n": """
[experiment]
name = "cest_15n"
time_t1 = 0.5
carrier = 117.0
b1_frq = 25.0
  [experiment.b1_distribution]
  type = "dephasing"

[conditions]
h_larmor_frq = 600.0

[data]
path = "../data/25Hz"
error = "scatter"
filter_offsets = [[0.0, 25.0]]
filter_planes = [3]
  [data.profiles]
  G2N = "2N.out"
""",

    "cest_15n_cw": """
[experiment]
name = "cest_15n_cw"
time_t1 = 0.5
carrier = 117.0
carrier_dec = 8.5
b1_frq = 25.0
b1_frq_dec = 2000.0
  [experiment.b1_distribution]
  type = "gaussian"
  scale = 0.1
  res = 11

[conditions]
h_larmor_frq = 600.0

[data]
path = "../data/25Hz"
error = "scatter"
  [data.profiles]
  G2N = "2N.out"
""",

    "cest_15n_tr": """
[experiment]
name = "cest_15n_tr"
time_t1 = 0.5
carrier = 117.0
b1_frq = 25.0
antitrosy = false
  [experiment.b1_distribution]
  type = "dephasing"

[conditions]
h_larmor_frq = 600.0

[data]
path = "../data/25Hz"
error = "scatter"
  [data.profiles]
  "G2N-HN" = "2N-HN.out"
""",

    "cest_13c": """
[experiment]
name = "cest_13c"
time_t1 = 0.5
carrier = 40.0
b1_frq = 25.0
  [experiment.b1_distribution]
  type = "dephasing"

[conditions]
h_larmor_frq = 600.0

[data]
path = "../data/25Hz"
error = "scatter"
  [data.profiles]
  G2C = "2C.out"
""",

    "cest_1hn_ap": """
[experiment]
name = "cest_1hn_ap"
time_t1 = 0.5
carrier = 8.5
b1_frq = 25.0
  [experiment.b1_distribution]
  type = "dephasing"

[conditions]
h_larmor_frq = 600.0

[data]
path = "../data/25Hz"
error = "scatter"
  [data.profiles]
  "G2HN-N" = "2HN-N.out"
""",

    "cest_1hn_ip_ap": """
[experiment]
name = "cest_1hn_ip_ap"
time_t1 = 0.5
carrier = 8.5
b1_frq = 25.0
d1 = 1.0
taua = 0.002
eta_block = false
  [experiment.b1_distribution]
  type = "dephasing"

[conditions]
h_larmor_frq = 600.0

[data]
path = "../data/25Hz"
error = "scatter"
  [data.profiles]
  "G2HN-N" = "2HN-N.out"
""",

    "cest_ch3_1h_ip_ap": """
[experiment]
name = "cest_ch3_1h_ip_ap"
time_t1 = 0.5
carrier = 1.0
b1_frq = 25.0
d1 = 1.0
taua = 0.002
  [experiment.b1_distribution]
  type = "dephasing"

[conditions]
h_larmor_frq = 600.0

[data]
path = "../data/25Hz"
error = "scatter"
  [data.profiles]
  "L3HD1-CD1" = "3HD1-CD1.out"
""",
}


@pytest.mark.parametrize("module_name", list(MODULE_CLASSES.keys()))
def test_all_cest_modules_in_registry(module_name):
    schema = get_module_schema(module_name)
    assert schema is not None
    assert schema["family"] == "cest"
    assert "experiment" in schema["sections"]
    assert "conditions" in schema["sections"]
    assert "data" in schema["sections"]


@pytest.mark.parametrize("module_name, toml_str", list(SAMPLE_TOML_STRINGS.items()))
def test_toml_validation_against_installed_chemex(module_name, toml_str):
    model_cls = MODULE_CLASSES[module_name]
    parsed_toml = tomllib.loads(toml_str)
    validated_config = model_cls.model_validate(parsed_toml)
    assert validated_config.experiment.name == module_name
    assert validated_config.experiment.b1_distribution is not None
