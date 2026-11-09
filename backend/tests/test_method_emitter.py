"""
Tests for the ChemEx method emitter, parser and validator.

Canonical output is ChemEx v2 (FORMAT_VERSION = 2) and is checked against
ChemEx's own ``read_method_plan``. The legacy v1 emitter is kept only for
explicit ``format_version=1`` callers.
"""

from pathlib import Path
import tempfile

import pytest

from chemex.configuration.methods import read_method_plan

from app.services.fitting.method_emitter import (
    McmcSettingsModel,
    MethodConfigModel,
    MethodStepModel,
    ParamSettingModel,
    RoleRuleModel,
    SearchAxisModel,
    StatisticsModel,
    StepSearchModel,
    emit_method_toml,
    emit_method_toml_v1,
    emit_method_toml_v2,
    parse_method_toml,
    validate_method_config,
)


def _chemex_plan(toml: str):
    with tempfile.NamedTemporaryFile("w", suffix=".toml", delete=False) as tf:
        tf.write(toml)
        path = Path(tf.name)
    try:
        return read_method_plan([path])
    finally:
        path.unlink(missing_ok=True)


def test_v1_emitter_byte_identity_without_statistics():
    """Legacy v1 output stays byte-identical and contains no statistics keys."""
    config = MethodConfigModel(
        steps=[
            MethodStepModel(
                name="STEP1",
                parameters=[
                    ParamSettingModel(name="PB", mode="fit"),
                    ParamSettingModel(name="KEX_AB", mode="fit"),
                    ParamSettingModel(name="CS_A", mode="default"),
                ],
                residues=[15, 31, 33],
            ),
            MethodStepModel(
                name="STEP2",
                parameters=[
                    ParamSettingModel(name="PB", mode="fix"),
                    ParamSettingModel(name="KEX_AB", mode="fix"),
                    ParamSettingModel(name="DW_AB", mode="fit"),
                ],
                residues=["ALL"],
                statistics=StatisticsModel(),
            ),
        ]
    )
    assert emit_method_toml(config, format_version=1) == (
        '[STEP1]\n'
        'FIT = ["PB", "KEX_AB"]\n'
        'INCLUDE = [15, 31, 33]\n\n'
        '[STEP2]\n'
        'FIT = ["DW_AB"]\n'
        'FIX = ["PB", "KEX_AB"]\n'
        'INCLUDE = ["ALL"]\n'
    )


def test_v2_emission_is_accepted_by_chemex():
    config = MethodConfigModel(
        steps=[
            MethodStepModel(
                name="GLOBAL_FIT",
                parameters=[
                    ParamSettingModel(name="PB", mode="fit"),
                    ParamSettingModel(name="KEX_AB", mode="fit"),
                    ParamSettingModel(name="R2_B", mode="constrain", expression="[R2_A]"),
                ],
                residues=[15, 31, 33],
            ),
            MethodStepModel(
                name="LOCAL_FITS",
                roles_from="GLOBAL_FIT",
                parameters=[
                    ParamSettingModel(name="PB", mode="fix"),
                    ParamSettingModel(name="KEX_AB", mode="fix"),
                    ParamSettingModel(name="DW_AB", mode="fit"),
                ],
                residues=["ALL"],
            ),
        ]
    )
    toml = emit_method_toml(config)
    assert toml == (
        "FORMAT_VERSION = 2\n\n"
        "[GLOBAL_FIT]\n"
        "INCLUDE = [15, 31, 33]\n"
        "ROLES = [\n"
        '  { CONSTRAIN = ["[R2_B] = [R2_A]"] },\n'
        '  { FIT = ["PB", "KEX_AB"] },\n'
        "]\n\n"
        "[LOCAL_FITS]\n"
        'INCLUDE = "ALL"\n'
        'ROLES_FROM = "GLOBAL_FIT"\n'
        "ROLES = [\n"
        '  { FIX = ["PB", "KEX_AB"] },\n'
        '  { FIT = ["DW_AB"] },\n'
        "]\n"
    )
    plan = _chemex_plan(toml)
    assert [s.name for s in plan.steps] == ["GLOBAL_FIT", "LOCAL_FITS"]
    assert plan.steps[0].roles_from is None  # no implicit carry-over in v2
    assert plan.steps[1].roles_from == "GLOBAL_FIT"


