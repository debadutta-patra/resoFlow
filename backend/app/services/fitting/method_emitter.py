"""
ChemEx v1 Method TOML Emitter, Parser, and Validator.
Supports standard v1 method sections (FIT, FIX, CONSTRAINTS, GRID, INCLUDE, EXCLUDE)
and full STATISTICS configuration (MC, BS, BSN, MCMC).
"""

from __future__ import annotations

import re
import sys
from typing import Any, Dict, List, Literal, Optional, Tuple, Union

if sys.version_info >= (3, 11):
    import tomllib
else:
    import tomli as tomllib

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)


class McmcSettingsModel(BaseModel):
    model_config = ConfigDict(extra="ignore")

    steps: int = Field(..., description="Number of sampler iterations per walker")
    burn: Union[int, Literal["auto"]] = Field(
        default="auto",
        description="Number of initial steps to discard or 'auto'",
    )
    thin: int = Field(default=1, description="Thinning interval")
    walkers: Optional[int] = Field(
        default=None,
        description="Number of walkers (default: max(32, 2 * nvarys))",
    )
    seed: Optional[int] = Field(default=None, description="Random seed for reproducibility")
    workers: Optional[int] = Field(default=None, description="Parallel worker count for MCMC")
    update_parameters: bool = Field(
        default=False,
        description="Update parameter store with posterior median and stderr",
    )

    @field_validator("steps")
    @classmethod
    def validate_steps(cls, v: int) -> int:
        if v < 1:
            raise ValueError("MCMC steps must be a positive integer (>= 1)")
        return v

    @field_validator("burn", mode="before")
    @classmethod
    def parse_burn(cls, v: Any) -> Union[int, Literal["auto"]]:
        if isinstance(v, str):
            if v.strip().lower() == "auto":
                return "auto"
            try:
                v = int(v)
            except ValueError:
                raise ValueError("MCMC burn must be a non-negative integer or 'auto'")
        if isinstance(v, int):
            if v < 0:
                raise ValueError("MCMC burn must be non-negative (>= 0)")
            return v
        raise ValueError("MCMC burn must be a non-negative integer or 'auto'")

    @field_validator("thin")
    @classmethod
    def validate_thin(cls, v: int) -> int:
        if v < 1:
            raise ValueError("MCMC thin must be a positive integer (>= 1)")
        return v

    @field_validator("walkers")
    @classmethod
    def validate_walkers(cls, v: Optional[int]) -> Optional[int]:
        if v is not None and v < 1:
            raise ValueError("MCMC walkers must be a positive integer (>= 1)")
        return v

    @field_validator("workers")
    @classmethod
    def validate_workers(cls, v: Optional[int]) -> Optional[int]:
        if v is not None and v < 1:
            raise ValueError("MCMC workers must be a positive integer (>= 1)")
        return v

    @model_validator(mode="after")
    def validate_sample_window(self) -> McmcSettingsModel:
        burn_val = 0 if self.burn == "auto" else self.burn
        if burn_val >= self.steps:
            raise ValueError(f"MCMC burn ({burn_val}) must be smaller than steps ({self.steps})")
        retained = (self.steps - burn_val) // self.thin
        if retained < 1:
            raise ValueError(
                f"MCMC settings retain 0 samples with steps={self.steps}, burn={burn_val}, thin={self.thin}"
            )
        return self


class StatisticsModel(BaseModel):
    model_config = ConfigDict(extra="ignore")

    mc: Optional[int] = Field(default=None, description="Number of Monte Carlo replicates")
    bs: Optional[int] = Field(default=None, description="Number of Bootstrap replicates")
    bsn: Optional[int] = Field(default=None, description="Number of Nucleus-Specific Bootstrap replicates")
    mcmc: Optional[Union[int, McmcSettingsModel]] = Field(
        default=None,
        description="MCMC chain length or detailed McmcSettingsModel",
    )

    @field_validator("mc", "bs", "bsn")
    @classmethod
    def validate_replicates(cls, v: Optional[int], info) -> Optional[int]:
        if v is not None and v < 1:
            raise ValueError(f"Replicate count for {info.field_name.upper()} must be a positive integer (>= 1)")
        return v

    @field_validator("mcmc", mode="before")
    @classmethod
    def parse_mcmc(cls, v: Any) -> Optional[Union[int, McmcSettingsModel]]:
        if v is None:
            return None
        if isinstance(v, int):
            if v < 1:
                raise ValueError("MCMC steps must be a positive integer (>= 1)")
            return v
        if isinstance(v, dict):
            lower_dict = {k.lower(): val for k, val in v.items()}
            return McmcSettingsModel(**lower_dict)
        return v

    def is_empty(self) -> bool:
        return self.mc is None and self.bs is None and self.bsn is None and self.mcmc is None


