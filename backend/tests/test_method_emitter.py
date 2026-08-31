"""
Tests for ChemEx v1 method emitter, parser, and validator with STATISTICS support.
"""

import pytest
from app.services.fitting.method_emitter import (
    MethodConfigModel,
    MethodStepModel,
    ParamSettingModel,
    StatisticsModel,
    McmcSettingsModel,
    emit_method_toml,
    parse_method_toml,
    validate_method_config,
)


def test_no_statistics_byte_identity_regression():
    """
    Regression assertion: When statistics are disabled/None, the emitter
    must emit ZERO statistics keys, subtables, or empty tables.
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

    emitted = emit_method_toml(config)

    expected = (
        '[STEP1]\n'
        'FIT = ["PB", "KEX_AB"]\n'
        'INCLUDE = [15, 31, 33]\n\n'
        '[STEP2]\n'
        'FIT = ["DW_AB"]\n'
        'FIX = ["PB", "KEX_AB"]\n'
        'INCLUDE = ["ALL"]\n'
    )

    assert emitted == expected
    assert "STATISTICS" not in emitted
    assert "MCMC" not in emitted
    assert "MC" not in emitted


def test_resampling_statistics_emission():
    """Test emission of Monte Carlo, Bootstrap, and Nucleus-Specific Bootstrap."""
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

    emitted = emit_method_toml(config)
    assert '[STEP1]' in emitted
    assert 'STATISTICS = { "MC" = 100, "BS" = 50, "BSN" = 25 }' in emitted


def test_mcmc_compact_emission():
    """Test compact MCMC emission when default settings are used."""
    config = MethodConfigModel(
        steps=[
            MethodStepModel(
                name="STEP1",
                parameters=[ParamSettingModel(name="PB", mode="fit")],
                statistics=StatisticsModel(mcmc=5000),
            )
        ]
    )

    emitted = emit_method_toml(config)
    assert 'STATISTICS = { "MCMC" = 5000 }' in emitted


def test_mcmc_expanded_emission():
    """Test expanded MCMC emission as [STEP.STATISTICS.MCMC] subtable."""
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

    emitted = emit_method_toml(config)
    assert '[STEP1]' in emitted
    assert '[STEP1.STATISTICS.MCMC]' in emitted
    assert 'STEPS = 5000' in emitted
    assert 'BURN = 1000' in emitted
    assert 'THIN = 10' in emitted
    assert 'WALKERS = 64' in emitted
    assert 'SEED = 1234' in emitted
    assert 'WORKERS = 2' in emitted
    assert 'UPDATE_PARAMETERS = true' in emitted


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

    # Re-emit and verify
    reemitted = emit_method_toml(config)
    assert 'STATISTICS = { "MC" = 10, "BS" = 10, "BSN" = 10 }' in reemitted
    assert 'FIX = ["PB", "KEX_AB"]' in reemitted


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
    """Test ChemEx standard GRID list syntax emission and parsing."""
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

    emitted = emit_method_toml(config)
    assert 'GRID = [\n  "[KEX_AB] = log(100.0, 600.0, 10)",\n  "[PB] = log(0.03, 0.15, 10)",\n  "[DW_AB] = lin(0.0, 10.0, 5)"\n]' in emitted

