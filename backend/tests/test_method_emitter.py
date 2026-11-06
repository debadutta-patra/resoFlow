"""
Tests for ChemEx v1 and v2 method emitter, parser, and validator with STATISTICS support.
"""

from pathlib import Path
import tempfile
import pytest

from chemex.configuration.methods import read_method_plan

from app.services.fitting.method_emitter import (
    MethodConfigModel,
    MethodStepModel,
    ParamSettingModel,
    StatisticsModel,
    McmcSettingsModel,
    emit_method_toml,
    emit_method_toml_v1,
    emit_method_toml_v2,
    parse_method_toml,
    validate_method_config,
)


def test_no_statistics_byte_identity_regression():
    """
    Regression assertion: When statistics are disabled/None, the emitter
    must emit ZERO statistics keys, subtables, or empty tables in v1 format.
    The output must match the classic v1 format byte-for-byte.
    """
    config = MethodConfigModel(
        steps=[
            MethodStepModel(
                name="STEP1",
                parameters=[
                    ParamSettingModel(name="PB", mode="fit"),
                    ParamSettingModel(name="KEX_AB", mode="fit"),
                    ParamSettingModel(name="CS_A", mode="default"),
                ],
                residue_mode="include",
                residues=[15, 31, 33],
                statistics=None,
            ),
            MethodStepModel(
                name="STEP2",
                parameters=[
                    ParamSettingModel(name="PB", mode="fix"),
                    ParamSettingModel(name="KEX_AB", mode="fix"),
                    ParamSettingModel(name="DW_AB", mode="fit"),
                ],
                residue_mode="include",
                residues=["ALL"],
                statistics=StatisticsModel(),  # empty statistics model
            ),
        ]
    )

    emitted_v1 = emit_method_toml(config, format_version=1)

    expected = (
        '[STEP1]\n'
        'FIT = ["PB", "KEX_AB"]\n'
        'INCLUDE = [15, 31, 33]\n\n'
        '[STEP2]\n'
        'FIT = ["DW_AB"]\n'
        'FIX = ["PB", "KEX_AB"]\n'
        'INCLUDE = ["ALL"]\n'
    )

    assert emitted_v1 == expected
    assert "STATISTICS" not in emitted_v1
    assert "MCMC" not in emitted_v1
    assert "MC" not in emitted_v1


def test_v2_method_emission():
    """Test default canonical v2 emission and ChemEx 2026.9 parser compatibility."""
    config = MethodConfigModel(
        steps=[
            MethodStepModel(
                name="STEP1",
                parameters=[
                    ParamSettingModel(name="PB", mode="fit"),
                    ParamSettingModel(name="KEX_AB", mode="fit"),
                ],
                residue_mode="include",
                residues=[15, 31, 33],
                statistics=None,
            ),
            MethodStepModel(
                name="STEP2",
                parameters=[
                    ParamSettingModel(name="PB", mode="fix"),
                    ParamSettingModel(name="KEX_AB", mode="fix"),
                    ParamSettingModel(name="DW_AB", mode="fit"),
                ],
                residue_mode="include",
                residues=["ALL"],
            ),
        ]
    )

    emitted_v2 = emit_method_toml(config)  # default is format_version=2
    assert "FORMAT_VERSION = 2" in emitted_v2
    assert '[STEP1]' in emitted_v2
    assert 'ROLES = [\n  { FIT = ["PB", "KEX_AB"] },\n]' in emitted_v2
    assert '[STEP2]' in emitted_v2
    assert 'ROLES_FROM = "STEP1"' in emitted_v2
    assert '{ FIX = ["PB", "KEX_AB"] }' in emitted_v2
    assert '{ FIT = ["DW_AB"] }' in emitted_v2

    # Validate that ChemEx 2026.9 read_method_plan can read this without error
    with tempfile.NamedTemporaryFile("w", suffix=".toml", delete=False) as tf:
        tf.write(emitted_v2)
        tf_path = Path(tf.name)
    try:
        plan = read_method_plan([tf_path])
        assert len(plan.steps) == 2
        assert plan.steps[0].name == "STEP1"
        assert plan.steps[1].name == "STEP2"
        assert plan.steps[1].roles_from == "STEP1"
    finally:
        tf_path.unlink(missing_ok=True)


