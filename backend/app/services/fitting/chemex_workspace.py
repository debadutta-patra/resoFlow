"""Stage a throwaway ChemEx workspace from an analysis run directory.

Used by the ChemEx validation / inspection endpoints: the analysis's own
Experiments, Data, Parameters and Methods are linked (never modified) into a
temporary directory, optional in-memory parameters/method TOML replace the
saved ones, and a ``FitJobSpec`` pointing at those files is returned.

Only files under the analysis run directory are ever exposed to ChemEx; callers
cannot supply arbitrary paths.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Iterable, Optional

from resoflow.chemex_api.spec import FitJobSpec


def _link_or_copy(src: Path, dest: Path) -> None:
    try:
        os.symlink(src.resolve(), dest)
    except OSError:
        if src.is_dir():
            shutil.copytree(src, dest)
        else:
            shutil.copy2(src, dest)


def _alias(dest: Path, target_name: str) -> None:
    """Create ``dest`` as a relative symlink to a sibling (case-variant directory alias)."""
    if dest.exists() or dest.is_symlink():
        return
    try:
        os.symlink(target_name, dest)
    except OSError:
        pass


def _stage_toml_dir(run_dir: Path, target: Path, names: Iterable[str], dest_name: str, *, copy: bool) -> Path:
    dest = target / dest_name
    dest.mkdir(parents=True, exist_ok=True)
    for name in names:
        src = run_dir / name
        if not src.is_dir():
            continue
        for f in src.glob("*.toml"):
            out = dest / f.name
            if out.exists():
                continue
            if copy:
                shutil.copy2(f, out)
            else:
                _link_or_copy(f, out)
    _alias(target / dest_name.lower(), dest_name)
    return dest


def _stage_data(run_dir: Path, target: Path) -> None:
    """Expose Data/ and data/ under both casings (experiment files use either)."""
    src_upper, src_lower = run_dir / "Data", run_dir / "data"
    dest_upper, dest_lower = target / "Data", target / "data"
    has_upper, has_lower = src_upper.is_dir(), src_lower.is_dir()

    if has_upper and has_lower and src_upper.resolve() != src_lower.resolve():
        for src, dest in ((src_upper, dest_upper), (src_lower, dest_lower)):
            dest.mkdir(parents=True, exist_ok=True)
            for item in src.iterdir():
                if not (dest / item.name).exists():
                    _link_or_copy(item, dest / item.name)
        # Cross-link entries so either casing resolves every dataset.
        for a, b, rel in ((dest_lower, dest_upper, "../data"), (dest_upper, dest_lower, "../Data")):
            for item in a.iterdir():
                if not (b / item.name).exists():
                    try:
                        os.symlink(f"{rel}/{item.name}", b / item.name)
                    except OSError:
                        pass
        return
    if has_upper:
        _link_or_copy(src_upper, dest_upper)
        _alias(dest_lower, "Data")
    elif has_lower:
        _link_or_copy(src_lower, dest_lower)
        _alias(dest_upper, "data")


def _stage_configured_experiments(run_dir: Path, target: Path, experiments: list) -> Path:
    """Write exactly the experiments a run would use (the saved config's generatedExperiments).

    The run task clears Experiments/ and writes these, so stale files left in the run
    directory by earlier generations must not be validated. Only base file names are used,
    and a saved ``path`` is read only if it lies inside the run directory.
    """
    dest = target / "Experiments"
    dest.mkdir(parents=True, exist_ok=True)
    _alias(target / "experiments", "Experiments")
    root = run_dir.resolve()
    for i, entry in enumerate(experiments):
        if isinstance(entry, dict):
            name = Path(str(entry.get("filename") or f"exp_{i}.toml")).name
            text = entry.get("toml_content") or ""
            if not text and entry.get("path"):
                src = Path(str(entry["path"]))
                src = (src if src.is_absolute() else run_dir / src).resolve()
                if src.is_file() and (src == root or root in src.parents):
                    text = src.read_text(encoding="utf-8")
        else:
            name, text = f"exp_{i}.toml", str(entry)
        if text.strip():
            (dest / name).write_text(text, encoding="utf-8")
    return dest


def stage_validation_workspace(
    run_dir: Optional[Path],
    target: Path,
    *,
    model: str = "2st",
    parameter_toml: Optional[str] = None,
    method_toml: Optional[str] = None,
    include: Optional[list[str]] = None,
    exclude: Optional[list[str]] = None,
    stage_methods: bool = True,
    experiments: Optional[list] = None,
) -> FitJobSpec:
    """Populate ``target`` from ``run_dir`` and return a spec for ChemEx validation/inspection.

    A missing run directory yields an empty workspace (ChemEx then reports
    "no data"); nothing outside the run directory is ever read. With
    ``stage_methods=False`` the saved method files are ignored (baseline roles).
    ``experiments`` (the saved config's generatedExperiments) selects exactly the
    experiment files a run would use; without it, the run directory's are staged.
    """
    src = run_dir if run_dir is not None and run_dir.is_dir() else None

    if src is not None:
        _stage_data(src, target)
    if src and experiments:
        exp_dir = _stage_configured_experiments(src, target, experiments)
    else:
        exp_dir = _stage_toml_dir(src, target, ("Experiments", "experiments"), "Experiments", copy=False) if src else _mkdirs(target, "Experiments")
    param_dir = _stage_toml_dir(src, target, ("Parameters", "parameters"), "Parameters", copy=True) if src else _mkdirs(target, "Parameters")
    method_dir = (
        _stage_toml_dir(src, target, ("Methods", "methods"), "Methods", copy=True)
        if src and stage_methods
        else _mkdirs(target, "Methods")
    )

    experiment_files = [f"Experiments/{f.name}" for f in sorted(exp_dir.glob("*.toml"))]

    if parameter_toml:
        (param_dir / "parameters.toml").write_text(parameter_toml, encoding="utf-8")
        parameter_files = ["Parameters/parameters.toml"]
    else:
        parameter_files = [f"Parameters/{f.name}" for f in sorted(param_dir.glob("*.toml"))]

    if method_toml:
        (method_dir / "method.toml").write_text(method_toml, encoding="utf-8")
        method_files = ["Methods/method.toml"]
    else:
        method_files = [f"Methods/{f.name}" for f in sorted(method_dir.glob("*.toml"))]

    return FitJobSpec(
        job_id="validation_spec",
        experiment_files=experiment_files,
        parameter_files=parameter_files,
        method_files=method_files,
        model=model or "2st",
        include=include or [],
        exclude=exclude or [],
        output_dir="Output",
    )


def _mkdirs(target: Path, name: str) -> Path:
    d = target / name
    d.mkdir(parents=True, exist_ok=True)
    _alias(target / name.lower(), name)
    return d
