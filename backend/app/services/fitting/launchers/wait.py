"""Polling loop and progress/log streaming for launched ChemEx jobs."""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Callable

from .base import JobHandle, JobState, Launcher

logger = logging.getLogger(__name__)


def _format_progress_data(event: dict[str, Any], step: dict[str, Any] | None = None) -> dict[str, Any]:
    """Shape one engine event for progress.json; ``step`` is the method step currently running."""
    k = event.get("kind", "progress")
    prog: dict[str, Any] = {
        "kind": k,
        "updated_at": time.time(),
    }
    if step:
        prog["step"] = step
    if k == "step":
        prog["stage"] = "Step"
        label = event.get("name") or "DEFAULT"
        prog["message"] = f"Starting step {label} ({event.get('index')}/{event.get('total')})"
    elif k == "fit":
        prog["stage"] = "Minimization"
        prog["iteration"] = event.get("iteration", 0)
        prog["chisqr"] = event.get("chisqr")
        prog["redchi"] = event.get("redchi")
        cs = f"{event.get('chisqr'):.2f}" if isinstance(event.get("chisqr"), (int, float)) else "?"
        rc = f"{event.get('redchi'):.2f}" if isinstance(event.get("redchi"), (int, float)) else "?"
        prog["message"] = f"Minimization iter {event.get('iteration')} (χ²: {cs}, red-χ²: {rc})"
    elif k in ("grid", "resample", "mcmc"):
        labels = {
            "grid": "Grid Search",
            "resample": "Resampling",
            "mcmc": "MCMC Sampling",
        }
        stage_name = labels.get(k, k.capitalize())
        prog["stage"] = stage_name
        done = event.get("done", 0)
        total = event.get("total")
        prog["done"] = done
        prog["total"] = total
        if total and total > 0:
            pct = round((done / total) * 100, 1)
            prog["percent"] = pct
            prog["message"] = f"{stage_name}: {done}/{total} ({pct}%)"
        else:
            prog["message"] = f"{stage_name}: {done} steps"
    else:
        prog["stage"] = k.capitalize()
        prog["message"] = str(event)
    return prog


