"""The frontend's instant-feedback grammar (lib/methodGrammar.ts) must agree with ChemEx.

Both sides read tests/fixtures/method_contract/grammar_cases.json; this test pins the
expected verdicts to ChemEx's own strict selector / constraint parsers.
"""

import json
from pathlib import Path

import pytest
from chemex.configuration.method_expressions import parse_constraint, parse_strict_selector
from chemex.configuration.method_plan import MethodFormatError, SourceRef

CASES = json.loads((Path(__file__).parent / "fixtures" / "method_contract" / "grammar_cases.json").read_text())
SRC = SourceRef(Path("method.toml"), "STEP", "ROLES[0].FIT[0]")


def _valid(fn, text: str) -> bool:
    try:
        fn(text)
        return True
    except (MethodFormatError, ValueError, TypeError):
        return False


@pytest.mark.parametrize("case", CASES["selectors"], ids=lambda c: c["text"] or "<empty>")
def test_selector_verdict_matches_chemex(case):
    assert _valid(lambda t: parse_strict_selector(t, SRC), case["text"]) is case["valid"]


@pytest.mark.parametrize("case", CASES["constraints"], ids=lambda c: c["text"])
def test_constraint_verdict_matches_chemex(case):
    assert _valid(lambda t: parse_constraint(t, SRC, parse_strict_selector), case["text"]) is case["valid"]
