"""Unit tests for chemex_jobs::build_fit_spec."""

import tempfile
from pathlib import Path

from app.services.fitting.chemex_jobs import build_fit_spec


def test_build_fit_spec_ordering_and_defaults():
    with tempfile.TemporaryDirectory() as tmp_dir:
        job_dir = Path(tmp_dir)
        exp_dir = job_dir / "Experiments"
        exp_dir.mkdir()
        # Create multiple experiment tomls out of alphabetical order
        (exp_dir / "exp_b.toml").write_text("# exp b")
        (exp_dir / "exp_a.toml").write_text("# exp a")
        (exp_dir / "exp_c.toml").write_text("# exp c")

        param_dir = job_dir / "Parameters"
        param_dir.mkdir()
        (param_dir / "parameters.toml").write_text("pb = 0.05\n")

        method_dir = job_dir / "Methods"
        method_dir.mkdir()
        (method_dir / "method.toml").write_text("[step1]\nfit = true\n")

        dirs = {
            "experiments_dir": exp_dir,
            "parameters_dir": param_dir,
            "methods_dir": method_dir,
            "output_dir": job_dir / "Output",
        }
        config = {
            "analysis_uuid": "test-uuid-123",
            "model": "2st",
            "include": [10, "15N"],
            "exclude": [40],
        }

        spec = build_fit_spec(dirs, config, job_dir=job_dir)

        assert spec.job_id == "test-uuid-123"
        assert spec.model == "2st"
        assert spec.experiment_files == [
            "Experiments/exp_a.toml",
            "Experiments/exp_b.toml",
            "Experiments/exp_c.toml",
        ]
        assert spec.parameter_files == ["Parameters/parameters.toml"]
        assert spec.method_files == ["Methods/method.toml"]
        assert spec.output_dir == "Output"
        assert spec.include == ["10", "15N"]
        assert spec.exclude == ["40"]


def test_build_fit_spec_omits_empty_param_and_method():
    with tempfile.TemporaryDirectory() as tmp_dir:
        job_dir = Path(tmp_dir)
        exp_dir = job_dir / "Experiments"
        exp_dir.mkdir()
        (exp_dir / "exp_1.toml").write_text("# exp 1")

        param_dir = job_dir / "Parameters"
        param_dir.mkdir()
        # Empty parameters.toml
        (param_dir / "parameters.toml").write_text("")

        method_dir = job_dir / "Methods"
        method_dir.mkdir()
        # Empty method.toml
        (method_dir / "method.toml").write_text("   \n")

        dirs = {
            "experiments_dir": exp_dir,
            "parameters_dir": param_dir,
            "methods_dir": method_dir,
            "output_dir": job_dir / "Output",
        }
        config = {"model": "3st"}

        spec = build_fit_spec(dirs, config, job_dir=job_dir)

        assert spec.experiment_files == ["Experiments/exp_1.toml"]
        assert spec.parameter_files == []
        assert spec.method_files == []
        assert spec.model == "3st"
