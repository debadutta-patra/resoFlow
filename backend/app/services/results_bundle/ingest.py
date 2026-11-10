"""Results Bundle Ingestion Engine (§3.11).

Single-pass parser that derives the complete results bundle into results.tmp/
and atomically promotes it to results/:
  - manifest.json
  - summary.json (< 200 kB eager payload)
  - results.sqlite (queryable relational store)
  - report_model.json (serialized ReportModel)
  - results.json (compatibility copy at run root)
"""

from __future__ import annotations

import fcntl
import json
import logging
import math
import os
import shutil
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Union

from ..fitting.chemex_output import locate, parse_output_tree
from ..fitting.chemex_output.grid_parser_v2 import (
    is_v2_grid_dir,
    load_v2_1d_profiles,
    load_v2_2d_surface,
)
from ..reporting.model import (
    ReportModel,
    build_report_model,
    to_json_serializable,
)
from .fingerprint import compute_bundle_fingerprint, invalidate_fingerprint_cache
from .schema import (
    BUNDLE_SCHEMA_VERSION,
    PARSER_VERSION,
    SQLITE_INIT_DDL,
    ManifestModel,
)

logger = logging.getLogger(__name__)


def _sanitize_float(val: Any) -> Optional[float]:
    if val is None:
        return None
    try:
        f = float(val)
        return None if (math.isnan(f) or math.isinf(f)) else f
    except (ValueError, TypeError):
        return None


@contextmanager
def _run_dir_lock(r_dir: Path) -> Iterator[None]:
    """Exclusive, cross-process lock on one run directory's bundle.

    Several ingests of the same run can be queued at once (Celery workers are separate
    processes), and they share results.tmp/, results.old/ and results.json.tmp; without
    the lock one deletes or promotes the other's temporary files mid-write. The lock is
    taken on the directory itself, so no lock file is added to the run.
    """
    fd = os.open(r_dir, os.O_RDONLY)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)  # closing releases the lock


def ingest_results(
    run_dir: Union[str, Path],
    analysis_uuid: str = "",
    chemex_version: Optional[str] = None,
    analysis_name: Optional[str] = None,
    analysis_type: str = "CEST",
    *,
    skip_if_current: bool = False,
) -> Dict[str, Any]:
    """
    Parse the ChemEx output tree and derive the complete results bundle atomically.
    Raises on failure, leaving raw files and any existing bundle intact. Concurrent
    ingests of the same run directory are serialized; with ``skip_if_current`` an
    ingest that finds an up-to-date bundle once it holds the lock reuses it.
    """
    r_dir = Path(run_dir).resolve()
    if not r_dir.exists():
        raise FileNotFoundError(f"Run directory does not exist: {r_dir}")
    with _run_dir_lock(r_dir):
        if skip_if_current:
            current = _current_bundle_meta(r_dir)
            if current is not None:
                return current
        return _ingest_results_locked(r_dir, analysis_uuid, chemex_version, analysis_name, analysis_type)


