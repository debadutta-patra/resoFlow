"""Per-step run overview for the Methods page, built once at ingest and cached in the bundle.

``results/run_overview.json`` (small, served by GET …/chemex/run-overview):
  * method snapshot (the method.toml the run used) and per-step status / χ² / ndata / nvarys
  * committed values ± errors per parameter name, as concrete copies (global or per residue)
  * GRID: per axis the actual grid values, scale (from the method snapshot), committed minimum
    and its edge position; available 2D pairs and 1D profiles
  * MCMC: τ_max, ESS, tentative-burn / withheld-summary flags
  * strong correlations (|ρ| ≥ 0.5) from covariance evidence and MCMC/MC/BS/BSN

``results/grid_surfaces.json``: every GRID step's 2D χ² surfaces, keyed "STEP|X|Y".

Nothing here re-reads ChemEx output on a page visit; ingest rebuilds both files whenever the
run directory changes (bundle fingerprint).
"""

from __future__ import annotations

import json
import logging
import math
import tomllib
from pathlib import Path
from typing import Any, Optional

from ..fitting.chemex_output import locate
from ..fitting.chemex_output.grid_parser_v2 import (
    is_v2_grid_dir,
    list_v2_2d_pairs,
    load_v2_1d_profiles,
    load_v2_2d_surface,
    parse_v2_grid_summary,
)

logger = logging.getLogger(__name__)

OVERVIEW_SCHEMA = 1
CORRELATION_FLOOR = 0.5


def _f(v: Any) -> Optional[float]:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def _clean(name: str) -> str:
    s = str(name).strip()
    if s.startswith("[") and s.endswith("]"):
        s = s[1:-1]
    return s.split(",")[0].strip().strip("_").upper()


def read_method_snapshot(output_dir: Path) -> Optional[str]:
    methods = output_dir / "run_info" / "inputs" / "methods"
    files = sorted(methods.glob("*.toml")) if methods.is_dir() else []
    return "\n".join(f.read_text(encoding="utf-8") for f in files) if files else None


def _method_axes(method_toml: Optional[str]) -> dict[str, dict[str, dict[str, Any]]]:
    """Step name (upper) → axis param (upper) → {fn, qualifier, low, high, count} from the snapshot."""
    if not method_toml:
        return {}
    try:
        from ..fitting.method_emitter import parse_method_toml, step_display_name

        cfg = parse_method_toml(method_toml)
    except Exception as exc:  # the overview must never fail on an odd method file
        logger.warning("run overview: cannot parse method snapshot: %s", exc)
        return {}
    out: dict[str, dict[str, dict[str, Any]]] = {}
    for i, step in enumerate(cfg.steps):
        search = step.search
        if not search or search.mode == "none":
            continue
        axes: dict[str, dict[str, Any]] = {}
        for a in search.axes:
            axes.setdefault(
                a.param.upper(),
                {"fn": a.fn, "qualifier": a.qualifier or "", "low": a.low, "high": a.high, "count": a.count, "mode": search.mode},
            )
        out[step_display_name(step, i).upper()] = axes
    return out


def _values(step: Any) -> dict[str, dict[str, Any]]:
    """Committed values per parameter name: role and concrete copies (value ± stderr)."""
    out: dict[str, dict[str, Any]] = {}
    params = getattr(step, "parameters", None)
    if params is None:
        return out
    for role, sections in (("fit", params.fitted), ("fix", params.fixed), ("constrained", params.constrained)):
        for section, entries in (sections or {}).items():
            qualifier = section.split(",", 1)[1].strip() if "," in section else ""
            for key, val in entries.items():
                if section.strip().upper() == "GLOBAL":
                    name, residue = key.strip().upper(), ""
                else:
                    name, residue = section.split(",")[0].strip().upper(), key.strip()
                entry = out.setdefault(name, {"scope": "residue" if residue else "global", "roles": [], "copies": []})
                if role not in entry["roles"]:
                    entry["roles"].append(role)
                entry["copies"].append(
                    {
                        "residue": residue,
                        "qualifier": qualifier,
                        "role": role,
                        "value": _f(val.value),
                        "stderr": _f(val.stderr) if getattr(val, "has_stderr", False) else None,
                    }
                )
    return out


def edge_position(value: Optional[float], grid_values: list[float]) -> Optional[str]:
    """'low' / 'high' when the committed minimum sits on the first / last grid value, else None."""
    if value is None or len(grid_values) < 2:
        return None
    lo, hi = min(grid_values), max(grid_values)
    tol = 1e-9 * max(abs(lo), abs(hi), 1.0)
    if abs(value - lo) <= tol:
        return "low"
    if abs(value - hi) <= tol:
        return "high"
    return None