def test_resampling_statistics_emission():
    """Test emission of Monte Carlo, Bootstrap, and Nucleus-Specific Bootstrap in v1 and v2."""
    config = MethodConfigModel(
        steps=[
            MethodStepModel(
                name="STEP1",
                parameters=[
                    ParamSettingModel(name="PB", mode="fit"),
                    ParamSettingModel(name="KEX_AB", mode="fit"),
                ],
                residue_mode="include",
                residues=[15, 31, 33, 34, 37],
                statistics=StatisticsModel(mc=100, bs=50, bsn=25),
            )
        ]
    )

    # v1
    emitted_v1 = emit_method_toml_v1(config)
    assert '[STEP1]' in emitted_v1
    assert 'STATISTICS = { "MC" = 100, "BS" = 50, "BSN" = 25 }' in emitted_v1

    # v2
    emitted_v2 = emit_method_toml_v2(config)
    assert 'FORMAT_VERSION = 2' in emitted_v2
    assert '[STEP1.STATISTICS.MC]' in emitted_v2
    assert 'REPLICATES = 100' in emitted_v2
    assert '[STEP1.STATISTICS.BS]' in emitted_v2
    assert 'REPLICATES = 50' in emitted_v2
    assert '[STEP1.STATISTICS.BSN]' in emitted_v2
    assert 'REPLICATES = 25' in emitted_v2

    # Roundtrip parse from v2 back to model
    parsed = parse_method_toml(emitted_v2)
    assert parsed.steps[0].statistics.mc == 100
    assert parsed.steps[0].statistics.bs == 50
    assert parsed.steps[0].statistics.bsn == 25


def test_mcmc_compact_emission():
    """Test compact MCMC emission in v1 and canonical format in v2."""
    config = MethodConfigModel(
        steps=[
            MethodStepModel(
                name="STEP1",
                parameters=[ParamSettingModel(name="PB", mode="fit")],
                statistics=StatisticsModel(mcmc=5000),
            )
        ]
    )

    emitted_v1 = emit_method_toml(config, format_version=1)
    assert 'STATISTICS = { "MCMC" = 5000 }' in emitted_v1

    emitted_v2 = emit_method_toml(config, format_version=2)
    assert '[STEP1.STATISTICS.MCMC]' in emitted_v2
    assert 'STEPS = 5000' in emitted_v2
    assert 'BURN = "AUTO"' in emitted_v2


def test_mcmc_expanded_emission():
    """Test expanded MCMC emission in v1 and canonical v2 (with unsupported params commented)."""
    config = MethodConfigModel(
        steps=[
            MethodStepModel(
                name="STEP1",
                parameters=[ParamSettingModel(name="PB", mode="fit")],
                statistics=StatisticsModel(
                    mcmc=McmcSettingsModel(
                        steps=5000,
                        burn=1000,
                        thin=10,
                        walkers=64,
                        seed=1234,
                        workers=2,
                        update_parameters=True,
                    )
                ),
            )
        ]
    )

    # v1 emission has all v1 keys
    emitted_v1 = emit_method_toml_v1(config)
    assert '[STEP1]' in emitted_v1
    assert '[STEP1.STATISTICS.MCMC]' in emitted_v1
    assert 'STEPS = 5000' in emitted_v1
    assert 'BURN = 1000' in emitted_v1
    assert 'THIN = 10' in emitted_v1
    assert 'WALKERS = 64' in emitted_v1
    assert 'SEED = 1234' in emitted_v1
    assert 'WORKERS = 2' in emitted_v1
    assert 'UPDATE_PARAMETERS = true' in emitted_v1

    # v2 emission has canonical v2 keys with v1-only keys commented out
    emitted_v2 = emit_method_toml_v2(config)
    assert '[STEP1.STATISTICS.MCMC]' in emitted_v2
    assert 'STEPS = 5000' in emitted_v2
    assert 'BURN = 1000' in emitted_v2
    assert 'SEED = 1234' in emitted_v2
    assert '# V1_ONLY_THIN = 10' in emitted_v2
    assert '# V1_ONLY_WALKERS = 64' in emitted_v2


def test_roundtrip_shipped_example_method_stat_toml():
    """
    Test round-trip parsing and re-emission against verbatim ChemEx fixture:
    examples/Experiments/CPMG_15N_IP/Methods/method_stat.toml
    """
    raw_fixture = """[STEP1]
INCLUDE = [15, 31, 33, 34, 37]
STATISTICS = { "MC" = 10, "BS" = 10, "BSN" = 10 }

[STEP2]
INCLUDE = ["ALL"]
FIX = ["PB", "KEX_AB"]
"""

    config = parse_method_toml(raw_fixture)
    assert len(config.steps) == 2

    # Step 1
    step1 = config.steps[0]
    assert step1.name == "STEP1"
    assert step1.residues == [15, 31, 33, 34, 37]
    assert step1.statistics is not None
    assert step1.statistics.mc == 10
    assert step1.statistics.bs == 10
    assert step1.statistics.bsn == 10

    # Step 2
    step2 = config.steps[1]
    assert step2.name == "STEP2"
    assert step2.statistics is None or step2.statistics.is_empty()
    fix_names = [p.name for p in step2.parameters if p.mode == "fix"]
    assert "PB" in fix_names
    assert "KEX_AB" in fix_names

    # Re-emit v1 and verify
    reemitted_v1 = emit_method_toml_v1(config)
    assert 'STATISTICS = { "MC" = 10, "BS" = 10, "BSN" = 10 }' in reemitted_v1
    assert 'FIX = ["PB", "KEX_AB"]' in reemitted_v1

    # Re-emit v2 and verify
    reemitted_v2 = emit_method_toml_v2(config)
    assert 'FORMAT_VERSION = 2' in reemitted_v2
    assert '[STEP1.STATISTICS.MC]' in reemitted_v2
    parsed_again = parse_method_toml(reemitted_v2)
    assert parsed_again.steps[0].statistics.mc == 10


