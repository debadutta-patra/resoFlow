"""Resolve a method's per-step effective roles with ChemEx against an analysis's inputs."""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any, Optional

from resoflow.chemex_api.roles import resolve_roles

from .chemex_workspace import stage_validation_workspace


def missing_inputs_message(experiment_files: list[str], parameter_files: list[str]) -> Optional[str]:
    """ChemEx's CLI parser exits (SystemExit) without these; report it plainly instead."""
    if not experiment_files:
        return "No experiment files for this analysis yet. Generate the experiments first."
    if not parameter_files:
        return "No parameters file for this analysis yet."
    return None


def resolve_method(
    run_dir: Optional[Path],
    *,
    method_toml: str,
    model: str = "2st",
    parameter_toml: Optional[str] = None,
) -> dict[str, Any]:
    """Validate ``method_toml`` with ChemEx and return every step's resolved roles.

    The analysis's saved method file is ignored; ``method_toml`` is the method
    being edited. ``parameter_toml`` (the unsaved parameters) overrides the saved one.
    """
    with tempfile.TemporaryDirectory() as td:
        job_dir = Path(td)
        spec = stage_validation_workspace(
            run_dir, job_dir, model=model, parameter_toml=parameter_toml, stage_methods=False
        )
        missing = missing_inputs_message(spec.experiment_files, spec.parameter_files)
        if missing:
            return {"valid": False, "format": None, "steps": [], "errors": [{"message": missing, "type": "MissingInputs", "source": {}}]}
        method_path = job_dir / "Methods" / "resolve_method.toml"
        method_path.write_text(method_toml, encoding="utf-8")
        try:
            return resolve_roles(spec, method_path, job_dir)
        except (Exception, SystemExit) as exc:  # session construction failed (inputs, model, parameters)
            return {
                "valid": False,
                "format": None,
                "steps": [],
                "errors": [{"message": str(exc) or type(exc).__name__, "type": type(exc).__name__, "source": {}}],
            }
