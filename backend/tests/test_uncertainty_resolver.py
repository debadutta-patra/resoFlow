"""
Tests for UncertaintyResolver conforming to Phase 1b and Phase 2 specifications.
Tests precedence hierarchy (GRID > RESAMPLED > COVARIANCE > NONE), parameter status
determination, bound proximity check, and fixture parsing.
"""

from pathlib import Path
import pytest
from app.services.reporting.uncertainty import (
    UncertaintyResolver,
    UncertaintySource,
    ParameterStatus,
    ResolvedParameter,
)

FIXTURES_ROOT = Path(__file__).parent / "fixtures" / "chemex_trees"


class TestUncertaintyResolver:
    """Test suite for UncertaintyResolver precedence and honesty rules."""

    def test_fixture_cest_step_grid_uncertainties(self):
        """Test resolver against the golden fixture cest_step_grid."""
        fixture_dir = FIXTURES_ROOT / "cest_step_grid"
        assert fixture_dir.is_dir()

        resolver = UncertaintyResolver(fixture_dir)

        # 1. Test tau_c resolves to NOT_IN_MODEL
        tauc_res = resolver.resolve("tauc_a", scope="global")
        assert tauc_res.status == ParameterStatus.NOT_IN_MODEL
        assert tauc_res.value is None

        # 2. Test global KEX_AB and PB (in STEP2 they are fixed at starting values)
        kex_res = resolver.resolve("kex_ab", scope="global")
        assert kex_res.value is not None
        assert abs(kex_res.value - 379.269) < 1e-2
        assert kex_res.status == ParameterStatus.FIXED

        pb_res = resolver.resolve("pb", scope="global")
        assert pb_res.value is not None
        assert abs(pb_res.value - 0.353022) < 1e-3
        assert pb_res.status == ParameterStatus.FIXED

        # 3. Test residue 14N DW_AB (now correctly discovers MCMC stats in STEP2!)
        dw_14 = resolver.resolve("dw_ab", scope="14N")
        assert dw_14.value is not None
        assert abs(dw_14.value - 6.62457) < 1e-4
        assert dw_14.source.value == "RESAMPLED"
        assert dw_14.method_name == "MCMC"
        assert dw_14.err_low is not None
        assert abs(dw_14.err_low - 0.0451) < 1e-3
        assert dw_14.status == ParameterStatus.FITTED

        # 4. Test residue 14N R1_A (also discovered via per-group MCMC in STEP2)
        r1_14 = resolver.resolve("r1_a", scope="14N")
        assert r1_14.value is not None
        assert abs(r1_14.value - 1.96616) < 1e-4
        assert r1_14.source == UncertaintySource.RESAMPLED
        assert r1_14.method_name == "MCMC"
        assert r1_14.err_low is not None
        assert abs(r1_14.err_low - 0.0101) < 1e-3
        assert r1_14.status == ParameterStatus.FITTED

        # 5. Test residue 14N CS_A (fixed at 113.589 ppm)
        csa_14 = resolver.resolve("cs_a", scope="14N")
        assert csa_14.value is not None
        assert abs(csa_14.value - 113.589) < 1e-2
        assert csa_14.status == ParameterStatus.FIXED

        # 6. Test residue 14N CS_B (derived: CS_A + DW_AB)
        csb_14 = resolver.resolve("cs_b", scope="14N")
        assert csb_14.value is not None
        assert abs(csb_14.value - 120.214) < 1e-2
        assert csb_14.status == ParameterStatus.DERIVED

    def test_resampled_precedence_over_covariance(self):
        """Test that Monte Carlo resampled statistics take precedence over covariance sigma."""
        stat_fixture = FIXTURES_ROOT / "stat_fit"
        if not stat_fixture.is_dir():
            pytest.skip("stat_fit fixture not found")

        resolver = UncertaintyResolver(stat_fixture)
        kex_res = resolver.resolve("kex_ab", scope="global")

        assert kex_res.value is not None
        assert kex_res.source == UncertaintySource.RESAMPLED
        assert kex_res.n_samples is not None and kex_res.n_samples >= 2

    def test_bound_proximity_check(self, tmp_path: Path):
        """Test that parameters within 1% of their bounds are flagged as AT_BOUND."""
        sim_dir = tmp_path / "bound_test"
        sim_dir.mkdir()

        # Create dummy results.json and config.json with bounds [0.0, 10.0]
        config = {
            "parameter_config": {
                "R2_B": {"min": 0.0, "max": 10.0}
            }
        }
        (sim_dir / "config.json").write_text(json_dumps := __import__("json").dumps(config))

        results = {
            "global": {},
            "residues": {
                "14N": {
                    "parameters": {
                        "r2_b": 0.05,  # 0.05 / 10.0 = 0.5% from lower bound
                        "r2_b_err": 0.01,
                    }
                }
            }
        }
        (sim_dir / "results.json").write_text(__import__("json").dumps(results))

        resolver = UncertaintyResolver(sim_dir, results_data=results)
        r2b_res = resolver.resolve("r2_b", scope="14N")

        assert r2b_res.is_near_bound is True
        assert r2b_res.status == ParameterStatus.AT_BOUND
        assert "Within 1% of lower bound" in (r2b_res.flag_reason or "")


