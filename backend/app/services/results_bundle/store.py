"""Results Bundle Store Read API (§3.11).

Provides high-performance query access to summary.json, results.sqlite, and
report_model.json. Validates fingerprint and schema versions with 60s TTL.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

from .fingerprint import compute_bundle_fingerprint
from .schema import BUNDLE_SCHEMA_VERSION, PARSER_VERSION, ManifestModel
from ..reporting.model import ReportModel

logger = logging.getLogger(__name__)


REQUIRED_BUNDLE_FILES = ("summary.json", "results.sqlite", "report_model.json")


def is_bundle_valid(run_dir: Union[str, Path]) -> bool:
    """
    Check if a results bundle exists, matches current parser and schema versions,
    and has a valid fingerprint matching the source files on disk.
    """
    r_dir = Path(run_dir).resolve()
    manifest_path = r_dir / "results" / "manifest.json"
    if not manifest_path.is_file():
        return False
    # A bundle damaged after promotion (e.g. by an interrupted or concurrent ingest) must be rebuilt.
    if not all((r_dir / "results" / name).is_file() for name in REQUIRED_BUNDLE_FILES):
        return False

    try:
        manifest_data = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest_data.get("bundle_schema") != BUNDLE_SCHEMA_VERSION:
            return False
        if manifest_data.get("parser_version") != PARSER_VERSION:
            return False

        recorded_fp = manifest_data.get("fingerprint")
        if not recorded_fp:
            return False

        current_fp = compute_bundle_fingerprint(r_dir, use_cache=True)
        return recorded_fp == current_fp
    except Exception as exc:
        logger.warning("Error validating bundle for %s: %s", r_dir, exc)
        return False


def get_manifest(run_dir: Union[str, Path]) -> Optional[ManifestModel]:
    """Load and parse the manifest.json for a run directory."""
    r_dir = Path(run_dir).resolve()
    manifest_path = r_dir / "results" / "manifest.json"
    if not manifest_path.is_file():
        return None
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
        return ManifestModel(**data)
    except Exception as exc:
        logger.warning("Failed reading manifest at %s: %s", manifest_path, exc)
        return None


def get_etag(run_dir: Union[str, Path]) -> str:
    """Generate ETag quoted string based on bundle fingerprint."""
    r_dir = Path(run_dir).resolve()
    manifest = get_manifest(r_dir)
    if manifest and manifest.fingerprint:
        return f'"{manifest.fingerprint}"'
    fp = compute_bundle_fingerprint(r_dir, use_cache=True)
    return f'"{fp}"'


def get_summary(run_dir: Union[str, Path]) -> Dict[str, Any]:
    """
    Load the small eager summary payload (< 200 kB).
    Falls back to results.json if summary.json is not yet created.
    """
    r_dir = Path(run_dir).resolve()
    summary_path = r_dir / "results" / "summary.json"
    if summary_path.is_file():
        return json.loads(summary_path.read_text(encoding="utf-8"))

    compat_path = r_dir / "results.json"
    if compat_path.is_file():
        return json.loads(compat_path.read_text(encoding="utf-8"))

    raise FileNotFoundError(f"Neither summary.json nor results.json found in {r_dir}")


def get_run_overview(run_dir: Union[str, Path]) -> Optional[Dict[str, Any]]:
    """Methods-page run overview cached at ingest (None for bundles built before it existed)."""
    path = Path(run_dir).resolve() / "results" / "run_overview.json"
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def get_grid_surface(run_dir: Union[str, Path], step: str, x: str, y: str) -> Optional[Dict[str, Any]]:
    """A cached GRID χ² surface; the pair is matched in either order (axes swapped when needed)."""
    path = Path(run_dir).resolve() / "results" / "grid_surfaces.json"
    if not path.is_file():
        return None
    surfaces = json.loads(path.read_text(encoding="utf-8"))
    xs, ys = x.strip().upper(), y.strip().upper()
    hit = surfaces.get(f"{step}|{xs}|{ys}")
    if hit is not None:
        return hit
    swapped = surfaces.get(f"{step}|{ys}|{xs}")
    if swapped is None:
        return None
    transpose = lambda m: [list(r) for r in zip(*m)] if m else m  # noqa: E731
    mp = swapped.get("min_point") or {}
    return {
        "x_param": swapped["y_param"],
        "y_param": swapped["x_param"],
        "x": swapped["y"],
        "y": swapped["x"],
        "z_chisqr": transpose(swapped.get("z_chisqr")),
        "z_delta": transpose(swapped.get("z_delta")),
        "min_point": {"x": mp.get("y"), "y": mp.get("x"), "chisqr": mp.get("chisqr")},
    }


def get_report_model(run_dir: Union[str, Path]) -> ReportModel:
    """
    Load and deserialize ReportModel from results/report_model.json.
    """
    r_dir = Path(run_dir).resolve()
    model_path = r_dir / "results" / "report_model.json"
    if not model_path.is_file():
        raise FileNotFoundError(f"report_model.json not found in {r_dir / 'results'}")
    raw_data = json.loads(model_path.read_text(encoding="utf-8"))
    return ReportModel.from_dict(raw_data, analysis_dir=r_dir)


def _get_sqlite_conn(run_dir: Union[str, Path]) -> sqlite3.Connection:
    r_dir = Path(run_dir).resolve()
    db_path = r_dir / "results" / "results.sqlite"
    if not db_path.is_file():
        raise FileNotFoundError(f"results.sqlite not found in {r_dir / 'results'}")
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def get_residue(
    run_dir: Union[str, Path],
    residue: str,
    step: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Lazy query for a single residue's parameters, profiles, and residuals.
    """
    conn = _get_sqlite_conn(run_dir)
    res_str = str(residue).strip().upper()
    try:
        cur = conn.cursor()

        # Parameters
        if step:
            cur.execute(
                "SELECT * FROM parameters WHERE step = ? AND (residue = ? OR param_id LIKE ?)",
                (step, res_str, f"%{res_str}%"),
            )
        else:
            cur.execute(
                "SELECT * FROM parameters WHERE residue = ? OR param_id LIKE ?",
                (res_str, f"%{res_str}%"),
            )
        params = [dict(row) for row in cur.fetchall()]

        # Profiles
        if step:
            cur.execute(
                "SELECT * FROM profiles WHERE step = ? AND residue = ?",
                (step, res_str),
            )
        else:
            cur.execute(
                "SELECT * FROM profiles WHERE residue = ?",
                (res_str,),
            )
        profiles = [dict(row) for row in cur.fetchall()]

        # Residuals
        if step:
            cur.execute(
                "SELECT * FROM residuals WHERE step = ? AND residue = ?",
                (step, res_str),
            )
        else:
            cur.execute(
                "SELECT * FROM residuals WHERE residue = ?",
                (res_str,),
            )
        residuals = [dict(row) for row in cur.fetchall()]

        return {
            "residue": res_str,
            "step": step,
            "parameters": params,
            "profiles": profiles,
            "residuals": residuals,
        }
    finally:
        conn.close()


