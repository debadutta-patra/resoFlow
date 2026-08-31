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
import re
import shutil
import signal
import logging
import subprocess
from pathlib import Path
from typing import Optional, Tuple, List, Dict, Any

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


def to_host_path(container_path: Path | str) -> str:
    """
    Translate a path within the worker/API environment to the workstation host path.
    Uses RESOFLOW_HOST_DATA_ROOT and RESOFLOW_CONTAINER_DATA_ROOT environment variables.
    If not set, returns the absolute resolved local path.
    """
    p = Path(container_path).resolve()
    host_data_root = os.getenv("RESOFLOW_HOST_DATA_ROOT")
    container_data_root = os.getenv("RESOFLOW_CONTAINER_DATA_ROOT")

    if host_data_root and container_data_root:
        host_root_p = Path(host_data_root).resolve()
        container_root_p = Path(container_data_root).resolve()
        try:
            rel = p.relative_to(container_root_p)
            return str(host_root_p / rel)
        except ValueError:
            # Not a subpath of container_data_root
            pass
    elif host_data_root and not container_data_root:
        # If host data root is provided without explicit container root,
        # check common mounts like /data or /app/data
        for candidate_root in [Path("/data"), Path("/app/data"), Path("/work")]:
            try:
                rel = p.relative_to(candidate_root)
                return str(Path(host_data_root).resolve() / rel)
            except ValueError:
                continue

    return str(p)


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


def cancel_chemex_job(job_id: str, timeout: int = 2) -> bool:
    """
    Cancel an active ChemEx fit by stopping and removing its deterministic container.
    Sends SIGTERM with a short grace period, followed by SIGKILL.
    """
    container_name = get_container_name(job_id)
    logger.info(f"Attempting to cancel ChemEx container: {container_name}")

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
) -> int:
    """
    Execute a ChemEx job in an ephemeral rootless Podman container.

    Args:
        job_id: Unique identifier for the job / analysis (used for container naming).
        work_dir: Host/local working directory where configs and data are located.
        cmd_args: Arguments passed to chemex (e.g. ["fit", "-e", "Experiments/exp.toml", ...]).
        log_file: Path to write stdout and stderr logs to.
        image_name: Container image tag (default: localhost/resoflow-chemex:latest).
        memory_limit: Optional container memory limit (e.g. "4g").
        cpus: Optional container CPU allocation (e.g. 2.0).
        timeout_seconds: Optional maximum runtime in seconds.

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

    # 3. Assemble Podman CLI command
    podman_cmd = [
        "podman", "run",
        "--name", container_name,
        "--rm",
        "--userns=keep-id",
        "-v", f"{host_work_dir}:/work:z",
    ]

    if memory_limit:
        podman_cmd.extend(["--memory", str(memory_limit)])
    if cpus:
        podman_cmd.extend(["--cpus", str(cpus)])

    podman_cmd.append(image_name)
    podman_cmd.extend(translated_cmd_args)

    logger.info(f"Launching ephemeral ChemEx container '{container_name}': {' '.join(podman_cmd)}")

    # 4. Open log file and stream output
    log_fp = None
    if log_file:
        log_file_p = Path(log_file)
        log_file_p.parent.mkdir(parents=True, exist_ok=True)
        log_fp = open(log_file_p, "a", encoding="utf-8")
        log_fp.write(f"\n[ChemEx Container: {container_name}]\n")
        log_fp.write(f"[Image: {image_name}]\n")
        log_fp.write(f"$ {' '.join(podman_cmd)}\n\n")
        log_fp.flush()

    return_code = 1
    try:
        process = subprocess.Popen(
            podman_cmd,
            cwd=str(work_path),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            universal_newlines=True,
        )

        # Stream lines in real-time
        if process.stdout:
            for line in iter(process.stdout.readline, ''):
                if log_fp:
                    log_fp.write(line)
                    log_fp.flush()
                else:
                    logger.debug(f"[{container_name}] {line.rstrip()}")

        process.wait(timeout=timeout_seconds)
        return_code = process.returncode

    except subprocess.TimeoutExpired:
        logger.warning(f"ChemEx container '{container_name}' timed out after {timeout_seconds}s")
        cancel_chemex_job(job_id)
        return_code = 124
        if log_fp:
            log_fp.write(f"\n[ERROR] Container execution timed out after {timeout_seconds}s\n")
            log_fp.flush()

    except Exception as e:
        logger.exception(f"Exception during ChemEx container run '{container_name}': {e}")
        cancel_chemex_job(job_id)
        return_code = 1
        if log_fp:
            log_fp.write(f"\n[ERROR] Exception running ChemEx container: {e}\n")
            log_fp.flush()

    finally:
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