def test_v2_never_emits_v1_only_constructs():
    config = MethodConfigModel(
        steps=[
            MethodStepModel(
                name="STEP1",
                parameters=[
                    ParamSettingModel(name="PB", mode="fit", bounds="< 0.5"),
                    ParamSettingModel(name="KEX_AB", mode="grid", grid={"min": 100, "max": 1000, "steps": 5, "scale": "log"}),
                ],
                statistics=StatisticsModel(
                    mcmc=McmcSettingsModel(steps=5000, burn="auto", thin=10, walkers=64, workers=2, update_parameters=True)
                ),
            )
        ]
    )
    toml = emit_method_toml_v2(config)
    for forbidden in ("CONSTRAINTS", "< 0.5", "\nGRID =", "THIN", "WALKERS", "WORKERS", "UPDATE_PARAMETERS", "BURN", "FITMETHOD", "#"):
        assert forbidden not in toml, forbidden
    assert '{ FIT = ["PB", "KEX_AB"] }' in toml
    assert '"[KEX_AB] = log(100, 1000, 5)",' in toml
    # No SEED / BURN → compact form, in the step table before the SEARCH sub-table.
    assert 'STATISTICS = { MCMC = 5000 }\n\n[STEP1.SEARCH.GRID]' in toml
    plan = _chemex_plan(toml)
    assert plan.steps[0].search is not None


def test_statistics_seeds_and_compact_counts():
    config = MethodConfigModel(
        steps=[
            MethodStepModel(
                name="STEP1",
                parameters=[ParamSettingModel(name="PB", mode="fit")],
                statistics=StatisticsModel(
                    mc={"replicates": 100, "seed": 680},
                    bs=50,
                    bsn={"enabled": True, "replicates": 25},
                    mcmc={"enabled": True, "steps": 20000, "burn": 4000, "seed": 7},
                ),
            )
        ]
    )
    toml = emit_method_toml_v2(config)
    assert "[STEP1.STATISTICS.MC]\nREPLICATES = 100\nSEED = 680\n" in toml
    assert "[STEP1.STATISTICS.BS]\nREPLICATES = 50\n\n" in toml
    assert "[STEP1.STATISTICS.BSN]\nREPLICATES = 25\n" in toml
    assert "[STEP1.STATISTICS.MCMC]\nSTEPS = 20000\nBURN = 4000\nSEED = 7\n" in toml
    plan = _chemex_plan(toml)
    assert plan.steps[0].statistics is not None

    parsed = parse_method_toml(toml)
    stats = parsed.steps[0].statistics
    assert stats.mc.replicates == 100 and stats.mc.seed == 680
    assert stats.bs == 50
    assert stats.mcmc.steps == 20000 and stats.mcmc.burn == 4000 and stats.mcmc.seed == 7