def _grid(step_name: str, output_dir: Path, method_axes: dict[str, dict[str, Any]]) -> tuple[Optional[dict[str, Any]], dict[str, Any]]:
    grid_dir = locate.grid_dir(output_dir, step_name)
    if not grid_dir or not is_v2_grid_dir(grid_dir):
        return None, {}
    summary = parse_v2_grid_summary(grid_dir)
    selected = {_clean(a.get("name") or a.get("parameter_id") or ""): _f(a.get("value")) for a in summary.get("selected_axes", [])}
    profiles = load_v2_1d_profiles(grid_dir)
    axes: list[dict[str, Any]] = []
    profiles_1d: dict[str, dict[str, list]] = {}
    for prof in profiles:
        name = _clean(prof.get("parameter", ""))
        xs = [float(x) for x in prof.get("x", [])]
        values = sorted(set(xs))
        best = selected.get(name, _f(prof.get("selected_val")) if prof.get("selected_val") is not None else _f(prof.get("min_x")))
        snap = method_axes.get(name, {})
        axes.append(
            {
                "param": name,
                "fn": snap.get("fn") or "lin",
                "qualifier": snap.get("qualifier", ""),
                "values": values,
                "low": values[0] if values else None,
                "high": values[-1] if values else None,
                "count": len(values),
                "best": best,
                "edge": edge_position(best, values),
            }
        )
        profiles_1d[name] = {"x": xs, "chisqr": [float(c) for c in prof.get("chisqr", [])]}
    surfaces: dict[str, Any] = {}
    pairs: list[list[str]] = []
    for p1, p2, _ in list_v2_2d_pairs(grid_dir):
        try:
            surf = load_v2_2d_surface(grid_dir, x_param=p1, y_param=p2)
        except Exception as exc:
            logger.warning("run overview: 2D surface %s/%s for %s: %s", p1, p2, step_name, exc)
            continue
        x, y = _clean(surf.get("x_param", p1)), _clean(surf.get("y_param", p2))
        pairs.append([x, y])
        mp = surf.get("min_point") or {}
        surfaces[f"{step_name}|{x}|{y}"] = {
            "x_param": x,
            "y_param": y,
            "x": [float(v) for v in surf.get("x", [])],
            "y": [float(v) for v in surf.get("y", [])],
            "z_chisqr": [[_f(v) for v in row] for row in surf.get("z_chisqr", [])],
            "z_delta": [[_f(v) for v in row] for row in surf.get("z_delta", [])],
            "min_point": {"x": _f(mp.get("x")), "y": _f(mp.get("y")), "chisqr": _f(mp.get("chisqr"))},
        }
    return (
        {
            "status": summary.get("status"),
            "chisqr": _f(summary.get("selected_chi_square")),
            "axes": axes,
            "best": {a["param"]: a["best"] for a in axes},
            "pairs": pairs,
            "profiles_1d": profiles_1d,
        },
        surfaces,
    )


def _mcmc_dir(output_dir: Path, step_name: str) -> Optional[Path]:
    for base in ([output_dir / step_name] if step_name else []) + [output_dir]:
        d = base / "Statistics" / "MCMC"
        if (d / "diagnostics.toml").is_file():
            return d
    return None


def _mcmc(step: Any, output_dir: Path, step_name: str) -> Optional[dict[str, Any]]:
    d = _mcmc_dir(output_dir, step_name)
    if d is None:
        return None
    try:
        diag = tomllib.loads((d / "diagnostics.toml").read_text(encoding="utf-8"))
    except Exception:
        return None
    tau = _f(diag.get("max_autocorrelation_time"))
    tentative_tau = _f(diag.get("max_autocorrelation_time_tentative"))
    status = str(diag.get("autocorrelation_status") or "")
    tentative = tau is None and tentative_tau is not None or "unreliable" in status or "tentative" in str(diag.get("burn_in_warning") or "")
    ess_values: list[float] = []
    try:
        summary = tomllib.loads((d / "summary.toml").read_text(encoding="utf-8")) if (d / "summary.toml").is_file() else {}
        for entry in summary.values():
            if isinstance(entry, dict):
                ess = _f(entry.get("effective_sample_size"))
                if ess is not None:
                    ess_values.append(ess)
    except Exception:
        summary = {}
    ess_withheld = bool(diag.get("effective_sample_size_warning")) and not ess_values
    posterior_withheld = not (d / "summary.toml").is_file() or str(diag.get("status", "complete")) != "complete"
    return {
        "status": diag.get("status", "complete"),
        "tau_max": tau if tau is not None else tentative_tau,
        "tau_tentative": tau is None and tentative_tau is not None,
        "tentative_burn": bool(tentative),
        "ess_min": min(ess_values) if ess_values else None,
        "ess_withheld": ess_withheld,
        "posterior_withheld": posterior_withheld,
        "steps": diag.get("steps"),
        "discarded_steps": diag.get("discarded_steps"),
        "recommended_min_steps": diag.get("recommended_min_steps_50tau"),
        "warnings": [str(diag[k]) for k in ("burn_in_warning", "autocorrelation_warning", "effective_sample_size_warning") if diag.get(k)],
        "seconds": _f(diag.get("total_seconds")),
    }


