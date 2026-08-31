"""
Statistics Trees Parser (§1.9).
Parses automatic Covariance diagnostics and optional Resampling / MCMC analyses.
Implements the completeness state machine (partial samples without summary is a valid state).
"""

from __future__ import annotations

import json
import tomllib
from pathlib import Path
from typing import Any, Optional

from .models import (
    McmcDiagnostics,
    McmcParameterSummary,
    McmcResultModel,
    ResamplingDiagnostics,
    ResamplingParameterSummary,
    ResamplingResultModel,
    StatisticsCollectionModel,
    StructuredWarning,
)


def _safe_float(val: Any) -> Optional[float]:
    if val is None:
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


def _safe_int(val: Any) -> Optional[int]:
    if val is None:
        return None
    try:
        return int(val)
    except (ValueError, TypeError):
        return None


def _parse_json_file(file_path: Path, warnings: list[StructuredWarning]) -> Optional[dict[str, Any]]:
    if not file_path.exists() or not file_path.is_file():
        return None
    try:
        return json.loads(file_path.read_text(encoding="utf-8"))
    except Exception as exc:
        warnings.append(
            StructuredWarning(
                code="CORRUPT_JSON_EVIDENCE",
                message=f"Failed to decode JSON evidence in {file_path.name}: {exc}",
                path=str(file_path),
            )
        )
        return None


def _parse_tsv_samples(
    file_path: Path,
    warnings: list[StructuredWarning],
) -> tuple[list[str], list[list[float]]]:
    """
    Parse samples.tsv returning (parameter_names, rows).
    """
    if not file_path.exists() or not file_path.is_file():
        return ([], [])

    try:
        lines = file_path.read_text(encoding="utf-8").splitlines()
    except Exception as exc:
        warnings.append(
            StructuredWarning(
                code="UNREADABLE_SAMPLES_TSV",
                message=f"Could not read {file_path.name}: {exc}",
                path=str(file_path),
            )
        )
        return ([], [])

    if not lines:
        return ([], [])

    headers = [h.strip().strip("[]") for h in lines[0].split("\t") if h.strip()]
    rows: list[list[float]] = []

    for line_idx, raw_line in enumerate(lines[1:], start=2):
        line = raw_line.strip()
        if not line:
            continue
        tokens = line.split("\t")
        row_vals: list[float] = []
        for t in tokens:
            t_clean = t.strip()
            if t_clean.lower() == "nan":
                row_vals.append(float("nan"))
            else:
                f_val = _safe_float(t_clean)
                row_vals.append(f_val if f_val is not None else float("nan"))
        if row_vals:
            rows.append(row_vals)

    return (headers, rows)


def _parse_tsv_correlations(
    file_path: Path,
    warnings: list[StructuredWarning],
) -> dict[str, dict[str, float]]:
    """
    Parse correlations.tsv matrix.
    """
    if not file_path.exists() or not file_path.is_file():
        return {}

    try:
        lines = file_path.read_text(encoding="utf-8").splitlines()
    except Exception:
        return {}

    if not lines or len(lines) < 2:
        return {}

    headers = [h.strip().strip("[]") for h in lines[0].split("\t")[1:] if h.strip()]
    result: dict[str, dict[str, float]] = {}

    for raw_line in lines[1:]:
        line = raw_line.strip()
        if not line:
            continue
        tokens = [t.strip() for t in line.split("\t")]
        if not tokens:
            continue
        row_param = tokens[0].strip("[]")
        result[row_param] = {}
        for col_idx, col_name in enumerate(headers):
            if col_idx + 1 < len(tokens):
                tok_val = tokens[col_idx + 1]
                val = _safe_float(tok_val)
                result[row_param][col_name] = val if val is not None else float("nan")

    return result


