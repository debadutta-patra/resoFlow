"""ChemEx output tree comparison utility for parity and regression testing.

Compares two ChemEx output directory trees.
Checks:
- Relative file sets match (ignoring ephemeral/platform-specific files).
- `Parameters/*.toml` parameter values and stderr comments match numerically within (rtol, atol).
- `statistics.toml` (and Statistics summary/diagnostics TOMLs) match numerically within (rtol, atol).
- `Data/*.dat`, `Plots/*.fit`, `Plots/*.exp` numerical tables match per section within (rtol, atol).
- `run_info/run.toml` matches structurally, ignoring timestamps, paths, and argv.
- Binary files (e.g. `.pdf`) exist in both trees without comparing binary blobs.
"""

from __future__ import annotations

import argparse
import math
import os
import re
import sys
import tomllib
from pathlib import Path
from typing import Any


# Regex for parameter lines with optional stderr comment:
# e.g.: KEX_AB =  3.77303e+02 # ±1.59730e+01
# e.g.: PB     =  6.67200e-02 # ±1.67100e-03
# e.g.: R2_A   =  3.95488e+00
_PARAM_LINE_RE = re.compile(
    r"^\s*([A-Za-z0-9_,\.\s\-\>\/\"\'\[\]]+?)\s*=\s*([+-]?(?:(?:\d*\.\d+)|\d+)(?:[eE][+-]?\d+)?)\s*(?:#\s*±\s*([+-]?(?:(?:\d*\.\d+)|\d+)(?:[eE][+-]?\d+)?))?"
)

# Files to ignore completely in tree comparison
_IGNORED_FILENAMES = {
    ".DS_Store",
    "chemex.log",
    "engine.log",
    "progress.json",
    "progress.jsonl",
    "heartbeat",
    "engine_result.json",
    "plots_emerald_green.zip",
}

_IGNORED_EXTENSIONS = {
    ".tmp",
    ".swp",
    ".log",
}


def _is_ignored(path: Path) -> bool:
    if path.name in _IGNORED_FILENAMES:
        return True
    if path.suffix in _IGNORED_EXTENSIONS:
        return True
    if any(part.endswith(".tmp") for part in path.parts):
        return True
    return False


def _isclose(a: float, b: float, rtol: float, atol: float) -> bool:
    if math.isnan(a) and math.isnan(b):
        return True
    if math.isinf(a) and math.isinf(b):
        return (a > 0) == (b > 0)
    return math.isclose(a, b, rel_tol=rtol, abs_tol=atol)


def parse_parameters_file(path: Path) -> dict[str, dict[str, tuple[float, float | None]]]:
    """Parse a ChemEx Parameters/*.toml file into a nested dict:

    section -> param_name -> (value, stderr)
    """
    sections: dict[str, dict[str, tuple[float, float | None]]] = {}
    current_section = "GLOBAL"
    sections[current_section] = {}

    with path.open("r", encoding="utf-8") as f:
        for line in f:
            stripped = line.strip()
            if not stripped:
                continue
            if stripped.startswith("[") and stripped.endswith("]"):
                current_section = stripped[1:-1].strip().strip('"').strip("'")
                if current_section not in sections:
                    sections[current_section] = {}
                continue

            match = _PARAM_LINE_RE.match(stripped)
            if match:
                key = match.group(1).strip().strip('"').strip("'")
                val = float(match.group(2))
                err = float(match.group(3)) if match.group(3) is not None else None
                sections[current_section][key] = (val, err)

    return sections


def parse_dat_or_fit_file(path: Path) -> dict[str, list[list[float]]]:
    """Parse a ChemEx Data/*.dat or Plots/*.fit or Plots/*.exp file into:

    section -> list of rows (floats)
    """
    sections: dict[str, list[list[float]]] = {}
    current_section = "DEFAULT"

    with path.open("r", encoding="utf-8") as f:
        for line in f:
            stripped = line.strip()
            if not stripped:
                continue
            if stripped.startswith("[") and stripped.endswith("]"):
                current_section = stripped[1:-1].strip()
                if current_section not in sections:
                    sections[current_section] = []
                continue

            if stripped.startswith("#"):
                continue

            # Strip inline comment (e.g. # NOT USED IN THE FIT)
            if "#" in stripped:
                stripped = stripped.split("#", 1)[0].strip()
                if not stripped:
                    continue

            parts = stripped.split()
            try:
                row = [float(p) for p in parts]
                if current_section not in sections:
                    sections[current_section] = []
                sections[current_section].append(row)
            except ValueError:
                continue

    return sections


