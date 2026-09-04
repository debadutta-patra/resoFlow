"""
Unit and regression tests for ReportModel and build_report_model.
Validates model extraction, flag evaluation, RuntimeError guard,
and golden JSON serialization against committed fixtures.

Refs: docs/reporting/weasyprint-design.md §3, §11
"""

import json
from pathlib import Path
import pytest

from app.services.reporting.model import (
    ReportModel,
    ResidueRecord,
    StepReportModel,
    build_report_model,
    natural_sort_key,
)
from app.services.reporting.report_generator import ReportBuilder, generate_modern_pdf_report
from app.services.reporting.uncertainty import UncertaintySource, ParameterStatus

FIXTURES_ROOT = Path(__file__).parent / "fixtures" / "chemex_trees"
GOLDEN_ROOT = Path(__file__).parent / "fixtures" / "golden_reports"
FIXED_TIMESTAMP = "2026-01-01T00:00:00+00:00"


class TestReportModel:
    """Test suite for ReportModel data structure and build_report_model builder."""

    def test_natural_sort_key(self):
        """Verify natural sort ordering for NMR spin systems."""
        raw = ["100N", "2N", "14N", "55N", "1N"]
        sorted_keys = sorted(raw, key=natural_sort_key)
        assert sorted_keys == ["1N", "2N", "14N", "55N", "100N"]

    def test_build_model_single_step_without_resampling(self):
        """Build model for a standard single-step CPMG analysis without resampling."""
        fix_dir = FIXTURES_ROOT / "single_step"
        assert fix_dir.is_dir()

        model = build_report_model(
            analysis_dir=fix_dir,
            analysis_name="single_step",
            analysis_type="CPMG",
            fixed_timestamp=FIXED_TIMESTAMP,
        )

        assert isinstance(model, ReportModel)
        assert model.analysis_name == "single_step"
        assert model.analysis_type == "CPMG"
        assert len(model.residues) > 0
        assert len(model.resampled) == 0  # No resampling statistics
        assert model.provenance.has_statistics_runs is False

        # Verify ResidueRecord access patterns
        first_res = model.residues[0]
        assert isinstance(first_res, ResidueRecord)
        assert first_res.anchor.startswith("res-")
        # Test both attribute and dictionary access
        assert first_res.dw == first_res["dw"]
        assert first_res.display_name == first_res["display_name"]
        assert "dw" in first_res

    def test_build_model_stat_fit_with_resampling(self):
        """Build model for an analysis with resampling statistics (MC/Bootstrap/MCMC)."""
        fix_dir = FIXTURES_ROOT / "stat_fit"
        assert fix_dir.is_dir()

        model = build_report_model(
            analysis_dir=fix_dir,
            analysis_name="stat_fit",
            analysis_type="CPMG",
            fixed_timestamp=FIXED_TIMESTAMP,
        )

        assert isinstance(model, ReportModel)
        assert model.provenance.has_statistics_runs is True
        assert len(model.resampled) > 0
        assert model.ledger.get(UncertaintySource.RESAMPLED.value, 0) > 0

        # Verify derived kinetics presence
        assert "kab" in model.derived_kinetics
        assert "kba" in model.derived_kinetics
        assert model.derived_kinetics["kab"].value is not None

    def test_golden_json_single_step(self):
        """Compare single_step model.to_dict() against committed golden JSON."""
        fix_dir = FIXTURES_ROOT / "single_step"
        golden_file = GOLDEN_ROOT / "single_step.json"
        assert golden_file.is_file()

        model = build_report_model(
            analysis_dir=fix_dir,
            analysis_name="single_step",
            analysis_type="CPMG",
            fixed_timestamp=FIXED_TIMESTAMP,
        )
        d = model.to_dict()
        d["provenance"]["git_sha"] = "PINNED"

        expected = json.loads(golden_file.read_text(encoding="utf-8"))
        assert d == expected

    def test_golden_json_stat_fit(self):
        """Compare stat_fit model.to_dict() against committed golden JSON."""
        fix_dir = FIXTURES_ROOT / "stat_fit"
        golden_file = GOLDEN_ROOT / "stat_fit.json"
        assert golden_file.is_file()

        model = build_report_model(
            analysis_dir=fix_dir,
            analysis_name="stat_fit",
            analysis_type="CPMG",
            fixed_timestamp=FIXED_TIMESTAMP,
        )
        d = model.to_dict()
        d["provenance"]["git_sha"] = "PINNED"

        expected = json.loads(golden_file.read_text(encoding="utf-8"))
        assert d == expected

    def test_golden_json_multi_step(self):
        """Compare multi_step model.to_dict() against committed golden JSON."""
        fix_dir = FIXTURES_ROOT / "multi_step"
        golden_file = GOLDEN_ROOT / "multi_step.json"
        assert golden_file.is_file()

        model = build_report_model(
            analysis_dir=fix_dir,
            analysis_name="multi_step",
            analysis_type="CPMG",
            fixed_timestamp=FIXED_TIMESTAMP,
        )
        d = model.to_dict()
        d["provenance"]["git_sha"] = "PINNED"

        expected = json.loads(golden_file.read_text(encoding="utf-8"))
        assert d == expected

    def test_runtime_error_guard_on_zero_resampled_resolution(self, monkeypatch):
        """Verify that build_report_model raises RuntimeError if stats exist but 0 resolve to RESAMPLED."""
        fix_dir = FIXTURES_ROOT / "stat_fit"
        assert fix_dir.is_dir()

        from app.services.reporting.uncertainty import UncertaintyResolver

        # Monkeypatch get_ledger_summary to simulate zero RESAMPLED resolutions
        orig_summary = UncertaintyResolver.get_ledger_summary

        def fake_ledger_summary(self):
            real = orig_summary(self)
            real[UncertaintySource.RESAMPLED.value] = 0
            return real

        monkeypatch.setattr(UncertaintyResolver, "get_ledger_summary", fake_ledger_summary)

        with pytest.raises(RuntimeError, match="Resampling statistics artifacts were found on disk, but zero parameters resolved"):
            build_report_model(
                analysis_dir=fix_dir,
                analysis_name="stat_fit",
                analysis_type="CPMG",
                fixed_timestamp=FIXED_TIMESTAMP,
            )

    def test_report_builder_consumes_model(self):
        """Verify that ReportBuilder initializes from and works with a pre-built ReportModel."""
        fix_dir = FIXTURES_ROOT / "single_step"
        model = build_report_model(
            analysis_dir=fix_dir,
            analysis_name="single_step",
            analysis_type="CPMG",
            fixed_timestamp=FIXED_TIMESTAMP,
        )
        builder = ReportBuilder(model=model, style_name="publication")
        assert builder.model is model
        assert builder.analysis_name == "single_step"
        assert len(builder.residue_records) == len(model.residues)
        pdf_buf = builder.render_pdf()
        assert pdf_buf.getbuffer().nbytes > 1000

    def test_build_model_multi_step_structure(self):
        """Verify multi-step fit correctly populates StepReportModel hierarchy and step-scoped parameters."""
        fix_dir = FIXTURES_ROOT / "multi_step"
        model = build_report_model(
            analysis_dir=fix_dir,
            analysis_name="multi_step",
            analysis_type="CPMG",
            fixed_timestamp=FIXED_TIMESTAMP,
        )
        assert model.is_multi_step is True
        assert model.step_order == ["STEP1", "STEP2"]
        assert len(model.steps) == 2

        s1, s2 = model.steps[0], model.steps[1]
        assert isinstance(s1, StepReportModel)
        assert isinstance(s2, StepReportModel)
        assert s1.step_name == "STEP1"
        assert s1.step_index == 1
        assert s2.step_name == "STEP2"
        assert s2.step_index == 2

        # STEP1 fits kex and pb, residue is 15N
        s1_kex = next(p for n, p in s1.global_params if n == "kex_ab")
        assert s1_kex.status == ParameterStatus.FITTED
        assert len(s1.residues) == 1
        assert s1.residues[0].display_name == "15N"
        assert s1.residues[0].anchor == "res-STEP1-15N"

        # STEP2 fixes kex and pb, residues are 15N and 31N
        s2_kex = next(p for n, p in s2.global_params if n == "kex_ab")
        assert s2_kex.status == ParameterStatus.FIXED
        assert len(s2.residues) == 2
        assert s2.residues[0].anchor == "res-STEP2-15N"
        assert s2.residues[1].anchor == "res-STEP2-31N"

    def test_build_model_cest_step_grid(self):
        """Verify cest_step_grid multi-step pipeline with 2D grid in STEP1 and MCMC in STEP2."""
        fix_dir = FIXTURES_ROOT / "cest_step_grid"
        model = build_report_model(
            analysis_dir=fix_dir,
            analysis_name="cest_step_grid",
            analysis_type="CEST",
            fixed_timestamp=FIXED_TIMESTAMP,
        )
        assert model.is_multi_step is True
        assert len(model.steps) == 2
        s1, s2 = model.steps[0], model.steps[1]

        # STEP1 has 2D grid surface and 1D likelihood profiles
        assert s1.has_grid is True
        assert s1.has_statistics is False
        assert s1.grid_2d is not None
        assert len(s1.grid_1d) > 0

        # STEP2 has MCMC/Bootstrap resampling statistics
        assert s2.has_grid is False
        assert s2.has_statistics is True
        assert len(s2.resampled) > 0
        assert s2.ledger.get(UncertaintySource.RESAMPLED.value, 0) > 0