def _parse_failures_tsv(file_path: Path) -> list[dict[str, Any]]:
    if not file_path.exists() or not file_path.is_file():
        return []
    try:
        lines = file_path.read_text(encoding="utf-8").splitlines()
        if not lines:
            return []
        headers = [h.strip() for h in lines[0].split("\t")]
        failures = []
        for line in lines[1:]:
            tokens = [t.strip() for t in line.split("\t")]
            failures.append({k: v for k, v in zip(headers, tokens)})
        return failures
    except Exception:
        return []


def parse_resampling_directory(
    method_dir: Path,
    method_type: str,
    warnings: list[StructuredWarning],
) -> Optional[ResamplingResultModel]:
    """
    Parse MonteCarlo/, Bootstrap/, or BootstrapNS/ directory.
    """
    if not method_dir.exists() or not method_dir.is_dir():
        return None

    summary_file = method_dir / "summary.toml"
    samples_file = method_dir / "samples.tsv"
    correlations_file = method_dir / "correlations.tsv"
    diagnostics_file = method_dir / "diagnostics.toml"
    failures_file = method_dir / "failures.tsv"
    plots_file = method_dir / "plots.pdf"

    # 1. Parse Diagnostics
    diagnostics = None
    if diagnostics_file.exists():
        try:
            d_data = tomllib.loads(diagnostics_file.read_text(encoding="utf-8"))
            diagnostics = ResamplingDiagnostics(
                method=d_data.get("method"),
                fitmethod=d_data.get("fitmethod"),
                requested_samples=_safe_int(d_data.get("requested_samples")),
                completed_samples=_safe_int(d_data.get("completed_samples")),
                workers=_safe_int(d_data.get("workers")),
                parameters=d_data.get("parameters", []),
                samples_file=d_data.get("samples_file"),
                summary_file=d_data.get("summary_file"),
                correlations_file=d_data.get("correlations_file"),
                plots_file=d_data.get("plots_file"),
                extra={k: v for k, v in d_data.items() if k not in ("method", "fitmethod", "requested_samples", "completed_samples", "workers", "parameters")},
            )
        except Exception as exc:
            warnings.append(
                StructuredWarning(
                    code="CORRUPT_DIAGNOSTICS_TOML",
                    message=f"Failed to decode diagnostics.toml in {method_dir.name}: {exc}",
                    path=str(diagnostics_file),
                )
            )

    # 2. Parse Replicate Matrix and Derive Statistics Dynamically
    summary_map: dict[str, ResamplingParameterSummary] = {}
    from ..statistics_engine import compute_parameter_summary, load_replicates_or_fallback

    rep_data = load_replicates_or_fallback(method_dir, method_type)
    if rep_data is not None and rep_data.get("replicates") is not None and len(rep_data["parameter_names"]) > 0:
        calc_summary = compute_parameter_summary(
            rep_data["replicates"],
            rep_data["parameter_names"],
        )
        for p_name, p_stat in calc_summary.items():
            summary_map[p_name] = ResamplingParameterSummary(**p_stat)
    elif summary_file.exists():
        # Fallback to summary.toml if no samples/npz exists
        try:
            s_data = tomllib.loads(summary_file.read_text(encoding="utf-8"))
            for param_key, p_dict in s_data.items():
                if isinstance(p_dict, dict):
                    clean_pname = param_key.strip("[]")
                    std_val = _safe_float(p_dict.get("standard_deviation"))
                    summary_map[clean_pname] = ResamplingParameterSummary(
                        parameter_name=clean_pname,
                        interval=str(p_dict.get("interval", "95% percentile")),
                        sample_count=int(p_dict.get("sample_count", 0)),
                        mean=_safe_float(p_dict.get("mean")),
                        standard_deviation=std_val,
                        std_dev=std_val,
                        std=std_val,
                        sem=_safe_float(p_dict.get("stderr")),
                        median=_safe_float(p_dict.get("median")),
                        percentile_95_lower=_safe_float(p_dict.get("percentile_95_lower")),
                        percentile_95_upper=_safe_float(p_dict.get("percentile_95_upper")),
                        interval_95_lower=_safe_float(p_dict.get("percentile_95_lower")),
                        interval_95_upper=_safe_float(p_dict.get("percentile_95_upper")),
                        eti_95_lower=_safe_float(p_dict.get("percentile_95_lower")),
                        eti_95_upper=_safe_float(p_dict.get("percentile_95_upper")),
                        lower_1sigma=_safe_float(p_dict.get("lower_1sigma")),
                        upper_1sigma=_safe_float(p_dict.get("upper_1sigma")),
                        stderr=_safe_float(p_dict.get("stderr")),
                    )
        except Exception as exc:
            warnings.append(
                StructuredWarning(
                    code="CORRUPT_SUMMARY_TOML",
                    message=f"Failed to decode summary.toml in {method_dir.name}: {exc}",
                    path=str(summary_file),
                )
            )

    # 3. Parse Samples & Correlations
    sample_params, samples = _parse_tsv_samples(samples_file, warnings)
    correlations = _parse_tsv_correlations(correlations_file, warnings)
    failures = _parse_failures_tsv(failures_file)

    # Determine status
    if diagnostics and diagnostics.requested_samples and diagnostics.completed_samples:
        if diagnostics.completed_samples >= diagnostics.requested_samples and bool(summary_map):
            status = "complete"
        else:
            status = "incomplete"
    elif bool(summary_map) and any(s.sample_count > 0 for s in summary_map.values()):
        status = "complete"
    elif samples or bool(summary_map):
        status = "incomplete"
    else:
        status = "empty"

    return ResamplingResultModel(
        method_type=method_type,
        status=status,
        summary=summary_map,
        sample_parameters=sample_params or (rep_data.get("parameter_names") if rep_data else []),
        samples=samples,
        correlations=correlations,
        diagnostics=diagnostics,
        plots_pdf=str(plots_file) if plots_file.exists() else None,
        failures=failures,
    )