class ParamSettingModel(BaseModel):
    name: str
    mode: Literal["default", "fit", "fix", "constrain", "grid"] = "default"
    value: Optional[float] = None
    bounds: Optional[str] = None
    expression: Optional[str] = None
    grid: Optional[Dict[str, Any]] = None


class MethodStepModel(BaseModel):
    id: Optional[str] = None
    name: str = "STEP1"
    parameters: List[ParamSettingModel] = Field(default_factory=list)
    residue_mode: Literal["include", "exclude"] = "include"
    residues: List[Union[int, str]] = Field(default_factory=list)
    statistics: Optional[StatisticsModel] = None


class MethodConfigModel(BaseModel):
    steps: List[MethodStepModel] = Field(default_factory=list)
    raw_override: Optional[str] = None


def _format_mcmc_subtable(mcmc: McmcSettingsModel, step_name: str) -> str:
    """Format MCMC settings as a [STEP.STATISTICS.MCMC] subtable."""
    lines = [f"[{step_name}.STATISTICS.MCMC]"]
    lines.append(f"STEPS = {mcmc.steps}")
    if isinstance(mcmc.burn, str):
        lines.append(f'BURN = "{mcmc.burn.upper()}"')
    else:
        lines.append(f"BURN = {mcmc.burn}")
    lines.append(f"THIN = {mcmc.thin}")
    if mcmc.walkers is not None:
        lines.append(f"WALKERS = {mcmc.walkers}")
    if mcmc.seed is not None:
        lines.append(f"SEED = {mcmc.seed}")
    if mcmc.workers is not None:
        lines.append(f"WORKERS = {mcmc.workers}")
    if mcmc.update_parameters:
        lines.append("UPDATE_PARAMETERS = true")
    return "\n".join(lines)


