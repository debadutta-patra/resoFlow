"""Tests verifying graceful cancellation on SIGTERM signal."""

import json
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

from resoflow.chemex_api.results import EngineResult
from resoflow.chemex_api.spec import FitJobSpec


def test_engine_sigterm_cancellation(tmp_path: Path):
    fixture_dir = Path(__file__).resolve().parent.parent / "fixtures" / "baselines" / "2026.6.1" / "cpmg_15n_ip" / "inputs"
    job_dir = tmp_path / "sigterm_job"
    job_dir.mkdir()
    shutil.copytree(fixture_dir / "Data", job_dir / "Data")
    shutil.copytree(fixture_dir / "Experiments", job_dir / "Experiments")
    shutil.copytree(fixture_dir / "Parameters", job_dir / "Parameters")

    # Include more residues so it runs long enough to receive SIGTERM
    spec = FitJobSpec(
        job_id="sigterm-test",
        chemex_version="2026.9.2",
        experiment_files=[f"Experiments/{f.name}" for f in sorted((job_dir / "Experiments").glob("*.toml"))],
        parameter_files=[f"Parameters/{f.name}" for f in sorted((job_dir / "Parameters").glob("*.toml"))],
        model="2st",
        include=["2N", "3N", "4N", "5N", "6N", "7N", "8N"],
        output_dir="output",
        plot="nothing",
    )
    spec.to_file(job_dir / "job.json")

    repo_root = Path(__file__).resolve().parent.parent.parent.parent
    cmd = [sys.executable, "-m", "resoflow.engine", "run", "job.json"]
    proc = subprocess.Popen(
        cmd,
        cwd=job_dir,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={"PYTHONPATH": str(repo_root)},
    )

    # Wait until engine starts and creates heartbeat
    for _ in range(50):
        if (job_dir / "heartbeat").exists():
            break
        time.sleep(0.1)

    proc.send_signal(signal.SIGTERM)

    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        raise AssertionError("Engine did not terminate within 10s after SIGTERM")

    assert proc.returncode == 130, f"Expected returncode 130 on SIGTERM, got {proc.returncode}"

    res_file = job_dir / "output" / "engine_result.json"
    assert res_file.exists(), "engine_result.json must be written on cancellation"

    res = EngineResult.from_file(res_file)
    assert res.status == "cancelled"
    assert res.exit_code == 130

    outcome_file = job_dir / "output" / "run_info" / "outcome.toml"
    if outcome_file.exists():
        content = outcome_file.read_text(encoding="utf-8")
        assert "incomplete" in content
