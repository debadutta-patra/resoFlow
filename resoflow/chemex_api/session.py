"""Session preparation, input validation, and parameter inspection."""

from __future__ import annotations

import contextlib
import os
import re
import sys
from argparse import Namespace
from collections import defaultdict
from pathlib import Path
from typing import Any, Literal, Sequence

from chemex.cli import build_parser
from chemex.configuration.method_plan import FormatOrigin, MethodPlan, StepPlan
from chemex.configuration.methods import Selection, read_method_plan
from chemex.configuration.parameters import ParameterConfigurationError, read_defaults
from chemex.containers.experiments import Experiments
from chemex.experiments.builder import build_experiments
from chemex.messages import print_method_v1_deprecation_warning
from chemex.parameters.parameterization import (
    ConstraintDomainError,
    IncompleteParameterDependenciesError,
)
from chemex.parameters.sealed import InvalidConfigurationError
from chemex.run_info import InputFile, capture_input_files
from chemex.runtime import (
    AnalysisSession,
    ExecutionSettings,
    ensure_plugins_registered,
)

from .errors import NoDataError
from .plugins import ensure_registered as ensure_resoflow_plugins_registered
from .spec import FitJobSpec

_CONDITION_KEYS = ("temperature", "h_larmor_frq", "p_total", "l_total", "d2o")


def _conditions(param_name: Any) -> dict[str, float]:
    cond = getattr(param_name, "conditions", None)
    if cond is None:
        return {}
    return {k: getattr(cond, k) for k in _CONDITION_KEYS if getattr(cond, k, None) is not None}


def build_session(
    spec: FitJobSpec,
    job_dir: Path | None = None,
    command: Literal["fit", "simulate"] = "fit",
) -> tuple[AnalysisSession, Experiments, MethodPlan | None, Namespace, Sequence[InputFile], list[str]]:
    """Prepare AnalysisSession, Experiments, MethodPlan, and Namespace according to steps 1-9 of the fidelity contract."""
    target_base = Path(job_dir).resolve() if job_dir is not None else Path.cwd()
    with contextlib.chdir(target_base):
        # Step 1: Ensure plugins are registered
        ensure_plugins_registered()
        ensure_resoflow_plugins_registered()

        # Step 2: Create AnalysisSession
        session = AnalysisSession.create()

        # Step 3: Configure execution settings and thread environment
        session.execution = ExecutionSettings.from_counts(
            workers=spec.execution.workers,
            native_threads=spec.execution.native_threads,
        )
        os.environ.update(session.execution.native_thread_env())

        # Step 4: Handle parameter overrides and build CLI Namespace
        overrides_relpath: str | None = None
        if spec.overrides:
            overrides_content = spec.render_overrides_toml()
            if overrides_content:
                param_dir = target_base / "Parameters"
                if param_dir.exists():
                    ov_file = param_dir / "overrides.toml"
                    overrides_relpath = "Parameters/overrides.toml"
                else:
                    ov_file = target_base / "overrides.toml"
                    overrides_relpath = "overrides.toml"
                ov_file.write_text(overrides_content, encoding="utf-8")

        equivalent_argv = spec.equivalent_argv(command=command, overrides_path=overrides_relpath)
        parser = build_parser()
        args_ns = parser.parse_args(equivalent_argv[1:])

        input_files = capture_input_files(args_ns, working_directory=target_base) if command == "fit" else ()

        # Step 5: Kinetics model
        session.set_model(spec.model)

        # Step 6: Build experiments with selection
        selection = Selection(args_ns.include, args_ns.exclude)
        experiments = build_experiments(args_ns.experiments, selection, session=session)
        if not experiments:
            raise NoDataError("No valid experimental data found matching selection criteria.")

        # Step 7: Method plan
        method_path = None
        if command == "fit":
            method_path = args_ns.method
        elif spec.method_files:
            method_path = [Path(f) for f in spec.method_files]

        if method_path:
            plan = read_method_plan(method_path)
            if plan.format_origin is FormatOrigin.V1:
                print_method_v1_deprecation_warning()
        else:
            plan = MethodPlan(FormatOrigin.V1, (StepPlan(""),)) if command == "fit" else None

        # Step 8: Parameter defaults
        defaults = read_defaults(args_ns.parameters)
        session.parameters.set_defaults(defaults)

        # Step 9: Try building native analysis values with error translation
        if not session.try_build_analysis_values():
            construction_error = getattr(session.parameter_factory, "native_construction_error", None)
            msg = "Native parameter initialization failed"
            if construction_error is None:
                raise RuntimeError(msg)
            if isinstance(
                construction_error,
                (
                    IncompleteParameterDependenciesError,
                    InvalidConfigurationError,
                    ConstraintDomainError,
                ),
            ):
                explanation = str(construction_error)
                if isinstance(construction_error, ConstraintDomainError) and isinstance(
                    construction_error.__cause__,
                    (ArithmeticError, ValueError),
                ):
                    explanation = str(construction_error.__cause__)
                raise ParameterConfigurationError(
                    tuple(args_ns.parameters),
                    explanation,
                ) from construction_error
            raise RuntimeError(f"{msg}: {construction_error}") from construction_error

        return session, experiments, plan, args_ns, input_files, equivalent_argv


