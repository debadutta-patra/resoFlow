"""Reports built from a cached results bundle, and concurrent ingests of one run.

Regression for an interactive report that failed with "list indices must be integers
or slices, not tuple": the cached report_model.json stores resampling replicates as
JSON lists, and report code slices them column-wise.
"""

import multiprocessing
import shutil
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

from app.services.reporting.model import ReportModel, build_report_model, resampled_from_dict
from app.services.reporting.render import build_kinetic_data, render_html
from app.services.results_bundle.ingest import ingest_results
from app.services.results_bundle.store import is_bundle_valid

FIXTURE = Path(__file__).parent / "fixtures" / "chemex_trees_2026_9" / "cest_step_grid"


def _ingested_copy(tmp_path: Path) -> Path:
    run = tmp_path / "run"
    shutil.copytree(FIXTURE, run)
    ingest_results(run, analysis_uuid="u")
    assert (run / "results" / "report_model.json").is_file()
    return run


def test_resampled_from_dict_restores_arrays():
    restored = resampled_from_dict(
        {"MCMC": {"parameter_names": ["[PB]", "[KEX_AB]"], "replicates": [[0.1, 100.0], [0.2, 200.0]], "chisqr": [1.0, 2.0], "is_mcmc": True}}
    )
    reps = restored["MCMC"]["replicates"]
    assert isinstance(reps, np.ndarray) and reps.shape == (2, 2)
    assert list(reps[:, 1]) == [100.0, 200.0]
    assert isinstance(restored["MCMC"]["chisqr"], np.ndarray)
    assert restored["MCMC"]["is_mcmc"] is True
    assert resampled_from_dict(None) == {}


def test_kinetic_plot_from_deserialized_model():
    model = ReportModel.from_dict(
        {
            "analysis_name": "x",
            "resampled": {
                "MCMC": {
                    "parameter_names": ["[PB]", "[KEX_AB]"],
                    "replicates": [[0.05 + 0.001 * i, 300.0 + i] for i in range(50)],
                }
            },
        }
    )
    assert build_kinetic_data(model) is not None


def test_report_renders_from_cached_bundle(tmp_path):
    run = _ingested_copy(tmp_path)
    model = build_report_model(analysis_dir=run, analysis_name="cached", analysis_type="CEST")
    for resampled in [model.resampled, *(s.resampled for s in model.steps)]:
        for entry in resampled.values():
            assert isinstance(entry["replicates"], np.ndarray)
    assert "<html" in render_html(model, style="screen").lower()


def test_concurrent_ingests_of_one_run_all_succeed(tmp_path):
    run = tmp_path / "run"
    shutil.copytree(FIXTURE, run)
    with ProcessPoolExecutor(max_workers=3, mp_context=multiprocessing.get_context("spawn")) as pool:
        results = [f.result() for f in [pool.submit(ingest_results, str(run), "u") for _ in range(3)]]
    assert all(r["status"] == "complete" for r in results)
    assert is_bundle_valid(run)
    assert not (run / "results.tmp").exists()
    assert not (run / "results.old").exists()


def test_queued_duplicate_ingest_reuses_current_bundle(tmp_path):
    run = _ingested_copy(tmp_path)
    manifest = (run / "results" / "manifest.json").read_text()
    meta = ingest_results(run, analysis_uuid="u", skip_if_current=True)
    assert meta["status"] == "complete" and meta.get("reused") is True
    assert meta["summary_n_residues"] > 0
    assert (run / "results" / "manifest.json").read_text() == manifest  # not rebuilt


def test_damaged_bundle_is_invalid_and_rebuilt(tmp_path):
    run = _ingested_copy(tmp_path)
    (run / "results" / "summary.json").unlink()  # what the ingest race left behind
    (run / "results" / "results.sqlite").unlink()
    assert not is_bundle_valid(run)
    meta = ingest_results(run, analysis_uuid="u", skip_if_current=True)
    assert "reused" not in meta
    assert is_bundle_valid(run)
