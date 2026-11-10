"""TREF (the .tc reference temperature) is a protected model constant: no method role or search."""

from __future__ import annotations

import pytest

from app.services.fitting.method_emitter import (
    MethodConfigModel,
    ProtectedTargetError,
    emit_method_toml_v2,
    reject_protected_targets,
)


def _config(**step) -> MethodConfigModel:
    base = {"id": "s1", "name": "STEP1", "parameters": [], "residueMode": "all", "residues": []}
    base.update(step)
    return MethodConfigModel(**{"steps": [base]})


@pytest.mark.parametrize(
    "step",
    [
        {"parameters": [{"name": "TREF", "mode": "fit"}]},
        {"parameters": [{"name": "tref", "mode": "fix"}]},
        {"roleRules": [{"id": "r", "action": "FIT", "entries": ["TREF"]}]},
        {"roleRules": [{"id": "r", "action": "CONSTRAIN", "entries": ["[TREF] = 20"]}]},
        {"search": {"mode": "grid", "axes": [{"id": "a", "param": "TREF", "fn": "lin", "low": 10, "high": 30, "count": 3}]}},
        {"search": {"mode": "de", "axes": [{"id": "a", "param": "TREF", "fn": "lin", "low": 10, "high": 30, "count": 1}], "seed": "1"}},
    ],
)
def test_tref_targets_are_refused(step: dict) -> None:
    with pytest.raises(ProtectedTargetError, match="TREF is a protected model constant"):
        emit_method_toml_v2(_config(**step))


def test_other_targets_and_raw_override_pass() -> None:
    reject_protected_targets(_config(parameters=[{"name": "DW0_AB", "mode": "fit"}, {"name": "CS1_A", "mode": "fix"}]))
    raw = MethodConfigModel(**{"steps": [], "raw_override": 'FORMAT_VERSION = 2\n[S]\nROLES = [{ FIT = ["TREF"] }]\n'})
    assert "TREF" in emit_method_toml_v2(raw)  # verbatim; ChemEx validation reports it