def test_frontend_camelcase_payload_and_ts_parity():
    """The same config the TS emitter serialises must produce byte-identical TOML."""
    payload = {
        "steps": [
            {
                "id": "a",
                "name": "GLOBAL_FIT",
                "residues": ["15", "31", "G24N-H"],
                "residueMode": "include",
                "parameters": [
                    {"name": "PB", "mode": "fit"},
                    {"name": "R2_B", "mode": "constrain", "expression": "0.5 * ([R2_A] + 1.0)"},
                ],
                "search": {
                    "mode": "grid",
                    "axes": [
                        {"id": "1", "param": "PB", "fn": "values", "low": 0, "high": 0, "count": 0, "values": [0.01, 0.05, 0.1]},
                        {"id": "2", "param": "KEX_AB", "fn": "log", "low": 20, "high": 2000, "count": 12},
                        {"id": "3", "param": "DW_AB", "qualifier": "NUC->G24N-H, B0->800.13MHz, T->25C", "fn": "lin", "low": -10, "high": 10, "count": 21},
                    ],
                },
                "statistics": {
                    "mc": {"enabled": True, "replicates": 5, "seed": 1},
                    "mcmc": {"enabled": True, "steps": 100, "burn": 10, "seed": 3},
                },
            },
            {
                "id": "b",
                "name": "LOCAL",
                "residues": ["ALL"],
                "residueMode": "include",
                "rolesFrom": "GLOBAL_FIT",
                "parameters": [{"name": "PB", "mode": "fix"}],
                "roleRules": [
                    {"id": "r", "action": "CONSTRAIN", "entries": ["[DW_AB, NUC->G31N-H] = [DW_AB, NUC->G24N-H]"]},
                    {"id": "r2", "action": "FIX", "entries": ["R1_A, [P]->0.001M, D2O->0.1"]},
                ],
                "search": {"mode": "de", "seed": 18446744073709, "axes": [{"id": "4", "param": "KEX_AB", "fn": "log", "low": 10, "high": 5000, "count": 0}]},
                "statistics": {"bs": {"enabled": True, "replicates": 5}, "bsn": {"enabled": True, "replicates": 5}},
            },
            {"id": "c", "name": "EXC", "residues": ["12", "18"], "residueMode": "exclude", "parameters": []},
        ]
    }
    # Expected emission for the same payload (search targets are not auto-added to FIT;
    # byte parity with methodToml.ts is pinned by tests/test_method_emit_contract.py).
    ts_output = (
        'FORMAT_VERSION = 2\n\n[GLOBAL_FIT]\nINCLUDE = [15, 31, "G24N-H"]\nROLES = [\n'
        '  { CONSTRAIN = ["[R2_B] = 0.5 * ([R2_A] + 1.0)"] },\n'
        '  { FIT = ["PB"] },\n]\n\n'
        '[GLOBAL_FIT.SEARCH.GRID]\nAXES = [\n  "[PB] = values(0.01, 0.05, 0.1)",\n'
        '  "[KEX_AB] = log(20, 2000, 12)",\n'
        '  "[DW_AB, NUC->G24N-H, B0->800.13MHz, T->25C] = lin(-10, 10, 21)",\n]\n\n'
        '[GLOBAL_FIT.STATISTICS.MC]\nREPLICATES = 5\nSEED = 1\n\n'
        '[GLOBAL_FIT.STATISTICS.MCMC]\nSTEPS = 100\nBURN = 10\nSEED = 3\n\n'
        '[LOCAL]\nINCLUDE = "ALL"\nROLES_FROM = "GLOBAL_FIT"\nROLES = [\n'
        '  { FIX = ["PB"] },\n'
        '  { CONSTRAIN = ["[DW_AB, NUC->G31N-H] = [DW_AB, NUC->G24N-H]"] },\n'
        '  { FIX = ["R1_A, [P]->0.001M, D2O->0.1"] },\n]\n'
        'STATISTICS = { BS = 5, BSN = 5 }\n\n'
        '[LOCAL.SEARCH.DE]\nSEED = 18446744073709\nCOORDINATES = [\n  "[KEX_AB] = log(10, 5000)",\n]\n\n'
        '[EXC]\nEXCLUDE = [12, 18]\n'
    )
    config = MethodConfigModel(**payload)
    toml = emit_method_toml_v2(config)
    assert toml == ts_output
    plan = _chemex_plan(toml)
    assert [s.name for s in plan.steps] == ["GLOBAL_FIT", "LOCAL", "EXC"]

    # parse → emit is a fixed point
    assert emit_method_toml_v2(parse_method_toml(toml)) == toml


def test_parse_v2_roles_ordering_into_table_and_rules():
    config = parse_method_toml(
        """FORMAT_VERSION = 2
[STEP]
ROLES = [
  { FIX = ["DW_AB"] },
  { FIT = ["DW_AB, NUC->G24N-H"] },
  { CONSTRAIN = ["[DW_AB, NUC->G31N-H] = [DW_AB, NUC->G24N-H]"] },
]
"""
    )
    step = config.steps[0]
    assert [(p.name, p.mode) for p in step.parameters] == [("DW_AB", "fix")]
    assert [(r.action, r.entries) for r in step.role_rules] == [
        ("FIT", ["DW_AB, NUC->G24N-H"]),
        ("CONSTRAIN", ["[DW_AB, NUC->G31N-H] = [DW_AB, NUC->G24N-H]"]),
    ]
    reemitted = emit_method_toml_v2(config)
    assert (
        'ROLES = [\n  { FIX = ["DW_AB"] },\n  { FIT = ["DW_AB, NUC->G24N-H"] },\n'
        '  { CONSTRAIN = ["[DW_AB, NUC->G31N-H] = [DW_AB, NUC->G24N-H]"] },\n]'
    ) in reemitted


def test_parse_v2_de_search():
    config = parse_method_toml(
        """FORMAT_VERSION = 2
[STEP]
ROLES = [{ FIT = ["PB", "KEX_AB", "DW_AB"] }]

[STEP.SEARCH.DE]
SEED = 597
COORDINATES = ["[PB] = log(0.001, 0.20)", "[KEX_AB] = log(100.0, 5000.0)"]
"""
    )
    search = config.steps[0].search
    assert search.mode == "de" and search.seed == 597
    assert [(a.param, a.fn, a.low, a.high) for a in search.axes] == [("PB", "log", 0.001, 0.2), ("KEX_AB", "log", 100.0, 5000.0)]
    assert "[STEP.SEARCH.DE]\nSEED = 597\nCOORDINATES = [\n" in emit_method_toml_v2(config)