def _check_legacy_names(base_dir: Path, spec: FitJobSpec) -> list[dict[str, str]]:
    """Scan parameter and method files for legacy ChemEx parameter names removed in 2026.9."""
    errors = []
    
    # 1. Parameter files
    for p_rel in spec.parameter_files:
        p_path = (base_dir / p_rel).resolve()
        if not p_path.exists() or not p_path.is_file():
            continue
        try:
            content = p_path.read_text(encoding="utf-8")
        except Exception:
            continue
        
        # Check DWP / DWM
        m_dwp = re.findall(r'\b(DW[PM](?:_[A-Za-z0-9]+)?)\b', content, re.IGNORECASE)
        for match in set(m_dwp):
            errors.append({
                "message": f"Legacy parameter '{match.upper()}' detected in '{p_rel}'. ChemEx 2026.9 replaced DWP/DWM with DW0_AX/DW1_AX for .tc models.",
                "type": "LegacyParameterError",
                "file": p_rel,
            })
            
        # Check binding model legacy names
        if spec.model and "binding" in spec.model.lower():
            m_kab = re.findall(r'\b(K(?:AB|BA|BC|CB))\b', content, re.IGNORECASE)
            for match in set(m_kab):
                errors.append({
                    "message": f"Legacy parameter '{match.upper()}' detected in '{p_rel}'. ChemEx 2026.9 uses KEQ_*/KEX_* for binding models.",
                    "type": "LegacyParameterError",
                    "file": p_rel,
                })
                
        # Check KD_EFF
        if re.search(r'\bKD_EFF\b', content, re.IGNORECASE):
            errors.append({
                "message": f"Legacy parameter 'KD_EFF' detected in '{p_rel}'. ChemEx 2026.9 renamed KD_EFF to KD_APP.",
                "type": "LegacyParameterError",
                "file": p_rel,
            })

    # 2. Method files
    for m_rel in spec.method_files:
        m_path = (base_dir / m_rel).resolve()
        if not m_path.exists() or not m_path.is_file():
            continue
        try:
            content = m_path.read_text(encoding="utf-8")
        except Exception:
            continue
            
        m_dwp = re.findall(r'\b(DW[PM](?:_[A-Za-z0-9]+)?)\b', content, re.IGNORECASE)
        for match in set(m_dwp):
            errors.append({
                "message": f"Legacy parameter '{match.upper()}' detected in method file '{m_rel}'. ChemEx 2026.9 replaced DWP/DWM with DW0_AX/DW1_AX for .tc models.",
                "type": "LegacyParameterError",
                "file": m_rel,
            })

    return errors


