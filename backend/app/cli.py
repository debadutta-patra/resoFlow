"""resoFlow Admin CLI utilities.

Usage:
    python -m app.cli rebuild-bundles [--all | --project <uuid> | --analysis <uuid>] [--force]
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

from . import database, models
from .services.results_bundle.ingest import ingest_results
from .services.results_bundle.store import is_bundle_valid
from .services.results_bundle.tasks import _resolve_run_dir

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("resoflow.cli")


def rebuild_bundles(
    all_runs: bool = False,
    project_uuid: str | None = None,
    analysis_uuid: str | None = None,
    force: bool = False,
) -> int:
    """Rebuild results bundles in bulk across the database."""
    db = next(database.get_db())
    try:
        query = db.query(models.Analysis)
        if analysis_uuid:
            query = query.filter(models.Analysis.analysis_uuid == analysis_uuid)
        elif project_uuid:
            project = db.query(models.Project).filter(models.Project.project_uuid == project_uuid).first()
            if not project:
                logger.error("Project %s not found", project_uuid)
                return 1
            query = query.filter(models.Analysis.project_id == project.id)
        elif not all_runs:
            logger.error("Must specify --all, --project <uuid>, or --analysis <uuid>")
            return 1

        analyses = query.all()
        logger.info("Found %d analyses to process", len(analyses))

        succeeded = 0
        skipped = 0
        failed = 0

        for a in analyses:
            if a.status in ("RUNNING", "PENDING"):
                logger.info("Skipping in-flight analysis %s", a.analysis_uuid)
                skipped += 1
                continue

            try:
                run_dir = _resolve_run_dir(a)
                if not run_dir.exists():
                    logger.warning("Directory for analysis %s does not exist: %s", a.analysis_uuid, run_dir)
                    skipped += 1
                    continue

                if not force and is_bundle_valid(run_dir):
                    logger.info("Analysis %s already has valid bundle (use --force to rebuild)", a.analysis_uuid)
                    skipped += 1
                    continue

                logger.info("Ingesting bundle for %s (%s)...", a.analysis_uuid, a.name)
                meta = ingest_results(
                    run_dir=run_dir,
                    analysis_uuid=a.analysis_uuid,
                    chemex_version=a.chemex_version,
                    analysis_name=a.name,
                    analysis_type=a.analysis_type or "CEST",
                )
                a.bundle_status = "VALID"
                a.summary_redchi = meta.get("summary_redchi")
                a.summary_n_residues = meta.get("summary_n_residues")
                db.commit()
                succeeded += 1
            except Exception as exc:
                logger.exception("Failed rebuilding bundle for %s: %s", a.analysis_uuid, exc)
                a.bundle_status = "ERROR"
                db.commit()
                failed += 1

        logger.info("Rebuild complete: %d succeeded, %d skipped, %d failed", succeeded, skipped, failed)
        return 0 if failed == 0 else 1
    finally:
        db.close()


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m app.cli", description="resoFlow admin command-line tool")
    subparsers = parser.add_subparsers(dest="command", required=True)

    rebuild_parser = subparsers.add_parser("rebuild-bundles", help="Rebuild results bundles")
    rebuild_parser.add_argument("--all", action="store_true", help="Rebuild for all analyses in the system")
    rebuild_parser.add_argument("--project", type=str, default=None, help="Rebuild for analyses under this project UUID")
    rebuild_parser.add_argument("--analysis", type=str, default=None, help="Rebuild for a specific analysis UUID")
    rebuild_parser.add_argument("--force", action="store_true", help="Force rebuild even if bundle is already valid")

    args = parser.parse_args()

    if args.command == "rebuild-bundles":
        exit_code = rebuild_bundles(
            all_runs=args.all,
            project_uuid=args.project,
            analysis_uuid=args.analysis,
            force=args.force,
        )
        sys.exit(exit_code)


if __name__ == "__main__":
    main()
