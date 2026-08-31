import tomllib
import pytest
import chemex.experiments.factories as factories
import chemex.experiments.loader as loader

loader.register_experiments()

CPMG_MODULE_CONFIGS = [
    ("cpmg_15n_ip", """
[experiment]
name = "cpmg_15n_ip"
time_t2 = 0.04
carrier = 117.0
pw90 = 35.0e-6

[conditions]
h_larmor_frq = 600.0

[data]
path = "."
error = "duplicates"
[data.profiles]
"G2N" = ["G2N.dat"]
"""),
    ("cpmg_15n_ip_0013", """
[experiment]
name = "cpmg_15n_ip_0013"
time_t2 = 0.04
carrier = 117.0
pw90 = 35.0e-6
ncyc_max = 20

[conditions]
h_larmor_frq = 800.0

[data]
path = "."
error = "file"
[data.profiles]
"G2N" = ["G2N.dat"]
"""),
    ("cpmg_15n_tr", """
[experiment]
name = "cpmg_15n_tr"
time_t2 = 0.04
carrier = 117.0
pw90 = 35.0e-6
taub = 0.002
antitrosy = false

[conditions]
h_larmor_frq = 600.0

[data]
path = "."
error = "duplicates"
[data.profiles]
"G2N-HN" = ["G2N-HN.dat"]
"""),
    ("cpmg_15n_tr", """
[experiment]
name = "cpmg_15n_tr"
time_t2 = 0.04
carrier = 117.0
pw90 = 35.0e-6
taub = 0.002
antitrosy = true

[conditions]
h_larmor_frq = 950.0

[data]
path = "."
error = "file"
[data.profiles]
"G2N-HN" = ["G2N-HN.dat"]
"""),
    ("cpmg_15n_tr_0013", """
[experiment]
name = "cpmg_15n_tr_0013"
time_t2 = 0.04
carrier = 117.0
pw90 = 35.0e-6
ncyc_max = 20

[conditions]
h_larmor_frq = 600.0

[data]
path = "."
error = "file"
[data.profiles]
"G2N-HN" = ["G2N-HN.dat"]
"""),
    ("cpmg_1hn_ap", """
[experiment]
name = "cpmg_1hn_ap"
time_t2 = 0.03
carrier = 8.5
pw90 = 12.0e-6

[conditions]
h_larmor_frq = 600.0

[data]
path = "."
error = "file"
[data.profiles]
"G2HN-N" = ["G2HN-N.dat"]
"""),
    ("cpmg_1hn_ap_0013", """
[experiment]
name = "cpmg_1hn_ap_0013"
time_t2 = 0.03
carrier = 8.5
pw90 = 12.0e-6
ncyc_max = 20

[conditions]
h_larmor_frq = 700.0

[data]
path = "."
error = "file"
[data.profiles]
"G2HN-N" = ["G2HN-N.dat"]
"""),
    ("cpmg_13c_ip", """
[experiment]
name = "cpmg_13c_ip"
time_t2 = 0.04
carrier = 40.0
pw90 = 15.0e-6

[conditions]
h_larmor_frq = 600.0

[data]
path = "."
error = "duplicates"
[data.profiles]
"G2C" = ["G2C.dat"]
"""),
    ("cpmg_13co_ap", """
[experiment]
name = "cpmg_13co_ap"
time_t2 = 0.04
carrier = 175.0
pw90 = 20.0e-6

[conditions]
h_larmor_frq = 600.0

[data]
path = "."
error = "file"
[data.profiles]
"G2C" = ["G2C.dat"]
"""),
    ("cpmg_ch3_mq", """
[experiment]
name = "cpmg_ch3_mq"
time_t2 = 0.04
t_zeta = 0.003
small_protein = false

[conditions]
h_larmor_frq = 800.0

[data]
path = "."
error = "duplicates"
[data.profiles]
"L3CD1-HD1" = ["L3CD1-HD1.dat"]
"""),
    ("cpmg_ch3_13c_h2c", """
[experiment]
name = "cpmg_ch3_13c_h2c"
time_t2 = 0.04
carrier = 20.0
pw90 = 15.0e-6
taub = 0.0018

[conditions]
h_larmor_frq = 600.0

[data]
path = "."
error = "file"
[data.profiles]
"L3CD1-HD1" = ["L3CD1-HD1.dat"]
"""),
    ("cpmg_ch3_13c_h2c_0013", """
[experiment]
name = "cpmg_ch3_13c_h2c_0013"
time_t2 = 0.04
carrier = 20.0
pw90 = 15.0e-6

[conditions]
h_larmor_frq = 600.0

[data]
path = "."
error = "file"
[data.profiles]
"L3CD1-HD1" = ["L3CD1-HD1.dat"]
"""),
    ("cpmg_ch3_1h_sq", """
[experiment]
name = "cpmg_ch3_1h_sq"
time_t2 = 0.04
carrier = 1.0
pw90 = 10.0e-6
ncyc_max = 24

[conditions]
h_larmor_frq = 600.0

[data]
path = "."
error = "file"
[data.profiles]
"L3HD1-CD1" = ["L3HD1-CD1.dat"]
"""),
    ("cpmg_ch3_1h_dq", """
[experiment]
name = "cpmg_ch3_1h_dq"
time_t2 = 0.04
carrier = 1.0
pw90 = 10.0e-6

[conditions]
h_larmor_frq = 600.0

[data]
path = "."
error = "file"
[data.profiles]
"L3HD1-CD1" = ["L3HD1-CD1.dat"]
"""),
    ("cpmg_ch3_1h_tq", """
[experiment]
name = "cpmg_ch3_1h_tq"
time_t2 = 0.04
carrier = 1.0
pw90 = 10.0e-6

[conditions]
h_larmor_frq = 600.0

[data]
path = "."
error = "file"
[data.profiles]
"L3HD1-CD1" = ["L3HD1-CD1.dat"]
"""),
    ("cpmg_ch3_1h_tq_diff", """
[experiment]
name = "cpmg_ch3_1h_tq_diff"
time_t2 = 0.04
carrier = 1.0
pw90 = 10.0e-6
delta = 0.002
gradient = 30.0

[conditions]
h_larmor_frq = 600.0

[data]
path = "."
error = "file"
[data.profiles]
"L3HD1-CD1" = ["L3HD1-CD1.dat"]
"""),
    ("cpmg_chd2_1h_ap", """
[experiment]
name = "cpmg_chd2_1h_ap"
time_t2 = 0.04
carrier = 1.0
pw90 = 10.0e-6

[conditions]
h_larmor_frq = 600.0

[data]
path = "."
error = "file"
[data.profiles]
"L3HD1-CD1" = ["L3HD1-CD1.dat"]
"""),
    ("cpmg_hn_dq_zq", """
[experiment]
name = "cpmg_hn_dq_zq"
time_t2 = 0.04
carrier_h = 8.5
carrier_n = 117.0
pw90_h = 10.0e-6
pw90_n = 35.0e-6
dq_flg = true

[conditions]
h_larmor_frq = 700.0

[data]
path = "."
error = "file"
[data.profiles]
"G2N-HN" = ["G2N-HN.dat"]
"""),
    ("cpmg_15n_rc", """
[experiment]
name = "cpmg_15n_rc"
time_t2 = 0.04
carrier = 117.0
pw90 = 35.0e-6
ncyc_max = 20
taub = 0.00268

[conditions]
h_larmor_frq = 600.0

[data]
path = "."
error = "duplicates"
[data.profiles]
"G2N-HN" = ["G2N-HN.dat"]
"""),
]

@pytest.mark.parametrize("module_name, toml_str", CPMG_MODULE_CONFIGS)
def test_cpmg_module_toml_validation(module_name: str, toml_str: str):
    creator = factories.factories.creators_registry.get(module_name)
    assert creator is not None, f"Module {module_name} must exist in ChemEx registry"
    cfg_cls = creator.config_creator
    data = tomllib.loads(toml_str)
    validated = cfg_cls.model_validate(data)
    assert validated.experiment.name == module_name
    assert validated.conditions.h_larmor_frq > 0