def test_v1_migration_shipped_example_method_stat():
    """examples/Experiments/CPMG_15N_IP/Methods/method_stat.toml (v1) → v2."""
    config = parse_method_toml(
        """[STEP1]
INCLUDE = [15, 31, 33, 34, 37]
STATISTICS = { "MC" = 10, "BS" = 10, "BSN" = 10 }

[STEP2]
INCLUDE = ["ALL"]
FIX = ["PB", "KEX_AB"]
"""
    )
    step1, step2 = config.steps
    assert step1.residues == [15, 31, 33, 34, 37]
    assert (step1.statistics.mc, step1.statistics.bs, step1.statistics.bsn) == (10, 10, 10)
    # v1 implicit role carry-over becomes explicit ROLES_FROM
    assert step2.roles_from == "STEP1"
    assert {p.name for p in step2.parameters if p.mode == "fix"} == {"PB", "KEX_AB"}

    v2 = emit_method_toml_v2(config)
    assert 'ROLES_FROM = "STEP1"' in v2
    assert "STATISTICS = { MC = 10, BS = 10, BSN = 10 }\n" in v2  # v1 statistics migrate to the compact v2 form
    assert len(_chemex_plan(v2).steps) == 2


def test_v1_migration_grid_bounds_and_mcmc():
    config = parse_method_toml(
        """[STEP1]
FIT = ["PB", "KEX_AB"]
CONSTRAINTS = ["[PB] < 0.5", "[R2_B] = 0.5 * [R2_A]"]
GRID = [
  "[KEX_AB] = log(100.0, 600.0, 10)",
  "[PB] = (0.01, 0.05, 0.10)",
]
[STEP1.STATISTICS.MCMC]
STEPS = 5000
BURN = "AUTO"
THIN = 10
WALKERS = 64
SEED = 1234
"""
    )
    step = config.steps[0]
    pb = next(p for p in step.parameters if p.name == "PB")
    assert pb.mode == "fit" and pb.bounds == "< 0.5"
    assert [(a.param, a.fn) for a in step.search.axes] == [("KEX_AB", "log"), ("PB", "values")]
    assert step.statistics.mcmc.burn == "auto" and step.statistics.mcmc.thin == 10

    v2 = emit_method_toml_v2(config)
    assert '"[PB] = values(0.01, 0.05, 0.1)",' in v2
    assert "< 0.5" not in v2 and "THIN" not in v2 and "BURN" not in v2
    assert "[STEP1.STATISTICS.MCMC]\nSTEPS = 5000\nSEED = 1234\n" in v2
    _chemex_plan(v2)

    issues = validate_method_config(config)
    assert any("v1 inequality" in i["message"] for i in issues)
    assert any("v1-only controls" in i["message"] for i in issues)


def test_v1_legacy_inline_table_grid():
    config = parse_method_toml(
        """[GRID_STEP]
FIT = ["DW_AB"]
GRID = { PB = [0.01, 0.2, 20], KEX_AB = [100, 2000, 20] }
"""
    )
    axes = config.steps[0].search.axes
    assert [(a.param, a.fn, a.low, a.high, a.count) for a in axes] == [
        ("PB", "lin", 0.01, 0.2, 20),
        ("KEX_AB", "lin", 100.0, 2000.0, 20),
    ]


def test_mcmc_model_validation():
    with pytest.raises(ValueError, match="positive integer"):
        StatisticsModel(mc=-5)
    with pytest.raises(ValueError, match="burn .* must be smaller than steps"):
        McmcSettingsModel(steps=100, burn=100)
    with pytest.raises(ValueError, match="retain 0 samples"):
        McmcSettingsModel(steps=100, burn=95, thin=10)