def test_roundtrip_shipped_mcmc_fixture():
    """
    Test round-trip parsing of verbatim MCMC test fixture from ChemEx:
    tests/configuration/test_methods.py
    """
    raw_mcmc_toml = """[STEP1]
FIT = ["PB", "KEX_AB"]
[STEP1.STATISTICS.MCMC]
STEPS = 5000
BURN = 1000
THIN = 10
WALKERS = 64
SEED = 1234
WORKERS = 2
"""

    config = parse_method_toml(raw_mcmc_toml)
    assert len(config.steps) == 1
    step = config.steps[0]
    assert step.name == "STEP1"
    assert step.statistics is not None
    assert isinstance(step.statistics.mcmc, McmcSettingsModel)
    assert step.statistics.mcmc.steps == 5000
    assert step.statistics.mcmc.burn == 1000
    assert step.statistics.mcmc.thin == 10
    assert step.statistics.mcmc.walkers == 64
    assert step.statistics.mcmc.seed == 1234
    assert step.statistics.mcmc.workers == 2


def test_validation_errors_and_warnings():
    """Test validation bounds for resampling and MCMC."""
    # 1. Negative replicate count
    with pytest.raises(ValueError, match="positive integer"):
        StatisticsModel(mc=-5)

    # 2. MCMC burn >= steps
    with pytest.raises(ValueError, match="burn .* must be smaller than steps"):
        McmcSettingsModel(steps=100, burn=100)

    # 3. MCMC zero retained samples
    with pytest.raises(ValueError, match="retain 0 samples"):
        McmcSettingsModel(steps=100, burn=95, thin=10)

    # 4. Conflict between GRID and STATISTICS
    conflict_config = MethodConfigModel(
        steps=[
            MethodStepModel(
                name="STEP1",
                parameters=[
                    ParamSettingModel(name="PB", mode="grid", grid={"min": 0.01, "max": 0.2, "steps": 10}),
                ],
                statistics=StatisticsModel(mc=100),
            )
        ]
    )
    issues = validate_method_config(conflict_config)
    assert any("GRID search and STATISTICS" in i["message"] for i in issues)
    assert any(i["severity"] == "warning" for i in issues)


def test_grid_emission_and_parsing():
    """Test ChemEx standard GRID list syntax emission and parsing in v1 and v2."""
    raw_toml = """[GRID_STEP]
FIT = ["DW_AB"]
GRID = [
  "[KEX_AB] = log(100.0, 600.0, 10)",
  "[PB] = log(0.03, 0.15, 10)",
  "[DW_AB] = lin(0.0, 10.0, 5)"
]
"""
    config = parse_method_toml(raw_toml)
    assert len(config.steps) == 1
    step = config.steps[0]
    assert step.name == "GRID_STEP"

    grid_params = {p.name: p for p in step.parameters if p.mode == "grid"}
    assert "KEX_AB" in grid_params
    assert grid_params["KEX_AB"].grid == {"min": 100.0, "max": 600.0, "steps": 10, "scale": "log"}

    assert "PB" in grid_params
    assert grid_params["PB"].grid == {"min": 0.03, "max": 0.15, "steps": 10, "scale": "log"}

    assert "DW_AB" in grid_params
    assert grid_params["DW_AB"].grid == {"min": 0.0, "max": 10.0, "steps": 5, "scale": "lin"}

    emitted_v1 = emit_method_toml_v1(config)
    assert 'GRID = [\n  "[KEX_AB] = log(100.0, 600.0, 10)",\n  "[PB] = log(0.03, 0.15, 10)",\n  "[DW_AB] = lin(0.0, 10.0, 5)"\n]' in emitted_v1

    emitted_v2 = emit_method_toml_v2(config)
    assert 'FORMAT_VERSION = 2' in emitted_v2
    assert '[GRID_STEP.SEARCH.GRID]' in emitted_v2
    assert 'AXES = [\n  "[KEX_AB] = log(100.0, 600.0, 10)",\n  "[PB] = log(0.03, 0.15, 10)",\n  "[DW_AB] = lin(0.0, 10.0, 5)",\n]' in emitted_v2

    # Roundtrip from v2
    parsed_v2 = parse_method_toml(emitted_v2)
    grid_params_v2 = {p.name: p for p in parsed_v2.steps[0].parameters if p.mode == "grid"}
    assert "KEX_AB" in grid_params_v2
    assert grid_params_v2["KEX_AB"].grid["scale"] == "log"
    assert grid_params_v2["KEX_AB"].grid["min"] == 100.0
