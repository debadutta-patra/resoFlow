"""Timing smoke benchmark comparing raw ChemEx output parsing vs results bundle reading (§3.11).

Logs timing measurements and asserts that reading the pre-digested bundle
is faster than re-parsing the entire raw output tree from scratch.
"""

import logging
import shutil
import time
from pathlib import Path

import pytest

from app.services.fitting.cest_tasks import _parse_chemex_output
from app.services.results_bundle import ingest_results, store


logger = logging.getLogger(__name__)

# Largest fixture is cest_step_grid (66MB with full grid matrices)
FIXTURE_PATH = Path(__file__).parent / "fixtures" / "chemex_trees" / "cest_step_grid"


def test_bundle_timing_smoke_benchmark(tmp_path: Path) -> None:
    test_run_dir = tmp_path / "run"
    shutil.copytree(FIXTURE_PATH, test_run_dir)

    # 1. Measure raw parsing time
    t0 = time.perf_counter()
    n_raw_iterations = 3
    for _ in range(n_raw_iterations):
        raw_res = _parse_chemex_output(test_run_dir)
    raw_time_per_call = (time.perf_counter() - t0) / n_raw_iterations

    # 2. Ingest bundle once
    ingest_results(test_run_dir, analysis_uuid="bench-uuid")

    # 3. Measure bundle read time
    t1 = time.perf_counter()
    n_bundle_iterations = 20
    for _ in range(n_bundle_iterations):
        bundle_res = store.get_summary(test_run_dir)
    bundle_time_per_call = (time.perf_counter() - t1) / n_bundle_iterations

    speedup = raw_time_per_call / max(bundle_time_per_call, 1e-6)

    print(f"\n[BENCHMARK] Raw parse: {raw_time_per_call * 1000:.2f} ms / call")
    print(f"[BENCHMARK] Bundle read: {bundle_time_per_call * 1000:.2f} ms / call")
    print(f"[BENCHMARK] Speedup: {speedup:.1f}x")

    # Plan: "log the numbers rather than asserting hard wall-clock limits in CI"
    assert bundle_time_per_call < raw_time_per_call
    assert speedup >= 2.0