def query_profiles(
    run_dir: Union[str, Path],
    step: Optional[str] = None,
    experiment: Optional[str] = None,
    residue: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Query fitted experimental profile points from results.sqlite."""
    conn = _get_sqlite_conn(run_dir)
    try:
        cur = conn.cursor()
        clauses = []
        params = []
        if step:
            clauses.append("step = ?")
            params.append(step)
        if experiment:
            clauses.append("experiment = ?")
            params.append(experiment)
        if residue:
            clauses.append("residue = ?")
            params.append(str(residue).strip().upper())

        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        cur.execute(f"SELECT * FROM profiles {where}", params)
        return [dict(row) for row in cur.fetchall()]
    finally:
        conn.close()


def query_residuals(
    run_dir: Union[str, Path],
    step: Optional[str] = None,
    experiment: Optional[str] = None,
    residue: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Query residuals from results.sqlite."""
    conn = _get_sqlite_conn(run_dir)
    try:
        cur = conn.cursor()
        clauses = []
        params = []
        if step:
            clauses.append("step = ?")
            params.append(step)
        if experiment:
            clauses.append("experiment = ?")
            params.append(experiment)
        if residue:
            clauses.append("residue = ?")
            params.append(str(residue).strip().upper())

        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        cur.execute(f"SELECT * FROM residuals {where}", params)
        return [dict(row) for row in cur.fetchall()]
    finally:
        conn.close()


def query_statistics_summary(
    run_dir: Union[str, Path],
    step: Optional[str] = None,
    method: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Query statistical summary from results.sqlite."""
    conn = _get_sqlite_conn(run_dir)
    try:
        cur = conn.cursor()
        clauses = []
        params = []
        if step:
            clauses.append("step = ?")
            params.append(step)
        if method:
            clauses.append("method = ?")
            params.append(method)

        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        cur.execute(f"SELECT * FROM stat_summary {where}", params)
        return [dict(row) for row in cur.fetchall()]
    finally:
        conn.close()


def query_grid_1d(
    run_dir: Union[str, Path],
    step: Optional[str] = None,
    param_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Query grid 1D profile data points from results.sqlite."""
    conn = _get_sqlite_conn(run_dir)
    try:
        cur = conn.cursor()
        clauses = []
        params = []
        if step:
            clauses.append("step = ?")
            params.append(step)
        if param_id:
            clauses.append("param_id = ?")
            params.append(param_id)

        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        cur.execute(f"SELECT * FROM grid_1d {where}", params)
        return [dict(row) for row in cur.fetchall()]
    finally:
        conn.close()
