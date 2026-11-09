"""Resolve a method's per-step effective roles with ChemEx against an analysis's inputs."""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any, Optional

from resoflow.chemex_api.compat import check_version
from resoflow.chemex_api.roles import validate_method

from .chemex_workspace import stage_validation_workspace


def missing_inputs_message(experiment_files: list[str], parameter_files: list[str]) -> Optional[str]:
    """ChemEx's CLI parser exits (SystemExit) without these; report it plainly instead."""
    if not experiment_files:
        return "No experiment files for this analysis yet. Generate the experiments first."
    if not parameter_files:
        return "No parameters file for this analysis yet."
    return None


def validate_method_for_analysis(
    run_dir: Optional[Path],
    *,
    method_toml: str,
    model: str = "2st",
    parameter_toml: Optional[str] = None,
    include: Optional[list[str]] = None,
    exclude: Optional[list[str]] = None,
    sharing_warnings: bool = False,
    experiments: Optional[list] = None,
) -> dict[str, Any]:
    """Validate ``method_toml`` with ChemEx against an analysis's inputs.

    Returns ``{valid, format, errors, warnings, steps, chemex_version}`` where each step
    carries its resolved roles and search resolution. The analysis's saved method file is
    ignored (``method_toml`` is the method being checked); ``parameter_toml`` (unsaved
    parameters) overrides the saved one.
    """
    with tempfile.TemporaryDirectory() as td:
        job_dir = Path(td)
        spec = stage_validation_workspace(
            run_dir, job_dir, model=model, parameter_toml=parameter_toml, include=include, exclude=exclude,
            stage_methods=False, experiments=experiments,
        )
        missing = missing_inputs_message(spec.experiment_files, spec.parameter_files)
        if missing:
            return {"valid": False, "format": None, "steps": [], "warnings": [], "chemex_version": check_version(),
                    "errors": [{"message": missing, "type": "MissingInputs", "source": {}}]}
        method_path = job_dir / "Methods" / "method.toml"
        method_path.write_text(method_toml, encoding="utf-8")
        return validate_method(spec, method_path, job_dir, sharing_warnings=sharing_warnings)


def step_timings_with_evaluations(run_dir: Path, model: str = "2st", experiments: Optional[list] = None) -> dict[str, Any]:
    """Last run's per-step durations plus how many fits each step performed.

    ``evaluations`` is 1 for a plain TRF step and the profiled GRID evaluation count
    for a GRID step (ChemEx does not report grid progress, so the count is recomputed
    once from the run's own method snapshot and cached in step_timings.json).
    DE steps get ``None`` (stochastic; no per-evaluation cost).
    """
    import json

    path = run_dir / "step_timings.json"
    if not path.exists():
        return {"state": None, "steps": [], "workers": None}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {"state": None, "steps": [], "workers": None}
    steps = [s for s in data.get("steps", []) if isinstance(s, dict)]
    if steps and any("evaluations" not in s for s in steps):
        method_files = sorted((run_dir / "Methods").glob("*.toml")) if (run_dir / "Methods").is_dir() else []
        by_name: dict[str, Any] = {}
        if method_files:
            report = validate_method_for_analysis(
                run_dir, method_toml=method_files[0].read_text(encoding="utf-8"), model=model, experiments=experiments
            )
            for st in report.get("steps", []):
                search = st.get("search") or {}
                if search.get("kind") == "grid":
                    by_name[st["name"]] = search.get("evaluations")
                elif search.get("kind") == "de":
                    by_name[st["name"]] = None
                else:
                    by_name[st["name"]] = 1
        for s in steps:
            s["evaluations"] = by_name.get(s.get("name") or "", 1 if not method_files else None)
        data["steps"] = steps
        try:
            path.write_text(json.dumps(data), encoding="utf-8")
        except Exception:
            pass
    return {"state": data.get("state"), "steps": steps, "workers": data.get("workers")}
