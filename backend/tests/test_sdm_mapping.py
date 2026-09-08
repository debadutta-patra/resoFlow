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
Tests for the reduced spectral density mapping core (app.services.sdm).

The package is standalone, so these tests exercise it directly against arrays
with no database, filesystem or FastAPI involvement.
"""

from __future__ import annotations

import math
import pathlib

import numpy as np
import pytest

from app.services.sdm import (
    GAMMA_H,
    GAMMA_N,
    GAMMA_RATIO_N_H,
    SdmVariant,
    build_input_covariance,
    build_matrix,
    build_rsdm_matrix,
    build_transform,
    constants_from_presets,
    cross_relaxation_rate,
    csa_constant,
    custom_constants,
    dipolar_constant,
    field_physics,
    larmor_frequencies,
    map_dataset,
    monte_carlo_covariance,
    reorder_lower_triangular,
    systematic_band,
)
from app.services.sdm.physics import W_H_EFF, W_N, ZERO

ROOT = pathlib.Path(__file__).resolve().parents[1]


# --------------------------------------------------------------------------
# Forward model: the FULL master equations, deliberately not the reduced ones.
# The round-trip test is only meaningful if the data it consumes was generated
# without the approximation under test.
# --------------------------------------------------------------------------

def lipari_szabo_j(omega, s2: float, tau_c: float, tau_e: float) -> np.ndarray:
    """Model-free spectral density.

    J(w) = (2/5)[ S^2 tau_c/(1+(w tau_c)^2)
                  + (1-S^2) tau/(1+(w tau)^2) ],  1/tau = 1/tau_c + 1/tau_e
    """
    omega = np.asarray(omega, dtype=np.float64)
    tau = 1.0 / (1.0 / tau_c + 1.0 / tau_e)
    return (2.0 / 5.0) * (
        s2 * tau_c / (1.0 + (omega * tau_c) ** 2)
        + (1.0 - s2) * tau / (1.0 + (omega * tau) ** 2)
    )


def forward_rates(s2, tau_c, tau_e, phys):
    """R1, R2, NOE from the full master equations for one residue."""
    d2, c2 = phys.d2, phys.c2
    wh, wn = phys.omega_h, phys.omega_n

    j0 = lipari_szabo_j(0.0, s2, tau_c, tau_e)
    j_wn = lipari_szabo_j(wn, s2, tau_c, tau_e)
    j_wh = lipari_szabo_j(wh, s2, tau_c, tau_e)
    j_diff = lipari_szabo_j(wh - wn, s2, tau_c, tau_e)
    j_sum = lipari_szabo_j(wh + wn, s2, tau_c, tau_e)

    r1 = (d2 / 4.0) * (j_diff + 3.0 * j_wn + 6.0 * j_sum) + c2 * j_wn
    r2 = (d2 / 8.0) * (
        4.0 * j0 + j_diff + 3.0 * j_wn + 6.0 * j_wh + 6.0 * j_sum
    ) + (c2 / 6.0) * (4.0 * j0 + 3.0 * j_wn)
    sigma = (d2 / 4.0) * (6.0 * j_sum - j_diff)
    noe = 1.0 + sigma * GAMMA_H / (GAMMA_N * r1)

    j_h_true = lipari_szabo_j(phys.omega_h_eff, s2, tau_c, tau_e)
    return r1, r2, noe, sigma, (j0, j_wn, j_h_true)


# --------------------------------------------------------------------------
# 3. Constant anchors
# --------------------------------------------------------------------------

def test_dipolar_constant_anchor():
    """|d| ~= 7.2e4 s^-1 at r_NH = 1.02 A."""
    consts = constants_from_presets("1.02", "-160")
    d = dipolar_constant(consts.r_nh)
    assert abs(d) == pytest.approx(7.2e4, rel=0.01)
    # gamma_N is negative and is not silently abs()'d, so d is negative.
    assert d < 0


def test_csa_constant_anchor():
    """c ~= 3.5e4 s^-1 at 600 MHz 1H with delta_sigma = -160 ppm."""
    consts = constants_from_presets("1.02", "-160")
    phys = field_physics(600e6, consts)
    assert phys.c == pytest.approx(3.5e4, rel=0.02)
    # Two negatives (omega_N, delta_sigma) give a positive c.
    assert phys.c > 0


def test_gamma_n_is_negative():
    """A sign flip here produces values that look 'a bit off', not broken."""
    assert GAMMA_N < 0
    assert GAMMA_RATIO_N_H < 0
    assert GAMMA_RATIO_N_H == pytest.approx(-0.1013, rel=0.01)


def test_larmor_frequencies_sign_and_scale():
    wh, wn = larmor_frequencies(600e6)
    assert wh == pytest.approx(2 * math.pi * 600e6)
    assert wn < 0
    assert abs(wn) == pytest.approx(abs(wh) * 0.1013, rel=0.01)


def test_bond_length_preset_changes_d_by_expected_amount():
    """1.02 vs 1.015 A is a ~1.5% change in d, i.e. ~3% in d^2."""
    d_102 = abs(dipolar_constant(constants_from_presets("1.02", "-160").r_nh))
    d_1015 = abs(dipolar_constant(constants_from_presets("1.015", "-160").r_nh))
    assert d_1015 > d_102
    assert d_1015 / d_102 == pytest.approx((1.02 / 1.015) ** 3, rel=1e-9)


# --------------------------------------------------------------------------
# 2. Structure
# --------------------------------------------------------------------------

@pytest.mark.parametrize("b0_mhz", [500.0, 600.0, 800.0, 950.0])
def test_matrix_is_lower_triangular_when_reordered(b0_mhz):
    """(sigma, R1, R2) x (J_h, J(wN), J(0)) is lower triangular.

    Forward substitution on that ordering reproduces the textbook sequential
    RSDM equations, so this is a structural check that a transcribed
    coefficient would break even when the determinant stays healthy.
    """
    phys = field_physics(b0_mhz * 1e6, constants_from_presets("1.02", "-160"))
    matrix, cols, rows = build_rsdm_matrix(phys)
    tri, _, _ = reorder_lower_triangular(matrix, cols, rows)
    assert np.abs(np.triu(tri, 1)).max() == 0.0


@pytest.mark.parametrize("b0_mhz", [500.0, 600.0, 800.0, 950.0])
def test_matrix_is_nonsingular_and_well_scaled(b0_mhz):
    """det != 0, and the triangular diagonal entries are within a factor ~2.

    The scale check catches a Hz-vs-rad/s mixup without hard-coding magic
    numbers: a factor-of-2pi error in omega shows up as a wildly skewed
    diagonal long before it shows up as a singular matrix.
    """
    phys = field_physics(b0_mhz * 1e6, constants_from_presets("1.02", "-160"))
    matrix, cols, rows = build_rsdm_matrix(phys)
    assert abs(np.linalg.det(matrix)) > 0

    tri, _, _ = reorder_lower_triangular(matrix, cols, rows)
    diag = np.abs(np.diag(tri))
    assert diag.min() > 0
    assert diag.max() / diag.min() < 2.5


def test_matrix_matches_the_published_coefficients():
    """Spot-check every entry against the algebra, not against a solved form.

    This is the guard against a hard-coded solved coefficient drifting from
    the master equations it is supposed to come from.
    """
    phys = field_physics(600e6, constants_from_presets("1.02", "-160"))
    d2, c2 = phys.d2, phys.c2
    matrix, cols, rows = build_rsdm_matrix(phys)
    i0, iwn, ih = cols.index(ZERO), cols.index(W_N), cols.index(W_H_EFF)
    r1, r2, sg = rows.index("R1"), rows.index("R2"), rows.index("sigma")

    assert matrix[r1, i0] == 0.0
    assert matrix[r1, iwn] == pytest.approx(3 * d2 / 4 + c2)
    assert matrix[r1, ih] == pytest.approx(7 * d2 / 4)

    assert matrix[r2, i0] == pytest.approx(d2 / 2 + 2 * c2 / 3)
    assert matrix[r2, iwn] == pytest.approx(3 * d2 / 8 + c2 / 2)
    assert matrix[r2, ih] == pytest.approx(13 * d2 / 8)

    assert matrix[sg, i0] == 0.0
    assert matrix[sg, iwn] == 0.0
    assert matrix[sg, ih] == pytest.approx(5 * d2 / 4)


def test_build_matrix_derives_column_order_from_labels():
    """Columns come from the union of labels, so a variant is data not code."""
    matrix, cols = build_matrix([{W_N: 2.0}, {ZERO: 1.0, W_H_EFF: 3.0}])
    assert cols == [ZERO, W_N, W_H_EFF]
    assert matrix.shape == (2, 3)
    assert matrix[0, cols.index(W_N)] == 2.0
    assert matrix[1, cols.index(W_H_EFF)] == 3.0


def test_build_matrix_rejects_unknown_frequency():
    with pytest.raises(ValueError, match="unknown frequency"):
        build_matrix([{ZERO: 1.0}], columns=[W_N])


def test_matrix_does_not_depend_on_measured_data():
    """M is a function of B0 and constants only -- built once per analysis."""
    phys = field_physics(600e6, constants_from_presets("1.02", "-160"))
    m1, _, _ = build_rsdm_matrix(phys)
    m2, _, _ = build_rsdm_matrix(phys)
    assert np.array_equal(m1, m2)


# --------------------------------------------------------------------------
# 1. Round trip against the full master equations
# --------------------------------------------------------------------------

ROUND_TRIP_GRID = [
    (s2, tau_c, tau_e)
    for s2 in (0.70, 0.85, 0.95)
    for tau_c in (5e-9, 10e-9, 15e-9)
    for tau_e in (20e-12, 100e-12, 500e-12)
]


@pytest.mark.parametrize("s2,tau_c,tau_e", ROUND_TRIP_GRID)
def test_round_trip_recovers_spectral_densities(s2, tau_c, tau_e):
    """Forward-model with the full equations, map back, compare.

    The residual is the cost of the reduced approximation itself, not an
    implementation error, so the tolerances are the documented bias bounds.
    """
    phys = field_physics(600e6, constants_from_presets("1.02", "-160"))
    r1, r2, noe, _, (j0_true, jwn_true, jh_true) = forward_rates(
        s2, tau_c, tau_e, phys
    )

    res = map_dataset(
        np.array([r1]), np.array([0.0]),
        np.array([r2]), np.array([0.0]),
        np.array([noe]), np.array([0.0]),
        phys,
    )

    assert res.j0[0] == pytest.approx(j0_true, rel=0.01)
    assert res.jwn[0] == pytest.approx(jwn_true, rel=0.03)
    assert res.jh[0] == pytest.approx(jh_true, rel=0.02)


def test_round_trip_bias_table():
    """Sweep the grid and record the approximation bias.

    The printed table is the source for the bias section of the user guide;
    the assertions pin the bounds quoted there so the docs cannot silently
    drift from the code.
    """
    phys = field_physics(600e6, constants_from_presets("1.02", "-160"))
    rows = []
    for s2, tau_c, tau_e in ROUND_TRIP_GRID:
        r1, r2, noe, _, (j0_t, jwn_t, jh_t) = forward_rates(s2, tau_c, tau_e, phys)
        res = map_dataset(
            np.array([r1]), np.array([0.0]),
            np.array([r2]), np.array([0.0]),
            np.array([noe]), np.array([0.0]),
            phys,
        )
        rows.append((
            s2, tau_c * 1e9, tau_e * 1e12,
            100.0 * (res.j0[0] - j0_t) / j0_t,
            100.0 * (res.jwn[0] - jwn_t) / jwn_t,
            100.0 * (res.jh[0] - jh_t) / jh_t,
        ))

    print("\n| S^2 | tau_c (ns) | tau_e (ps) | J(0) bias % | J(wN) bias % | J_h bias % |")
    print("|---|---|---|---|---|---|")
    for s2, tc, te, b0, bn, bh in rows:
        print(f"| {s2:.2f} | {tc:.0f} | {te:.0f} | "
              f"{b0:+.2f} | {bn:+.2f} | {bh:+.2f} |")

    # Bounds sit ~2-3x above the observed maxima (0.35 / 1.60 / 0.50 %), so
    # they are loose enough to survive grid changes but tight enough that a
    # real coefficient error trips them.
    bias = np.array([[r[3], r[4], r[5]] for r in rows])
    assert np.abs(bias[:, 0]).max() < 1.0, "J(0) bias exceeded the documented bound"
    assert np.abs(bias[:, 1]).max() < 3.0, "J(wN) bias exceeded the documented bound"
    assert np.abs(bias[:, 2]).max() < 2.0, "J_h bias exceeded the documented bound"


def test_round_trip_is_vectorised_over_residues():
    """One solve for N residues must equal N single-residue solves."""
    phys = field_physics(700e6, constants_from_presets("1.02", "-170"))
    params = [(0.8, 8e-9, 50e-12), (0.9, 12e-9, 100e-12), (0.6, 6e-9, 300e-12)]
    r1s, r2s, noes = [], [], []
    for s2, tc, te in params:
        r1, r2, noe, _, _ = forward_rates(s2, tc, te, phys)
        r1s.append(r1); r2s.append(r2); noes.append(noe)

    zeros = np.zeros(len(params))
    batch = map_dataset(
        np.array(r1s), zeros, np.array(r2s), zeros, np.array(noes), zeros, phys
    )
    for i in range(len(params)):
        one = map_dataset(
            np.array([r1s[i]]), np.zeros(1),
            np.array([r2s[i]]), np.zeros(1),
            np.array([noes[i]]), np.zeros(1),
            phys,
        )
        assert batch.j[i] == pytest.approx(one.j[0], rel=1e-12)


# --------------------------------------------------------------------------
# 4. Covariance
# --------------------------------------------------------------------------

def _demo_dataset(phys, n=4):
    r1s, r2s, noes = [], [], []
    for s2, tc, te in [(0.85, 9e-9, 50e-12), (0.75, 9e-9, 200e-12),
                       (0.90, 11e-9, 30e-12), (0.65, 7e-9, 400e-12)][:n]:
        r1, r2, noe, _, _ = forward_rates(s2, tc, te, phys)
        r1s.append(r1); r2s.append(r2); noes.append(noe)
    return np.array(r1s), np.array(r2s), np.array(noes)


def test_transform_carries_the_r1_sigma_coupling():
    """T's bottom-left entry is k(NOE-1); its absence is the classic bug."""
    r1 = np.array([1.5, 2.0])
    noe = np.array([0.75, -0.20])
    t = build_transform(r1, noe)
    assert t.shape == (2, 3, 3)
    for i in range(2):
        assert t[i, 0, 0] == 1.0
        assert t[i, 1, 1] == 1.0
        assert t[i, 2, 0] == pytest.approx(GAMMA_RATIO_N_H * (noe[i] - 1.0))
        assert t[i, 2, 2] == pytest.approx(GAMMA_RATIO_N_H * r1[i])
        # sigma does not depend on R2.
        assert t[i, 2, 1] == 0.0