def emit_method_toml(config: MethodConfigModel) -> str:
    """
    Serializes a MethodConfigModel into a deterministic ChemEx v1 method.toml string.

    Hard guarantee: When statistics are disabled on all steps, the emitted output
    contains NO statistics keys, subtables, or empty tables.
    """
    if config.raw_override and config.raw_override.strip():
        return config.raw_override

    sections: List[str] = []

    for step in config.steps:
        lines: List[str] = []
        step_name = (step.name or "STEP1").strip().upper()
        lines.append(f"[{step_name}]")

        # 1. FIT
        fit_params = [p for p in step.parameters if p.mode == "fit"]
        if fit_params:
            names = ", ".join(f'"{p.name.upper()}"' for p in fit_params)
            lines.append(f"FIT = [{names}]")

        # 2. FIX
        fix_params = [p for p in step.parameters if p.mode == "fix"]
        if fix_params:
            names = ", ".join(f'"{p.name.upper()}"' for p in fix_params)
            lines.append(f"FIX = [{names}]")

        # 3. CONSTRAINTS
        constraint_list: List[str] = []
        for p in fit_params:
            if p.bounds and p.bounds.strip():
                b = p.bounds.strip()
                if b.startswith("[") or b.upper().startswith(p.name.upper()):
                    constraint_list.append(b)
                else:
                    constraint_list.append(f"[{p.name.upper()}] {b}")

        constrain_params = [p for p in step.parameters if p.mode == "constrain"]
        for p in constrain_params:
            if p.expression and p.expression.strip():
                expr = p.expression.strip()
                if "=" in expr:
                    constraint_list.append(expr)
                else:
                    constraint_list.append(f"[{p.name.upper()}] = {expr}")

        if len(constraint_list) == 1:
            clean_c = constraint_list[0].replace('"', '')
            lines.append(f'CONSTRAINTS = ["{clean_c}"]')
        elif len(constraint_list) > 1:
            clean_items = [c.replace('"', '') for c in constraint_list]
            formatted = ",\n".join(f'  "{c}"' for c in clean_items)
            lines.append(f"CONSTRAINTS = [\n{formatted}\n]")

        # 4. GRID
        grid_params = [p for p in step.parameters if p.mode == "grid" and p.grid]
        if grid_params:
            grid_items: list[str] = []
            for p in grid_params:
                g = p.grid
                scale = str(g.get("scale", "lin")).lower()
                fn = "log" if scale == "log" else "lin"
                p_name = p.name.upper()
                p_formatted = p_name if p_name.startswith("[") else f"[{p_name}]"
                min_val = g.get("min", 0.0)
                max_val = g.get("max", 1.0)
                steps_val = g.get("steps", 10)
                grid_items.append(f'"{p_formatted} = {fn}({min_val}, {max_val}, {steps_val})"')
            if len(grid_items) == 1:
                lines.append(f"GRID = [{grid_items[0]}]")
            elif len(grid_items) > 1:
                formatted_items = ",\n".join(f"  {item}" for item in grid_items)
                lines.append(f"GRID = [\n{formatted_items}\n]")

        # 5. INCLUDE / EXCLUDE
        if step.residues:
            formatted_items = []
            for r in step.residues:
                if isinstance(r, int) or (isinstance(r, str) and r.isdigit()):
                    formatted_items.append(str(r))
                elif isinstance(r, str) and r.upper() in ["*", "ALL"]:
                    formatted_items.append('"ALL"')
                else:
                    formatted_items.append(f'"{r}"')

            res_str = ", ".join(formatted_items)
            if step.residue_mode == "include":
                lines.append(f"INCLUDE = [{res_str}]")
            elif step.residue_mode == "exclude":
                lines.append(f"EXCLUDE = [{res_str}]")

        # 6. STATISTICS (v1 ChemEx schema)
        stats = step.statistics
        mcmc_subtable_content = None

        if stats and not stats.is_empty():
            inline_parts: List[str] = []
            if stats.mc is not None:
                inline_parts.append(f'"MC" = {stats.mc}')
            if stats.bs is not None:
                inline_parts.append(f'"BS" = {stats.bs}')
            if stats.bsn is not None:
                inline_parts.append(f'"BSN" = {stats.bsn}')

            if stats.mcmc is not None:
                if isinstance(stats.mcmc, int):
                    inline_parts.append(f'"MCMC" = {stats.mcmc}')
                elif isinstance(stats.mcmc, McmcSettingsModel):
                    m = stats.mcmc
                    is_simple = (
                        m.burn == "auto"
                        and m.thin == 1
                        and m.walkers is None
                        and m.seed is None
                        and m.workers is None
                        and not m.update_parameters
                    )
                    if is_simple and not inline_parts:
                        inline_parts.append(f'"MCMC" = {m.steps}')
                    elif is_simple and inline_parts:
                        inline_parts.append(f'"MCMC" = {m.steps}')
                    else:
                        mcmc_subtable_content = _format_mcmc_subtable(m, step_name)

            if inline_parts:
                lines.append(f"STATISTICS = {{ {', '.join(inline_parts)} }}")

        sections.append("\n".join(lines))

        if mcmc_subtable_content:
            sections.append(mcmc_subtable_content)

    return "\n\n".join(sections) + "\n"


