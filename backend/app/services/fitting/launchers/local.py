"""Direct subprocess job launcher with process group isolation."""

from __future__ import annotations

import json
import logging
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from resoflow.chemex_api.spec import FitJobSpec

from .base import JobHandle, JobState, Launcher, Resources, find_engine_result

logger = logging.getLogger(__name__)


class LocalLauncher(Launcher):
    """Executes ChemEx jobs as direct subprocesses with new session / process group isolation."""

    name: str = "local"

    def submit(self, job_dir: Path, spec: FitJobSpec, resources: Resources) -> JobHandle:
        job_path = Path(job_dir).resolve()
        job_path.mkdir(parents=True, exist_ok=True)

        job_json_file = job_path / "job.json"
        if not job_json_file.exists():
            spec.to_file(job_json_file)

        env = os.environ.copy()
        env["TERM"] = "dumb"
        env.setdefault("MPLBACKEND", "Agg")

        # Ensure repo root is on PYTHONPATH so resoflow is always importable
        repo_root = Path(__file__).resolve().parent.parent.parent.parent.parent
        pythonpath = env.get("PYTHONPATH", "")
        paths = [str(repo_root)]
        if pythonpath:
            paths.append(pythonpath)
        env["PYTHONPATH"] = os.pathsep.join(paths)

        if resources.cpus:
            env["OMP_NUM_THREADS"] = str(int(resources.cpus))
            env["OPENBLAS_NUM_THREADS"] = str(int(resources.cpus))

        cmd = [sys.executable, "-m", "resoflow.engine", "run", "job.json"]
        logger.info(f"LocalLauncher submitting job in {job_path}: {' '.join(cmd)}")

        proc = subprocess.Popen(
            cmd,
            cwd=str(job_path),
            start_new_session=True,
            env=env,
        )

        return JobHandle(
            launcher=self.name,
            id=str(proc.pid),
            job_dir=str(job_path),
            metadata={"pid": proc.pid, "pgid": proc.pid, "proc": proc},
        )

    def poll(self, handle: JobHandle) -> JobState:
        proc = handle.metadata.get("proc")
        proc_rc = None
        if proc is not None:
            if hasattr(proc, "poll"):
                res = proc.poll()
                if isinstance(res, int):
                    proc_rc = res
            if proc_rc is None and hasattr(proc, "returncode") and isinstance(proc.returncode, int):
                proc_rc = proc.returncode

        if proc_rc is not None:
            if proc_rc == 0:
                return JobState.DONE
            elif proc_rc in (130, 137, 143):
                return JobState.CANCELLED
            else:
                return JobState.FAILED

        pid_val = handle.metadata.get("pid")
        if isinstance(pid_val, int):
            pid = pid_val
        else:
            try:
                pid = int(handle.id)
            except (ValueError, TypeError):
                pid = None

        alive = False
        if pid is not None:
            try:
                os.kill(pid, 0)
                alive = True
            except OSError:
                alive = False

        job_path = Path(handle.job_dir)
        result_file = find_engine_result(job_path)

        if result_file is not None and result_file.exists():
            try:
                data = json.loads(result_file.read_text(encoding="utf-8"))
                status = data.get("status")
                if status == "complete":
                    out_dir = result_file.parent
                    outcome_file = out_dir / data.get("outcome_toml", "run_info/outcome.toml")
                    if not outcome_file.exists():
                        outcome_file = job_path / data.get("outcome_toml", "run_info/outcome.toml")
                    if outcome_file.exists():
                        outcome_text = outcome_file.read_text(encoding="utf-8")
                        if 'status = "complete"' in outcome_text or "status = 'complete'" in outcome_text:
                            return JobState.DONE
                    return JobState.DONE
                elif status == "cancelled":
                    return JobState.CANCELLED
                elif status in ("failed", "incomplete"):
                    return JobState.FAILED
            except Exception as exc:
                logger.debug(f"Error parsing engine_result.json in {job_path}: {exc}")

        if alive:
            return JobState.RUNNING

        # Process is dead and engine_result didn't indicate clean terminal state
        if result_file is not None and result_file.exists():
            return JobState.FAILED
        return JobState.LOST

    def cancel(self, handle: JobHandle) -> None:
        pid = int(handle.id)
        pgid = handle.metadata.get("pgid", pid)
        logger.info(f"LocalLauncher cancelling job {handle.id} (pgid={pgid})")

        try:
            os.killpg(pgid, signal.SIGTERM)
        except OSError:
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                return

        # Short grace period for graceful shutdown
        for _ in range(20):
            time.sleep(0.1)
            try:
                os.kill(pid, 0)
            except OSError:
                return

        try:
            os.killpg(pgid, signal.SIGKILL)
        except OSError:
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass

    def collect(self, handle: JobHandle) -> Path:
        return Path(handle.job_dir)
