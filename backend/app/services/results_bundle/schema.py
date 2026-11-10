"""Results Bundle Schema and SQLite DDL Definition (§3.11).

Defines bundle schema versions, Pydantic models for manifest.json and summary.json,
and relational SQLite table DDL for lazy queries.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional
from pydantic import BaseModel, ConfigDict, Field

BUNDLE_SCHEMA_VERSION = 1
PARSER_VERSION = "2026.9.2-p2"  # p2: run_overview.json + grid_surfaces.json

SQLITE_INIT_DDL = """
PRAGMA journal_mode = DELETE;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS parameters (
    step TEXT NOT NULL,
    param_id TEXT NOT NULL,
    name TEXT NOT NULL,
    residue TEXT,
    spin TEXT,
    value REAL,
    err REAL,
    err_kind TEXT,
    vary INTEGER NOT NULL DEFAULT 1,
    expr TEXT,
    min REAL,
    max REAL,
    PRIMARY KEY (step, param_id)
);
CREATE INDEX IF NOT EXISTS idx_params_residue ON parameters(residue);
CREATE INDEX IF NOT EXISTS idx_params_step_res ON parameters(step, residue);

CREATE TABLE IF NOT EXISTS profiles (
    step TEXT NOT NULL,
    experiment TEXT NOT NULL,
    residue TEXT NOT NULL,
    x REAL NOT NULL,
    y_obs REAL,
    y_err REAL,
    y_calc REAL,
    excluded INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_profiles_step_res ON profiles(step, residue);
CREATE INDEX IF NOT EXISTS idx_profiles_exp_res ON profiles(experiment, residue);

CREATE TABLE IF NOT EXISTS residuals (
    step TEXT NOT NULL,
    experiment TEXT NOT NULL,
    residue TEXT NOT NULL,
    x REAL NOT NULL,
    residual REAL,
    weighted_residual REAL
);
CREATE INDEX IF NOT EXISTS idx_residuals_step_res ON residuals(step, residue);
CREATE INDEX IF NOT EXISTS idx_residuals_exp_res ON residuals(experiment, residue);

CREATE TABLE IF NOT EXISTS stat_summary (
    step TEXT NOT NULL,
    method TEXT NOT NULL,
    param_id TEXT NOT NULL,
    center REAL,
    lower_68 REAL,
    upper_68 REAL,
    half_width_68 REAL,
    mcse_mean REAL,
    status TEXT,
    PRIMARY KEY (step, method, param_id)
);
CREATE INDEX IF NOT EXISTS idx_stat_summary_step_method ON stat_summary(step, method);

CREATE TABLE IF NOT EXISTS stat_correlations (
    step TEXT NOT NULL,
    method TEXT NOT NULL,
    param_a TEXT NOT NULL,
    param_b TEXT NOT NULL,
    r REAL NOT NULL,
    PRIMARY KEY (step, method, param_a, param_b)
);

CREATE TABLE IF NOT EXISTS grid_1d (
    step TEXT NOT NULL,
    param_id TEXT NOT NULL,
    value REAL NOT NULL,
    chi2 REAL NOT NULL,
    delta_chi2 REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_grid_1d_step_param ON grid_1d(step, param_id);

CREATE TABLE IF NOT EXISTS grid_2d (
    step TEXT NOT NULL,
    param_x TEXT NOT NULL,
    param_y TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    chi2 REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_grid_2d_step_params ON grid_2d(step, param_x, param_y);

CREATE TABLE IF NOT EXISTS sharing (
    param_id TEXT NOT NULL,
    experiment TEXT NOT NULL,
    PRIMARY KEY (param_id, experiment)
);
"""


class ArtifactIndexEntry(BaseModel):
    model_config = ConfigDict(extra="ignore")
    path: str
    sha256: str
    render_key: str
    kind: str  # "report" | "plots"
    status: str = "ready"  # "ready" | "pending" | "failed"


class ManifestModel(BaseModel):
    model_config = ConfigDict(extra="ignore")
    bundle_schema: int = BUNDLE_SCHEMA_VERSION
    parser_version: str = PARSER_VERSION
    chemex_version: Optional[str] = None
    fingerprint: str
    created_at: str
    status: str = "complete"  # "complete" | "completed_with_errors" | "partial"
    artifacts: Dict[str, ArtifactIndexEntry] = Field(default_factory=dict)


class SummaryModel(BaseModel):
    """Small eager summary of fit statistics and headline parameters (< 200 kB)."""
    model_config = ConfigDict(extra="ignore")
    run_status: str = "complete"
    chi2: Optional[float] = None
    chi2_red: Optional[float] = None
    aic: Optional[float] = None
    bic: Optional[float] = None
    ndata: Optional[int] = None
    nvarys: Optional[int] = None
    uncertainty_kind: Optional[str] = None
    global_params: Dict[str, Any] = Field(default_factory=dict)
    residues: Dict[str, Any] = Field(default_factory=dict)
    warnings: List[Dict[str, Any]] = Field(default_factory=list)
    step_order: List[str] = Field(default_factory=list)
    primary_step: Optional[str] = None
    is_multi_step: bool = False
    derived_kinetics: Dict[str, Any] = Field(default_factory=dict)
    can_continue_fit: bool = False
    continue_explanation: Optional[str] = None
    restart_file_path: Optional[str] = None
    provenance: Optional[Dict[str, Any]] = None
    outcome: Optional[Dict[str, Any]] = None
    fit_mode: str = "global"
