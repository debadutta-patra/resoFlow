"""Tests for atomic ingest of results bundle (§3.11).

Verifies that if ingestion fails or crashes at any point:
1. No partial results/ directory is left behind.
2. Temporary directory results.tmp/ is cleaned up.
3. Raw ChemEx files remain completely untouched.
4. Any pre-existing results/ bundle is preserved intact.
"""

import shutil
from pathlib import Path
from unittest.mock import patch

import pytest

from app.services.results_bundle.ingest import ingest_results
from app.services.results_bundle.store import is_bundle_valid


FIXTURE_PATH = Path(__file__).parent / "fixtures" / "chemex_trees_2026_9" / "cest_step_grid"


def test_ingest_atomic_failure_cleans_up(tmp_path: Path) -> None:
    test_run_dir = tmp_path / "run"
    shutil.copytree(FIXTURE_PATH, test_run_dir)

    # Snapshot raw directory before ingest
    raw_files_before = sorted(p.relative_to(test_run_dir) for p in test_run_dir.rglob("*"))

    # Force a failure midway through ingest (patch compute_bundle_fingerprint)
    with patch(
        "app.services.results_bundle.ingest.compute_bundle_fingerprint",
        side_effect=RuntimeError("Simulated mid-ingest explosion!"),
    ):
        with pytest.raises(RuntimeError, match="Simulated mid-ingest explosion!"):
            ingest_results(test_run_dir, analysis_uuid="fail-uuid")

    # 1. results/ directory must not exist
    assert not (test_run_dir / "results").exists()

    # 2. results.tmp/ directory must be cleaned up
    assert not (test_run_dir / "results.tmp").exists()

    # 3. Raw ChemEx files must be 100% untouched
    raw_files_after = sorted(p.relative_to(test_run_dir) for p in test_run_dir.rglob("*"))
    assert raw_files_before == raw_files_after


def test_ingest_atomic_failure_preserves_existing_bundle(tmp_path: Path) -> None:
    test_run_dir = tmp_path / "run"
    shutil.copytree(FIXTURE_PATH, test_run_dir)

    # First do a successful ingest
    meta = ingest_results(test_run_dir, analysis_uuid="good-uuid")
    assert is_bundle_valid(test_run_dir)
    manifest_before = (test_run_dir / "results" / "manifest.json").read_text()

    # Now attempt a re-ingest that fails mid-way
    with patch(
        "app.services.results_bundle.ingest.compute_bundle_fingerprint",
        side_effect=RuntimeError("Re-ingest failed!"),
    ):
        with pytest.raises(RuntimeError, match="Re-ingest failed!"):
            ingest_results(test_run_dir, analysis_uuid="good-uuid")

    # The original results/ directory must still exist and be valid
    assert (test_run_dir / "results").exists()
    assert is_bundle_valid(test_run_dir)
    assert not (test_run_dir / "results.tmp").exists()
    assert not (test_run_dir / "results.old").exists()
    assert (test_run_dir / "results" / "manifest.json").read_text() == manifest_before