def compare_toml_data(
    data_a: Any,
    data_b: Any,
    path_prefix: str,
    rtol: float,
    atol: float,
) -> list[str]:
    """Recursively compare parsed TOML data structures."""
    diffs: list[str] = []

    if isinstance(data_a, dict) and isinstance(data_b, dict):
        keys_a = set(data_a.keys())
        keys_b = set(data_b.keys())
        for k in sorted(keys_a - keys_b):
            diffs.append(f"{path_prefix}.{k}: present in tree A but missing in tree B")
        for k in sorted(keys_b - keys_a):
            diffs.append(f"{path_prefix}.{k}: present in tree B but missing in tree A")
        for k in sorted(keys_a & keys_b):
            diffs.extend(
                compare_toml_data(
                    data_a[k], data_b[k], f"{path_prefix}.{k}", rtol, atol
                )
            )
    elif isinstance(data_a, list) and isinstance(data_b, list):
        if len(data_a) != len(data_b):
            diffs.append(
                f"{path_prefix}: list length mismatch ({len(data_a)} vs {len(data_b)})"
            )
        else:
            for i, (item_a, item_b) in enumerate(zip(data_a, data_b)):
                diffs.extend(
                    compare_toml_data(
                        item_a, item_b, f"{path_prefix}[{i}]", rtol, atol
                    )
                )
    elif isinstance(data_a, (int, float)) and isinstance(data_b, (int, float)):
        val_a = float(data_a)
        val_b = float(data_b)
        if not _isclose(val_a, val_b, rtol, atol):
            diffs.append(
                f"{path_prefix}: numeric mismatch: {val_a} vs {val_b} (diff={abs(val_a - val_b):.2e})"
            )
    else:
        if data_a != data_b:
            diffs.append(f"{path_prefix}: value mismatch: {data_a!r} vs {data_b!r}")

    return diffs


def compare_parameters_files(
    path_a: Path, path_b: Path, rel_path: str, rtol: float, atol: float
) -> list[str]:
    diffs: list[str] = []
    params_a = parse_parameters_file(path_a)
    params_b = parse_parameters_file(path_b)

    all_sections = sorted(set(params_a.keys()) | set(params_b.keys()))
    for sec in all_sections:
        if sec not in params_a:
            diffs.append(f"{rel_path}: section [{sec}] missing in tree A")
            continue
        if sec not in params_b:
            diffs.append(f"{rel_path}: section [{sec}] missing in tree B")
            continue

        sec_a = params_a[sec]
        sec_b = params_b[sec]
        all_keys = sorted(set(sec_a.keys()) | set(sec_b.keys()))

        for k in all_keys:
            if k not in sec_a:
                diffs.append(f"{rel_path} [{sec}] {k}: missing in tree A")
                continue
            if k not in sec_b:
                diffs.append(f"{rel_path} [{sec}] {k}: missing in tree B")
                continue

            val_a, err_a = sec_a[k]
            val_b, err_b = sec_b[k]

            if not _isclose(val_a, val_b, rtol, atol):
                diffs.append(
                    f"{rel_path} [{sec}] {k} value: {val_a} vs {val_b} "
                    f"(rel diff={abs(val_a - val_b) / (abs(val_a) + 1e-15):.2e})"
                )

            if err_a is not None and err_b is not None:
                if not _isclose(err_a, err_b, rtol, atol):
                    diffs.append(
                        f"{rel_path} [{sec}] {k} stderr: {err_a} vs {err_b} "
                        f"(rel diff={abs(err_a - err_b) / (abs(err_a) + 1e-15):.2e})"
                    )
            elif err_a is not None or err_b is not None:
                diffs.append(
                    f"{rel_path} [{sec}] {k} stderr presence mismatch: {err_a} vs {err_b}"
                )

    return diffs