def parse_method_toml(toml_str: str) -> MethodConfigModel:
    """
    Parses a ChemEx v1 method.toml string into a MethodConfigModel.
    Handles section names, parameters (FIT, FIX, CONSTRAINTS, GRID, INCLUDE, EXCLUDE),
    and STATISTICS in inline or subtable forms.
    """
    if not toml_str or not toml_str.strip():
        return MethodConfigModel(steps=[MethodStepModel(name="STEP1")])

    try:
        parsed_dict = tomllib.loads(toml_str)
    except Exception:
        return MethodConfigModel(steps=[MethodStepModel(name="STEP1")], raw_override=toml_str)

    steps: List[MethodStepModel] = []

    for section_name, section_data in parsed_dict.items():
        if not isinstance(section_data, dict):
            continue

        step_name = section_name.upper()

        params: List[ParamSettingModel] = []
        residue_mode: Literal["include", "exclude"] = "include"
        residues: List[Union[int, str]] = []
        statistics: Optional[StatisticsModel] = None

        # 1. FIT
        fit_list = section_data.get("FIT", section_data.get("fit", []))
        if isinstance(fit_list, list):
            for item in fit_list:
                params.append(ParamSettingModel(name=str(item).upper(), mode="fit"))

        # 2. FIX
        fix_list = section_data.get("FIX", section_data.get("fix", []))
        if isinstance(fix_list, list):
            for item in fix_list:
                params.append(ParamSettingModel(name=str(item).upper(), mode="fix"))

        # 3. CONSTRAINTS
        constraints = section_data.get("CONSTRAINTS", section_data.get("constraints", []))
        if isinstance(constraints, str):
            constraints = [constraints]
        if isinstance(constraints, list):
            for c in constraints:
                c_str = str(c).strip()
                bound_match = re.match(r'^(?:\[([A-Za-z0-9_]+)\]|([A-Za-z0-9_]+))\s*([<>]=?\s*[\d.eE+-]+)$', c_str, re.I)
                if bound_match:
                    pname = (bound_match.group(1) or bound_match.group(2)).upper()
                    bound_part = bound_match.group(3).strip()
                    existing = next((p for p in params if p.name == pname), None)
                    if existing:
                        existing.bounds = bound_part
                    else:
                        params.append(ParamSettingModel(name=pname, mode="fit", bounds=bound_part))
                    continue

                expr_match = re.match(r'^(?:\[([A-Za-z0-9_]+)\]|([A-Za-z0-9_]+))\s*=\s*(.+)$', c_str, re.I)
                if expr_match:
                    pname = (expr_match.group(1) or expr_match.group(2)).upper()
                    expression = expr_match.group(3).strip()
                    existing = next((p for p in params if p.name == pname), None)
                    if existing:
                        existing.mode = "constrain"
                        existing.expression = expression
                    else:
                        params.append(ParamSettingModel(name=pname, mode="constrain", expression=expression))
                    continue

        # 4. GRID
        grid_data = section_data.get("GRID", section_data.get("grid"))
        if grid_data is not None:
            if isinstance(grid_data, str):
                grid_data = [grid_data]
            if isinstance(grid_data, list):
                for g_item in grid_data:
                    g_str = str(g_item).strip().strip('"').strip("'")
                    func_match = re.match(
                        r'^(?:\[([A-Za-z0-9_]+)\]|([A-Za-z0-9_]+))\s*=\s*(log|lin)\s*\(\s*([\d.eE+-]+)\s*,\s*([\d.eE+-]+)\s*,\s*(\d+)\s*\)$',
                        g_str,
                        re.I,
                    )
                    if func_match:
                        pname = (func_match.group(1) or func_match.group(2)).upper()
                        scale = "log" if func_match.group(3).lower() == "log" else "lin"
                        min_v = float(func_match.group(4))
                        max_v = float(func_match.group(5))
                        steps_v = int(func_match.group(6))
                        params.append(
                            ParamSettingModel(
                                name=pname,
                                mode="grid",
                                grid={"min": min_v, "max": max_v, "steps": steps_v, "scale": scale},
                            )
                        )
                        continue

                    arr_match = re.match(
                        r'^(?:\[([A-Za-z0-9_]+)\]|([A-Za-z0-9_]+))\s*=\s*\[\s*([\d.eE+-]+)\s*,\s*([\d.eE+-]+)\s*,\s*(\d+)\s*\]$',
                        g_str,
                        re.I,
                    )
                    if arr_match:
                        pname = (arr_match.group(1) or arr_match.group(2)).upper()
                        min_v = float(arr_match.group(3))
                        max_v = float(arr_match.group(4))
                        steps_v = int(arr_match.group(5))
                        params.append(
                            ParamSettingModel(
                                name=pname,
                                mode="grid",
                                grid={"min": min_v, "max": max_v, "steps": steps_v, "scale": "lin"},
                            )
                        )
                        continue
            elif isinstance(grid_data, dict):
                for pname, gval in grid_data.items():
                    if isinstance(gval, list) and len(gval) >= 3:
                        params.append(
                            ParamSettingModel(
                                name=str(pname).upper(),
                                mode="grid",
                                grid={"min": float(gval[0]), "max": float(gval[1]), "steps": int(gval[2]), "scale": "lin"},
                            )
                        )

        # 5. INCLUDE / EXCLUDE
        include_data = section_data.get("INCLUDE", section_data.get("include"))
        exclude_data = section_data.get("EXCLUDE", section_data.get("exclude"))
        if include_data is not None:
            residue_mode = "include"
            if isinstance(include_data, list):
                residues = include_data
            elif isinstance(include_data, (str, int)):
                residues = [include_data]
        elif exclude_data is not None:
            residue_mode = "exclude"
            if isinstance(exclude_data, list):
                residues = exclude_data
            elif isinstance(exclude_data, (str, int)):
                residues = [exclude_data]

        # 6. STATISTICS
        stat_data = section_data.get("STATISTICS", section_data.get("statistics"))
        if isinstance(stat_data, dict):
            stat_norm: Dict[str, Any] = {}
            for sk, sv in stat_data.items():
                sk_lower = sk.lower()
                if sk_lower in ["mc", "bs", "bsn"]:
                    try:
                        stat_norm[sk_lower] = int(sv)
                    except (ValueError, TypeError):
                        pass
                elif sk_lower == "mcmc":
                    if isinstance(sv, (int, str)) and str(sv).isdigit():
                        stat_norm["mcmc"] = int(sv)
                    elif isinstance(sv, dict):
                        mcmc_norm = {mk.lower(): mv for mk, mv in sv.items()}
                        try:
                            stat_norm["mcmc"] = McmcSettingsModel(**mcmc_norm)
                        except Exception:
                            pass
            if stat_norm:
                statistics = StatisticsModel(**stat_norm)

        steps.append(
            MethodStepModel(
                name=step_name,
                parameters=params,
                residue_mode=residue_mode,
                residues=residues,
                statistics=statistics,
            )
        )

    if not steps:
        steps.append(MethodStepModel(name="STEP1"))

    return MethodConfigModel(steps=steps)


