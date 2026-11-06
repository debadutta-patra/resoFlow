"""
Unit tests for Grid Search Parser v2 (grid_parser_v2.py).
"""

import tempfile
from pathlib import Path
import pytest

from app.services.fitting.chemex_output.grid_parser_v2 import (
    is_v2_grid_dir,
    parse_v2_grid_summary,
    load_v2_1d_profiles,
    load_v2_2d_surface,
    parse_v2_grid_directory,
)


def _setup_synthetic_v2_grid(grid_dir: Path):
    summary_content = """status = "complete"
selected_chi_square = 120.5
factor_count = 1

[[selected_axes]]
parameter_id = "p_kex_ab"
name = "kex_ab"
value = 250.0

[[selected_axes]]
parameter_id = "p_pb"
name = "pb"
value = 0.05
"""
    (grid_dir / "summary.toml").write_text(summary_content, encoding="utf-8")

    prof_1d = grid_dir / "Profiles" / "1D"
    prof_1d.mkdir(parents=True)
    kex_tsv = "kex_ab\tchi_square\tselected\n100.0\t180.0\tfalse\n250.0\t120.5\ttrue\n500.0\t210.0\tfalse\n"
    (prof_1d / "kex_ab.tsv").write_text(kex_tsv, encoding="utf-8")

    pb_tsv = "pb\tchi_square\tselected\n0.01\t190.0\tfalse\n0.05\t120.5\ttrue\n0.10\t220.0\tfalse\n"
    (prof_1d / "pb.tsv").write_text(pb_tsv, encoding="utf-8")

    prof_2d = grid_dir / "Profiles" / "2D"
    prof_2d.mkdir(parents=True)
    surface_tsv = """kex_ab\tpb\tchi_square\tselected
100.0\t0.01\t250.0\tfalse
100.0\t0.05\t190.0\tfalse
250.0\t0.01\t180.0\tfalse
250.0\t0.05\t120.5\ttrue
500.0\t0.01\t290.0\tfalse
500.0\t0.05\t210.0\tfalse
"""
    (prof_2d / "kex_ab__pb.tsv").write_text(surface_tsv, encoding="utf-8")

    (grid_dir / "grid_1d.pdf").write_text("%PDF-1.4\n", encoding="utf-8")
    (grid_dir / "grid_2d.pdf").write_text("%PDF-1.4\n", encoding="utf-8")


def test_is_v2_grid_dir():
    with tempfile.TemporaryDirectory() as tmp_dir:
        p = Path(tmp_dir)
        assert not is_v2_grid_dir(p)
        _setup_synthetic_v2_grid(p)
        assert is_v2_grid_dir(p)


def test_parse_v2_grid_summary():
    with tempfile.TemporaryDirectory() as tmp_dir:
        p = Path(tmp_dir)
        _setup_synthetic_v2_grid(p)
        summary = parse_v2_grid_summary(p)
        assert summary["status"] == "complete"
        assert summary["selected_chi_square"] == 120.5
        assert summary["factor_count"] == 1
        assert len(summary["selected_axes"]) == 2
        assert summary["selected_axes"][0]["name"] == "kex_ab"
        assert summary["selected_axes"][0]["value"] == 250.0


def test_load_v2_1d_profiles():
    with tempfile.TemporaryDirectory() as tmp_dir:
        p = Path(tmp_dir)
        _setup_synthetic_v2_grid(p)
        profs = load_v2_1d_profiles(p)
        assert len(profs) == 2
        p_names = [p_item["parameter"] for p_item in profs]
        assert "kex_ab" in p_names or "KEX_AB" in p_names
        kex_prof = next(p_item for p_item in profs if "kex" in p_item["parameter"].lower())
        assert kex_prof["min_val"] == 250.0
        assert kex_prof["min_chisqr"] == 120.5
        assert kex_prof["selected_val"] == 250.0
        assert len(kex_prof["x"]) == 3
        assert len(kex_prof["delta_chisqr"]) == 3
        assert kex_prof["delta_chisqr"][1] == 0.0


def test_load_v2_2d_surface():
    with tempfile.TemporaryDirectory() as tmp_dir:
        p = Path(tmp_dir)
        _setup_synthetic_v2_grid(p)
        surf = load_v2_2d_surface(p, "kex_ab", "pb")
        assert surf["x_param"] == "kex_ab"
        assert surf["y_param"] == "pb"
        assert len(surf["x"]) == 3
        assert len(surf["y"]) == 2
        assert surf["min_point"]["chisqr"] == 120.5
        assert surf["min_point"]["x"] == 250.0
        assert surf["min_point"]["y"] == 0.05
        assert len(surf["z_chisqr"]) == 2
        assert len(surf["z_chisqr"][0]) == 3


def test_parse_v2_grid_directory():
    with tempfile.TemporaryDirectory() as tmp_dir:
        p = Path(tmp_dir)
        _setup_synthetic_v2_grid(p)
        model = parse_v2_grid_directory(p)
        assert model is not None
        assert model.has_grid is True
        assert len(model.parameters) == 2
        assert model.best_point is not None
        assert model.best_point.chisqr == 120.5
        assert model.best_point.values.get("KEX_AB") == 250.0 or model.best_point.values.get("kex_ab") == 250.0
        assert model.grid_1d_pdf is not None
        assert model.grid_2d_pdf is not None