def test_covariance_is_dense_for_diagonal_inputs():
    """J(0), J(wN) and J_h are mutually correlated even for independent rates.

    Storing only the three variances would discard this, and every derived
    quantity -- tau_c, trimmed means, the correlation plot's ellipses --
    needs the off-diagonals.
    """
    phys = field_physics(600e6, constants_from_presets("1.02", "-160"))
    r1, r2, noe = _demo_dataset(phys)
    res = map_dataset(
        r1, 0.02 * r1, r2, 0.02 * r2, noe, np.full_like(noe, 0.03), phys
    )
    for i in range(len(r1)):
        cov = res.covariance[i]
        assert cov[0, 1] != 0.0, "J(0)-J(wN) covariance must not vanish"
        assert cov[0, 2] != 0.0
        assert cov[1, 2] != 0.0
        # Symmetric and positive semi-definite.
        assert np.allclose(cov, cov.T)
        assert np.linalg.eigvalsh(cov).min() > -1e-30


def test_analytic_covariance_matches_monte_carlo():
    """Analytic vs 1e5-replicate MC, within MC error.

    The map is exactly linear in the rates, so the only thing MC can disagree
    with is the sigma = k(NOE-1)R1 product -- which is precisely what makes
    this a real test of T rather than a tautology.
    """
    phys = field_physics(600e6, constants_from_presets("1.02", "-160"))
    r1, r2, noe = _demo_dataset(phys, n=3)
    r1_e, r2_e, noe_e = 0.03 * r1, 0.03 * r2, np.full_like(noe, 0.04)

    analytic = map_dataset(r1, r1_e, r2, r2_e, noe, noe_e, phys)
    n_rep = 100_000
    _, mc_cov = monte_carlo_covariance(
        r1, r1_e, r2, r2_e, noe, noe_e, phys, n_replicates=n_rep, seed=20260908
    )

    # Relative standard error of a sample (co)variance is ~sqrt(2/(n-1));
    # allow 5 sigma of that plus a small floor.
    tol = 5.0 * math.sqrt(2.0 / (n_rep - 1)) + 0.01
    for i in range(len(r1)):
        for a in range(3):
            for b in range(3):
                scale = math.sqrt(
                    abs(analytic.covariance[i, a, a] * analytic.covariance[i, b, b])
                )
                assert abs(mc_cov[i, a, b] - analytic.covariance[i, a, b]) <= tol * scale