def test_validation_v2_rules():
    config = MethodConfigModel(
        steps=[
            MethodStepModel(
                name="A",
                roles_from="B",
                parameters=[ParamSettingModel(name="PB", mode="fix")],
                search=StepSearchModel(
                    mode="de",
                    axes=[
                        SearchAxisModel(param="PB", fn="log", low=0.001, high=0.2),
                        SearchAxisModel(param="KEX_AB", fn="values", values=[1, 2]),
                        SearchAxisModel(param="DW_AB", fn="log", low=-1, high=5),
                    ],
                ),
                role_rules=[RoleRuleModel(action="FIT", entries=["DW_AB, FOO->1"])],
            ),
            MethodStepModel(
                name="B",
                search=StepSearchModel(mode="grid", axes=[SearchAxisModel(param="PB", fn="lin", low=0.2, high=0.1, count=1)]),
                statistics=StatisticsModel(mc=100),
            ),
        ]
    )
    messages = [i["message"] for i in validate_method_config(config)]
    assert any("ROLES_FROM 'B' must name an earlier step" in m for m in messages)
    assert any("search targets must be FIT" in m for m in messages)
    assert any("requires an unsigned 64-bit SEED" in m for m in messages)
    assert any("DE coordinates must use lin" in m for m in messages)
    assert any("must be positive" in m for m in messages)
    assert any("Invalid qualifier" in m for m in messages)
    assert any("low < high" in m for m in messages)
    assert any("at least 2 points" in m for m in messages)
    assert any("The last step uses GRID" in m for m in messages)


# ── u64 seeds ────────────────────────────────────────────────────────────

MAX_U64 = "18446744073709551615"


def test_seed_precision_round_trip_and_chemex_acceptance():
    """2**64 - 1 survives frontend-string → model → TOML → ChemEx → parse → JSON."""
    payload = {
        "steps": [
            {
                "name": "STEP",
                "parameters": [{"name": "PB", "mode": "fit"}, {"name": "KEX_AB", "mode": "fit"}],
                "search": {"mode": "de", "seed": MAX_U64, "axes": [{"param": "PB", "fn": "log", "low": 0.001, "high": 0.2}]},
                "statistics": {
                    "mc": {"enabled": True, "replicates": 10, "seed": MAX_U64},
                    "mcmc": {"enabled": True, "steps": 100, "seed": "9007199254740993"},
                },
            }
        ]
    }
    toml = emit_method_toml_v2(MethodConfigModel(**payload))
    assert f"SEED = {MAX_U64}\nCOORDINATES" in toml
    assert f"REPLICATES = 10\nSEED = {MAX_U64}" in toml
    assert "STEPS = 100\nSEED = 9007199254740993" in toml

    plan = _chemex_plan(toml)
    assert plan.steps[0].search.seed == int(MAX_U64)
    assert plan.steps[0].statistics.mc.seed == int(MAX_U64)

    parsed = parse_method_toml(toml)
    assert parsed.steps[0].search.seed == int(MAX_U64)
    dumped = parsed.model_dump(mode="json")["steps"][0]
    # JSON carries seeds as strings so browsers never round them through a float.
    assert dumped["search"]["seed"] == MAX_U64
    assert dumped["statistics"]["mc"]["seed"] == MAX_U64
    assert dumped["statistics"]["mcmc"]["seed"] == "9007199254740993"


@pytest.mark.parametrize("bad", ["18446744073709551616", "-1", "1.5", "abc", True, -1, 1 << 64])
def test_seed_out_of_range_or_malformed_is_rejected(bad):
    with pytest.raises(Exception):
        StepSearchModel(mode="de", seed=bad)
    with pytest.raises(Exception):
        McmcSettingsModel(steps=10, seed=bad)


def test_seed_accepts_legacy_int_and_empty_string():
    assert StepSearchModel(mode="de", seed=597).seed == 597
    assert StepSearchModel(mode="de", seed="0").seed == 0
    assert StepSearchModel(mode="de", seed="").seed is None


def test_compact_statistics_form_matches_docs_and_chemex():
    """Docs: STATISTICS = { MC = 100, BS = 100, BSN = 100, MCMC = 5000 } when no SEED/BURN is set."""
    config = MethodConfigModel(**{"steps": [{"name": "STEP", "parameters": [{"name": "PB", "mode": "fit"}],
        "statistics": {"mc": {"enabled": True, "replicates": 100}, "bs": {"enabled": True, "replicates": 100},
                       "bsn": {"enabled": True, "replicates": 100}, "mcmc": {"enabled": True, "steps": 5000, "burn": "auto"}}}]})
    toml = emit_method_toml_v2(config)
    assert toml == 'FORMAT_VERSION = 2\n\n[STEP]\nROLES = [\n  { FIT = ["PB"] },\n]\nSTATISTICS = { MC = 100, BS = 100, BSN = 100, MCMC = 5000 }\n'
    plan = _chemex_plan(toml)
    st = plan.steps[0].statistics
    assert (st.mc.replicates, st.bs.replicates, st.bsn.replicates, st.mcmc.steps, st.mcmc.burn) == (100, 100, 100, 5000, None)
    assert emit_method_toml_v2(parse_method_toml(toml)) == toml
