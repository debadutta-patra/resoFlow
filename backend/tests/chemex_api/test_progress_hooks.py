"""Tests asserting progress capture hooks (fit, grid, mcmc) and heartbeat."""

import json
import shutil
import subprocess
import sys
from pathlib import Path

from resoflow.chemex_api.spec import FitJobSpec


def _setup_tiny_cpmg(target_dir: Path) -> tuple[list[str], list[str]]:
    fixture_dir = Path(__file__).resolve().parent.parent / "fixtures" / "baselines" / "2026.6.1" / "cpmg_15n_ip" / "inputs"
    shutil.copytree(fixture_dir / "Data", target_dir / "Data")
    shutil.copytree(fixture_dir / "Experiments", target_dir / "Experiments")
    shutil.copytree(fixture_dir / "Parameters", target_dir / "Parameters")
    exp_files = [f"Experiments/{f.name}" for f in sorted((target_dir / "Experiments").glob("*.toml"))]
    param_files = [f"Parameters/{f.name}" for f in sorted((target_dir / "Parameters").glob("*.toml"))]
    return exp_files, param_files


def test_fit_and_grid_progress_events(tmp_path: Path):
    job_dir = tmp_path / "progress_job"
    job_dir.mkdir()
    exp_files, param_files = _setup_tiny_cpmg(job_dir)

    # Method with a tiny grid search followed by fit
    method_file = job_dir / "method_grid.toml"
    method_file.write_text(
        "[STEP1]\n"
        "GRID = [\"[KEX_AB] = log(200.0, 500.0, 2)\"]\n"
        "\n"
        "[STEP2]\n"
        "FIT = [\"KEX_AB\"]\n"
    )

    spec = FitJobSpec(
        job_id="grid-progress-test",
        chemex_version="2026.9.2",
        experiment_files=exp_files,
        parameter_files=param_files,
        method_files=["method_grid.toml"],
        model="2st",
        include=["2N", "3N"],
        output_dir="output",
        plot="nothing",
    )
    spec.to_file(job_dir / "job.json")

    repo_root = Path(__file__).resolve().parent.parent.parent.parent
    cmd = [sys.executable, "-m", "resoflow.engine", "run", "job.json"]
    res = subprocess.run(cmd, cwd=job_dir, capture_output=True, text=True, env={"PYTHONPATH": str(repo_root)})
    assert res.returncode == 0, f"Engine run failed: {res.stderr}\n{res.stdout}"

    # Verify heartbeat exists
    heartbeat_path = job_dir / "heartbeat"
    assert heartbeat_path.exists()
    assert len(heartbeat_path.read_text().strip()) > 0

    # Verify progress.jsonl
    progress_path = job_dir / "progress.jsonl"
    assert progress_path.exists()

    lines = [json.loads(line) for line in progress_path.read_text().strip().split("\n") if line.strip()]
    assert len(lines) > 0

    # Assert seq is strictly increasing
    seqs = [entry["seq"] for entry in lines]
    assert seqs == list(range(1, len(seqs) + 1))

    # Assert fit and grid events exist
    fit_events = [e for e in lines if e.get("kind") == "fit"]
    grid_events = [e for e in lines if e.get("kind") == "grid"]

    assert len(fit_events) >= 1
    assert any("chisqr" in e for e in fit_events)
    assert len(grid_events) >= 1
    assert any("done" in e and "total" in e for e in grid_events)


def test_mcmc_progress_events(tmp_path: Path):
    job_dir = tmp_path / "mcmc_progress_job"
    job_dir.mkdir()
    exp_files, param_files = _setup_tiny_cpmg(job_dir)

    # Method with a short 20-step MCMC
    method_file = job_dir / "method_mcmc.toml"
    method_file.write_text(
        "[STEP1]\n"
        "FIT = [\"DW_AB\"]\n"
        "\n"
        "[STEP1.STATISTICS.MCMC]\n"
        "STEPS = 20\n"
        "BURN = 2\n"
        "SEED = 42\n"
    )

    spec = FitJobSpec(
        job_id="mcmc-progress-test",
        chemex_version="2026.9.2",
        experiment_files=exp_files,
        parameter_files=param_files,
        method_files=["method_mcmc.toml"],
        model="2st",
        include=["3N"],
        output_dir="output",
        plot="nothing",
    )
    spec.to_file(job_dir / "job.json")

    repo_root = Path(__file__).resolve().parent.parent.parent.parent
    cmd = [sys.executable, "-m", "resoflow.engine", "run", "job.json"]
    res = subprocess.run(cmd, cwd=job_dir, capture_output=True, text=True, env={"PYTHONPATH": str(repo_root)})
    assert res.returncode == 0, f"MCMC engine run failed: {res.stderr}\n{res.stdout}"

    progress_path = job_dir / "progress.jsonl"
    assert progress_path.exists()

    lines = [json.loads(line) for line in progress_path.read_text().strip().split("\n") if line.strip()]
    mcmc_events = [e for e in lines if e.get("kind") == "mcmc"]

    assert len(mcmc_events) >= 1
    # Check that final MCMC event has done == total == 20
    assert any(e.get("done") == 20 and e.get("total") == 20 for e in mcmc_events)
