"""Single source of truth for the ChemEx parameter catalogue (Parameters and Methods tabs).

Served by the CEST, CPMG and EXCHANGE ``method-parameters`` endpoints. Rows are derived
from the installed ChemEx (``resoflow.chemex_api.defaults``), so default values, bounds
and default roles cannot drift from the library. The hand-written tables below are only
a fallback if ChemEx cannot be introspected.

Row keys (backward compatible): ``name, gloss, scope, default_mode, default_bounds,
category, is_primary`` and ``default_expression`` for default constraints. Added:
``default_value, lower, upper`` (ChemEx defaults; null = unbounded), ``default_role``
(fit/fix/derived/protected), ``derived``, ``protected``, ``condition_dependent``, ``hint``.
``default_bounds`` is always null: it is a legacy v1 inequality field in the Methods tab,
and real bounds belong in parameters.toml.
"""

from __future__ import annotations

import copy
import logging
import re
from functools import lru_cache
from typing import Any

logger = logging.getLogger(__name__)

_PARAMS_2ST: list[dict] = [{'name': 'PB',
  'gloss': 'Population of state B (0 - 1); nothing enforces PA > PB',
  'hint': 'typically < 0.5',
  'scope': 'global',
  'default_mode': 'default',
  'category': 'kinetic',
  'is_primary': True},
 {'name': 'KEX_AB',
  'gloss': 'Exchange rate between states A and B (s⁻¹)',
  'scope': 'global',
  'default_mode': 'default',
  'category': 'kinetic',
  'is_primary': True},
 {'name': 'CS_A',
  'gloss': 'Chemical shift of major ground state A (ppm)',
  'scope': 'residue',
  'default_mode': 'default',
  'category': 'chemical_shift',
  'is_primary': True},
 {'name': 'DW_AB',
  'gloss': 'Chemical shift difference between states B and A: CS_B - CS_A (ppm)',
  'scope': 'residue',
  'default_mode': 'default',
  'category': 'chemical_shift',
  'is_primary': True},
 {'name': 'R1_A',
  'gloss': 'Longitudinal relaxation rate of state A (s⁻¹)',
  'scope': 'residue',
  'default_mode': 'default',
  'category': 'relaxation',
  'is_primary': True},
 {'name': 'R2_A',
  'gloss': 'Transverse relaxation rate of state A (s⁻¹)',
  'scope': 'residue',
  'default_mode': 'default',
  'category': 'relaxation',
  'is_primary': True},
 {'name': 'R1_B',
  'gloss': 'Longitudinal relaxation rate of state B (s⁻¹)',
  'scope': 'residue',
  'default_mode': 'default',
  'default_expression': '[R1_A]',
  'category': 'relaxation',
  'is_primary': True},
 {'name': 'R2_B',
  'gloss': 'Transverse relaxation rate of state B (s⁻¹)',
  'scope': 'residue',
  'default_mode': 'default',
  'default_expression': '[R2_A]',
  'category': 'relaxation',
  'is_primary': True},
 {'name': 'TAUC_A',
  'gloss': 'Rotational correlation time of state A (ns)',
  'scope': 'global',
  'default_mode': 'default',
  'category': 'hydrodynamic',
  'is_primary': False}]

