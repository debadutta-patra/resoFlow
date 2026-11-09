"""Emitter contract: method_emitter.py must emit exactly the TOML pinned in the shared
fixture (frontend/src/lib/methodToml.contract.test.ts holds methodToml.ts to the same
bytes). Every non-raw case must also be accepted by ChemEx's own v2 reader."""

import json
import tempfile
from pathlib import Path

import pytest
from chemex.configuration.methods import read_method_plan

from app.schemas import MethodConfigSchema
from app.services.fitting.method_emitter import MethodConfigModel, emit_method_toml_v2, parse_method_toml

CASES = json.loads((Path(__file__).parent / "fixtures" / "method_contract" / "emit_cases.json").read_text())["cases"]


def _emit(config: dict) -> str:
    # Same path as the API: request schema → emitter model.
    return emit_method_toml_v2(MethodConfigModel(**MethodConfigSchema(**config).model_dump()))


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_backend_emits_the_shared_bytes(case):
    assert _emit(case["config"]) == case["toml"]
    # Also directly from the camelCase payload.
    assert emit_method_toml_v2(MethodConfigModel(**case["config"])) == case["toml"]


@pytest.mark.parametrize("case", [c for c in CASES if not c["config"].get("rawOverride")], ids=lambda c: c["name"])
def test_parse_emit_fixed_point(case):
    assert emit_method_toml_v2(parse_method_toml(case["toml"])) == case["toml"]


@pytest.mark.parametrize(
    "case",
    [c for c in CASES if not c["config"].get("rawOverride") and "dangling" not in c["name"]],
    ids=lambda c: c["name"],
)
def test_chemex_reads_every_case(case):
    with tempfile.TemporaryDirectory() as td:
        path = Path(td) / "method.toml"
        path.write_text(case["toml"], encoding="utf-8")
        plan = read_method_plan([path])
    assert plan.format_origin.value == "v2"