def validate_method_config(
    config: MethodConfigModel,
    available_params: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    """
    Performs server-side validation on a MethodConfigModel.
    Returns a list of actionable issue dicts compatible with resoFlow UI:
    [
      {
        "id": str,
        "stepIndex": int,
        "stepName": str,
        "field": str,
        "severity": "error" | "warning",
        "message": str
      }
    ]
    """
    issues: List[Dict[str, Any]] = []

    if not config.steps:
        issues.append({
            "id": "empty-config",
            "stepIndex": -1,
            "stepName": "",
            "field": "steps",
            "severity": "error",
            "message": "Method configuration must contain at least one step.",
        })
        return issues

    for idx, step in enumerate(config.steps):
        step_label = step.name or f"STEP{idx + 1}"

        # 1. Parameter conflict validation
        fit_params = [p for p in step.parameters if p.mode == "fit"]
        grid_params = [p for p in step.parameters if p.mode == "grid"]

        # 2. Statistics validation
        if step.statistics and not step.statistics.is_empty():
            stats = step.statistics

            # Check grid + statistics conflict
            if grid_params:
                issues.append({
                    "id": f"step-{idx}-grid-statistics-conflict",
                    "stepIndex": idx,
                    "stepName": step_label,
                    "field": "statistics",
                    "severity": "warning",
                    "message": f"Step '{step_label}' has both GRID search and STATISTICS enabled. ChemEx will disable statistics for steps performing grid search.",
                })

            # Check replicate counts
            for stype, count in [("MC", stats.mc), ("BS", stats.bs), ("BSN", stats.bsn)]:
                if count is not None:
                    if count < 1:
                        issues.append({
                            "id": f"step-{idx}-{stype.lower()}-count",
                            "stepIndex": idx,
                            "stepName": step_label,
                            "field": f"statistics.{stype.lower()}",
                            "severity": "error",
                            "message": f"{stype} replicate count must be a positive integer (>= 1). Got {count}.",
                        })
                    elif count > 10000:
                        issues.append({
                            "id": f"step-{idx}-{stype.lower()}-high-count",
                            "stepIndex": idx,
                            "stepName": step_label,
                            "field": f"statistics.{stype.lower()}",
                            "severity": "warning",
                            "message": f"{stype} replicate count ({count}) is very high and will require significant compute time ({count} full refits).",
                        })

            # Check MCMC
            if stats.mcmc is not None:
                if isinstance(stats.mcmc, int):
                    if stats.mcmc < 1:
                        issues.append({
                            "id": f"step-{idx}-mcmc-steps",
                            "stepIndex": idx,
                            "stepName": step_label,
                            "field": "statistics.mcmc.steps",
                            "severity": "error",
                            "message": f"MCMC steps must be a positive integer (>= 1). Got {stats.mcmc}.",
                        })
                elif isinstance(stats.mcmc, McmcSettingsModel):
                    m = stats.mcmc
                    if m.steps < 1:
                        issues.append({
                            "id": f"step-{idx}-mcmc-steps",
                            "stepIndex": idx,
                            "stepName": step_label,
                            "field": "statistics.mcmc.steps",
                            "severity": "error",
                            "message": f"MCMC steps must be a positive integer (>= 1). Got {m.steps}.",
                        })

                    burn_val = 0 if m.burn == "auto" else m.burn
                    if burn_val < 0:
                        issues.append({
                            "id": f"step-{idx}-mcmc-burn-neg",
                            "stepIndex": idx,
                            "stepName": step_label,
                            "field": "statistics.mcmc.burn",
                            "severity": "error",
                            "message": "MCMC burn must be non-negative (>= 0) or 'auto'.",
                        })
                    elif burn_val >= m.steps:
                        issues.append({
                            "id": f"step-{idx}-mcmc-burn-ge-steps",
                            "stepIndex": idx,
                            "stepName": step_label,
                            "field": "statistics.mcmc.burn",
                            "severity": "error",
                            "message": f"MCMC burn ({burn_val}) must be smaller than total steps ({m.steps}).",
                        })

                    if m.thin < 1:
                        issues.append({
                            "id": f"step-{idx}-mcmc-thin",
                            "stepIndex": idx,
                            "stepName": step_label,
                            "field": "statistics.mcmc.thin",
                            "severity": "error",
                            "message": f"MCMC thin must be a positive integer (>= 1). Got {m.thin}.",
                        })
                    elif burn_val < m.steps and (m.steps - burn_val) // m.thin < 1:
                        issues.append({
                            "id": f"step-{idx}-mcmc-retained-zero",
                            "stepIndex": idx,
                            "stepName": step_label,
                            "field": "statistics.mcmc.thin",
                            "severity": "error",
                            "message": f"MCMC settings retain 0 samples with steps={m.steps}, burn={burn_val}, thin={m.thin}. Decrease thin or increase steps.",
                        })

                    if m.walkers is not None:
                        if m.walkers < 1:
                            issues.append({
                                "id": f"step-{idx}-mcmc-walkers",
                                "stepIndex": idx,
                                "stepName": step_label,
                                "field": "statistics.mcmc.walkers",
                                "severity": "error",
                                "message": f"MCMC walkers must be a positive integer (>= 1). Got {m.walkers}.",
                            })
                        elif fit_params and m.walkers < 2 * len(fit_params):
                            issues.append({
                                "id": f"step-{idx}-mcmc-walkers-bound",
                                "stepIndex": idx,
                                "stepName": step_label,
                                "field": "statistics.mcmc.walkers",
                                "severity": "error",
                                "message": f"MCMC walkers ({m.walkers}) must be at least 2x number of fitted parameters (2 * {len(fit_params)} = {2 * len(fit_params)}).",
                            })

                    if m.workers is not None and m.workers < 1:
                        issues.append({
                            "id": f"step-{idx}-mcmc-workers",
                            "stepIndex": idx,
                            "stepName": step_label,
                            "field": "statistics.mcmc.workers",
                            "severity": "error",
                            "message": f"MCMC workers must be a positive integer (>= 1). Got {m.workers}.",
                        })

    return issues
