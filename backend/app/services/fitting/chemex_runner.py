"""
ChemEx Per-Job Ephemeral Container Runner.

Executes ChemEx fits inside isolated rootless Podman containers with:
  - Deterministic container naming (`rf-chemex-{job_id}`) for reliable cancellation
  - Host path translation for nested container/sibling execution (RESOFLOW_HOST_DATA_ROOT)
  - SELinux :z flag and UserNS=keep-id for host UID/GID preservation
  - Atomic output directories (staging in .tmp before atomic rename on exit 0)
  - Real-time line-buffered log streaming to chemex.log
  - Image digest and version tracking
  - Orphan container cleanup on worker startup
"""

import os
import sys
import re
import shutil
import signal
import logging
import subprocess
import json
import threading
from pathlib import Path
from typing import Optional, Tuple, List, Dict, Any, Callable

logger = logging.getLogger(__name__)

# Default ChemEx container image
DEFAULT_CHEMEX_IMAGE = os.getenv("RESOFLOW_CHEMEX_IMAGE", "localhost/resoflow-chemex:latest")

# Cache for image metadata
_IMAGE_METADATA_CACHE: Dict[str, Tuple[Optional[str], Optional[str]]] = {}


def get_container_name(job_id: str) -> str:
    """Generate deterministic container name from job ID / analysis UUID."""
    # Sanitize job_id to contain only safe container name chars ([a-zA-Z0-9_.-])
    clean_id = re.sub(r"[^a-zA-Z0-9_.-]", "-", str(job_id).strip())
    return f"rf-chemex-{clean_id}"


from ..path_utils import to_host_path, to_container_path


