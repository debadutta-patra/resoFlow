"""Per-step resolved roles, computed by ChemEx (resoflow.chemex_api.roles), on the cest_15n inputs.

Cases follow the ChemEx v2 method-file docs: broad rule followed by specific
exceptions, ROLES_FROM chaining, step-local selection, and protected parameters.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from resoflow.chemex_api.roles import resolve_roles
from resoflow.chemex_api.spec import FitJobSpec

FIXTURE = Path(__file__).resolve().parent.parent / "fixtures" / "baselines" / "2026.6.1" / "cest_15n" / "inputs"


@pytest.fixture
def resolve(tmp_path: Path):
    if not FIXTURE.exists():
        pytest.skip("cest_15n inputs not found")
    for sub in ("Data", "Experiments", "Parameters"):
        shutil.copytree(FIXTURE / sub, tmp_path / sub)
    spec = FitJobSpec(
        job_id="roles",
        experiment_files=[f"Experiments/{p.name}" for p in sorted((tmp_path / "Experiments").glob("*.toml"))],
        parameter_files=[f"Parameters/{p.name}" for p in sorted((tmp_path / "Parameters").glob("*.toml"))],
        method_files=[],
        model="2st",
        output_dir="Output",
    )

    def _run(method: str) -> dict:
        path = tmp_path / "method.toml"
        path.write_text(method, encoding="utf-8")
        return resolve_roles(spec, path, tmp_path)

    return _run


def _by_id(step: dict) -> dict[str, dict]:
    return {p["id"]: p for p in step["parameters"]}


def test_broad_rule_then_exceptions(resolve):
    """Docs example: fix every DW_AB, fit G24's, constrain G31's to it; list order is the precedence."""
    report = resolve(
        """FORMAT_VERSION = 2

[STEP]
ROLES = [
  { FIX = ["DW_AB"] },
  { FIT = ["DW_AB, NUC->26N"] },
  { CONSTRAIN = ["[DW_AB, NUC->28N] = [DW_AB, NUC->26N]"] },
]
"""
    )
    assert report["valid"], report["errors"]
    step = report["steps"][0]
    p = _by_id(step)

    assert p["__DW_AB_26N"]["role"] == "fit"
    assert p["__DW_AB_26N"]["rule"] == {"step": "STEP", "action_index": 1, "entry_index": 0, "action": "FIT", "inherited": False}

    assert p["__DW_AB_28N"]["role"] == "constrained"
    assert "DW_AB" in p["__DW_AB_28N"]["expression"] and "26N" in p["__DW_AB_28N"]["expression"]
    assert p["__DW_AB_28N"]["rule"]["action_index"] == 2

    others = [v for k, v in p.items() if k.startswith("__DW_AB_") and k not in ("__DW_AB_26N", "__DW_AB_28N")]
    assert others and all(v["role"] == "fix" and v["rule"]["action_index"] == 0 for v in others)

    # Parameters no rule touched keep their ChemEx baseline role, attributed to baseline/model.
    assert p["__PB"]["role"] == "fit" and p["__PB"]["decided_by"] == "baseline" and p["__PB"]["scope"] == "global"
    assert p["__DW_AB_26N"]["scope"] == "residue" and p["__DW_AB_26N"]["spin"]
    assert step["counts"]["constrained"] == 1


def test_roles_from_chaining_and_step_local_selection(resolve):
    """ROLES_FROM copies the effective role chain (transitively); selection is never inherited."""
    report = resolve(
        """FORMAT_VERSION = 2

[GLOBAL_FIT]
INCLUDE = [13, 26]
ROLES = [{ FIX = ["DW_AB"] }, { FIT = ["PB", "KEX_AB"] }]

[LOCAL_FITS]
ROLES_FROM = "GLOBAL_FIT"
ROLES = [{ FIX = ["PB", "KEX_AB"] }]

[REFINE]
ROLES_FROM = "LOCAL_FITS"
INCLUDE = [13]

[FRESH]
INCLUDE = [13]
"""
    )
    assert report["valid"], report["errors"]
    g, local, refine, fresh = report["steps"]

    # Selection is step-local: GLOBAL_FIT sees 2 residues, LOCAL_FITS (no INCLUDE) sees all.
    g_res = {p["spin"] for p in g["parameters"] if p["scope"] == "residue"}
    l_res = {p["spin"] for p in local["parameters"] if p["scope"] == "residue"}
    assert len(g_res) == 2 and len(l_res) > 2

    lp = _by_id(local)
    assert lp["__PB"]["role"] == "fix" and lp["__PB"]["rule"]["step"] == "LOCAL_FITS"
    # DW_AB stays fixed because LOCAL_FITS inherits GLOBAL_FIT's broad FIX.
    assert lp["__DW_AB_29N"]["role"] == "fix"
    assert lp["__DW_AB_29N"]["rule"] == {"step": "GLOBAL_FIT", "action_index": 0, "entry_index": 0, "action": "FIX", "inherited": True}

    # Chained: REFINE inherits LOCAL_FITS, which inherits GLOBAL_FIT.
    rp = _by_id(refine)
    assert rp["__PB"]["role"] == "fix" and rp["__PB"]["rule"]["step"] == "LOCAL_FITS" and rp["__PB"]["rule"]["inherited"]
    assert rp["__DW_AB_13N"]["role"] == "fix" and rp["__DW_AB_13N"]["rule"]["step"] == "GLOBAL_FIT"
    assert {p["spin"] for p in refine["parameters"] if p["scope"] == "residue"} == {p["spin"] for p in fresh["parameters"] if p["scope"] == "residue"}

    # No ROLES_FROM → baseline roles, not the previous step's.
    fp = _by_id(fresh)
    assert fp["__PB"]["role"] == "fit" and fp["__PB"]["rule"] is None
    assert fp["__DW_AB_13N"]["role"] == "fit"


def test_errors_carry_chemex_source_location(resolve):
    report = resolve(
        """FORMAT_VERSION = 2

