"""Seed an isolated demo database + project for UI screenshots (never touches the dev Postgres).

Usage (from the repo root):
    DATABASE_URL=sqlite:////tmp/shots/demo.db uv run --project backend \
        python dev/screenshots/seed_demo.py /tmp/shots

Creates user demo@resoflow.local / demo-password, one project, and one 15N-CEST
analysis whose run directory holds the cest_15n test inputs (2 B1 fields, 16 residues)
and a two-step method (GRID on PB/KEX_AB, then a refine step). Prints the URL path of the
analysis page. Pass --with-run to also run ChemEx on 3 residues so the Methods page has
committed results (GRID surface, per-step values) to show.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT))

FIXTURE = ROOT / "backend" / "tests" / "fixtures" / "baselines" / "2026.6.1" / "cest_15n" / "inputs"

METHOD_CONFIG = {
    "steps": [
        {
            "id": "step_grid",
            "name": "STEP1",
            "parameters": [
                {"name": "PB", "mode": "fit"},
                {"name": "KEX_AB", "mode": "fit"},
                {"name": "DW_AB", "mode": "fit"},
                {"name": "CS_A", "mode": "fit"},
                {"name": "R2_B", "mode": "constrain", "expression": "[R2_A]"},
            ],
            "residueMode": "include",
            "residues": ["13N", "26N", "28N"],
            "roleRules": [],
            "search": {
                "mode": "grid",
                "axes": [
                    {"id": "ax_pb", "param": "PB", "fn": "log", "low": 0.01, "high": 0.1, "count": 3},
                    {"id": "ax_kex", "param": "KEX_AB", "fn": "log", "low": 20.0, "high": 200.0, "count": 3},
                ],
            },
        },
        {
            "id": "step_refine",
            "name": "STEP2",
            "parameters": [],
            "residueMode": "include",
            "residues": ["13N", "26N", "28N"],
            "roleRules": [],
        },
        {
            "id": "step_local",
            "name": "STEP3",
            "parameters": [{"name": "PB", "mode": "fix"}, {"name": "KEX_AB", "mode": "fix"}],
            "residueMode": "all",
            "residues": [],
            "roleRules": [],
        },
    ]
}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("workdir")
    ap.add_argument("--with-run", action="store_true")
    args = ap.parse_args()
    if not os.environ.get("DATABASE_URL", "").startswith("sqlite"):
        sys.exit("Refusing to seed: set DATABASE_URL to a throwaway sqlite:/// database.")

    from app import database, models, security

    work = Path(args.workdir).resolve()
    proj_dir = work / "demo_project"
    models.Base.metadata.drop_all(bind=database.engine)
    models.Base.metadata.create_all(bind=database.engine)
    db = database.SessionLocal()
    user = models.User(
        email="demo@resoflow.local",
        full_name="Demo",
        hashed_password=security.get_password_hash("demo-password"),
        is_active=True,
    )
    db.add(user)
    db.commit()
    if proj_dir.exists():
        shutil.rmtree(proj_dir)
    proj_dir.mkdir(parents=True)
    project = models.Project(name="CEST demo", local_directory_path=str(proj_dir), user_id=user.id)
    db.add(project)
    db.commit()
    analysis = models.Analysis(name="15N CEST (demo)", analysis_type="15N-CEST", project_id=project.id, status="PENDING")
    db.add(analysis)
    db.commit()

    run_dir = proj_dir / "cest_fitting" / analysis.analysis_uuid
    for sub in ("Data", "Experiments", "Parameters"):
        shutil.copytree(FIXTURE / sub, run_dir / sub)
    data_files: dict[str, str] = {}
    metadata: dict[str, dict] = {}
    for label, b1 in (("13Hz", 13.0), ("26Hz", 26.0)):
        metadata[label] = {"b1": b1, "b0": 499.243, "carrier": 118.987}
        for f in sorted((run_dir / "Data" / label).glob("*-HN.out")):
            data_files[f"{f.name.split('-')[0]}:{label}"] = str(f)
    config = {"model": "2st", "fit_mode": "global", "data_files": data_files, "metadata": metadata, "method_config": METHOD_CONFIG}
    (run_dir / "config.json").write_text(json.dumps(config, indent=2), encoding="utf-8")

    if args.with_run:
        from app.services.fitting.method_emitter import MethodConfigModel, emit_method_toml_v2

        (run_dir / "Methods").mkdir(exist_ok=True)
        method = emit_method_toml_v2(MethodConfigModel(**METHOD_CONFIG))
        (run_dir / "Methods" / "method.toml").write_text(method, encoding="utf-8")
        cmd = [
            sys.executable, "-m", "chemex", "fit",
            "-e", *[str(p) for p in sorted((run_dir / "Experiments").glob("*.toml"))],
            "-p", str(run_dir / "Parameters" / "parameters.toml"),
            "-m", str(run_dir / "Methods" / "method.toml"),
            "-d", "2st", "-o", str(run_dir / "Output"),
        ]
        subprocess.run(cmd, cwd=run_dir, check=True)
        from datetime import datetime, timezone

        from app.services.results_bundle.ingest import ingest_results

        ingest_results(run_dir, analysis.analysis_uuid, None, analysis.name, "15N-CEST")
        analysis.status = "COMPLETED"
        analysis.completed_at = datetime.now(timezone.utc)
        db.commit()

    print(f"/projects/{project.project_uuid}/analysis/{analysis.analysis_uuid}")


if __name__ == "__main__":
    main()