def get_chemex_image_info(image_name: str = DEFAULT_CHEMEX_IMAGE) -> Tuple[Optional[str], Optional[str]]:
    """
    Inspect the ChemEx container image to retrieve its SHA256 digest and version string.
    Returns (digest, version). Results are cached in-memory.
    """
    if image_name in _IMAGE_METADATA_CACHE:
        return _IMAGE_METADATA_CACHE[image_name]

    digest: Optional[str] = None
    version: Optional[str] = None

    # 1. Fetch image digest via podman inspect
    try:
        inspect_res = subprocess.run(
            ["podman", "inspect", "--format", "{{.Digest}}", image_name],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if inspect_res.returncode == 0 and inspect_res.stdout.strip():
            digest_str = inspect_res.stdout.strip()
            if digest_str and digest_str != "<no value>":
                digest = digest_str
        
        # Fallback to image ID if digest is empty (local build without push)
        if not digest:
            id_res = subprocess.run(
                ["podman", "inspect", "--format", "{{.Id}}", image_name],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if id_res.returncode == 0 and id_res.stdout.strip():
                digest = id_res.stdout.strip()
    except Exception as e:
        logger.warning(f"Failed to inspect ChemEx image digest: {e}")

    # 2. Fetch ChemEx version via container run
    try:
        ver_res = subprocess.run(
            ["podman", "run", "--rm", image_name, "--version"],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if ver_res.returncode == 0 and ver_res.stdout.strip():
            # Example output: "chemex 0.9.1" or "0.9.1"
            out = ver_res.stdout.strip()
            v_match = re.search(r"(\d+\.\d+(\.\d+)?)", out)
            version = v_match.group(1) if v_match else out
    except Exception as e:
        logger.warning(f"Failed to get ChemEx version from image: {e}")

    _IMAGE_METADATA_CACHE[image_name] = (digest, version)
    return digest, version


def _podman_socket_request(method: str, path: str):
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
        import socket
        import http.client

        class UnixHTTPConnection(http.client.HTTPConnection):
            def __init__(self, s_path):
                super().__init__("localhost")
                self.s_path = s_path

            def connect(self):
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


def is_chemex_container_running(job_id: str) -> bool:
    """Check if the ephemeral ChemEx container for the given job_id is currently running."""
    container_name = get_container_name(job_id)

    # 1. Try Podman API socket first (works in containers without podman CLI)
    import urllib.parse
    import json
    filters = json.dumps({"name": [container_name], "status": ["running"]})
    res = _podman_socket_request("GET", f"/v4.0.0/libpod/containers/json?filters={urllib.parse.quote(filters)}")
    if res is not None:
        status, data = res
        if status == 200:
            try:
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


def cancel_chemex_job(job_id: str, timeout: int = 2) -> bool:
    """
    Cancel an active ChemEx fit by stopping and removing its deterministic container.
    Sends SIGTERM with a short grace period, followed by SIGKILL.
    """
    container_name = get_container_name(job_id)
    logger.info(f"Attempting to cancel ChemEx container: {container_name}")

    # 1. Try socket API
    res = _podman_socket_request("POST", f"/v4.0.0/libpod/containers/{container_name}/stop?t={timeout}")
    if res is not None and res[0] in (200, 204, 304):
        _podman_socket_request("DELETE", f"/v4.0.0/libpod/containers/{container_name}?force=true")
        logger.info(f"Successfully cancelled container via Podman socket: {container_name}")
        return True

    # 2. Fallback to CLI
    try:
        # Check if container is running
        ps_res = subprocess.run(
            ["podman", "ps", "-q", "--filter", f"name={container_name}"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if ps_res.returncode == 0 and ps_res.stdout.strip():
            # Stop gracefully first
            subprocess.run(
                ["podman", "stop", "-t", str(timeout), container_name],
                capture_output=True,
                timeout=timeout + 5,
            )
            # Force remove if still hanging
            subprocess.run(
                ["podman", "rm", "-f", container_name],
                capture_output=True,
                timeout=5,
            )
            logger.info(f"Successfully stopped and removed container: {container_name}")
            return True
        else:
            # Check if stopped/dead container exists to clean up
            subprocess.run(
                ["podman", "rm", "-f", container_name],
                capture_output=True,
                timeout=5,
            )
            return False
    except Exception as e:
        logger.warning(f"Error during cancellation of {container_name}: {e}")
        # Final desperate kill attempt
        try:
            subprocess.run(["podman", "kill", container_name], capture_output=True, timeout=5)
            subprocess.run(["podman", "rm", "-f", container_name], capture_output=True, timeout=5)
            return True
        except Exception:
            return False


def reap_orphaned_chemex_containers() -> List[str]:
    """
    Scan for and forcibly remove any leftover rf-chemex-* containers.
    Called on Celery worker startup to ensure no orphan containers remain after crashes.
    """
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
                c.strip() for c in res.stdout.strip().splitlines()
                if c.strip().startswith("rf-chemex-")
            ]
            for c in containers:
                logger.info(f"Reaping orphaned ChemEx container: {c}")
                subprocess.run(["podman", "rm", "-f", c], capture_output=True, timeout=5)
                reaped.append(c)
    except Exception as e:
        logger.warning(f"Error during orphan container cleanup: {e}")
    return reaped


def run_chemex_job(
    job_id: str,
    work_dir: Path | str,
    cmd_args: List[str],
    log_file: Optional[Path | str] = None,
    image_name: str = DEFAULT_CHEMEX_IMAGE,
    memory_limit: Optional[str] = None,
    cpus: Optional[float] = None,
    timeout_seconds: Optional[int] = None,
    progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
    use_container: Optional[bool] = None,
) -> int:
    """
    Execute a ChemEx job in an ephemeral container or via direct subprocess with progress streaming.

    Args:
        job_id: Unique identifier for the job / analysis (used for container naming).
        work_dir: Host/local working directory where configs and data are located.
        cmd_args: Arguments passed to chemex (e.g. ["fit", "-e", "Experiments/exp.toml", ...]).
        log_file: Path to write stdout and stderr logs to.
        image_name: Container image tag (default: localhost/resoflow-chemex:latest).
        memory_limit: Optional container memory limit (e.g. "4g").
        cpus: Optional container CPU allocation (e.g. 2.0).
        timeout_seconds: Optional maximum runtime in seconds.
        progress_callback: Optional callable receiving structured JSON progress events.
        use_container: Whether to execute inside Podman container or direct subprocess.

    Returns:
        int: Subprocess return code. 0 for success, 137/143 for cancellation.
    """
    work_path = Path(work_dir).resolve()
    work_path.mkdir(parents=True, exist_ok=True)
    container_name = get_container_name(job_id)

    # 1. Path translation for bind mount
    host_work_dir = to_host_path(work_path)

    # 2. Identify output argument for atomic staging
    final_output_dir: Optional[Path] = None
    tmp_output_dir: Optional[Path] = None
    translated_cmd_args: List[str] = []
    
    i = 0
    while i < len(cmd_args):
        arg = cmd_args[i]
        if arg in ("-o", "--output") and i + 1 < len(cmd_args):
            orig_output = cmd_args[i + 1]
            # Convert to Path relative to work_dir if relative
            if os.path.isabs(orig_output):
                final_output_dir = Path(orig_output)
            else:
                final_output_dir = work_path / orig_output

            tmp_output_dir = final_output_dir.with_name(f"{final_output_dir.name}.tmp")
            
            # Pass the staging directory to ChemEx inside the container
            # Make path relative to /work for clean execution inside container
            try:
                rel_tmp = tmp_output_dir.relative_to(work_path)
                translated_cmd_args.extend([arg, str(rel_tmp)])
            except ValueError:
                translated_cmd_args.extend([arg, f"/work/{tmp_output_dir.name}"])
            i += 2
            continue

        # Convert absolute paths within work_path to relative paths inside /work
        if os.path.isabs(arg):
            try:
                rel_arg = Path(arg).relative_to(work_path)
                translated_cmd_args.append(str(rel_arg))
                i += 1
                continue
            except ValueError:
                pass

        translated_cmd_args.append(arg)
        i += 1

    # Ensure tmp output directory is clean before run
    if tmp_output_dir and tmp_output_dir.exists():
        shutil.rmtree(tmp_output_dir, ignore_errors=True)

    # Determine execution mode: container vs direct subprocess
    if use_container is None:
        if os.getenv("RESOFLOW_USE_CONTAINER", "").lower() in ("true", "1", "yes") or "RESOFLOW_SELINUX_MOUNT" in os.environ:
            use_container = True
        else:
            use_container = False

    if use_container:
        # Ensure any existing container with the same name is removed
        try:
            subprocess.run(["podman", "rm", "-f", container_name], capture_output=True, timeout=5)
        except Exception:
            pass

        # 3. Assemble Podman CLI command
        selinux_opt = ":z"
        if os.getenv("RESOFLOW_SELINUX_MOUNT", "").lower() in ("false", "0", "no") or sys.platform == "darwin":
            selinux_opt = ""

        cmd = [
            "podman", "run",
            "--name", container_name,
            "--replace",
            "--rm",
            "--userns=keep-id",
            "-v", f"{host_work_dir}:/work{selinux_opt}",
        ]

        if memory_limit:
            cmd.extend(["--memory", str(memory_limit)])
        if cpus:
            cmd.extend(["--cpus", str(cpus)])

        cmd.append(image_name)
        cmd.extend(translated_cmd_args)
        logger.info(f"Launching ephemeral ChemEx container '{container_name}': {' '.join(cmd)}")
    else:
        cmd = [sys.executable, "-m", "resoflow.progress", *translated_cmd_args]
        logger.info(f"Launching direct ChemEx subprocess for '{job_id}': {' '.join(cmd)}")

    # 4. Open log file and stream output
    log_fp = None
    if log_file:
        log_file_p = Path(log_file)
        log_file_p.parent.mkdir(parents=True, exist_ok=True)
        log_fp = open(log_file_p, "a", encoding="utf-8")
        log_fp.write(f"\n[ChemEx Runner: {container_name}]\n")
        if use_container:
            log_fp.write(f"[Image: {image_name}]\n")
        log_fp.write(f"$ {' '.join(cmd)}\n\n")
        log_fp.flush()

    # Set up progress pipe for structured event streaming
    r_fd, w_fd = os.pipe()
    os.set_inheritable(w_fd, True)
    w_fd_closed = False

    child_env = os.environ.copy()
    child_env["RESOFLOW_PROGRESS_FD"] = str(w_fd)

    def _dispatch_progress_event(event: Dict[str, Any]) -> None:
        if progress_callback:
            try:
                progress_callback(event)
            except Exception as e:
                logger.debug(f"progress_callback error: {e}")
        if log_fp:
            try:
                k = event.get("kind", "progress")
                if k == "fit":
                    log_fp.write(f"[Progress] Fit iteration {event.get('iteration')}: chisqr={event.get('chisqr')}, redchi={event.get('redchi')}\n")
                elif k in ("grid", "resample", "mcmc"):
                    log_fp.write(f"[Progress] {k.capitalize()}: {event.get('done')}/{event.get('total')}\n")
                log_fp.flush()
            except Exception:
                pass

    def _drain_progress(fd: int) -> None:
        try:
            with os.fdopen(fd, "r", encoding="utf-8") as pipe_in:
                for line in pipe_in:
                    stripped = line.strip()
                    if not stripped:
                        continue
                    try:
                        event = json.loads(stripped)
                        _dispatch_progress_event(event)
                    except Exception as err:
                        logger.warning(f"Malformed progress event skipped: {stripped[:100]!r} ({err})")
        except Exception as err:
            logger.debug(f"Progress stream reader terminated: {err}")

    drain_thread = threading.Thread(target=_drain_progress, args=(r_fd,), daemon=True)
    drain_thread.start()

    return_code = 1
    try:
        process = subprocess.Popen(
            cmd,
            cwd=str(work_path),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            universal_newlines=True,
            pass_fds=(w_fd,),
            env=child_env,
        )

        try:
            os.close(w_fd)
            w_fd_closed = True
        except OSError:
            pass

        # Stream lines in real-time
        def _handle_stdout_line(line: Any) -> None:
            if isinstance(line, bytes):
                str_line = line.decode("utf-8", errors="replace")
            else:
                str_line = str(line)

            stripped = str_line.strip()
            if stripped.startswith("{") and stripped.endswith("}"):
                try:
                    event = json.loads(stripped)
                    if isinstance(event, dict) and event.get("kind") in ("grid", "resample", "mcmc", "fit"):
                        _dispatch_progress_event(event)
                        return
                except Exception:
                    pass
            if log_fp:
                log_fp.write(str_line)
                log_fp.flush()
            else:
                logger.debug(f"[{container_name}] {stripped}")

        if process.stdout:
            if hasattr(process.stdout, "readline"):
                for line in iter(process.stdout.readline, ''):
                    _handle_stdout_line(line)
            else:
                for line in process.stdout:
                    _handle_stdout_line(line)

        process.wait(timeout=timeout_seconds)
        return_code = process.returncode

    except subprocess.TimeoutExpired:
        logger.warning(f"ChemEx run '{container_name}' timed out after {timeout_seconds}s")
        cancel_chemex_job(job_id)
        return_code = 124
        if log_fp:
            log_fp.write(f"\n[ERROR] Container execution timed out after {timeout_seconds}s\n")
            log_fp.flush()

    except Exception as e:
        logger.exception(f"Exception during ChemEx run '{container_name}': {e}")
        cancel_chemex_job(job_id)
        return_code = 1
        if log_fp:
            log_fp.write(f"\n[ERROR] Exception running ChemEx container: {e}\n")
            log_fp.flush()

    finally:
        if not w_fd_closed:
            try:
                os.close(w_fd)
            except OSError:
                pass
        drain_thread.join(timeout=2.0)
        if log_fp:
            log_fp.close()

    # 5. Atomic Promotion or Cleanup
    if return_code == 0:
        if tmp_output_dir and tmp_output_dir.exists() and final_output_dir:
            try:
                # Remove existing final directory if present
                if final_output_dir.exists():
                    shutil.rmtree(final_output_dir, ignore_errors=True)
                # Atomically promote staging directory
                shutil.move(str(tmp_output_dir), str(final_output_dir))
                logger.info(f"Atomically promoted {tmp_output_dir} -> {final_output_dir}")
            except Exception as e:
                logger.error(f"Failed atomic move of ChemEx output: {e}")
    else:
        # On error or cancellation (137/143), remove partial staging directory
        if tmp_output_dir and tmp_output_dir.exists():
            shutil.rmtree(tmp_output_dir, ignore_errors=True)
            logger.info(f"Cleaned up staging output directory after non-zero exit ({return_code}): {tmp_output_dir}")

    return return_code
