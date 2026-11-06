"""Job specification and parameter override models for resoFlow ChemEx execution."""

from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class ParameterOverride(BaseModel):
    """Specification of a single parameter override to be applied over baseline defaults."""

    selector: str | None = None
    section: str = "GLOBAL"
    name: str | None = None
    value: float
    min: float | None = None
    max: float | None = None
    brute_step: float | None = None

    model_config = ConfigDict(extra="ignore")

    def get_section_and_name(self) -> tuple[str, str]:
        """Resolve the TOML section and parameter name."""
        if self.selector:
            s = self.selector.strip()
            if s.startswith("[") and "]" in s:
                close_bracket = s.find("]")
                sec = s[1:close_bracket].strip()
                remainder = s[close_bracket + 1 :].strip()
                if remainder.startswith("."):
                    remainder = remainder[1:].strip()
                if remainder:
                    return sec, remainder
                if self.name:
                    return sec, self.name
                return "GLOBAL", sec
            if "." in s:
                sec, nm = s.split(".", 1)
                return sec.strip(), nm.strip()
            if " " in s:
                sec, nm = s.split(" ", 1)
                return sec.strip(), nm.strip()
            if self.name:
                return self.section, self.name
            return self.section, s
        return self.section, self.name or ""


class ExecutionSpec(BaseModel):
    """Execution resources settings."""

    workers: int | Literal["auto"] = "auto"
    native_threads: int | Literal["auto"] = "auto"

    model_config = ConfigDict(extra="ignore")


class SelectionSpec(BaseModel):
    """Spin system inclusion and exclusion criteria."""

    include: list[str] = Field(default_factory=list)
    exclude: list[str] = Field(default_factory=list)

    model_config = ConfigDict(extra="ignore")


class FitJobSpec(BaseModel):
    """Self-contained job specification for running a ChemEx fit or simulation.

    All paths are relative to the job directory containing the spec file.
    """

    schema_version: int = Field(default=1, alias="schema")
    job_id: str = ""
    chemex_version: str = "2026.9.2"
    engine_version: str = "1.0.0"

    experiment_files: list[str] = Field(default_factory=list)
    parameter_files: list[str] = Field(default_factory=list)
    method_files: list[str] = Field(default_factory=list)

    model: str = "2st"
    include: list[str] = Field(default_factory=list)
    exclude: list[str] = Field(default_factory=list)

    output_dir: str = "output"
    plot: Literal["nothing", "normal", "all"] = "normal"
    execution: ExecutionSpec = Field(default_factory=ExecutionSpec)
    overrides: list[ParameterOverride] = Field(default_factory=list)

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    def render_overrides_toml(self) -> str:
        """Render overrides as a ChemEx-compatible TOML parameter defaults string."""
        if not self.overrides:
            return ""

        grouped: dict[str, dict[str, Any]] = defaultdict(dict)
        for ov in self.overrides:
            sec, nm = ov.get_section_and_name()
            if ov.brute_step is not None and ov.min is not None and ov.max is not None:
                vals = [ov.value, ov.min, ov.max, ov.brute_step]
            elif ov.min is not None and ov.max is not None:
                vals = [ov.value, ov.min, ov.max]
            else:
                vals = ov.value
            grouped[sec.upper()][nm] = vals

        lines: list[str] = []
        for sec, entries in grouped.items():
            lines.append(f"[{sec}]")
            for nm, val in entries.items():
                if isinstance(val, list):
                    formatted_vals = ", ".join(f"{v:.6g}" if isinstance(v, float) else str(v) for v in val)
                    lines.append(f"{nm} = [{formatted_vals}]")
                else:
                    lines.append(f"{nm} = {val:.6g}" if isinstance(val, float) else f"{nm} = {val}")
            lines.append("")

        return "\n".join(lines).strip() + "\n"

    def equivalent_argv(
        self,
        command: Literal["fit", "simulate"] = "fit",
        overrides_path: str | Path | None = None,
    ) -> list[str]:
        """Construct the equivalent ChemEx CLI argv vector reproducing this run."""
        argv = ["chemex", command]
        if self.experiment_files:
            argv.append("-e")
            argv.extend(str(f) for f in self.experiment_files)

        param_files = list(self.parameter_files)
        if overrides_path is not None:
            param_files.append(str(overrides_path))
        if param_files:
            argv.append("-p")
            argv.extend(str(f) for f in param_files)

        if command == "fit" and self.method_files:
            argv.append("-m")
            argv.extend(str(f) for f in self.method_files)

        argv.extend(["-d", self.model])
        argv.extend(["-o", str(self.output_dir)])
        argv.extend(["--plot", self.plot])

        if self.include:
            argv.append("--include")
            argv.extend(self.include)
        if self.exclude:
            argv.append("--exclude")
            argv.extend(self.exclude)

        argv.extend(["--workers", str(self.execution.workers)])
        argv.extend(["--native-threads", str(self.execution.native_threads)])

        return argv

    def to_json(self, indent: int = 2) -> str:
        """Serialize spec to JSON."""
        return self.model_dump_json(by_alias=True, indent=indent)

    @classmethod
    def from_json(cls, json_str: str) -> FitJobSpec:
        """Deserialize spec from JSON string."""
        data = json.loads(json_str)
        return cls.model_validate(data)

    @classmethod
    def from_file(cls, path: str | Path) -> FitJobSpec:
        """Read and validate spec from file."""
        return cls.from_json(Path(path).read_text(encoding="utf-8"))

    def to_file(self, path: str | Path) -> None:
        """Write spec to file."""
        Path(path).write_text(self.to_json(), encoding="utf-8")
