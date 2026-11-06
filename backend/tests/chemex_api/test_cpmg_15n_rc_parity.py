"""Parity and registration test for custom cpmg_15n_rc experiment plugin."""

from __future__ import annotations

import shutil
from pathlib import Path
import numpy as np
import pytest

from chemex.experiments.experiment_types import registered_experiment_types
from app.services.fitting.chemex_registry import get_chemex_module_registry, get_module_schema
from resoflow.chemex_api import FitJobSpec, run_simulation
from resoflow.chemex_api.plugins import ensure_registered, registered_plugins
from tests.parity.compare_trees import parse_dat_or_fit_file


def test_cpmg_15n_rc_registration():
    """Verify that cpmg_15n_rc is properly registered and present in registries."""
    ensure_registered()
    assert "cpmg_15n_rc" in registered_plugins()
    assert "cpmg_15n_rc" in registered_experiment_types()
    
    registry = get_chemex_module_registry()
    assert "cpmg_15n_rc" in registry
    
    schema = get_module_schema("cpmg_15n_rc")
    assert schema is not None
    assert schema["family"] == "cpmg"
    assert schema["probe"] == "15N"
    assert schema["spin_system_format"]["format"] == "two_spin_15n_1h"
    exp_fields = schema["sections"]["experiment"]["fields"]
    assert "time_t2" in exp_fields
    assert "carrier" in exp_fields
    assert "pw90" in exp_fields
    assert "ncyc_max" in exp_fields
    assert "taub" in exp_fields


def test_cpmg_15n_rc_simulation_parity(tmp_path: Path):
    """Verify simulation parity against the 2026.6.1 baseline at fixed fitted parameters."""
    ensure_registered()
    
    repo_root = Path(__file__).resolve().parents[3]
    baseline_dir = repo_root / "backend" / "tests" / "fixtures" / "baselines" / "2026.6.1" / "cpmg_15n_rc"
    inputs_dir = baseline_dir / "inputs"
    baseline_output = baseline_dir / "output"
    
    # Setup job dir
    shutil.copytree(inputs_dir / "Experiments", tmp_path / "Experiments")
    shutil.copytree(inputs_dir / "data", tmp_path / "data")
    shutil.copytree(inputs_dir / "Parameters", tmp_path / "Parameters")
    shutil.copytree(inputs_dir / "Methods", tmp_path / "Methods")
    
    fitted_toml = (baseline_output / "Parameters" / "fitted.toml").read_text(encoding="utf-8")
    (tmp_path / "Parameters" / "fitted.toml").write_text(fitted_toml, encoding="utf-8")
    
    spec = FitJobSpec(
        experiment_files=["Experiments/exp_600MHz.toml"],
        parameter_files=["Parameters/parameters.toml", "Parameters/fitted.toml"],
        method_files=["Methods/method.toml"],
        model="2st",
        include=["32N", "55N", "65N"],
        output_dir="sim_output",
        plot="nothing",
    )
    
    run_simulation(spec, job_dir=tmp_path)
    
    sim_dat_file = tmp_path / "sim_output" / "Data" / "exp_600MHz.dat"
    assert sim_dat_file.exists(), "Simulation must write Data/exp_600MHz.dat"
    
    sim_data = parse_dat_or_fit_file(sim_dat_file)
    base_data = parse_dat_or_fit_file(baseline_output / "Data" / "exp_600MHz.dat")
    
    for sec in ["32N-H", "55N-H", "65N-H"]:
        assert sec in sim_data, f"Section {sec} missing in simulation output"
        assert sec in base_data, f"Section {sec} missing in baseline output"
        sim_rows = np.array(sim_data[sec])
        base_rows = np.array(base_data[sec])
        
        # Col 0: NCYC
        np.testing.assert_allclose(sim_rows[:, 0], base_rows[:, 0], rtol=1e-12)
        
        # Col 1: INTENSITY (CALC) in simulation vs Col 3: INTENSITY (CALC) in baseline fit
        # Note: baseline fit used in-memory unrounded parameters while fitted.toml has 6-digit rounding;
        # tolerance of 5e-6 covers the rounding of float text representations.
        calc_sim = sim_rows[:, 1]
        calc_base = base_rows[:, 3]
        np.testing.assert_allclose(calc_sim, calc_base, rtol=5e-6, atol=1e-6)
