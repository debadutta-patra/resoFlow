"""
Layout detection for ChemEx output directories.

Distinguishes between legacy ChemEx 2026.6 layout (Groups/, All/, Grid/Groups/*.out)
and modern ChemEx 2026.9 layout (direct step root artifacts, Grid/summary.toml, Profiles/, Factors/).
"""

from __future__ import annotations

import tomllib
from pathlib import Path
from typing import Literal

LayoutVersion = Literal["v2026_6", "v2026_9"]


def detect_layout(run_dir: Path | str) -> LayoutVersion:
    """
    Detect whether run_dir follows the v2026_6 or v2026_9 directory layout.

    Detection order:
    1. run_info/run.toml version string ([chemex] version).
    2. run_info/outcome.toml presence (2026.9 trust gate).
    3. Grid artifacts: Grid/summary.toml -> v2026_9; Grid/grid.out or Grid/Groups -> v2026_6.
    4. Probing for Groups/ or All/ directory presence -> v2026_6.
    5. Default fallback -> v2026_9 (modern default).
    """
    p = Path(run_dir).resolve()
    # Check if run_dir itself or an Output/ subdirectory contains run_info
    candidates = [p]
    if (p / "Output").is_dir():
        candidates.insert(0, p / "Output")

    for root in candidates:
        # 1. Check run_info/run.toml
        run_toml = root / "run_info" / "run.toml"
        if run_toml.is_file():
            try:
                data = tomllib.loads(run_toml.read_text(encoding="utf-8"))
                version = str(data.get("chemex", {}).get("version", "")).strip()
                if version:
                    parts = version.split(".")
                    try:
                        year = int(parts[0])
                        minor = int(parts[1]) if len(parts) > 1 else 0
                        if (year, minor) >= (2026, 9):
                            return "v2026_9"
                        elif (year, minor) <= (2026, 6):
                            return "v2026_6"
                    except (ValueError, IndexError):
                        if version.startswith("2026.9"):
                            return "v2026_9"
                        elif version.startswith("2026.6"):
                            return "v2026_6"
            except Exception:
                pass

        # 2. Check run_info/outcome.toml presence (written by ChemEx 2026.9+ and resoflow engine)
        outcome_toml = root / "run_info" / "outcome.toml"
        if outcome_toml.is_file():
            try:
                data = tomllib.loads(outcome_toml.read_text(encoding="utf-8"))
                schema = int(data.get("schema_version", 1))
                if schema >= 2 or data.get("status") in ("complete", "incomplete", "running", "cancelled"):
                    return "v2026_9"
            except Exception:
                return "v2026_9"

        # 3. Check Grid directory signatures
        grid_dir = root / "Grid"
        if grid_dir.is_dir():
            if (grid_dir / "summary.toml").is_file() or (grid_dir / "Profiles").is_dir() or (grid_dir / "Factors").is_dir():
                return "v2026_9"
            if (grid_dir / "grid.out").is_file() or (grid_dir / "Groups").is_dir():
                return "v2026_6"

        # Check step-level Grid directories
        for step_child in root.iterdir():
            if step_child.is_dir() and step_child.name.upper().startswith("STEP"):
                s_grid = step_child / "Grid"
                if s_grid.is_dir():
                    if (s_grid / "summary.toml").is_file() or (s_grid / "Profiles").is_dir() or (s_grid / "Factors").is_dir():
                        return "v2026_9"
                    if (s_grid / "grid.out").is_file() or (s_grid / "Groups").is_dir():
                        return "v2026_6"

        # 4. Probe for legacy All/ or Groups/
        if (root / "All").is_dir() or (root / "Groups").is_dir():
            return "v2026_6"
        for step_child in root.iterdir():
            if step_child.is_dir() and step_child.name.upper().startswith("STEP"):
                if (step_child / "All").is_dir() or (step_child / "Groups").is_dir():
                    return "v2026_6"

    # Default to modern layout
    return "v2026_9"
