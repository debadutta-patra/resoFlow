# Copyright (C) 2026 resoFlow Authors
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

"""
REST endpoints for reduced spectral density mapping.

Follows the repo's analysis conventions: UUID-scoped paths under a project,
ownership enforced by the get_project / get_analysis dependencies, results on
disk under <project>/sdm_fitting/<uuid>/.
"""

from __future__ import annotations

import json
import os
import re
import uuid as uuid_lib
from datetime import datetime
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import Response
from sqlalchemy.orm import Session

from .. import database, models
from ..features import ENABLE_EXPERIMENTAL_SDM_REX, experimental_sdm_rex_enabled
from ..services.fitting.sdm_runner import (
    build_csv,
    build_multifield_csv,
    run_mapping,
    run_multifield_mapping,
    sdm_run_dir,
    write_results,
)
from ..services.fitting.sdm_sources import (
    B0_TOLERANCE_MHZ,
    SdmSourceError,
    align_datasets,
    build_dataset,
    load_cpmg_r2_series,
    load_rate_series,
    validate_field_consistency,
)
from ..services.sdm.schemas import R2Provenance, RexSource, SpectralDensityCreate
from ..services.path_utils import resolve_existing_path
from .deps import get_project

router = APIRouter(
    prefix="/api/projects/{project_uuid}/spectral-density", tags=["spectral-density"]
)

ANALYSIS_TYPE = "SDM"


def _get_sdm_analysis(
    analysis_uuid: str,
    project: models.Project,
    db: Session,
) -> models.Analysis:
    """Fetch an SDM analysis inside a project the caller owns."""
    analysis = (
        db.query(models.Analysis)
        .filter(
            models.Analysis.analysis_uuid == analysis_uuid,
            models.Analysis.project_id == project.id,
        )
        .first()
    )
    if not analysis:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Spectral density analysis not found in this project",
        )
    if (analysis.analysis_type or "").upper() != ANALYSIS_TYPE:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=(
                f"Analysis '{analysis.name}' is of type "
                f"{analysis.analysis_type}, not a spectral density mapping"
            ),
        )
    return analysis


def _load_source(project: models.Project, db: Session, source_uuid: str, role: str):
    """Look up one source analysis, scoped to the project."""
    analysis = (
        db.query(models.Analysis)
        .filter(
            models.Analysis.analysis_uuid == source_uuid,
            models.Analysis.project_id == project.id,
        )
        .first()
    )
    if not analysis:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Source {role} analysis {source_uuid} not found in this project",
        )
    return analysis


def _read_results(analysis: models.Analysis) -> Optional[Dict[str, Any]]:
    path = resolve_existing_path(analysis.results_path) if analysis.results_path else None
    if not path or not os.path.exists(path):
        path = os.path.join(sdm_run_dir(analysis), "results.json")
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def _reject_gated_rex(rex_source: RexSource) -> None:
    """Refuse Rex-corrected requests unless the flag is on.

    The database column and the pydantic field accept the value regardless --
    gating lives here, at the API layer, so a record written while the flag
    was enabled still deserialises after it is turned off.
    """
    if rex_source == RexSource.NONE:
        return
    if experimental_sdm_rex_enabled():
        return
    raise HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        detail=(
            f"Chemical-exchange correction (rex_source='{rex_source.value}') is "
            "an experimental feature and is disabled on this server. Set "
            f"{ENABLE_EXPERIMENTAL_SDM_REX}=true to enable it."
        ),
    )


