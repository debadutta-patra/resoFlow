"""ChemEx Per-Job Execution Runner.

Coordinates job specification, launcher submission (Local or Podman container),
log and structured progress streaming, atomic output staging, and cancellation.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from resoflow.chemex_api.spec import FitJobSpec

from ..path_utils import to_container_path, to_host_path
from .launchers import (
    JobHandle,
    JobState,
    Launcher,
    LocalLauncher,
    PodmanLauncher,
    Resources,
    get_container_name,
    get_launcher,
    is_chemex_container_running,
    reap_orphaned_chemex_containers,
    wait_for_job,
)
from .launchers.podman import (
    DEFAULT_CHEMEX_IMAGE,
    _podman_socket_request,
)
import app.services.fitting.launchers.podman as podman_mod

logger = logging.getLogger(__name__)

# Cache for image metadata
_IMAGE_METADATA_CACHE: Dict[str, Tuple[Optional[str], Optional[str]]] = {}


def _get_detected_api_prefix() -> Optional[str]:
    return podman_mod._DETECTED_API_PREFIX


def _set_detected_api_prefix(val: Optional[str]) -> None:
    podman_mod._DETECTED_API_PREFIX = val


# Compatibility property wrapper for _DETECTED_API_PREFIX
class _RunnerModuleCompat:
    @property
    def _DETECTED_API_PREFIX(self) -> Optional[str]:
        return podman_mod._DETECTED_API_PREFIX

    @_DETECTED_API_PREFIX.setter
    def _DETECTED_API_PREFIX(self, val: Optional[str]) -> None:
        podman_mod._DETECTED_API_PREFIX = val


_DETECTED_API_PREFIX = podman_mod._DETECTED_API_PREFIX


def get_chemex_image_info(
    image_name: str = DEFAULT_CHEMEX_IMAGE,
    use_container: Optional[bool] = None,
) -> Tuple[Optional[str], Optional[str]]:
    """Inspect the ChemEx image / engine to retrieve its SHA256 digest and version string.

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

    # 2. Fetch ChemEx version via engine JSON output
    if use_container is None:
        launcher_name = os.getenv("RESOFLOW_LAUNCHER", "").lower().strip()
        if launcher_name == "podman" or os.getenv("RESOFLOW_USE_CONTAINER", "").lower() in ("true", "1", "yes") or "RESOFLOW_SELINUX_MOUNT" in os.environ:
            use_container = True
        else:
            use_container = False

    try:
        if use_container:
            cmd = ["podman", "run", "--rm", image_name, "version"]
        else:
            cmd = [sys.executable, "-m", "resoflow.engine", "version"]

        ver_res = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=15,
        )
        if ver_res.returncode == 0 and ver_res.stdout.strip():
            out = ver_res.stdout.strip()
            try:
                data = json.loads(out)
                if isinstance(data, dict) and "chemex_version" in data:
                    version = data["chemex_version"]
            except Exception:
                pass

            if not version:
                # Regex fallback for plain text version strings (e.g. from mock tests)
                v_match = re.search(r"(\d+\.\d+(\.\d+)?)", out)
                version = v_match.group(1) if v_match else out
    except Exception as e:
        logger.warning(f"Failed to get ChemEx version: {e}")

    _IMAGE_METADATA_CACHE[image_name] = (digest, version)
    return digest, version


def cancel_chemex_job(job_id: str, timeout: int = 2) -> bool:
    """Cancel an active ChemEx fit by handle or container name."""
    logger.info(f"cancel_chemex_job requested for job_id={job_id}")

    # 1. Try DB lookup of launcher_handle
    try:
        from ...database import SessionLocal
        from ...models import Analysis

        with SessionLocal() as db:
            analysis = db.query(Analysis).filter_by(analysis_uuid=job_id).first()
            if analysis and analysis.launcher_handle:
                handle = JobHandle.from_dict(analysis.launcher_handle)
                launcher = get_launcher(handle.launcher)
                launcher.cancel(handle)
                return True
    except Exception as exc:
        logger.debug(f"DB lookup for launcher_handle during cancel failed: {exc}")

    # 2. Fallback to Podman / container cancellation
    launcher = PodmanLauncher()
    container_name = get_container_name(job_id)
    handle = JobHandle(launcher="podman", id=container_name, job_dir="")
    launcher.cancel(handle)
    return True