def _current_bundle_meta(r_dir: Path) -> Optional[Dict[str, Any]]:
    """Result metadata of an existing, up-to-date bundle (None when it must be rebuilt)."""
    from .store import is_bundle_valid

    invalidate_fingerprint_cache(r_dir)
    if not is_bundle_valid(r_dir):
        return None
    try:
        manifest = json.loads((r_dir / "results" / "manifest.json").read_text(encoding="utf-8"))
        summary = json.loads((r_dir / "results" / "summary.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    g = summary.get("global") or {}
    return {
        "status": "complete",
        "fingerprint": manifest.get("fingerprint"),
        "summary_redchi": g.get("redchi") or g.get("chi2_red"),
        "summary_n_residues": len(summary.get("residues") or {}),
        "reused": True,
    }


def _ingest_results_locked(
    r_dir: Path,
    analysis_uuid: str,
    chemex_version: Optional[str],
    analysis_name: Optional[str],
    analysis_type: str,
) -> Dict[str, Any]:
    tmp_dir = r_dir / "results.tmp"
    final_dir = r_dir / "results"

    if tmp_dir.exists():
        shutil.rmtree(tmp_dir, ignore_errors=True)

    tmp_dir.mkdir(parents=True, exist_ok=True)
    (tmp_dir / "artifacts").mkdir(parents=True, exist_ok=True)

    db_path = tmp_dir / "results.sqlite"

    try:
        # 1. Parse tree using Phase 5 parser
        target_dir = r_dir / "Output" if (r_dir / "Output").is_dir() else r_dir
        run_res = parse_output_tree(target_dir)

        primary_step = run_res.primary_step
        if primary_step is None and run_res.step_order:
            primary_step = run_res.steps.get(run_res.step_order[-1])

        # 2. Build summary dict matching cest_tasks._parse_chemex_output
        global_dict: dict[str, Any] = {}
        residues_dict: dict[str, Any] = {}

        if primary_step is not None:
            for g_key, g_val in primary_step.globals.items():
                k_lower = g_key.lower()
                global_dict[k_lower] = _sanitize_float(g_val.value)
                global_dict[g_key] = _sanitize_float(g_val.value)
                if g_val.has_stderr and g_val.stderr is not None:
                    global_dict[f"{k_lower}_err"] = _sanitize_float(g_val.stderr)
                    global_dict[f"{g_key}_err"] = _sanitize_float(g_val.stderr)

            if primary_step.statistics is not None:
                st = primary_step.statistics
                global_dict["chisqr"] = _sanitize_float(st.chisqr)
                global_dict["chi2"] = _sanitize_float(st.chisqr)
                global_dict["redchi"] = _sanitize_float(st.redchi)
                global_dict["chi2_red"] = _sanitize_float(st.redchi)
                global_dict["ndata"] = st.ndata
                global_dict["nvarys"] = st.nvarys
                global_dict["pvalue"] = _sanitize_float(st.pvalue)
                global_dict["ks_pvalue"] = _sanitize_float(st.ks_pvalue)
                global_dict["aic"] = _sanitize_float(st.aic)
                global_dict["bic"] = _sanitize_float(st.bic)

            for res_key, res_model in primary_step.residues.items():
                params: dict[str, Any] = {}
                for p_sec, p_val in res_model.parameters.items():
                    sec_name = p_sec.lower().strip().strip('"')
                    params[sec_name] = _sanitize_float(p_val.value)
                    if p_val.has_stderr and p_val.stderr is not None:
                        params[f"{sec_name}_err"] = _sanitize_float(p_val.stderr)

                if res_model.cs_a is not None:
                    params["cs_a"] = _sanitize_float(res_model.cs_a.value)
                    if res_model.cs_a.has_stderr and res_model.cs_a.stderr is not None:
                        params["cs_a_err"] = _sanitize_float(res_model.cs_a.stderr)
                if res_model.cs_b is not None:
                    params["cs_b"] = _sanitize_float(res_model.cs_b.value)
                    if res_model.cs_b.has_stderr and res_model.cs_b.stderr is not None:
                        params["cs_b_err"] = _sanitize_float(res_model.cs_b.stderr)
                if res_model.dw_ab is not None:
                    params["dw_ab"] = _sanitize_float(res_model.dw_ab.value)
                    params["dw"] = _sanitize_float(res_model.dw_ab.value)
                    if res_model.dw_ab.has_stderr and res_model.dw_ab.stderr is not None:
                        params["dw_ab_err"] = _sanitize_float(res_model.dw_ab.stderr)
                if res_model.r1_a is not None:
                    params["r1_a"] = _sanitize_float(res_model.r1_a.value)
                    if res_model.r1_a.has_stderr and res_model.r1_a.stderr is not None:
                        params["r1_a_err"] = _sanitize_float(res_model.r1_a.stderr)
                if res_model.r2_a is not None:
                    params["r2_a"] = _sanitize_float(res_model.r2_a.value)
                    if res_model.r2_a.has_stderr and res_model.r2_a.stderr is not None:
                        params["r2_a_err"] = _sanitize_float(res_model.r2_a.stderr)
                if res_model.r2_b is not None:
                    params["r2_b"] = _sanitize_float(res_model.r2_b.value)
                    if res_model.r2_b.has_stderr and res_model.r2_b.stderr is not None:
                        params["r2_b_err"] = _sanitize_float(res_model.r2_b.stderr)
                if res_model.kex_ab is not None:
                    params["kex_ab"] = _sanitize_float(res_model.kex_ab.value)
                    if res_model.kex_ab.has_stderr and res_model.kex_ab.stderr is not None:
                        params["kex_ab_err"] = _sanitize_float(res_model.kex_ab.stderr)
                if res_model.pb is not None:
                    params["pb"] = _sanitize_float(res_model.pb.value)
                    if res_model.pb.has_stderr and res_model.pb.stderr is not None:
                        params["pb_err"] = _sanitize_float(res_model.pb.stderr)
                if res_model.kab is not None:
                    params["kab"] = _sanitize_float(res_model.kab.value)
                    if res_model.kab.has_stderr and res_model.kab.stderr is not None:
                        params["kab_err"] = _sanitize_float(res_model.kab.stderr)
                if res_model.kba is not None:
                    params["kba"] = _sanitize_float(res_model.kba.value)
                    if res_model.kba.has_stderr and res_model.kba.stderr is not None:
                        params["kba_err"] = _sanitize_float(res_model.kba.stderr)
                if res_model.tau_b is not None:
                    params["tau_b"] = _sanitize_float(res_model.tau_b.value)
                    if res_model.tau_b.has_stderr and res_model.tau_b.stderr is not None:
                        params["tau_b_err"] = _sanitize_float(res_model.tau_b.stderr)

                params["chi2"] = _sanitize_float(res_model.chi2) if res_model.chi2 is not None else global_dict.get("chi2")
                params["chi2_red"] = _sanitize_float(res_model.chi2_red) if res_model.chi2_red is not None else global_dict.get("chi2_red")

                residues_dict[res_key] = {
                    "parameters": params,
                    "experiments": res_model.experiments,
                    "chi2": _sanitize_float(res_model.chi2),
                    "chi2_red": _sanitize_float(res_model.chi2_red),
                    "ndata": res_model.ndata,
                    "nvarys": res_model.nvarys,
                }

        output_files: list[str] = []
        if r_dir.exists():
            for root_w, _, files_w in os.walk(r_dir):
                for fw in files_w:
                    output_files.append(os.path.relpath(os.path.join(root_w, fw), r_dir).replace("\\", "/"))

        full_results = {
            "analysis_uuid": analysis_uuid or r_dir.name,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "fit_mode": "global",
            "global": global_dict,
            "residues": residues_dict,
            "steps": {sname: s.model_dump(mode="json") for sname, s in run_res.steps.items()},
            "step_order": run_res.step_order,
            "is_multi_step": run_res.is_multi_step,
            "primary_step": primary_step.name if primary_step else "",
            "state": run_res.state.value if hasattr(run_res.state, "value") else str(run_res.state),
            "is_provisional": run_res.is_provisional,
            "can_continue_fit": run_res.can_continue_fit,
            "continue_explanation": run_res.continue_explanation,
            "restart_file_path": run_res.restart_file_path,
            "provenance": run_res.provenance.model_dump(mode="json") if run_res.provenance else None,
            "outcome": run_res.outcome.model_dump(mode="json") if run_res.outcome else None,
            "warnings": [w.model_dump(mode="json") for w in run_res.warnings],
            "output_files": output_files,
        }

        # 3. Write summary.json
        summary_path = tmp_dir / "summary.json"
        summary_path.write_text(json.dumps(to_json_serializable(full_results), indent=2), encoding="utf-8")

        # 3b. Methods-page run overview + GRID surfaces (cached so page visits never re-parse)
        try:
            from .run_overview import build_run_overview

            overview, surfaces = build_run_overview(Path(target_dir), run_res)
            (tmp_dir / "run_overview.json").write_text(json.dumps(to_json_serializable(overview)), encoding="utf-8")
            (tmp_dir / "grid_surfaces.json").write_text(json.dumps(to_json_serializable(surfaces)), encoding="utf-8")
        except Exception as ov_exc:
            logger.warning("Failed building run overview during ingest: %s", ov_exc)

        # 4. Populate results.sqlite
        conn = sqlite3.connect(str(db_path))
        try:
            conn.executescript(SQLITE_INIT_DDL)
            cur = conn.cursor()

            # Insert parameters
            for sname, sres in run_res.steps.items():
                step_key = sname or "primary"
                if sres.parameters:
                    # Fitted
                    for sec_name, sec_dict in sres.parameters.fitted.items():
                        for p_key, p_val in sec_dict.items():
                            param_id = f"{sec_name}/{p_key}"
                            res = p_key if p_key.endswith("N") or p_key.isdigit() else ""
                            cur.execute(
                                "INSERT OR REPLACE INTO parameters VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                                (
                                    step_key,
                                    param_id,
                                    sec_name,
                                    res,
                                    "",
                                    _sanitize_float(p_val.value),
                                    _sanitize_float(p_val.stderr),
                                    "stderr",
                                    1,
                                    None,
                                    _sanitize_float(getattr(p_val, "min_val", None)),
                                    _sanitize_float(getattr(p_val, "max_val", None)),
                                ),
                            )
                    # Fixed
                    for sec_name, sec_dict in sres.parameters.fixed.items():
                        for p_key, p_val in sec_dict.items():
                            param_id = f"{sec_name}/{p_key}"
                            res = p_key if p_key.endswith("N") or p_key.isdigit() else ""
                            cur.execute(
                                "INSERT OR REPLACE INTO parameters VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                                (
                                    step_key,
                                    param_id,
                                    sec_name,
                                    res,
                                    "",
                                    _sanitize_float(p_val.value),
                                    None,
                                    "none",
                                    0,
                                    None,
                                    _sanitize_float(getattr(p_val, "min_val", None)),
                                    _sanitize_float(getattr(p_val, "max_val", None)),
                                ),
                            )
                    # Constrained
                    for sec_name, sec_dict in sres.parameters.constrained.items():
                        for p_key, p_val in sec_dict.items():
                            param_id = f"{sec_name}/{p_key}"
                            res = p_key if p_key.endswith("N") or p_key.isdigit() else ""
                            cur.execute(
                                "INSERT OR REPLACE INTO parameters VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                                (
                                    step_key,
                                    param_id,
                                    sec_name,
                                    res,
                                    "",
                                    _sanitize_float(p_val.value),
                                    None,
                                    "none",
                                    0,
                                    p_val.expression,
                                    _sanitize_float(getattr(p_val, "min_val", None)),
                                    _sanitize_float(getattr(p_val, "max_val", None)),
                                ),
                            )

                # Insert profiles & residuals
                for exp_stem, df_model in sres.data.items():
                    for res_name, prof_model in df_model.profiles.items():
                        for pt in prof_model.points:
                            x_val = 0.0
                            if pt.metadata:
                                for x_candidate in ("offset", "ncyc", "time", "delay", "t_relax"):
                                    if x_candidate in pt.metadata:
                                        x_val = float(pt.metadata[x_candidate])
                                        break
                                else:
                                    # Fallback to first scalar value in metadata
                                    for v in pt.metadata.values():
                                        if isinstance(v, (int, float)):
                                            x_val = float(v)
                                            break
                            y_o = _sanitize_float(pt.exp)
                            y_e = _sanitize_float(pt.err)
                            y_c = _sanitize_float(pt.calc)
                            excl = 0 if pt.mask else 1

                            cur.execute(
                                "INSERT INTO profiles VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                                (step_key, exp_stem, res_name, x_val, y_o, y_e, y_c, excl),
                            )

                            if y_o is not None and y_c is not None:
                                res_val = y_o - y_c
                                w_res_val = res_val / y_e if (y_e and y_e != 0.0) else res_val
                                cur.execute(
                                    "INSERT INTO residuals VALUES (?, ?, ?, ?, ?, ?)",
                                    (step_key, exp_stem, res_name, x_val, res_val, w_res_val),
                                )

                # Insert stat_summary & stat_correlations
                if sres.statistical_analyses:
                    stat_coll = sres.statistical_analyses
                    method_map = {
                        "MonteCarlo": stat_coll.monte_carlo,
                        "Bootstrap": stat_coll.bootstrap,
                        "BootstrapNS": stat_coll.bootstrap_ns,
                        "MCMC": stat_coll.mcmc,
                    }
                    for m_name, m_model in method_map.items():
                        if not m_model:
                            continue
                        for p_name, p_sum in m_model.summary.items():
                            center = _sanitize_float(getattr(p_sum, "mean", None) or getattr(p_sum, "median", None) or getattr(p_sum, "deterministic_value", None))
                            lower_68 = _sanitize_float(getattr(p_sum, "percentile_68_lower", None) or getattr(p_sum, "lower_1sigma", None))
                            upper_68 = _sanitize_float(getattr(p_sum, "percentile_68_upper", None) or getattr(p_sum, "upper_1sigma", None))
                            half_w_68 = _sanitize_float(getattr(p_sum, "half_percentile_68_width", None) or getattr(p_sum, "stderr", None))
                            mcse = _sanitize_float(getattr(p_sum, "sem", None))
                            cur.execute(
                                "INSERT OR REPLACE INTO stat_summary VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                                (step_key, m_name, p_name, center, lower_68, upper_68, half_w_68, mcse, "ok"),
                            )

                        if isinstance(m_model.correlations, dict):
                            for pa, inner in m_model.correlations.items():
                                if isinstance(inner, dict):
                                    for pb, r_val in inner.items():
                                        cur.execute(
                                            "INSERT OR REPLACE INTO stat_correlations VALUES (?, ?, ?, ?, ?)",
                                            (step_key, m_name, pa, pb, _sanitize_float(r_val) or 0.0),
                                        )

                # Insert grid_1d
                grid_d = locate.grid_dir(Path(target_dir), sname)
                if grid_d and grid_d.is_dir():
                    try:
                        if is_v2_grid_dir(grid_d):
                            v2_1d = load_v2_1d_profiles(grid_d)
                            for prof in v2_1d:
                                p_id = prof.get("parameter", "")
                                # Loader returns parallel arrays, not point dicts.
                                for xv, cv, dv in zip(
                                    prof.get("x", []),
                                    prof.get("chisqr", []),
                                    prof.get("delta_chisqr", []),
                                ):
                                    cur.execute(
                                        "INSERT INTO grid_1d VALUES (?, ?, ?, ?, ?)",
                                        (step_key, p_id, float(xv), float(cv), float(dv)),
                                    )
                    except Exception as g_exc:
                        logger.warning("Could not ingest grid_1d for step %s: %s", sname, g_exc)

            conn.commit()
        finally:
            conn.close()

        # 5. Build report_model.json
        try:
            report_model = build_report_model(
                analysis_dir=r_dir,
                analysis_name=analysis_name or analysis_uuid or r_dir.name,
                analysis_type=analysis_type,
            )
            report_model_dict = report_model.to_dict()
            (tmp_dir / "report_model.json").write_text(
                json.dumps(to_json_serializable(report_model_dict), indent=2),
                encoding="utf-8",
            )
        except Exception as r_exc:
            logger.warning("Failed building report_model during ingest: %s", r_exc)
            # Create minimal report_model.json
            minimal_model = {
                "analysis_name": analysis_name or r_dir.name,
                "analysis_type": analysis_type,
                "analysis_dir": r_dir.name,
                "results": to_json_serializable(full_results),
                "provenance": {},
                "derived_kinetics": {},
                "residues": [],
                "global_params": [],
                "resampled": {},
                "grid_1d": {},
                "ledger": {},
            }
            (tmp_dir / "report_model.json").write_text(
                json.dumps(minimal_model, indent=2),
                encoding="utf-8",
            )

        # 6. Compute fingerprint and write manifest.json
        # Invalidate cache first so newly written ChemEx files are indexed
        invalidate_fingerprint_cache(r_dir)
        fingerprint = compute_bundle_fingerprint(r_dir, use_cache=False)

        manifest = ManifestModel(
            bundle_schema=BUNDLE_SCHEMA_VERSION,
            parser_version=PARSER_VERSION,
            chemex_version=chemex_version,
            fingerprint=fingerprint,
            created_at=datetime.now(timezone.utc).isoformat(),
            status="complete",
            artifacts={},
        )
        (tmp_dir / "manifest.json").write_text(
            json.dumps(manifest.model_dump(), indent=2),
            encoding="utf-8",
        )

        # 7. Atomic promote results.tmp -> results
        old_dir = r_dir / "results.old"
        if old_dir.exists():
            shutil.rmtree(old_dir, ignore_errors=True)
        if final_dir.exists():
            os.replace(str(final_dir), str(old_dir))
        try:
            os.replace(str(tmp_dir), str(final_dir))
            if old_dir.exists():
                shutil.rmtree(old_dir, ignore_errors=True)
        except Exception:
            if old_dir.exists() and not final_dir.exists():
                os.replace(str(old_dir), str(final_dir))
            raise

        # 8. Write compatibility results.json into run_dir
        compat_results_path = r_dir / "results.json"
        tmp_compat = r_dir / "results.json.tmp"
        tmp_compat.write_text(
            json.dumps(to_json_serializable(full_results), indent=2),
            encoding="utf-8",
        )
        os.replace(str(tmp_compat), str(compat_results_path))

        logger.info("Successfully ingested results bundle for %s", r_dir)

        redchi = global_dict.get("redchi") or global_dict.get("chi2_red")
        n_residues = len(residues_dict)

        return {
            "status": "complete",
            "fingerprint": fingerprint,
            "summary_redchi": redchi,
            "summary_n_residues": n_residues,
        }

    except Exception:
        if tmp_dir.exists():
            shutil.rmtree(tmp_dir, ignore_errors=True)
        if (r_dir / "results.json.tmp").exists():
            try:
                (r_dir / "results.json.tmp").unlink(missing_ok=True)
            except OSError:
                pass
        raise
