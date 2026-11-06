"""
Grid Search Parser for ChemEx 2026.9+ Directory Layout (v2).

Parses:
- Grid/summary.toml (status, selected_chi_square, factor_count, selected_axes)
- Grid/Profiles/1D/<token>.tsv (1D profile likelihood curves)
- Grid/Profiles/2D/<token1>__<token2>.tsv (2D profile likelihood surfaces)
- Grid/Factors/factor_*.tsv (per-factor evaluated grid points)
- grid_1d.pdf, grid_2d.pdf

Produces the data shapes expected by GridResultModel and GridSearchSection.tsx.
"""

from __future__ import annotations

import math
import os
import re
import tomllib
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

from .models import (
    GridGroupInfo,
    GridPointModel,
    GridResultModel,
    GridSpecModel,
    StructuredWarning,
)


def is_v2_grid_dir(grid_dir: Path | str) -> bool:
    """Check if grid_dir follows the ChemEx 2026.9+ layout."""
    p = Path(grid_dir)
    if not p.is_dir():
        return False
    return (
        (p / "summary.toml").is_file()
        or (p / "Profiles").is_dir()
        or (p / "Factors").is_dir()
    )


def parse_v2_grid_summary(grid_dir: Path | str) -> dict[str, Any]:
    """Parse Grid/summary.toml."""
    p = Path(grid_dir)
    summary_file = p / "summary.toml"
    if not summary_file.is_file():
        return {}

    try:
        data = tomllib.loads(summary_file.read_text(encoding="utf-8"))
    except Exception:
        return {}

    selected_axes: list[dict[str, Any]] = []
    for item in data.get("selected_axes", []):
        if isinstance(item, dict):
            selected_axes.append({
                "parameter_id": item.get("parameter_id"),
                "name": item.get("name"),
                "value": float(item["value"]) if item.get("value") is not None else None,
            })

    return {
        "status": data.get("status", "complete"),
        "selected_chi_square": float(data["selected_chi_square"]) if "selected_chi_square" in data else None,
        "factor_count": int(data.get("factor_count", 0)),
        "selected_axes": selected_axes,
    }


def _clean_token_name(token: str) -> str:
    """Turn token filename stem e.g. 'kex_ab' or '[KEX_AB]' or '__KEX_AB' into uppercase clean name."""
    s = token.strip()
    if s.startswith("[") and s.endswith("]"):
        s = s[1:-1].strip()
    s = s.replace("__", "").strip()
    return s.upper()


def load_v2_1d_profiles(
    grid_dir: Path | str,
    target_param: Optional[str] = None,
) -> list[dict[str, Any]]:
    """
    Load 1D profile likelihood curves from Grid/Profiles/1D/*.tsv.
    Returns list of dicts conforming to Profile1D in frontend / analysis router:
    [
        {
            "parameter": str,
            "values": list[float],
            "x": list[float],
            "chisqr": list[float],
            "delta_chisqr": list[float],
            "min_val": float,
            "min_x": float,
            "min_chisqr": float,
            "selected_val": Optional[float],
        }, ...
    ]
    """
    p = Path(grid_dir)
    prof_1d_dir = p / "Profiles" / "1D"
    if not prof_1d_dir.is_dir():
        return []

    summary_info = parse_v2_grid_summary(p)
    selected_map: dict[str, float] = {}
    name_map: dict[str, str] = {}
    for ax in summary_info.get("selected_axes", []):
        raw_name = str(ax.get("name") or ax.get("parameter_id") or "")
        clean_k = _clean_token_name(raw_name)
        if ax.get("value") is not None:
            selected_map[clean_k] = float(ax["value"])
            name_map[clean_k] = raw_name

    profiles: list[dict[str, Any]] = []
    tsv_files = sorted(prof_1d_dir.glob("*.tsv"))

    for f in tsv_files:
        stem = f.stem
        param_clean = _clean_token_name(stem)
        display_name = name_map.get(param_clean, stem)

        if target_param:
            t_clean = _clean_token_name(target_param)
            if t_clean != param_clean and t_clean not in param_clean and param_clean not in t_clean:
                continue

        try:
            lines = f.read_text(encoding="utf-8").splitlines()
            if not lines:
                continue
            headers = [h.strip() for h in lines[0].split("\t")]
            param_col_name = headers[0] if headers else stem
            display_name = name_map.get(param_clean, param_col_name)

            x_vals: list[float] = []
            chi2_vals: list[float] = []
            selected_val: Optional[float] = None

            for line in lines[1:]:
                parts = line.strip().split("\t")
                if len(parts) >= 2:
                    try:
                        xv = float(parts[0])
                        cv = float(parts[1])
                        x_vals.append(xv)
                        chi2_vals.append(cv)
                        if len(parts) >= 3 and parts[2].lower() == "true":
                            selected_val = xv
                    except ValueError:
                        continue

            if not x_vals:
                continue

            # Sort by x
            sort_idx = np.argsort(x_vals)
            x_arr = np.array(x_vals)[sort_idx]
            chi2_arr = np.array(chi2_vals)[sort_idx]

            finite_mask = np.isfinite(chi2_arr)
            min_chi2 = float(np.min(chi2_arr[finite_mask])) if np.any(finite_mask) else 0.0
            min_idx = int(np.argmin(chi2_arr[finite_mask])) if np.any(finite_mask) else 0
            best_x = float(x_arr[finite_mask][min_idx]) if np.any(finite_mask) else float(x_arr[0])
            delta_arr = np.maximum(0.0, chi2_arr - min_chi2)

            profiles.append({
                "parameter": display_name,
                "values": x_arr.tolist(),
                "x": x_arr.tolist(),
                "chisqr": chi2_arr.tolist(),
                "delta_chisqr": delta_arr.tolist(),
                "min_val": best_x,
                "min_x": best_x,
                "min_chisqr": min_chi2,
                "selected_val": selected_val if selected_val is not None else selected_map.get(param_clean),
            })
        except Exception:
            pass

    return profiles


