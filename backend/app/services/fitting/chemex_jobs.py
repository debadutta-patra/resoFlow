"""Job specification builder for resoFlow ChemEx integration."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Mapping

from resoflow.chemex_api.spec import ExecutionSpec, FitJobSpec, ParameterOverride


def build_fit_spec(
    dirs: Mapping[str, str | Path],
    config: Mapping[str, Any],
    job_dir: str | Path | None = None,
) -> FitJobSpec:
    """Build a self-contained FitJobSpec from task directories and analysis config.

    Replaces the previous _build_*_chemex_command functions.
    Preserves ordering: sorted experiment TOMLs, parameters.toml only if non-empty,
    method.toml only if non-empty, and kinetic model default '2st'.
    All paths in the resulting spec are stored relative to `job_dir`.
    """
    experiments_dir = Path(dirs["experiments_dir"]).resolve()
    if job_dir is None:
        target_job_dir = experiments_dir.parent
    else:
        target_job_dir = Path(job_dir).resolve()

    # 1. Experiment files (sorted alphabetically)
    exp_files: list[str] = []
    if experiments_dir.exists():
        for fname in sorted(os.listdir(experiments_dir)):
            if fname.endswith(".toml"):
                full_p = (experiments_dir / fname).resolve()
                try:
                    rel_p = full_p.relative_to(target_job_dir).as_posix()
                except ValueError:
                    rel_p = os.path.relpath(full_p, target_job_dir)
                exp_files.append(rel_p)

    # 2. Parameter files - only parameters.toml if exists and non-empty
    param_files: list[str] = []
    if "parameters_dir" in dirs:
        parameters_dir = Path(dirs["parameters_dir"]).resolve()
        param_path = parameters_dir / "parameters.toml"
        if param_path.exists() and param_path.stat().st_size > 0 and param_path.read_text(encoding="utf-8").strip():
            try:
                rel_param = param_path.relative_to(target_job_dir).as_posix()
            except ValueError:
                rel_param = os.path.relpath(param_path, target_job_dir)
            param_files.append(rel_param)

    # 3. Method files - only method.toml if exists and non-empty
    method_files: list[str] = []
    if "methods_dir" in dirs:
        methods_dir = Path(dirs["methods_dir"]).resolve()
        method_path = methods_dir / "method.toml"
        if method_path.exists() and method_path.stat().st_size > 0 and method_path.read_text(encoding="utf-8").strip():
            try:
                rel_method = method_path.relative_to(target_job_dir).as_posix()
            except ValueError:
                rel_method = os.path.relpath(method_path, target_job_dir)
            method_files.append(rel_method)

    # 4. Kinetic model
    model = str(config.get("model", "2st"))

    # 5. Output directory
    if "output_dir" in dirs:
        out_p = Path(dirs["output_dir"]).resolve()
        try:
            rel_out = out_p.relative_to(target_job_dir).as_posix()
        except ValueError:
            rel_out = os.path.relpath(out_p, target_job_dir)
    else:
        rel_out = "Output"

    # 6. Include / Exclude
    include_list = [str(r) for r in config.get("include", []) if r is not None]
    exclude_list = [str(r) for r in config.get("exclude", []) if r is not None]

    # 7. Execution settings (workers, native_threads)
    workers = config.get("workers", os.getenv("RESOFLOW_CHEMEX_WORKERS", "auto"))
    native_threads = config.get("native_threads", os.getenv("RESOFLOW_CHEMEX_NATIVE_THREADS", "auto"))
    if isinstance(workers, str) and workers.isdigit():
        workers = int(workers)
    if isinstance(native_threads, str) and native_threads.isdigit():
        native_threads = int(native_threads)
    execution = ExecutionSpec(workers=workers, native_threads=native_threads)

    # 8. Overrides (if any)
    overrides: list[ParameterOverride] = []
    if "overrides" in config:
        for ov in config["overrides"]:
            if isinstance(ov, ParameterOverride):
                overrides.append(ov)
            elif isinstance(ov, dict):
                overrides.append(ParameterOverride.model_validate(ov))

    plot = config.get("plot", "normal")
    if plot not in ("nothing", "normal", "all"):
        plot = "normal"

    job_id = str(config.get("analysis_uuid") or config.get("job_id") or "")

    return FitJobSpec(
        job_id=job_id,
        experiment_files=exp_files,
        parameter_files=param_files,
        method_files=method_files,
        model=model,
        include=include_list,
        exclude=exclude_list,
        output_dir=rel_out,
        plot=plot,
        execution=execution,
        overrides=overrides,
    )
