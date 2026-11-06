"""
Goodness-of-Fit Statistics Parser (§1.8).
Maps human-readable quoted keys in statistics.toml to stable normalized fields while retaining unknown keys.
"""

from __future__ import annotations

import tomllib
from pathlib import Path
from typing import Any, Optional

from .models import (
    GoodnessOfFitModel,
    StructuredWarning,
)

KEY_MAPPING = {
    "number of data points": "ndata",
    "number of variables": "nvarys",
    "chi-square": "chisqr",
    "reduced-chi-square": "redchi",
    "chi-squared test": "pvalue",
    "kolmogorov-smirnov test": "ks_pvalue",
    "akaike information criterion (aic)": "aic",
    "bayesian information criterion (bic)": "bic",
}


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


def parse_statistics_toml(
    file_path: Path,
    warnings: list[StructuredWarning],
) -> Optional[GoodnessOfFitModel]:
    """
    Parse statistics.toml file.
    Total function: returns None or partial model on missing/corrupt files.
    """
    if not file_path.exists() or not file_path.is_file():
        return None

    try:
        data = tomllib.loads(file_path.read_text(encoding="utf-8"))
    except Exception as exc:
        warnings.append(
            StructuredWarning(
                code="CORRUPT_STATISTICS_TOML",
                message=f"Failed to decode statistics.toml: {exc}",
                path=str(file_path),
            )
        )
        return None

    ndata = None
    nvarys = None
    chisqr = None
    redchi = None
    pvalue = None
    ks_pvalue = None
    aic = None
    bic = None
    extra: dict[str, Any] = {}

    for raw_key, val in data.items():
        norm_key = str(raw_key).lower().strip().strip('"').strip("'")
        mapped_field = KEY_MAPPING.get(norm_key)

        if mapped_field == "ndata":
            ndata = _safe_int(val)
        elif mapped_field == "nvarys":
            nvarys = _safe_int(val)
        elif mapped_field == "chisqr":
            chisqr = _safe_float(val)
        elif mapped_field == "redchi":
            redchi = _safe_float(val)
        elif mapped_field == "pvalue":
            pvalue = _safe_float(val)
        elif mapped_field == "ks_pvalue":
            ks_pvalue = _safe_float(val)
        elif mapped_field == "aic":
            aic = _safe_float(val)
        elif mapped_field == "bic":
            bic = _safe_float(val)
        elif norm_key == "experiments" and isinstance(val, dict):
            pass # Handle below
        else:
            extra[raw_key] = val

    experiment_stats = {}
    if "experiments" in data and isinstance(data["experiments"], dict):
        for exp_name, exp_data in data["experiments"].items():
            if isinstance(exp_data, dict):
                e_ndata = _safe_int(exp_data.get("number of data points"))
                e_nvarys = _safe_int(exp_data.get("number of variables"))
                e_chisqr = _safe_float(exp_data.get("chi-square"))
                e_redchi = _safe_float(exp_data.get("reduced-chi-square"))
                e_pvalue = _safe_float(exp_data.get("chi-squared test"))
                e_ks_pvalue = _safe_float(exp_data.get("kolmogorov-smirnov test"))
                e_aic = _safe_float(exp_data.get("akaike information criterion (aic)"))
                e_bic = _safe_float(exp_data.get("bayesian information criterion (bic)"))
                
                e_extra = {}
                for rk, rv in exp_data.items():
                    nk = str(rk).lower().strip().strip('"').strip("'")
                    if KEY_MAPPING.get(nk) is None:
                        e_extra[rk] = rv
                        
                experiment_stats[exp_name] = GoodnessOfFitModel(
                    ndata=e_ndata,
                    nvarys=e_nvarys,
                    chisqr=e_chisqr,
                    redchi=e_redchi,
                    pvalue=e_pvalue,
                    ks_pvalue=e_ks_pvalue,
                    aic=e_aic,
                    bic=e_bic,
                    extra=e_extra,
                )

    return GoodnessOfFitModel(
        ndata=ndata,
        nvarys=nvarys,
        chisqr=chisqr,
        redchi=redchi,
        pvalue=pvalue,
        ks_pvalue=ks_pvalue,
        aic=aic,
        bic=bic,
        extra=extra,
        experiment_stats=experiment_stats,
    )
