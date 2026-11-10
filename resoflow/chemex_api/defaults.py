"""ChemEx's own default starting values and safety bounds, per kinetic model.

ChemEx has no public "list defaults" API. The values live in the model setting makers
(``chemex.models.factory.model_factory``) and the spin setting maker
(``chemex.parameters.spins.create_base_param_settings``); both are registered in
``compat.verify_hooks`` (hook 11). Reading them here means the catalogue served to the
Parameters/Methods tabs cannot drift from the installed ChemEx.

Pure and in-process (no experiments needed). Defaults depend on the model and the
parameter name, not on the residue; a few kinetic models (Eyring, binding, H/D,
oligomerisation) depend on the experimental conditions, which is reported as
``condition_dependent`` (values are shown for 25 °C / 600 MHz / 1 mM).
"""

from __future__ import annotations

import math
import re
from dataclasses import asdict, dataclass
from functools import lru_cache
from typing import Any, Literal

Scope = Literal["global", "residue"]
Role = Literal["fit", "fix", "derived", "protected"]

#: Spin-level names exposed in the catalogue (the rest are experiment internals).
_SPIN_NAMES = re.compile(r"^(cs|dw|r1|r2)_[a-f]{1,2}$|^(cs0|cs1)_a$|^(dw0|dw1)_a[b-f]$|^tauc_a$|^tref$")
#: Per-spin-system in ChemEx but offered as a [GLOBAL] blanket value in the UI.
_GLOBAL_SPIN = {"tauc_a", "tref"}
_HUGE = 1e300

_CONDITIONS_A: dict[str, Any] = {"temperature": 25.0, "h_larmor_frq": 600.0, "p_total": 1e-3, "l_total": 1e-3, "d2o": 0.1}
_CONDITIONS_B: dict[str, Any] = {"temperature": 35.0, "h_larmor_frq": 800.0, "p_total": 2e-3, "l_total": 3e-3, "d2o": 0.2}


@dataclass(frozen=True)
class ParamDefault:
    name: str  # upper-case ChemEx name, e.g. "PB", "DW_AB"
    scope: Scope
    value: float | None
    lower: float | None
    upper: float | None
    role: Role  # ChemEx's default role
    expression: str  # default constraint, e.g. "[R2_A]" (derived only)
    protected: bool  # model-owned constant (e.g. TREF): no bounds, no method role
    condition_dependent: bool

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _finite(x: Any) -> float | None:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) and abs(v) < _HUGE else None


def _conditions(values: dict[str, Any]):
    from chemex.configuration.conditions import Conditions

    return Conditions(**values)


def _model_spec(model: str):
    from chemex.models.model import ModelSpec

    return ModelSpec.from_name(model)


def _kinetic_settings(spec, conditions) -> dict[str, Any]:
    from chemex.models.factory import model_factory

    return model_factory.create_for_model(spec, conditions)


def _spin_settings(spec, conditions) -> dict[str, Any]:
    from chemex.nmr.basis import Basis
    from chemex.parameters.spins import create_base_param_settings

    basis = Basis(type="ixyz", model=spec, extension="", spin_system="nh")
    settings: dict[str, Any] = {}
    for state in spec.states:
        settings.update(create_base_param_settings(basis, state, conditions))
    return settings


def _expression(expr: str, key_to_name: dict[str, str]) -> str:
    """ChemEx setting expressions use setting keys ("{r2_i_a}"); show names ("[R2_A]")."""
    return re.sub(r"\{([a-zA-Z0-9_]+)\}", lambda m: f"[{key_to_name.get(m[1], m[1]).upper()}]", expr)


def _rows(model: str, conditions_values: dict[str, Any]) -> dict[str, ParamDefault]:
    spec = _model_spec(model)
    conditions = _conditions(conditions_values)
    kinetic = _kinetic_settings(spec, conditions)
    spin = _spin_settings(spec, conditions)
    key_to_name = {k: s.name_setting.name for k, s in {**kinetic, **spin}.items()}

    rows: dict[str, ParamDefault] = {}

    def add(setting: Any, scope: Scope) -> None:
        name = setting.name_setting.name.upper()
        if name in rows:
            return
        model_owned = bool(getattr(setting, "model_owned", False))
        expr = setting.expr or ""
        if model_owned and not expr:
            role: Role = "protected"
        elif expr:
            role = "derived"
        else:
            role = "fit" if setting.vary else "fix"
        protected = model_owned and not expr
        rows[name] = ParamDefault(
            name=name,
            scope=scope,
            # A derived parameter's own value is not a starting value (its expression wins).
            value=None if role == "derived" else _finite(setting.value),
            lower=None if protected else _finite(setting.min),
            upper=None if protected else _finite(setting.max),
            role=role,
            expression=_expression(expr, key_to_name) if expr else "",
            protected=protected,
            condition_dependent=False,
        )

    for setting in kinetic.values():
        part = setting.name_setting.spin_system_part
        add(setting, "global" if part == "" else "residue")
    for setting in spin.values():
        lname = setting.name_setting.name.lower()
        if not _SPIN_NAMES.match(lname):
            continue
        add(setting, "global" if lname in _GLOBAL_SPIN or setting.name_setting.spin_system_part == "" else "residue")
    return rows


@lru_cache(maxsize=64)
def parameter_defaults(model: str = "2st") -> tuple[ParamDefault, ...]:
    """Every catalogue parameter of ``model`` with ChemEx's default value, bounds and role.

    Raises ``ValueError`` for an unknown model (ChemEx's own message).
    """
    from chemex.runtime.session import ensure_plugins_registered

    ensure_plugins_registered()
    rows_a = _rows(model, _CONDITIONS_A)
    try:
        rows_b = _rows(model, _CONDITIONS_B)
    except Exception:  # noqa: BLE001 - a second probe is only used to detect condition dependence
        rows_b = rows_a
    out: list[ParamDefault] = []
    for name, row in rows_a.items():
        other = rows_b.get(name)
        dependent = other is None or (other.value, other.lower, other.upper, other.expression) != (
            row.value,
            row.lower,
            row.upper,
            row.expression,
        )
        out.append(ParamDefault(**{**asdict(row), "condition_dependent": dependent}))
    return tuple(out)
