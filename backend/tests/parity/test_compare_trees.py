"""Test suite for compare_trees parity harness."""

from pathlib import Path
import pytest
from tests.parity.compare_trees import compare_trees, assert_trees_equal


FIXTURES_DIR = Path(__file__).resolve().parents[1] / "fixtures" / "chemex_trees"
BASELINES_DIR = Path(__file__).resolve().parents[1] / "fixtures" / "baselines" / "2026.6.1"


def test_compare_trees_identical_self():
    single_step = FIXTURES_DIR / "single_step"
    if not single_step.is_dir():
        pytest.skip("single_step fixture directory not found")

    is_equal, diffs = compare_trees(single_step, single_step)
    assert is_equal, f"Expected tree to match itself, got diffs:\n" + "\n".join(diffs)
    assert len(diffs) == 0


def test_assert_trees_equal_self():
    single_step = FIXTURES_DIR / "single_step"
    if not single_step.is_dir():
        pytest.skip("single_step fixture directory not found")

    assert_trees_equal(single_step, single_step)


def test_compare_trees_different():
    single_step = FIXTURES_DIR / "single_step"
    grid_fit = FIXTURES_DIR / "grid_fit"
    if not single_step.is_dir() or not grid_fit.is_dir():
        pytest.skip("fixtures not found")

    is_equal, diffs = compare_trees(single_step, grid_fit)
    assert not is_equal
    assert len(diffs) > 0


@pytest.mark.parametrize(
    "case_dir",
    [p for p in BASELINES_DIR.iterdir() if p.is_dir()] if BASELINES_DIR.is_dir() else [],
    ids=lambda p: p.name,
)
def test_baseline_matches_self(case_dir: Path):
    out_dir = case_dir / "output"
    if not out_dir.is_dir():
        pytest.skip(f"Output directory not found in {case_dir}")

    assert_trees_equal(out_dir, out_dir)
