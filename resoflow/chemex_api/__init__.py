"""resoFlow ChemEx API library facade and compatibility layer."""

from __future__ import annotations

from typing import Any

from .compat import (
    MAX_CHEMEX,
    MIN_CHEMEX,
    MODEL_ALIASES,
    check_version,
    verify_hooks,
)
from .errors import (
    ChemExCompatError,
    EngineRunError,
    InputValidationError,
    NoDataError,
)
from .fit import run_fit
from .plugins import ensure_registered, registered_plugins
from .results import EngineErrorInfo, EngineResult, EngineStepInfo, write_engine_result
from .session import build_session, inspect_parameters, validate_inputs
from .simulate import run_simulation
from .spec import ExecutionSpec, FitJobSpec, ParameterOverride, SelectionSpec


def chemex_info() -> dict[str, Any]:
    """Return runtime metadata and health checks for ChemEx and resoFlow engine."""
    version = check_version()
    hooks_valid = False
    try:
        hooks_valid = verify_hooks()
    except Exception:
        hooks_valid = False

    return {
        "chemex_version": version,
        "engine_version": "1.0.0",
        "plugins": registered_plugins(),
        "hooks_ok": hooks_valid,
    }


__all__ = [
    "ChemExCompatError",
    "EngineErrorInfo",
    "EngineResult",
    "EngineRunError",
    "EngineStepInfo",
    "ExecutionSpec",
    "FitJobSpec",
    "InputValidationError",
    "MAX_CHEMEX",
    "MIN_CHEMEX",
    "MODEL_ALIASES",
    "NoDataError",
    "ParameterOverride",
    "SelectionSpec",
    "build_session",
    "check_version",
    "chemex_info",
    "ensure_registered",
    "inspect_parameters",
    "registered_plugins",
    "run_fit",
    "run_simulation",
    "validate_inputs",
    "verify_hooks",
    "write_engine_result",
]