def _hex_or_float(v: Any) -> Optional[float]:
    if isinstance(v, dict) and "binary64" in v:
        try:
            return float.fromhex(v["binary64"])
        except (TypeError, ValueError):
            return None
    return _f(v)


def _covariance_correlations(output_dir: Path, step_name: str) -> list[dict[str, Any]]:
    path = (output_dir / step_name if step_name else output_dir) / "Statistics" / "Covariance" / "evidence.json"
    if not path.is_file():
        return []
    try:
        corr = json.loads(path.read_text(encoding="utf-8")).get("correlations") or {}
    except Exception:
        return []
    ids = corr.get("output_ids") or []
    out: list[dict[str, Any]] = []
    for i, row in enumerate(corr.get("entries") or []):
        for j in range(i + 1, min(len(row), len(ids))):
            cell = row[j] or {}
            if cell.get("outcome") != "AVAILABLE":
                continue
            rho = _hex_or_float(cell.get("value"))
            if rho is not None and abs(rho) >= CORRELATION_FLOOR:
                out.append({"a": ids[i], "b": ids[j], "rho": rho, "method": "Covariance"})
    return out


def _sampled_correlations(step: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    coll = getattr(step, "statistical_analyses", None)
    if coll is None:
        return out
    for method, model in (("MCMC", coll.mcmc), ("MonteCarlo", coll.monte_carlo), ("Bootstrap", coll.bootstrap), ("BootstrapNS", coll.bootstrap_ns)):
        if not model or not isinstance(model.correlations, dict):
            continue
        seen: set[tuple[str, str]] = set()
        for a, inner in model.correlations.items():
            if not isinstance(inner, dict):
                continue
            for b, r in inner.items():
                rho = _f(r)
                key = tuple(sorted((a, b)))
                if a == b or rho is None or key in seen or abs(rho) < CORRELATION_FLOOR:
                    continue
                seen.add(key)  # type: ignore[arg-type]
                out.append({"a": a, "b": b, "rho": rho, "method": method})
    return out


def build_run_overview(output_dir: Path, run_res: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return (overview, grid_surfaces) for a parsed run."""
    method_toml = read_method_snapshot(output_dir)
    axes_by_step = _method_axes(method_toml)
    steps: list[dict[str, Any]] = []
    surfaces: dict[str, Any] = {}
    for name in run_res.step_order or list(run_res.steps):
        step = run_res.steps.get(name)
        if step is None:
            continue
        stats = step.statistics
        grid, surf = _grid(name, output_dir, axes_by_step.get((name or "").upper(), {}))
        surfaces.update(surf)
        steps.append(
            {
                "name": name,
                "status": step.status,
                "redchi": _f(stats.redchi) if stats else None,
                "chisqr": _f(stats.chisqr) if stats else None,
                "ndata": stats.ndata if stats else None,
                "nvarys": stats.nvarys if stats else None,
                "values": _values(step),
                "residue_redchi": {k: _f(r.chi2_red) for k, r in (step.residues or {}).items()},
                "grid": grid,
                "mcmc": _mcmc(step, output_dir, name),
                "correlations": _covariance_correlations(output_dir, name) + _sampled_correlations(step),
            }
        )
    overview = {
        "schema": OVERVIEW_SCHEMA,
        "state": run_res.state.value if hasattr(run_res.state, "value") else str(run_res.state),
        "method_toml": method_toml,
        "step_order": list(run_res.step_order or []),
        "steps": steps,
    }
    return overview, surfaces


ACTIVE_STATES = {"RUNNING", "PENDING", "CANCELLING"}


def ensure_bundle(run_dir: Path, analysis: Any) -> bool:
    """True when a current results bundle exists for a completed run, building it once if needed.

    Page visits read the bundle only; this ingests (parses ChemEx output) only when the bundle is
    missing or stale — the same path the results endpoints use after a run completes.
    """
    from . import is_bundle_valid
    from .ingest import ingest_results

    if (getattr(analysis, "status", "") or "").upper() in ACTIVE_STATES:
        return False
    if is_bundle_valid(run_dir):
        return True
    if (getattr(analysis, "status", "") or "").upper() not in {"COMPLETED", "COMPLETED_WITH_ERRORS"}:
        return False
    if not (run_dir / "Output").is_dir():
        return False
    try:
        ingest_results(
            run_dir,
            analysis_uuid=analysis.analysis_uuid,
            chemex_version=getattr(analysis, "chemex_version", None),
            analysis_name=analysis.name,
            analysis_type=analysis.analysis_type or "CEST",
        )
    except Exception as exc:
        logger.warning("run overview: ingest failed for %s: %s", run_dir, exc)
        return False
    return is_bundle_valid(run_dir)
