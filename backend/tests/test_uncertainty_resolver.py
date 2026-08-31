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