def parse_mcmc_directory(
    mcmc_dir: Path,
    warnings: list[StructuredWarning],
) -> Optional[McmcResultModel]:
    """
    Parse Statistics/MCMC/ directory.
    """
    if not mcmc_dir.exists() or not mcmc_dir.is_dir():
        return None

    summary_file = mcmc_dir / "summary.toml"
    samples_file = mcmc_dir / "samples.tsv"
    correlations_file = mcmc_dir / "correlations.tsv"
    diagnostics_file = mcmc_dir / "diagnostics.toml"
    failures_file = mcmc_dir / "failures.tsv"
    plots_file = mcmc_dir / "plots.pdf"

    # 1. Parse Diagnostics
    diagnostics = None
    if diagnostics_file.exists():
        try:
            d_data = tomllib.loads(diagnostics_file.read_text(encoding="utf-8"))
            timing_keys = (
                "sampling_seconds",
                "result_processing_seconds",
                "output_summary_seconds",
                "output_samples_seconds",
                "output_correlations_seconds",
                "output_plots_seconds",
                "output_total_seconds",
                "total_seconds",
            )
            timings = {k: float(d_data[k]) for k in timing_keys if k in d_data}
            unbounded = [str(u).strip("[]") for u in d_data.get("unbounded_parameters", [])]

            diagnostics = McmcDiagnostics(
                sampler=d_data.get("sampler"),
                lmfit_version=d_data.get("lmfit_version"),
                emcee_version=d_data.get("emcee_version"),
                autocorrelation_status=d_data.get("autocorrelation_status"),
                steps=_safe_int(d_data.get("steps")),
                requested_burn=d_data.get("requested_burn"),
                discarded_steps=_safe_int(d_data.get("discarded_steps")),
                thin=_safe_int(d_data.get("thin")),
                walkers=_safe_int(d_data.get("walkers")),
                workers=_safe_int(d_data.get("workers")),
                retained_steps=_safe_int(d_data.get("retained_steps")),
                retained_samples=_safe_int(d_data.get("retained_samples")),
                acceptance_fraction_mean=_safe_float(d_data.get("acceptance_fraction_mean")),
                acceptance_fraction_min=_safe_float(d_data.get("acceptance_fraction_min")),
                acceptance_fraction_max=_safe_float(d_data.get("acceptance_fraction_max")),
                unbounded_parameters=unbounded,
                burn_in_warning=d_data.get("burn_in_warning"),
                autocorrelation_warning=d_data.get("autocorrelation_warning"),
                timings=timings,
                extra={k: v for k, v in d_data.items() if k not in timing_keys and k not in ("sampler", "lmfit_version", "emcee_version", "autocorrelation_status", "steps", "requested_burn", "discarded_steps", "thin", "walkers", "workers", "retained_steps", "retained_samples", "acceptance_fraction_mean", "acceptance_fraction_min", "acceptance_fraction_max", "unbounded_parameters", "burn_in_warning", "autocorrelation_warning")},
            )
        except Exception as exc:
            warnings.append(
                StructuredWarning(
                    code="CORRUPT_MCMC_DIAGNOSTICS",
                    message=f"Failed to decode MCMC diagnostics.toml: {exc}",
                    path=str(diagnostics_file),
                )
            )

    # 2. Parse Chains / Samples and Derive Statistics Dynamically
    summary_map: dict[str, McmcParameterSummary] = {}
    from ..statistics_engine import compute_parameter_summary, load_replicates_or_fallback

    rep_data = load_replicates_or_fallback(mcmc_dir, "MCMC")
    ess_mcse_map: dict[str, dict[str, Any]] = {}

    if summary_file.exists():
        try:
            s_data = tomllib.loads(summary_file.read_text(encoding="utf-8"))
            for param_key, p_dict in s_data.items():
                if isinstance(p_dict, dict):
                    clean_pname = param_key.strip("[]")
                    ess_mcse_map[clean_pname] = {
                        "prior": str(p_dict.get("prior", "uniform")),
                        "prior_lower": _safe_float(p_dict.get("prior_lower")),
                        "prior_upper": _safe_float(p_dict.get("prior_upper")),
                        "effective_sample_size": _safe_float(p_dict.get("effective_sample_size")),
                        "mcse_mean": _safe_float(p_dict.get("mcse_mean")),
                    }
        except Exception as exc:
            warnings.append(
                StructuredWarning(
                    code="CORRUPT_MCMC_SUMMARY",
                    message=f"Failed to decode MCMC summary.toml: {exc}",
                    path=str(summary_file),
                )
            )

    if rep_data is not None and rep_data.get("replicates") is not None and len(rep_data["parameter_names"]) > 0:
        calc_summary = compute_parameter_summary(
            rep_data["replicates"],
            rep_data["parameter_names"],
        )
        for p_name, p_stat in calc_summary.items():
            meta_info = ess_mcse_map.get(p_name, {})
            summary_map[p_name] = McmcParameterSummary(
                **p_stat,
                prior=meta_info.get("prior", "uniform"),
                prior_lower=meta_info.get("prior_lower"),
                prior_upper=meta_info.get("prior_upper"),
                effective_sample_size=meta_info.get("effective_sample_size"),
                mcse_mean=meta_info.get("mcse_mean"),
            )
    elif summary_file.exists():
        # Fallback to summary.toml
        try:
            s_data = tomllib.loads(summary_file.read_text(encoding="utf-8"))
            for param_key, p_dict in s_data.items():
                if isinstance(p_dict, dict):
                    clean_pname = param_key.strip("[]")
                    std_val = _safe_float(p_dict.get("standard_deviation"))
                    eti_low = _safe_float(p_dict.get("eti_95_lower")) or _safe_float(p_dict.get("percentile_95_lower"))
                    eti_high = _safe_float(p_dict.get("eti_95_upper")) or _safe_float(p_dict.get("percentile_95_upper"))
                    summary_map[clean_pname] = McmcParameterSummary(
                        parameter_name=clean_pname,
                        prior=str(p_dict.get("prior", "uniform")),
                        prior_lower=_safe_float(p_dict.get("prior_lower")),
                        prior_upper=_safe_float(p_dict.get("prior_upper")),
                        credible_interval=str(p_dict.get("credible_interval", "95% equal-tailed")),
                        mean=_safe_float(p_dict.get("mean")),
                        standard_deviation=std_val,
                        std_dev=std_val,
                        std=std_val,
                        sem=_safe_float(p_dict.get("stderr")),
                        median=_safe_float(p_dict.get("median")),
                        eti_95_lower=eti_low,
                        eti_95_upper=eti_high,
                        percentile_95_lower=eti_low,
                        percentile_95_upper=eti_high,
                        interval_95_lower=eti_low,
                        interval_95_upper=eti_high,
                        lower_1sigma=_safe_float(p_dict.get("lower_1sigma")),
                        upper_1sigma=_safe_float(p_dict.get("upper_1sigma")),
                        stderr=_safe_float(p_dict.get("stderr")),
                        effective_sample_size=_safe_float(p_dict.get("effective_sample_size")),
                        mcse_mean=_safe_float(p_dict.get("mcse_mean")),
                    )
        except Exception:
            pass

    sample_params, samples = _parse_tsv_samples(samples_file, warnings)
    correlations = _parse_tsv_correlations(correlations_file, warnings)
    failures = _parse_failures_tsv(failures_file)

    if bool(summary_map):
        status = "complete"
    elif samples or diagnostics:
        status = "incomplete"
    else:
        status = "empty"

    return McmcResultModel(
        status=status,
        summary=summary_map,
        sample_parameters=sample_params or (rep_data.get("parameter_names") if rep_data else []),
        samples=samples,
        correlations=correlations,
        diagnostics=diagnostics,
        plots_pdf=str(plots_file) if plots_file.exists() else None,
        failures=failures,
    )


