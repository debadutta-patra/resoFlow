"""Tests asserting that resoflow.engine is completely isolated from backend/app."""

import json
import shutil
import subprocess
import sys
from pathlib import Path


def test_engine_has_no_backend_imports():
    """Verify that importing resoflow.engine does not pull in backend or app modules."""
    code = (
        "import sys\n"
        "import resoflow.engine.__main__\n"
        "bad = [m for m in sys.modules if m.startswith('app.') or m.startswith('backend.')]\n"
        "if bad:\n"
        "    print(f'Leaked modules: {bad}')\n"
        "    sys.exit(1)\n"
    )
    res = subprocess.run(
        [sys.executable, "-c", code],
        cwd=Path(__file__).resolve().parent.parent.parent.parent,
        capture_output=True,
        text=True,
        env={"PYTHONPATH": "."},
    )
    assert res.returncode == 0, f"Engine leaked backend/app imports: {res.stderr}\n{res.stdout}"


def test_engine_standalone_run(tmp_path: Path):
    """Run a tiny fit using only resoflow on PYTHONPATH."""
    fixture_dir = Path(__file__).resolve().parent.parent / "fixtures" / "baselines" / "2026.6.1" / "cpmg_15n_ip" / "inputs"
    job_dir = tmp_path / "standalone_job"
    job_dir.mkdir()
    shutil.copytree(fixture_dir / "Data", job_dir / "Data")
    shutil.copytree(fixture_dir / "Experiments", job_dir / "Experiments")
    shutil.copytree(fixture_dir / "Parameters", job_dir / "Parameters")

    job_spec = {
        "schema": 1,
        "chemex_version": "2026.9.2",
        "experiment_files": [f"Experiments/{f.name}" for f in sorted((job_dir / "Experiments").glob("*.toml"))],
        "parameter_files": [f"Parameters/{f.name}" for f in sorted((job_dir / "Parameters").glob("*.toml"))],
        "model": "2st",
        "include": ["3N"],
        "output_dir": "output",
        "plot": "nothing",
    }
    (job_dir / "job.json").write_text(json.dumps(job_spec), encoding="utf-8")

    repo_root = Path(__file__).resolve().parent.parent.parent.parent
    cmd = [sys.executable, "-m", "resoflow.engine", "run", "job.json"]
    res = subprocess.run(cmd, cwd=job_dir, capture_output=True, text=True, env={"PYTHONPATH": str(repo_root)})

    assert res.returncode == 0, f"Standalone run failed: {res.stderr}"
    assert (job_dir / "output" / "engine_result.json").exists()
