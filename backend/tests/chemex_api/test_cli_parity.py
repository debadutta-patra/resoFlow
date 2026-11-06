"""Parity tests asserting identical output trees between chemex fit and resoflow.engine run."""

import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Sequence

import pytest
from tests.parity.compare_trees import compare_trees
from resoflow.chemex_api.spec import FitJobSpec

CASES = [
    ("cpmg_15n_ip", ["3N"]),
    ("cest_15n", ["13N"]),
    ("cpmg_15n_ip_grid", ["15N"]),
    ("cpmg_15n_ip_stat", ["15N"]),
    ("dcest_15n", ["F4N"]),
    ("resoflow_cest", ["12N"]),
    ("resoflow_cpmg", ["3N"]),
]


def _run_parity(
    tmp_path: Path,
    case_name: str,
    include: Sequence[str] | None = None,
) -> tuple[bool, list[str]]:
    fixture_dir = (
        Path(__file__).resolve().parent.parent
        / "fixtures"
        / "baselines"
        / "2026.6.1"
        / case_name
        / "inputs"
    )
    if not fixture_dir.exists():
        pytest.skip(f"Baseline inputs for {case_name} not found.")

    d_cli = tmp_path / "cli"
    d_eng = tmp_path / "eng"
    shutil.copytree(fixture_dir, d_cli)
    shutil.copytree(fixture_dir, d_eng)

    exp_files = [f"Experiments/{f.name}" for f in sorted((d_cli / "Experiments").glob("*.toml"))]
    param_files = [f"Parameters/{f.name}" for f in sorted((d_cli / "Parameters").glob("*.toml"))]
    method_dir = d_cli / "Methods"
    method_files = [f"Methods/{f.name}" for f in sorted(method_dir.glob("*.toml"))] if method_dir.exists() else []

    env = dict(os.environ)
    env["MPLBACKEND"] = "Agg"
    repo_root = Path(__file__).resolve().parent.parent.parent.parent
    env["PYTHONPATH"] = str(repo_root)

    # 1. Run chemex fit via CLI
    cmd_cli = [
        sys.executable,
        "-m",
        "chemex",
        "fit",
        "-e",
        *exp_files,
        "-p",
        *param_files,
        "-o",
        "output",
        "--plot",
        "nothing",
    ]
    if method_files:
        cmd_cli.extend(["-m", *method_files])
    if include:
        cmd_cli.extend(["--include", *include])

    res_cli = subprocess.run(cmd_cli, cwd=d_cli, capture_output=True, text=True, env=env)
    assert res_cli.returncode == 0, f"CLI fit failed: {res_cli.stderr}\n{res_cli.stdout}"

    # 2. Run resoFlow engine via job.json
    spec = FitJobSpec(
        job_id=f"parity-{case_name}",
        chemex_version="2026.9.2",
        experiment_files=exp_files,
        parameter_files=param_files,
        method_files=method_files,
        model="2st",
        include=list(include) if include else [],
        output_dir="output",
        plot="nothing",
    )
    spec.to_file(d_eng / "job.json")

    cmd_eng = [sys.executable, "-m", "resoflow.engine", "run", "job.json"]
    res_eng = subprocess.run(cmd_eng, cwd=d_eng, capture_output=True, text=True, env=env)
    assert res_eng.returncode == 0, f"Engine run failed: {res_eng.stderr}\n{(d_eng / 'engine.log').read_text() if (d_eng / 'engine.log').exists() else ''}"

    # 3. Compare trees with rtol=1e-12
    return compare_trees(d_cli / "output", d_eng / "output", rtol=1e-12, atol=1e-12)


@pytest.mark.parametrize("case_name, include", CASES)
def test_cli_parity_cases(tmp_path: Path, case_name: str, include: list[str]):
    """Test CLI vs Engine bit-for-bit parity across all Phase 0 baseline cases."""
    match, mismatches = _run_parity(tmp_path, case_name, include=include)
    assert match, f"Parity mismatch in {case_name}:\n" + "\n".join(mismatches)


@pytest.mark.slow
def test_cli_parity_full_cest(tmp_path: Path):
    """Full-dataset parity test on cest_15n without residue filtering."""
    match, mismatches = _run_parity(tmp_path, "cest_15n", include=None)
    assert match, "Full cest_15n parity mismatch:\n" + "\n".join(mismatches)
