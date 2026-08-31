"""
Provenance and Trust-Gate Parser (§1.3, §1.4).
Pure functions, total over messy/interrupted files.
"""

from __future__ import annotations

import os
import tomllib
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from .models import (
    GitMetadata,
    InputFileRef,
    OutcomeModel,
    ProvenanceModel,
    RunState,
    StartingParameter,
    StructuredWarning,
)


def _safe_float(val: Any) -> Optional[float]:
    if val is None:
        return None
    try:
        f = float(val)
        return f
    except (ValueError, TypeError):
        return None


def parse_outcome_toml(
    output_dir: Path,
    warnings: list[StructuredWarning],
    *,
    staleness_minutes: float = 5.0,
    is_task_active_fn: Optional[callable] = None,
) -> OutcomeModel:
    """
    Parse run_info/outcome.toml trust gate (§1.3).
    Total function: handles missing, corrupted, or stale outcome files.
    """
    outcome_file = output_dir / "run_info" / "outcome.toml"
    if not outcome_file.exists():
        # Fallback heuristic: check if run.toml exists and scientific outputs exist
        run_file = output_dir / "run_info" / "run.toml"
        stats_file = output_dir / "statistics.toml"
        fitted_file = output_dir / "Parameters" / "fitted.toml"
        has_step_dirs = any(
            p.is_dir() and (p / "Parameters").exists()
            for p in output_dir.iterdir()
            if p.name != "run_info" and not p.name.startswith(".")
        ) if output_dir.exists() else False

        if stats_file.exists() or fitted_file.exists() or has_step_dirs:
            status = RunState.COMPLETE
            is_provisional = False
        elif run_file.exists():
            status = RunState.INCOMPLETE
            is_provisional = True
            warnings.append(
                StructuredWarning(
                    code="MISSING_OUTCOME_GATE",
                    message="run_info/outcome.toml is absent; run marked incomplete based on run.toml presence without complete outputs.",
                    path=str(outcome_file),
                )
            )
        else:
            status = RunState.UNKNOWN
            is_provisional = True

        return OutcomeModel(
            schema_version=1,
            status=status,
            is_provisional=is_provisional,
            failure_reason="outcome.toml not emitted" if is_provisional else None,
        )

    try:
        data = tomllib.loads(outcome_file.read_text(encoding="utf-8"))
    except Exception as exc:
        warnings.append(
            StructuredWarning(
                code="CORRUPT_OUTCOME_FILE",
                message=f"Failed to decode outcome.toml: {exc}",
                path=str(outcome_file),
            )
        )
        return OutcomeModel(
            schema_version=2,
            status=RunState.INCOMPLETE,
            is_provisional=True,
            failure_reason=f"Corrupt outcome.toml: {exc}",
        )

    raw_status = str(data.get("status", "incomplete")).lower()
    if raw_status == "complete":
        status = RunState.COMPLETE
    elif raw_status == "running":
        # Staleness heuristic check
        is_stale = False
        if is_task_active_fn is not None:
            try:
                is_stale = not bool(is_task_active_fn())
            except Exception:
                is_stale = False
        else:
            # Check last mtime across output directory
            try:
                latest_mtime = max(
                    (p.stat().st_mtime for p in output_dir.rglob("*")),
                    default=0.0,
                )
                age_seconds = datetime.now().timestamp() - latest_mtime
                if age_seconds > staleness_minutes * 60.0:
                    is_stale = True
            except Exception:
                pass

        status = RunState.ABANDONED if is_stale else RunState.RUNNING
    elif raw_status == "incomplete":
        status = RunState.INCOMPLETE
    else:
        status = RunState.UNKNOWN

    is_provisional = (status != RunState.COMPLETE)

    return OutcomeModel(
        schema_version=int(data.get("schema_version", 2)),
        status=status,
        latest_committed_revision=data.get("latest_committed_revision"),
        latest_restart_revision=data.get("latest_restart_revision"),
        failure_stage=data.get("failure_stage"),
        failure_reason=data.get("failure_reason"),
        is_provisional=is_provisional,
        raw=data,
    )


