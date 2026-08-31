"""
Parser for ChemEx uncertainty statistics outputs under Statistics/ directories
(MonteCarlo, Bootstrap, BootstrapNS, MCMC).
Extracts parameter distributions, credible intervals, autocorrelation diagnostics,
and handles withheld/under-converged summaries explicitly.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

if sys.version_info >= (3, 11):
    import tomllib
else:
    import tomli as tomllib


def parse_statistics_directory(base_dir: str) -> Dict[str, Any]:
    """
    Scans base_dir (which may be run_dir, output_dir, or a step directory)
    for Statistics/ subdirectories and parses MonteCarlo, Bootstrap, BootstrapNS, and MCMC.

    Returns:
      {
        "has_statistics": bool,
        "methods": {
          "monte_carlo": { ... } | None,
          "bootstrap": { ... } | None,
          "bootstrap_ns": { ... } | None,
          "mcmc": { ... } | None,
        },
        "steps": {
          "<step_name>": { ... }
        }
      }
    """
    result: Dict[str, Any] = {
        "has_statistics": False,
        "methods": {},
        "steps": {},
    }

    # Find candidate statistics roots:
    # 1. base_dir/Statistics
    # 2. base_dir/Output/Statistics
    # 3. base_dir/<STEP>/Statistics
    # 4. base_dir/Output/<STEP>/Statistics
    stat_dirs_to_check: List[tuple[str, Path]] = []

    root_path = Path(base_dir)
    direct_stat = root_path / "Statistics"
    if direct_stat.is_dir():
        stat_dirs_to_check.append(("global", direct_stat))

    out_stat = root_path / "Output" / "Statistics"
    if out_stat.is_dir():
        stat_dirs_to_check.append(("global", out_stat))

    # Check step subdirectories (e.g. STEP1, STEP2)
    search_containers = [root_path, root_path / "Output"]
    for container in search_containers:
        if container.is_dir():
            try:
                for entry in container.iterdir():
                    if entry.is_dir() and entry.name.upper().startswith("STEP"):
                        step_stat = entry / "Statistics"
                        if step_stat.is_dir():
                            stat_dirs_to_check.append((entry.name.upper(), step_stat))
            except Exception:
                pass

    if not stat_dirs_to_check:
        return result

    result["has_statistics"] = True

    for scope_name, stat_path in stat_dirs_to_check:
        scope_methods: Dict[str, Any] = {}

        # 1. MonteCarlo
        mc_path = stat_path / "MonteCarlo"
        if mc_path.is_dir():
            scope_methods["monte_carlo"] = _parse_resampling_folder(mc_path, "Monte Carlo")

        # 2. Bootstrap
        bs_path = stat_path / "Bootstrap"
        if bs_path.is_dir():
            scope_methods["bootstrap"] = _parse_resampling_folder(bs_path, "Bootstrap")

        # 3. BootstrapNS
        bsn_path = stat_path / "BootstrapNS"
        if bsn_path.is_dir():
            scope_methods["bootstrap_ns"] = _parse_resampling_folder(bsn_path, "Nucleus-Specific Bootstrap")

        # 4. MCMC
        mcmc_path = stat_path / "MCMC"
        if mcmc_path.is_dir():
            scope_methods["mcmc"] = _parse_mcmc_folder(mcmc_path)

        if scope_name == "global":
            result["methods"].update(scope_methods)
        else:
            result["steps"][scope_name] = scope_methods
            # Also populate top-level methods if not already set
            for k, v in scope_methods.items():
                if k not in result["methods"]:
                    result["methods"][k] = v

    return result


def _parse_resampling_folder(folder: Path, method_name: str) -> Dict[str, Any]:
    """Parse outputs from a Resampling (MC/BS/BSN) directory."""
    diag_file = folder / "diagnostics.toml"
    summary_file = folder / "summary.toml"
    corr_file = folder / "correlations.tsv"
    samples_file = folder / "samples.tsv"
    pdf_file = folder / "plots.pdf"

    diagnostics = _read_toml_safe(diag_file)
    summary = _read_toml_safe(summary_file)
    correlations = _read_tsv_matrix(corr_file)

    sample_count = 0
    if samples_file.is_file():
        try:
            with samples_file.open("r", encoding="utf-8", errors="replace") as f:
                sample_count = max(0, sum(1 for _ in f) - 1)
        except Exception:
            pass

    # Status check
    requested = diagnostics.get("requested_samples", 0)
    completed = diagnostics.get("completed_samples", sample_count)
    is_complete = requested > 0 and completed >= requested

    status = "completed" if is_complete else "partial"

    return {
        "method_name": method_name,
        "status": status,
        "directory": str(folder),
        "has_plots_pdf": pdf_file.is_file(),
        "pdf_filename": pdf_file.name if pdf_file.is_file() else None,
        "diagnostics": diagnostics,
        "summary": _normalize_summary_parameters(summary),
        "correlations": correlations,
        "sample_count": completed,
        "requested_samples": requested,
    }


def _parse_mcmc_folder(folder: Path) -> Dict[str, Any]:
    """
    Parse outputs from an MCMC posterior sampling directory.
    Accurately captures autocorrelation diagnostics, burn-in, ESS,
    and distinct 'summary withheld' status if chain is under-converged.
    """
    diag_file = folder / "diagnostics.toml"
    summary_file = folder / "summary.toml"
    corr_file = folder / "correlations.tsv"
    samples_file = folder / "samples.tsv"
    pdf_file = folder / "plots.pdf"

    diagnostics = _read_toml_safe(diag_file)
    summary = _read_toml_safe(summary_file)
    correlations = _read_tsv_matrix(corr_file)

    autocorr_status = diagnostics.get("autocorrelation_status", "unavailable")
    autocorr_warning = diagnostics.get("autocorrelation_warning")
    ess_warning = diagnostics.get("effective_sample_size_warning")
    burn_in_warning = diagnostics.get("burn_in_warning")

    sample_count = 0
    if samples_file.is_file():
        try:
            with samples_file.open("r", encoding="utf-8", errors="replace") as f:
                sample_count = max(0, sum(1 for _ in f) - 1)
        except Exception:
            pass

    # Determine status
    if autocorr_status == "unreliable_short_chain":
        status = "diagnostics_available_summary_withheld"
        withheld_reason = (
            autocorr_warning
            or "Chain length is shorter than 50 times the integrated autocorrelation time. "
            "Effective sample size and MCSE were withheld by ChemEx."
        )
    elif autocorr_status == "unavailable":
        status = "diagnostics_available"
        withheld_reason = autocorr_warning or "Autocorrelation time was unavailable."
    else:
        status = "converged"
        withheld_reason = None

    normalized_summary = _normalize_summary_parameters(summary)

    return {
        "method_name": "MCMC Posterior Sampling",
        "status": status,
        "withheld_reason": withheld_reason,
        "directory": str(folder),
        "has_plots_pdf": pdf_file.is_file(),
        "pdf_filename": pdf_file.name if pdf_file.is_file() else None,
        "diagnostics": diagnostics,
        "autocorrelation_status": autocorr_status,
        "autocorrelation_warning": autocorr_warning,
        "ess_warning": ess_warning,
        "burn_in_warning": burn_in_warning,
        "summary": normalized_summary,
        "correlations": correlations,
        "sample_count": sample_count,
        "retained_samples": diagnostics.get("retained_samples", sample_count),
        "steps": diagnostics.get("steps"),
        "discarded_steps": diagnostics.get("discarded_steps"),
        "acceptance_fraction_mean": diagnostics.get("acceptance_fraction_mean"),
        "acceptance_fraction_min": diagnostics.get("acceptance_fraction_min"),
        "acceptance_fraction_max": diagnostics.get("acceptance_fraction_max"),
        "max_autocorrelation_time": diagnostics.get("max_autocorrelation_time") or diagnostics.get("max_autocorrelation_time_tentative"),
    }


def _read_toml_safe(filepath: Path) -> Dict[str, Any]:
    if not filepath.is_file():
        return {}
    try:
        with filepath.open("rb") as f:
            return tomllib.load(f)
    except Exception:
        # Fallback text parsing if invalid syntax
        res: Dict[str, Any] = {}
        try:
            with filepath.open("r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    line_s = line.strip()
                    if "=" in line_s and not line_s.startswith("#"):
                        parts = line_s.split("=", 1)
                        k = parts[0].strip().strip('"').strip("'")
                        v_str = parts[1].strip().split("#")[0].strip()
                        try:
                            res[k] = float(v_str) if "." in v_str or "e" in v_str.lower() else int(v_str)
                        except ValueError:
                            res[k] = v_str.strip('"').strip("'")
        except Exception:
            pass
        return res


def _read_tsv_matrix(filepath: Path) -> Dict[str, Any]:
    """Parse a correlations.tsv matrix into labels and 2D array."""
    if not filepath.is_file():
        return {"parameters": [], "matrix": []}
    try:
        with filepath.open("r", encoding="utf-8", errors="replace") as f:
            lines = [l.strip() for l in f if l.strip()]
        if not lines:
            return {"parameters": [], "matrix": []}

        header = lines[0].split("\t")
        parameters = [p.strip() for p in header[1:] if p.strip()]

        matrix: List[List[float]] = []
        for line in lines[1:]:
            parts = line.split("\t")
            if len(parts) > 1:
                row = []
                for val in parts[1:]:
                    try:
                        row.append(float(val))
                    except ValueError:
                        row.append(0.0)
                matrix.append(row)

        return {"parameters": parameters, "matrix": matrix}
    except Exception:
        return {"parameters": [], "matrix": []}


def _normalize_summary_parameters(summary_dict: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    """Normalizes the parameter summary dictionary for frontend consumption."""
    normalized: Dict[str, Dict[str, Any]] = {}
    for param_key, param_val in summary_dict.items():
        if isinstance(param_val, dict):
            clean_key = param_key.strip().strip('"').strip("'").strip("[]")
            normalized[clean_key] = {
                "mean": param_val.get("mean"),
                "std": param_val.get("standard_deviation"),
                "median": param_val.get("median"),
                "interval_95_lower": param_val.get("percentile_95_lower") or param_val.get("eti_95_lower"),
                "interval_95_upper": param_val.get("percentile_95_upper") or param_val.get("eti_95_upper"),
                "lower_1sigma": param_val.get("lower_1sigma"),
                "upper_1sigma": param_val.get("upper_1sigma"),
                "stderr": param_val.get("stderr"),
                "sample_count": param_val.get("sample_count"),
                "effective_sample_size": param_val.get("effective_sample_size"),
                "mcse_mean": param_val.get("mcse_mean"),
                "prior": param_val.get("prior"),
                "prior_lower": param_val.get("prior_lower"),
                "prior_upper": param_val.get("prior_upper"),
            }
    return normalized