def parse_statistics_tree(
    statistics_dir: Path,
    warnings: list[StructuredWarning],
) -> Optional[StatisticsCollectionModel]:
    """
    Parse Statistics/ directory containing Covariance, Constrained, and Resampling/MCMC outputs.
    """
    if not statistics_dir.exists() or not statistics_dir.is_dir():
        return None

    cov_evidence = _parse_json_file(statistics_dir / "Covariance" / "evidence.json", warnings)
    con_evidence = _parse_json_file(statistics_dir / "Constrained" / "evidence.json", warnings)
    cov_blocks = _parse_json_file(statistics_dir / "Covariance" / "blocks.json", warnings)
    cov_status = _parse_json_file(statistics_dir / "Covariance" / "status.json", warnings)

    mc_result = parse_resampling_directory(statistics_dir / "MonteCarlo", "MonteCarlo", warnings)
    bs_result = parse_resampling_directory(statistics_dir / "Bootstrap", "Bootstrap", warnings)
    bsn_result = parse_resampling_directory(statistics_dir / "BootstrapNS", "BootstrapNS", warnings)
    mcmc_result = parse_mcmc_directory(statistics_dir / "MCMC", warnings)

    has_any = any(
        x is not None
        for x in (cov_evidence, con_evidence, cov_blocks, cov_status, mc_result, bs_result, bsn_result, mcmc_result)
    )
    if not has_any:
        return None

    return StatisticsCollectionModel(
        covariance_evidence=cov_evidence,
        constrained_evidence=con_evidence,
        covariance_blocks=cov_blocks,
        covariance_status=cov_status,
        monte_carlo=mc_result,
        bootstrap=bs_result,
        bootstrap_ns=bsn_result,
        mcmc=mcmc_result,
    )