_PARAMS_3ST: list[dict] = [{'name': 'PB',
  'gloss': 'Population of state B (0 - 1)',
  'scope': 'global',
  'default_mode': 'default',
  'category': 'kinetic',
  'is_primary': True},
 {'name': 'PC',
  'gloss': 'Population of state C (0 - 1)',
  'scope': 'global',
  'default_mode': 'default',
  'category': 'kinetic',
  'is_primary': True},
 {'name': 'KEX_AB',
  'gloss': 'Exchange rate between states A and B (s⁻¹)',
  'scope': 'global',
  'default_mode': 'default',
  'category': 'kinetic',
  'is_primary': True},
 {'name': 'KEX_AC',
  'gloss': 'Exchange rate between states A and C (s⁻¹)',
  'scope': 'global',
  'default_mode': 'default',
  'category': 'kinetic',
  'is_primary': True},
 {'name': 'KEX_BC',
  'gloss': 'Exchange rate between states B and C (s⁻¹)',
  'scope': 'global',
  'default_mode': 'default',
  'category': 'kinetic',
  'is_primary': False},
 {'name': 'CS_A',
  'gloss': 'Chemical shift of major state A (ppm)',
  'scope': 'residue',
  'default_mode': 'default',
  'category': 'chemical_shift',
  'is_primary': True},
 {'name': 'DW_AB',
  'gloss': 'Chemical shift difference CS_B - CS_A (ppm)',
  'scope': 'residue',
  'default_mode': 'default',
  'category': 'chemical_shift',
  'is_primary': True},
 {'name': 'DW_AC',
  'gloss': 'Chemical shift difference CS_C - CS_A (ppm)',
  'scope': 'residue',
  'default_mode': 'default',
  'category': 'chemical_shift',
  'is_primary': True},
 {'name': 'R1_A',
  'gloss': 'Longitudinal relaxation rate of state A (s⁻¹)',
  'scope': 'residue',
  'default_mode': 'default',
  'category': 'relaxation',
  'is_primary': True},
 {'name': 'R2_A',
  'gloss': 'Transverse relaxation rate of state A (s⁻¹)',
  'scope': 'residue',
  'default_mode': 'default',
  'category': 'relaxation',
  'is_primary': True},
 {'name': 'R1_B',
  'gloss': 'Longitudinal relaxation rate of state B (s⁻¹)',
  'scope': 'residue',
  'default_mode': 'default',
  'default_expression': '[R1_A]',
  'category': 'relaxation',
  'is_primary': True},
 {'name': 'R2_B',
  'gloss': 'Transverse relaxation rate of state B (s⁻¹)',
  'scope': 'residue',
  'default_mode': 'default',
  'default_expression': '[R2_A]',
  'category': 'relaxation',
  'is_primary': True},
 {'name': 'R1_C',
  'gloss': 'Longitudinal relaxation rate of state C (s⁻¹)',
  'scope': 'residue',
  'default_mode': 'default',
  'default_expression': '[R1_A]',
  'category': 'relaxation',
  'is_primary': True},
 {'name': 'R2_C',
  'gloss': 'Transverse relaxation rate of state C (s⁻¹)',
  'scope': 'residue',
  'default_mode': 'default',
  'default_expression': '[R2_A]',
  'category': 'relaxation',
  'is_primary': True},
 {'name': 'TAUC_A',
  'gloss': 'Rotational correlation time of state A (ns)',
  'scope': 'global',
  'default_mode': 'default',
  'category': 'hydrodynamic',
  'is_primary': False}]



_GLOSSES: list[tuple[str, str, str | None]] = [
    (r"^P([B-F])$", "Population of state {0} (0 - 1); nothing enforces PA > P{0}", "typically < 0.5"),
    (r"^PA$", "Population of state A (1 minus the other populations)", None),
    (r"^KEX_([A-F])([A-F])$", "Exchange rate between states {0} and {1}: k{0}{1} + k{1}{0} (s⁻¹)", None),
    (r"^K([A-F])([A-F])$", "Rate constant {0} → {1} (s⁻¹)", None),
    (r"^KD$", "Dissociation constant (M)", None),
    (r"^KD_APP$", "Apparent dissociation constant (M)", None),
    (r"^KOFF(_[A-F]{2})?$", "Dissociation rate constant (s⁻¹)", None),
    (r"^KEQ_([A-F])([A-F])$", "Equilibrium constant between states {0} and {1}", None),
    (r"^DH_", "Enthalpy (J/mol)", None),
    (r"^DS_", "Entropy (J/mol/K)", None),
    (r"^TREF$", "Reference temperature of the .tc shift polynomials (°C); protected model constant", None),
    (r"^CS0_A$", "State-A chemical shift at TREF (ppm)", None),
    (r"^CS1_A$", "State-A chemical shift temperature coefficient (ppm/°C)", None),
    (r"^DW0_A([B-F])$", "CS_{0} − CS_A at TREF (ppm)", None),
    (r"^DW1_A([B-F])$", "Temperature coefficient of CS_{0} − CS_A (ppm/°C)", None),
    (r"^CS_A$", "Chemical shift of major ground state A (ppm)", None),
    (r"^CS_([B-F])$", "Chemical shift of state {0} (ppm)", None),
    (r"^DW_A([B-F])$", "Chemical shift difference between states {0} and A: CS_{0} - CS_A (ppm)", None),
    (r"^R1_([A-F])$", "Longitudinal relaxation rate of state {0} (s⁻¹)", None),
    (r"^R2_([A-F])$", "Transverse relaxation rate of state {0} (s⁻¹)", None),
    (r"^TAUC_A$", "Rotational correlation time of state A (ns)", None),
]


