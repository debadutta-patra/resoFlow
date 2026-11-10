"""Per-step effective parameter roles, resolved by ChemEx itself.

For each method step this runs exactly what ChemEx's executor does
(``chemex.optimize.method_plan_execution.execute_method_plan``):

    experiments.select_profiles(step.selection)
    session.compile_parameterization_from_actions(
        plan.effective_role_actions()[step.name], experiments.param_ids)

and reports, for every concrete parameter in the step's active scope, its
final role (fit / fix / derived), any constraint expression, and which ROLES
entry (in which step, after ``ROLES_FROM`` inheritance) decided it.

The FIT/FIX attribution uses ``chemex.parameters.parameterization._build_action_rules``
(the same rule list ChemEx compiles); it is registered in ``compat.verify_hooks``.
"""

from __future__ import annotations

import math

import contextlib
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from chemex.configuration.method_plan import (
    ConstrainAction,
    DeSearch,
    FitAction,
    FixAction,
    GridSearch,
    GridValues,
    MethodFormatError,
    MethodPlan,
    SourceRef,
)
from chemex.configuration.method_validation import resolve_de_coordinates, resolve_grid_axes
from chemex.configuration.methods import read_method_plan
from chemex.parameters.parameterization import ParameterRole

from .session import _conditions, build_session, serialized_cwd
from .spec import FitJobSpec


@dataclass(frozen=True, slots=True)
class RuleOrigin:
    """Where one ROLES entry was declared."""

    step: str
    action_index: int
    entry_index: int
    action: str  # FIT | FIX | CONSTRAIN


_ROLES_FIELD = re.compile(r"ROLES\[(\d+)\]\.(FIT|FIX|CONSTRAIN)\[(\d+)\]", re.IGNORECASE)


def source_ref_dict(source: SourceRef | None) -> dict[str, Any]:
    """ChemEx error location. ``field`` is e.g. "ROLES[1].FIT[0]", "SEARCH.GRID.AXES" (+ ``index``),
    "SEARCH.DE.SEED", "STATISTICS.MC", "ROLES_FROM"; ``start``/``end`` span the entry text.
    For ROLES entries the action/entry indices are also given separately."""
    if source is None:
        return {}
    out: dict[str, Any] = {
        "step": source.step,
        "field": source.field,
        "index": source.index,
        "start": source.start,
        "end": source.end,
    }
    if (m := _ROLES_FIELD.fullmatch(source.field or "")):
        out["action_index"] = int(m.group(1))
        out["action"] = m.group(2).upper()
        out["entry_index"] = int(m.group(3))
    return out


def method_error(exc: BaseException) -> dict[str, Any]:
    """Structured ChemEx error; MethodFormatError carries the exact step/field/index/span."""
    if isinstance(exc, MethodFormatError):
        return {"message": exc.message, "type": type(exc).__name__, "source": source_ref_dict(exc.source)}
    return {"message": str(exc), "type": type(exc).__name__, "source": {}}


def _entries(action: Any) -> tuple[Any, ...]:
    if isinstance(action, (FitAction, FixAction)):
        return action.selectors
    if isinstance(action, ConstrainAction):
        return action.constraints
    return ()


def _action_name(action: Any) -> str:
    return "FIT" if isinstance(action, FitAction) else "FIX" if isinstance(action, FixAction) else "CONSTRAIN"


def rule_origins(plan: MethodPlan) -> dict[str, list[RuleOrigin]]:
    """Ordinal → origin for each step's effective chain (ChemEx numbers every entry in order)."""
    chains: dict[str, list[RuleOrigin]] = {}
    for step in plan.steps:
        own = [
            RuleOrigin(step.name, ai, ei, _action_name(action))
            for ai, action in enumerate(step.role_actions)
            for ei, _ in enumerate(_entries(action))
        ]
        inherited = [] if step.roles_from is None else chains[step.roles_from]
        chains[step.name] = [*inherited, *own]
    return chains


def _last_matching_ordinals(actions: tuple[Any, ...], model: Any) -> dict[str, int]:
    """param_id → ordinal of the last ROLES entry that matched it (later entries win)."""
    from chemex.parameters.parameterization import _build_action_rules

    last: dict[str, int] = {}
    for rule in _build_action_rules(actions, model.definitions):
        for param_id in rule.matches:
            last[param_id] = rule.ordinal
    return last