@router.post("", response_model=None, status_code=status.HTTP_201_CREATED)
def create_spectral_density(
    payload: SpectralDensityCreate,
    project: models.Project = Depends(get_project),
    db: Session = Depends(database.get_db),
):
    """Create and run a spectral density mapping.

    The analytic path is milliseconds for a few hundred residues, so it runs
    synchronously in the request rather than round-tripping through Celery.
    """
    _reject_gated_rex(payload.rex_source)

    if payload.rex_source == RexSource.MULTI_FIELD and not payload.additional_field_sources:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={
                "message": (
                    "Multi-field consistency needs at least one entry in "
                    "additional_field_sources. A single field gives a square "
                    "system with no surplus degree of freedom, so there is "
                    "nothing for the chi-square to test."
                )
            },
        )

    r1_analysis = _load_source(project, db, payload.source_r1_analysis_uuid, "R1")
    r2_analysis = _load_source(project, db, payload.source_r2_analysis_uuid, "R2")
    noe_analysis = _load_source(project, db, payload.source_noe_analysis_uuid, "hetNOE")

    try:
        r1_series = load_rate_series(r1_analysis)
        noe_series = load_rate_series(noe_analysis)

        if payload.r2_provenance == R2Provenance.CPMG_R2_0:
            # ChemEx's fitted R2_A is already exchange-free, so no Rex
            # subtraction is involved and this stays a production path.
            # The field comes from R1 and the hetNOE, and the CPMG loader
            # selects the R2,0 block for exactly that field rather than
            # guessing between a multi-field fit's blocks.
            target_b0 = validate_field_consistency(
                [r1_series, noe_series], B0_TOLERANCE_MHZ
            )
            r2_series = load_cpmg_r2_series(r2_analysis, target_b0, B0_TOLERANCE_MHZ)
        else:
            r2_series = load_rate_series(r2_analysis)

        dataset = build_dataset(r1_series, r2_series, noe_series)

        extra_datasets = []
        if payload.rex_source == RexSource.MULTI_FIELD:
            for index, triple in enumerate(payload.additional_field_sources, start=2):
                extra_datasets.append(build_dataset(
                    load_rate_series(_load_source(
                        project, db, triple.source_r1_analysis_uuid,
                        f"R1 (field {index})")),
                    load_rate_series(_load_source(
                        project, db, triple.source_r2_analysis_uuid,
                        f"R2 (field {index})")),
                    load_rate_series(_load_source(
                        project, db, triple.source_noe_analysis_uuid,
                        f"hetNOE (field {index})")),
                ))
            # Every field must cover the same residues, since one system is
            # solved per residue across all of them.
            datasets = align_datasets([dataset, *extra_datasets])
            dataset = datasets[0]
    except SdmSourceError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={"message": str(exc), **exc.detail},
        )

    if len(dataset) == 0:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={
                "message": (
                    "No residue is present in all three source analyses, so "
                    "there is nothing to map."
                ),
                "excluded_residues": [e.to_dict() for e in dataset.excluded],
            },
        )

    params: Dict[str, Any] = {
        "additional_field_sources": [
            t.model_dump() for t in payload.additional_field_sources
        ],
        "source_r1_analysis_uuid": payload.source_r1_analysis_uuid,
        "source_r2_analysis_uuid": payload.source_r2_analysis_uuid,
        "source_noe_analysis_uuid": payload.source_noe_analysis_uuid,
        "constants": payload.constants.model_dump(),
        "variant": payload.variant,
        "error_method": payload.error_method.value,
        "n_replicates": payload.n_replicates,
        "seed": payload.seed,
        "r2_provenance": payload.r2_provenance.value,
        "r1rho_tilt_angle_deg": payload.r1rho_tilt_angle_deg,
        "rex_source": payload.rex_source.value,
        "rex_cpmg_analysis_uuid": payload.rex_cpmg_analysis_uuid,
    }

    analysis = models.Analysis(
        analysis_uuid=str(uuid_lib.uuid4()),
        name=payload.name,
        analysis_type=ANALYSIS_TYPE,
        project_id=project.id,
        status="RUNNING",
        parameters=json.dumps(params),
        experimental=payload.rex_source != RexSource.NONE,
    )
    db.add(analysis)
    db.commit()
    db.refresh(analysis)

    try:
        if payload.rex_source == RexSource.MULTI_FIELD:
            results = run_multifield_mapping(datasets, params)
        else:
            results = run_mapping(dataset, params)
        results_path = write_results(analysis, results)
        analysis.results_path = results_path
        analysis.status = "COMPLETED"
        analysis.completed_at = datetime.now()
        analysis.error_message = None
        db.commit()
        db.refresh(analysis)
    except Exception as exc:  # noqa: BLE001 - recorded on the analysis row
        analysis.status = "FAILED"
        analysis.error_message = str(exc)
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={"message": f"Spectral density mapping failed: {exc}"},
        )

    return _detail_payload(analysis, results)