def merge_resampling_results(
    results: list[ResamplingResultModel],
    method_type: str,
) -> Optional[ResamplingResultModel]:
    valid = [r for r in results if r is not None and r.status != "empty"]
    if not valid:
        return None

    merged_summary: dict[str, ResamplingParameterSummary] = {}
    merged_sample_params: list[str] = []
    merged_correlations: dict[str, dict[str, float]] = {}
    merged_failures: list[dict[str, Any]] = []
    all_sample_matrices: list[list[list[float]]] = []

    for r in valid:
        merged_summary.update(r.summary)
        for p in r.sample_parameters:
            if p not in merged_sample_params:
                merged_sample_params.append(p)
        merged_correlations.update(r.correlations)
        merged_failures.extend(r.failures)
        if r.samples:
            all_sample_matrices.append(r.samples)

    merged_samples: list[list[float]] = []
    if all_sample_matrices:
        n_rows = len(all_sample_matrices[0])
        if all(len(m) == n_rows for m in all_sample_matrices):
            for row_idx in range(n_rows):
                row_vals: list[float] = []
                for m in all_sample_matrices:
                    row_vals.extend(m[row_idx])
                merged_samples.append(row_vals)
        else:
            merged_samples = all_sample_matrices[0]

    # Build full N x N correlation matrix across all merged parameters
    all_p_keys = list(merged_summary.keys())
    full_correlations: dict[str, dict[str, float]] = {}
    for p1 in all_p_keys:
        full_correlations[p1] = {}
        for p2 in all_p_keys:
            if p1 == p2:
                full_correlations[p1][p2] = 1.0
            elif p1 in merged_correlations and p2 in merged_correlations[p1]:
                full_correlations[p1][p2] = merged_correlations[p1][p2]
            else:
                full_correlations[p1][p2] = 0.0

    primary_diag = valid[0].diagnostics
    if primary_diag:
        merged_diag = ResamplingDiagnostics(
            method=primary_diag.method,
            fitmethod=primary_diag.fitmethod,
            requested_samples=primary_diag.requested_samples,
            completed_samples=max(
                (r.diagnostics.completed_samples for r in valid if r.diagnostics and r.diagnostics.completed_samples is not None),
                default=primary_diag.completed_samples,
            ),
            workers=primary_diag.workers,
            parameters=merged_sample_params,
            samples_file=primary_diag.samples_file,
            summary_file=primary_diag.summary_file,
            correlations_file=primary_diag.correlations_file,
            plots_file=next((r.diagnostics.plots_file for r in valid if r.diagnostics and r.diagnostics.plots_file), None),
            extra=primary_diag.extra,
        )
    else:
        merged_diag = None

    plots_pdf = next((r.plots_pdf for r in valid if r.plots_pdf), None)
    status = "complete" if any(r.status == "complete" for r in valid) else "incomplete"

    return ResamplingResultModel(
        method_type=method_type,
        status=status,
        summary=merged_summary,
        sample_parameters=merged_sample_params,
        samples=merged_samples,
        correlations=full_correlations,
        diagnostics=merged_diag,
        plots_pdf=plots_pdf,
        failures=merged_failures,
    )