def _origin_dict(origin: RuleOrigin | None, current_step: str) -> dict[str, Any] | None:
    if origin is None:
        return None
    return {
        "step": origin.step,
        "action_index": origin.action_index,
        "entry_index": origin.entry_index,
        "action": origin.action,
        "inherited": origin.step != current_step,
    }


def _axis_points(axis: Any) -> int:
    spacing = axis.spacing
    return len(spacing.values) if isinstance(spacing, GridValues) else int(spacing.count)


def _search_report(step: Any, parameterization: Any, model: Any, spin_of: dict[str, str]) -> dict[str, Any] | None:
    """Per-axis resolution of SEARCH.GRID / SEARCH.DE against this step's final roles.

    ChemEx's own validator stops at the first bad axis; resolving each axis on its
    own lets the editor flag every affected axis (e.g. after a role change).
    """
    search = step.search
    if search is None:
        return None
    scope = tuple(parameterization.scope_ids)
    in_scope = set(scope)
    fit_ids = tuple(pid for pid in scope if parameterization.role(pid) is ParameterRole.FIT)
    fit_set = set(fit_ids)

    if isinstance(search, GridSearch):
        axes: list[dict[str, Any]] = []
        for i, axis in enumerate(search.axes):
            entry: dict[str, Any] = {
                "index": i, "selector": axis.selector.render(), "points": _axis_points(axis),
                "coordinates": [], "owned": 0, "error": None,
            }
            try:
                resolved = resolve_grid_axes(GridSearch((axis,)), model, active_scope_ids=scope, final_fit_ids=fit_ids)
                entry["coordinates"] = [r.param_id for r in resolved]
            except Exception as exc:
                entry["error"] = method_error(exc)
            axes.append(entry)
        out: dict[str, Any] = {"kind": "grid", "axes": axes, "global_points": None, "local_points": {}, "evaluations": None}
        if not any(a["error"] for a in axes):
            # Later axes replace earlier broad ones for the same concrete coordinate.
            final = resolve_grid_axes(search, model, active_scope_ids=scope, final_fit_ids=fit_ids)
            global_points, local = 1, {}
            for r in final:
                axes[r.declaration_ordinal]["owned"] += 1
                spin = spin_of.get(r.param_id, "")
                if spin:
                    local[spin] = local.get(spin, 1) * len(r.values)
                else:
                    global_points *= len(r.values)
            out["global_points"] = global_points
            out["local_points"] = local
            # Exact factorisation: each global point profiles every residue factor's local grid.
            out["evaluations"] = global_points * (sum(local.values()) if local else 1)
        return out

    if isinstance(search, DeSearch):
        coords: list[dict[str, Any]] = []
        for i, coordinate in enumerate(search.coordinates):
            entry = {"index": i, "selector": coordinate.selector.render(), "coordinates": [], "error": None}
            try:
                param_id = resolve_de_coordinates(DeSearch(search.seed, (coordinate,)), model)[0].param_id
                entry["coordinates"] = [param_id]
                if param_id not in in_scope:
                    raise MethodFormatError(f"DE target {param_id} is not in this step's selected profiles", coordinate.source)
                if param_id not in fit_set:
                    raise MethodFormatError(f"DE target {param_id} is not a final independent FIT coordinate", coordinate.source)
                cfg = model.configuration[param_id]
                rng = coordinate.range
                if rng.low < cfg.lower_bound or rng.high > cfg.upper_bound:
                    raise MethodFormatError(
                        f"Search range for {param_id} lies outside physical bounds [{cfg.lower_bound}, {cfg.upper_bound}]",
                        coordinate.source,
                    )
            except Exception as exc:
                entry["error"] = method_error(exc)
            coords.append(entry)
        seen: dict[str, int] = {}
        for c in coords:
            for pid in c["coordinates"]:
                if pid in seen and c["error"] is None:
                    c["error"] = {"message": f"Duplicate DE coordinate {pid} (also coordinate {seen[pid] + 1})", "type": "MethodFormatError", "source": {}}
                seen.setdefault(pid, c["index"])
        return {"kind": "de", "axes": coords}
    return None


