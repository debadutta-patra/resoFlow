# resoFlow Database Cutover & Migration Runbook

This document details the operational procedure for migrating resoFlow persistence from SQLite (`backend/sql_app.db`) to PostgreSQL using Alembic and the data migration script (`scripts/migrate_sqlite_to_postgres.py`).

---

## 1. Connection Pool Sizing Arithmetic

To prevent connection starvation, pool exhaustion, and intermittent database errors, connection pools must be sized deliberately against PostgreSQL's `max_connections`.

### Formula

$$\text{Total Potential Connections} = (N_{\text{api}} \times (S_{\text{pool}} + O_{\text{overflow}})) + (N_{\text{celery}} \times (S_{\text{pool}} + O_{\text{overflow}})) \le C_{\text{max}} - B_{\text{reserved}}$$

Where:
- $N_{\text{api}}$ = Number of FastAPI / Uvicorn worker processes
- $N_{\text{celery}}$ = Number of Celery prefork child processes (or concurrency level)
- $S_{\text{pool}}$ = SQLAlchemy `pool_size` (default: 5)
- $O_{\text{overflow}}$ = SQLAlchemy `max_overflow` (default: 10)
- $C_{\text{max}}$ = PostgreSQL `max_connections` (default: 100)
- $B_{\text{reserved}}$ = Reserved connections for administrative/superuser access and psql sessions (minimum: 15)

### Standard Deployment Arithmetic

With 1 FastAPI process and 4 Celery worker concurrency on default PostgreSQL ($C_{\text{max}} = 100$):

$$\text{FastAPI Connections} = 1 \times (5 + 10) = 15$$
$$\text{Celery Connections} = 4 \times (5 + 10) = 60$$
$$\text{Total Peak Connections} = 15 + 60 = 75 \le 85 \quad (100 - 15 \text{ buffer})$$

Environment variable overrides:
- `DB_POOL_SIZE` (default: 5)
- `DB_MAX_OVERFLOW` (default: 10)
- `DB_POOL_RECYCLE` (default: 1800 seconds / 30 minutes)

---

## 2. Pre-Flight Checklist & Environment Variables

Ensure the following environment variables are configured in the environment or `.env` file:

```bash
# PostgreSQL Connection URL
DATABASE_URL="postgresql://resoflow:resoflow@localhost:5432/resoflow"

# Redis Broker URL
REDIS_URL="redis://localhost:6379/0"
```

---

## 3. Step-by-Step Cutover Procedure

```
  [1. Stop Services] ───> [2. Backup SQLite & PG] ───> [3. Alembic Schema Init]
           │                         │                           │
           ▼                         ▼                           ▼
  [4. Migration Dry-Run] ─> [5. Live Data Migration] ─> [6. API Smoke-Test]
                                                                 │
                                                                 ▼
                                                       [7. Celery E2E Test]
                                                                 │
                                                                 ▼
                                                       [8. Cutover Complete]
```

### Step 1: Stop API and Celery Workers
Stop all running instances of FastAPI and Celery workers to prevent new writes to SQLite.

```bash
# If using dev/start scripts:
./stop_apps.sh

# Verify no python/celery processes are running:
pkill -f "uvicorn app.main:app"
pkill -f "celery -A app.celery_app"
```

> **Go / No-Go Criterion 1**: Verify no processes hold open locks on `sql_app.db` (`fuser backend/sql_app.db` returns empty).

---

### Step 2: Back Up SQLite and PostgreSQL Target
Create a timestamped backup of the authoritative SQLite database and dump the target PostgreSQL database.

```bash
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# 1. Back up SQLite database
cp backend/sql_app.db "backend/sql_app.db.bak_${TIMESTAMP}"
[ -f "backend/sql_app.db-wal" ] && cp backend/sql_app.db-wal "backend/sql_app.db-wal.bak_${TIMESTAMP}"
[ -f "backend/sql_app.db-shm" ] && cp backend/sql_app.db-shm "backend/sql_app.db-shm.bak_${TIMESTAMP}"

# 2. Dump PostgreSQL target (even if empty)
pg_dump -h localhost -p 5432 -U resoflow -d resoflow -F c -b -v -f "resoflow_pg_pre_migration_${TIMESTAMP}.dump"
```

> **Go / No-Go Criterion 2**: Confirm backup files exist and are non-zero in size:
> `ls -lh backend/sql_app.db.bak_*`

---

### Step 3: Apply Alembic Migrations to PostgreSQL
Run Alembic against the target PostgreSQL database to provision the complete schema with constraints and indexes.

```bash
cd backend
DATABASE_URL="postgresql://resoflow:resoflow@localhost:5432/resoflow" uv run alembic upgrade head
```

> **Go / No-Go Criterion 3**: Verify Alembic reports `Running upgrade -> <revision>, baseline_schema` and `uv run alembic current` reports `(head)`.

---

### Step 4: Run Data Migration Dry-Run
Execute the migration script in `--dry-run` mode to perform pre-flight foreign key validation, schema checks, and type coercion simulations without writing records.

```bash
uv run --project backend python scripts/migrate_sqlite_to_postgres.py \
    --sqlite-path backend/sql_app.db \
    --pg-url "postgresql://resoflow:resoflow@localhost:5432/resoflow" \
    --dry-run
```

> **Go / No-Go Criterion 4**: The output must end with:
> `Referential integrity check PASSED: 0 orphan rows.`
> `Dry run completed successfully. No records were written.`
> **If any foreign key error or type error is reported, STOP IMMEDIATELY.**

---

### Step 5: Execute Live Data Migration & Sequence Synchronization
Run the data migration script to copy all tables in topological order, convert datetimes to UTC, coerce booleans, and synchronize primary key sequences.