@pytest.mark.parametrize("noe_err", [0.01, 0.05, 0.15, 0.40])
def test_analytic_covariance_matches_monte_carlo_for_large_noe_errors(noe_err):
    """The agreement must hold where the NOE error is large.

    J(0.87 wH) is dominated by the NOE error, so this is the regime where a
    mishandled sigma product would show up first.
    """
    phys = field_physics(600e6, constants_from_presets("1.02", "-160"))
    r1, r2, noe = _demo_dataset(phys, n=2)
    r1_e, r2_e = 0.02 * r1, 0.02 * r2
    noe_e = np.full_like(noe, noe_err)

    analytic = map_dataset(r1, r1_e, r2, r2_e, noe, noe_e, phys)
    n_rep = 60_000
    _, mc_cov = monte_carlo_covariance(
        r1, r1_e, r2, r2_e, noe, noe_e, phys, n_replicates=n_rep, seed=7
    )
    tol = 5.0 * math.sqrt(2.0 / (n_rep - 1)) + 0.02
    for i in range(len(r1)):
        for a in range(3):
            scale = analytic.covariance[i, a, a]
            assert abs(mc_cov[i, a, a] - scale) <= tol * abs(scale)


def test_dropping_the_transform_disagrees_with_monte_carlo():
    """The guard test: omitting T must visibly break the error bars.

    Treating sigma as an independent observable -- propagating only its
    variance and ignoring that R1 appears in both y1 and y3 -- is the most
    common quiet error in published RSDM error bars. If this test ever
    passes, the T matrix has stopped doing its job.
    """
    phys = field_physics(600e6, constants_from_presets("1.02", "-160"))
    r1, r2, noe = _demo_dataset(phys, n=2)
    r1_e, r2_e, noe_e = 0.05 * r1, 0.05 * r2, np.full_like(noe, 0.05)

    correct = map_dataset(r1, r1_e, r2, r2_e, noe, noe_e, phys)
    _, mc_cov = monte_carlo_covariance(
        r1, r1_e, r2, r2_e, noe, noe_e, phys, n_replicates=60_000, seed=99
    )

    # The naive alternative: correct sigma variance, but no cross-terms.
    matrix, _, _ = build_rsdm_matrix(phys)
    minv = np.linalg.inv(matrix)
    t = build_transform(r1, noe)
    cov_u = build_input_covariance(r1_e, r2_e, noe_e)
    sigma_var = np.einsum("nj,njk,nk->n", t[:, 2, :], cov_u, t[:, 2, :])

    worst_correct, worst_naive = 0.0, 0.0
    for i in range(len(r1)):
        cov_y_naive = np.diag([r1_e[i] ** 2, r2_e[i] ** 2, sigma_var[i]])
        naive = minv @ cov_y_naive @ minv.T
        for a in range(3):
            ref = mc_cov[i, a, a]
            worst_correct = max(
                worst_correct, abs(correct.covariance[i, a, a] - ref) / abs(ref)
            )
            worst_naive = max(worst_naive, abs(naive[a, a] - ref) / abs(ref))

    assert worst_correct < 0.05, "the T-aware result should track MC closely"
    assert worst_naive > 0.20, (
        "dropping T should visibly disagree with MC; if this fails, the "
        "guard has stopped discriminating"
    )


