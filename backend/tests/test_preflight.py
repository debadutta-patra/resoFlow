from pathlib import Path
import pytest
from resoflow.preflight import build_sharing_map

def test_preflight_build_sharing_map():
    fixtures_dir = Path(__file__).parent / "fixtures" / "baselines" / "2026.6.1" / "cpmg_15n_ip" / "inputs"
    exp_files = sorted(list((fixtures_dir / "Experiments").glob("*.toml")))
    param_files = sorted(list((fixtures_dir / "Parameters").glob("*.toml")))
    assert len(exp_files) > 0
    assert len(param_files) > 0

    result = build_sharing_map(exp_files, param_files, model="2st")
    assert "parameters" in result
    assert "warnings" in result
    assert len(result["parameters"]) > 0
