"""
ChemEx method TOML emitter and parser — the backend half of the ChemEx method
contract (mirror: frontend/src/lib/methodToml.ts; byte parity pinned by
tests/test_method_emit_contract.py). Validation is ChemEx's own, via
services/fitting/method_resolution.validate_method_for_analysis.

Canonical output is ChemEx v2 (``FORMAT_VERSION = 2``):
https://gbouvignies.github.io/ChemEx/docs/user_guide/fitting/method_files

A step's effective roles are, in order: baseline roles (or ``ROLES_FROM``),
the per-parameter table (plain-name CONSTRAIN → FIX → FIT), then the ordered
selector-level ``role_rules``. An optional ``search`` (GRID or DE) and
``statistics`` follow. Legacy v1 files are parsed and migrated explicitly
(implicit carry-over → ``ROLES_FROM`` + repeated selection). The v1 emitter
is kept only for callers that explicitly request ``format_version=1``.
"""

from __future__ import annotations

import json
import math
import re
import sys
import uuid
from typing import Annotated, Any, Dict, List, Literal, Optional, Tuple, Union

if sys.version_info >= (3, 11):
    import tomllib
else:
    import tomli as tomllib

from pydantic import (
    AliasChoices,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    PlainSerializer,
    field_validator,
    model_validator,
)

MAX_SEED = (1 << 64) - 1


def _coerce_seed(value: Any) -> Any:
    """Accept a ChemEx SEED as int or canonical decimal string; enforce unsigned 64-bit.

    The frontend carries seeds as decimal strings because JS numbers lose precision
    above 2**53. ``None`` passes through (seed omitted).
    """
    if value is None:
        return None
    if isinstance(value, bool):
        raise ValueError("SEED must be an unsigned 64-bit integer, not a boolean")
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        if not text.isdigit():
            raise ValueError(f"SEED must be an unsigned 64-bit integer (got {value!r})")
        value = int(text)
    if not isinstance(value, int):
        raise ValueError(f"SEED must be an unsigned 64-bit integer (got {value!r})")
    if not 0 <= value <= MAX_SEED:
        raise ValueError(f"SEED must be between 0 and {MAX_SEED} (got {value})")
    return value


#: Optional unsigned 64-bit seed: validated as int (``None``/``""`` = omitted) and
#: serialised to JSON as a decimal string so browsers never round it through a float.
U64Seed = Annotated[
    Optional[int],
    BeforeValidator(_coerce_seed),
    PlainSerializer(lambda v: None if v is None else str(v), return_type=Optional[str], when_used="json"),
]


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
    seed: U64Seed = Field(default=None, description="Unsigned 64-bit random seed for reproducibility")
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


class ResamplingSettingsModel(BaseModel):
    """Expanded MC/BS/BSN request (v2: REPLICATES + optional SEED)."""

    model_config = ConfigDict(extra="ignore")

    replicates: int
    seed: U64Seed = None

    @field_validator("replicates")
    @classmethod
    def validate_replicates(cls, v: int) -> int:
        if v < 1:
            raise ValueError("Replicate count must be a positive integer (>= 1)")
        return v


Resampling = Union[int, ResamplingSettingsModel]


def _replicates(v: Optional[Resampling]) -> Optional[int]:
    if v is None:
        return None
    return v.replicates if isinstance(v, ResamplingSettingsModel) else int(v)


def _resampling_seed(v: Optional[Resampling]) -> Optional[int]:
    return v.seed if isinstance(v, ResamplingSettingsModel) else None


