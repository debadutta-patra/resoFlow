#!/usr/bin/env bash
set -euo pipefail

# resoFlow macOS Service Supervisor Script for launchd

CONFIG_DIR="${HOME}/.config/resoflow"
ENV_FILE="${CONFIG_DIR}/resoflow.env"

ensure_podman_machine() {
    if ! command -v podman >/dev/null 2>&1; then
        echo "Error: 'podman' CLI is not installed." >&2
        exit 1
    fi

    # Check if a machine exists and is running
    if podman machine info >/dev/null 2>&1; then
        # Machine is responsive
        return 0
    fi

    echo "Starting Podman machine..."
    if ! podman machine start; then
        echo "Initializing default Podman machine..."
        podman machine init --cpus 4 --memory 8192 --disk-size 50
        podman machine start
    fi
}

start_pod() {
    ensure_podman_machine

    if [ ! -f "${ENV_FILE}" ]; then
        echo "Error: Configuration file not found at ${ENV_FILE}. Please run ./deploy/install.sh first." >&2
        exit 1
    fi

    # Check if pod exists
    if podman pod exists resoflow 2>/dev/null; then
        echo "Starting existing resoFlow pod..."
        podman pod start resoflow
    else
        echo "Creating and starting resoFlow pod..."
        # Source environment
        # shellcheck source=/dev/null
        set -a; source "${ENV_FILE}"; set +a

        WEB_PORT="${WEB_PORT:-8080}"
        API_PORT="${API_PORT:-8000}"
        DATA_DIR="${RESOFLOW_HOST_DATA_ROOT:-${HOME}/.local/share/resoflow/projects}"

        # Ensure persistent volumes
        podman volume exists resoflow-pgdata 2>/dev/null || podman volume create resoflow-pgdata >/dev/null
        podman volume exists resoflow-redisdata 2>/dev/null || podman volume create resoflow-redisdata >/dev/null

        # Create pod with published web port
        podman pod create --name resoflow -p "127.0.0.1:${WEB_PORT}:${WEB_PORT}"

        # Start PostgreSQL
        podman run -d --name resoflow-postgres --pod resoflow --restart always \
            --env-file "${ENV_FILE}" \
            -v resoflow-pgdata:/var/lib/postgresql/data:Z \
            docker.io/library/postgres:16-alpine

        # Start Redis
        podman run -d --name resoflow-redis --pod resoflow --restart always \
            -v resoflow-redisdata:/data:Z \
            docker.io/library/redis:7-alpine redis-server --appendonly yes

        # Start API (Wait for PostgreSQL)
        podman run -d --name resoflow-api --pod resoflow --restart always \
            --env-file "${ENV_FILE}" \
            -v "${DATA_DIR}:/data/projects" \
            localhost/resoflow-api:latest \
            sh -c "alembic upgrade head && exec uvicorn app.main:app --host 0.0.0.0 --port ${API_PORT}"

        # Start Celery Worker (mount Podman socket for ChemEx container execution)
        PODMAN_SOCK="$(podman info --format '{{.Host.RemoteSocket.Path}}' 2>/dev/null || echo '/run/user/1000/podman/podman.sock')"
        podman run -d --name resoflow-worker --pod resoflow --restart always \
            --env-file "${ENV_FILE}" \
            --env CONTAINER_HOST=unix:///run/podman/podman.sock \
            -v "${DATA_DIR}:/data/projects" \
            -v "${PODMAN_SOCK}:/run/podman/podman.sock" \
            localhost/resoflow-worker:latest

        # Start Web Proxy (Caddy)
        podman run -d --name resoflow-web --pod resoflow --restart always \
            --env-file "${ENV_FILE}" \
            localhost/resoflow-web:latest
    fi

    echo "resoFlow pod is running."
}

stop_pod() {
    echo "Stopping resoFlow pod..."
    if podman pod exists resoflow 2>/dev/null; then
        podman pod stop resoflow || true
    fi
}

status_pod() {
    ensure_podman_machine
    if podman pod exists resoflow 2>/dev/null; then
        podman pod ps --filter name=resoflow
        echo ""
        podman ps --filter pod=resoflow
    else
        echo "resoFlow pod does not exist."
    fi
}

case "${1:-start}" in
    start)
        start_pod
        ;;
    stop)
        stop_pod
        ;;
    restart)
        stop_pod
        sleep 2
        start_pod
        ;;
    status)
        status_pod
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status}" >&2
        exit 1
        ;;
esac
