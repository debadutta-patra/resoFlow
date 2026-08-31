"""
Integration test running ChemEx with STATISTICS block emitted by method_emitter
and validating extraction via statistics_parser.
"""

import subprocess
from pathlib import Path
import pytest
from app.services.fitting.method_emitter import (
    MethodConfigModel,
    MethodStepModel,
    ParamSettingModel,
    StatisticsModel,
    emit_method_toml,
)
from app.services.fitting.statistics_parser import parse_statistics_directory


def test_chemex_monte_carlo_end_to_end(tmp_path: Path):
    """
    Run an actual mini ChemEx fitting run with 2 Monte Carlo replicates on residue 15.
    Verifies that ChemEx parses our emitted method.toml, performs MC refits,
    and our statistics_parser correctly ingests the outputs.
    """
    example_root = Path("/home/debadutta/Documents/ChemEx/examples/Experiments/CPMG_15N_IP")
    if not example_root.is_dir():
        pytest.skip("ChemEx example directory not available.")

    # 1. Emit method TOML with Monte Carlo replicates = 2 on residue 15
    config = MethodConfigModel(
        steps=[
            MethodStepModel(
                name="STEP1",
                parameters=[
                    ParamSettingModel(name="PB", mode="fit"),
                    ParamSettingModel(name="KEX_AB", mode="fit"),
                ],
                residue_mode="include",
                residues=[15],
                statistics=StatisticsModel(mc=2),
            )
        ]
    )
    method_toml_str = emit_method_toml(config)
    method_file = tmp_path / "method.toml"
    method_file.write_text(method_toml_str)

    output_dir = tmp_path / "Output"

    # 2. Run ChemEx CLI
    cmd = [
        "chemex",
        "fit",
        "-e",
        str(example_root / "Experiments" / "500mhz.toml"),
        str(example_root / "Experiments" / "800mhz.toml"),
        "-p",
        str(example_root / "Parameters" / "parameters.toml"),
        "-m",
        str(method_file),
        "-o",
        str(output_dir),
    ]

    proc = subprocess.run(cmd, cwd=str(example_root), capture_output=True, text=True)
    assert proc.returncode == 0, f"ChemEx failed with error:\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}"

    # 3. Verify statistics parser extracts results
    stat_res = parse_statistics_directory(str(output_dir))
    assert stat_res["has_statistics"] is True
    assert "monte_carlo" in stat_res["methods"]

    mc = stat_res["methods"]["monte_carlo"]
    assert mc["sample_count"] == 2
    assert mc["status"] == "completed"
    assert "PB" in mc["summary"]
    assert "KEX_AB" in mc["summary"]
    assert mc["summary"]["PB"]["median"] is not None
    assert mc["summary"]["PB"]["std"] is not None