```bash
uv run --project backend python scripts/migrate_sqlite_to_postgres.py \
    --sqlite-path backend/sql_app.db \
    --pg-url "postgresql://resoflow:resoflow@localhost:5432/resoflow"
```

> **Go / No-Go Criterion 5**: 
> 1. All table row counts between SQLite and PostgreSQL report `MATCH` in the summary table.
> 2. All sequences (`users_id_seq`, `projects_id_seq`, `spectra_id_seq`, `analyses_id_seq`, `jobs_id_seq`) are advanced to their respective maximum primary key IDs.

---

### Step 6: Start FastAPI Backend and Smoke-Test
Launch the FastAPI backend with `DATABASE_URL` pointing to PostgreSQL and smoke-test essential endpoints.

```bash
cd backend
export DATABASE_URL="postgresql://resoflow:resoflow@localhost:5432/resoflow"
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Smoke-test endpoints:
1. **Health / Login**: `POST http://127.0.0.1:8000/auth/login` (obtain JWT token)
2. **Projects List**: `GET http://127.0.0.1:8000/api/projects` (verify project list matches SQLite)
3. **Dashboard**: `GET http://127.0.0.1:8000/api/users/me/dashboard` (verify stats and recent analyses)

> **Go / No-Go Criterion 6**: All 3 smoke-test requests return HTTP 200 with complete JSON payloads matching pre-migration outputs.

---

### Step 7: Start Celery Workers & End-to-End Analysis Test
Start Celery workers with PostgreSQL and submit a test analysis to verify concurrent worker updates.

```bash
cd backend
export DATABASE_URL="postgresql://resoflow:resoflow@localhost:5432/resoflow"
export REDIS_URL="redis://localhost:6379/0"
uv run celery -A app.celery_app worker --loglevel=info -c 4
```

1. Submit a peak-fitting or relaxation task from the frontend or API.
2. Monitor `celery.log` and verify:
   - Worker processes initialize and execute `engine.dispose(close=True)` on fork.
   - Status updates transition smoothly: `PENDING` $\to$ `RUNNING` $\to$ `COMPLETED`.
   - No `database is locked` or connection error messages occur.

> **Go / No-Go Criterion 7**: The test analysis finishes with status `COMPLETED` and fitted parameters are written to the database.

---

### Step 8: Mark SQLite as Read-Only Artifact
Once Step 7 passes, lock the SQLite file to prevent accidental modifications:

```bash
chmod 444 backend/sql_app.db
[ -f backend/sql_app.db-wal ] && chmod 444 backend/sql_app.db-wal
[ -f backend/sql_app.db-shm ] && chmod 444 backend/sql_app.db-shm
```

Cutover is complete. PostgreSQL is now the authoritative persistence store.

---

## 4. Rollback Procedure

If any Go/No-Go criterion fails before Step 8 is finalized, execute the following rollback:

1. **Stop Services**:
   ```bash
   pkill -f "uvicorn app.main:app"
   pkill -f "celery -A app.celery_app"
   ```
2. **Revert SQLite Database**:
   Restore SQLite files from the backup created in Step 2:
   ```bash
   cp "backend/sql_app.db.bak_${TIMESTAMP}" backend/sql_app.db
   ```
3. **Reset Environment**:
   Unset `DATABASE_URL` or reset it to SQLite in deployment configuration:
   ```bash
   unset DATABASE_URL
   ```
4. **Restart Services on SQLite**:
   ```bash
   ./start_apps.sh
   ```
5. **Clean PostgreSQL Target**:
   ```bash
   PGPASSWORD=resoflow psql -h localhost -p 5432 -U resoflow -d resoflow -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
   ```

---

## 5. PostgreSQL Backup & Restore Procedures

### Periodic / Pre-Migration Backup

A `pg_dump` must be executed immediately before every `alembic upgrade` in production:

```bash
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
pg_dump -h localhost -p 5432 -U resoflow -d resoflow -F c -b -v -f "/var/backups/resoflow_backup_${TIMESTAMP}.dump"
```

### Database Restore Procedure

To restore from a `.dump` backup file:

```bash
# 1. Terminate existing connections to database
PGPASSWORD=resoflow psql -h localhost -p 5432 -U resoflow -d postgres -c "
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'resoflow' AND pid <> pg_backend_pid();
"

# 2. Drop and recreate database
PGPASSWORD=resoflow psql -h localhost -p 5432 -U resoflow -d postgres -c "DROP DATABASE IF EXISTS resoflow; CREATE DATABASE resoflow OWNER resoflow;"

# 3. Restore schema and data
pg_restore -h localhost -p 5432 -U resoflow -d resoflow -v "/var/backups/resoflow_backup_<TIMESTAMP>.dump"
```

---

## 6. Proposed Follow-Up Revisions

The following schema enhancements are proposed for subsequent dedicated changes:

1. **Native `JSONB` for `Analysis.parameters`**:
   - Currently stored as `VARCHAR` / `TEXT`.
   - Migration will alter column `parameters` from `TEXT` to `JSONB USING parameters::jsonb`.
   - Pydantic models and routers will be updated to accept dictionary objects natively.

2. **Native PostgreSQL `UUID` Type**:
   - Currently `project_uuid`, `spectrum_uuid`, `job_uuid`, and `analysis_uuid` are stored as `VARCHAR(32)` / `VARCHAR(36)`.
   - Migration will alter columns to `UUID USING uuid_column::uuid`.
   - SQLAlchemy models will transition to `sa.dialects.postgresql.UUID(as_uuid=True)`.