def list_v2_2d_pairs(grid_dir: Path | str) -> list[tuple[str, str, Path]]:
    """List available 2D parameter pairs in Grid/Profiles/2D/*.tsv."""
    p = Path(grid_dir)
    prof_2d_dir = p / "Profiles" / "2D"
    if not prof_2d_dir.is_dir():
        return []

    pairs: list[tuple[str, str, Path]] = []
    for f in sorted(prof_2d_dir.glob("*.tsv")):
        if "__" in f.stem:
            p1, p2 = f.stem.split("__", 1)
            pairs.append((_clean_token_name(p1), _clean_token_name(p2), f))
    return pairs


def load_v2_2d_surface(
    grid_dir: Path | str,
    x_param: Optional[str] = None,
    y_param: Optional[str] = None,
    max_resolution: int = 100,
) -> dict[str, Any]:
    """
    Load a 2D surface from Grid/Profiles/2D/*.tsv.
    Returns Surface2DData dict for the API.
    """
    p = Path(grid_dir)
    pairs = list_v2_2d_pairs(p)
    if not pairs:
        raise FileNotFoundError(f"No 2D grid surface TSVs found in {p / 'Profiles' / '2D'}")

    target_file: Optional[Path] = None
    target_p1 = ""
    target_p2 = ""

    if x_param and y_param:
        xc = _clean_token_name(x_param)
        yc = _clean_token_name(y_param)
        for p1, p2, fpath in pairs:
            if (p1 == xc and p2 == yc) or (p1 == yc and p2 == xc):
                target_file = fpath
                target_p1, target_p2 = p1, p2
                break

    if target_file is None:
        target_p1, target_p2, target_file = pairs[0]

    lines = target_file.read_text(encoding="utf-8").splitlines()
    if not lines:
        raise ValueError(f"Empty 2D grid profile in {target_file}")

    headers = [h.strip() for h in lines[0].split("\t")]
    actual_x_name = headers[0] if len(headers) > 0 else target_p1
    actual_y_name = headers[1] if len(headers) > 1 else target_p2

    x_list: list[float] = []
    y_list: list[float] = []
    chi2_list: list[float] = []

    for line in lines[1:]:
        parts = line.strip().split("\t")
        if len(parts) >= 3:
            try:
                xv = float(parts[0])
                yv = float(parts[1])
                cv = float(parts[2])
                x_list.append(xv)
                y_list.append(yv)
                chi2_list.append(cv)
            except ValueError:
                continue

    if not x_list:
        raise ValueError(f"No valid coordinate rows in {target_file}")

    x_arr = np.array(x_list)
    y_arr = np.array(y_list)
    c_arr = np.array(chi2_list)

    unique_x = np.unique(x_arr)
    unique_x.sort()
    unique_y = np.unique(y_arr)
    unique_y.sort()

    if len(unique_x) > max_resolution:
        idx = np.round(np.linspace(0, len(unique_x) - 1, max_resolution)).astype(int)
        unique_x = unique_x[idx]
    if len(unique_y) > max_resolution:
        idx = np.round(np.linspace(0, len(unique_y) - 1, max_resolution)).astype(int)
        unique_y = unique_y[idx]

    x_map = {round(float(v), 6): i for i, v in enumerate(unique_x)}
    y_map = {round(float(v), 6): i for i, v in enumerate(unique_y)}

    z_grid = np.full((len(unique_y), len(unique_x)), np.inf, dtype=np.float64)
    min_chi2 = float("inf")
    min_x = float(unique_x[0])
    min_y = float(unique_y[0])

    for i in range(len(x_arr)):
        xi = x_map.get(round(float(x_arr[i]), 6))
        yi = y_map.get(round(float(y_arr[i]), 6))
        if xi is not None and yi is not None:
            cv = c_arr[i]
            if np.isfinite(cv) and cv < z_grid[yi, xi]:
                z_grid[yi, xi] = cv
            if cv < min_chi2:
                min_chi2 = cv
                min_x = float(x_arr[i])
                min_y = float(y_arr[i])

    z_chi2: list[list[Optional[float]]] = []
    z_delta: list[list[Optional[float]]] = []

    for yi in range(len(unique_y)):
        row_c: list[Optional[float]] = []
        row_d: list[Optional[float]] = []
        for xi in range(len(unique_x)):
            val = z_grid[yi, xi]
            if np.isfinite(val):
                row_c.append(float(val))
                row_d.append(float(max(0.0, val - min_chi2)))
            else:
                row_c.append(None)
                row_d.append(None)
        z_chi2.append(row_c)
        z_delta.append(row_d)

    # Collect all available parameter names across pairs
    avail_params = sorted(list({p1 for p1, _, _ in pairs} | {p2 for _, p2, _ in pairs}))

    return {
        "x_param": actual_x_name,
        "y_param": actual_y_name,
        "x": unique_x.tolist(),
        "y": unique_y.tolist(),
        "z_chisqr": z_chi2,
        "z_delta": z_delta,
        "min_point": {
            "x": min_x,
            "y": min_y,
            "chisqr": min_chi2 if math.isfinite(min_chi2) else None,
        },
        "available_parameters": avail_params,
    }