[STEP1]
ROLES = [{ FIT = ["PB"] }]

[STEP2]
ROLES = [{ FIX = ["KEX_AB"] }, { FIT = ["DW_AB, NUC->26N, NUC->28N"] }]
"""
    )
    assert report["valid"] is False
    err = report["errors"][0]
    assert err["type"] == "MethodFormatError"
    assert "Duplicate selector qualifier NUC" in err["message"]
    assert err["source"]["step"] == "STEP2"
    assert err["source"]["field"] == "ROLES[1].FIT[0]"
    assert (err["source"]["action_index"], err["source"]["action"], err["source"]["entry_index"]) == (1, "FIT", 0)
    # Character span of the offending qualifier inside the entry text.
    entry = "DW_AB, NUC->26N, NUC->28N"
    assert entry[err["source"]["start"] : err["source"]["end"]] == "NUC->28N"


def test_protected_parameters_are_flagged_and_rejected(resolve):
    report = resolve('FORMAT_VERSION = 2\n\n[STEP]\nROLES = [{ FIT = ["KAB"] }]\n')
    assert report["valid"] is False
    assert any("model-owned" in e["message"] for e in report["errors"] + [s["error"] or {"message": ""} for s in report["steps"]])

    ok = resolve('FORMAT_VERSION = 2\n\n[STEP]\nROLES = [{ FIT = ["PB"] }]\n')
    kab = _by_id(ok["steps"][0])["__KAB"]
    assert kab["protected"] is True and kab["role"] == "derived" and kab["decided_by"] == "model"


def _axes(step: dict) -> list[dict]:
    return step["search"]["axes"]


def test_grid_axes_later_specific_replaces_broad_and_counts_points(resolve):
    report = resolve(
        """FORMAT_VERSION = 2

[STEP]
INCLUDE = [13, 26, 28]
ROLES = [{ FIT = ["PB", "DW_AB"] }]

[STEP.SEARCH.GRID]
AXES = [
  "[PB] = values(0.01, 0.02)",
  "[DW_AB] = lin(-5.0, 5.0, 3)",
  "[DW_AB, NUC->26N] = values(1.0, 2.0)",
]
"""
    )
    assert report["valid"], report["errors"]
    search = report["steps"][0]["search"]
    pb, broad, specific = search["axes"]
    assert pb["coordinates"] == ["__PB"] and pb["owned"] == 1 and pb["points"] == 2
    assert len(broad["coordinates"]) == 3 and broad["owned"] == 2  # 26N taken over by the later axis
    assert specific["coordinates"] == ["__DW_AB_26N"] and specific["owned"] == 1
    assert search["global_points"] == 2
    assert search["local_points"] == {"13N": 3, "26N": 2, "28N": 3}
    assert search["evaluations"] == 2 * (3 + 2 + 3)


def test_role_change_flags_only_the_invalidated_grid_axis(resolve):
    report = resolve(
        """FORMAT_VERSION = 2

[STEP]
INCLUDE = [13]
ROLES = [{ FIT = ["PB"] }, { FIX = ["DW_AB"] }]

[STEP.SEARCH.GRID]
AXES = ["[PB] = values(0.01, 0.02)", "[DW_AB] = lin(-5.0, 5.0, 3)"]
"""
    )
    pb, dw = _axes(report["steps"][0])
    assert pb["error"] is None
    assert "no active final independent FIT coordinate" in dw["error"]["message"]
    assert report["valid"] is False  # ChemEx's own validation agrees


def test_de_coordinates_must_resolve_to_one_fit_coordinate_within_bounds(resolve):
    report = resolve(
        """FORMAT_VERSION = 2

[STEP]
ROLES = [{ FIT = ["PB", "DW_AB"] }, { FIX = ["KEX_AB"] }]

[STEP.SEARCH.DE]
SEED = 18446744073709551615
COORDINATES = [
  "[DW_AB] = lin(-5.0, 5.0)",
  "[DW_AB, NUC->26N] = lin(-5.0, 5.0)",
  "[KEX_AB] = log(10.0, 500.0)",
  "[PB] = log(0.01, 5.0)",
]
"""
    )
    broad, single, fixed, wide = _axes(report["steps"][0])
    assert "exactly one" in broad["error"]["message"]
    assert single["error"] is None and single["coordinates"] == ["__DW_AB_26N"]
    assert "not a final independent FIT coordinate" in fixed["error"]["message"]
    assert "outside physical bounds" in wide["error"]["message"]