def test_monte_carlo_mean_matches_the_analytic_point_estimate():
    phys = field_physics(600e6, constants_from_presets("1.02", "-160"))
    r1, r2, noe = _demo_dataset(phys, n=3)
    r1_e, r2_e, noe_e = 0.02 * r1, 0.02 * r2, np.full_like(noe, 0.02)
    analytic = map_dataset(r1, r1_e, r2, r2_e, noe, noe_e, phys)
    mc_mean, _ = monte_carlo_covariance(
        r1, r1_e, r2, r2_e, noe, noe_e, phys, n_replicates=40_000, seed=3
    )
    for i in range(len(r1)):
        assert mc_mean[i] == pytest.approx(analytic.j[i], rel=0.02)


def test_monte_carlo_progress_callback_reports_completion():
    """The Celery path emits kind='resample' events off this callback."""
    phys = field_physics(600e6, constants_from_presets("1.02", "-160"))
    r1, r2, noe = _demo_dataset(phys, n=2)
    seen = []
    monte_carlo_covariance(
        r1, 0.02 * r1, r2, 0.02 * r2, noe, np.full_like(noe, 0.02), phys,
        n_replicates=1000, seed=1, chunk_size=250,
        progress_callback=lambda done, total, msg: seen.append((done, total)),
    )
    assert seen[-1] == (1000, 1000)
    assert [d for d, _ in seen] == [250, 500, 750, 1000]


