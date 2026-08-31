#!/usr/bin/env bash
set -euo pipefail

# resoFlow Automated PostgreSQL Backup Script
# Dumps the PostgreSQL database into compressed archives in ~/.local/share/resoflow/backups/

BACKUP_DIR="${HOME}/.local/share/resoflow/backups"
CONFIG_FILE="${HOME}/.config/resoflow/resoflow.env"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
TARGET_FILE="${BACKUP_DIR}/resoflow_backup_${TIMESTAMP}.sql.gz"
RETENTION_DAYS=14

mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"

if [ -f "${CONFIG_FILE}" ]; then
    # shellcheck source=/dev/null
    set -a
    source "${CONFIG_FILE}"
    set +a
fi

PG_USER="${POSTGRES_USER:-resoflow}"
PG_DB="${POSTGRES_DB:-resoflow}"

# Check if postgres container is running
if ! podman ps --filter "name=resoflow-postgres" --filter "status=running" -q | grep -q .; then
    echo "Warning: resoflow-postgres is not running. Backup skipped." >&2
    exit 0
fi

echo "Creating database backup to ${TARGET_FILE}..."
podman exec -i resoflow-postgres pg_dump -U "${PG_USER}" "${PG_DB}" | gzip -9 > "${TARGET_FILE}"
chmod 600 "${TARGET_FILE}"
echo "✓ Backup created successfully ($(du -h "${TARGET_FILE}" | cut -f1))."

# Clean up backups older than RETENTION_DAYS
echo "Cleaning up backups older than ${RETENTION_DAYS} days..."
find "${BACKUP_DIR}" -name "resoflow_backup_*.sql.gz" -type f -mtime +"${RETENTION_DAYS}" -delete 2>/dev/null || true
echo "✓ Backup retention policy enforced."
