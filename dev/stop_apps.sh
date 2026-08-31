#!/bin/bash

# resoFlow Stop Script
# Gracefully stops Backend, Celery, and Frontend processes, with optional Docker container management.

# Colors for logging
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m' # No Color

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

STOP_DOCKER=false
DOCKER_DOWN=false

# Parse arguments
while [[ "$#" -gt 0 ]]; do
    case $1 in
        --all|--docker) STOP_DOCKER=true ;;
        --down) DOCKER_DOWN=true ;;
        -h|--help)
            echo -e "${BOLD}resoFlow Graceful Shutdown Utility${NC}"
            echo -e "Usage: ./stop_apps.sh [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  (no args)       Gracefully stop Backend (FastAPI), Celery worker, and Frontend (Vite)"
            echo "  --all, --docker Gracefully stop app processes AND stop Docker containers (resoflow-postgres, resoflow-redis)"
            echo "  --down          Gracefully stop app processes AND tear down Docker containers (docker compose down)"
            echo "  -h, --help      Display this help message"
            exit 0
            ;;
        *) echo -e "${RED}Unknown parameter: $1${NC}. Use --help for usage."; exit 1 ;;
    esac
    shift
done

echo -e "${BLUE}${BOLD}Stopping resoFlow services...${NC}"

# 1. Gracefully stop Celery Workers
echo -e "${YELLOW}Shutting down Celery workers (SIGTERM)...${NC}"
CELERY_PIDS=$(pgrep -f "celery -A app.celery_app" 2>/dev/null)
if [ -n "$CELERY_PIDS" ]; then
    kill -TERM $CELERY_PIDS 2>/dev/null
    # Wait up to 5 seconds for Celery workers to finish/abort active tasks gracefully
    for i in {1..5}; do
        if ! pgrep -f "celery -A app.celery_app" > /dev/null 2>&1; then
            break
        fi
        sleep 1
    done
    # Force kill if still hanging
    if pgrep -f "celery -A app.celery_app" > /dev/null 2>&1; then
        pkill -9 -f "celery -A app.celery_app" 2>/dev/null
        echo -e "  ${RED}Celery workers forcibly killed.${NC}"
    else
        echo -e "  ${GREEN}Celery workers exited cleanly.${NC}"
    fi
else
    echo "  No running Celery workers found."
fi

# 2. Gracefully stop FastAPI / Uvicorn Backend
echo -e "${YELLOW}Shutting down FastAPI Backend...${NC}"
UVICORN_PIDS=$(pgrep -f "uvicorn app.main:app" 2>/dev/null)
if [ -n "$UVICORN_PIDS" ]; then
    kill -TERM $UVICORN_PIDS 2>/dev/null
    for i in {1..3}; do
        if ! pgrep -f "uvicorn app.main:app" > /dev/null 2>&1; then
            break
        fi
        sleep 1
    done
    pkill -9 -f "uvicorn app.main:app" 2>/dev/null
fi

if [ -x "$(command -v fuser)" ]; then
    fuser -k 8000/tcp 2>/dev/null && echo "  Port 8000 cleared."
fi
echo -e "  ${GREEN}Backend stopped.${NC}"

# 3. Gracefully stop Frontend / Vite
echo -e "${YELLOW}Shutting down Frontend (Vite)...${NC}"
pkill -f "node.*vite" 2>/dev/null || pkill -f "npm run dev" 2>/dev/null
if [ -x "$(command -v fuser)" ]; then
    fuser -k 5173/tcp 2>/dev/null && echo "  Port 5173 cleared."
fi
echo -e "  ${GREEN}Frontend stopped.${NC}"

# 4. Handle Docker Containers if requested
if [ "$DOCKER_DOWN" = true ]; then
    echo -e "${YELLOW}Tearing down Docker containers (docker compose down)...${NC}"
    cd "$ROOT_DIR"
    if command -v docker > /dev/null 2>&1 && docker compose version > /dev/null 2>&1; then
        docker compose down
    elif command -v docker-compose > /dev/null 2>&1; then
        docker-compose down
    fi
    echo -e "  ${GREEN}Docker containers stopped and removed.${NC}"
elif [ "$STOP_DOCKER" = true ]; then
    echo -e "${YELLOW}Stopping Docker database & cache containers (docker compose stop)...${NC}"
    cd "$ROOT_DIR"
    if command -v docker > /dev/null 2>&1 && docker compose version > /dev/null 2>&1; then
        docker compose stop
    elif command -v docker-compose > /dev/null 2>&1; then
        docker-compose stop
    fi
    echo -e "  ${GREEN}Docker containers (resoflow-postgres, resoflow-redis) stopped.${NC}"
else
    # Show container status if running
    if command -v docker > /dev/null 2>&1; then
        RUNNING_CONTAINERS=$(docker ps --filter "name=resoflow-" --format "{{.Names}} ({{.Status}})" 2>/dev/null)
        if [ -n "$RUNNING_CONTAINERS" ]; then
            echo ""
            echo -e "${BLUE}Active database containers:${NC}"
            echo "$RUNNING_CONTAINERS" | while read -r line; do
                echo -e "  • $line"
            done
            echo -e "${YELLOW}Tip: To stop the database containers as well, run: ${BOLD}./stop_apps.sh --all${NC}"
        fi
    fi
fi

echo ""
echo -e "${GREEN}${BOLD}✓ All requested resoFlow services stopped successfully.${NC}"
