"""Tests for FitJobSpec serialization, deserialization, and schema validation."""

import json
from pathlib import Path
from resoflow.chemex_api.spec import FitJobSpec, ParameterOverride, ExecutionSpec, SelectionSpec


def test_spec_json_roundtrip(tmp_path: Path):
    spec = FitJobSpec(
        job_id="job-1234",
        chemex_version="2026.9.2",
        engine_version="1.0.0",
        experiment_files=["Experiments/exp1.toml", "Experiments/exp2.toml"],
        parameter_files=["Parameters/params.toml"],
        method_files=["Methods/method.toml"],
        model="2st",
        include=["2N", "3N"],
        exclude=["4N"],
        output_dir="output",
        plot="normal",
        execution=ExecutionSpec(workers=2, native_threads=1),
        overrides=[
            ParameterOverride(selector="[GLOBAL] KEX_AB", value=450.0, min=10.0, max=1000.0),
            ParameterOverride(section="CS_A", name="1N", value=126.5),
        ],
    )

    json_str = spec.to_json(indent=2)
    data = json.loads(json_str)
    assert data["schema"] == 1
    assert data["job_id"] == "job-1234"
    assert len(data["overrides"]) == 2

    # Roundtrip from JSON string
    loaded = FitJobSpec.from_json(json_str)
    assert loaded.job_id == spec.job_id
    assert loaded.model == spec.model
    assert loaded.experiment_files == spec.experiment_files
    assert len(loaded.overrides) == 2
    assert loaded.overrides[0].value == 450.0
    assert loaded.overrides[0].min == 10.0
    assert loaded.overrides[0].max == 1000.0
    assert loaded.overrides[1].section == "CS_A"
    assert loaded.overrides[1].value == 126.5

    # Roundtrip from file
    file_path = tmp_path / "job.json"
    spec.to_file(file_path)
    loaded_from_file = FitJobSpec.from_file(file_path)
    assert loaded_from_file.job_id == spec.job_id


def test_spec_overrides_toml_rendering():
    spec = FitJobSpec(
        experiment_files=["exp.toml"],
        overrides=[
            ParameterOverride(selector="[GLOBAL] KEX_AB", value=500.0, min=20.0, max=2000.0),
            ParameterOverride(selector="[CS_A] 1N", value=125.4),
            ParameterOverride(section="DW_AB", name="15N", value=2.5, min=0.0, max=10.0, brute_step=0.5),
        ],
    )
    toml_str = spec.render_overrides_toml()
    assert "[GLOBAL]" in toml_str
    assert "KEX_AB = [500, 20, 2000]" in toml_str
    assert "[CS_A]" in toml_str
    assert "1N = 125.4" in toml_str
    assert "[DW_AB]" in toml_str
    assert "15N = [2.5, 0, 10, 0.5]" in toml_str
