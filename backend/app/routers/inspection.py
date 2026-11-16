"""Inspection aids for Pick CEST and Inspect Dispersion (read-only calculations on the
analysis' generated profiles; nothing is written)."""

from __future__ import annotations

import json
import os
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import models
from ..services.inspection.cest_one_state import fit_one_state, flag_high_r2
from ..services.inspection.cpmg_screening import screen_profile
from ..services.inspection.cest_sources import (
    cest_profiles_from_config,
    experiment_inputs,
    normalize_masks,
    time_t1_by_label,
)
from ..services.path_utils import to_container_path
from .deps import get_analysis

router = APIRouter(
    prefix="/api/projects/{project_uuid}/analysis/{analysis_uuid}/inspection",
    tags=["inspection"],
)

DEFAULT_XI_15N = 0.101329118

# (sub-directory, config file) per analysis type.
_CONFIG_LOCATIONS = {
    "15N-CEST": ("cest_fitting", "config.json"),
    "EXCHANGE": ("exchange_fitting", "config.json"),
}


def _analysis_config(analysis: models.Analysis) -> dict:
    loc = _CONFIG_LOCATIONS.get(analysis.analysis_type)
    if not loc:
        raise HTTPException(status_code=400, detail=f"No CEST inspection for analysis type {analysis.analysis_type}")
    project_dir = analysis.project.local_directory_path
    if analysis.analysis_type == "EXCHANGE":
        project_dir = to_container_path(project_dir) or project_dir
    path = os.path.join(project_dir, loc[0], analysis.analysis_uuid, loc[1])
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="No generated experiments yet")
    try:
        with open(path, "r") as f:
            return json.load(f)
    except (OSError, ValueError) as e:
        raise HTTPException(status_code=500, detail=f"Unreadable analysis config: {e}")


class OneStateRequest(BaseModel):
    residues: Optional[list[str]] = None
    #: Unsaved masks from the page; falls back to the saved ``cest_masks``.
    masks: Optional[dict[str, list[int]]] = None
    xi: float = Field(default=DEFAULT_XI_15N, gt=0)
    #: Fixed R1 (s⁻¹); only R2 − R1 is identifiable from a one-state CEST fit.
    r1: float = Field(default=1.5, gt=0, le=20)


@router.post("/cest/one-state")
def cest_one_state_fits(
    body: OneStateRequest,
    analysis: models.Analysis = Depends(get_analysis),
) -> dict[str, Any]:
    """One-state fit per residue: fitted curve, residuals and R2, plus R2 outlier stats."""
    cfg = _analysis_config(analysis)
    profiles = cest_profiles_from_config(cfg)
    wanted = set(body.residues) if body.residues else None
    t1 = time_t1_by_label(cfg)
    masks = normalize_masks(body.masks if body.masks is not None else cfg.get("cest_masks"))
    fits: dict[str, Any] = {}
    for prof in profiles:
        res = prof.get("residue")
        if not res or (wanted is not None and res not in wanted):
            continue
        try:
            fit = fit_one_state(experiment_inputs(prof, t1, masks), xi=body.xi, r1=body.r1)
        except (ValueError, FloatingPointError, ArithmeticError) as e:
            fit = {"error": str(e)}
        if fit is not None:
            fits[res] = fit
    stats = flag_high_r2({r: f.get("r2") for r, f in fits.items() if "r2" in f})
    return {"fits": fits, "r2_stats": stats, "time_t1": t1}


class CpmgExperimentIn(BaseModel):
    b0: Optional[float] = None
    nu_cpmg: list[float] = Field(default_factory=list)
    r2eff: list[float] = Field(default_factory=list)
    r2eff_err: list[Optional[float]] = Field(default_factory=list)


class CpmgProfileIn(BaseModel):
    residue: str
    experiments: list[CpmgExperimentIn] = Field(default_factory=list)


class CpmgScreeningRequest(BaseModel):
    profiles: list[CpmgProfileIn]
    #: Flag residues whose duplicate spread exceeds the reported error by this factor.
    factor: float = Field(default=3.0, gt=0)


@router.post("/cpmg/screening")
def cpmg_screening(
    body: CpmgScreeningRequest,
    analysis: models.Analysis = Depends(get_analysis),
) -> dict[str, Any]:
    """Rex (lowest − highest ν_CPMG mean, with error) and pooled duplicate error per residue."""
    return {
        "factor": body.factor,
        "residues": {
            p.residue: screen_profile([e.model_dump() for e in p.experiments], factor=body.factor)
            for p in body.profiles
        },
    }
