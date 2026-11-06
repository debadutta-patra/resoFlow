"""Parity test: asserting that v1 method emission and v2 method emission produce identical fits under ChemEx 2026.9.2."""

import shutil
from pathlib import Path
from typing import Sequence
import numpy as np
import pytest

from app.services.fitting.method_emitter import (
    MethodConfigModel,
    MethodStepModel,
    ParamSettingModel,
    emit_method_toml_v1,
    emit_method_toml_v2,
)
from resoflow.chemex_api.fit import run_fit
from resoflow.chemex_api.spec import FitJobSpec


PRESETS = [
    (
        "2st_standard",
        MethodConfigModel(
            steps=[
                MethodStepModel(
                    name="STEP1",
                    parameters=[
                        ParamSettingModel(name="PB", mode="fit"),
                        ParamSettingModel(name="KEX_AB", mode="fit"),
                        ParamSettingModel(name="DW_AB", mode="fit"),
                        ParamSettingModel(name="CS_A", mode="fit"),
                        ParamSettingModel(name="R1_A", mode="fix"),
                        ParamSettingModel(name="R2_A", mode="fix"),
                        ParamSettingModel(name="R1_B", mode="constrain", expression="[R1_A]"),
                        ParamSettingModel(name="R2_B", mode="constrain", expression="[R2_A]"),
                    ],
                    residue_mode="include",
                    residues=["13N"],
                )
            ]
        ),
        "cest_15n",
        ["13N"],
    ),
    (
        "grid_and_refine",
        MethodConfigModel(
            steps=[
                MethodStepModel(
                    name="GRID_SEARCH",
                    parameters=[
                        ParamSettingModel(
                            name="PB",
                            mode="grid",
                            grid={"min": 0.01, "max": 0.25, "steps": 5, "scale": "lin"},
                        ),
                        ParamSettingModel(
                            name="KEX_AB",
                            mode="grid",
                            grid={"min": 50.0, "max": 1000.0, "steps": 5, "scale": "lin"},
                        ),
                        ParamSettingModel(name="DW_AB", mode="fit"),
                    ],
                    residue_mode="include",
                    residues=["15N"],
                ),
                MethodStepModel(
                    name="REFINEMENT",
                    parameters=[
                        ParamSettingModel(name="PB", mode="fit"),
                        ParamSettingModel(name="KEX_AB", mode="fit"),
                        ParamSettingModel(name="DW_AB", mode="fit"),
                    ],
                    residue_mode="include",
                    residues=["15N"],
                ),
            ]
        ),
        "cpmg_15n_ip_grid",
        ["15N"],
    ),
]


@pytest.mark.parametrize("preset_name,config,case_name,include", PRESETS)
def test_method_v1_v2_parity(
    tmp_path: Path,
    preset_name: str,
    config: MethodConfigModel,
    case_name: str,
    include: Sequence[str],
):
    fixture_dir = (
        Path(__file__).resolve().parent.parent
        / "fixtures"
        / "baselines"
        / "2026.6.1"
        / case_name
        / "inputs"
    )
    if not fixture_dir.exists():
        pytest.skip(f"Baseline inputs for {case_name} not found.")

    dir_v1 = tmp_path / "v1"
    dir_v2 = tmp_path / "v2"
    shutil.copytree(fixture_dir, dir_v1)
    shutil.copytree(fixture_dir, dir_v2)

    # Emit v1 into dir_v1/Methods/method.toml
    (dir_v1 / "Methods").mkdir(parents=True, exist_ok=True)
    toml_v1 = emit_method_toml_v1(config)
    (dir_v1 / "Methods" / "method.toml").write_text(toml_v1, encoding="utf-8")

    # Emit v2 into dir_v2/Methods/method.toml
    (dir_v2 / "Methods").mkdir(parents=True, exist_ok=True)
    toml_v2 = emit_method_toml_v2(config)
    (dir_v2 / "Methods" / "method.toml").write_text(toml_v2, encoding="utf-8")

    exp_files = [f"Experiments/{f.name}" for f in sorted((dir_v1 / "Experiments").glob("*.toml"))]
    param_files = [f"Parameters/{f.name}" for f in sorted((dir_v1 / "Parameters").glob("*.toml"))]
    method_files = ["Methods/method.toml"]

    spec_v1 = FitJobSpec(
        job_id="test_v1",
        experiment_files=exp_files,
        parameter_files=param_files,
        method_files=method_files,
        model="2st",
        include=list(include),
        output_dir="Output",
    )
    spec_v2 = FitJobSpec(
        job_id="test_v2",
        experiment_files=exp_files,
        parameter_files=param_files,
        method_files=method_files,
        model="2st",
        include=list(include),
        output_dir="Output",
    )

    res_v1 = run_fit(spec_v1, job_dir=dir_v1)
    res_v2 = run_fit(spec_v2, job_dir=dir_v2)

    assert res_v1.exit_code == 0, f"v1 fit failed: {res_v1.error}"
    assert res_v2.exit_code == 0, f"v2 fit failed: {res_v2.error}"

    # Verify both produced identical final values
    assert res_v1.final_values, "res_v1 returned empty final_values"
    assert res_v2.final_values, "res_v2 returned empty final_values"

    for key in res_v1.final_values:
        assert key in res_v2.final_values, f"Key {key} missing from v2 results"
        val_v1 = res_v1.final_values[key]
        val_v2 = res_v2.final_values[key]
        np.testing.assert_allclose(
            val_v1,
            val_v2,
            rtol=1e-12,
            atol=1e-12,
            err_msg=f"Discrepancy for parameter {key} between v1 and v2 method runs",
        )
