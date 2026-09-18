# Copyright (C) 2026 resoFlow Authors
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

"""
Tests for the EXPERIMENTAL multi-field consistency analysis.

The chi-square exchange test is only worth anything if the statistic is
actually chi-square distributed under the null, so that is tested by
calibration against many noise realisations, not merely by asserting that
exchange raises it.
"""

from __future__ import annotations

import numpy as np
import pytest
from scipy import stats

from app.services.sdm import constants_from_presets, field_physics
from app.services.sdm.multifield import (
    ALPHA_BOUNDS,
    FieldObservation,
    J0_COLUMN,
    build_multifield_matrix,
    fit_rex_scaling_exponent,
    map_multifield_dataset,
)
from app.services.sdm.physics import W_H_EFF, W_N

from test_sdm_mapping import forward_rates, lipari_szabo_j

CONSTANTS = constants_from_presets("1.02", "-160")


def physics_at(mhz):
    return field_physics(mhz * 1e6, CONSTANTS)


def synthetic_field(mhz, params, rex=0.0, rel_err=0.0):
    """Rates at one field from the full master equations, plus optional Rex."""
    phys = physics_at(mhz)
    r1, r2, noe = [], [], []
    for s2, tau_c, tau_e in params:
        a, b, c, _, _ = forward_rates(s2, tau_c, tau_e, phys)
        r1.append(a)
        r2.append(b + rex)
        noe.append(c)
    r1 = np.array(r1)
    r2 = np.array(r2)
    noe = np.array(noe)
    return FieldObservation(
        physics=phys,
        r1=r1, r1_err=np.maximum(rel_err * r1, 1e-12),
        r2=r2, r2_err=np.maximum(rel_err * r2, 1e-12),
        noe=noe, noe_err=np.maximum(rel_err * np.abs(noe), 1e-12),
    )


PARAMS = [(0.85, 9e-9, 50e-12), (0.75, 9e-9, 200e-12)]


# --------------------------------------------------------------------------
# Structure of the stacked system
# --------------------------------------------------------------------------

def test_matrix_has_one_shared_j0_and_per_field_frequency_columns():
    """3n rows, 1 + 2n unknowns, with J(0) shared across every block."""
    fields = [physics_at(500), physics_at(600), physics_at(800)]
    matrix, columns, rows = build_multifield_matrix(fields)

    assert matrix.shape == (9, 7)
    assert columns[0] == J0_COLUMN
    assert columns.count(J0_COLUMN) == 1
    for k in range(3):
        assert f"{W_N}@{k}" in columns
        assert f"{W_H_EFF}@{k}" in columns
    assert rows == [f"{name}@{k}" for k in range(3)
                    for name in ("R1", "R2", "sigma")]


def test_only_r2_rows_touch_the_shared_j0_column():
    """R1 and the NOE carry no exchange, which is what makes the test work."""
    matrix, columns, rows = build_multifield_matrix([physics_at(600), physics_at(800)])
    j0_col = columns.index(J0_COLUMN)
    for i, label in enumerate(rows):
        if label.startswith("R2@"):
            assert matrix[i, j0_col] != 0.0
        else:
            assert matrix[i, j0_col] == 0.0


def test_frequency_columns_do_not_leak_between_fields():
    matrix, columns, rows = build_multifield_matrix([physics_at(600), physics_at(800)])
    for i, label in enumerate(rows):
        block = int(label.split("@")[1])
        other = 1 - block
        assert matrix[i, columns.index(f"{W_N}@{other}")] == 0.0
        assert matrix[i, columns.index(f"{W_H_EFF}@{other}")] == 0.0


def test_single_field_is_rejected():
    """One field leaves the system square and the test with no dof."""
    with pytest.raises(ValueError, match="at least two fields"):
        build_multifield_matrix([physics_at(600)])
    with pytest.raises(ValueError, match="at least two fields"):
        map_multifield_dataset([synthetic_field(600, PARAMS)])


def test_repeated_fields_are_rejected():
    """Each field gets its own J(wN)/J_h columns, so a repeated field is
    still full rank and would silently solve -- turning the chi-square
    into a replicate consistency check rather than a test of exchange.
    """
    with pytest.raises(ValueError, match="genuinely different fields"):
        map_multifield_dataset([
            synthetic_field(600, PARAMS, rel_err=0.02),
            synthetic_field(600, PARAMS, rel_err=0.02),
        ])


def test_mismatched_residue_counts_are_rejected():
    with pytest.raises(ValueError, match="same residues"):
        map_multifield_dataset([
            synthetic_field(600, PARAMS, rel_err=0.02),
            synthetic_field(800, PARAMS[:1], rel_err=0.02),
        ])


