"""
Grid Search Discovery & Cataloguer (§1.7).
Discovers Grid/ directory containing grid_1d.pdf, grid_2d.pdf, and Groups/*.out files.
"""

from __future__ import annotations

import math
import os
import re
import tomllib
from pathlib import Path
from typing import Optional, Dict

from .models import (
    GridGroupInfo,
    GridPointModel,
    GridResultModel,
    GridSpecModel,
    StructuredWarning,
)


def _safe_float(val: str) -> Optional[float]:
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


def _parse_method_grid_specs(method_file: Path, step_name: str) -> dict[str, GridSpecModel]:
    """Parse GRID = [...] specs for a given step from method.toml."""
    if not method_file.exists():
        return {}

    specs: dict[str, GridSpecModel] = {}
    try:
        data = tomllib.loads(method_file.read_text(encoding="utf-8"))
        step_data = data.get(step_name, {})
        grid_entries = step_data.get("GRID", [])
        if isinstance(grid_entries, list):
            for entry in grid_entries:
                if not isinstance(entry, str):
                    continue
                # Format e.g. "[PB] = log(0.001, 0.02, 20)" or "KEX_AB = lin(10, 1000, 20)"
                m = re.search(
                    r"\[?([A-Za-z0-9_]+)\]?\s*=\s*(log|lin)\(\s*([0-9.eE+-]+)\s*,\s*([0-9.eE+-]+)\s*,\s*([0-9]+)\s*\)",
                    entry.strip(),
                )
                if m:
                    pname = m.group(1).upper()
                    scale = m.group(2).lower()
                    min_val = float(m.group(3))
                    max_val = float(m.group(4))
                    num_pts = int(m.group(5))
                    specs[pname] = GridSpecModel(
                        parameter=pname,
                        scale=scale,
                        min_val=min_val,
                        max_val=max_val,
                        num_points=num_pts,
                    )
    except Exception:
        pass
    return specs


def _extract_residue_from_group_name(raw_name: str) -> str:
    """
    Extract residue identifier from group name.
    e.g. '1_14N' -> '14N', '14N' -> '14N', '3_65N' -> '65N'
    """
    cleaned = raw_name.removesuffix(".out")
    if "_" in cleaned:
        parts = cleaned.split("_", 1)
        if parts[0].isdigit():
            return parts[1]
    return cleaned


def parse_grid_directory(
    grid_dir: Path,
    warnings: list[StructuredWarning],
    step_name: str = "",
    run_info_dir: Optional[Path] = None,
    residue_labels_map: Optional[Dict[str, str]] = None,
) -> Optional[GridResultModel]:
    """
    Parse Grid/ directory containing optional grid PDFs and/or Groups/*.out files.
    Detection rule: Grid/ exists AND contains at least one of grid_1d.pdf, grid_2d.pdf,
    or Groups/*.out (or root *.out).
    """
    if not grid_dir.exists() or not grid_dir.is_dir():
        return None

    grid_1d = grid_dir / "grid_1d.pdf"
    grid_2d = grid_dir / "grid_2d.pdf"

    # Search for .out files in Groups/ or root
    out_files: list[Path] = []
    groups_dir = grid_dir / "Groups"
    if groups_dir.exists() and groups_dir.is_dir():
        out_files = sorted(groups_dir.glob("*.out"))
    if not out_files:
        out_files = sorted(grid_dir.glob("*.out"))

    has_1d_pdf = grid_1d.exists()
    has_2d_pdf = grid_2d.exists()
    has_out_files = len(out_files) > 0

    if not has_1d_pdf and not has_2d_pdf and not has_out_files:
        return None

    # Parse method grid specs if available
    specs: dict[str, GridSpecModel] = {}
    if run_info_dir and step_name:
        methods_dir = run_info_dir / "inputs" / "methods"
        if methods_dir.exists() and methods_dir.is_dir():
            for mf in sorted(methods_dir.glob("*.toml")):
                parsed_specs = _parse_method_grid_specs(mf, step_name)
                if parsed_specs:
                    specs.update(parsed_specs)

    # Build group info list
    groups_info: list[GridGroupInfo] = []
    param_names: list[str] = []

    res_map = residue_labels_map or {}

    for out_f in out_files:
        raw_key = out_f.stem
        res_key = _extract_residue_from_group_name(raw_key)
        disp_name = res_map.get(res_key, res_map.get(raw_key, res_key))
        groups_info.append(
            GridGroupInfo(
                raw_key=raw_key,
                residue=res_key,
                display_name=disp_name,
                file_path=str(out_f),
            )
        )

        # Extract param names from .out header across all files
        try:
            with open(out_f, "r", encoding="utf-8") as f:
                first_line = f.readline().strip()
                if first_line.startswith("#"):
                    raw = first_line.lstrip("#").strip()
                    if "[" in raw and "]" in raw:
                        items = re.findall(r"\[(.*?)\]", raw)
                    else:
                        items = raw.split()
                    chi2_aliases = {"χ²", "chi2", "chisqr", "χ2", "\u03c7\u00b2", "\u03c72", "chi_sq", "chisq"}
                    for it in items:
                        c_it = it.strip()
                        if c_it and c_it.lower() not in chi2_aliases and c_it not in param_names:
                            param_names.append(c_it)
        except Exception:
            pass

    if not param_names and specs:
        param_names = list(specs.keys())

    # If an out file is available, parse points and best_point for protocol conformance
    points: list[GridPointModel] = []
    best_point: Optional[GridPointModel] = None
    min_chisqr = float("inf")

    primary_out = grid_dir / "grid.out" if (grid_dir / "grid.out").exists() else (out_files[0] if out_files else None)
    if primary_out and primary_out.is_file():
        try:
            lines = primary_out.read_text(encoding="utf-8").splitlines()
            for line in lines[1:]:
                l_str = line.strip()
                if not l_str or l_str.startswith("#"):
                    continue
                tokens = l_str.split()
                nums = [_safe_float(t) for t in tokens]
                if any(n is None for n in nums) or len(nums) < 2:
                    continue
                chisqr = nums[-1]
                val_nums = nums[:-1]
                val_map: dict[str, float] = {}
                if param_names and len(param_names) == len(val_nums):
                    for pname, pval in zip(param_names, val_nums):
                        val_map[pname] = pval
                else:
                    for idx, pval in enumerate(val_nums):
                        val_map[f"param_{idx+1}"] = pval

                pt = GridPointModel(values=val_map, chisqr=chisqr)
                points.append(pt)
                if math.isfinite(chisqr) and chisqr < min_chisqr:
                    min_chisqr = chisqr
                    best_point = pt
        except Exception:
            pass

    output_files: list[str] = []
    for root_d, _, files in os.walk(grid_dir):
        for f in files:
            output_files.append(os.path.relpath(os.path.join(root_d, f), grid_dir))

    return GridResultModel(
        has_grid=True,
        parameters=param_names,
        specs=specs,
        groups=groups_info,
        points=points,
        best_point=best_point,
        grid_1d_pdf=str(grid_1d) if has_1d_pdf else None,
        grid_2d_pdf=str(grid_2d) if has_2d_pdf else None,
        output_files=output_files,
    )
