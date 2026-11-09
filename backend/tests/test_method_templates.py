"""Every Methods-page template (and each addition applied to a method) is a valid ChemEx v2
method: pinned emitted TOML (frontend/src/lib/methodTemplates.contract.test.ts keeps it in
step with the templates), backend parse → emit fixed point, and ChemEx validation against
the cest_15n inputs (3-state templates: ChemEx parsing only)."""

from __future__ import annotations

import json
import shutil
import tempfile
from pathlib import Path

import pytest
from chemex.configuration.methods import read_method_plan

from app.services.fitting.method_emitter import emit_method_toml_v2, parse_method_toml
from resoflow.chemex_api.roles import validate_method
from resoflow.chemex_api.spec import FitJobSpec

HERE = Path(__file__).parent
ENTRIES = json.loads((HERE / "fixtures" / "method_contract" / "templates_emitted.json").read_text())
CEST = HERE / "fixtures" / "baselines" / "2026.6.1" / "cest_15n" / "inputs"


@pytest.mark.parametrize("entry", ENTRIES, ids=lambda e: e["id"])
def test_template_round_trips_and_is_read_by_chemex(entry):
    toml = entry["toml"]
    assert emit_method_toml_v2(parse_method_toml(toml)) == toml
    with tempfile.TemporaryDirectory() as td:
        path = Path(td) / "method.toml"
        path.write_text(toml, encoding="utf-8")
        assert read_method_plan([path]).format_origin.value == "v2"


@pytest.mark.parametrize("entry", [e for e in ENTRIES if e["model"] == "2st"], ids=lambda e: e["id"])
def test_two_state_templates_pass_chemex_validation_on_data(entry, tmp_path: Path):
    if not CEST.exists():
        pytest.skip("cest_15n inputs not found")
    for sub in ("Data", "Experiments", "Parameters"):
        shutil.copytree(CEST / sub, tmp_path / sub)
    (tmp_path / "Methods").mkdir()
    method = tmp_path / "Methods" / "method.toml"
    method.write_text(entry["toml"], encoding="utf-8")
    spec = FitJobSpec(
        job_id="tmpl",
        experiment_files=[f"Experiments/{p.name}" for p in sorted((tmp_path / "Experiments").glob("*.toml"))],
        parameter_files=[f"Parameters/{p.name}" for p in sorted((tmp_path / "Parameters").glob("*.toml"))],
        method_files=[],
        model="2st",
        output_dir="Output",
    )
    report = validate_method(spec, method, tmp_path)
    assert report["valid"], report["errors"]
    assert all(s["error"] is None for s in report["steps"]), [s["error"] for s in report["steps"]]
    for s in report["steps"]:
        for axis in (s["search"] or {}).get("axes", []):
            assert axis["error"] is None, axis