@pytest.mark.parametrize("n_fields,expected_dof", [(2, 1), (3, 2), (4, 3)])
def test_degrees_of_freedom_equal_n_fields_minus_one(n_fields, expected_dof):
    """The surplus is exactly the shared-J(0) assumption, once per extra field."""
    mhz = [500, 600, 700, 800][:n_fields]
    result = map_multifield_dataset(
        [synthetic_field(m, PARAMS, rel_err=0.02) for m in mhz]
    )
    assert result.dof == expected_dof
    assert result.dof == n_fields - 1


# --------------------------------------------------------------------------
# Recovery
# --------------------------------------------------------------------------

def test_noiseless_recovery_of_a_shared_j0():
    """Consistent data must solve exactly, with chi-square at zero."""
    fields = [500, 600, 800]
    result = map_multifield_dataset(
        [synthetic_field(m, PARAMS, rel_err=0.01) for m in fields]
    )
    for i, (s2, tau_c, tau_e) in enumerate(PARAMS):
        j0_true = lipari_szabo_j(0.0, s2, tau_c, tau_e)
        assert result.j0[i] == pytest.approx(j0_true, rel=0.02)
        for k, mhz in enumerate(fields):
            phys = physics_at(mhz)
            assert result.j_wn[i, k] == pytest.approx(
                lipari_szabo_j(phys.omega_n, s2, tau_c, tau_e), rel=0.05
            )
    # No exchange was added, so the shared-J(0) model fits.
    assert np.all(result.chi2 < 1.0)
    assert np.all(result.p_value > 0.05)


def test_shapes_are_per_residue_and_per_field():
    fields = [600, 800]
    result = map_multifield_dataset(
        [synthetic_field(m, PARAMS, rel_err=0.02) for m in fields]
    )
    n_res, n_fields = len(PARAMS), len(fields)
    assert result.j0.shape == (n_res,)
    assert result.j_wn.shape == (n_res, n_fields)
    assert result.j_h.shape == (n_res, n_fields)
    assert result.covariance.shape == (n_res, 1 + 2 * n_fields, 1 + 2 * n_fields)
    assert result.r2_residual.shape == (n_res, n_fields)
    assert result.chi2.shape == (n_res,)
    assert result.p_value.shape == (n_res,)
    assert result.j0_err.shape == (n_res,)


# --------------------------------------------------------------------------
# The exchange test
# --------------------------------------------------------------------------

def test_exchange_raises_chi_square_and_drops_the_p_value():
    """Rex added to R2 alone must show up as a shared-J(0) inconsistency."""
    clean = map_multifield_dataset([
        synthetic_field(600, PARAMS, rel_err=0.02),
        synthetic_field(800, PARAMS, rel_err=0.02),
    ])
    # Fast-limit exchange: Rex scales as B0^2.
    exchanged = map_multifield_dataset([
        synthetic_field(600, PARAMS, rex=2.0, rel_err=0.02),
        synthetic_field(800, PARAMS, rex=2.0 * (800 / 600) ** 2, rel_err=0.02),
    ])
    assert np.all(exchanged.chi2 > clean.chi2)
    # dof = 1, so chi-square above ~3.84 is significant at the 5% level.
    assert np.all(exchanged.chi2 > 5.0)
    assert np.all(exchanged.p_value < 0.05)
    assert np.all(clean.p_value > 0.05)


def test_field_independent_offset_is_absorbed_not_flagged():
    """A B0-independent R2 offset is degenerate with J(0) and must not trip
    the test -- only a field-DEPENDENT discrepancy is evidence of exchange."""
    same = map_multifield_dataset([
        synthetic_field(600, PARAMS, rex=1.5, rel_err=0.02),
        synthetic_field(800, PARAMS, rex=1.5, rel_err=0.02),
    ])
    # The offset shifts J(0) instead of raising chi-square.
    assert np.all(same.p_value > 0.05)