def parse_v2_grid_directory(
    grid_dir: Path | str,
    warnings: list[StructuredWarning] | None = None,
    step_name: str = "",
    run_info_dir: Optional[Path] = None,
    residue_labels_map: Optional[dict[str, str]] = None,
) -> Optional[GridResultModel]:
    """
    Parse a ChemEx 2026.9+ Grid/ directory into GridResultModel.
    """
    p = Path(grid_dir).resolve()
    if not is_v2_grid_dir(p):
        return None

    summary_info = parse_v2_grid_summary(p)
    profiles_1d = load_v2_1d_profiles(p)

    param_names = [_clean_token_name(prof["parameter"]) for prof in profiles_1d]
    specs: dict[str, GridSpecModel] = {}

    for prof in profiles_1d:
        pname = _clean_token_name(prof["parameter"])
        x_vals = prof["values"]
        if x_vals:
            specs[pname] = GridSpecModel(
                parameter=pname,
                scale="lin",
                min_val=float(min(x_vals)),
                max_val=float(max(x_vals)),
                num_points=len(x_vals),
            )

    # Extract best point from summary or profiles
    best_coords: dict[str, float] = {}
    for prof in profiles_1d:
        pname = _clean_token_name(prof["parameter"])
        if prof.get("selected_val") is not None:
            best_coords[pname] = prof["selected_val"]
        elif prof.get("min_val") is not None:
            best_coords[pname] = prof["min_val"]

    best_chi2 = summary_info.get("selected_chi_square")
    if best_chi2 is None and profiles_1d:
        best_chi2 = min(p["min_chisqr"] for p in profiles_1d)

    best_point = (
        GridPointModel(values=best_coords, chisqr=float(best_chi2))
        if best_coords and best_chi2 is not None
        else None
    )

    # Parse points from 2D profile if available, else 1D
    points: list[GridPointModel] = []
    prof_2d_dir = p / "Profiles" / "2D"
    if prof_2d_dir.is_dir():
        for tsv_f in sorted(prof_2d_dir.glob("*.tsv")):
            lines = tsv_f.read_text(encoding="utf-8").splitlines()
            if len(lines) > 1:
                headers = [_clean_token_name(h) for h in lines[0].split("\t")]
                if len(headers) >= 3:
                    p1 = headers[0]
                    p2 = headers[1]
                    for line in lines[1:]:
                        parts = line.strip().split("\t")
                        if len(parts) >= 3:
                            try:
                                v1 = float(parts[0])
                                v2 = float(parts[1])
                                c = float(parts[2])
                                points.append(GridPointModel(values={p1: v1, p2: v2}, chisqr=c))
                            except ValueError:
                                continue
                    break
    elif profiles_1d:
        for prof in profiles_1d:
            pname = _clean_token_name(prof["parameter"])
            for xv, cv in zip(prof["values"], prof["chisqr_values"]):
                points.append(GridPointModel(values={pname: xv}, chisqr=cv))

    grid_1d_pdf = p / "grid_1d.pdf"
    grid_2d_pdf = p / "grid_2d.pdf"

    output_files: list[str] = []
    for root_d, _, files in os.walk(p):
        for f in files:
            output_files.append(os.path.relpath(os.path.join(root_d, f), p))

    return GridResultModel(
        has_grid=True,
        parameters=param_names,
        specs=specs,
        groups=[],  # In 2026.9, grid artifacts are unified across factors rather than split into Groups/
        points=points,
        best_point=best_point,
        grid_1d_pdf=str(grid_1d_pdf) if grid_1d_pdf.is_file() else None,
        grid_2d_pdf=str(grid_2d_pdf) if grid_2d_pdf.is_file() else None,
        output_files=output_files,
    )
