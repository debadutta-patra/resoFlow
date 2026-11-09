"""In-process ChemEx work must be safe under a threaded server.

ChemEx resolves paths against the (process-wide) working directory; concurrent requests
used to chdir under each other and fail with "[Errno 2] No such file or directory".
Also: validation must use exactly the experiments a run would use (saved config), not
stale files left in the run directory by earlier generations.
"""

from __future__ import annotations

import shutil
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from app.services.fitting.chemex_workspace import stage_validation_workspace
from app.services.fitting.method_resolution import validate_method_for_analysis

CEST = Path(__file__).parent / "fixtures" / "baselines" / "2026.6.1" / "cest_15n" / "inputs"
METHOD = 'FORMAT_VERSION = 2\n\n[STEP]\nROLES = [{ FIT = ["PB", "KEX_AB"] }]\n'


@pytest.fixture
def run_dir(tmp_path: Path) -> Path:
    if not CEST.exists():
        pytest.skip("cest_15n inputs not found")
    for sub in ("Data", "Experiments", "Parameters"):
        shutil.copytree(CEST / sub, tmp_path / sub)
    return tmp_path


def test_concurrent_validations_do_not_break_each_other(run_dir: Path):
    def one(_):
        r = validate_method_for_analysis(run_dir, method_toml=METHOD, model="2st")
        return "ok" if r["valid"] else r["errors"][0]["message"]

    with ThreadPoolExecutor(6) as pool:
        results = list(pool.map(one, range(12)))
    assert results == ["ok"] * 12, results


def test_validation_uses_the_configured_experiments_not_stale_files(run_dir: Path):
    # A stale experiment from an older generation, of a type ChemEx does not know.
    (run_dir / "Experiments" / "old generation.toml").write_text(
        '[experiment]\nname = "15N CW CEST (15N • G2N)"\n', encoding="utf-8"
    )
    configured = [
        {"filename": "13hz.toml", "toml_content": (CEST / "Experiments" / "13hz.toml").read_text(encoding="utf-8")},
        {"filename": "../26hz.toml", "path": str(run_dir / "Experiments" / "26hz.toml")},  # name sanitised
        {"filename": "outside.toml", "path": "/etc/hostname"},  # outside the run dir: ignored
    ]
    with tempfile.TemporaryDirectory() as td:
        spec = stage_validation_workspace(run_dir, Path(td), experiments=configured, stage_methods=False)
        assert spec.experiment_files == ["Experiments/13hz.toml", "Experiments/26hz.toml"]

    report = validate_method_for_analysis(run_dir, method_toml=METHOD, model="2st", experiments=configured)
    assert report["valid"], report["errors"]

    stale = validate_method_for_analysis(run_dir, method_toml=METHOD, model="2st")  # folder fallback
    assert stale["valid"] is False and "Unknown Experiment Type" in stale["errors"][0]["message"]
