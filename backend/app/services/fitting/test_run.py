"""Quick "Test on 1 residue" runs of the current method (Methods page, Phase E8).

The method is reduced for speed — every step INCLUDEs only the chosen residue, all
STATISTICS are stripped and every GRID axis keeps at most 3 points — and run in-process
with ChemEx in an isolated workspace ``<run_dir>/test_runs/<test_id>/``. Nothing of the
analysis is touched: not ``Output/``, not the results bundle, not the analysis status, so a
test never shows up as "Last committed". Its per-step wall times (with the number of fits
each step performed) refine the runtime estimates until a full run exists.
"""

from __future__ import annotations

import json
import logging
import shutil
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from ...celery_app import celery_app
from .method_emitter import emit_method_toml_v2, parse_method_toml

logger = logging.getLogger(__name__)

TEST_DIRNAME = "test_runs"
MAX_GRID_POINTS = 3
KEEP_TEST_RUNS = 5


def _three(values: list[float]) -> list[float]:
    if len(values) <= MAX_GRID_POINTS:
        return list(values)
    return [values[0], values[len(values) // 2], values[-1]]


def make_test_method(method_toml: str, residue: str) -> str:
    """The current method reduced to one residue, no statistics and ≤ 3 points per GRID axis."""
    cfg = parse_method_toml(method_toml)
    if cfg.raw_override:
        raise ValueError("The method could not be parsed; fix it before a test run.")
    for step in cfg.steps:
        step.residue_mode = "include"
        step.residues = [residue]
        step.statistics = None
        search = step.search
        if search is not None and search.mode == "grid":
            for axis in search.axes:
                if axis.fn == "values":
                    axis.values = _three(list(axis.values or []))
                else:
                    axis.count = min(int(axis.count or MAX_GRID_POINTS), MAX_GRID_POINTS)
    return emit_method_toml_v2(cfg)


def test_root(run_dir: Path) -> Path:
    return run_dir / TEST_DIRNAME


def _status_path(run_dir: Path, test_id: str) -> Path:
    return test_root(run_dir) / test_id / "status.json"


def write_status(run_dir: Path, test_id: str, data: dict[str, Any]) -> None:
    path = _status_path(run_dir, test_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    tmp.replace(path)


def read_status(run_dir: Path, test_id: str) -> Optional[dict[str, Any]]:
    path = _status_path(run_dir, test_id)
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def latest_status(run_dir: Path) -> Optional[dict[str, Any]]:
    root = test_root(run_dir)
    if not root.is_dir():
        return None
    runs = [read_status(run_dir, d.name) for d in root.iterdir() if d.is_dir()]
    runs = [r for r in runs if r]
    return max(runs, key=lambda r: r.get("queued_at") or "", default=None)


def _prune(run_dir: Path) -> None:
    root = test_root(run_dir)
    dirs = sorted((d for d in root.iterdir() if d.is_dir()), key=lambda d: d.stat().st_mtime) if root.is_dir() else []
    for d in dirs[:-KEEP_TEST_RUNS]:
        shutil.rmtree(d, ignore_errors=True)


def queue_test_run(run_dir: Path, *, method_toml: str, parameter_toml: Optional[str], model: str, residue: str, experiments: Optional[list]) -> dict[str, Any]:
    """Validate the reduction, record a queued status and dispatch the Celery task."""
    test_method = make_test_method(method_toml, residue)
    test_id = uuid.uuid4().hex[:12]
    status = {
        "test_id": test_id,
        "state": "queued",
        "residue": residue,
        "model": model,
        "method_toml": test_method,
        "queued_at": datetime.now(timezone.utc).isoformat(),
        "steps": [],
    }
    write_status(run_dir, test_id, status)
    _prune(run_dir)
    run_test_fit_task.apply_async(args=[str(run_dir), test_id, test_method, parameter_toml, model, residue, experiments])
    return status


def execute_test_run(run_dir: Path, test_id: str, test_method: str, parameter_toml: Optional[str], model: str, residue: str, experiments: Optional[list]) -> dict[str, Any]:
    """Stage an isolated workspace and run ChemEx in-process; returns (and stores) the final status."""
    from resoflow.chemex_api.fit import run_fit

    from .chemex_workspace import stage_validation_workspace

    status = read_status(run_dir, test_id) or {"test_id": test_id, "residue": residue, "model": model}
    target = test_root(run_dir) / test_id / "job"
    if target.exists():
        shutil.rmtree(target, ignore_errors=True)
    target.mkdir(parents=True)
    started = time.time()
    status.update({"state": "running", "started_at": datetime.now(timezone.utc).isoformat()})
    write_status(run_dir, test_id, status)

    steps: list[dict[str, Any]] = []

    def observer(event: dict[str, Any]) -> None:
        if event.get("kind") == "step":
            now = time.time()
            if steps and steps[-1].get("seconds") is None:
                steps[-1]["seconds"] = round(now - steps[-1]["started_at"], 3)
            steps.append({"name": event.get("name") or "DEFAULT", "index": event.get("index"), "started_at": now, "seconds": None})

    try:
        spec = stage_validation_workspace(
            run_dir, target, model=model, parameter_toml=parameter_toml, method_toml=test_method, experiments=experiments
        )
        result = run_fit(spec, observer=observer, job_dir=target)
        if getattr(result, "status", "complete") == "complete":
            state, error = "done", None
        else:
            info = getattr(result, "error", None)
            state, error = "failed", (getattr(info, "message", None) or str(getattr(result, "status", "failed")))
    except BaseException as exc:  # noqa: BLE001 — report every failure to the page
        state, error = "failed", str(exc) or exc.__class__.__name__
        logger.info("Test run %s failed: %s", test_id, error)
    end = time.time()
    if steps and steps[-1].get("seconds") is None:
        steps[-1]["seconds"] = round(end - steps[-1]["started_at"], 3)
        steps[-1]["incomplete"] = state != "done"
    for s in steps:
        s.pop("started_at", None)
    status.update(
        {
            "state": state,
            "error": error,
            "seconds": round(end - started, 3),
            "finished_at": datetime.now(timezone.utc).isoformat(),
            "steps": _with_evaluations(target, test_method, model, experiments, steps),
        }
    )
    write_status(run_dir, test_id, status)
    return status


def _with_evaluations(target: Path, method: str, model: str, experiments: Optional[list], steps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Number of fits each test step performed (GRID: profiled evaluations), for per-fit timing."""
    try:
        from .method_resolution import validate_method_for_analysis

        report = validate_method_for_analysis(target, method_toml=method, model=model, experiments=None)
        by_name: dict[str, Any] = {}
        for st in report.get("steps", []):
            search = st.get("search") or {}
            by_name[st["name"]] = search.get("evaluations") if search.get("kind") == "grid" else (None if search.get("kind") == "de" else 1)
        for s in steps:
            s["evaluations"] = by_name.get(s["name"], 1)
    except Exception as exc:
        logger.debug("test run evaluations unavailable: %s", exc)
        for s in steps:
            s.setdefault("evaluations", 1)
    return steps


@celery_app.task(name="app.services.fitting.test_run.run_test_fit_task")
def run_test_fit_task(run_dir: str, test_id: str, test_method: str, parameter_toml: Optional[str], model: str, residue: str, experiments: Optional[list]) -> dict[str, Any]:
    return execute_test_run(Path(run_dir), test_id, test_method, parameter_toml, model, residue, experiments)
