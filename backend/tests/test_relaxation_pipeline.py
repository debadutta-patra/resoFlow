import os
import json
import pytest
import numpy as np
from unittest.mock import MagicMock
from fastapi import HTTPException

from app.services.fitting.relaxation import (
    parse_vdlist,
    parse_vclist,
    get_relaxation_times,
    fit_exponential_decay,
)
from app.routers.analysis import run_analysis
from app import schemas

def test_parse_vdlist(tmp_path):
    vd_file = tmp_path / "t1_vdlist"
    vd_file.write_text("10m\n50m\n100m\n1.5s\n2000m\n")
    delays = parse_vdlist(str(vd_file))
    assert len(delays) == 5
    assert np.isclose(delays[0], 0.010)
    assert np.isclose(delays[1], 0.050)
    assert np.isclose(delays[2], 0.100)
    assert np.isclose(delays[3], 1.5)
    assert np.isclose(delays[4], 2.0)

def test_parse_vclist(tmp_path):
    vc_file = tmp_path / "t2_vclist"
    vc_file.write_text("1\n2\n4\n8\n")
    delays = parse_vclist(str(vc_file), delay=0.0167)
    assert len(delays) == 4
    assert np.isclose(delays[0], 0.0167)
    assert np.isclose(delays[1], 0.0334)
    assert np.isclose(delays[2], 0.0668)
    assert np.isclose(delays[3], 0.1336)

def test_get_relaxation_times_t1_and_r1(tmp_path):
    vd_file = tmp_path / "vdlist"
    vd_file.write_text("10m\n100m\n500m\n1s\n")
    
    # Mock spectrum with T1
    s_t1 = MagicMock()
    s_t1.experiment_type = "T1"
    s_t1.vdlist_path = str(vd_file)
    s_t1.vclist_path = None
    s_t1.delay = None
    times_t1 = get_relaxation_times(s_t1)
    assert times_t1 is not None
    assert len(times_t1) == 4

    # Mock spectrum with R1 (uppercase/lowercase)
    s_r1 = MagicMock()
    s_r1.experiment_type = "r1"
    s_r1.vdlist_path = str(vd_file)
    s_r1.vclist_path = None
    s_r1.delay = None
    times_r1 = get_relaxation_times(s_r1)
    assert times_r1 is not None
    assert len(times_r1) == 4

def test_get_relaxation_times_t2_and_r2(tmp_path):
    vc_file = tmp_path / "vclist"
    vc_file.write_text("2\n4\n6\n")
    vd_file = tmp_path / "vdlist"
    vd_file.write_text("0.02\n0.04\n0.06\n")

    # T2 with VC list
    s_t2 = MagicMock()
    s_t2.experiment_type = "T2"
    s_t2.vclist_path = str(vc_file)
    s_t2.vdlist_path = None
    s_t2.delay = 0.01
    times_t2 = get_relaxation_times(s_t2)
    assert times_t2 is not None
    assert np.allclose(times_t2, [0.02, 0.04, 0.06])

    # R2 with direct VD list
    s_r2 = MagicMock()
    s_r2.experiment_type = "R2"
    s_r2.vclist_path = None
    s_r2.vdlist_path = str(vd_file)
    s_r2.delay = None
    times_r2 = get_relaxation_times(s_r2)
    assert times_r2 is not None
    assert np.allclose(times_r2, [0.02, 0.04, 0.06])

def test_fit_exponential_decay():
    times = np.array([0.01, 0.05, 0.1, 0.2, 0.5, 1.0])
    true_amp = 1000.0
    true_rate = 2.5
    intensities = true_amp * np.exp(-true_rate * times)
    
    result = fit_exponential_decay(times, intensities)
    assert np.isclose(result.params['amplitude'].value, true_amp, rtol=1e-2)
    assert np.isclose(result.params['rate'].value, true_rate, rtol=1e-2)

def test_preflight_validation_missing_delay_list(tmp_path):
    db = MagicMock()
    analysis = MagicMock()
    analysis.analysis_type = "R1"
    analysis.parameters = "{}"

    spectrum = MagicMock()
    spectrum.id = 1
    spectrum.name = "spec1.ft2"
    spectrum.experiment_type = "R1"
    spectrum.results_json_path = str(tmp_path / "results.json")
    (tmp_path / "results.json").write_text(json.dumps({"results": []}))
    spectrum.vdlist_path = None
    spectrum.vclist_path = None
    spectrum.delay = None

    db.query().filter().all.return_value = [spectrum]

    req = schemas.AnalysisRunRequest(spectrum_ids=[1], workers=1)
    with pytest.raises(HTTPException) as exc_info:
        run_analysis(req, analysis=analysis, db=db)
    assert exc_info.value.status_code == 400
    assert "Missing VD List" in exc_info.value.detail


def test_validate_relaxation_spectrum_wrong_vclist(tmp_path):
    from app.services.fitting.relaxation import validate_relaxation_spectrum

    spec = MagicMock()
    spec.name = "spec_r2"
    spec.experiment_type = "R2"
    spec.vdlist_path = None
    spec.vclist_path = "/non/existent/path/to/vclist"
    spec.delay = 0.0167

    # Non-existent vclist path
    err = validate_relaxation_spectrum(spec, "R2")
    assert err is not None
    assert "VC List file not found" in err
    assert "/non/existent/path/to/vclist" in err

    # Existing vclist path but missing delay
    vc_file = tmp_path / "vclist"
    vc_file.write_text("0\n2\n4\n8\n")
    spec.vclist_path = str(vc_file)
    spec.delay = 0.0

    err = validate_relaxation_spectrum(spec, "R2")
    assert err is not None
    assert "Delay value must be greater than 0" in err

    # Valid vclist and delay
    spec.delay = 0.0167
    err = validate_relaxation_spectrum(spec, "R2")
    assert err is None
