#!/usr/bin/env python3
"""
Data Migration Script: SQLite -> PostgreSQL for resoFlow.

This script reads data from resoFlow's SQLite database and writes it to PostgreSQL
using SQLAlchemy models, preserving primary keys, validating foreign keys,
normalizing booleans and timezone-aware datetimes, and advancing PostgreSQL sequences.

Usage:
    python scripts/migrate_sqlite_to_postgres.py --sqlite-path backend/sql_app.db --pg-url postgresql://user:pass@host:5432/dbname [--dry-run]
"""

import os
import sys
import argparse
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Any, List, Set, Tuple

# Add backend directory to sys.path
SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
BACKEND_DIR = REPO_ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from sqlalchemy import create_engine, text, func, inspect as sa_inspect
from sqlalchemy.orm import sessionmaker, Session

# Import models
from app.models import Base, User, Project, Spectrum, Job, Analysis, analysis_spectra
from app.database import normalize_database_url

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S"
)
logger = logging.getLogger("migration")


def parse_args():
    parser = argparse.ArgumentParser(description="Migrate resoFlow data from SQLite to PostgreSQL.")
    parser.add_argument(
        "--sqlite-path",
        default=str(BACKEND_DIR / "sql_app.db"),
        help="Path to source SQLite database file (default: backend/sql_app.db)"
    )
    parser.add_argument(
        "--pg-url",
        default=os.environ.get("DATABASE_URL"),
        help="Target PostgreSQL connection URL (or set DATABASE_URL env var)"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Perform all validations and coercions without modifying destination database."
    )
    return parser.parse_args()


def parse_datetime_to_utc(val: Any) -> Tuple[datetime, bool]:
    """
    Parse a datetime value (or string) and normalize it to a timezone-aware UTC datetime.
    Returns (normalized_datetime, was_coerced_flag).
    """
    if val is None:
        return None, False
    
    if isinstance(val, datetime):
        if val.tzinfo is None:
            return val.replace(tzinfo=timezone.utc), True
        return val.astimezone(timezone.utc), False
    
    if isinstance(val, str):
        # Format can be 'YYYY-MM-DD HH:MM:SS' or 'YYYY-MM-DD HH:MM:SS.ffffff' or ISO
        cleaned_str = val.strip().replace("T", " ")
        try:
            if "." in cleaned_str:
                dt = datetime.strptime(cleaned_str, "%Y-%m-%d %H:%M:%S.%f")
            else:
                dt = datetime.strptime(cleaned_str, "%Y-%m-%d %H:%M:%S")
            return dt.replace(tzinfo=timezone.utc), True
        except ValueError:
            # Fallback to fromisoformat
            try:
                dt = datetime.fromisoformat(val)
                if dt.tzinfo is None:
                    return dt.replace(tzinfo=timezone.utc), True
                return dt.astimezone(timezone.utc), False
            except Exception as e:
                raise ValueError(f"Unable to parse datetime string '{val}': {e}")
                
    raise TypeError(f"Unexpected datetime type: {type(val)} for value {val}")


def parse_boolean(val: Any) -> Tuple[bool, bool]:
    """
    Normalize boolean value to True/False.
    Returns (normalized_bool, was_coerced_flag).
    """
    if val is None:
        return False, True
    if isinstance(val, bool):
        return val, False
    if isinstance(val, (int, float)):
        return bool(val), True
    if isinstance(val, str):
        lower_val = val.lower().strip()
        if lower_val in ("1", "true", "t", "yes", "y"):
            return True, True
        elif lower_val in ("0", "false", "f", "no", "n"):
            return False, True
    raise ValueError(f"Invalid boolean value: {val} (type {type(val)})")