def test_monte_carlo_is_reproducible_for_a_fixed_seed():
    phys = field_physics(600e6, constants_from_presets("1.02", "-160"))
    r1, r2, noe = _demo_dataset(phys, n=2)
    args = (r1, 0.02 * r1, r2, 0.02 * r2, noe, np.full_like(noe, 0.02), phys)
    a_mean, a_cov = monte_carlo_covariance(*args, n_replicates=2000, seed=42)
    b_mean, b_cov = monte_carlo_covariance(*args, n_replicates=2000, seed=42)
    assert np.array_equal(a_mean, b_mean)
    assert np.array_equal(a_cov, b_cov)


# --------------------------------------------------------------------------
# Physically valid edge cases that must be mapped, not filtered
# --------------------------------------------------------------------------

def test_negative_noe_is_mapped_not_filtered():
    """Negative NOE is valid for tails and loops; it must produce a result."""
    phys = field_physics(600e6, constants_from_presets("1.02", "-160"))
    res = map_dataset(
        np.array([1.2]), np.array([0.05]),
        np.array([4.0]), np.array([0.2]),
        np.array([-0.5]), np.array([0.1]),
        phys,
    )
    assert np.all(np.isfinite(res.j))
    assert res.sigma[0] > 0  # k<0 and (NOE-1)<0 give a positive sigma
    # J_h carries a large relative error in this regime.
    assert res.errors[0, 2] / abs(res.j[0, 2]) > 0.05