class StatisticsModel(BaseModel):
    model_config = ConfigDict(extra="ignore")

    mc: Optional[Resampling] = Field(default=None, description="Monte Carlo replicates (or expanded request)")
    bs: Optional[Resampling] = Field(default=None, description="Bootstrap replicates (or expanded request)")
    bsn: Optional[Resampling] = Field(default=None, description="Nucleus-specific bootstrap replicates (or expanded request)")
    mcmc: Optional[Union[int, McmcSettingsModel]] = Field(
        default=None,
        description="MCMC chain length or detailed McmcSettingsModel",
    )

    @field_validator("mc", "bs", "bsn", mode="before")
    @classmethod
    def parse_resampling(cls, v: Any, info) -> Optional[Resampling]:
        if v is None:
            return None
        if isinstance(v, dict):
            lower = {str(k).lower(): val for k, val in v.items()}
            if "enabled" in lower and not lower.get("enabled"):
                return None
            reps = lower.get("replicates")
            if reps is None:
                raise ValueError(f"Expanded {info.field_name.upper()} request requires REPLICATES")
            if int(reps) < 1:
                raise ValueError(f"Replicate count for {info.field_name.upper()} must be a positive integer (>= 1)")
            seed = _coerce_seed(lower.get("seed"))
            if seed is None:
                return int(reps)
            return ResamplingSettingsModel(replicates=int(reps), seed=seed)
        if isinstance(v, int) and not isinstance(v, bool):
            if v < 1:
                raise ValueError(f"Replicate count for {info.field_name.upper()} must be a positive integer (>= 1)")
            return v
        return v

    @field_validator("mcmc", mode="before")
    @classmethod
    def parse_mcmc(cls, v: Any) -> Optional[Union[int, McmcSettingsModel]]:
        if v is None:
            return None
        if isinstance(v, int) and not isinstance(v, bool):
            if v < 1:
                raise ValueError("MCMC steps must be a positive integer (>= 1)")
            return v
        if isinstance(v, dict):
            lower_dict = {k.lower(): val for k, val in v.items()}
            if "enabled" in lower_dict and not lower_dict.pop("enabled"):
                return None
            return McmcSettingsModel(**lower_dict)
        return v

    def is_empty(self) -> bool:
        return self.mc is None and self.bs is None and self.bsn is None and self.mcmc is None