def inspect_parameters(
    spec: FitJobSpec,
    job_dir: Path | None = None,
    include_warnings: bool = False,
) -> list[dict[str, Any]] | dict[str, Any]:
    """Build the session up to step 9 and introspect all model parameters.
    
    If include_warnings is True, returns a dict with 'parameters', 'warnings', and 'experiments'.
    Otherwise returns just the list of parameter dicts for backward compatibility.
    """
    cm = contextlib.chdir(job_dir) if job_dir is not None else contextlib.nullcontext()
    with cm:
        target_dir = Path.cwd()
        session, experiments, _, _, _, _ = build_session(spec, job_dir=target_dir, command="fit")

        used_by: dict[str, set[str]] = defaultdict(set)
        for experiment in experiments:
            label = Path(experiment.filename).name
            for profile in experiment.profiles:
                for pid in profile.param_ids:
                    used_by[pid].add(label)

        frontier = list(used_by)
        while frontier:
            pid = frontier.pop()
            setting = session.parameters.get_parameters([pid]).get(pid)
            for dep in getattr(setting, "dependencies", None) or ():
                before = len(used_by[dep])
                used_by[dep] |= used_by[pid]
                if len(used_by[dep]) != before:
                    frontier.append(dep)

        params = session.parameters.get_parameters(used_by)
        rows: list[dict[str, Any]] = []
        for pid, setting in params.items():
            pname = setting.param_name
            status = "fit" if getattr(setting, "vary", False) else ("constrain" if getattr(setting, "expr", "") else "fix")
            rows.append({
                "id": pid,
                "selector": pname.section_res,
                "name": pname.name,
                "spin": str(pname.spin_system) if pname.spin_system else "",
                "conditions": _conditions(pname),
                "vary": bool(getattr(setting, "vary", False)),
                "status": status,
                "is_shared": len(used_by[pid]) > 1,
                "value": getattr(setting, "value", None),
                "min": getattr(setting, "min", None),
                "max": getattr(setting, "max", None),
                "expr": getattr(setting, "expr", ""),
                "experiments": sorted(used_by[pid]),
            })

        rows.sort(key=lambda r: (r["selector"], r["name"]))

        if not include_warnings:
            return rows

        # Calculate sharing map warnings
        warnings = []
        by_family: dict[tuple[str, str], list[dict]] = defaultdict(list)
        for row in rows:
            by_family[(row["name"], row["spin"])].append(row)

        for (name, spin), family in by_family.items():
            key_sets = {tuple(sorted(r["conditions"])) for r in family}
            if len(key_sets) > 1:
                warnings.append({
                    "code": "CONDITION_MISMATCH",
                    "parameter": f"{name}{', ' + spin if spin else ''}",
                    "variants": [r["selector"] for r in family],
                    "message": "Same parameter under different condition qualifiers; these copies are fitted independently, not shared.",
                })
            fields = sorted({r["conditions"]["h_larmor_frq"] for r in family if "h_larmor_frq" in r["conditions"]})
            for lo, hi in zip(fields, fields[1:]):
                if hi - lo < 1.0:
                    warnings.append({
                        "code": "NEAR_FIELD",
                        "parameter": f"{name}{', ' + spin if spin else ''}",
                        "fields_mhz": [lo, hi],
                        "message": "Fields differ by < 1 MHz, so field-dependent rates are split. Snap both to one spectrometer value if they are the same magnet.",
                    })

        all_files = sorted({Path(e.filename).name for e in experiments})
        for label in all_files:
            shares = any(r["vary"] and label in r["experiments"] and len(r["experiments"]) > 1 for r in rows)
            if not shares and len(all_files) > 1:
                warnings.append({
                    "code": "ISOLATED",
                    "experiment": label,
                    "message": "Shares no fitted parameter with any other experiment file.",
                })

        return {
            "parameters": rows,
            "warnings": warnings,
            "experiments": all_files,
        }


def validate_inputs(spec: FitJobSpec, job_dir: Path | None = None) -> dict[str, Any]:
    """Run steps 1-9 dry build plus method plan validation and return a structured report."""
    base_dir = Path(job_dir).resolve() if job_dir is not None else Path.cwd().resolve()
    report: dict[str, Any] = {
        "valid": True,
        "errors": [],
        "warnings": [],
    }

    # Step A: Check for legacy parameter names from ChemEx B9
    legacy_errors = _check_legacy_names(base_dir, spec)
    if legacy_errors:
        report["valid"] = False
        report["errors"].extend(legacy_errors)

    cm = contextlib.chdir(base_dir)
    with cm:
        try:
            session, experiments, plan, _, _, _ = build_session(spec, job_dir=base_dir, command="fit")
            parameter_model = session.parameter_factory.sealed_parameter_model
            if parameter_model is None:
                report["valid"] = False
                report["errors"].append({"message": "Native parameter model is unavailable."})
                return report

            if plan is not None and hasattr(plan, "validate"):
                try:
                    plan.validate(parameter_model)
                except Exception as exc:
                    report["valid"] = False
                    report["errors"].append({"message": str(exc), "type": type(exc).__name__})

            # Step B: Gather preflight sharing warnings
            try:
                inspection = inspect_parameters(spec, job_dir=base_dir, include_warnings=True)
                if isinstance(inspection, dict) and "warnings" in inspection:
                    report["warnings"].extend(inspection["warnings"])
            except Exception:
                pass

        except Exception as exc:
            report["valid"] = False
            report["errors"].append({"message": str(exc), "type": type(exc).__name__})

    return report