def run_migration(sqlite_path: str, pg_url: str, dry_run: bool = False):
    sqlite_file = Path(sqlite_path).resolve()
    if not sqlite_file.exists():
        logger.error(f"Source SQLite database not found at: {sqlite_file}")
        sys.exit(1)

    if not pg_url:
        logger.error("Destination PostgreSQL URL is required (--pg-url or DATABASE_URL).")
        sys.exit(1)

    normalized_pg_url = normalize_database_url(pg_url)
    logger.info(f"Source SQLite DB: {sqlite_file}")
    logger.info(f"Target Postgres DB: {normalized_pg_url.split('@')[-1] if '@' in normalized_pg_url else normalized_pg_url}")
    if dry_run:
        logger.info("=== RUNNING IN DRY-RUN MODE (No changes will be written) ===")

    # Setup source SQLite engine & session
    sqlite_engine = create_engine(
        f"sqlite:///{sqlite_file}",
        connect_args={"check_same_thread": False}
    )
    SqliteSession = sessionmaker(bind=sqlite_engine)
    src_session: Session = SqliteSession()

    # Setup target PostgreSQL engine & session
    pg_engine = create_engine(
        normalized_pg_url,
        pool_pre_ping=True
    )
    PgSession = sessionmaker(bind=pg_engine)
    dst_session: Session = PgSession()

    # Verify target tables exist
    pg_inspector = sa_inspect(pg_engine)
    pg_tables = pg_inspector.get_table_names()
    required_tables = ["users", "projects", "spectra", "jobs", "analyses", "analysis_spectra"]
    missing_tables = [t for t in required_tables if t not in pg_tables]
    if missing_tables:
        logger.error(f"Missing required tables in destination database: {missing_tables}")
        logger.error("Please run 'alembic upgrade head' on the destination database first.")
        sys.exit(1)

    coercion_stats = {
        "booleans": 0,
        "datetimes": 0,
    }

    # 1. READ ALL DATA FROM SQLITE
    logger.info("Reading records from source SQLite database...")
    
    users_raw = src_session.query(User).order_by(User.id).all()
    projects_raw = src_session.query(Project).order_by(Project.id).all()
    spectra_raw = src_session.query(Spectrum).order_by(Spectrum.id).all()
    analyses_raw = src_session.query(Analysis).order_by(Analysis.id).all()
    jobs_raw = src_session.query(Job).order_by(Job.id).all()
    
    # Read association table
    assoc_rows = src_session.execute(text("SELECT analysis_id, spectrum_id FROM analysis_spectra")).fetchall()

    logger.info(f"Found source counts: Users={len(users_raw)}, Projects={len(projects_raw)}, Spectra={len(spectra_raw)}, Analyses={len(analyses_raw)}, Jobs={len(jobs_raw)}, Analysis-Spectra Links={len(assoc_rows)}")

    # 2. VALIDATE FOREIGN KEY INTEGRITY
    logger.info("Validating referential integrity...")
    valid_user_ids: Set[int] = {u.id for u in users_raw}
    valid_project_ids: Set[int] = {p.id for p in projects_raw}
    valid_spectra_ids: Set[int] = {s.id for s in spectra_raw}
    valid_analysis_ids: Set[int] = {a.id for a in analyses_raw}

    fk_errors: List[str] = []

    for p in projects_raw:
        if p.user_id is not None and p.user_id not in valid_user_ids:
            fk_errors.append(f"Project id={p.id} references invalid user_id={p.user_id}")

    for s in spectra_raw:
        if s.project_id is not None and s.project_id not in valid_project_ids:
            fk_errors.append(f"Spectrum id={s.id} references invalid project_id={s.project_id}")

    for a in analyses_raw:
        if a.project_id is not None and a.project_id not in valid_project_ids:
            fk_errors.append(f"Analysis id={a.id} references invalid project_id={a.project_id}")

    for j in jobs_raw:
        if j.project_id is not None and j.project_id not in valid_project_ids:
            fk_errors.append(f"Job id={j.id} references invalid project_id={j.project_id}")
        if j.spectrum_id is not None and j.spectrum_id not in valid_spectra_ids:
            fk_errors.append(f"Job id={j.id} references invalid spectrum_id={j.spectrum_id}")

    for r in assoc_rows:
        aid, sid = r[0], r[1]
        if aid not in valid_analysis_ids:
            fk_errors.append(f"analysis_spectra references invalid analysis_id={aid}")
        if sid not in valid_spectra_ids:
            fk_errors.append(f"analysis_spectra references invalid spectrum_id={sid}")

    if fk_errors:
        logger.error(f"Foreign key validation failed with {len(fk_errors)} violation(s):")
        for err in fk_errors:
            logger.error(f"  - {err}")
        sys.exit(1)

    logger.info("Referential integrity check PASSED: 0 orphan rows.")

    # 3. PREPARE TRANSFORMED OBJECTS
    transformed_users = []
    for u in users_raw:
        is_act, c1 = parse_boolean(u.is_active)
        is_sup, c2 = parse_boolean(u.is_superuser)
        if c1 or c2:
            coercion_stats["booleans"] += (c1 + c2)
        transformed_users.append({
            "id": u.id,
            "email": u.email,
            "hashed_password": u.hashed_password,
            "full_name": u.full_name,
            "is_active": is_act,
            "is_superuser": is_sup,
        })

    transformed_projects = []
    for p in projects_raw:
        is_arch, c_b = parse_boolean(p.is_archived)
        c_at, c_dt = parse_datetime_to_utc(p.created_at)
        if c_b:
            coercion_stats["booleans"] += 1
        if c_dt:
            coercion_stats["datetimes"] += 1
        transformed_projects.append({
            "id": p.id,
            "project_uuid": p.project_uuid,
            "name": p.name,
            "local_directory_path": p.local_directory_path,
            "protein_sequence": p.protein_sequence,
            "molecular_weight": p.molecular_weight,
            "spectra_path": p.spectra_path,
            "experiments": p.experiments,
            "created_at": c_at,
            "user_id": p.user_id,
            "is_archived": is_arch,
        })

    transformed_spectra = []
    for s in spectra_raw:
        is_fit, c_b = parse_boolean(s.is_fitted)
        if c_b:
            coercion_stats["booleans"] += 1
        transformed_spectra.append({
            "id": s.id,
            "spectrum_uuid": s.spectrum_uuid,
            "name": s.name,
            "file_path": s.file_path,
            "experiment_type": s.experiment_type,
            "peaklist_path": s.peaklist_path,
            "list_path": s.list_path,
            "vclist_path": s.vclist_path,
            "vdlist_path": s.vdlist_path,
            "f3list_path": s.f3list_path,
            "delay": s.delay,
            "t_relax": s.t_relax,
            "b1": s.b1,
            "hetnoe_mode": s.hetnoe_mode,
            "project_id": s.project_id,
            "is_fitted": is_fit,
            "results_json_path": s.results_json_path,
            "peaktable_json_path": s.peaktable_json_path,
            "b0": s.b0,
            "temperature": s.temperature,
            "carrier": s.carrier,
        })

    transformed_analyses = []
    for a in analyses_raw:
        u_height, c_b = parse_boolean(a.use_height)
        c_at, c_dt1 = parse_datetime_to_utc(a.created_at)
        comp_at, c_dt2 = parse_datetime_to_utc(a.completed_at)
        if c_b:
            coercion_stats["booleans"] += 1
        if c_dt1 or c_dt2:
            coercion_stats["datetimes"] += (c_dt1 + c_dt2)
        transformed_analyses.append({
            "id": a.id,
            "analysis_uuid": a.analysis_uuid,
            "name": a.name,
            "analysis_type": a.analysis_type,
            "status": a.status,
            "parameters": a.parameters,
            "project_id": a.project_id,
            "use_height": u_height,
            "created_at": c_at,
            "completed_at": comp_at,
            "results_path": a.results_path,
            "log_path": a.log_path,
            "error_message": a.error_message,
        })

    transformed_jobs = []
    for j in jobs_raw:
        c_at, c_dt1 = parse_datetime_to_utc(j.created_at)
        comp_at, c_dt2 = parse_datetime_to_utc(j.completed_at)
        if c_dt1 or c_dt2:
            coercion_stats["datetimes"] += (c_dt1 + c_dt2)
        transformed_jobs.append({
            "id": j.id,
            "job_uuid": j.job_uuid,
            "status": j.status,
            "total_clusters": j.total_clusters,
            "completed_clusters": j.completed_clusters,
            "processors": j.processors,
            "log_path": j.log_path,
            "celery_task_id": j.celery_task_id,
            "error_message": j.error_message,
            "created_at": c_at,
            "completed_at": comp_at,
            "project_id": j.project_id,
            "spectrum_id": j.spectrum_id,
        })

    transformed_assoc = [{"analysis_id": r[0], "spectrum_id": r[1]} for r in assoc_rows]

    logger.info(f"Type Coercion Report: {coercion_stats['booleans']} booleans normalized, {coercion_stats['datetimes']} datetimes converted to UTC.")

    if dry_run:
        logger.info("DRY-RUN SUMMARY:")
        logger.info(f"  - Users to insert: {len(transformed_users)}")
        logger.info(f"  - Projects to insert: {len(transformed_projects)}")
        logger.info(f"  - Spectra to insert: {len(transformed_spectra)}")
        logger.info(f"  - Analyses to insert: {len(transformed_analyses)}")
        logger.info(f"  - Jobs to insert: {len(transformed_jobs)}")
        logger.info(f"  - Analysis-Spectra links to insert: {len(transformed_assoc)}")
        logger.info(f"  - Sequences to advance: users_id_seq, projects_id_seq, spectra_id_seq, analyses_id_seq, jobs_id_seq")
        logger.info("Dry run completed successfully. No records were written.")
        return

    # 4. WRITE TO DESTINATION POSTGRESQL
    logger.info("Writing data to PostgreSQL in topological dependency order...")

    try:
        # Clear existing rows in target tables (in reverse topological order) to ensure clean migration
        dst_session.execute(text("TRUNCATE TABLE analysis_spectra, jobs, analyses, spectra, projects, users CASCADE;"))
        dst_session.commit()

        # Insert users
        if transformed_users:
            dst_session.execute(User.__table__.insert(), transformed_users)
        dst_session.commit()
        logger.info(f"Inserted {len(transformed_users)} users.")

        # Insert projects
        if transformed_projects:
            dst_session.execute(Project.__table__.insert(), transformed_projects)
        dst_session.commit()
        logger.info(f"Inserted {len(transformed_projects)} projects.")

        # Insert spectra
        if transformed_spectra:
            dst_session.execute(Spectrum.__table__.insert(), transformed_spectra)
        dst_session.commit()
        logger.info(f"Inserted {len(transformed_spectra)} spectra.")

        # Insert analyses
        if transformed_analyses:
            dst_session.execute(Analysis.__table__.insert(), transformed_analyses)
        dst_session.commit()
        logger.info(f"Inserted {len(transformed_analyses)} analyses.")

        # Insert jobs
        if transformed_jobs:
            dst_session.execute(Job.__table__.insert(), transformed_jobs)
        dst_session.commit()
        logger.info(f"Inserted {len(transformed_jobs)} jobs.")

        # Insert analysis_spectra
        if transformed_assoc:
            dst_session.execute(analysis_spectra.insert(), transformed_assoc)
        dst_session.commit()
        logger.info(f"Inserted {len(transformed_assoc)} analysis-spectra associations.")

    except Exception as e:
        dst_session.rollback()
        logger.error(f"Error during data insertion into PostgreSQL: {e}")
        raise e

    # 5. ADVANCE POSTGRES SEQUENCES
    logger.info("Advancing PostgreSQL sequences to match maximum primary keys...")
    tables_with_sequences = [
        ("users", "id"),
        ("projects", "id"),
        ("spectra", "id"),
        ("analyses", "id"),
        ("jobs", "id"),
    ]

    for table_name, pk_col in tables_with_sequences:
        # Get sequence name using pg_get_serial_sequence
        seq_query = text(f"SELECT pg_get_serial_sequence('{table_name}', '{pk_col}')")
        seq_name = dst_session.execute(seq_query).scalar()
        
        if seq_name:
            # Advance sequence to max(pk_col)
            setval_query = text(f"""
                SELECT setval(
                    '{seq_name}',
                    COALESCE((SELECT MAX({pk_col}) FROM {table_name}), 1),
                    (SELECT MAX({pk_col}) FROM {table_name}) IS NOT NULL
                )
            """)
            new_val = dst_session.execute(setval_query).scalar()
            logger.info(f"Sequence for table '{table_name}' ({seq_name}) advanced to: {new_val}")
        else:
            logger.warning(f"Could not find identity sequence for table '{table_name}'.")

    dst_session.commit()

    # 6. VERIFY ROW COUNTS (Source vs Destination)
    logger.info("Verifying post-migration row counts...")
    mismatch_found = False
    table_models = [
        ("users", User),
        ("projects", Project),
        ("spectra", Spectrum),
        ("analyses", Analysis),
        ("jobs", Job),
    ]

    print("\n" + "=" * 60)
    print(f"{'TABLE':<20} | {'SOURCE (SQLite)':<15} | {'DEST (Postgres)':<15} | {'STATUS'}")
    print("=" * 60)

    for tbl_name, model in table_models:
        src_cnt = src_session.query(model).count()
        dst_cnt = dst_session.query(model).count()
        status_str = "MATCH" if src_cnt == dst_cnt else "MISMATCH"
        print(f"{tbl_name:<20} | {src_cnt:<15} | {dst_cnt:<15} | {status_str}")
        if src_cnt != dst_cnt:
            mismatch_found = True

    # Check association table
    src_assoc_cnt = src_session.execute(text("SELECT COUNT(*) FROM analysis_spectra")).scalar()
    dst_assoc_cnt = dst_session.execute(text("SELECT COUNT(*) FROM analysis_spectra")).scalar()
    status_str = "MATCH" if src_assoc_cnt == dst_assoc_cnt else "MISMATCH"
    print(f"{'analysis_spectra':<20} | {src_assoc_cnt:<15} | {dst_assoc_cnt:<15} | {status_str}")
    if src_assoc_cnt != dst_assoc_cnt:
        mismatch_found = True

    print("=" * 60 + "\n")

    src_session.close()
    dst_session.close()

    if mismatch_found:
        logger.error("MIGRATION FAILED: Row count mismatch detected between SQLite and PostgreSQL!")
        sys.exit(1)

    logger.info("MIGRATION COMPLETED SUCCESSFULLY! All records migrated, validated, and sequences synchronized.")


if __name__ == "__main__":
    args = parse_args()
    run_migration(args.sqlite_path, args.pg_url, dry_run=args.dry_run)