def test_chi_square_is_calibrated_under_the_null():
    """The statistic must actually be chi-square distributed with dof = n-1.

    This is the test that makes the p-value mean something. Without it, "chi
    square went up when I added exchange" only shows the number responds to
    exchange, not that a stated p-value is a real false-positive rate.
    """
    rng = np.random.default_rng(20260909)
    fields = [600, 800]
    base = [synthetic_field(m, PARAMS[:1], rel_err=0.0) for m in fields]

    rel = 0.02
    n_trials = 1500
    chi2_values = []
    for _ in range(n_trials):
        observations = []
        for obs in base:
            r1_e = rel * obs.r1
            r2_e = rel * obs.r2
            noe_e = rel * np.abs(obs.noe)
            observations.append(FieldObservation(
                physics=obs.physics,
                r1=obs.r1 + rng.normal(0, 1, obs.r1.shape) * r1_e, r1_err=r1_e,
                r2=obs.r2 + rng.normal(0, 1, obs.r2.shape) * r2_e, r2_err=r2_e,
                noe=obs.noe + rng.normal(0, 1, obs.noe.shape) * noe_e, noe_err=noe_e,
            ))
        chi2_values.append(map_multifield_dataset(observations).chi2[0])

    chi2_values = np.array(chi2_values)
    dof = len(fields) - 1

    # Mean of a chi-square variate is its dof; the standard error of the
    # mean over n_trials draws is sqrt(2*dof/n_trials).
    sem = np.sqrt(2.0 * dof / n_trials)
    assert abs(chi2_values.mean() - dof) < 5 * sem

    # And the distribution itself should pass a KS test against chi2(dof).
    ks = stats.kstest(chi2_values, lambda x: stats.chi2.cdf(x, dof))
    assert ks.pvalue > 0.001, f"chi-square miscalibrated (KS p={ks.pvalue:.2e})"


def test_p_values_are_uniform_under_the_null():
    """A calibrated test yields uniform p-values when there is no exchange."""
    rng = np.random.default_rng(7)
    fields = [500, 800]
    base = [synthetic_field(m, PARAMS[:1], rel_err=0.0) for m in fields]

    rel = 0.03
    p_values = []
    for _ in range(1200):
        observations = []
        for obs in base:
            r1_e, r2_e = rel * obs.r1, rel * obs.r2
            noe_e = rel * np.abs(obs.noe)
            observations.append(FieldObservation(
                physics=obs.physics,
                r1=obs.r1 + rng.normal(0, 1, obs.r1.shape) * r1_e, r1_err=r1_e,
                r2=obs.r2 + rng.normal(0, 1, obs.r2.shape) * r2_e, r2_err=r2_e,
                noe=obs.noe + rng.normal(0, 1, obs.noe.shape) * noe_e, noe_err=noe_e,
            ))
        p_values.append(map_multifield_dataset(observations).p_value[0])

    ks = stats.kstest(np.array(p_values), "uniform")
    assert ks.pvalue > 0.001, f"p-values not uniform (KS p={ks.pvalue:.2e})"


def test_covariance_matches_monte_carlo():
    """Cov = (M^T W M)^-1 must reproduce the scatter of repeated fits."""
    rng = np.random.default_rng(4242)
    fields = [600, 800]
    base = [synthetic_field(m, PARAMS[:1], rel_err=0.0) for m in fields]
    rel = 0.03

    analytic = map_multifield_dataset([
        FieldObservation(
            physics=o.physics,
            r1=o.r1, r1_err=rel * o.r1,
            r2=o.r2, r2_err=rel * o.r2,
            noe=o.noe, noe_err=rel * np.abs(o.noe),
        ) for o in base
    ])

    draws = []
    for _ in range(4000):
        observations = []
        for obs in base:
            r1_e, r2_e = rel * obs.r1, rel * obs.r2
            noe_e = rel * np.abs(obs.noe)
            observations.append(FieldObservation(
                physics=obs.physics,
                r1=obs.r1 + rng.normal(0, 1, obs.r1.shape) * r1_e, r1_err=r1_e,
                r2=obs.r2 + rng.normal(0, 1, obs.r2.shape) * r2_e, r2_err=r2_e,
                noe=obs.noe + rng.normal(0, 1, obs.noe.shape) * noe_e, noe_err=noe_e,
            ))
        draws.append(map_multifield_dataset(observations).j0[0])

    mc_sd = float(np.std(draws, ddof=1))
    assert analytic.j0_err[0] == pytest.approx(mc_sd, rel=0.1)


def test_r2_residual_responds_to_field_dependent_exchange():
    """The residual moves with the FIELD DEPENDENCE of exchange, not its size.

    It is not a calibrated R_ex and is not asserted to be one: the fit
    absorbs part of any exchange into J(omega_N) and J_h as well as J(0), so
    the residual recovers the right sign and order of magnitude but
    systematically under-reports. Absolute values are not meaningful;
    differences between fields are.
    """
    injected = {0: 2.0, 1: 2.0 * (800 / 600) ** 2}
    result = map_multifield_dataset([
        synthetic_field(600, PARAMS, rex=injected[0], rel_err=0.01),
        synthetic_field(800, PARAMS, rex=injected[1], rel_err=0.01),
    ])
    observed = result.r2_residual[:, 1] - result.r2_residual[:, 0]
    expected = injected[1] - injected[0]
    for value in observed:
        assert value > 0
        assert 0.4 * expected < value < 1.2 * expected


