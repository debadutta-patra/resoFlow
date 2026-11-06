"""Structured exception hierarchy for resoFlow ChemEx API."""

from __future__ import annotations

from typing import Any
from chemex.exceptions import ChemExError


class ChemExCompatError(RuntimeError):
    """Raised when the installed ChemEx version or internal hooks do not match requirements."""


class NoDataError(ChemExError):
    """Raised when no valid experimental data was found matching the selection criteria."""


class InputValidationError(Exception):
    """Raised when input files, parameter values, or job specifications fail validation."""

    def __init__(self, message: str, errors: list[dict[str, Any]] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.errors = errors or []


class EngineRunError(Exception):
    """Raised when the ChemEx engine encounters an execution error."""

    def __init__(
        self,
        message: str,
        stage: str = "execution",
        exit_code: int = 1,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.stage = stage
        self.exit_code = exit_code
        self.details = details or {}