def test_near_zero_noe_is_mapped():
    phys = field_physics(600e6, constants_from_presets("1.02", "-160"))
    res = map_dataset(
        np.array([1.3]), np.array([0.05]),
        np.array([12.0]), np.array([0.4]),
        np.array([0.001]), np.array([0.05]),
        phys,
    )
    assert np.all(np.isfinite(res.j))


def test_cross_relaxation_sign_convention():
    """sigma = k(NOE-1)R1 with k negative."""
    sigma = cross_relaxation_rate(np.array([0.8]), np.array([1.5]))
    assert sigma[0] == pytest.approx(GAMMA_RATIO_N_H * (0.8 - 1.0) * 1.5)
    assert sigma[0] > 0


# --------------------------------------------------------------------------
# Input validation
# --------------------------------------------------------------------------

def test_map_dataset_rejects_mismatched_lengths():
    phys = field_physics(600e6, constants_from_presets("1.02", "-160"))
    with pytest.raises(ValueError, match="same length"):
        map_dataset(
            np.array([1.0, 2.0]), np.array([0.1, 0.1]),
            np.array([10.0]), np.array([0.5]),
            np.array([0.7, 0.7]), np.array([0.05, 0.05]),
            phys,
        )


def test_larmor_rejects_non_positive_field():
    with pytest.raises(ValueError, match="must be positive"):
        larmor_frequencies(0.0)


