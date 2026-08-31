"""
Core Statistical Calculation Engine for resoFlow.
Handles replicate array persistence (.npz), dynamic statistical derivation
(mean, std, median, 95% percentiles, skewness, SEM), Freedman-Diaconis histogram binning,
2D joint distributions, and per-replicate derived quantity propagation.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

import numpy as np

logger = logging.getLogger(__name__)


def clean_param_name(name: str) -> str:
    """Strip brackets, quotes, and whitespace from parameter names."""
    return name.strip().strip('"').strip("'").strip("[]").strip()


def compute_parameter_summary(
    replicates: np.ndarray,
    parameter_names: List[str],
    deterministic_values: Optional[Dict[str, float]] = None,
    interval_pct: float = 95.0,
) -> Dict[str, Dict[str, Any]]:
    """
    Derive all summary statistics for a parameter matrix (shape: n_samples, n_params).
    All statistics are derived purely from this single replicate array at read time.
    """
    if deterministic_values is None:
        deterministic_values = {}

    summary: Dict[str, Dict[str, Any]] = {}
    n_samples, n_params = replicates.shape

    alpha = (100.0 - interval_pct) / 2.0
    p_lower_val = alpha
    p_upper_val = 100.0 - alpha

    for col_idx, raw_name in enumerate(parameter_names):
        param_name = clean_param_name(raw_name)
        col = replicates[:, col_idx]

        # Filter out NaNs if any
        valid_mask = ~np.isnan(col)
        valid_col = col[valid_mask]
        n_valid = len(valid_col)

        if n_valid == 0:
            summary[param_name] = {
                "parameter_name": param_name,
                "interval": f"{interval_pct:.0f}% percentile",
                "sample_count": 0,
                "mean": None,
                "standard_deviation": None,
                "std_dev": None,
                "std": None,
                "sem": None,
                "median": None,
                "percentile_95_lower": None,
                "percentile_95_upper": None,
                "interval_95_lower": None,
                "interval_95_upper": None,
                "lower_1sigma": None,
                "upper_1sigma": None,
                "stderr": None,
                "skew": None,
                "asymmetric_lower": None,
                "asymmetric_upper": None,
                "is_skewed": False,
                "deterministic_value": deterministic_values.get(param_name),
                "bias": None,
            }
            continue

        median_val = float(np.median(valid_col))
        mean_val = float(np.mean(valid_col))
        std_val = float(np.std(valid_col, ddof=1)) if n_valid > 1 else 0.0
        sem_val = float(std_val / np.sqrt(n_valid)) if n_valid > 0 else 0.0

        p_low = float(np.percentile(valid_col, p_lower_val))
        p_high = float(np.percentile(valid_col, p_upper_val))
        sig1_low = float(np.percentile(valid_col, 15.8655))
        sig1_high = float(np.percentile(valid_col, 84.1345))

        # Fisher-Pearson Skewness
        if n_valid >= 3 and std_val > 1e-15:
            m3 = float(np.mean((valid_col - mean_val) ** 3))
            skew_val = float((m3 / (std_val ** 3)) * (np.sqrt(n_valid * (n_valid - 1)) / (n_valid - 2)))
        elif std_val > 1e-15:
            skew_val = float(3.0 * (mean_val - median_val) / std_val)
        else:
            skew_val = 0.0

        asym_lower = float(median_val - p_low)
        asym_upper = float(p_high - median_val)

        # Flag skewed distributions where asymmetric intervals represent reality better than +/- SD
        is_skewed = bool(
            abs(skew_val) > 0.45
            or (
                asym_lower > 1e-9
                and asym_upper > 1e-9
                and (asym_lower / asym_upper > 1.35 or asym_upper / asym_lower > 1.35)
            )
        )

        det_val = deterministic_values.get(param_name)
        if det_val is None:
            # Check raw name or lowercase name
            det_val = deterministic_values.get(raw_name) or deterministic_values.get(param_name.lower())

        bias = float((det_val - median_val) / std_val) if (det_val is not None and std_val > 1e-15) else None

        summary[param_name] = {
            "parameter_name": param_name,
            "interval": f"{interval_pct:.0f}% percentile",
            "sample_count": n_valid,
            "mean": mean_val,
            "standard_deviation": std_val,
            "std_dev": std_val,
            "std": std_val,
            "sem": sem_val,
            "median": median_val,
            "percentile_95_lower": p_low,
            "percentile_95_upper": p_high,
            "interval_95_lower": p_low,
            "interval_95_upper": p_high,
            "eti_95_lower": p_low,
            "eti_95_upper": p_high,
            "lower_1sigma": sig1_low,
            "upper_1sigma": sig1_high,
            "stderr": std_val,  # For ChemEx resampling, stderr was replicate SD
            "skew": skew_val,
            "asymmetric_lower": asym_lower,
            "asymmetric_upper": asym_upper,
            "is_skewed": is_skewed,
            "deterministic_value": det_val,
            "bias": bias,
        }

    return summary


def compute_freedman_diaconis_bins(data: np.ndarray) -> int:
    """Calculate optimal number of histogram bins using Freedman-Diaconis rule."""
    valid = data[~np.isnan(data)]
    n = len(valid)
    if n < 2:
        return 10

    q75, q25 = np.percentile(valid, [75, 25])
    iqr = q75 - q25
    val_range = float(np.max(valid) - np.min(valid))

    if iqr > 1e-12 and val_range > 1e-12:
        bin_width = 2.0 * iqr * (n ** (-1.0 / 3.0))
        if bin_width > 0:
            num_bins = int(np.ceil(val_range / bin_width))
            return int(np.clip(num_bins, 15, 80))

    # Fallback to Scott's rule
    std = float(np.std(valid, ddof=1))
    if std > 1e-12 and val_range > 1e-12:
        bin_width = 3.49 * std * (n ** (-1.0 / 3.0))
        if bin_width > 0:
            num_bins = int(np.ceil(val_range / bin_width))
            return int(np.clip(num_bins, 15, 80))

    # Fallback to square-root rule
    return int(np.clip(int(np.ceil(np.sqrt(n))), 10, 50))


def compute_parameter_histogram(
    replicates: np.ndarray,
    parameter_names: List[str],
    target_param: str,
    bins: Optional[int] = None,
    deterministic_value: Optional[float] = None,
) -> Optional[Dict[str, Any]]:
    """
    Compute 1D server-side histogram binning with Freedman-Diaconis rule.
    Returns bin edges, bin centers, counts, and statistical markers.
    """
    clean_target = clean_param_name(target_param).lower()
    col_idx = None

    for idx, name in enumerate(parameter_names):
        if clean_param_name(name).lower() == clean_target:
            col_idx = idx
            break

    if col_idx is None:
        return None

    col = replicates[:, col_idx]
    valid = col[~np.isnan(col)]
    n = len(valid)
    if n == 0:
        return None

    if bins is None or bins <= 0:
        num_bins = compute_freedman_diaconis_bins(valid)
    else:
        num_bins = int(np.clip(bins, 5, 200))

    counts, bin_edges = np.histogram(valid, bins=num_bins)
    bin_centers = (bin_edges[:-1] + bin_edges[1:]) / 2.0

    median_val = float(np.median(valid))
    mean_val = float(np.mean(valid))
    std_val = float(np.std(valid, ddof=1)) if n > 1 else 0.0
    p_low = float(np.percentile(valid, 2.5))
    p_high = float(np.percentile(valid, 97.5))

    # Compute skew
    if n >= 3 and std_val > 1e-15:
        m3 = float(np.mean((valid - mean_val) ** 3))
        skew_val = float((m3 / (std_val ** 3)) * (np.sqrt(n * (n - 1)) / (n - 2)))
    else:
        skew_val = 0.0

    return {
        "parameter_name": parameter_names[col_idx],
        "sample_count": n,
        "bin_edges": bin_edges.tolist(),
        "bin_centers": bin_centers.tolist(),
        "counts": counts.tolist(),
        "median": median_val,
        "mean": mean_val,
        "std_dev": std_val,
        "percentile_95_lower": p_low,
        "percentile_95_upper": p_high,
        "deterministic_value": deterministic_value,
        "skew": skew_val,
        "is_skewed": bool(abs(skew_val) > 0.45 or abs((median_val - p_low) - (p_high - median_val)) / max(std_val, 1e-6) > 0.3),
    }


def compute_joint_2d_distribution(
    replicates: np.ndarray,
    parameter_names: List[str],
    param_x: str,
    param_y: str,
    bins: int = 25,
    x_deterministic: Optional[float] = None,
    y_deterministic: Optional[float] = None,
) -> Optional[Dict[str, Any]]:
    """
    Compute 2D joint histogram / density grid and correlation for a parameter pair.
    """
    clean_x = clean_param_name(param_x).lower()
    clean_y = clean_param_name(param_y).lower()

    idx_x = None
    idx_y = None

    for idx, name in enumerate(parameter_names):
        cname = clean_param_name(name).lower()
        if cname == clean_x:
            idx_x = idx
        if cname == clean_y:
            idx_y = idx

    if idx_x is None or idx_y is None:
        return None

    x_col = replicates[:, idx_x]
    y_col = replicates[:, idx_y]

    mask = ~np.isnan(x_col) & ~np.isnan(y_col)
    x_valid = x_col[mask]
    y_valid = y_col[mask]

    n = len(x_valid)
    if n == 0:
        return None

    # Correlation coefficient
    if np.std(x_valid) > 1e-12 and np.std(y_valid) > 1e-12:
        r_matrix = np.corrcoef(x_valid, y_valid)
        r_val = float(r_matrix[0, 1]) if not np.isnan(r_matrix[0, 1]) else 0.0
    else:
        r_val = 0.0

    num_bins = int(np.clip(bins, 10, 60))
    counts_2d, x_edges, y_edges = np.histogram2d(x_valid, y_valid, bins=num_bins)
    x_centers = ((x_edges[:-1] + x_edges[1:]) / 2.0).tolist()
    y_centers = ((y_edges[:-1] + y_edges[1:]) / 2.0).tolist()

    return {
        "param_x": parameter_names[idx_x],
        "param_y": parameter_names[idx_y],
        "sample_count": n,
        "correlation_r": r_val,
        "x_edges": x_edges.tolist(),
        "y_edges": y_edges.tolist(),
        "x_bins": x_centers,
        "y_bins": y_centers,
        "x_centers": x_centers,
        "y_centers": y_centers,
        "counts_2d": counts_2d.T.tolist(),  # Transpose so rows are Y and columns are X
        "x_deterministic": x_deterministic,
        "y_deterministic": y_deterministic,
        "x_median": float(np.median(x_valid)),
        "y_median": float(np.median(y_valid)),
        "x_percentiles_95": [float(np.percentile(x_valid, 2.5)), float(np.percentile(x_valid, 97.5))],
        "y_percentiles_95": [float(np.percentile(y_valid, 2.5)), float(np.percentile(y_valid, 97.5))],
    }


def compute_correlation_matrix(
    replicates: np.ndarray,
    parameter_names: List[str],
) -> Dict[str, Any]:
    """Compute pairwise Pearson correlation matrix from replicate array."""
    n_params = len(parameter_names)
    matrix = [[0.0] * n_params for _ in range(n_params)]

    clean_names = [clean_param_name(p) for p in parameter_names]

    for i in range(n_params):
        matrix[i][i] = 1.0
        for j in range(i + 1, n_params):
            xi = replicates[:, i]
            xj = replicates[:, j]
            mask = ~np.isnan(xi) & ~np.isnan(xj)
            if np.sum(mask) > 1:
                std_i = np.std(xi[mask])
                std_j = np.std(xj[mask])
                if std_i > 1e-12 and std_j > 1e-12:
                    r = np.corrcoef(xi[mask], xj[mask])[0, 1]
                    val = float(r) if not np.isnan(r) else 0.0
                else:
                    val = 0.0
            else:
                val = 0.0
            matrix[i][j] = val
            matrix[j][i] = val

    return {
        "parameters": clean_names,
        "matrix": matrix,
    }


def propagate_derived_quantities(
    replicates: np.ndarray,
    parameter_names: List[str],
) -> Dict[str, np.ndarray]:
    """
    Evaluate derived quantities per replicate sample to preserve exact parameter correlations.
    Calculates k_AB = k_ex * p_B, k_BA = k_ex * (1 - p_B), tau_B = 1 / k_BA (in seconds & ms).
    """
    clean_map = {clean_param_name(name).upper(): idx for idx, name in enumerate(parameter_names)}

    kex_idx = clean_map.get("KEX_AB")
    pb_idx = clean_map.get("PB")

    derived: Dict[str, np.ndarray] = {}

    if kex_idx is not None and pb_idx is not None:
        kex_samples = replicates[:, kex_idx]
        pb_samples = replicates[:, pb_idx]

        kab_samples = kex_samples * pb_samples
        kba_samples = kex_samples * (1.0 - pb_samples)

        # Avoid division by zero
        with np.errstate(divide="ignore", invalid="ignore"):
            tau_b_sec = np.where(kba_samples > 0, 1.0 / kba_samples, np.nan)
            tau_b_ms = tau_b_sec * 1000.0

        derived["KAB"] = kab_samples
        derived["KBA"] = kba_samples
        derived["PA"] = 1.0 - pb_samples
        derived["TAU_B_SEC"] = tau_b_sec
        derived["TAU_B_MS"] = tau_b_ms

    return derived


# --- Persistence Layer (.npz) & Fallback Reader ---


def save_replicates_npz(
    npz_path: Union[str, Path],
    replicates: np.ndarray,
    parameter_names: List[str],
    chisqr: Optional[np.ndarray] = None,
    metadata: Optional[Dict[str, Any]] = None,
) -> None:
    """Save replicate matrix and parameter list to a compressed .npz archive."""
    npz_path = Path(npz_path)
    npz_path.parent.mkdir(parents=True, exist_ok=True)

    arrays: Dict[str, Any] = {
        "replicates": replicates.astype(np.float64),
        "parameter_names": np.array(parameter_names, dtype=str),
    }
    if chisqr is not None:
        arrays["chisqr"] = chisqr.astype(np.float64)

    if metadata is not None:
        arrays["metadata_json"] = np.array([json.dumps(metadata)], dtype=str)

    np.savez_compressed(npz_path, **arrays)
    logger.info("Saved compressed replicate archive to %s", npz_path)


def save_mcmc_chains_npz(
    npz_path: Union[str, Path],
    chains: np.ndarray,
    parameter_names: List[str],
    discarded_steps: int = 0,
    thin: int = 1,
    metadata: Optional[Dict[str, Any]] = None,
) -> None:
    """
    Save MCMC posterior chains to .npz preserving walker and step dimensions.
    Shape: (n_walkers, n_steps, n_parameters)
    """
    npz_path = Path(npz_path)
    npz_path.parent.mkdir(parents=True, exist_ok=True)

    meta = metadata or {}
    meta["discarded_steps"] = discarded_steps
    meta["thin"] = thin
    meta["walkers"] = chains.shape[0] if chains.ndim == 3 else 1
    meta["steps"] = chains.shape[1] if chains.ndim == 3 else chains.shape[0]

    np.savez_compressed(
        npz_path,
        chains=chains.astype(np.float64),
        parameter_names=np.array(parameter_names, dtype=str),
        metadata_json=np.array([json.dumps(meta)], dtype=str),
    )
    logger.info("Saved MCMC chains archive to %s", npz_path)


def parse_tsv_samples_matrix(samples_file: Path) -> Tuple[List[str], np.ndarray, Optional[np.ndarray]]:
    """Parse ChemEx samples.tsv into (parameter_names, replicates_array, chisqr_array)."""
    if not samples_file.is_file():
        return [], np.empty((0, 0)), None

    try:
        lines = samples_file.read_text(encoding="utf-8").splitlines()
    except Exception as exc:
        logger.warning("Could not read samples.tsv at %s: %s", samples_file, exc)
        return [], np.empty((0, 0)), None

    if not lines:
        return [], np.empty((0, 0)), None

    raw_headers = [h.strip() for h in lines[0].split("\t") if h.strip()]
    headers = [clean_param_name(h) for h in raw_headers]

    chisqr_col = None
    param_indices = []
    param_names = []

    for idx, h in enumerate(headers):
        if h.lower() in ("chisqr", "chi2", "chisq"):
            chisqr_col = idx
        else:
            param_indices.append(idx)
            param_names.append(raw_headers[idx])

    rows: List[List[float]] = []
    chisqr_vals: List[float] = []

    for line in lines[1:]:
        s_line = line.strip()
        if not s_line:
            continue
        tokens = s_line.split("\t")
        row: List[float] = []
        for p_idx in param_indices:
            if p_idx < len(tokens):
                tok = tokens[p_idx].strip()
                if tok.lower() == "nan" or not tok:
                    row.append(np.nan)
                else:
                    try:
                        row.append(float(tok))
                    except ValueError:
                        row.append(np.nan)
            else:
                row.append(np.nan)
        rows.append(row)

        if chisqr_col is not None and chisqr_col < len(tokens):
            c_tok = tokens[chisqr_col].strip()
            try:
                chisqr_vals.append(float(c_tok))
            except ValueError:
                chisqr_vals.append(np.nan)

    replicates = np.array(rows, dtype=np.float64)
    chisqr = np.array(chisqr_vals, dtype=np.float64) if chisqr_vals else None

    return param_names, replicates, chisqr


def load_replicates_or_fallback(
    method_dir: Union[str, Path],
    method_type: str = "MonteCarlo",
) -> Optional[Dict[str, Any]]:
    """
    Load replicates array with automatic backfill and fallback.
    1. Looks for replicates.npz (or mcmc_chains.npz).
    2. If missing, checks for samples.tsv, parses and caches as .npz.
    3. Returns dict containing 'replicates', 'parameter_names', 'chisqr', 'is_mcmc', 'chains'.
    """
    method_dir = Path(method_dir)
    if not method_dir.is_dir():
        return None

    is_mcmc = method_type.lower() in ("mcmc", "mcmc posterior sampling")
    npz_file = method_dir / ("mcmc_chains.npz" if is_mcmc else "replicates.npz")
    samples_file = method_dir / "samples.tsv"

    # 1. Try loading existing .npz
    if npz_file.is_file():
        try:
            with np.load(npz_file, allow_pickle=True) as data:
                if is_mcmc and "chains" in data:
                    chains = data["chains"]
                    p_names = [str(x) for x in data["parameter_names"]]
                    meta = json.loads(str(data["metadata_json"][0])) if "metadata_json" in data else {}
                    # Flatten chains for summary statistics (n_walkers * n_steps, n_params)
                    if chains.ndim == 3:
                        w, s, p = chains.shape
                        flat_replicates = chains.reshape(w * s, p)
                    else:
                        flat_replicates = chains
                    return {
                        "replicates": flat_replicates,
                        "chains": chains,
                        "parameter_names": p_names,
                        "chisqr": data.get("chisqr"),
                        "metadata": meta,
                        "is_mcmc": True,
                    }
                elif "replicates" in data:
                    p_names = [str(x) for x in data["parameter_names"]]
                    return {
                        "replicates": data["replicates"],
                        "parameter_names": p_names,
                        "chisqr": data.get("chisqr"),
                        "metadata": json.loads(str(data["metadata_json"][0])) if "metadata_json" in data else {},
                        "is_mcmc": False,
                    }
        except Exception as exc:
            logger.warning("Failed to load .npz at %s: %s; attempting fallback", npz_file, exc)

    # 2. Backfill from samples.tsv
    if samples_file.is_file():
        p_names, replicates, chisqr = parse_tsv_samples_matrix(samples_file)
        if len(p_names) > 0 and replicates.shape[0] > 0:
            if is_mcmc:
                # Check diagnostics for walker structure
                diag_file = method_dir / "diagnostics.toml"
                walkers = 1
                discarded_steps = 0
                thin = 1
                if diag_file.is_file():
                    try:
                        import tomllib
                        diag_data = tomllib.loads(diag_file.read_text(encoding="utf-8"))
                        walkers = int(diag_data.get("walkers", 1))
                        discarded_steps = int(diag_data.get("discarded_steps", 0))
                        thin = int(diag_data.get("thin", 1))
                    except Exception:
                        pass

                total_samples = replicates.shape[0]
                if walkers > 1 and total_samples % walkers == 0:
                    steps = total_samples // walkers
                    chains = replicates.reshape((walkers, steps, replicates.shape[1]))
                else:
                    chains = replicates[np.newaxis, ...]

                try:
                    save_mcmc_chains_npz(
                        npz_file,
                        chains,
                        p_names,
                        discarded_steps=discarded_steps,
                        thin=thin,
                    )
                except Exception as save_exc:
                    logger.warning("Could not cache MCMC npz: %s", save_exc)

                return {
                    "replicates": replicates,
                    "chains": chains,
                    "parameter_names": p_names,
                    "chisqr": chisqr,
                    "metadata": {"walkers": walkers, "discarded_steps": discarded_steps, "thin": thin},
                    "is_mcmc": True,
                }
            else:
                try:
                    save_replicates_npz(npz_file, replicates, p_names, chisqr=chisqr)
                except Exception as save_exc:
                    logger.warning("Could not cache resampling npz: %s", save_exc)

                return {
                    "replicates": replicates,
                    "parameter_names": p_names,
                    "chisqr": chisqr,
                    "metadata": {},
                    "is_mcmc": False,
                }

    # 3. Check group directories (e.g. Groups/*/Statistics/{dir_name})
    possible_groups_dirs = [
        method_dir.parent.parent / "Groups",
        method_dir.parent / "Groups",
        method_dir.parent.parent / "groups",
    ]
    for groups_dir in possible_groups_dirs:
        if groups_dir.is_dir():
            group_dirs = sorted(d for d in groups_dir.iterdir() if d.is_dir())
            all_p_names: list[str] = []
            all_reps: list[np.ndarray] = []
            all_chisqr: list[np.ndarray] = []
            for g in group_dirs:
                g_method_dir = g / "Statistics" / method_dir.name
                if not g_method_dir.is_dir():
                    g_method_dir = g / "statistics" / method_dir.name
                if g_method_dir.is_dir():
                    g_rep = load_replicates_or_fallback(g_method_dir, method_type)
                    if g_rep is not None and g_rep.get("replicates") is not None and len(g_rep["parameter_names"]) > 0:
                        all_p_names.extend(g_rep["parameter_names"])
                        all_reps.append(g_rep["replicates"])
                        if g_rep.get("chisqr") is not None:
                            all_chisqr.append(g_rep["chisqr"])

            if all_reps and all_p_names:
                min_rows = min(r.shape[0] for r in all_reps)
                trimmed_reps = [r[:min_rows] for r in all_reps]
                combined_reps = np.hstack(trimmed_reps)
                combined_chisqr = np.sum([c[:min_rows] for c in all_chisqr], axis=0) if all_chisqr else None
                method_dir.mkdir(parents=True, exist_ok=True)
                if is_mcmc:
                    try:
                        save_mcmc_chains_npz(npz_file, combined_reps[np.newaxis, ...], all_p_names)
                    except Exception as save_exc:
                        logger.warning("Could not cache MCMC npz from groups: %s", save_exc)
                    return {
                        "replicates": combined_reps,
                        "chains": combined_reps[np.newaxis, ...],
                        "parameter_names": all_p_names,
                        "chisqr": combined_chisqr,
                        "metadata": {},
                        "is_mcmc": True,
                    }
                else:
                    try:
                        save_replicates_npz(npz_file, combined_reps, all_p_names, chisqr=combined_chisqr)
                    except Exception as save_exc:
                        logger.warning("Could not cache resampling npz from groups: %s", save_exc)
                    return {
                        "replicates": combined_reps,
                        "parameter_names": all_p_names,
                        "chisqr": combined_chisqr,
                        "metadata": {},
                        "is_mcmc": False,
                    }

    return None
