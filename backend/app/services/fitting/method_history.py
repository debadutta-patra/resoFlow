"""Completed runs whose method can be loaded into the Methods editor ("Load method from run…").

A project keeps one run per analysis plus that analysis's previous run (``Output_bak``), so the
history is: every analysis of the same family in the project with a completed run, and each
backup. The method snapshot is the one ChemEx archived in ``run_info/inputs/methods`` (the
exact text the run used); red-χ² comes from the cached results bundle when present.
"""

from __future__ import annotations

import json
import tomllib
from pathlib import Path
from typing import Any, Optional

FAMILY_TYPES: dict[str, set[str]] = {
    "cest": {"15N-CEST", "CEST"},
    "cpmg": {"CPMG"},
    "exchange": {"EXCHANGE"},
}


def _snapshot(output_dir: Path) -> Optional[str]:
    methods = output_dir / "run_info" / "inputs" / "methods"
    files = sorted(methods.glob("*.toml")) if methods.is_dir() else []
    return "\n".join(f.read_text(encoding="utf-8") for f in files) if files else None


def _step_names(method_toml: str) -> list[str]:
    try:
        data = tomllib.loads(method_toml)
    except Exception:
        return []
    return [k for k, v in data.items() if isinstance(v, dict)]


def _bundle_redchi(results_dir: Path) -> Optional[float]:
    path = results_dir / "run_overview.json"
    if not path.is_file():
        return None
    try:
        steps = json.loads(path.read_text(encoding="utf-8")).get("steps") or []
    except Exception:
        return None
    for step in reversed(steps):
        if isinstance(step.get("redchi"), (int, float)):
            return float(step["redchi"])
    return None


def method_history(analyses: list[Any], run_dir_of, family: str) -> list[dict[str, Any]]:
    types = FAMILY_TYPES.get(family, set())
    out: list[dict[str, Any]] = []
    for a in analyses:
        if types and (a.analysis_type or "").upper() not in {t.upper() for t in types}:
            continue
        run_dir = Path(run_dir_of(a))
        for source, output_dir, results_dir in (("current", run_dir / "Output", run_dir / "results"), ("backup", run_dir / "Output_bak", run_dir / "results_bak")):
            if source == "current" and (a.status or "").upper() not in {"COMPLETED", "COMPLETED_WITH_ERRORS"}:
                continue
            method = _snapshot(output_dir)
            if not method:
                continue
            redchi = _bundle_redchi(results_dir)
            if redchi is None and source == "current" and a.summary_redchi is not None:
                redchi = float(a.summary_redchi)
            completed = a.completed_at.isoformat() if (source == "current" and a.completed_at) else None
            if source == "backup" and completed is None:
                try:
                    completed = Path(output_dir).stat().st_mtime
                    from datetime import datetime, timezone

                    completed = datetime.fromtimestamp(completed, tz=timezone.utc).isoformat()
                except OSError:
                    completed = None
            out.append(
                {
                    "analysis_uuid": a.analysis_uuid,
                    "analysis_name": a.name,
                    "source": source,
                    "completed_at": completed,
                    "redchi": redchi,
                    "steps": _step_names(method),
                    "method_toml": method,
                }
            )
    out.sort(key=lambda r: r["completed_at"] or "", reverse=True)
    return out
