"""Podman ephemeral container job launcher."""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path
from typing import Any, Optional, Tuple

from resoflow.chemex_api.spec import FitJobSpec

from ...path_utils import to_host_path
from .base import JobHandle, JobState, Launcher, Resources, find_engine_result

logger = logging.getLogger(__name__)

DEFAULT_CHEMEX_IMAGE = os.getenv("RESOFLOW_CHEMEX_IMAGE", "localhost/resoflow-chemex:latest")

_DETECTED_API_PREFIX: Optional[str] = None


def get_container_name(job_id: str) -> str:
    """Generate deterministic container name from job ID / analysis UUID."""
    clean_id = re.sub(r"[^a-zA-Z0-9_.-]", "-", str(job_id).strip())
    return f"rf-chemex-{clean_id}"


def _podman_socket_request(method: str, path: str) -> Optional[Tuple[int, str]]:
    """Execute a REST request directly against the Podman Unix socket."""
    sock_path = os.environ.get("CONTAINER_HOST", "").replace("unix://", "")
    if not sock_path:
        for candidate in [
            "/run/podman/podman.sock",
            f"/run/user/{os.getuid()}/podman/podman.sock" if hasattr(os, "getuid") else None,
            os.path.expanduser("~/.local/share/containers/podman/machine/podman.sock"),
            os.path.expanduser("~/.local/share/containers/podman/machine/qemu/podman.sock"),
        ]:
            if candidate and os.path.exists(candidate):
                sock_path = candidate
                break
    if not sock_path or not os.path.exists(sock_path):
        return None

    try:
        import http.client
        import socket

        class UnixHTTPConnection(http.client.HTTPConnection):
            def __init__(self, s_path: str):
                super().__init__("localhost")
                self.s_path = s_path

            def connect(self) -> None:
                self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                self.sock.settimeout(4.0)
                self.sock.connect(self.s_path)

        conn = UnixHTTPConnection(sock_path)
        conn.request(method, path)
        resp = conn.getresponse()
        data = resp.read().decode("utf-8", errors="replace")
        conn.close()
        return resp.status, data
    except Exception as e:
        logger.debug(f"Podman socket {method} {path} error: {e}")
        return None


def _get_socket_request_fn() -> Any:
    runner_mod = sys.modules.get("app.services.fitting.chemex_runner")
    if runner_mod and hasattr(runner_mod, "_podman_socket_request"):
        return getattr(runner_mod, "_podman_socket_request")
    return _podman_socket_request


def _get_api_prefix() -> Optional[str]:
    runner_mod = sys.modules.get("app.services.fitting.chemex_runner")
    if runner_mod and hasattr(runner_mod, "_DETECTED_API_PREFIX"):
        return getattr(runner_mod, "_DETECTED_API_PREFIX")
    return _DETECTED_API_PREFIX


def _set_api_prefix(val: Optional[str]) -> None:
    global _DETECTED_API_PREFIX
    _DETECTED_API_PREFIX = val
    runner_mod = sys.modules.get("app.services.fitting.chemex_runner")
    if runner_mod and hasattr(runner_mod, "_DETECTED_API_PREFIX"):
        setattr(runner_mod, "_DETECTED_API_PREFIX", val)


