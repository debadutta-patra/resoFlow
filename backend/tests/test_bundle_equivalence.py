"""Test Bundle Equivalence (§3.11, Phase 6).

Asserts that endpoint JSON derived from results bundle equals endpoint JSON
derived from the raw ChemEx output parser across all 2026.6 and 2026.9 fixtures.
"""

from __future__ import annotations

import math
import os
import shutil
from pathlib import Path
from typing import Any

import pytest

from app.services.fitting.cest_tasks import _parse_chemex_output
from app.services.results_bundle import ingest_results, is_bundle_valid, store

FIXTURE_ROOT_2026_6 = Path(__file__).parent / "fixtures" / "chemex_trees"
FIXTURE_ROOT_2026_9 = Path(__file__).parent / "fixtures" / "chemex_trees_2026_9"


def _clean_floats(obj: Any) -> Any:
    """Recursively clean NaN, inf, and normalize floats for deep comparison."""
    if obj is None:
        return None
    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            return None
        return round(obj, 6)
    if isinstance(obj, dict):
        return {k: _clean_floats(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_clean_floats(x) for x in obj]
    return obj


def _gather_fixture_dirs() -> list[tuple[str, Path]]:
    dirs = []
    for root in (FIXTURE_ROOT_2026_6, FIXTURE_ROOT_2026_9):
        if not root.is_dir():
            continue
        for child in sorted(root.iterdir()):
            if child.is_dir() and not child.name.startswith("."):
                # Must look like a run directory (has Output or STEP1 or run_info)
                has_run = (
                    (child / "Output").is_dir()
                    or (child / "STEP1").is_dir()
                    or (child / "run_info").is_dir()
                    or (child / "Parameters").is_dir()
                )
                if has_run:
                    dirs.append((f"{root.name}/{child.name}", child))
    return dirs


FIXTURE_CASES = _gather_fixture_dirs()


@pytest.mark.parametrize("case_id, fixture_path", FIXTURE_CASES)
def test_bundle_equivalence_with_raw_parser(case_id: str, fixture_path: Path, tmp_path: Path) -> None:
    """For every fixture tree, bundle summary JSON must deeply match raw parse JSON."""
    test_run_dir = tmp_path / "run"
    shutil.copytree(fixture_path, test_run_dir)

    # 1. Raw parse first
    raw_results = _parse_chemex_output(str(test_run_dir))

    # 2. Ingest bundle
    meta = ingest_results(test_run_dir, analysis_uuid="test-uuid")
    assert is_bundle_valid(test_run_dir)
    assert meta["status"] == "complete"

    # 3. Read back from bundle
    bundled_summary = store.get_summary(test_run_dir)

    # 4. Compare globals
    clean_raw_globals = _clean_floats(raw_results.get("global", {}))
    clean_bundle_globals = _clean_floats(bundled_summary.get("global", {}))

    for k, raw_v in clean_raw_globals.items():
        assert k in clean_bundle_globals, f"[{case_id}] Missing global param {k} in bundle"
        bundle_v = clean_bundle_globals[k]
        if raw_v is None:
            assert bundle_v is None, f"[{case_id}] Expected None for {k}, got {bundle_v}"
        else:
            assert math.isclose(raw_v, bundle_v, rel_tol=1e-4, abs_tol=1e-5), (
                f"[{case_id}] Global mismatch for {k}: raw={raw_v}, bundle={bundle_v}"
            )

    # 5. Compare residues
    clean_raw_residues = _clean_floats(raw_results.get("residues", {}))
    clean_bundle_residues = _clean_floats(bundled_summary.get("residues", {}))

    assert set(clean_raw_residues.keys()) == set(clean_bundle_residues.keys()), (
        f"[{case_id}] Residue key mismatch"
    )

    for res_name, raw_res_data in clean_raw_residues.items():
        bundle_res_data = clean_bundle_residues[res_name]
        raw_params = raw_res_data.get("parameters", {})
        bundle_params = bundle_res_data.get("parameters", {})

        for p_name, raw_p_val in raw_params.items():
            assert p_name in bundle_params, f"[{case_id}:{res_name}] Missing param {p_name}"
            bundle_p_val = bundle_params[p_name]
            if raw_p_val is None:
                assert bundle_p_val is None
            else:
                assert math.isclose(raw_p_val, bundle_p_val, rel_tol=1e-4, abs_tol=1e-5), (
                    f"[{case_id}:{res_name}] Param mismatch for {p_name}: raw={raw_p_val}, bundle={bundle_p_val}"
                )

    # 6. Verify SQLite table query
    if clean_bundle_residues:
        sample_res = next(iter(clean_bundle_residues.keys()))
        res_data = store.get_residue(test_run_dir, sample_res)
        assert res_data["residue"] == sample_res.strip().upper()
