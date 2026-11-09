"""Golden round trips for every TOML example on the ChemEx v2 method-files page.

Shared with frontend/src/lib/docsExamples.contract.test.ts (same pinned emitted bytes).
Every example must also be read by ChemEx, and our emission must mean exactly what
the original means (identical ChemEx canonical rendering). The v2 examples are also
validated semantically by ChemEx against a docs-shaped dataset derived from the
cest_15n fixture (spins renamed to the docs' residues, 800.13 MHz, 23 °C).
"""

from __future__ import annotations

import re
import shutil
import tempfile
from pathlib import Path

import pytest
from chemex.configuration.methods import read_method_plan

from app.services.fitting.method_emitter import emit_method_toml_v2, parse_method_toml
from resoflow.chemex_api.roles import validate_method
from resoflow.chemex_api.spec import FitJobSpec

HERE = Path(__file__).parent
EXAMPLES = HERE / "fixtures" / "method_contract" / "docs_examples"
FILES = sorted(EXAMPLES.glob("*.toml"))
CEST = HERE / "fixtures" / "baselines" / "2026.6.1" / "cest_15n" / "inputs"


def _plan(text: str):
    with tempfile.TemporaryDirectory() as td:
        path = Path(td) / "method.toml"
        path.write_text(text, encoding="utf-8")
        return read_method_plan([path])


@pytest.mark.parametrize("path", FILES, ids=lambda p: p.name)
def test_backend_emits_the_shared_golden_bytes_and_round_trips(path: Path):
    golden = (EXAMPLES / "emitted" / path.name).read_text(encoding="utf-8")
    out = emit_method_toml_v2(parse_method_toml(path.read_text(encoding="utf-8")))
    assert out == golden
    assert emit_method_toml_v2(parse_method_toml(out)) == out


@pytest.mark.parametrize("path", FILES, ids=lambda p: p.name)
def test_emission_means_exactly_what_the_docs_example_means(path: Path):
    """ChemEx reads both, and renders them to the same canonical v2 method."""
    original = _plan(path.read_text(encoding="utf-8"))
    ours = _plan((EXAMPLES / "emitted" / path.name).read_text(encoding="utf-8"))
    assert ours.format_origin.value == "v2"
    assert ours.render() == original.render()


def test_v1_step_and_its_documented_v2_equivalent_are_the_same_plan():
    v1 = _plan((EXAMPLES / "11_v1_step.toml").read_text(encoding="utf-8"))
    v2 = _plan((EXAMPLES / "11_v2_equivalent.toml").read_text(encoding="utf-8"))
    assert v1.format_origin.value == "v1"
    assert v1.render() == v2.render()


# ── semantic validation against data ────────────────────────────────────

RENAME = {"13N": "G23N-H", "26N": "G24N-H", "28N": "G31N-H", "29N": "A15N-H"}


@pytest.fixture(scope="module")
def docs_dataset(tmp_path_factory) -> Path:
    if not CEST.exists():
        pytest.skip("cest_15n inputs not found")
    root = tmp_path_factory.mktemp("docs_dataset")
    shutil.copytree(CEST / "Data", root / "Data")
    (root / "Experiments").mkdir()
    (root / "Parameters").mkdir()
    for exp in sorted((CEST / "Experiments").glob("*.toml")):
        text = re.sub(r"h_larmor_frq = [\d.]+", "h_larmor_frq = 800.13\ntemperature = 23.0", exp.read_text())
        head, profiles = text.split("[data.profiles]")
        kept = []
        for line in profiles.strip().splitlines():
            key = line.split("=")[0].strip()
            if key in RENAME:
                kept.append(f"{RENAME[key]} = {line.split('=', 1)[1].strip()}")
        (root / "Experiments" / exp.name).write_text(head + "[data.profiles]\n" + "\n".join(kept) + "\n")
    (root / "Parameters" / "parameters.toml").write_text(
        "[GLOBAL]\nPB = 0.015\nKEX_AB = 70.0\nTAUC_A = 10.0\n\n"
        "[CS_A]\nG23N = 108.2\nG24N = 115.7\nG31N = 113.9\nA15N = 115.3\n\n"
        "[DW_AB]\nG23N = 4.0\nG24N = 5.5\nG31N = 6.5\nA15N = 6.0\n",
        encoding="utf-8",
    )
    return root


def _validate(dataset: Path, method_text: str) -> dict:
    with tempfile.TemporaryDirectory() as td:
        job = Path(td)
        shutil.copytree(dataset, job, dirs_exist_ok=True)
        (job / "Methods").mkdir()
        method = job / "Methods" / "method.toml"
        method.write_text(method_text, encoding="utf-8")
        spec = FitJobSpec(
            job_id="docs",
            experiment_files=[f"Experiments/{p.name}" for p in sorted((job / "Experiments").glob("*.toml"))],
            parameter_files=["Parameters/parameters.toml"],
            method_files=[],
            model="2st",
            output_dir="Output",
        )
        return validate_method(spec, method, job)


#: Two docs examples do not validate as written against multi-residue data (ChemEx 2026.9.2):
#: 1. DW_AB lives on single-nucleus spins (G24N): ChemEx matches a selector only if its spin
#:    keys are a subset of the parameter's, so "NUC->G24N-H" never matches a nitrogen DW_AB.
#: 2. A qualified constraint reference is not re-scoped to each target: in
#:    "[R2_B, NUC->N] = [R2_A, NUC->N]" the reference is ambiguous once there are several N
#:    residues, while a plain "[R2_A]" resolves per target residue.
#: They are validated with these substitutions (and pinned as written below).
NUC_SUBSTITUTIONS = {
    "NUC->G24N-H": "NUC->G24N",
    "NUC->G31N-H": "NUC->G31N",
    "= [R2_A, NUC->N]": "= [R2_A]",
}

V2_DATA_EXAMPLES = [f for f in FILES if f.name not in ("11_v1_step.toml", "12_chemex_method_de.toml")]


@pytest.mark.parametrize("path", V2_DATA_EXAMPLES, ids=lambda p: p.name)
def test_chemex_validates_every_v2_docs_example_against_data(docs_dataset: Path, path: Path):
    text = (EXAMPLES / "emitted" / path.name).read_text(encoding="utf-8")
    for old, new in NUC_SUBSTITUTIONS.items():
        text = text.replace(old, new)
    report = _validate(docs_dataset, text)
    assert report["valid"], report["errors"]
    assert report["errors"] == []


def test_docs_broad_rule_example_as_written_does_not_match_nitrogen_dw(docs_dataset: Path):
    """Documents the docs inconsistency: [DW_AB, NUC->G24N-H] cannot match a ¹⁵N DW_AB."""
    report = _validate(docs_dataset, (EXAMPLES / "03_broad_rule_exceptions.toml").read_text(encoding="utf-8"))
    assert any("No parameter matches selector [DW_AB, NUC->G24N-H]" in e["message"] for e in report["errors"])


def test_docs_qualified_reference_is_ambiguous_with_several_residues(docs_dataset: Path):
    """Documents docs inconsistency #2: the reference [R2_A, NUC->N] is not scoped to each target."""
    report = _validate(docs_dataset, (EXAMPLES / "04_selectors_constraints.toml").read_text(encoding="utf-8"))
    assert any("Constraint reference [R2_A, NUC->N] is ambiguous" in e["message"] for e in report["errors"])
