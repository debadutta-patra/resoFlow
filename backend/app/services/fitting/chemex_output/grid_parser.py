"""
Grid Search Scientific Parser & Profile Likelihood Engine (§1.7).
Loads ChemEx .out files into NumPy, manages LRU caching on (path, mtime, size),
computes delta-chi-square and 1D/2D profile likelihood surfaces.
"""

from __future__ import annotations

import math
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

# Cache keyed by (resolved_path_str, mtime, file_size)
_GRID_CACHE: dict[tuple[str, float, int], tuple[list[str], np.ndarray]] = {}
_MAX_CACHE_ENTRIES = 64


def parse_grid_header_line(header_line: str) -> list[str]:
    """
    Parse column names from a grid file header line.
    Handles bracketed format: '# [DW_AB, NUC->14N] [KEX_AB] [PB] [χ²]'
    and space-separated format: '# DW_AB KEX_AB PB chi2'
    """
    raw = header_line.lstrip("#").strip()
    if "[" in raw and "]" in raw:
        items = re.findall(r"\[(.*?)\]", raw)
    else:
        items = raw.split()

    chi2_aliases = {"χ²", "chi2", "chisqr", "χ2", "\u03c7\u00b2", "\u03c72", "chi_sq", "chisq"}
    return [it.strip() for it in items if it.strip() and it.strip().lower() not in chi2_aliases]


def _clean_param_name(name: str) -> str:
    """Clean bracketed parameter name e.g. '[KEX_AB]' -> 'KEX_AB'."""
    return name.strip().lstrip("#").strip().strip("[]")


def _find_param_index(param_names: list[str], target: str) -> int:
    """Find index of target parameter in param_names, supporting base name and case-insensitive matching."""
    t_clean = target.strip().strip("[]").upper()
    t_base = t_clean.split(",")[0].strip()

    # 1. Exact match (case-insensitive)
    for idx, p in enumerate(param_names):
        p_clean = p.strip().strip("[]").upper()
        if p_clean == t_clean:
            return idx

    # 2. Base name match (e.g. "DW_AB" matches "DW_AB, NUC->14N")
    for idx, p in enumerate(param_names):
        p_clean = p.strip().strip("[]").upper()
        p_base = p_clean.split(",")[0].strip()
        if p_base == t_base or p_base == t_clean or p_clean == t_base:
            return idx

    # 3. Substring match
    for idx, p in enumerate(param_names):
        p_clean = p.strip().strip("[]").upper()
        if t_clean in p_clean or p_clean in t_clean:
            return idx

    raise ValueError(f"Parameter {target!r} not found in {param_names}")


def load_grid_file(file_path: Path | str) -> tuple[list[str], np.ndarray]:
    """
    Load a ChemEx .out file into NumPy array with (mtime, size) caching.
    Returns (param_names, data_array) where data_array has shape (N, num_params + 1).
    The last column is always chi-square.
    """
    path = Path(file_path).resolve()
    if not path.exists():
        raise FileNotFoundError(f"Grid file not found: {path}")

    stat = path.stat()
    cache_key = (str(path), stat.st_mtime, stat.st_size)

    if cache_key in _GRID_CACHE:
        return _GRID_CACHE[cache_key]

    with open(path, "r", encoding="utf-8") as f:
        first_line = f.readline().strip()
        if not first_line.startswith("#"):
            raise ValueError(f"Invalid grid file header in {path}: expected line starting with '#'")

        param_names = parse_grid_header_line(first_line)
        data = np.loadtxt(f, dtype=np.float64)

    # Manage cache size
    if len(_GRID_CACHE) >= _MAX_CACHE_ENTRIES:
        _GRID_CACHE.pop(next(iter(_GRID_CACHE)))

    _GRID_CACHE[cache_key] = (param_names, data)
    return param_names, data


def extract_residue_label_from_filename(raw_name: str) -> str:
    """Extract residue label from group filename (e.g. '1_14N.out' -> '14N')."""
    base = raw_name.removesuffix(".out")
    if "_" in base:
        parts = base.split("_", 1)
        if parts[0].isdigit():
            return parts[1]
    return base


def find_grid_out_files(grid_dir: Path) -> list[Path]:
    """Find all .out files in Grid/Groups/ or directly in Grid/."""
    groups_dir = grid_dir / "Groups"
    if groups_dir.exists() and groups_dir.is_dir():
        out_files = sorted(groups_dir.glob("*.out"))
        if out_files:
            return out_files
    return sorted(grid_dir.glob("*.out"))


