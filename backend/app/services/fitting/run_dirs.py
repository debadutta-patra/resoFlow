"""Locate the on-disk run directory and saved config of any ChemEx analysis.

CEST, CPMG and EXCHANGE analyses all run ChemEx and expose the same Parameters/Methods
model, but historically live in different folders with different config filenames.
Callers that work across experiment types (parameter inheritance, compatibility
checks, reporting) resolve paths here instead of hard-coding ``cest_fitting``.
"""

from __future__ import annotations

import json
import os
from typing import Optional

from ..path_utils import to_container_path
from .config_normalizer import normalize_chemex_config

CHEMEX_ANALYSIS_TYPES = frozenset({"CEST", "15N-CEST", "CPMG", "EXCHANGE"})

_SUBDIR_BY_TYPE = {
    "CEST": "cest_fitting",
    "15N-CEST": "cest_fitting",
    "CPMG": "cpmg_fitting",
    "EXCHANGE": "exchange_fitting",
}

_CONFIG_FILENAMES_BY_TYPE = {
    "CPMG": ("cpmg_config.json", "config.json"),
    "EXCHANGE": ("config.json", "exchange_config.json"),
}


def is_chemex_analysis_type(analysis_type: Optional[str]) -> bool:
    return (analysis_type or "").upper() in CHEMEX_ANALYSIS_TYPES


def chemex_run_dir(analysis) -> str:
    """Return the run directory for a CEST / CPMG / EXCHANGE analysis (not created)."""
    a_type = (analysis.analysis_type or "CEST").upper()
    subdir = _SUBDIR_BY_TYPE.get(a_type, "cest_fitting")
    project_dir = analysis.project.local_directory_path
    if a_type == "EXCHANGE":
        # Mirrors routers/exchange._get_exchange_run_dir
        project_dir = to_container_path(project_dir) or project_dir
    return os.path.join(project_dir, subdir, analysis.analysis_uuid)


def chemex_config_path(analysis) -> str:
    """Return the path of the saved config file (first existing candidate, else default)."""
    run_dir = chemex_run_dir(analysis)
    names = _CONFIG_FILENAMES_BY_TYPE.get((analysis.analysis_type or "").upper(), ("config.json",))
    for name in names:
        candidate = os.path.join(run_dir, name)
        if os.path.exists(candidate):
            return candidate
    return os.path.join(run_dir, names[0])


def load_chemex_config(analysis) -> dict:
    """Load and normalize the saved config of an analysis; ``{}`` if missing/unreadable."""
    path = chemex_config_path(analysis)
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r") as f:
            return normalize_chemex_config(json.load(f))
    except Exception:
        return {}