def _data_summary(experiments: Any) -> dict[str, Any]:
    """Active data points per spin system and per-experiment B1 fields for the selected profiles.

    Feeds resoFlow's soft scientific checks (data / parameter ratio, number of B1 fields).
    Best-effort: a profile type without the expected attributes is skipped, never fatal.
    """
    points: dict[str, int] = {}
    exps: list[dict[str, Any]] = []
    for experiment in experiments:
        b1: float | None = None
        n_profiles = 0
        for profile in getattr(experiment, "profiles", []):
            n_profiles += 1
            try:
                spin = str(profile.spin_system)
                mask = getattr(profile.data, "mask", None)
                n = int(mask.sum()) if mask is not None else len(profile.data.exp)
                points[spin] = points.get(spin, 0) + n
            except Exception:
                continue
            if b1 is None:
                raw = getattr(getattr(getattr(profile, "pulse_sequence", None), "settings", None), "b1_frq", None)
                try:
                    b1 = float(raw) if raw is not None and math.isfinite(float(raw)) else None
                except (TypeError, ValueError):
                    b1 = None
        exps.append(
            {"name": getattr(experiment, "name", ""), "file": str(getattr(experiment, "filename", "")), "b1_frq": b1, "profiles": n_profiles}
        )
    return {"data_points": points, "ndata": sum(points.values()), "experiments": exps}


def _resolve_step(session: Any, experiments: Any, plan: MethodPlan, step: Any, chain: list[RuleOrigin]) -> dict[str, Any]:
    model = session.parameter_factory.sealed_parameter_model
    experiments.select_profiles(step.selection)
    required = experiments.param_ids
    out: dict[str, Any] = {
        "name": step.name,
        "roles_from": step.roles_from,
        "profiles": len(experiments),
        "parameters": [],
        "counts": {"fit": 0, "fix": 0, "constrained": 0, "derived": 0},
        "search": None,
        "error": None,
    }
    if not required:
        out["error"] = {"message": "No profiles selected for this step; ChemEx skips it.", "type": "NoData", "source": {}}
        return out

    out.update(_data_summary(experiments))

    actions = plan.effective_role_actions()[step.name]
    parameterization = session.compile_parameterization_from_actions(actions, required)
    constraints = {c.target_id: c for c in parameterization.program.constraints}
    try:
        last_rule = _last_matching_ordinals(actions, model)
    except Exception:  # attribution is best-effort; roles themselves come from ChemEx
        last_rule = {}
    settings = session.parameters.get_parameters(list(parameterization.scope_ids))

    for param_id in parameterization.scope_ids:
        role = parameterization.role(param_id)
        constraint = constraints.get(param_id)
        source = constraint.source if constraint is not None else None
        ordinal: int | None = None
        if source and source.startswith("method-rule:"):
            ordinal = int(source.split(":", 1)[1])
        elif role is not ParameterRole.DERIVED and param_id in last_rule:
            ordinal = last_rule[param_id]
        origin = chain[ordinal] if ordinal is not None and 0 <= ordinal < len(chain) else None

        if role is ParameterRole.DERIVED:
            kind = "constrained" if origin is not None else "derived"
        else:
            kind = "fit" if role is ParameterRole.FIT else "fix"
        out["counts"][kind] += 1

        declaration = model.declarations.get(param_id)
        setting = settings.get(param_id)
        pname = getattr(setting, "param_name", None)
        raw_value = getattr(setting, "value", None)
        try:
            value = float(raw_value) if raw_value is not None and math.isfinite(float(raw_value)) else None
        except (TypeError, ValueError):
            value = None
        spin = str(pname.spin_system) if pname is not None and pname.spin_system else ""
        out["parameters"].append(
            {
                "id": param_id,
                "name": pname.name if pname is not None else param_id.strip("_"),
                "spin": spin,
                "conditions": _conditions(pname) if pname is not None else {},
                "scope": "residue" if spin else "global",
                "role": kind,
                "expression": constraint.expression_text if constraint is not None else "",
                "decided_by": (
                    "rule" if origin is not None
                    else "model" if getattr(declaration, "model_owned", False)
                    else "baseline"
                ),
                "rule": _origin_dict(origin, step.name),
                "protected": bool(getattr(declaration, "model_owned", False)),
                # Value at step start before any earlier step commits (parameters file / ChemEx default).
                "value": value,
            }
        )
    spin_of = {p["id"]: p["spin"] for p in out["parameters"]}
    try:
        out["search"] = _search_report(step, parameterization, model, spin_of)
    except Exception as exc:  # never let the search preview hide the roles
        out["search"] = {"kind": "grid" if isinstance(step.search, GridSearch) else "de", "axes": [], "error": method_error(exc)}
    return out