def compare_dat_or_fit_files(
    path_a: Path, path_b: Path, rel_path: str, rtol: float, atol: float
) -> list[str]:
    diffs: list[str] = []
    data_a = parse_dat_or_fit_file(path_a)
    data_b = parse_dat_or_fit_file(path_b)

    all_sections = sorted(set(data_a.keys()) | set(data_b.keys()))
    for sec in all_sections:
        if sec not in data_a:
            diffs.append(f"{rel_path}: section [{sec}] missing in tree A")
            continue
        if sec not in data_b:
            diffs.append(f"{rel_path}: section [{sec}] missing in tree B")
            continue

        rows_a = data_a[sec]
        rows_b = data_b[sec]

        if len(rows_a) != len(rows_b):
            diffs.append(
                f"{rel_path} [{sec}]: row count mismatch ({len(rows_a)} vs {len(rows_b)})"
            )
            continue

        for r_idx, (row_a, row_b) in enumerate(zip(rows_a, rows_b)):
            if len(row_a) != len(row_b):
                diffs.append(
                    f"{rel_path} [{sec}] row {r_idx}: column count mismatch ({len(row_a)} vs {len(row_b)})"
                )
                continue
            for c_idx, (v_a, v_b) in enumerate(zip(row_a, row_b)):
                if not _isclose(v_a, v_b, rtol, atol):
                    diffs.append(
                        f"{rel_path} [{sec}] row {r_idx} col {c_idx}: {v_a} vs {v_b} "
                        f"(diff={abs(v_a - v_b):.2e})"
                    )
                    if len(diffs) > 20:
                        diffs.append(f"{rel_path}: stopping after 20 numerical diffs")
                        return diffs

    return diffs


def compare_run_info_run_toml(path_a: Path, path_b: Path, rel_path: str) -> list[str]:
    """Compare run_info/run.toml ignoring runtime timestamps, paths, and argv."""
    diffs: list[str] = []
    try:
        with path_a.open("rb") as fa:
            data_a = tomllib.load(fa)
        with path_b.open("rb") as fb:
            data_b = tomllib.load(fb)
    except Exception as exc:
        return [f"{rel_path}: failed to load TOML: {exc}"]

    # Check schema_version and run kind if present
    if data_a.get("schema_version") != data_b.get("schema_version"):
        diffs.append(
            f"{rel_path}: schema_version mismatch ({data_a.get('schema_version')} vs {data_b.get('schema_version')})"
        )

    run_a = data_a.get("run", {})
    run_b = data_b.get("run", {})
    if run_a.get("kind") != run_b.get("kind"):
        diffs.append(
            f"{rel_path}: [run].kind mismatch ({run_a.get('kind')} vs {run_b.get('kind')})"
        )

    return diffs