@router.get("")
def list_spectral_density(
    project: models.Project = Depends(get_project),
    db: Session = Depends(database.get_db),
):
    """List the spectral density analyses in a project."""
    rows = (
        db.query(models.Analysis)
        .filter(
            models.Analysis.project_id == project.id,
            models.Analysis.analysis_type == ANALYSIS_TYPE,
        )
        .order_by(models.Analysis.created_at.desc())
        .all()
    )
    return [
        {
            "analysis_uuid": a.analysis_uuid,
            "name": a.name,
            "status": a.status,
            "experimental": bool(a.experimental),
            "created_at": a.created_at.isoformat() if a.created_at else None,
            "completed_at": a.completed_at.isoformat() if a.completed_at else None,
            "error_message": a.error_message,
        }
        for a in rows
    ]


@router.get("/{analysis_uuid}")
def get_spectral_density(
    analysis_uuid: str,
    project: models.Project = Depends(get_project),
    db: Session = Depends(database.get_db),
):
    """Detail plus every mapped residue."""
    analysis = _get_sdm_analysis(analysis_uuid, project, db)
    return _detail_payload(analysis, _read_results(analysis))


@router.get("/{analysis_uuid}/export.csv")
def export_spectral_density_csv(
    analysis_uuid: str,
    project: models.Project = Depends(get_project),
    db: Session = Depends(database.get_db),
):
    """Per-residue CSV, with the experimental marker in the header."""
    analysis = _get_sdm_analysis(analysis_uuid, project, db)
    results = _read_results(analysis)
    if not results:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No results available for this analysis",
        )
    clean = re.sub(r"[^A-Za-z0-9_-]", "_", (analysis.name or "sdm").strip()).lower()
    filename = f"resoflow_sdm_{clean}_{analysis.analysis_uuid[:8]}.csv"
    writer = (
        build_multifield_csv if results.get("mode") == "multi_field" else build_csv
    )
    return Response(
        content=writer(results),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/{analysis_uuid}/report")
def generate_spectral_density_report(
    analysis_uuid: str,
    style: str = "publication",
    palette: Optional[str] = None,
    project: models.Project = Depends(get_project),
    db: Session = Depends(database.get_db),
):
    """Render the PDF report.

    Goes through the shared report generator so the spectral density section
    sits alongside every other section, rather than through a parallel
    reporting path.
    """
    analysis = _get_sdm_analysis(analysis_uuid, project, db)
    if analysis.status != "COMPLETED":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Report requires status COMPLETED (current: {analysis.status})",
        )

    from ..services.reporting.report_generator import generate_modern_pdf_report

    buffer = generate_modern_pdf_report(
        analysis_dir=sdm_run_dir(analysis),
        analysis_name=analysis.name,
        analysis_type=ANALYSIS_TYPE,
        style=style,
        palette=palette,
    )
    clean = re.sub(r"[^A-Za-z0-9_-]", "_", (analysis.name or "sdm").strip()).lower()
    filename = f"resoflow_sdm_{clean}_{analysis.analysis_uuid[:8]}.pdf"
    return Response(
        content=buffer.getvalue(),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.delete("/{analysis_uuid}")
def delete_spectral_density(
    analysis_uuid: str,
    project: models.Project = Depends(get_project),
    db: Session = Depends(database.get_db),
):
    """Delete the analysis and its run directory."""
    analysis = _get_sdm_analysis(analysis_uuid, project, db)
    run_dir = sdm_run_dir(analysis)
    db.delete(analysis)
    db.commit()

    if os.path.isdir(run_dir):
        from ..services.cleanup import delete_directory_safely

        try:
            delete_directory_safely(run_dir)
        except Exception:
            # The row is already gone; a stale directory is not worth
            # failing the request over.
            pass
    return {"message": "Spectral density analysis deleted"}


def _detail_payload(
    analysis: models.Analysis, results: Optional[Dict[str, Any]]
) -> Dict[str, Any]:
    """Assemble the detail response.

    The experimental marker is echoed at the top level of every response, not
    only inside the results blob, so a client cannot render the numbers
    without also having seen that they are experimental.
    """
    body: Dict[str, Any] = {
        "analysis_uuid": analysis.analysis_uuid,
        "name": analysis.name,
        "analysis_type": analysis.analysis_type,
        "status": analysis.status,
        "experimental": bool(analysis.experimental),
        "created_at": analysis.created_at.isoformat() if analysis.created_at else None,
        "completed_at": (
            analysis.completed_at.isoformat() if analysis.completed_at else None
        ),
        "error_message": analysis.error_message,
        "results": results,
    }
    if analysis.experimental:
        from ..services.fitting.sdm_runner import EXPERIMENTAL_NOTICE

        body["experimental_notice"] = EXPERIMENTAL_NOTICE
    return body
