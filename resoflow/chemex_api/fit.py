"""Direct library entry point for running ChemEx fits with progress capture."""

from __future__ import annotations

import contextlib
import sys
import traceback
from pathlib import Path
from typing import Any, Callable

import chemex.chemex
from chemex.exceptions import ChemExError

from .compat import check_version
from .errors import NoDataError
from .progress import ProgressObserver, install_progress_hooks
from .results import EngineErrorInfo, EngineResult, EngineStepInfo, write_engine_result
from .session import build_session
from .spec import FitJobSpec


def _is_interrupted(error: BaseException) -> bool:
    if isinstance(error, KeyboardInterrupt):
        return True
    if isinstance(error, ChemExError) and getattr(error, "terminal", None) == "interrupted":
        return True
    return False


def run_fit(
    spec: FitJobSpec,
    observer: ProgressObserver | None = None,
    job_dir: Path | None = None,
) -> EngineResult:
    """Execute a ChemEx fit using the fidelity contract, delegating directly to chemex.chemex.run_fit."""
    chemex_ver = check_version()
    base_dir = Path(job_dir).resolve() if job_dir is not None else Path.cwd()

    hook_cm = install_progress_hooks(observer) if observer is not None else contextlib.nullcontext()

    session = None
    args_ns = None
    equivalent_argv = []
    plan = None

    try:
        with hook_cm, contextlib.chdir(base_dir):
            session, experiments, plan, args_ns, input_files, equivalent_argv = build_session(
                spec, job_dir=base_dir, command="fit"
            )

            chemex.chemex.run_fit(
                args_ns,
                experiments,
                session,
                input_files=input_files,
                argv=equivalent_argv,
                methods=plan,
            )

        final_values: dict[str, float] = {}
        with contextlib.suppress(Exception):
            if session is not None and hasattr(session, "analysis_values"):
                final_values = {str(k): float(v) for k, v in session.analysis_values.snapshot().items()}

        steps: list[EngineStepInfo] = []
        if plan is not None and hasattr(plan, "steps"):
            for step_plan in plan.steps:
                s_name = step_plan.name if step_plan.name else "STEP1"
                steps.append(EngineStepInfo(name=s_name, output_dir=s_name))

        out_raw = Path(args_ns.output) if (args_ns is not None and getattr(args_ns, "output", None)) else Path(spec.output_dir)
        out_path = out_raw if out_raw.is_absolute() else (base_dir / out_raw)
        outcome_file = out_path / "run_info" / "outcome.toml"
        restart_file = out_path / "run_info" / "restart.toml"

        result = EngineResult(
            status="complete",
            exit_code=0,
            chemex_version=chemex_ver,
            resoflow_engine_version=spec.engine_version,
            equivalent_argv=equivalent_argv,
            outcome_toml=str(outcome_file) if outcome_file.exists() else None,
            restart_toml=str(restart_file) if restart_file.exists() else None,
            final_values=final_values,
            steps=steps,
        )
        write_engine_result(result, out_path)
        return result

    except BaseException as exc:
        interrupted = _is_interrupted(exc)
        if interrupted:
            status = "cancelled"
            exit_code = 130
            stage = getattr(exc, "failure_stage", "deterministic_fit")
        elif isinstance(exc, NoDataError):
            status = "failed"
            exit_code = 2
            stage = "input"
        elif isinstance(exc, ChemExError):
            status = "failed"
            exit_code = 3
            stage = getattr(exc, "failure_stage", "deterministic_fit")
        else:
            status = "failed"
            exit_code = 1
            stage = getattr(exc, "failure_stage", "unknown")

        if not interrupted:
            traceback.print_exc(file=sys.stderr)

        err_info = EngineErrorInfo(
            type=type(exc).__name__,
            message=str(exc),
            stage=stage,
        )

        final_values = {}
        if session is not None and hasattr(session, "analysis_values"):
            with contextlib.suppress(Exception):
                final_values = {str(k): float(v) for k, v in session.analysis_values.snapshot().items()}

        out_raw = Path(args_ns.output) if (args_ns is not None and getattr(args_ns, "output", None)) else Path(spec.output_dir)
        out_path = out_raw if out_raw.is_absolute() else (base_dir / out_raw)
        outcome_file = out_path / "run_info" / "outcome.toml"
        restart_file = out_path / "run_info" / "restart.toml"

        result = EngineResult(
            status=status,
            exit_code=exit_code,
            chemex_version=chemex_ver,
            resoflow_engine_version=spec.engine_version,
            equivalent_argv=equivalent_argv if equivalent_argv else spec.equivalent_argv(),
            outcome_toml=str(outcome_file) if outcome_file.exists() else None,
            restart_toml=str(restart_file) if restart_file.exists() else None,
            final_values=final_values,
            error=err_info,
        )

        with contextlib.suppress(Exception):
            write_engine_result(result, out_path)

        return result