def get_grid_data_for_group(
    grid_dir: Path,
    group: Optional[str] = None,
    residue_mapping: Optional[dict[str, str]] = None,
) -> tuple[list[str], np.ndarray, str]:
    """
    Retrieve grid data for a specific group or aggregated across all groups.
    Returns (param_names, data_array, resolved_group_label).
    """
    out_files = find_grid_out_files(grid_dir)
    if not out_files:
        raise FileNotFoundError(f"No grid .out files found in {grid_dir}")

    res_map = residue_mapping or {}

    # If a specific group is requested
    if group and group.lower() not in ("all", "all groups", ""):
        target_file: Optional[Path] = None
        cleaned_group = group.strip()

        for f in out_files:
            stem = f.stem
            res_key = extract_residue_label_from_filename(stem)
            mapped_label = res_map.get(res_key, res_map.get(stem, res_key))
            if cleaned_group in (stem, res_key, mapped_label, f.name):
                target_file = f
                break

        if target_file is None:
            # Fallback: try case-insensitive match or residue number match
            for f in out_files:
                stem = f.stem
                res_key = extract_residue_label_from_filename(stem)
                mapped_label = res_map.get(res_key, res_map.get(stem, res_key))
                if cleaned_group.upper() in (stem.upper(), res_key.upper(), mapped_label.upper()):
                    target_file = f
                    break

        if target_file is None:
            raise ValueError(f"Group {group!r} not found in grid files for {grid_dir}")

        param_names, data = load_grid_file(target_file)
        res_key = extract_residue_label_from_filename(target_file.stem)
        label = res_map.get(res_key, res_map.get(target_file.stem, res_key))
        return param_names, data.copy(), label

    # Aggregated "All Groups"
    groups_data = [load_grid_file(f) for f in out_files]
    first_params, first_data = groups_data[0]

    # Check if all files have identical parameter lists
    all_identical = all(p_list == first_params for p_list, _ in groups_data)
    all_same_shape = all(d.shape == first_data.shape for _, d in groups_data)

    if all_identical and all_same_shape and not any("NUC->" in p or "," in p for p in first_params):
        combined_chi2 = np.zeros(first_data.shape[0], dtype=np.float64)
        for _, g_data in groups_data:
            chi2_col = np.nan_to_num(g_data[:, -1], nan=1e12, posinf=1e12, neginf=1e12)
            combined_chi2 += chi2_col
        agg_data = first_data.copy()
        agg_data[:, -1] = combined_chi2
        return first_params, agg_data, "All Groups"

    # Identify global parameters (present across all groups, not containing NUC-> or ,)
    global_params: list[str] = []
    for p in first_params:
        base = p.split(",")[0].strip()
        is_common = True
        for other_p, _ in groups_data[1:]:
            other_bases = [op.split(",")[0].strip() for op in other_p]
            if base not in other_bases and p not in other_p:
                is_common = False
                break
        if is_common and "NUC->" not in p and "," not in p:
            global_params.append(p)

    if not global_params:
        # Fallback: use first parameters
        global_params = first_params

    # Column index of global params per group
    group_global_indices = []
    for p_list, _ in groups_data:
        indices = [_find_param_index(p_list, gp) for gp in global_params]
        group_global_indices.append(indices)

    # Unique global coordinates
    g0_cols = first_data[:, group_global_indices[0]]
    _, unique_idx = np.unique(g0_cols, axis=0, return_index=True)
    unique_idx.sort()
    unique_global_coords = g0_cols[unique_idx]

    coord_map = {tuple(round(float(v), 6) for v in row): idx for idx, row in enumerate(unique_global_coords)}
    comb_chi2 = np.zeros(len(unique_global_coords), dtype=np.float64)

    for g_idx, (_, d) in enumerate(groups_data):
        g_cols = d[:, group_global_indices[g_idx]]
        g_chi2 = d[:, -1]
        g_min = np.full(len(unique_global_coords), np.inf, dtype=np.float64)
        for r_idx in range(len(d)):
            tup = tuple(round(float(v), 6) for v in g_cols[r_idx])
            u_idx = coord_map.get(tup)
            c = g_chi2[r_idx]
            if u_idx is not None and np.isfinite(c) and c < g_min[u_idx]:
                g_min[u_idx] = c
        comb_chi2 += np.where(np.isfinite(g_min), g_min, 1e12)

    agg_data = np.column_stack([unique_global_coords, comb_chi2])
    return global_params, agg_data, "All Groups"


def compute_grid_minimum(param_names: list[str], data: np.ndarray) -> dict[str, Any]:
    """
    Find global minimum chi-square and its parameter coordinates on the grid.
    """
    chi2_col = data[:, -1]
    finite_mask = np.isfinite(chi2_col)
    if not np.any(finite_mask):
        return {
            "chisqr": None,
            "coordinates": {p: None for p in param_names},
            "point_index": None,
        }

    valid_indices = np.where(finite_mask)[0]
    min_sub_idx = np.argmin(chi2_col[finite_mask])
    best_idx = valid_indices[min_sub_idx]
    best_chi2 = float(chi2_col[best_idx])

    coords = {}
    for idx, pname in enumerate(param_names):
        coords[pname] = float(data[best_idx, idx])

    return {
        "chisqr": best_chi2,
        "coordinates": coords,
        "point_index": int(best_idx),
    }