class TestFieldAwareResolution:
    """Field-dependent rates must not be resolved by whichever B0 block wins.

    ChemEx writes one section per static field for R1_A/R1_B/R2_A/R2_B, and
    the typed parser's convenience attributes (res.r2_a) keep only the last
    one seen. The report resolved through those attributes, so a multi-field
    CPMG or CEST report showed an R2,0 from an arbitrary field, unlabelled.
    """

    FIXTURE = FIXTURES_ROOT / "reused_output"

    def test_canonical_key_honours_the_field_when_asked(self):
        from app.services.fitting.param_canonicalizer import canonicalize

        key = canonicalize("R2_A, NUC->31N, B0->500.0MHZ")
        # Opt-in: omitting the field keeps the historical behaviour.
        assert key.matches("R2_A", "31N")
        assert key.matches("R2_A", "31N", field="500.0MHZ")
        assert not key.matches("R2_A", "31N", field="800.0MHZ")

    def test_field_comparison_is_numeric_not_textual(self):
        from app.services.fitting.param_canonicalizer import canonicalize

        key = canonicalize("R2_A, NUC->31N, B0->600.3MHZ")
        for spelling in ("600.3MHZ", "600.3mhz", "600.3", "600.30MHZ"):
            assert key.matches("R2_A", "31N", field=spelling), spelling
        assert not key.matches("R2_A", "31N", field="600.4MHZ")

    def test_unqualified_key_matches_any_requested_field(self):
        """A single-field fit writes no qualifier, and must still resolve."""
        from app.services.fitting.param_canonicalizer import canonicalize

        key = canonicalize("R2_A, NUC->31N")
        assert key.matches("R2_A", "31N", field="800.0MHZ")
        assert key.matches("R2_A", "31N")

    def test_available_fields_are_listed_ascending(self):
        resolver = UncertaintyResolver(str(self.FIXTURE))
        assert resolver.available_fields("r2_a", "31N") == ["500.0MHZ", "800.0MHZ"]

    def test_available_fields_is_empty_without_a_qualifier(self):
        resolver = UncertaintyResolver(str(self.FIXTURE))
        assert resolver.available_fields("dw_ab", "31N") == []

    def test_each_field_resolves_to_its_own_value(self):
        """The bug: both of these used to return 7.94425."""
        resolver = UncertaintyResolver(str(self.FIXTURE))
        low = resolver.resolve("r2_a", "31N", field="500.0MHZ")
        high = resolver.resolve("r2_a", "31N", field="800.0MHZ")

        assert low.value == pytest.approx(5.83417, rel=1e-6)
        assert low.sigma == pytest.approx(0.258888, rel=1e-5)
        assert high.value == pytest.approx(7.94425, rel=1e-6)
        assert high.sigma == pytest.approx(0.402940, rel=1e-5)
        assert low.value != high.value

    def test_r1_is_also_field_dependent(self):
        resolver = UncertaintyResolver(str(self.FIXTURE))
        low = resolver.resolve("r1_a", "31N", field="500.0MHZ")
        high = resolver.resolve("r1_a", "31N", field="800.0MHZ")
        assert low.value != high.value

    def test_omitting_the_field_keeps_the_previous_behaviour(self):
        """Existing callers are untouched; the field argument is opt-in."""
        resolver = UncertaintyResolver(str(self.FIXTURE))
        assert resolver.resolve("r2_a", "31N").value == pytest.approx(7.94425, rel=1e-6)

    def test_field_independent_parameters_ignore_the_argument(self):
        resolver = UncertaintyResolver(str(self.FIXTURE))
        plain = resolver.resolve("dw_ab", "31N")
        with_field = resolver.resolve("dw_ab", "31N", field="500.0MHZ")
        assert plain.value == with_field.value == pytest.approx(1.95915, rel=1e-6)


class TestMultiFieldReportRendering:
    """The report must show every field, labelled."""

    FIXTURE = FIXTURES_ROOT / "reused_output"

    def _model(self):
        from app.services.reporting.model import build_report_model

        return build_report_model(str(self.FIXTURE), "demo", analysis_type="CEST")

    def test_residue_record_captures_every_field(self):
        model = self._model()
        record = model.residues[0]
        assert record.is_multi_field
        by_field = {f: p.value for f, p in record.rates_by_field["r2_a"]}
        assert by_field["500.0MHZ"] == pytest.approx(5.83417, rel=1e-6)
        assert by_field["800.0MHZ"] == pytest.approx(7.94425, rel=1e-6)

    def test_rendered_report_shows_both_values_labelled(self):
        from app.services.reporting.render import render_html

        html = render_html(self._model(), style="screen")
        # Both values reach the page -- previously only one did.
        assert "5.83" in html
        assert "7.94" in html
        # And each carries its field, so neither is misattributed.
        assert 'class="field-tag">500.0<' in html
        assert 'class="field-tag">800.0<' in html

    def test_pdf_renders_with_field_labels(self):
        from app.services.reporting.render import render_pdf

        buffer = render_pdf(self._model(), style="publication")
        content = buffer.getvalue()
        assert content.startswith(b"%PDF")
        assert len(content) > 5000

    def test_model_dict_round_trips_the_field_breakdown(self):
        record = self._model().residues[0].to_dict()
        assert "rates_by_field" in record
        fields = [e["field"] for e in record["rates_by_field"]["r2_a"]]
        assert fields == ["500.0MHZ", "800.0MHZ"]

    def test_single_field_fixture_gains_no_breakdown(self):
        """A single-field run must render exactly as before."""
        from app.services.reporting.model import build_report_model
        from app.services.reporting.render import render_html

        model = build_report_model(
            str(FIXTURES_ROOT / "cest_step_grid"), "demo", analysis_type="CEST"
        )
        assert not any(r.is_multi_field for r in model.residues)
        assert all(not r.rates_by_field for r in model.residues)
        assert "field-tag" not in render_html(model, style="screen").split("</style>")[1]