def is_chemex_container_running(job_id: str) -> bool:
    """Check if the ephemeral ChemEx container for the given job_id is currently running."""
    container_name = get_container_name(job_id)

    # 1. Try Podman API socket first
    filters = json.dumps({"name": [container_name], "status": ["running"]})
    encoded_filters = urllib.parse.quote(filters)

    sock_fn = _get_socket_request_fn()
    prefix = _get_api_prefix() or "/v4.0.0/libpod"
    res = sock_fn("GET", f"{prefix}/containers/json?filters={encoded_filters}")

    # If /v4.0.0 endpoint returns 404 (Podman 3.x / Docker compat), probe fallback prefixes
    if res is not None and res[0] == 404 and _get_api_prefix() is None:
        for candidate in ["/v3.0.0/libpod", "/v1.40"]:
            probe = sock_fn("GET", f"{candidate}/containers/json?filters={encoded_filters}")
            if probe is not None and probe[0] == 200:
                _set_api_prefix(candidate)
                res = probe
                break

    if res is not None:
        status, data = res
        if status == 200:
            try:
                if isinstance(data, (bytes, bytearray)):
                    data = data.decode("utf-8")
                containers = json.loads(data)
                return len(containers) > 0
            except Exception:
                pass

    # 2. Fallback to CLI
    try:
        ps_res = subprocess.run(
            ["podman", "ps", "-q", "--filter", f"name={container_name}", "--filter", "status=running"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        return ps_res.returncode == 0 and bool(ps_res.stdout.strip())
    except Exception:
        return False


def reap_orphaned_chemex_containers() -> list[str]:
    """Scan for and forcibly remove any leftover rf-chemex-* containers."""
    reaped = []
    try:
        res = subprocess.run(
            ["podman", "ps", "-a", "--filter", "name=rf-chemex-", "--format", "{{.Names}}"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if res.returncode == 0 and res.stdout.strip():
            containers = [
                c.strip()
                for c in res.stdout.strip().splitlines()
                if c.strip().startswith("rf-chemex-")
            ]
            for c in containers:
                logger.info(f"Reaping orphaned ChemEx container: {c}")
                subprocess.run(["podman", "rm", "-f", c], capture_output=True, timeout=5)
                reaped.append(c)
    except Exception as e:
        logger.warning(f"Error during orphan container cleanup: {e}")
    return reaped


class PodmanLauncher(Launcher):
    """Executes ChemEx jobs inside isolated ephemeral Podman containers."""

    name: str = "podman"

    def __init__(self, image_name: str = DEFAULT_CHEMEX_IMAGE):
        self.image_name = image_name

    def submit(self, job_dir: Path, spec: FitJobSpec, resources: Resources) -> JobHandle:
        job_path = Path(job_dir).resolve()
        job_path.mkdir(parents=True, exist_ok=True)

        job_json_file = job_path / "job.json"
        if not job_json_file.exists():
            spec.to_file(job_json_file)

        container_name = get_container_name(spec.job_id or job_path.name)
        host_work_dir = to_host_path(job_path)

        # Ensure any stale container with the same name is removed
        try:
            subprocess.run(["podman", "rm", "-f", container_name], capture_output=True, timeout=5)
        except Exception:
            pass

        selinux_opt = ":z"
        if os.getenv("RESOFLOW_SELINUX_MOUNT", "").lower() in ("false", "0", "no") or sys.platform == "darwin":
            selinux_opt = ""

        cmd = [
            "podman",
            "run",
            "--name",
            container_name,
            "--replace",
            "--rm",
            "--userns=keep-id",
            "-v",
            f"{host_work_dir}:/work{selinux_opt}",
        ]

        if resources.memory:
            cmd.extend(["--memory", str(resources.memory)])
        if resources.cpus:
            cmd.extend(["--cpus", str(resources.cpus)])

        cmd.append(self.image_name)
        cmd.extend(["run", "job.json"])

        logger.info(f"PodmanLauncher launching ephemeral ChemEx container '{container_name}': {' '.join(cmd)}")

        proc = subprocess.Popen(
            cmd,
            cwd=str(job_path),
            start_new_session=True,
        )

        return JobHandle(
            launcher=self.name,
            id=container_name,
            job_dir=str(job_path),
            metadata={"pid": proc.pid, "container_name": container_name, "image": self.image_name, "proc": proc},
        )

    def poll(self, handle: JobHandle) -> JobState:
        container_name = handle.id
        job_path = Path(handle.job_dir)

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

        running = is_chemex_container_running(container_name)

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

        if running:
            return JobState.RUNNING

        if result_file is not None and result_file.exists():
            return JobState.FAILED
        return JobState.LOST

    def cancel(self, handle: JobHandle) -> None:
        container_name = handle.id
        timeout = 2
        logger.info(f"Attempting to cancel ChemEx container: {container_name}")

        sock_fn = _get_socket_request_fn()
        prefix = _get_api_prefix() or "/v4.0.0/libpod"
        res = sock_fn("POST", f"{prefix}/containers/{container_name}/stop?t={timeout}")

        if res is not None and res[0] == 404 and _get_api_prefix() is None:
            for candidate in ["/v3.0.0/libpod", "/v1.40"]:
                probe = sock_fn("POST", f"{candidate}/containers/{container_name}/stop?t={timeout}")
                if probe is not None and probe[0] in (200, 204, 304):
                    _set_api_prefix(candidate)
                    prefix = candidate
                    res = probe
                    break

        if res is not None and res[0] in (200, 204, 304):
            sock_fn("DELETE", f"{prefix}/containers/{container_name}?force=true")
            logger.info(f"Successfully cancelled container via Podman socket: {container_name}")
            return

        try:
            ps_res = subprocess.run(
                ["podman", "ps", "-q", "--filter", f"name={container_name}"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if ps_res.returncode == 0 and ps_res.stdout.strip():
                subprocess.run(
                    ["podman", "stop", "-t", str(timeout), container_name],
                    capture_output=True,
                    timeout=timeout + 5,
                )
                subprocess.run(
                    ["podman", "rm", "-f", container_name],
                    capture_output=True,
                    timeout=5,
                )
            else:
                subprocess.run(
                    ["podman", "rm", "-f", container_name],
                    capture_output=True,
                    timeout=5,
                )
        except Exception as e:
            logger.warning(f"Error during cancellation of {container_name}: {e}")
            try:
                subprocess.run(["podman", "kill", container_name], capture_output=True, timeout=5)
                subprocess.run(["podman", "rm", "-f", container_name], capture_output=True, timeout=5)
            except Exception:
                pass

    def collect(self, handle: JobHandle) -> Path:
        return Path(handle.job_dir)
