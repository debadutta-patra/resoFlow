"""ChemEx 2026.9.2 compatibility verification and private symbol contracts.

Every private or non-public ChemEx symbol used across resoFlow must be listed
here and verified via `verify_hooks()`. If a future ChemEx upgrade moves or changes
any hook signature, verification raises `ChemExCompatError` immediately at import
time / startup rather than failing a production fit.
"""

from __future__ import annotations

import importlib.metadata
import inspect
from typing import Mapping

from .errors import ChemExCompatError

MIN_CHEMEX: str = "2026.9.2"
MAX_CHEMEX: str = "2026.9.2"

# Kinetic model name aliases (e.g. forward-compatibility for upstream 2st.rs)
MODEL_ALIASES: dict[str, str] = {
    "2st.rs": "2st_rs",
}


def normalize_version(version: str) -> str:
    """Normalize version string like '2026.09.2' to '2026.9.2'."""
    parts = version.strip().split(".")
    normalized_parts = []
    for part in parts:
        if part.isdigit():
            normalized_parts.append(str(int(part)))
        else:
            normalized_parts.append(part)
    return ".".join(normalized_parts)


def check_version() -> str:
    """Verify that the installed ChemEx package matches the exact pinned version."""
    try:
        import chemex

        raw_version = getattr(chemex, "__version__", None)
        if not raw_version or raw_version == "0.0.0":
            try:
                raw_version = importlib.metadata.version("chemex")
            except Exception:
                raw_version = getattr(chemex, "__version__", "unknown")
    except ImportError as exc:
        raise ChemExCompatError("ChemEx is not installed in the current environment.") from exc

    norm_version = normalize_version(raw_version)
    norm_min = normalize_version(MIN_CHEMEX)
    norm_max = normalize_version(MAX_CHEMEX)

    if norm_version < norm_min or norm_version > norm_max:
        raise ChemExCompatError(
            f"Installed ChemEx version {raw_version!r} (normalized {norm_version!r}) is not compatible. "
            f"Required version: {MIN_CHEMEX}."
        )

    return norm_version