def wait_for_job(
    launcher: Launcher,
    handle: JobHandle,
    on_progress: Callable[[dict[str, Any]], None] | None = None,
    log_file: Path | str | None = None,
    poll_interval: float = 0.5,
    timeout_seconds: float | None = None,
    stale_heartbeat_timeout: float = 30.0,
) -> JobState:
    """Wait for a launched job to complete, tailing progress.jsonl and engine.log.

    Returns the terminal JobState (DONE, FAILED, CANCELLED, LOST).
    """
    job_dir = Path(handle.job_dir)
    progress_jsonl = job_dir / "progress.jsonl"
    engine_log = job_dir / "engine.log"
    heartbeat_file = job_dir / "heartbeat"
    progress_file = job_dir / "progress.json"

    progress_offset = 0
    engine_log_offset = 0

    log_fp = None
    if log_file:
        log_path = Path(log_file)
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_fp = open(log_path, "a", encoding="utf-8")

    last_file_write_time = 0.0
    last_milestones: dict[str, int] = {}
    current_step: dict[str, Any] | None = None
    last_heartbeat_seen = time.time()
    start_time = time.time()

    def _drain_progress() -> None:
        nonlocal progress_offset, last_file_write_time, current_step
        if not progress_jsonl.exists():
            return
        try:
            with open(progress_jsonl, "r", encoding="utf-8") as pf:
                pf.seek(progress_offset)
                for line in pf:
                    line_str = line.strip()
                    if not line_str:
                        continue
                    try:
                        event = json.loads(line_str)
                    except Exception:
                        continue

                    if on_progress:
                        try:
                            on_progress(event)
                        except Exception as e:
                            logger.debug(f"on_progress callback error: {e}")

                    step_changed = event.get("kind") == "step"
                    if step_changed:
                        current_step = {
                            "name": event.get("name") or "",
                            "index": event.get("index"),
                            "total": event.get("total"),
                            "started_at": event.get("t", time.time()),
                        }
                        # Fresh milestones per step; announce it in the run log.
                        last_milestones.clear()
                        if log_fp:
                            log_fp.write(
                                f"[{handle.id}] Step {current_step['index']}/{current_step['total']}: "
                                f"{current_step['name'] or 'DEFAULT'}\n"
                            )
                            log_fp.flush()

                    # Write structured progress.json throttled to 250ms (step changes always written)
                    prog_data = _format_progress_data(event, current_step)
                    now = time.time()
                    pct = prog_data.get("percent", 0)
                    if step_changed or pct >= 100 or (now - last_file_write_time >= 0.25):
                        last_file_write_time = now
                        try:
                            tmp_p = progress_file.with_name(f"{progress_file.name}.tmp")
                            tmp_p.write_text(json.dumps(prog_data), encoding="utf-8")
                            tmp_p.replace(progress_file)
                        except Exception:
                            pass

                    # Write milestones to log_file
                    if log_fp:
                        k = event.get("kind")
                        if k in ("grid", "resample", "mcmc"):
                            total = event.get("total")
                            done = event.get("done", 0)
                            if total and total > 0:
                                pct_int = int((done / total) * 100)
                                bucket = (pct_int // 25) * 25
                                if bucket > last_milestones.get(k, -1):
                                    last_milestones[k] = bucket
                                    log_fp.write(f"[{handle.id}] {k.upper()} progress: {bucket}% ({done}/{total})\n")
                                    log_fp.flush()

                progress_offset = pf.tell()
        except Exception as exc:
            logger.debug(f"Error reading progress.jsonl: {exc}")

    def _drain_log() -> None:
        nonlocal engine_log_offset
        if not engine_log.exists():
            return
        try:
            with open(engine_log, "r", encoding="utf-8", errors="replace") as ef:
                ef.seek(engine_log_offset)
                chunk = ef.read()
                if chunk and log_fp:
                    log_fp.write(chunk)
                    log_fp.flush()
                engine_log_offset = ef.tell()
        except Exception as exc:
            logger.debug(f"Error reading engine.log: {exc}")

    try:
        while True:
            _drain_progress()
            _drain_log()

            # Heartbeat monitoring
            if heartbeat_file.exists():
                try:
                    hb_mtime = heartbeat_file.stat().st_mtime
                    if hb_mtime > last_heartbeat_seen:
                        last_heartbeat_seen = hb_mtime
                except OSError:
                    pass

            now = time.time()
            if timeout_seconds and (now - start_time) > timeout_seconds:
                logger.warning(f"Job {handle.id} timed out after {timeout_seconds}s")
                launcher.cancel(handle)
                return JobState.CANCELLED

            state = launcher.poll(handle)

            # Check for stale heartbeat
            if state == JobState.RUNNING:
                if (now - last_heartbeat_seen) > stale_heartbeat_timeout:
                    # Double-check state
                    latest_state = launcher.poll(handle)
                    if latest_state != JobState.RUNNING:
                        state = latest_state
                    else:
                        logger.warning(f"Job {handle.id} heartbeat stale ({now - last_heartbeat_seen:.1f}s > {stale_heartbeat_timeout}s)")
                        state = JobState.LOST

            if state in (JobState.DONE, JobState.FAILED, JobState.CANCELLED, JobState.LOST):
                # Drain remaining output
                _drain_progress()
                _drain_log()

                # Write final terminal state to progress.json
                final_stage = "Completed" if state == JobState.DONE else ("Cancelled" if state == JobState.CANCELLED else "Failed")
                final_prog = {
                    "kind": "completed" if state == JobState.DONE else ("cancelled" if state == JobState.CANCELLED else "failed"),
                    "stage": final_stage,
                    "percent": 100.0 if state == JobState.DONE else 0.0,
                    "message": f"Run {final_stage.lower()}",
                    "updated_at": time.time(),
                }
                try:
                    tmp_p = progress_file.with_name(f"{progress_file.name}.tmp")
                    tmp_p.write_text(json.dumps(final_prog), encoding="utf-8")
                    tmp_p.replace(progress_file)
                except Exception:
                    pass

                return state

            time.sleep(poll_interval)
    finally:
        if log_fp:
            log_fp.close()
