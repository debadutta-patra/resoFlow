"""Command-line interface for the standalone resoFlow ChemEx execution engine."""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
from pathlib import Path
from typing import Any

from resoflow.chemex_api.compat import check_version, normalize_version, verify_hooks
from resoflow.chemex_api.fit import run_fit
from resoflow.chemex_api.progress import ProgressFileLogger, start_heartbeat
from resoflow.chemex_api.results import EngineErrorInfo, EngineResult, write_engine_result
from resoflow.chemex_api.session import validate_inputs
from resoflow.chemex_api.spec import FitJobSpec


def _handle_sigterm(signum: int, frame: Any) -> None:
    raise KeyboardInterrupt("Received SIGTERM signal")


signal.signal(signal.SIGTERM, _handle_sigterm)


def cmd_version(args: argparse.Namespace) -> int:
    """Print version and compatibility metadata in JSON."""
    try:
        ver = check_version()
        hooks_ok = verify_hooks()
    except Exception as exc:
        payload = {
            "chemex_version": "unknown",
            "engine_version": "1.0.0",
            "plugins": [],
            "hooks_ok": False,
            "error": str(exc),
        }
        print(json.dumps(payload, indent=2))
        return 1

    payload = {
        "chemex_version": ver,
        "engine_version": "1.0.0",
        "plugins": [],
        "hooks_ok": hooks_ok,
    }
    print(json.dumps(payload, indent=2))
    return 0


def cmd_validate(args: argparse.Namespace) -> int:
    """Validate a job.json specification without executing the fit."""
    job_path = Path(args.job_json).resolve()
    if not job_path.exists():
        print(json.dumps({"valid": False, "errors": [{"message": f"Job file not found: {job_path}"}]}))
        return 2

    job_dir = job_path.parent
    os.chdir(job_dir)

    try:
        spec = FitJobSpec.from_file(job_path)
    except Exception as exc:
        print(json.dumps({"valid": False, "errors": [{"message": f"Invalid job spec: {exc}", "type": type(exc).__name__}]}))
        return 2

    report = validate_inputs(spec, job_dir=job_dir)
    print(json.dumps(report, indent=2))
    return 0 if report.get("valid", False) else 2


def cmd_run(args: argparse.Namespace) -> int:
    """Execute a fit from a self-contained job.json specification."""
    job_path = Path(args.job_json).resolve()
    if not job_path.exists():
        sys.stderr.write(f"Error: job file not found: {job_path}\n")
        return 2

    job_dir = job_path.parent
    os.chdir(job_dir)

    os.environ["TERM"] = "dumb"
    os.environ.setdefault("MPLBACKEND", "Agg")

    # Set up SIGTERM handler to gracefully trigger KeyboardInterrupt in main thread
    signal.signal(signal.SIGTERM, _handle_sigterm)

    # Redirect stdout and stderr to engine.log
    engine_log_path = job_dir / "engine.log"
    log_fd = open(engine_log_path, "a", buffering=1, encoding="utf-8")
    orig_stdout_fd = sys.stdout.fileno()
    orig_stderr_fd = sys.stderr.fileno()
    os.dup2(log_fd.fileno(), orig_stdout_fd)
    os.dup2(log_fd.fileno(), orig_stderr_fd)
    sys.stdout = log_fd
    sys.stderr = log_fd

    try:
        spec = FitJobSpec.from_file(job_path)
    except Exception as exc:
        err_msg = f"Failed to load job specification: {exc}"
        sys.stderr.write(err_msg + "\n")
        err_info = EngineErrorInfo(type=type(exc).__name__, message=err_msg, stage="input")
        res = EngineResult(
            status="failed",
            exit_code=2,
            chemex_version="unknown",
            resoflow_engine_version="1.0.0",
            error=err_info,
        )
        write_engine_result(res, job_dir / "output")
        return 2

    # Check installed ChemEx version against spec
    try:
        installed_ver = check_version()
        if normalize_version(installed_ver) != normalize_version(spec.chemex_version):
            err_msg = (
                f"ChemEx version mismatch: installed is {installed_ver}, "
                f"job requires {spec.chemex_version}"
            )
            sys.stderr.write(err_msg + "\n")
            err_info = EngineErrorInfo(type="VersionMismatchError", message=err_msg, stage="input")
            res = EngineResult(
                status="failed",
                exit_code=2,
                chemex_version=installed_ver,
                resoflow_engine_version=spec.engine_version,
                error=err_info,
            )
            write_engine_result(res, job_dir / spec.output_dir)
            return 2
    except Exception as exc:
        sys.stderr.write(f"Compatibility verification failed: {exc}\n")
        err_info = EngineErrorInfo(type=type(exc).__name__, message=str(exc), stage="input")
        res = EngineResult(
            status="failed",
            exit_code=2,
            chemex_version="unknown",
            resoflow_engine_version=spec.engine_version,
            error=err_info,
        )
        write_engine_result(res, job_dir / spec.output_dir)
        return 2

    # Start progress file logger and heartbeat
    progress_logger = ProgressFileLogger(job_dir)
    stop_heartbeat = start_heartbeat(job_dir)

    try:
        result = run_fit(spec, observer=progress_logger, job_dir=job_dir)
        return result.exit_code
    finally:
        stop_heartbeat()
        progress_logger.close()
        log_fd.flush()


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="python -m resoflow.engine",
        description="resoFlow standalone isolated execution engine for ChemEx",
    )
    subparsers = parser.add_subparsers(dest="subcommand", required=True)

    # version subcommand
    p_ver = subparsers.add_parser("version", help="Print version and environment check")
    p_ver.set_defaults(func=cmd_version)

    # validate subcommand
    p_val = subparsers.add_parser("validate", help="Validate a job.json file without fitting")
    p_val.add_argument("job_json", help="Path to job.json")
    p_val.set_defaults(func=cmd_validate)

    # run subcommand
    p_run = subparsers.add_parser("run", help="Run a fit from job.json")
    p_run.add_argument("job_json", help="Path to job.json")
    p_run.set_defaults(func=cmd_run)

    args = parser.parse_args()
    exit_code = args.func(args)
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
