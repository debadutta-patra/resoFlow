"""
Artifact Locator for ChemEx output directories (§3.6, §4 Phase 5).

Unified path discovery functions supporting both:
- v2026_6 (legacy): aggregate artifacts under All/, group outputs in Groups/<grp>/, Grid/Groups/*.out
- v2026_9 (modern): aggregate artifacts at step root, no All/ or Groups/, Grid/summary.toml + Profiles/ + Factors/
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Optional, Sequence

from .layout import detect_layout, LayoutVersion

# Normalization mapping for statistics directory names
STATISTICS_METHOD_MAP = {
    "covariance": "Covariance",
    "cov": "Covariance",
    "mc": "MonteCarlo",
    "monte_carlo": "MonteCarlo",
    "montecarlo": "MonteCarlo",
    "bs": "Bootstrap",
    "bootstrap": "Bootstrap",
    "bootstrap_case": "Bootstrap",
    "bs_case": "Bootstrap",
    "bootstrap_residuals": "Bootstrap",
    "bsn": "BootstrapNS",
    "bootstrap_ns": "BootstrapNS",
    "bootstrapns": "BootstrapNS",
    "mcmc": "MCMC",
}


def resolve_run_dir(target: Path | str) -> Path:
    """
    Resolve the root directory where ChemEx artifacts are stored.
    If target contains an Output/ subdirectory with run artifacts, returns target / Output.
    """
    p = Path(target).resolve()
    out = p / "Output"
    if out.is_dir() and (
        (out / "run_info").exists()
        or (out / "Parameters").exists()
        or (out / "Statistics").exists()
        or (out / "Grid").exists()
        or (out / "Groups").exists()
        or (out / "Data").exists()
        or (out / "Plots").exists()
        or (out / "STEP1").exists()
        or any(c.is_dir() and c.name.upper().startswith("STEP") for c in out.iterdir())
    ):
        return out
    return p


def step_names(run_dir: Path | str) -> list[str]:
    """
    Discover all step directory names (e.g. ['STEP1', 'STEP2']) in natural order.
    Returns empty list for single-step runs.
    """
    root = resolve_run_dir(run_dir)
    steps = [
        c.name
        for c in root.iterdir()
        if c.is_dir() and re.match(r"^step\d+$", c.name, re.IGNORECASE)
    ]

    def _step_key(name: str) -> int:
        m = re.search(r"\d+", name)
        return int(m.group(0)) if m else 0

    return sorted(steps, key=_step_key)


def step_dir(run_dir: Path | str, step_name: Optional[str] = None) -> Path:
    """
    Get the directory for a specific step, or the run_dir if single-step or step_name is None.
    """
    root = resolve_run_dir(run_dir)
    if not step_name:
        # If run_dir has steps and no step specified, default to primary/last step or root
        s_names = step_names(root)
        if s_names:
            return root / s_names[-1]
        return root

    target_step = root / step_name
    if target_step.is_dir():
        return target_step

    # Case-insensitive lookup
    for c in root.iterdir():
        if c.is_dir() and c.name.lower() == step_name.lower():
            return c

    return root / step_name


def fitted_params(run_dir: Path | str, step_name: Optional[str] = None) -> Optional[Path]:
    """
    Locate Parameters/fitted.toml for a run or step, handling both v2026_6 and v2026_9 layouts.
    """
    root = resolve_run_dir(run_dir)
    s_dir = step_dir(root, step_name) if step_name else root
    candidates = []

    # 1. Step-level / root-level standard location
    candidates.append(s_dir / "Parameters" / "fitted.toml")

    # 2. Legacy v2026_6 locations with All/
    candidates.append(s_dir / "All" / "Parameters" / "fitted.toml")

    # 3. If step_name was given, but fitted.toml is in root (or vice-versa)
    if s_dir != root:
        candidates.append(root / "Parameters" / "fitted.toml")
        candidates.append(root / "All" / "Parameters" / "fitted.toml")

    # 4. If step_name was not given, search steps in reverse order (STEP2 then STEP1)
    for s in reversed(step_names(root)):
        candidates.append(root / s / "Parameters" / "fitted.toml")
        candidates.append(root / s / "All" / "Parameters" / "fitted.toml")

    for c in candidates:
        if c.is_file():
            return c

    # 5. Legacy group-level fallback
    for g_parent in [s_dir / "Groups", root / "Groups"]:
        if g_parent.is_dir():
            for g_child in sorted(g_parent.iterdir()):
                g_fitted = g_child / "Parameters" / "fitted.toml"
                if g_fitted.is_file():
                    return g_fitted

    return None


def fixed_params(run_dir: Path | str, step_name: Optional[str] = None) -> Optional[Path]:
    """Locate Parameters/fixed.toml."""
    root = resolve_run_dir(run_dir)
    s_dir = step_dir(root, step_name) if step_name else root
    for c in [
        s_dir / "Parameters" / "fixed.toml",
        s_dir / "All" / "Parameters" / "fixed.toml",
        root / "Parameters" / "fixed.toml",
        root / "All" / "Parameters" / "fixed.toml",
    ]:
        if c.is_file():
            return c
    return None


def constrained_params(run_dir: Path | str, step_name: Optional[str] = None) -> Optional[Path]:
    """Locate Parameters/constrained.toml."""
    root = resolve_run_dir(run_dir)
    s_dir = step_dir(root, step_name) if step_name else root
    for c in [
        s_dir / "Parameters" / "constrained.toml",
        s_dir / "All" / "Parameters" / "constrained.toml",
        root / "Parameters" / "constrained.toml",
        root / "All" / "Parameters" / "constrained.toml",
    ]:
        if c.is_file():
            return c
    return None


def all_parameter_files(run_dir: Path | str, step_name: Optional[str] = None) -> list[Path]:
    """
    Get all existing parameter files in order: parameters.toml, fitted.toml, fixed.toml, constrained.toml.
    """
    root = resolve_run_dir(run_dir)
    s_dir = step_dir(root, step_name) if step_name else root
    found: list[Path] = []
    seen = set()

    for name in ["parameters.toml", "fitted.toml", "fixed.toml", "constrained.toml"]:
        for parent in [s_dir / "Parameters", s_dir / "All" / "Parameters", root / "Parameters", root / "All" / "Parameters"]:
            cand = parent / name
            if cand.is_file() and cand not in seen:
                seen.add(cand)
                found.append(cand)
                break
    return found


def data_dir(run_dir: Path | str, step_name: Optional[str] = None) -> Optional[Path]:
    """Locate Data/ directory for a step or run."""
    root = resolve_run_dir(run_dir)
    s_dir = step_dir(root, step_name) if step_name else root
    for c in [
        s_dir / "Data",
        s_dir / "All" / "Data",
        root / "Data",
        root / "All" / "Data",
    ]:
        if c.is_dir():
            return c
    return None


def data_files(run_dir: Path | str, step_name: Optional[str] = None) -> list[Path]:
    """Get all .dat files in Data/."""
    d = data_dir(run_dir, step_name)
    if d and d.is_dir():
        return sorted(d.glob("*.dat"))
    return []


def plots_dir(run_dir: Path | str, step_name: Optional[str] = None) -> Optional[Path]:
    """Locate Plots/ directory."""
    root = resolve_run_dir(run_dir)
    s_dir = step_dir(root, step_name) if step_name else root
    for c in [
        s_dir / "Plots",
        s_dir / "All" / "Plots",
        root / "Plots",
        root / "All" / "Plots",
    ]:
        if c.is_dir():
            return c
    return None


def plot_files(
    run_dir: Path | str,
    step_name: Optional[str] = None,
    extension: Optional[str] = None,
) -> list[Path]:
    """Get plot files (.fit, .exp, .pdf) from Plots/."""
    p = plots_dir(run_dir, step_name)
    if not p or not p.is_dir():
        return []
    pattern = f"*{extension}" if extension else "*"
    return sorted(f for f in p.glob(pattern) if f.is_file())


def statistics_toml(run_dir: Path | str, step_name: Optional[str] = None) -> Optional[Path]:
    """Locate statistics.toml for a step or run."""
    root = resolve_run_dir(run_dir)
    s_dir = step_dir(root, step_name) if step_name else root
    for c in [
        s_dir / "statistics.toml",
        s_dir / "All" / "statistics.toml",
        root / "statistics.toml",
        root / "All" / "statistics.toml",
    ]:
        if c.is_file():
            return c
    return None


def statistics_dir(
    run_dir: Path | str,
    kind: str,
    step_name: Optional[str] = None,
) -> Optional[Path]:
    """
    Locate the Statistics/<Kind> directory (e.g. Statistics/MonteCarlo).
    Returns the primary directory or None if not found.
    """
    dirs = all_statistics_dirs(run_dir, kind, step_name)
    return dirs[0] if dirs else None


def all_statistics_dirs(
    run_dir: Path | str,
    kind: str,
    step_name: Optional[str] = None,
) -> list[Path]:
    """
    Locate all matching Statistics/<Kind> directories across top-level, step-level, and group-level paths.
    """
    root = resolve_run_dir(run_dir)
    dir_name = STATISTICS_METHOD_MAP.get(kind.lower(), kind)
    s_dir = step_dir(root, step_name) if step_name else root

    found: list[Path] = []
    seen = set()

    def _check_and_add(p: Path) -> None:
        try:
            res = p.resolve()
        except Exception:
            res = p
        if res not in seen and p.is_dir():
            seen.add(res)
            found.append(p)

    # 1. Step-level or root-level Statistics/<DirName>
    _check_and_add(s_dir / "Statistics" / dir_name)
    _check_and_add(s_dir / "All" / "Statistics" / dir_name)

    # Legacy Group-level statistics under s_dir
    if (s_dir / "Groups").is_dir():
        for g_child in sorted((s_dir / "Groups").iterdir()):
            if g_child.is_dir():
                _check_and_add(g_child / "Statistics" / dir_name)

    # If a specific step was requested, do not fall back to other steps
    if step_name:
        return found

    # 2. When no step specified: check root and other steps
    _check_and_add(root / "Statistics" / dir_name)
    _check_and_add(root / "All" / "Statistics" / dir_name)

    for s in reversed(step_names(root)):
        _check_and_add(root / s / "Statistics" / dir_name)
        _check_and_add(root / s / "All" / "Statistics" / dir_name)
        s_grp = root / s / "Groups"
        if s_grp.is_dir():
            for g_child in sorted(s_grp.iterdir()):
                if g_child.is_dir():
                    _check_and_add(g_child / "Statistics" / dir_name)

    if (root / "Groups").is_dir():
        for g_child in sorted((root / "Groups").iterdir()):
            if g_child.is_dir():
                _check_and_add(g_child / "Statistics" / dir_name)

    return found


def grid_dir(run_dir: Path | str, step_name: Optional[str] = None) -> Optional[Path]:
    """
    Locate the Grid/ directory for a step or run.
    """
    dirs = all_grid_dirs(run_dir, step_name)
    return dirs[0] if dirs else None


def all_grid_dirs(run_dir: Path | str, step_name: Optional[str] = None) -> list[Path]:
    """
    Locate all Grid/ directories for a step or run across step, root, and group levels.
    """
    root = resolve_run_dir(run_dir)
    s_dir = step_dir(root, step_name) if step_name else root

    found: list[Path] = []
    seen = set()

    def _check_and_add(p: Path) -> None:
        try:
            res = p.resolve()
        except Exception:
            res = p
        if res not in seen and p.is_dir():
            seen.add(res)
            found.append(p)

    _check_and_add(s_dir / "Grid")
    _check_and_add(s_dir / "All" / "Grid")

    # Legacy group-level Grid in s_dir
    if (s_dir / "Groups").is_dir():
        for g_child in sorted((s_dir / "Groups").iterdir()):
            if g_child.is_dir():
                _check_and_add(g_child / "Grid")

    # If a specific step was requested, do not fall back to other steps
    if step_name:
        return found

    # When no step requested: check root and other steps
    if s_dir != root:
        _check_and_add(root / "Grid")
        _check_and_add(root / "All" / "Grid")

    for s in step_names(root):
        _check_and_add(root / s / "Grid")
        _check_and_add(root / s / "All" / "Grid")
        if (root / s / "Groups").is_dir():
            for g_child in sorted((root / s / "Groups").iterdir()):
                if g_child.is_dir():
                    _check_and_add(g_child / "Grid")

    if (root / "Groups").is_dir():
        for g_child in sorted((root / "Groups").iterdir()):
            if g_child.is_dir():
                _check_and_add(g_child / "Grid")

    return found


def outcome_file(run_dir: Path | str) -> Optional[Path]:
    """Locate run_info/outcome.toml."""
    root = resolve_run_dir(run_dir)
    for c in [root / "run_info" / "outcome.toml", root.parent / "run_info" / "outcome.toml"]:
        if c.is_file():
            return c
    return None


def run_file(run_dir: Path | str) -> Optional[Path]:
    """Locate run_info/run.toml."""
    root = resolve_run_dir(run_dir)
    for c in [root / "run_info" / "run.toml", root.parent / "run_info" / "run.toml"]:
        if c.is_file():
            return c
    return None


def parameters_used_file(run_dir: Path | str) -> Optional[Path]:
    """Locate run_info/parameters_used.toml."""
    root = resolve_run_dir(run_dir)
    for c in [root / "run_info" / "parameters_used.toml", root.parent / "run_info" / "parameters_used.toml"]:
        if c.is_file():
            return c
    return None


def restart_file(run_dir: Path | str) -> Optional[Path]:
    """Locate run_info/restart.toml."""
    root = resolve_run_dir(run_dir)
    for c in [root / "run_info" / "restart.toml", root.parent / "run_info" / "restart.toml"]:
        if c.is_file():
            return c
    return None