def merge_mcmc_results(
    results: list[McmcResultModel],
) -> Optional[McmcResultModel]:
    valid = [r for r in results if r is not None and r.status != "empty"]
    if not valid:
        return None

    merged_summary: dict[str, McmcParameterSummary] = {}
    merged_sample_params: list[str] = []
    merged_correlations: dict[str, dict[str, float]] = {}
    merged_failures: list[dict[str, Any]] = []
    all_sample_matrices: list[list[list[float]]] = []

    for r in valid:
        merged_summary.update(r.summary)
        for p in r.sample_parameters:
            if p not in merged_sample_params:
                merged_sample_params.append(p)
        merged_correlations.update(r.correlations)
        merged_failures.extend(r.failures)
        if r.samples:
            all_sample_matrices.append(r.samples)

    merged_samples: list[list[float]] = []
    if all_sample_matrices:
        n_rows = len(all_sample_matrices[0])
        if all(len(m) == n_rows for m in all_sample_matrices):
            for row_idx in range(n_rows):
                row_vals: list[float] = []
                for m in all_sample_matrices:
                    row_vals.extend(m[row_idx])
                merged_samples.append(row_vals)
        else:
            merged_samples = all_sample_matrices[0]

    # Build full N x N correlation matrix across all merged parameters
    all_p_keys = list(merged_summary.keys())
    full_correlations: dict[str, dict[str, float]] = {}
    for p1 in all_p_keys:
        full_correlations[p1] = {}
        for p2 in all_p_keys:
            if p1 == p2:
                full_correlations[p1][p2] = 1.0
            elif p1 in merged_correlations and p2 in merged_correlations[p1]:
                full_correlations[p1][p2] = merged_correlations[p1][p2]
            else:
                full_correlations[p1][p2] = 0.0

    primary_diag = valid[0].diagnostics
    plots_pdf = next((r.plots_pdf for r in valid if r.plots_pdf), None)
    status = "complete" if any(r.status == "complete" for r in valid) else "incomplete"

    return McmcResultModel(
        status=status,
        summary=merged_summary,
        sample_parameters=merged_sample_params,
        samples=merged_samples,
        correlations=full_correlations,
        diagnostics=primary_diag,
        plots_pdf=plots_pdf,
        failures=merged_failures,
    )