def run_chemex_job(
    job_id: str,
    work_dir: Path | str | None = None,
    job_dir: Path | str | None = None,
    spec: Optional[FitJobSpec] = None,
    cmd_args: Optional[List[str]] = None,
    log_file: Optional[Path | str] = None,
    image_name: str = DEFAULT_CHEMEX_IMAGE,
    memory_limit: Optional[str] = None,
    cpus: Optional[float] = None,
    timeout_seconds: Optional[int] = None,
    progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
    use_container: Optional[bool] = None,
    launcher_name: Optional[str] = None,
) -> int:
    """Execute a ChemEx job in an ephemeral container or local subprocess.

    Writes job.json with output_dir set to a staging directory (<output>.tmp),
    submits via the selected Launcher, monitors execution via wait_for_job,
    and atomically promotes <output>.tmp to <output> upon clean completion.

    Returns:
        int: Subprocess return code. 0 for success, 130/137/143 for cancellation.
    """
    target_dir = Path(job_dir or work_dir or ".").resolve()
    target_dir.mkdir(parents=True, exist_ok=True)

    # 1. Construct or adapt spec if cmd_args was passed by legacy callers / tests
    if spec is None:
        out_arg = "Output"
        exp_args: list[str] = []
        param_args: list[str] = []
        method_args: list[str] = []
        model_arg = "2st"
        include_args: list[str] = []
        exclude_args: list[str] = []

        if cmd_args:
            i = 0
            while i < len(cmd_args):
                arg = cmd_args[i]
                if arg in ("-o", "--output") and i + 1 < len(cmd_args):
                    out_arg = cmd_args[i + 1]
                    i += 2
                    continue
                elif arg in ("-e", "--experiments") and i + 1 < len(cmd_args):
                    i += 1
                    while i < len(cmd_args) and not cmd_args[i].startswith("-"):
                        exp_args.append(cmd_args[i])
                        i += 1
                    continue
                elif arg in ("-p", "--parameters") and i + 1 < len(cmd_args):
                    i += 1
                    while i < len(cmd_args) and not cmd_args[i].startswith("-"):
                        param_args.append(cmd_args[i])
                        i += 1
                    continue
                elif arg in ("-m", "--methods") and i + 1 < len(cmd_args):
                    i += 1
                    while i < len(cmd_args) and not cmd_args[i].startswith("-"):
                        method_args.append(cmd_args[i])
                        i += 1
                    continue
                elif arg in ("-d", "--model") and i + 1 < len(cmd_args):
                    model_arg = cmd_args[i + 1]
                    i += 2
                    continue
                elif arg == "--include" and i + 1 < len(cmd_args):
                    i += 1
                    while i < len(cmd_args) and not cmd_args[i].startswith("-"):
                        include_args.append(cmd_args[i])
                        i += 1
                    continue
                elif arg == "--exclude" and i + 1 < len(cmd_args):
                    i += 1
                    while i < len(cmd_args) and not cmd_args[i].startswith("-"):
                        exclude_args.append(cmd_args[i])
                        i += 1
                    continue
                i += 1

        spec = FitJobSpec(
            job_id=job_id,
            experiment_files=exp_args,
            parameter_files=param_args,
            method_files=method_args,
            model=model_arg,
            include=include_args,
            exclude=exclude_args,
            output_dir=out_arg,
        )

    # 2. Determine final output directory and staging directory
    raw_output = spec.output_dir or "Output"
    if os.path.isabs(raw_output):
        final_output_dir = Path(raw_output)
    else:
        final_output_dir = target_dir / raw_output

    if final_output_dir.name.endswith(".tmp"):
        final_output_dir = final_output_dir.with_name(final_output_dir.name[:-4])

    tmp_output_dir = final_output_dir.with_name(f"{final_output_dir.name}.tmp")
    if tmp_output_dir.exists():
        shutil.rmtree(tmp_output_dir, ignore_errors=True)

    # Clean up stale results and progress markers from any previous runs
    for stale_file in [
        target_dir / "engine_result.json",
        target_dir / "heartbeat",
        target_dir / "progress.jsonl",
        target_dir / "progress.json",
        target_dir / "engine.log",
        final_output_dir / "engine_result.json",
        tmp_output_dir / "engine_result.json",
    ]:
        if stale_file.exists():
            try:
                stale_file.unlink()
            except Exception:
                pass

    for leftover in target_dir.glob("*.tmp.tmp"):
        if leftover.is_dir():
            shutil.rmtree(leftover, ignore_errors=True)

    # Make staging output path relative to target_dir for the spec
    try:
        staging_rel = tmp_output_dir.relative_to(target_dir).as_posix()
    except ValueError:
        staging_rel = tmp_output_dir.name

    run_spec = spec.model_copy(deep=True)
    run_spec.output_dir = staging_rel

    # Write job.json into the job directory
    run_spec.to_file(target_dir / "job.json")

    # 3. Select launcher
    if launcher_name:
        launcher = get_launcher(launcher_name)
    elif use_container is not None:
        launcher = get_launcher("podman" if use_container else "local")
    else:
        launcher = get_launcher()

    # Pass image if PodmanLauncher
    if isinstance(launcher, PodmanLauncher):
        launcher.image_name = image_name

    resources = Resources(cpus=cpus, memory=memory_limit, walltime_s=timeout_seconds)

    # 4. Submit job
    handle = launcher.submit(target_dir, run_spec, resources)

    # Persist launcher_handle to DB if analysis record exists
    try:
        from ...database import SessionLocal
        from ...models import Analysis

        with SessionLocal() as db:
            analysis = db.query(Analysis).filter_by(analysis_uuid=job_id).first()
            if analysis:
                analysis.launcher_handle = handle.to_dict()
                db.commit()
    except Exception:
        pass

    # 5. Wait for job completion with real-time log/progress streaming
    state = wait_for_job(
        launcher=launcher,
        handle=handle,
        on_progress=progress_callback,
        log_file=log_file,
        timeout_seconds=timeout_seconds,
    )

    # 6. Collect finished job
    launcher.collect(handle)

    # 7. Atomic promotion or cleanup
    return_code = 1
    if state == JobState.DONE:
        return_code = 0
        if tmp_output_dir.exists():
            try:
                if final_output_dir.exists():
                    shutil.rmtree(final_output_dir, ignore_errors=True)
                shutil.move(str(tmp_output_dir), str(final_output_dir))
                logger.info(f"Atomically promoted {tmp_output_dir} -> {final_output_dir}")
                # Ensure engine_result.json is also accessible at target_dir / "engine_result.json"
                eng_res_in_out = final_output_dir / "engine_result.json"
                eng_res_root = target_dir / "engine_result.json"
                if eng_res_in_out.exists() and not eng_res_root.exists():
                    try:
                        shutil.copy2(eng_res_in_out, eng_res_root)
                    except Exception:
                        pass
            except Exception as e:
                logger.error(f"Failed atomic move of ChemEx output: {e}")
                return_code = 1
        elif not final_output_dir.exists():
            logger.error(f"Job completed with state DONE but neither staging ({tmp_output_dir}) nor final ({final_output_dir}) exists")
            return_code = 1
    elif state == JobState.CANCELLED:
        return_code = 130
        proc = handle.metadata.get("proc")
        if proc is not None and hasattr(proc, "returncode") and isinstance(proc.returncode, int):
            return_code = proc.returncode
        result_file = target_dir / "engine_result.json"
        if result_file.exists():
            try:
                data = json.loads(result_file.read_text(encoding="utf-8"))
                if data.get("exit_code") in (130, 137, 143):
                    return_code = data["exit_code"]
            except Exception:
                pass
        if tmp_output_dir.exists():
            shutil.rmtree(tmp_output_dir, ignore_errors=True)
            logger.info(f"Cleaned up staging output dir after cancellation: {tmp_output_dir}")
    else:
        # FAILED or LOST
        return_code = 1
        result_file = target_dir / "engine_result.json"
        if result_file.exists():
            try:
                data = json.loads(result_file.read_text(encoding="utf-8"))
                ec = data.get("exit_code")
                if ec is not None and ec != 0:
                    return_code = ec
            except Exception:
                pass
        if tmp_output_dir.exists():
            shutil.rmtree(tmp_output_dir, ignore_errors=True)
            logger.info(f"Cleaned up staging output dir after non-zero exit ({return_code}): {tmp_output_dir}")

    return return_code
