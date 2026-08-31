import tempfile
from pathlib import Path
import numpy as np
import pytest

from app.services.fitting.statistics_engine import (
    compute_parameter_summary,
    compute_freedman_diaconis_bins,
    compute_parameter_histogram,
    compute_joint_2d_distribution,
    compute_correlation_matrix,
    propagate_derived_quantities,
    save_replicates_npz,
    save_mcmc_chains_npz,
    load_replicates_or_fallback,
    parse_tsv_samples_matrix,
)


def test_compute_parameter_summary_accuracy():
    np.random.seed(42)
    # Generate 1000 samples with mean 100, std 10
    col1 = np.random.normal(100.0, 10.0, size=1000)
    # Generate skewed log-normal samples
    col2 = np.random.lognormal(mean=2.0, sigma=0.5, size=1000)

    replicates = np.column_stack([col1, col2])
    param_names = ["KEX_AB", "PB"]
    det_vals = {"KEX_AB": 100.2, "PB": 7.38}

    summary = compute_parameter_summary(replicates, param_names, deterministic_values=det_vals)

    assert "KEX_AB" in summary
    assert "PB" in summary

    kex = summary["KEX_AB"]
    assert kex["sample_count"] == 1000
    assert kex["mean"] == pytest.approx(100.0, abs=1.0)
    assert kex["median"] == pytest.approx(100.0, abs=1.0)
    assert kex["standard_deviation"] == pytest.approx(10.0, abs=0.8)
    assert kex["std_dev"] == kex["standard_deviation"]
    assert kex["std"] == kex["standard_deviation"]
    assert kex["sem"] == pytest.approx(10.0 / np.sqrt(1000), abs=0.1)
    assert kex["percentile_95_lower"] < kex["median"] < kex["percentile_95_upper"]
    assert kex["deterministic_value"] == 100.2
    assert kex["bias"] is not None

    pb = summary["PB"]
    assert pb["is_skewed"] is True  # Log-normal distribution is skewed
    assert pb["skew"] > 0.45
    assert pb["asymmetric_upper"] > pb["asymmetric_lower"]


def test_freedman_diaconis_histogram():
    np.random.seed(42)
    samples = np.random.normal(50.0, 5.0, size=500)
    replicates = samples[:, np.newaxis]
    param_names = ["R2_A"]

    hist = compute_parameter_histogram(replicates, param_names, "R2_A", deterministic_value=50.1)
    assert hist is not None
    assert hist["parameter_name"] == "R2_A"
    assert hist["sample_count"] == 500
    assert len(hist["counts"]) == len(hist["bin_centers"])
    assert len(hist["bin_edges"]) == len(hist["counts"]) + 1
    assert sum(hist["counts"]) == 500
    assert hist["deterministic_value"] == 50.1


def test_joint_2d_distribution_and_correlation():
    np.random.seed(42)
    x = np.random.normal(100.0, 10.0, size=500)
    y = -0.8 * x + np.random.normal(0.0, 2.0, size=500)
    replicates = np.column_stack([x, y])
    param_names = ["KEX_AB", "R2_A"]

    joint = compute_joint_2d_distribution(replicates, param_names, "KEX_AB", "R2_A", bins=20)
    assert joint is not None
    assert joint["correlation_r"] == pytest.approx(-0.97, abs=0.05)
    assert len(joint["counts_2d"]) == 20
    assert len(joint["counts_2d"][0]) == 20

    corr = compute_correlation_matrix(replicates, param_names)
    assert corr["matrix"][0][0] == 1.0
    assert corr["matrix"][1][1] == 1.0
    assert corr["matrix"][0][1] == pytest.approx(-0.97, abs=0.05)
    assert corr["matrix"][1][0] == corr["matrix"][0][1]


def test_derived_quantity_propagation():
    # Test that k_ab = k_ex * p_B and tau_b = 1 / (k_ex * (1 - p_B)) are preserved per replicate
    kex = np.array([400.0, 500.0, 600.0])
    pb = np.array([0.01, 0.02, 0.03])
    replicates = np.column_stack([kex, pb])
    param_names = ["[KEX_AB]", "[PB]"]

    derived = propagate_derived_quantities(replicates, param_names)
    assert "KAB" in derived
    assert "KBA" in derived
    assert "TAU_B_MS" in derived

    expected_kab = kex * pb
    expected_kba = kex * (1.0 - pb)
    expected_tau_b_ms = (1.0 / expected_kba) * 1000.0

    np.testing.assert_allclose(derived["KAB"], expected_kab)
    np.testing.assert_allclose(derived["KBA"], expected_kba)
    np.testing.assert_allclose(derived["TAU_B_MS"], expected_tau_b_ms)


def test_npz_persistence_and_fallback():
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp_path = Path(tmpdir)
        mc_dir = tmp_path / "MonteCarlo"
        mc_dir.mkdir()

        # 1. Write mock samples.tsv
        tsv_file = mc_dir / "samples.tsv"
        tsv_content = (
            "[CS_A, NUC->14N]\t[KEX_AB]\tchisqr\n"
            "113.62\t450.1\t350.2\n"
            "113.64\t452.3\t348.1\n"
            "113.61\t448.9\t352.0\n"
        )
        tsv_file.write_text(tsv_content, encoding="utf-8")

        # 2. Test parse_tsv_samples_matrix
        p_names, rep_mat, chisqr = parse_tsv_samples_matrix(tsv_file)
        assert p_names == ["[CS_A, NUC->14N]", "[KEX_AB]"]
        assert rep_mat.shape == (3, 2)
        assert len(chisqr) == 3

        # 3. Test load_replicates_or_fallback (which should cache replicates.npz)
        data = load_replicates_or_fallback(mc_dir, "MonteCarlo")
        assert data is not None
        assert data["replicates"].shape == (3, 2)
        assert data["parameter_names"] == ["[CS_A, NUC->14N]", "[KEX_AB]"]

        # Confirm replicates.npz was created
        assert (mc_dir / "replicates.npz").is_file()

        # 4. Load directly from the cached .npz
        data_cached = load_replicates_or_fallback(mc_dir, "MonteCarlo")
        assert data_cached is not None
        np.testing.assert_allclose(data_cached["replicates"], rep_mat)


def test_mcmc_chain_persistence():
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp_path = Path(tmpdir)
        mcmc_dir = tmp_path / "MCMC"
        mcmc_dir.mkdir()

        # 4 walkers, 10 steps, 2 parameters
        chains = np.random.normal(50.0, 2.0, size=(4, 10, 2))
        param_names = ["KEX_AB", "PB"]

        npz_file = mcmc_dir / "mcmc_chains.npz"
        save_mcmc_chains_npz(npz_file, chains, param_names, discarded_steps=5, thin=2)

        data = load_replicates_or_fallback(mcmc_dir, "MCMC")
        assert data is not None
        assert data["is_mcmc"] is True
        assert data["chains"].shape == (4, 10, 2)
        assert data["replicates"].shape == (40, 2)  # Flattened draws
        assert data["metadata"]["discarded_steps"] == 5
        assert data["metadata"]["thin"] == 2
