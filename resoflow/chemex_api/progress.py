"""Progress hooks and file logger for ChemEx execution."""

from __future__ import annotations

import contextlib
import json
import threading
import time
from pathlib import Path
from typing import Any, Callable, Generator

import chemex.optimize.mcmc
import chemex.optimize.native_deterministic
import chemex.optimize.resampling
from chemex.messages import McmcProgressReporter, MinimizationProgressReporter

ProgressObserver = Callable[[dict[str, Any]], None]

_ACTIVE_OBSERVER: ProgressObserver | None = None
_HOOK_LOCK = threading.Lock()


class ProgressFileLogger:
    """Thread-safe rate-limiting logger streaming JSON events to progress.jsonl."""

    def __init__(self, job_dir: str | Path, min_interval_s: float = 0.25) -> None:
        self.job_dir = Path(job_dir)
        self.path = self.job_dir / "progress.jsonl"
        self.min_interval_s = min_interval_s
        self._seq = 0
        self._last_emitted_t: dict[str, float] = {}
        self._lock = threading.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._file = open(self.path, "a", encoding="utf-8")

    def __call__(self, event: dict[str, Any]) -> None:
        self.log_event(event)

    def log_event(self, event: dict[str, Any], force: bool = False) -> None:
        kind = event.get("kind", "unknown")
        now = time.time()

        with self._lock:
            is_first = kind not in self._last_emitted_t
            is_final = False
            done = event.get("done")
            total = event.get("total")
            if total is not None and done is not None and done >= total:
                is_final = True

            last_t = self._last_emitted_t.get(kind, 0.0)
            if not (force or is_first or is_final or (now - last_t >= self.min_interval_s)):
                return

            self._seq += 1
            record = {
                "t": round(now, 4),
                "seq": self._seq,
                **event,
            }
            line = json.dumps(record) + "\n"
            self._file.write(line)
            self._file.flush()
            self._last_emitted_t[kind] = now

    def close(self) -> None:
        with self._lock:
            if not self._file.closed:
                self._file.flush()
                self._file.close()


def start_heartbeat(job_dir: str | Path, interval: float = 15.0) -> Callable[[], None]:
    """Start a background daemon thread updating <job_dir>/heartbeat every interval seconds."""
    stop_event = threading.Event()
    heartbeat_path = Path(job_dir) / "heartbeat"
    heartbeat_path.parent.mkdir(parents=True, exist_ok=True)

    def _loop() -> None:
        while not stop_event.is_set():
            try:
                heartbeat_path.write_text(f"{time.time():.4f}\n", encoding="utf-8")
            except Exception:
                pass
            stop_event.wait(interval)

    # Write initial heartbeat immediately
    try:
        heartbeat_path.write_text(f"{time.time():.4f}\n", encoding="utf-8")
    except Exception:
        pass

    thread = threading.Thread(target=_loop, name="resoFlowHeartbeat", daemon=True)
    thread.start()

    def _stop() -> None:
        stop_event.set()
        thread.join(timeout=1.0)

    return _stop


class _WrappedMinimizationProgressReporter(MinimizationProgressReporter):
    def observe(self, context: Any, event: Any) -> None:
        if _ACTIVE_OBSERVER is not None:
            try:
                iteration = getattr(event, "objective_evaluations_completed", None)
                chisqr = getattr(event, "best_chi_square", None)
                redchi = getattr(event, "reduced_chi_square", None)
                _ACTIVE_OBSERVER({
                    "kind": "fit",
                    "iteration": iteration,
                    "chisqr": chisqr,
                    "redchi": redchi,
                })

                grid_total = getattr(context, "grid_seed_total", None)
                if grid_total is not None:
                    grid_ordinal = getattr(context, "grid_seed_ordinal", 0)
                    _ACTIVE_OBSERVER({
                        "kind": "grid",
                        "done": grid_ordinal,
                        "total": grid_total,
                    })
            except Exception:
                pass
        super().observe(context, event)


class _WrappedMcmcProgressReporter(McmcProgressReporter):
    def start(self) -> None:
        if _ACTIVE_OBSERVER is not None:
            try:
                _ACTIVE_OBSERVER({
                    "kind": "mcmc",
                    "done": 0,
                    "total": self._requested_steps,
                })
            except Exception:
                pass
        super().start()

    def observe(self, completed_steps: int) -> None:
        if _ACTIVE_OBSERVER is not None:
            try:
                _ACTIVE_OBSERVER({
                    "kind": "mcmc",
                    "done": completed_steps,
                    "total": self._requested_steps,
                })
            except Exception:
                pass
        super().observe(completed_steps)


def _make_wrapped_resampling(original_func: Any) -> Any:
    def _wrapped(experiments: Any, path: Any, kind: Any, request: Any, fit: Any, **kwargs: Any) -> Any:
        if _ACTIVE_OBSERVER is not None:
            try:
                _ACTIVE_OBSERVER({"kind": "resample", "done": 0, "total": None})
            except Exception:
                pass
        try:
            return original_func(experiments, path, kind, request, fit, **kwargs)
        finally:
            if _ACTIVE_OBSERVER is not None:
                try:
                    _ACTIVE_OBSERVER({"kind": "resample", "done": 1, "total": 1})
                except Exception:
                    pass

    return _wrapped


@contextlib.contextmanager
def install_progress_hooks(observer: ProgressObserver) -> Generator[None, None, None]:
    """Temporarily install progress reporters and wrap resampling during fitting."""
    global _ACTIVE_OBSERVER
    with _HOOK_LOCK:
        prev_observer = _ACTIVE_OBSERVER
        _ACTIVE_OBSERVER = observer

        orig_min_reporter = chemex.optimize.native_deterministic.MinimizationProgressReporter
        orig_mcmc_reporter = chemex.optimize.mcmc.McmcProgressReporter
        orig_resample_func = chemex.optimize.resampling.run_native_resampling

        chemex.optimize.native_deterministic.MinimizationProgressReporter = _WrappedMinimizationProgressReporter
        chemex.optimize.mcmc.McmcProgressReporter = _WrappedMcmcProgressReporter
        chemex.optimize.resampling.run_native_resampling = _make_wrapped_resampling(orig_resample_func)

        try:
            yield
        finally:
            chemex.optimize.native_deterministic.MinimizationProgressReporter = orig_min_reporter
            chemex.optimize.mcmc.McmcProgressReporter = orig_mcmc_reporter
            chemex.optimize.resampling.run_native_resampling = orig_resample_func
            _ACTIVE_OBSERVER = prev_observer