def parse_run_toml(
    output_dir: Path,
    warnings: list[StructuredWarning],
) -> Optional[ProvenanceModel]:
    """
    Parse run_info/run.toml metadata (§1.4).
    """
    run_file = output_dir / "run_info" / "run.toml"
    if not run_file.exists():
        warnings.append(
            StructuredWarning(
                code="MISSING_RUN_TOML",
                message="run_info/run.toml is absent; provenance metadata unavailable.",
                path=str(run_file),
            )
        )
        return None

    try:
        data = tomllib.loads(run_file.read_text(encoding="utf-8"))
    except Exception as exc:
        warnings.append(
            StructuredWarning(
                code="CORRUPT_RUN_TOML",
                message=f"Failed to parse run.toml: {exc}",
                path=str(run_file),
            )
        )
        return None

    # Parse created_at_utc
    created_at = None
    if "created_at_utc" in data:
        try:
            created_at = datetime.fromisoformat(str(data["created_at_utc"]))
        except Exception:
            pass

    # Inputs table array
    inputs_list: list[InputFileRef] = []
    raw_inputs = data.get("inputs", {})
    if isinstance(raw_inputs, dict):
        for category, file_entries in raw_inputs.items():
            if isinstance(file_entries, list):
                for entry in file_entries:
                    if isinstance(entry, dict):
                        inputs_list.append(
                            InputFileRef(
                                category=category,
                                provided_path=str(entry.get("provided_path", "")),
                                resolved_path=str(entry.get("resolved_path", "")),
                                copied_path=str(entry.get("copied_path", "")),
                            )
                        )

    # Git table
    git_meta = None
    if "git" in data and isinstance(data["git"], dict):
        g = data["git"]
        git_meta = GitMetadata(
            commit=g.get("commit"),
            branch=g.get("branch"),
            working_tree_dirty=g.get("working_tree_dirty"),
        )

    # Command arguments
    command_data = data.get("command", {})
    arguments = command_data.get("arguments", []) if isinstance(command_data, dict) else []

    # Run table
    run_table = data.get("run", {}) if isinstance(data.get("run"), dict) else {}
    chemex_table = data.get("chemex", {}) if isinstance(data.get("chemex"), dict) else {}
    python_table = data.get("python", {}) if isinstance(data.get("python"), dict) else {}

    return ProvenanceModel(
        schema_version=int(data.get("schema_version", 1)),
        created_at_utc=created_at,
        kind=str(run_table.get("kind", "fit")),
        working_directory=run_table.get("working_directory"),
        output_directory=run_table.get("output_directory"),
        chemex_version=chemex_table.get("version"),
        python_version=python_table.get("version"),
        python_platform=python_table.get("platform"),
        arguments=arguments,
        inputs=inputs_list,
        git=git_meta,
        root_seeds=data.get("seeds", {}),
    )


def parse_parameters_used_toml(
    output_dir: Path,
    warnings: list[StructuredWarning],
) -> dict[str, dict[str, StartingParameter]]:
    """
    Parse run_info/parameters_used.toml (§1.4).
    Returns mapping of section -> key -> StartingParameter.
    """
    params_file = output_dir / "run_info" / "parameters_used.toml"
    if not params_file.exists():
        return {}

    try:
        data = tomllib.loads(params_file.read_text(encoding="utf-8"))
    except Exception as exc:
        warnings.append(
            StructuredWarning(
                code="CORRUPT_PARAMETERS_USED_TOML",
                message=f"Failed to parse parameters_used.toml: {exc}",
                path=str(params_file),
            )
        )
        return {}

    result: dict[str, dict[str, StartingParameter]] = {}
    for section_name, key_values in data.items():
        if not isinstance(key_values, dict):
            continue
        result[section_name] = {}
        for key_name, val_array in key_values.items():
            name = f"[{section_name}]/{key_name}" if section_name != "GLOBAL" else key_name
            val = None
            min_val = None
            max_val = None
            brute_step = None
            if isinstance(val_array, list):
                if len(val_array) > 0:
                    val = _safe_float(val_array[0])
                if len(val_array) > 1:
                    min_val = _safe_float(val_array[1])
                if len(val_array) > 2:
                    max_val = _safe_float(val_array[2])
                if len(val_array) > 3:
                    brute_step = _safe_float(val_array[3])
            elif isinstance(val_array, (int, float)):
                val = float(val_array)

            result[section_name][key_name] = StartingParameter(
                name=name,
                section=section_name,
                key=key_name,
                value=val,
                min_val=min_val,
                max_val=max_val,
                brute_step=brute_step,
            )

    return result


def locate_restart_file(
    output_dir: Path,
) -> tuple[Optional[str], bool, Optional[str]]:
    """
    Check for run_info/restart.toml (§1.4).
    Returns (restart_path, can_continue, explanation).
    """
    restart_file = output_dir / "run_info" / "restart.toml"
    if restart_file.exists() and restart_file.is_file() and restart_file.stat().st_size > 0:
        return (str(restart_file), True, None)
    return (
        None,
        False,
        "No restart checkpoint found in run_info/restart.toml (fit made no state-changing commit or was interrupted).",
    )