def verify_hooks() -> bool:
    """Verify that all required ChemEx classes, functions, and internal hook points

    exist with expected signatures.
    """
    check_version()

    # 1. MinimizationProgressReporter in chemex.messages
    try:
        from chemex.messages import MinimizationProgressReporter
    except (ImportError, AttributeError) as exc:
        raise ChemExCompatError(
            "Missing hook: chemex.messages.MinimizationProgressReporter not found."
        ) from exc

    if not hasattr(MinimizationProgressReporter, "observe"):
        raise ChemExCompatError(
            "Missing hook: MinimizationProgressReporter.observe method not found."
        )
    sig_min = inspect.signature(MinimizationProgressReporter.observe)
    params_min = list(sig_min.parameters.keys())
    if "context" not in params_min or "event" not in params_min:
        raise ChemExCompatError(
            f"Hook signature mismatch for MinimizationProgressReporter.observe: expected 'context' and 'event', got {params_min}"
        )

    # 2. MinimizationProgressReporter imported by name in chemex.optimize.native_deterministic
    try:
        from chemex.optimize import native_deterministic

        if not hasattr(native_deterministic, "MinimizationProgressReporter"):
            raise ChemExCompatError(
                "Missing hook: chemex.optimize.native_deterministic.MinimizationProgressReporter not found."
            )
    except ImportError as exc:
        raise ChemExCompatError(
            "Missing module: chemex.optimize.native_deterministic not found."
        ) from exc

    # 3. McmcProgressReporter in chemex.messages
    try:
        from chemex.messages import McmcProgressReporter
    except (ImportError, AttributeError) as exc:
        raise ChemExCompatError(
            "Missing hook: chemex.messages.McmcProgressReporter not found."
        ) from exc

    if not hasattr(McmcProgressReporter, "observe"):
        raise ChemExCompatError(
            "Missing hook: McmcProgressReporter.observe method not found."
        )
    sig_mcmc = inspect.signature(McmcProgressReporter.observe)
    params_mcmc = list(sig_mcmc.parameters.keys())
    if "completed_steps" not in params_mcmc:
        raise ChemExCompatError(
            f"Hook signature mismatch for McmcProgressReporter.observe: expected 'completed_steps', got {params_mcmc}"
        )

    # 4. McmcProgressReporter imported by name in chemex.optimize.mcmc
    try:
        from chemex.optimize import mcmc

        if not hasattr(mcmc, "McmcProgressReporter"):
            raise ChemExCompatError(
                "Missing hook: chemex.optimize.mcmc.McmcProgressReporter not found."
            )
    except ImportError as exc:
        raise ChemExCompatError("Missing module: chemex.optimize.mcmc not found.") from exc

    # 5. run_native_resampling in chemex.optimize.resampling
    try:
        from chemex.optimize.resampling import run_native_resampling
    except (ImportError, AttributeError) as exc:
        raise ChemExCompatError(
            "Missing hook: chemex.optimize.resampling.run_native_resampling not found."
        ) from exc

    sig_resample = inspect.signature(run_native_resampling)
    params_resample = list(sig_resample.parameters.keys())
    for req_param in ("experiments", "path", "kind", "request", "fit"):
        if req_param not in params_resample:
            raise ChemExCompatError(
                f"Hook signature mismatch for run_native_resampling: missing required parameter '{req_param}', got {params_resample}"
            )

    # 6. Session and plugin registration
    try:
        from chemex.runtime.session import AnalysisSession, ensure_plugins_registered
    except (ImportError, AttributeError) as exc:
        raise ChemExCompatError(
            "Missing runtime session hook: AnalysisSession or ensure_plugins_registered not found."
        ) from exc

    # 7. Experiment types registration
    try:
        from chemex.experiments.experiment_types import (
            ExperimentType,
            register_experiment_type,
            registered_experiment_types,
        )
    except (ImportError, AttributeError) as exc:
        raise ChemExCompatError(
            "Missing experiment_types hook: ExperimentType, register_experiment_type, or registered_experiment_types not found."
        ) from exc

    # 8. Execution settings
    try:
        from chemex.runtime.execution import ExecutionSettings
    except (ImportError, AttributeError) as exc:
        raise ChemExCompatError(
            "Missing execution settings: chemex.runtime.execution.ExecutionSettings not found."
        ) from exc

    # 9. Method-step announcement (wrapped by progress.install_progress_hooks to report the running step)
    try:
        from chemex.optimize import method_plan_execution
    except ImportError as exc:
        raise ChemExCompatError("Missing module: chemex.optimize.method_plan_execution not found.") from exc
    if not callable(getattr(method_plan_execution, "print_step_name", None)):
        raise ChemExCompatError(
            "Missing hook: chemex.optimize.method_plan_execution.print_step_name not found."
        )
    if list(inspect.signature(method_plan_execution.print_step_name).parameters) != ["name", "index", "total"]:
        raise ChemExCompatError("Hook signature mismatch for print_step_name(name, index, total).")

    # 10. Role resolution (roles.resolve_roles): effective actions, per-step compilation, rule attribution
    try:
        from chemex.configuration.method_plan import MethodPlan
        from chemex.parameters.parameterization import ActiveParameterization, _build_action_rules
        from chemex.runtime.session import AnalysisSession as _Session
    except (ImportError, AttributeError) as exc:
        raise ChemExCompatError(f"Missing role-resolution hook: {exc}") from exc
    for owner, attr in (
        (MethodPlan, "effective_role_actions"),
        (_Session, "compile_parameterization_from_actions"),
        (ActiveParameterization, "role"),
        (ActiveParameterization, "scope_ids"),
    ):
        if not hasattr(owner, attr):
            raise ChemExCompatError(f"Missing role-resolution hook: {owner.__name__}.{attr}")
    try:
        from chemex.configuration.method_validation import resolve_de_coordinates, resolve_grid_axes
    except (ImportError, AttributeError) as exc:
        raise ChemExCompatError(f"Missing search-resolution hook: {exc}") from exc
    if not {"active_scope_ids", "final_fit_ids"} <= set(inspect.signature(resolve_grid_axes).parameters):
        raise ChemExCompatError("Hook signature mismatch for resolve_grid_axes(search, model, *, active_scope_ids, final_fit_ids).")
    if list(inspect.signature(resolve_de_coordinates).parameters) != ["search", "model"]:
        raise ChemExCompatError("Hook signature mismatch for resolve_de_coordinates(search, model).")
    if list(inspect.signature(_build_action_rules).parameters) != ["actions", "definitions"]:
        raise ChemExCompatError("Hook signature mismatch for parameterization._build_action_rules(actions, definitions).")

    return True