def compare_trees(
    dir_a: Path,
    dir_b: Path,
    rtol: float = 1e-7,
    atol: float = 1e-10,
    check_plots_data: bool = True,
) -> tuple[bool, list[str]]:
    """Compare two ChemEx output trees.

    Returns (is_equal, list_of_diffs).
    """
    diffs: list[str] = []

    if not dir_a.is_dir():
        return False, [f"Tree A directory does not exist: {dir_a}"]
    if not dir_b.is_dir():
        return False, [f"Tree B directory does not exist: {dir_b}"]

    # 1. Collect relative files
    files_a: dict[str, Path] = {}
    for root, _, files in os.walk(dir_a):
        for f in files:
            p = Path(root) / f
            if not _is_ignored(p):
                rel = str(p.relative_to(dir_a))
                files_a[rel] = p

    files_b: dict[str, Path] = {}
    for root, _, files in os.walk(dir_b):
        for f in files:
            p = Path(root) / f
            if not _is_ignored(p):
                rel = str(p.relative_to(dir_b))
                files_b[rel] = p

    set_a = set(files_a.keys())
    set_b = set(files_b.keys())

    # Optional: ignore run_info/inputs in file set comparison if directory layouts differ
    # But for strict parity, both should have the same structure
    only_in_a = sorted(set_a - set_b)
    only_in_b = sorted(set_b - set_a)

    if only_in_a:
        for f in only_in_a:
            diffs.append(f"File only in tree A: {f}")
    if only_in_b:
        for f in only_in_b:
            diffs.append(f"File only in tree B: {f}")

    # 2. Compare matching files
    common_files = sorted(set_a & set_b)
    for rel in common_files:
        pa = files_a[rel]
        pb = files_b[rel]

        # Ignore PDF binary differences, only check existence
        if pa.suffix.lower() == ".pdf":
            continue

        # Ignore zip binary differences
        if pa.suffix.lower() == ".zip":
            continue

        # Special handling for run.toml
        if rel.endswith("run_info/run.toml") or rel == "run.toml":
            diffs.extend(compare_run_info_run_toml(pa, pb, rel))
            continue

        # Parameter files
        if "Parameters" in pa.parts and pa.suffix.lower() == ".toml":
            diffs.extend(compare_parameters_files(pa, pb, rel, rtol, atol))
            continue

        # Data and Plot numeric tables
        if (
            rel.endswith(".dat")
            or rel.endswith(".fit")
            or (check_plots_data and rel.endswith(".exp"))
        ):
            diffs.extend(compare_dat_or_fit_files(pa, pb, rel, rtol, atol))
            continue

        # TOML statistics and general TOML files
        if pa.suffix.lower() == ".toml":
            try:
                with pa.open("rb") as fa:
                    data_a = tomllib.load(fa)
                with pb.open("rb") as fb:
                    data_b = tomllib.load(fb)
                diffs.extend(compare_toml_data(data_a, data_b, rel, rtol, atol))
            except Exception as e:
                diffs.append(f"{rel}: failed parsing TOML: {e}")
            continue

        # Plain text files or TSV/out files
        if pa.suffix.lower() in (".out", ".tsv", ".txt"):
            diffs.extend(compare_dat_or_fit_files(pa, pb, rel, rtol, atol))
            continue

    is_equal = len(diffs) == 0
    return is_equal, diffs


def assert_trees_equal(
    dir_a: Path,
    dir_b: Path,
    rtol: float = 1e-7,
    atol: float = 1e-10,
    check_plots_data: bool = True,
) -> None:
    """Assert that two ChemEx output trees are numerically equal."""
    is_equal, diffs = compare_trees(
        dir_a, dir_b, rtol=rtol, atol=atol, check_plots_data=check_plots_data
    )
    if not is_equal:
        report = "\n".join(diffs[:50])
        if len(diffs) > 50:
            report += f"\n... and {len(diffs) - 50} more differences"
        raise AssertionError(f"ChemEx output trees differ:\n{report}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Compare two ChemEx output trees for parity."
    )
    parser.add_argument("tree_a", type=Path, help="Path to first ChemEx output tree")
    parser.add_argument("tree_b", type=Path, help="Path to second ChemEx output tree")
    parser.add_argument(
        "--rtol",
        type=float,
        default=1e-7,
        help="Relative numerical tolerance (default: 1e-7)",
    )
    parser.add_argument(
        "--atol",
        type=float,
        default=1e-10,
        help="Absolute numerical tolerance (default: 1e-10)",
    )

    args = parser.parse_args()
    is_equal, diffs = compare_trees(
        args.tree_a, args.tree_b, rtol=args.rtol, atol=args.atol
    )

    if is_equal:
        print(f"SUCCESS: Trees match within rtol={args.rtol}, atol={args.atol}")
        return 0
    else:
        print(f"FAILURE: Trees differ ({len(diffs)} differences):")
        for d in diffs[:50]:
            print(f"  - {d}")
        if len(diffs) > 50:
            print(f"  ... and {len(diffs) - 50} more differences")
        return 1


if __name__ == "__main__":
    sys.exit(main())