def merge_statistics_collections(
    collections: list[StatisticsCollectionModel],
) -> Optional[StatisticsCollectionModel]:
    """
    Merge multiple group statistics collections into an aggregated step-level collection.
    """
    valid = [c for c in collections if c is not None]
    if not valid:
        return None

    mc_list = [c.monte_carlo for c in valid if c.monte_carlo is not None]
    bs_list = [c.bootstrap for c in valid if c.bootstrap is not None]
    bsn_list = [c.bootstrap_ns for c in valid if c.bootstrap_ns is not None]
    mcmc_list = [c.mcmc for c in valid if c.mcmc is not None]

    merged_cov_evidence: dict[str, Any] = {}
    merged_con_evidence: dict[str, Any] = {}
    merged_cov_blocks: dict[str, Any] = {}
    merged_cov_status: dict[str, Any] = {}

    for c in valid:
        if c.covariance_evidence:
            merged_cov_evidence.update(c.covariance_evidence)
        if c.constrained_evidence:
            merged_con_evidence.update(c.constrained_evidence)
        if c.covariance_blocks:
            merged_cov_blocks.update(c.covariance_blocks)
        if c.covariance_status:
            merged_cov_status.update(c.covariance_status)

    mc_merged = merge_resampling_results(mc_list, "MonteCarlo") if mc_list else None
    bs_merged = merge_resampling_results(bs_list, "Bootstrap") if bs_list else None
    bsn_merged = merge_resampling_results(bsn_list, "BootstrapNS") if bsn_list else None
    mcmc_merged = merge_mcmc_results(mcmc_list) if mcmc_list else None

    has_any = any(
        x is not None
        for x in (
            merged_cov_evidence,
            merged_con_evidence,
            merged_cov_blocks,
            merged_cov_status,
            mc_merged,
            bs_merged,
            bsn_merged,
            mcmc_merged,
        )
    )
    if not has_any:
        return None

    return StatisticsCollectionModel(
        covariance_evidence=merged_cov_evidence or None,
        constrained_evidence=merged_con_evidence or None,
        covariance_blocks=merged_cov_blocks or None,
        covariance_status=merged_cov_status or None,
        monte_carlo=mc_merged,
        bootstrap=bs_merged,
        bootstrap_ns=bsn_merged,
        mcmc=mcmc_merged,
    )

