"""Tests verifying that engine run refuses a ChemEx version mismatch with job.json."""

import json
import subprocess
import sys
from pathlib import Path

from resoflow.chemex_api.spec import FitJobSpec


def test_engine_version_guard_mismatch(tmp_path: Path):
    job_file = tmp_path / "job.json"
    spec = FitJobSpec(
        chemex_version="2026.6.1",  # Deliberate mismatch with installed 2026.9.2
        experiment_files=["Experiments/exp.toml"],
        output_dir="output",
    )
    spec.to_file(job_file)

    repo_root = Path(__file__).resolve().parent.parent.parent.parent
    cmd = [sys.executable, "-m", "resoflow.engine", "run", str(job_file)]
    res = subprocess.run(cmd, cwd=tmp_path, capture_output=True, text=True, env={"PYTHONPATH": str(repo_root)})

    assert res.returncode == 2, f"Expected exit 2, got {res.returncode}. Stderr: {res.stderr}"

    result_json_path = tmp_path / "output" / "engine_result.json"
    assert result_json_path.exists(), "engine_result.json must be written on version mismatch"

    result_data = json.loads(result_json_path.read_text(encoding="utf-8"))
    assert result_data["status"] == "failed"
    assert result_data["exit_code"] == 2
    assert result_data["error"]["type"] == "VersionMismatchError"
    assert "ChemEx version mismatch" in result_data["error"]["message"]