def _gloss(name: str) -> tuple[str, str | None]:
    for pattern, text, hint in _GLOSSES:
        m = re.match(pattern, name)
        if m:
            return text.format(*m.groups()), hint
    return f"ChemEx parameter {name}", None


def _category(name: str) -> str:
    if re.match(r"^(CS|DW)", name):
        return "chemical_shift"
    if re.match(r"^R[12]_", name):
        return "relaxation"
    if name.startswith("TAUC"):
        return "hydrodynamic"
    if name == "TREF":
        return "temperature"
    return "kinetic"


def _order(row: dict) -> tuple:
    name = row["name"]
    state = name[-1] if re.match(r"^R[12]_[A-F]$", name) else ""
    groups = [
        (r"^P[A-F]$", 0), (r"^KEX_", 1), (r"^K", 2), (r"^D[HS]_", 2), (r"^TREF$", 3),
        (r"^CS0?1?_A$|^CS0_A$|^CS1_A$|^CS_A$", 4), (r"^CS_", 5), (r"^DW", 6), (r"^R[12]_", 7), (r"^TAUC", 9),
    ]
    group = next((g for p, g in groups if re.match(p, name)), 8)
    return (0 if row["scope"] == "global" and group < 4 else 1, group, state, name)


def _keep(d: Any) -> bool:
    """Catalogue rows: independent parameters, TREF, and overridable default constraints (R1_B = [R1_A])."""
    if d.role != "derived":
        return True
    return bool(re.match(r"^R[12]_[B-F]$", d.name))


def _row(d: Any) -> dict:
    gloss, hint = _gloss(d.name)
    row: dict[str, Any] = {
        "name": d.name,
        "gloss": gloss,
        "scope": d.scope,
        "default_mode": "default",
        "default_bounds": None,
        "category": _category(d.name),
        "is_primary": not (d.name.startswith("TAUC") or d.protected),
        "default_value": d.value,
        "lower": d.lower,
        "upper": d.upper,
        "default_role": d.role,
        "derived": d.role == "derived",
        "protected": d.protected,
        "condition_dependent": d.condition_dependent,
    }
    if d.expression:
        row["default_expression"] = d.expression
    if hint:
        row["hint"] = hint
    return row


@lru_cache(maxsize=64)
def _catalog_from_chemex(model: str) -> tuple[dict, ...] | None:
    try:
        from resoflow.chemex_api.defaults import parameter_defaults

        rows = [_row(d) for d in parameter_defaults(model) if _keep(d)]
    except Exception as exc:  # noqa: BLE001 - never fail the endpoint; fall back to the static table
        logger.warning("ChemEx parameter defaults unavailable for model %r: %s", model, exc)
        return None
    return tuple(sorted(rows, key=_order))


def _is_multistate(model: str | None) -> bool:
    model_clean = (model or "2st").lower()
    return "3st" in model_clean or "3" in model_clean


def get_method_parameter_catalog(model: str | None = "2st") -> list[dict]:
    """Return a fresh copy of the parameter definitions for ``model`` (ChemEx-derived)."""
    rows = _catalog_from_chemex(model or "2st")
    if rows is not None:
        return copy.deepcopy(list(rows))
    return copy.deepcopy(_PARAMS_3ST if _is_multistate(model) else _PARAMS_2ST)


def _chemex_version() -> str | None:
    try:
        import chemex

        return getattr(chemex, "__version__", None)
    except Exception:  # noqa: BLE001
        return None


def method_parameters_response(model: str | None = "2st") -> dict:
    """Response body shared by all ``*/method-parameters`` endpoints."""
    derived = _catalog_from_chemex(model or "2st") is not None
    return {
        "model": model,
        "parameters": get_method_parameter_catalog(model),
        "source": "chemex" if derived else "fallback",
        "chemex_version": _chemex_version(),
    }
