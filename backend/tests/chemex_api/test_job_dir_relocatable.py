"""Tests verifying that job directories are self-contained and relocatable."""

import shutil
import subprocess
import sys
from pathlib import Path

from resoflow.chemex_api.results import EngineResult
from resoflow.chemex_api.spec import FitJobSpec


def test_job_dir_is_relocatable(tmp_path: Path):
    fixture_dir = Path(__file__).resolve().parent.parent / "fixtures" / "baselines" / "2026.6.1" / "cpmg_15n_ip" / "inputs"

    # Set up job dir A
    job_dir_a = tmp_path / "job_a"
    job_dir_a.mkdir()
    shutil.copytree(fixture_dir / "Data", job_dir_a / "Data")
    shutil.copytree(fixture_dir / "Experiments", job_dir_a / "Experiments")
    shutil.copytree(fixture_dir / "Parameters", job_dir_a / "Parameters")

    exp_files = [f"Experiments/{f.name}" for f in sorted((job_dir_a / "Experiments").glob("*.toml"))]
    param_files = [f"Parameters/{f.name}" for f in sorted((job_dir_a / "Parameters").glob("*.toml"))]

    spec = FitJobSpec(
        job_id="relocatable-test",
        chemex_version="2026.9.2",
        experiment_files=exp_files,
        parameter_files=param_files,
        model="2st",
        include=["3N"],
        output_dir="output",
        plot="nothing",
    )
    spec.to_file(job_dir_a / "job.json")

    repo_root = Path(__file__).resolve().parent.parent.parent.parent
    env = {"PYTHONPATH": str(repo_root), "MPLBACKEND": "Agg"}

    # Run in job_dir_a
    cmd_a = [sys.executable, "-m", "resoflow.engine", "run", "job.json"]
    res_a = subprocess.run(cmd_a, cwd=job_dir_a, capture_output=True, text=True, env=env)
    assert res_a.returncode == 0, f"Run in dir A failed with {res_a.returncode}. Log: {(job_dir_a / 'engine.log').read_text()}"

    res_data_a = EngineResult.from_file(job_dir_a / "output" / "engine_result.json")
    assert res_data_a.status == "complete"

    # Now move or copy the input setup to an entirely different path B
    job_dir_b = tmp_path / "completely_different_path" / "subfolder" / "job_b"
    job_dir_b.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(fixture_dir / "Data", job_dir_b / "Data")
    shutil.copytree(fixture_dir / "Experiments", job_dir_b / "Experiments")
    shutil.copytree(fixture_dir / "Parameters", job_dir_b / "Parameters")
    spec.to_file(job_dir_b / "job.json")

    # Run in job_dir_b
    cmd_b = [sys.executable, "-m", "resoflow.engine", "run", "job.json"]
    res_b = subprocess.run(cmd_b, cwd=job_dir_b, capture_output=True, text=True, env=env)
    assert res_b.returncode == 0, f"Run in dir B failed with {res_b.returncode}. Log: {(job_dir_b / 'engine.log').read_text()}"

    res_data_b = EngineResult.from_file(job_dir_b / "output" / "engine_result.json")
    assert res_data_b.status == "complete"

    # Compare values
    for k, v in res_data_a.final_values.items():
        assert k in res_data_b.final_values
        assert abs(v - res_data_b.final_values[k]) < 1e-7
