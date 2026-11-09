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

import contextlib
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from chemex.configuration.method_plan import (
    ConstrainAction,
    FitAction,
    FixAction,
    MethodFormatError,
    MethodPlan,
    SourceRef,
)
from chemex.configuration.methods import read_method_plan
from chemex.parameters.parameterization import ParameterRole

from .session import _conditions, build_session
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
        "error": None,
    }
    if not required:
        out["error"] = {"message": "No profiles selected for this step; ChemEx skips it.", "type": "NoData", "source": {}}
        return out

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
        pname = getattr(settings.get(param_id), "param_name", None)
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
            }
        )
    return out


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