@serialized_cwd
def resolve_roles(spec: FitJobSpec, method_path: Path, job_dir: Path) -> dict[str, Any]:
    """Validate ``method_path`` with ChemEx and resolve every step's effective roles.

    ``spec`` must not reference the method file (the session is built without
    one so that method errors never prevent baseline construction).
    """
    report: dict[str, Any] = {"valid": True, "format": None, "errors": [], "steps": []}
    with contextlib.chdir(job_dir):
        session, experiments, *_ = build_session(spec, job_dir=job_dir, command="fit")
        try:
            plan = read_method_plan([method_path])
        except Exception as exc:  # syntax / structure: nothing to resolve
            report["valid"] = False
            report["errors"].append(method_error(exc))
            return report
        report["format"] = plan.format_origin.value

        model = session.parameter_factory.sealed_parameter_model
        try:
            plan.validate(model)
        except Exception as exc:
            report["valid"] = False
            report["errors"].append(method_error(exc))

        chains = rule_origins(plan)
        for step in plan.steps:
            try:
                report["steps"].append(_resolve_step(session, experiments, plan, step, chains[step.name]))
            except Exception as exc:
                report["valid"] = False
                report["steps"].append(
                    {"name": step.name, "roles_from": step.roles_from, "profiles": None, "parameters": [],
                     "counts": {"fit": 0, "fix": 0, "constrained": 0, "derived": 0}, "error": method_error(exc)}
                )
    return report


@serialized_cwd
def validate_method(
    spec: FitJobSpec,
    method_path: Path,
    job_dir: Path,
    *,
    sharing_warnings: bool = False,
) -> dict[str, Any]:
    """The single ChemEx-backed method validation: everything a run would reject, with locations.

    1. Parameter / method names removed in ChemEx 2026.9 (checked first: they also make
       session construction fail, and this message says what to rename).
    2. Session construction (experiments, model, parameters).
    3. Method parsing and ChemEx's own plan validation (MethodFormatError with step,
       field, entry index and character span), plus per-step resolved roles and
       per-axis search resolution (see ``resolve_roles``).
    4. Optionally, parameter-sharing warnings (CONDITION_MISMATCH / NEAR_FIELD / ISOLATED).
    """
    from .compat import check_version
    from .session import _check_legacy_names, inspect_parameters

    report: dict[str, Any] = {"valid": True, "format": None, "errors": [], "warnings": [], "steps": []}
    try:
        rel = method_path.resolve().relative_to(job_dir.resolve()).as_posix()
    except ValueError:
        rel = str(method_path)
    legacy = _check_legacy_names(job_dir, spec.model_copy(update={"method_files": [rel]}))
    if legacy:
        report["valid"] = False
        report["errors"].extend({**e, "source": {}} for e in legacy)

    try:
        resolved = resolve_roles(spec, method_path, job_dir)
        report["format"] = resolved["format"]
        report["steps"] = resolved["steps"]
        report["errors"].extend(resolved["errors"])
        report["valid"] = report["valid"] and resolved["valid"]
    except (Exception, SystemExit) as exc:
        report["valid"] = False
        report["errors"].append({"message": str(exc) or type(exc).__name__, "type": type(exc).__name__, "source": {}})

    if sharing_warnings and report["steps"]:
        with contextlib.suppress(Exception):
            inspection = inspect_parameters(spec, job_dir=job_dir, include_warnings=True)
            if isinstance(inspection, dict):
                report["warnings"].extend(inspection.get("warnings", []))

    with contextlib.suppress(Exception):
        report["chemex_version"] = check_version()
    return report