def compute_1d_profiles(
    param_names: list[str],
    data: np.ndarray,
    target_param: Optional[str] = None,
) -> list[dict[str, Any]]:
    """
    Compute 1D profile likelihood curves for each parameter (or target_param).
    Profile likelihood minimizes chi-square over all other parameters at each value.
    """
    min_info = compute_grid_minimum(param_names, data)
    global_min_chi2 = min_info["chisqr"] if min_info["chisqr"] is not None else 0.0

    profiles: list[dict[str, Any]] = []

    for p_idx, pname in enumerate(param_names):
        if target_param:
            try:
                t_idx = _find_param_index(param_names, target_param)
                if p_idx != t_idx:
                    continue
            except ValueError:
                continue

        p_vals = data[:, p_idx]
        chi2_vals = data[:, -1]

        unique_vals = np.unique(p_vals)
        unique_vals.sort()
        val_map = {round(float(v), 6): i for i, v in enumerate(unique_vals)}

        prof_min = np.full(len(unique_vals), np.inf, dtype=np.float64)
        for r_idx in range(len(p_vals)):
            idx = val_map.get(round(float(p_vals[r_idx]), 6))
            c = chi2_vals[r_idx]
            if idx is not None and np.isfinite(c) and c < prof_min[idx]:
                prof_min[idx] = c

        prof_x = [float(v) for v in unique_vals]
        prof_chi2 = [float(v) if np.isfinite(v) else None for v in prof_min]
        prof_delta = [float(max(0.0, v - global_min_chi2)) if np.isfinite(v) else None for v in prof_min]

        profiles.append({
            "parameter": pname,
            "x": prof_x,
            "chisqr": prof_chi2,
            "delta_chisqr": prof_delta,
            "min_val": min_info["coordinates"].get(pname),
            "min_x": min_info["coordinates"].get(pname),
            "min_chisqr": global_min_chi2,
        })

    return profiles


def compute_2d_surface(
    param_names: list[str],
    data: np.ndarray,
    x_param: str,
    y_param: str,
    max_resolution: int = 100,
) -> dict[str, Any]:
    """
    Compute 2D surface (mesh) of delta-chi-square and chi-square for a pair of parameters.
    Minimizes over any other parameters if total parameter count > 2.
    """
    x_idx = _find_param_index(param_names, x_param)
    y_idx = _find_param_index(param_names, y_param)

    if x_idx == y_idx:
        raise ValueError(f"X and Y parameters must be distinct (got {x_param!r})")

    x_col = data[:, x_idx]
    y_col = data[:, y_idx]
    chi2_col = data[:, -1]

    min_info = compute_grid_minimum(param_names, data)
    global_min_chi2 = min_info["chisqr"] if min_info["chisqr"] is not None else 0.0

    unique_x = np.unique(x_col)
    unique_x.sort()
    unique_y = np.unique(y_col)
    unique_y.sort()

    # Downsample if grid resolution is exceedingly large
    if len(unique_x) > max_resolution:
        indices = np.round(np.linspace(0, len(unique_x) - 1, max_resolution)).astype(int)
        unique_x = unique_x[indices]
    if len(unique_y) > max_resolution:
        indices = np.round(np.linspace(0, len(unique_y) - 1, max_resolution)).astype(int)
        unique_y = unique_y[indices]

    x_map = {round(float(v), 6): i for i, v in enumerate(unique_x)}
    y_map = {round(float(v), 6): i for i, v in enumerate(unique_y)}

    z_grid = np.full((len(unique_y), len(unique_x)), np.inf, dtype=np.float64)

    for r_idx in range(len(x_col)):
        xi = x_map.get(round(float(x_col[r_idx]), 6))
        yi = y_map.get(round(float(y_col[r_idx]), 6))
        if xi is not None and yi is not None:
            c = chi2_col[r_idx]
            if np.isfinite(c) and c < z_grid[yi, xi]:
                z_grid[yi, xi] = c

    z_chi2: list[list[Optional[float]]] = []
    z_delta: list[list[Optional[float]]] = []

    for yi in range(len(unique_y)):
        row_chi2: list[Optional[float]] = []
        row_delta: list[Optional[float]] = []
        for xi in range(len(unique_x)):
            val = z_grid[yi, xi]
            if np.isfinite(val):
                row_chi2.append(float(val))
                row_delta.append(float(max(0.0, val - global_min_chi2)))
            else:
                row_chi2.append(None)
                row_delta.append(None)
        z_chi2.append(row_chi2)
        z_delta.append(row_delta)

    return {
        "x_param": param_names[x_idx],
        "y_param": param_names[y_idx],
        "x": [float(v) for v in unique_x],
        "y": [float(v) for v in unique_y],
        "z_chisqr": z_chi2,
        "z_delta": z_delta,
        "min_point": {
            "x": min_info["coordinates"].get(param_names[x_idx]),
            "y": min_info["coordinates"].get(param_names[y_idx]),
            "chisqr": global_min_chi2,
        },
    }