def test_field_independent_exchange_is_invisible_in_the_residual():
    """The one thing this analysis fundamentally cannot see.

    n fields give n-1 residual degrees of freedom but n R_ex values would be
    needed. The shortfall is exactly the field-independent component, which
    is perfectly degenerate with J(0) -- so a constant offset is absorbed
    rather than reported, and J(0) is biased by it without any warning sign.
    """
    offset = 1.5
    result = map_multifield_dataset([
        synthetic_field(600, PARAMS, rex=offset, rel_err=0.01),
        synthetic_field(800, PARAMS, rex=offset, rel_err=0.01),
    ])
    assert np.all(np.abs(result.r2_residual) < 0.15 * offset)
    assert np.all(result.p_value > 0.05)


# --------------------------------------------------------------------------
# Scaling exponent -- fitted, never assumed
# --------------------------------------------------------------------------

def test_scaling_exponent_recovers_a_known_power():
    fields = np.array([500e6, 600e6, 700e6, 800e6])
    for true_alpha in (0.5, 1.0, 1.6, 2.0):
        rex = 3.0 * (fields / fields.mean()) ** true_alpha
        fit = fit_rex_scaling_exponent(fields, rex, 0.01 * rex)
        assert fit is not None
        assert fit.alpha == pytest.approx(true_alpha, abs=0.05)


def test_scaling_exponent_is_bounded():
    """alpha is constrained to [0, 2]; a steeper trend saturates at 2."""
    fields = np.array([500e6, 600e6, 800e6])
    rex = 2.0 * (fields / fields.mean()) ** 3.5
    fit = fit_rex_scaling_exponent(fields, rex, 0.01 * rex)
    assert fit is not None
    assert ALPHA_BOUNDS[0] <= fit.alpha <= ALPHA_BOUNDS[1]
    assert fit.at_bound
    # At a bound the error estimate is not meaningful and is withheld.
    assert fit.alpha_err is None


def test_two_fields_cannot_identify_the_exponent():
    """Two fields leave one residual dof against a two-parameter power law.

    Returning a number there would be an artefact of the parametrisation, so
    the fit declines instead.
    """
    fields = np.array([600e6, 800e6])
    rex = np.array([2.0, 2.0 * (800 / 600) ** 2])
    assert fit_rex_scaling_exponent(fields, rex, np.array([0.1, 0.1])) is None


def test_three_fields_determine_the_exponent_exactly():
    fields = np.array([500e6, 650e6, 800e6])
    rex = 2.0 * (fields / fields.mean()) ** 1.2
    fit = fit_rex_scaling_exponent(fields, rex, 0.05 * rex)
    assert fit is not None
    assert fit.exactly_determined
    assert fit.alpha == pytest.approx(1.2, abs=0.1)


def test_four_fields_overdetermine_the_exponent():
    fields = np.array([500e6, 600e6, 700e6, 800e6])
    rex = 2.0 * (fields / fields.mean()) ** 1.2
    fit = fit_rex_scaling_exponent(fields, rex, 0.05 * rex)
    assert fit is not None
    assert not fit.exactly_determined
    assert fit.alpha_err is not None


def test_scaling_exponent_declines_to_fit_degenerate_input():
    assert fit_rex_scaling_exponent([600e6], [2.0]) is None
    assert fit_rex_scaling_exponent([500e6, 600e6, 800e6], [-1.0, -2.0, -3.0]) is None
    assert fit_rex_scaling_exponent([500e6, 600e6, 800e6], [np.nan, 2.0, 3.0]) is None


def test_fast_exchange_assumption_is_not_baked_in():
    """A slow-exchange-like field dependence must NOT come back as alpha=2.

    Fixing the exponent at 2 is only valid in fast exchange; assuming it
    where exchange is slower silently misattributes the result.
    """
    fields = np.array([500e6, 600e6, 700e6, 800e6])
    rex = 3.0 * (fields / fields.mean()) ** 0.4
    fit = fit_rex_scaling_exponent(fields, rex, 0.02 * rex)
    assert fit is not None
    assert fit.alpha < 1.0
    assert fit.alpha == pytest.approx(0.4, abs=0.1)
