"""[GLOBAL] vs per-parameter sections in parameters.toml (ChemEx 2026.9.2).

ChemEx applies parameter-file defaults so that, for each parameter, the *last matching
entry in file order* wins (ParameterDatabase.set_defaults walks the list in reverse and
claims each id once). It is not "most specific wins". resoFlow always writes [GLOBAL]
first, so per-residue sections override the blanket value; a file with [GLOBAL] after a
per-residue section makes the global win everywhere. Verified here on a real session
(inspect_parameters) and a real fit (run_info/parameters_used.toml).
"""

from __future__ import annotations

import shutil
import tomllib
from pathlib import Path

import pytest

from resoflow.chemex_api.fit import run_fit
from resoflow.chemex_api.session import inspect_parameters
from resoflow.chemex_api.spec import FitJobSpec

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "baselines" / "2026.6.1" / "cpmg_15n_ip" / "inputs"
INCLUDE = ["3N", "4N"]

GLOBAL_FIRST = """[GLOBAL]
PB = 0.07
KEX_AB = 400.0
R2_A = 20.0
DW_AB = 2.0

[R2_A]
3N = 7.0

[DW_AB]
3N = 4.0
"""

GLOBAL_LAST = """[R2_A]
3N = 7.0

[DW_AB]
3N = 4.0

[GLOBAL]
PB = 0.07
KEX_AB = 400.0
R2_A = 20.0
DW_AB = 2.0
"""


def _stage(tmp_path: Path, parameters: str) -> FitJobSpec:
    shutil.copytree(FIXTURE / "Data", tmp_path / "Data")
    shutil.copytree(FIXTURE / "Experiments", tmp_path / "Experiments")
    (tmp_path / "Parameters").mkdir()
    (tmp_path / "Parameters" / "parameters.toml").write_text(parameters, encoding="utf-8")
    return FitJobSpec(
        experiment_files=[f"Experiments/{f.name}" for f in sorted((tmp_path / "Experiments").glob("*.toml"))],
        parameter_files=["Parameters/parameters.toml"],
        model="2st",
        include=INCLUDE,
        output_dir="Output",
    )


def _values(rows: list[dict], name: str) -> dict[str, set[float]]:
    out: dict[str, set[float]] = {}
    for r in rows:
        if r["name"].upper() == name:
            residue = r["spin"].split("-")[0].upper()
            out.setdefault(residue, set()).add(r["value"])
    return out


def test_per_residue_section_after_global_wins(tmp_path: Path) -> None:
    rows = inspect_parameters(_stage(tmp_path, GLOBAL_FIRST), job_dir=tmp_path)
    r2a = _values(rows, "R2_A")
    dw = _values(rows, "DW_AB")
    assert r2a["3N"] == {7.0} and r2a["4N"] == {20.0}
    assert dw["3N"] == {4.0} and dw["4N"] == {2.0}


def test_global_after_per_residue_section_wins_everywhere(tmp_path: Path) -> None:
    rows = inspect_parameters(_stage(tmp_path, GLOBAL_LAST), job_dir=tmp_path)
    assert _values(rows, "R2_A") == {"3N": {20.0}, "4N": {20.0}}
    assert _values(rows, "DW_AB") == {"3N": {2.0}, "4N": {2.0}}


@pytest.mark.slow
def test_real_fit_starts_from_the_per_residue_value(tmp_path: Path) -> None:
    spec = _stage(tmp_path, GLOBAL_FIRST)
    result = run_fit(spec, job_dir=tmp_path)
    assert result.exit_code == 0, result.error
    used = tomllib.loads((tmp_path / "Output" / "run_info" / "parameters_used.toml").read_text(encoding="utf-8"))
    sections = {k.upper(): v for k, v in used.items()}
    dw = {k.split("-")[0].upper(): (v[0] if isinstance(v, list) else v) for k, v in sections["DW_AB"].items()}
    assert dw["3N"] == pytest.approx(4.0)
    assert dw["4N"] == pytest.approx(2.0)
