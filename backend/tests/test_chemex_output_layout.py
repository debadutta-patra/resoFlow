"""
Unit tests for ChemEx output layout detection (detect_layout).
"""

import tempfile
from pathlib import Path
import pytest

from app.services.fitting.chemex_output.layout import detect_layout

FIXTURES_ROOT = Path(__file__).parent / "fixtures" / "chemex_trees"


def test_detect_layout_legacy_fixtures():
    """Verify all 2026.6 committed fixtures are detected as v2026_6."""
    legacy_cases = [
        "single_step",
        "multi_step",
        "grid_fit",
        "stat_fit",
        "cest_step_grid",
    ]
    for case in legacy_cases:
        case_dir = FIXTURES_ROOT / case
        if case_dir.exists():
            layout = detect_layout(case_dir)
            assert layout == "v2026_6", f"Expected v2026_6 for {case}, got {layout}"


def test_detect_layout_v2026_9_by_run_toml():
    """Detect v2026_9 when run.toml specifies chemex 2026.9.2."""
    with tempfile.TemporaryDirectory() as tmp_dir:
        p = Path(tmp_dir)
        run_info = p / "run_info"
        run_info.mkdir(parents=True)
        (run_info / "run.toml").write_text(
            '[chemex]\nversion = "2026.9.2"\n', encoding="utf-8"
        )
        assert detect_layout(p) == "v2026_9"


def test_detect_layout_v2026_9_by_outcome_toml():
    """Detect v2026_9 when outcome.toml exists even without run.toml version."""
    with tempfile.TemporaryDirectory() as tmp_dir:
        p = Path(tmp_dir)
        run_info = p / "run_info"
        run_info.mkdir(parents=True)
        (run_info / "outcome.toml").write_text(
            'schema_version = 2\nstatus = "complete"\n', encoding="utf-8"
        )
        assert detect_layout(p) == "v2026_9"


def test_detect_layout_v2026_9_by_grid_summary():
    """Detect v2026_9 when Grid/summary.toml exists."""
    with tempfile.TemporaryDirectory() as tmp_dir:
        p = Path(tmp_dir)
        grid_dir = p / "Grid"
        grid_dir.mkdir(parents=True)
        (grid_dir / "summary.toml").write_text('status = "complete"\n', encoding="utf-8")
        assert detect_layout(p) == "v2026_9"


def test_detect_layout_probe_groups_all():
    """Probe Groups/ or All/ falls back to v2026_6."""
    with tempfile.TemporaryDirectory() as tmp_dir:
        p = Path(tmp_dir)
        (p / "Groups").mkdir()
        assert detect_layout(p) == "v2026_6"

    with tempfile.TemporaryDirectory() as tmp_dir:
        p = Path(tmp_dir)
        step = p / "STEP1"
        (step / "All").mkdir(parents=True)
        assert detect_layout(p) == "v2026_6"
