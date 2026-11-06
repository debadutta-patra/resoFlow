"""Engine result models and atomic persistence for resoFlow ChemEx execution."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class EngineStepInfo(BaseModel):
    """Execution step metadata."""

    name: str
    output_dir: str

    model_config = ConfigDict(extra="ignore")


class EngineErrorInfo(BaseModel):
    """Structured error information."""

    type: str
    message: str
    stage: str = "execution"
    details: dict[str, Any] = Field(default_factory=dict)

    model_config = ConfigDict(extra="ignore")


class EngineResult(BaseModel):
    """Canonical execution outcome produced by the ChemEx engine."""

    schema_version: int = Field(default=1, alias="schema")
    status: Literal["complete", "incomplete", "failed", "cancelled"] = "complete"
    exit_code: int = 0
    chemex_version: str = "2026.9.2"
    resoflow_engine_version: str = "1.0.0"
    equivalent_argv: list[str] = Field(default_factory=list)
    outcome_toml: str | None = None
    restart_toml: str | None = None
    final_values: dict[str, float] = Field(default_factory=dict)
    steps: list[EngineStepInfo] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    error: EngineErrorInfo | None = None

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    def to_json(self, indent: int = 2) -> str:
        """Serialize result to JSON string."""
        return self.model_dump_json(by_alias=True, indent=indent)

    @classmethod
    def from_json(cls, json_str: str) -> EngineResult:
        """Deserialize result from JSON string."""
        return cls.model_validate(json.loads(json_str))

    @classmethod
    def from_file(cls, path: str | Path) -> EngineResult:
        """Read result from JSON file."""
        return cls.from_json(Path(path).read_text(encoding="utf-8"))


def write_engine_result(result: EngineResult, target_dir: str | Path) -> Path:
    """Atomically write engine_result.json into the target directory."""
    out_dir = Path(target_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    target_path = out_dir / "engine_result.json"
    tmp_path = out_dir / "engine_result.json.tmp"

    tmp_path.write_text(result.to_json(indent=2) + "\n", encoding="utf-8")
    os.replace(tmp_path, target_path)
    return target_path