def test_dipolar_constant_rejects_non_positive_distance():
    with pytest.raises(ValueError, match="must be positive"):
        dipolar_constant(0.0)


def test_custom_constants_reject_unit_mistakes():
    """A metre typed where an Angstrom was meant must not sail through."""
    with pytest.raises(ValueError, match="plausible range"):
        custom_constants(1.02e-10, -160.0)
    with pytest.raises(ValueError, match="plausible range"):
        custom_constants(1.02, -160000.0)


def test_unknown_preset_names_are_rejected():
    with pytest.raises(KeyError, match="Unknown r_NH preset"):
        constants_from_presets("1.09", "-160")
    with pytest.raises(KeyError, match="Unknown delta_sigma preset"):
        constants_from_presets("1.02", "-999")


# --------------------------------------------------------------------------
# Snapshot and systematic band
# --------------------------------------------------------------------------

def test_snapshot_distinguishes_constant_choices():
    """Re-running with a different CSA must produce a distinguishable record."""
    a = field_physics(600e6, constants_from_presets("1.02", "-160")).to_snapshot()
    b = field_physics(600e6, constants_from_presets("1.02", "-172")).to_snapshot()
    assert a != b
    assert a["constants"]["delta_sigma_ppm"] == pytest.approx(-160.0)
    assert b["constants"]["delta_sigma_ppm"] == pytest.approx(-172.0)
    assert a["variant"] == SdmVariant.FARROW1995.value
    assert a["high_freq_factor"] == 0.87
    # The snapshot is self-describing: everything needed to rebuild the
    # matrix is present.
    for key in ("b0_h_hz", "d_rad_s", "c_rad_s", "omega_n_rad_s"):
        assert key in a


def test_systematic_band_is_coherent_not_per_residue():
    """The constants choice shifts every residue the same way."""
    consts = constants_from_presets("1.02", "-160")
    phys = field_physics(600e6, consts)
    r1, r2, noe = _demo_dataset(phys, n=4)
    band = systematic_band(
        r1, 0.02 * r1, r2, 0.02 * r2, noe, np.full_like(noe, 0.02),
        600e6, consts, SdmVariant.FARROW1995,
    )
    assert band.lower.shape == band.reference.shape == (4, 3)
    assert np.all(band.lower <= band.reference + 1e-30)
    assert np.all(band.upper >= band.reference - 1e-30)
    # Coherent: the sign of the shift is the same for every residue.
    shift = band.upper[:, 0] - band.reference[:, 0]
    assert np.all(shift >= 0)
    assert np.all(band.fractional_span() >= 0)


def test_j_units_are_converted_only_at_the_boundary():
    """Internals are s rad^-1; ns rad^-1 appears only via the display helper."""
    phys = field_physics(600e6, constants_from_presets("1.02", "-160"))
    r1, r2, noe = _demo_dataset(phys, n=2)
    res = map_dataset(r1, 0.02 * r1, r2, 0.02 * r2, noe,
                      np.full_like(noe, 0.02), phys)
    # A typical J(0) for a ~10 ns tumbler is a few ns rad^-1.
    assert 0.5 < res.j_ns()[0, 0] < 10.0
    assert np.allclose(res.j_ns(), res.j * 1e9)
    assert np.allclose(res.errors_ns(), res.errors * 1e9)


# --------------------------------------------------------------------------
# The package must stay usable from a plain script
# --------------------------------------------------------------------------

