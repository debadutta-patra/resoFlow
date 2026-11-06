"""Tests asserting that parameter overrides take precedence over baseline parameters.toml."""

from pathlib import Path
from chemex.configuration.parameters import read_defaults
from resoflow.chemex_api.session import inspect_parameters
from resoflow.chemex_api.spec import FitJobSpec, ParameterOverride


def test_override_precedence_in_defaults(tmp_path: Path):
    p_base = tmp_path / "parameters.toml"
    p_base.write_text(
        "[GLOBAL]\n"
        "kex_ab = 400.0\n"
        "pb = 0.05\n"
        "\n"
        "[CS_A]\n"
        "1N = 126.886\n"
    )

    spec = FitJobSpec(
        parameter_files=[str(p_base)],
        overrides=[
            ParameterOverride(selector="[GLOBAL] KEX_AB", value=750.0),
            ParameterOverride(section="CS_A", name="1N", value=122.5),
        ],
    )

    overrides_text = spec.render_overrides_toml()
    p_overrides = tmp_path / "overrides.toml"
    p_overrides.write_text(overrides_text)

    # Read defaults with overrides appended after base parameters
    defaults = read_defaults([p_base, p_overrides])
    defaults_dict = {str(k): v.value for k, v in defaults}

    assert defaults_dict["[KEX_AB]"] == 750.0
    assert defaults_dict["[PB]"] == 0.05
    assert any(k.name == "CS_A" and str(k.spin_system) == "1N" and v.value == 122.5 for k, v in defaults)


def test_override_precedence_in_inspection(tmp_path: Path):
    import shutil
    repo_root = Path(__file__).resolve().parent.parent.parent.parent
    fixture_dir = repo_root / "backend" / "tests" / "fixtures" / "baselines" / "2026.6.1" / "cpmg_15n_ip" / "inputs"

    shutil.copytree(fixture_dir / "Data", tmp_path / "Data")
    shutil.copytree(fixture_dir / "Experiments", tmp_path / "Experiments")
    shutil.copytree(fixture_dir / "Parameters", tmp_path / "Parameters")

    exp_files = [f"Experiments/{f.name}" for f in sorted((tmp_path / "Experiments").glob("*.toml"))]
    param_files = [f"Parameters/{f.name}" for f in sorted((tmp_path / "Parameters").glob("*.toml"))]

    spec = FitJobSpec(
        experiment_files=exp_files,
        parameter_files=param_files,
        model="2st",
        include=["3N"],
        overrides=[
            ParameterOverride(selector="[GLOBAL] KEX_AB", value=999.0),
        ],
    )

    params = inspect_parameters(spec, job_dir=tmp_path)
    kex_rows = [p for p in params if p["name"].lower() == "kex_ab"]
    assert len(kex_rows) == 1
    assert kex_rows[0]["value"] == 999.0