class ParamSettingModel(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str
    mode: Literal["default", "fit", "fix", "constrain", "grid"] = "default"
    value: Optional[float] = None
    bounds: Optional[str] = None  # legacy v1 inequality; never emitted in v2
    expression: Optional[str] = None
    grid: Optional[Dict[str, Any]] = None  # legacy per-parameter grid; migrated to search


class SearchAxisModel(BaseModel):
    """One GRID axis or DE coordinate."""

    model_config = ConfigDict(extra="ignore")

    id: Optional[str] = None
    param: str
    qualifier: Optional[str] = None
    fn: Literal["lin", "log", "values"] = "lin"
    low: float = 0.0
    high: float = 1.0
    count: int = 0
    values: Optional[List[float]] = None


class StepSearchModel(BaseModel):
    model_config = ConfigDict(extra="ignore")

    mode: Literal["none", "grid", "de"] = "none"
    axes: List[SearchAxisModel] = Field(default_factory=list)
    seed: U64Seed = None


class RoleRuleModel(BaseModel):
    """One ordered ROLES action (selectors for FIT/FIX, equations for CONSTRAIN)."""

    model_config = ConfigDict(extra="ignore")

    id: Optional[str] = None
    action: Literal["FIT", "FIX", "CONSTRAIN"]
    entries: List[str] = Field(default_factory=list)


class MethodStepModel(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    id: Optional[str] = None
    name: str = "STEP1"
    parameters: List[ParamSettingModel] = Field(default_factory=list)
    # "all": no INCLUDE/EXCLUDE. "include"/"exclude" are always written (an empty INCLUDE stays visible).
    residue_mode: Literal["all", "include", "exclude"] = Field(
        default="all", validation_alias=AliasChoices("residue_mode", "residueMode")
    )
    residues: List[Union[int, str]] = Field(default_factory=list)
    # ROLES_FROM target by step id (authoritative) and its last known name (legacy / dangling fallback).
    roles_from_step_id: Optional[str] = Field(
        default=None, validation_alias=AliasChoices("roles_from_step_id", "rolesFromStepId")
    )
    roles_from: Optional[str] = Field(default=None, validation_alias=AliasChoices("roles_from", "rolesFrom"))
    role_rules: List[RoleRuleModel] = Field(
        default_factory=list, validation_alias=AliasChoices("role_rules", "roleRules")
    )
    search: Optional[StepSearchModel] = None
    statistics: Optional[StatisticsModel] = None

    @model_validator(mode="after")
    def _default_mode_for_given_residues(self) -> "MethodStepModel":
        # Python callers that pass residues without a mode mean INCLUDE (the pre-"all" default).
        if "residue_mode" not in self.model_fields_set and self.residues:
            self.residue_mode = "include"
        return self


class MethodConfigModel(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    steps: List[MethodStepModel] = Field(default_factory=list)
    raw_override: Optional[str] = Field(default=None, validation_alias=AliasChoices("raw_override", "rawOverride"))


def normalize_step(step: MethodStepModel) -> MethodStepModel:
    """Migrate legacy per-parameter 'grid' modes into FIT + a GRID search axis (idempotent)."""
    legacy = [p for p in step.parameters if p.mode == "grid"]
    if not legacy:
        return step
    axes = list(step.search.axes) if step.search else []
    for p in legacy:
        g = p.grid or {}
        if any(a.param.upper() == p.name.upper() and not a.qualifier for a in axes):
            continue
        axes.append(
            SearchAxisModel(
                param=p.name.upper(),
                fn="log" if str(g.get("scale", "lin")).lower() == "log" else "lin",
                low=float(g.get("min", 0.01)),
                high=float(g.get("max", 0.2)),
                count=int(g.get("steps", 10)),
            )
        )
    params = [ParamSettingModel(name=p.name, mode="fit") if p.mode == "grid" else p for p in step.parameters]
    seed = step.search.seed if step.search else None
    return step.model_copy(update={"parameters": params, "search": StepSearchModel(mode="grid", axes=axes, seed=seed)})


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


def emit_method_toml_v1(config: MethodConfigModel) -> str:
    """
    Legacy: serializes a MethodConfigModel into a deterministic ChemEx v1 method.toml string.

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
        grid_items: list[str] = []
        if step.search and step.search.mode == "grid":
            for a in step.search.axes:
                if a.fn == "values":
                    grid_items.append(_q(f"[{axis_selector(a)}] = ({', '.join(_num(v) for v in (a.values or []))})"))
                else:
                    grid_items.append(_q(format_axis(a, "grid")))
        if grid_params or grid_items:
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
                inline_parts.append(f'"MC" = {_replicates(stats.mc)}')
            if stats.bs is not None:
                inline_parts.append(f'"BS" = {_replicates(stats.bs)}')
            if stats.bsn is not None:
                inline_parts.append(f'"BSN" = {_replicates(stats.bsn)}')

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


# ── v2 emission ─────────────────────────────────────────────────────────

def _q(s: str) -> str:
    """TOML basic string (JSON escapes are valid TOML basic-string escapes)."""
    return json.dumps(s, ensure_ascii=False)


def _num(x: float) -> str:
    """Format a number like JS ``String(x)`` for the common cases (100 → "100", 0.005 → "0.005")."""
    if not math.isfinite(x):
        return "0"
    if float(x).is_integer() and abs(x) < 1e21:
        return str(int(x))
    return re.sub(r"e([+-])0*(\d)", r"e\1\2", repr(float(x)))


def axis_selector(axis: SearchAxisModel) -> str:
    base = axis.param.strip().upper().strip("[]")
    qual = re.sub(r"^,\s*", "", (axis.qualifier or "").strip())
    return f"{base}, {qual}" if qual else base


def format_axis(axis: SearchAxisModel, mode: str) -> str:
    sel = f"[{axis_selector(axis)}]"
    if mode == "grid" and axis.fn == "values":
        return f"{sel} = values({', '.join(_num(v) for v in (axis.values or []))})"
    fn = "log" if axis.fn == "log" else "lin"
    if mode == "de":
        return f"{sel} = {fn}({_num(axis.low)}, {_num(axis.high)})"
    return f"{sel} = {fn}({_num(axis.low)}, {_num(axis.high)}, {int(axis.count)})"


_FULL_EQUATION = re.compile(r"^\s*\[[^\]]+\]\s*=")


def _constraint_entry(p: ParamSettingModel) -> Optional[str]:
    expr = (p.expression or "").strip()
    if not expr:
        return None
    if _FULL_EQUATION.match(expr):
        return expr
    return f"[{p.name.upper()}] = {expr}"


def step_role_actions(step: MethodStepModel) -> List[Tuple[str, List[str]]]:
    """Ordered ROLES actions for a step: table (CONSTRAIN → FIX → FIT), then explicit rules.

    Search targets are never added to FIT implicitly (GRID/DE do not change roles).
    """
    step = normalize_step(step)
    actions: List[Tuple[str, List[str]]] = []

    constrain = [e for e in (_constraint_entry(p) for p in step.parameters if p.mode == "constrain") if e]
    if constrain:
        actions.append(("CONSTRAIN", constrain))
    fix = [p.name.upper() for p in step.parameters if p.mode == "fix"]
    if fix:
        actions.append(("FIX", fix))
    fit = [p.name.upper() for p in step.parameters if p.mode in ("fit", "grid")]
    if fit:
        actions.append(("FIT", fit))
    for rule in step.role_rules:
        entries = [e.strip() for e in rule.entries if e.strip()]
        if entries:
            actions.append((rule.action, entries))
    return actions


_BARE_KEY = re.compile(r"^[A-Za-z0-9_-]+$")


def step_display_name(step: MethodStepModel, idx: int) -> str:
    """Name as emitted: trimmed, case preserved (ChemEx compares ROLES_FROM case-sensitively)."""
    return (step.name or "").strip() or f"STEP{idx + 1}"


def toml_key(name: str) -> str:
    """Bare TOML key when possible, else a quoted basic string (as ChemEx renders)."""
    return name if _BARE_KEY.match(name) else _q(name)


def roles_from_name(steps: List[MethodStepModel], idx: int) -> Optional[str]:
    """ROLES_FROM name to emit: the id target's current name; a dangling or name-only
    reference keeps its last known name so the problem stays visible."""
    step = steps[idx]
    last = (step.roles_from or "").strip() or None
    if step.roles_from_step_id:
        for j, other in enumerate(steps):
            if other.id == step.roles_from_step_id:
                return step_display_name(other, j)
        return last
    return last


def _format_residue(r: Union[int, str]) -> str:
    s = str(r).strip()
    return s if s.isdigit() else _q(s)


def compact_statistics(stats: Optional[StatisticsModel]) -> Optional[str]:
    """``MC = 100, BS = 100, BSN = 100, MCMC = 5000``, or None when a request carries a
    SEED or BURN (then every request uses expanded tables) or nothing is requested."""
    if stats is None or stats.is_empty():
        return None
    parts: List[str] = []
    for key, val in (("MC", stats.mc), ("BS", stats.bs), ("BSN", stats.bsn)):
        reps = _replicates(val)
        if not reps:
            continue
        if _resampling_seed(val) is not None:
            return None
        parts.append(f"{key} = {reps}")
    m = stats.mcmc
    if m is not None:
        if isinstance(m, McmcSettingsModel):
            if isinstance(m.burn, int) or m.seed is not None:
                return None
            parts.append(f"MCMC = {m.steps}")
        else:
            parts.append(f"MCMC = {int(m)}")
    return ", ".join(parts) or None


#: Model constants no method action may target (ChemEx rejects them; .tc reference temperature).
PROTECTED_METHOD_TARGETS = frozenset({"TREF"})


class ProtectedTargetError(ValueError):
    """A method step targets a protected model constant (e.g. TREF) with FIT/FIX/CONSTRAIN/GRID/DE."""


def _target_name(entry: str) -> str:
    """Parameter name an action entry targets: "[DW_AB, NUC->3N] = …" / "KEX_AB, B0->600MHz" → name."""
    head = re.split(r"[,=]", entry.strip(), maxsplit=1)[0]
    return head.strip().strip("[]").strip().upper()


def reject_protected_targets(config: MethodConfigModel) -> None:
    """Raise ProtectedTargetError if any step targets TREF (or another protected constant)."""
    for idx, step in enumerate(config.steps):
        name = step_display_name(step, idx)
        for action, entries in step_role_actions(step):
            for entry in entries:
                target = _target_name(entry)
                if target in PROTECTED_METHOD_TARGETS:
                    raise ProtectedTargetError(
                        f"{target} is a protected model constant (step {name!r}, {action}): it cannot be a "
                        f"FIT/FIX/CONSTRAIN/GRID/DE target. Set its scalar value in [GLOBAL] of parameters.toml."
                    )
        search = step.search
        if search and search.mode != "none":
            for axis in search.axes:
                if axis.param.strip().upper() in PROTECTED_METHOD_TARGETS:
                    raise ProtectedTargetError(
                        f"{axis.param.strip().upper()} is a protected model constant (step {name!r}, "
                        f"{search.mode.upper()} axis): it cannot be searched."
                    )


def emit_method_toml_v2(config: MethodConfigModel) -> str:
    """Serializes a MethodConfigModel into canonical ChemEx v2 method.toml (FORMAT_VERSION = 2)."""
    if config.raw_override and config.raw_override.strip():
        return config.raw_override  # verbatim; ChemEx itself rejects protected targets here
    reject_protected_targets(config)

    lines: List[str] = ["FORMAT_VERSION = 2"]

    for idx, raw_step in enumerate(config.steps):
        step = normalize_step(raw_step)
        name = toml_key(step_display_name(step, idx))
        lines += ["", f"[{name}]"]

        residues = [str(r).strip() for r in step.residues if str(r).strip()]
        if step.residue_mode != "all":
            key = "EXCLUDE" if step.residue_mode == "exclude" else "INCLUDE"
            is_all = len(residues) == 1 and residues[0].upper() in ("ALL", "*")
            value = '"ALL"' if is_all else "[" + ", ".join(_format_residue(r) for r in residues) + "]"
            lines.append(f"{key} = {value}")

        rf = roles_from_name(config.steps, idx)
        if rf:
            lines.append(f"ROLES_FROM = {_q(rf)}")

        actions = step_role_actions(step)
        if actions:
            lines.append("ROLES = [")
            for action, entries in actions:
                lines.append(f"  {{ {action} = [{', '.join(_q(e) for e in entries)}] }},")
            lines.append("]")

        # Compact STATISTICS = { ... } lives in the step table, i.e. before any sub-table header.
        compact_stats = compact_statistics(step.statistics)
        if compact_stats:
            lines.append(f"STATISTICS = {{ {compact_stats} }}")

        search = step.search
        if search and search.mode != "none" and search.axes:
            if search.mode == "grid":
                lines += ["", f"[{name}.SEARCH.GRID]", "AXES = ["]
                lines += [f"  {_q(format_axis(a, 'grid'))}," for a in search.axes]
                lines.append("]")
            else:
                lines += ["", f"[{name}.SEARCH.DE]"]
                if search.seed is not None:
                    lines.append(f"SEED = {int(search.seed)}")
                lines.append("COORDINATES = [")
                lines += [f"  {_q(format_axis(a, 'de'))}," for a in search.axes]
                lines.append("]")

        stats = step.statistics
        if stats and not stats.is_empty() and not compact_stats:
            for key, val in (("MC", stats.mc), ("BS", stats.bs), ("BSN", stats.bsn)):
                reps = _replicates(val)
                if reps:
                    lines += ["", f"[{name}.STATISTICS.{key}]", f"REPLICATES = {reps}"]
                    seed = _resampling_seed(val)
                    if seed is not None:
                        lines.append(f"SEED = {seed}")
            if stats.mcmc is not None:
                m = stats.mcmc
                steps_n = m if isinstance(m, int) else m.steps
                lines += ["", f"[{name}.STATISTICS.MCMC]", f"STEPS = {steps_n}"]
                if isinstance(m, McmcSettingsModel):
                    if isinstance(m.burn, int):
                        lines.append(f"BURN = {m.burn}")
                    if m.seed is not None:
                        lines.append(f"SEED = {m.seed}")

    return "\n".join(lines) + "\n"


def emit_method_toml(config: MethodConfigModel, format_version: int = 2) -> str:
    """
    Serializes a MethodConfigModel into a ChemEx method.toml string.
    By default (format_version=2), emits canonical ChemEx v2 format.
    If format_version=1 is specified, emits classic v1 format.
    """
    if format_version == 1:
        return emit_method_toml_v1(config)
    return emit_method_toml_v2(config)


# ── Parsing ─────────────────────────────────────────────────────────────

_SIMPLE_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_PLAIN_CONSTRAINT = re.compile(r"^\s*\[\s*([A-Za-z_][A-Za-z0-9_]*)\s*\]\s*=\s*(.+)$", re.S)
_BOUND_CONSTRAINT = re.compile(r"^\s*\[?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\]?\s*(<=?|>=?)\s*[-+.\deE]+\s*$")
_AXIS = re.compile(r"^\s*\[?([^\]=]+?)\]?\s*=\s*([A-Za-z_]*)\s*[(\[]\s*([^)\]]*)[)\]]\s*$")


def _get(table: Any, key: str) -> Any:
    if not isinstance(table, dict):
        return None
    for k, v in table.items():
        if str(k).upper() == key.upper():
            return v
    return None


def _str_list(v: Any) -> List[str]:
    if v is None:
        return []
    if isinstance(v, list):
        return [str(x) for x in v]
    return [str(v)]


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


def parse_axis_string(text: str, legacy_array_is_range: bool = False) -> Optional[SearchAxisModel]:
    """Parse "[SEL] = fn(...)", legacy bare tuple "(a, b, c)", or legacy "[min, max, n]" (v1 GRID)."""
    m = _AXIS.match(text.strip().strip('"').strip("'"))
    if not m:
        return None
    selector, fn, args_s = m.group(1).strip(), m.group(2).lower(), m.group(3)
    try:
        args = [float(a) for a in args_s.split(",") if a.strip()]
    except ValueError:
        return None
    if not args or not all(math.isfinite(a) for a in args):
        return None
    parts = [p.strip() for p in selector.split(",")]
    base = dict(id=_new_id("axis"), param=parts[0].upper(), qualifier=", ".join(parts[1:]) or None)
    is_bracket_array = "[" in text.split("=", 1)[1] if "=" in text else False
    if fn == "" and legacy_array_is_range and is_bracket_array and len(args) == 3:
        return SearchAxisModel(**base, fn="lin", low=args[0], high=args[1], count=int(args[2]))
    if fn in ("values", ""):
        return SearchAxisModel(**base, fn="values", low=min(args), high=max(args), count=len(args), values=args)
    if fn not in ("lin", "log"):
        return None
    return SearchAxisModel(**base, fn=fn, low=args[0], high=args[1], count=int(args[2]) if len(args) >= 3 else 0)


def _parse_axes(entries: Any, legacy: bool) -> List[SearchAxisModel]:
    if isinstance(entries, dict):  # legacy inline table { PB = [min, max, n] }
        entries = [f"[{k}] = [{', '.join(str(x) for x in v)}]" if isinstance(v, list) else f"[{k}] = {v}" for k, v in entries.items()]
    axes = []
    for e in _str_list(entries):
        a = parse_axis_string(e, legacy_array_is_range=legacy)
        if a:
            axes.append(a)
    return axes


def _upsert(params: List[ParamSettingModel], name: str, **update: Any) -> None:
    uname = name.upper()
    for p in params:
        if p.name.upper() == uname:
            for k, v in update.items():
                setattr(p, k, v)
            return
    params.append(ParamSettingModel(name=uname, **{"mode": "fit", **update}))


def _parse_roles(roles: Any) -> Tuple[List[ParamSettingModel], List[RoleRuleModel]]:
    """Plain-name actions on not-yet-assigned params → table; the rest → ordered rules."""
    params: List[ParamSettingModel] = []
    rules: List[RoleRuleModel] = []
    assigned: set[str] = set()
    in_table = True
    # The table always emits CONSTRAIN → FIX → FIT; an action of an earlier bucket that comes
    # after a later one must stay an ordered rule, or re-emitting would reorder ROLES.
    bucket = {"CONSTRAIN": 0, "FIX": 1, "FIT": 2}
    last_bucket = -1
    for action_table in roles if isinstance(roles, list) else []:
        if not isinstance(action_table, dict) or len(action_table) != 1:
            continue
        raw_key, raw_val = next(iter(action_table.items()))
        action = str(raw_key).upper()
        if action not in ("FIT", "FIX", "CONSTRAIN"):
            continue
        entries = [e.strip() for e in _str_list(raw_val) if e.strip()]
        names: Optional[List[str]] = None
        if in_table and bucket[action] < last_bucket:
            in_table = False
        if in_table:
            if action == "CONSTRAIN":
                ms = [_PLAIN_CONSTRAINT.match(e) for e in entries]
                if all(ms):
                    names = [m.group(1).upper() for m in ms]  # type: ignore[union-attr]
            elif all(_SIMPLE_NAME.match(e) for e in entries):
                names = [e.upper() for e in entries]
            else:
                # Mixed FIT/FIX action: plain names on fresh params → table, qualified rest → first rule.
                plain = [e.upper() for e in entries if _SIMPLE_NAME.match(e)]
                qualified = [e for e in entries if not _SIMPLE_NAME.match(e)]
                if plain and not any(n in assigned for n in plain) and len(set(plain)) == len(plain):
                    for n in plain:
                        assigned.add(n)
                        _upsert(params, n, mode="fit" if action == "FIT" else "fix")
                    in_table = False
                    rules.append(RoleRuleModel(id=_new_id("rule"), action=action, entries=qualified))  # type: ignore[arg-type]
                    continue
            if names and (any(n in assigned for n in names) or len(set(names)) != len(names)):
                names = None
        if in_table and names:
            last_bucket = bucket[action]
            for n, e in zip(names, entries):
                assigned.add(n)
                if action == "CONSTRAIN":
                    _upsert(params, n, mode="constrain", expression=_PLAIN_CONSTRAINT.match(e).group(2).strip())  # type: ignore[union-attr]
                else:
                    _upsert(params, n, mode="fit" if action == "FIT" else "fix")
        else:
            in_table = False
            rules.append(RoleRuleModel(id=_new_id("rule"), action=action, entries=entries))  # type: ignore[arg-type]
    return params, rules


def _parse_statistics(stat_data: Any) -> Optional[StatisticsModel]:
    if not isinstance(stat_data, dict):
        return None
    norm: Dict[str, Any] = {}
    for sk, sv in stat_data.items():
        k = str(sk).lower()
        if k in ("mc", "bs", "bsn"):
            norm[k] = sv
        elif k == "mcmc":
            if isinstance(sv, int) and not isinstance(sv, bool):
                norm["mcmc"] = sv
            elif isinstance(sv, dict):
                mcmc = {str(mk).lower(): mv for mk, mv in sv.items()}
                if isinstance(mcmc.get("burn"), str):
                    mcmc["burn"] = "auto" if mcmc["burn"].strip().lower() == "auto" else mcmc["burn"]
                try:
                    norm["mcmc"] = McmcSettingsModel(**mcmc)
                except Exception:
                    pass
    try:
        stats = StatisticsModel(**norm)
    except Exception:
        return None
    return None if stats.is_empty() else stats


def _parse_selection(section: dict) -> Tuple[Literal["all", "include", "exclude"], List[Union[int, str]]]:
    inc, exc = _get(section, "INCLUDE"), _get(section, "EXCLUDE")
    raw, mode = (inc, "include") if inc is not None else (exc, "exclude") if exc is not None else (None, "all")
    if raw is None:
        return "all", []
    residues: List[Union[int, str]] = []
    for r in raw if isinstance(raw, list) else [raw]:
        s = str(r).strip()
        residues.append(int(s) if s.isdigit() else ("ALL" if s == "*" else s))
    return mode, residues  # type: ignore[return-value]


def _parse_v2_step(name: str, section: dict) -> MethodStepModel:
    residue_mode, residues = _parse_selection(section)
    params, rules = _parse_roles(_get(section, "ROLES") or [])
    search = None
    search_data = _get(section, "SEARCH")
    if isinstance(search_data, dict):
        grid, de = _get(search_data, "GRID"), _get(search_data, "DE")
        if isinstance(grid, dict):
            search = StepSearchModel(mode="grid", axes=_parse_axes(_get(grid, "AXES"), legacy=False))
        elif isinstance(de, dict):
            seed = _get(de, "SEED")
            search = StepSearchModel(
                mode="de",
                axes=_parse_axes(_get(de, "COORDINATES"), legacy=False),
                seed=seed if isinstance(seed, int) and not isinstance(seed, bool) else None,
            )
    rf = _get(section, "ROLES_FROM")
    return MethodStepModel(
        name=name,
        parameters=params,
        residue_mode=residue_mode,
        residues=residues,
        roles_from=rf if isinstance(rf, str) else None,
        role_rules=rules,
        search=search,
        statistics=_parse_statistics(_get(section, "STATISTICS")),
    )


def _parse_v1_step(name: str, section: dict) -> MethodStepModel:
    residue_mode, residues = _parse_selection(section)
    params: List[ParamSettingModel] = []
    rules: List[RoleRuleModel] = []
    # v1 bucket order CONSTRAINTS → FIX → FIT (later wins).
    for c in _str_list(_get(section, "CONSTRAINTS")):
        b = _BOUND_CONSTRAINT.match(c)
        if b:
            exists = any(p.name.upper() == b.group(1).upper() for p in params)
            bound = re.sub(r"^\s*\[?\s*[A-Za-z_][A-Za-z0-9_]*\s*\]?\s*", "", c)
            _upsert(params, b.group(1), bounds=bound, **({} if exists else {"mode": "default"}))
            continue
        m = _PLAIN_CONSTRAINT.match(c)
        if m:
            _upsert(params, m.group(1), mode="constrain", expression=m.group(2).strip())
        else:
            rules.append(RoleRuleModel(id=_new_id("rule"), action="CONSTRAIN", entries=[c]))
    for key in ("FIX", "FIT"):
        for sel in _str_list(_get(section, key)):
            if _SIMPLE_NAME.match(sel.strip()):
                _upsert(params, sel.strip(), mode="fit" if key == "FIT" else "fix")
            else:
                rules.append(RoleRuleModel(id=_new_id("rule"), action=key, entries=[sel]))  # type: ignore[arg-type]
    grid = _get(section, "GRID")
    search = StepSearchModel(mode="grid", axes=_parse_axes(grid, legacy=True)) if grid is not None else None
    return MethodStepModel(
        name=name,
        parameters=params,
        residue_mode=residue_mode,
        residues=residues,
        role_rules=rules,
        search=search,
        statistics=_parse_statistics(_get(section, "STATISTICS")),
    )


def parse_method_toml(toml_str: str) -> MethodConfigModel:
    """
    Parse a ChemEx method.toml (v2, or legacy v1 migrated to v2 semantics) into a MethodConfigModel.
    Malformed TOML is preserved verbatim as ``raw_override``.
    """
    if not toml_str or not toml_str.strip():
        return MethodConfigModel(steps=[MethodStepModel(name="STEP1")])
    try:
        data = tomllib.loads(toml_str)
    except Exception:
        return MethodConfigModel(steps=[MethodStepModel(name="STEP1")], raw_override=toml_str)

    is_v2 = any(str(k).upper() == "FORMAT_VERSION" for k in data)
    steps: List[MethodStepModel] = []
    for section_name, section in data.items():
        if not isinstance(section, dict):
            continue
        name = str(section_name)  # case preserved
        parsed = _parse_v2_step(name, section) if is_v2 else _parse_v1_step(name, section)
        parsed.id = _new_id("step")
        steps.append(parsed)

    if not is_v2:
        # v1 carried roles and selection implicitly between steps; make it explicit.
        for i in range(1, len(steps)):
            steps[i].roles_from = steps[i - 1].name
            steps[i].roles_from_step_id = steps[i - 1].id
            if steps[i].residue_mode == "all" and steps[i - 1].residue_mode != "all":
                steps[i].residue_mode = steps[i - 1].residue_mode
                steps[i].residues = list(steps[i - 1].residues)

    # Link name-only ROLES_FROM references to step ids (earlier steps first).
    for i, st in enumerate(steps):
        if st.roles_from and not st.roles_from_step_id:
            target = next((s for s in steps[:i] if s.name == st.roles_from), None) or next(
                (s for s in steps if s.name == st.roles_from), None
            )
            if target is not None:
                st.roles_from_step_id = target.id

    return MethodConfigModel(steps=steps or [MethodStepModel(name="STEP1")])