def test_package_pulls_in_no_web_or_orm_dependencies():
    """app.services.sdm must be importable standalone.

    Phase 1 requires the core to be usable from a plain Python script against
    arrays, so importing it must not drag in FastAPI, SQLAlchemy, Celery or
    the app's database module. Run in a subprocess because the rest of the
    test session has already imported all of them.
    """
    import subprocess
    import sys
    import textwrap

    script = textwrap.dedent(
        """
        import sys
        import app.services.sdm as sdm   # noqa: F401

        forbidden = [
            m for m in sys.modules
            if m.split(".")[0] in {"fastapi", "sqlalchemy", "celery", "starlette"}
            or m.startswith("app.models")
            or m.startswith("app.database")
        ]
        if forbidden:
            print("LEAKED:" + ",".join(sorted(forbidden)))
            sys.exit(1)
        print("CLEAN")
        """
    )
    proc = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True, text=True, cwd=str(ROOT),
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "CLEAN" in proc.stdout


def test_core_workflow_runs_without_any_app_context():
    """The documented three-line usage from the package docstring."""
    consts = constants_from_presets("1.02", "-160")
    phys = field_physics(600.13e6, consts)
    result = map_dataset(
        np.array([1.35, 1.28]), np.array([0.03, 0.03]),
        np.array([12.1, 13.4]), np.array([0.30, 0.35]),
        np.array([0.78, 0.71]), np.array([0.04, 0.04]),
        phys,
    )
    assert result.j_ns().shape == (2, 3)
    assert result.covariance.shape == (2, 3, 3)


# --------------------------------------------------------------------------
# 5. Literature regression
# --------------------------------------------------------------------------

LITERATURE_FIXTURE = ROOT / "tests" / "fixtures" / "sdm" / "literature_rsdm.json"


@pytest.mark.skipif(
    not LITERATURE_FIXTURE.is_file(),
    reason=(
        "No published RSDM dataset has been supplied yet. Drop a fixture at "
        "tests/fixtures/sdm/literature_rsdm.json to enable this regression. "
        "Deliberately NOT fabricated: a made-up fixture would anchor the "
        "implementation to itself and prove nothing."
    ),
)
def test_matches_published_spectral_densities():
    """Regression against a published R1/R2/NOE dataset with expected J values.

    Expected fixture shape:
        {
          "citation":       "<paper, journal, year, doi>",
          "b0_h_mhz":       600.13,
          "r_nh_angstrom":  1.02,
          "delta_sigma_ppm": -160.0,
          "variant":        "farrow1995",
          "tolerance_rel":  0.02,
          "residues": [
            {"assignment": "G14N", "r1": 1.35, "r1_err": 0.03,
             "r2": 12.1, "r2_err": 0.30, "noe": 0.78, "noe_err": 0.04,
             "j0_ns": 3.71, "j_wn_ns": 0.31, "j_h_ns": 0.011},
            ...
          ]
        }
    J values in ns rad^-1. The authors' r_NH and CSA must be the ones they
    actually used, or the comparison tests the constants rather than the map.
    """
    import json

    data = json.loads(LITERATURE_FIXTURE.read_text())
    consts = custom_constants(
        data["r_nh_angstrom"], data["delta_sigma_ppm"],
        label=f"literature: {data['citation']}",
    )
    phys = field_physics(
        data["b0_h_mhz"] * 1e6, consts, SdmVariant(data.get("variant", "farrow1995"))
    )
    res_in = data["residues"]
    zeros = np.zeros(len(res_in))
    result = map_dataset(
        np.array([r["r1"] for r in res_in]),
        np.array([r.get("r1_err", 0.0) for r in res_in]),
        np.array([r["r2"] for r in res_in]),
        np.array([r.get("r2_err", 0.0) for r in res_in]),
        np.array([r["noe"] for r in res_in]),
        np.array([r.get("noe_err", 0.0) for r in res_in]),
        phys,
    )
    del zeros

    tol = data.get("tolerance_rel", 0.02)
    j_ns = result.j_ns()
    for i, row in enumerate(res_in):
        assert j_ns[i, 0] == pytest.approx(row["j0_ns"], rel=tol), row["assignment"]
        assert j_ns[i, 1] == pytest.approx(row["j_wn_ns"], rel=tol), row["assignment"]
        assert j_ns[i, 2] == pytest.approx(row["j_h_ns"], rel=tol), row["assignment"]
