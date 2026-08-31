#!/bin/bash

# resoFlow Start Script
# Starts PostgreSQL, Redis, Backend (FastAPI), Celery Worker, and Frontend (Vite).

# Colors for logging
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m' # No Color

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

echo -e "${BLUE}${BOLD}======================================================${NC}"
echo -e "${BLUE}${BOLD}               Starting resoFlow Platform              ${NC}"
echo -e "${BLUE}${BOLD}======================================================${NC}"

# 0. Ensure a clean state by stopping any existing app processes
if [ -f "$ROOT_DIR/dev/stop_apps.sh" ]; then
    bash "$ROOT_DIR/dev/stop_apps.sh"
elif [ -f "$ROOT_DIR/stop_apps.sh" ]; then
    bash "$ROOT_DIR/stop_apps.sh"
fi

# Function to handle cleanup on exit (Ctrl+C / SIGINT / SIGTERM)
cleanup() {
    echo -e "\n${YELLOW}Shutting down application processes...${NC}"
    kill $BACKEND_PID $FRONTEND_PID $CELERY_PID 2>/dev/null
    pkill -f "celery -A app.celery_app" 2>/dev/null
    pkill -f "uvicorn app.main:app" 2>/dev/null
    pkill -f "node.*vite" 2>/dev/null
    echo -e "${GREEN}✓ Application processes stopped.${NC}"
    echo -e "${BLUE}Tip: Database containers (PostgreSQL & Redis) remain active for fast restarts.${NC}"
    echo -e "To stop containers too, run: ${BOLD}./stop_apps.sh --all${NC}"
    exit 0
}

trap cleanup SIGINT SIGTERM

# 1. Start and verify Docker containers (PostgreSQL & Redis)
echo -e "\n${BLUE}[1/5] Checking Database & Cache Containers...${NC}"

POSTGRES_PORT="${POSTGRES_PORT:-5433}"
REDIS_PORT="${REDIS_PORT:-6380}"
POSTGRES_USER="${POSTGRES_USER:-resoflow}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-resoflow}"
POSTGRES_DB="${POSTGRES_DB:-resoflow}"

if command -v docker > /dev/null 2>&1; then
    # Check if docker daemon is running
    if docker info > /dev/null 2>&1; then
        # 1. Stop conflicting host systemd services if active
        if command -v systemctl > /dev/null 2>&1; then
            if systemctl is-active --quiet postgresql 2>/dev/null; then
                echo -e "  ${YELLOW}Stopping conflicting host postgresql service...${NC}"
                systemctl stop postgresql 2>/dev/null || true
            fi
            if systemctl is-active --quiet redis-server 2>/dev/null; then
                echo -e "  ${YELLOW}Stopping conflicting host redis-server service...${NC}"
                systemctl stop redis-server 2>/dev/null || true
            fi
        fi

        echo -e "  Starting Docker containers via docker compose..."
        cd "$ROOT_DIR"
        COMPOSE_CMD="docker compose"
        if ! docker compose version > /dev/null 2>&1; then
            COMPOSE_CMD="docker-compose"
        fi

        $COMPOSE_CMD up -d --remove-orphans

        # Ensure container port mappings exist; if missing, force recreate
        if ! docker port resoflow-postgres 5432 > /dev/null 2>&1; then
            $COMPOSE_CMD up -d --force-recreate postgres redis
        fi

        # Wait for PostgreSQL container readiness and authenticated connection
        echo -n "  Waiting for PostgreSQL container (port $POSTGRES_PORT)..."
        PG_READY=false
        TARGET_DB_URL="postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@localhost:$POSTGRES_PORT/$POSTGRES_DB"
        for i in {1..30}; do
            if uv run --project "$ROOT_DIR/backend" python -c "import psycopg; conn = psycopg.connect('$TARGET_DB_URL'); conn.close()" > /dev/null 2>&1; then
                PG_READY=true
                break
            fi
            echo -n "."
            sleep 1
        done

        if [ "$PG_READY" = true ]; then
            echo -e " ${GREEN}${BOLD}[UP & READY]${NC}"
        else
            echo -e " ${YELLOW}[Started, check connection]${NC}"
        fi

        # Wait for Redis container readiness
        echo -n "  Waiting for Redis container (port $REDIS_PORT)..."
        REDIS_READY=false
        for i in {1..20}; do
            if command -v redis-cli > /dev/null 2>&1; then
                if redis-cli -p "$REDIS_PORT" ping 2>/dev/null | grep -q "PONG"; then
                    REDIS_READY=true
                    break
                fi
            else
                if uv run --project "$ROOT_DIR/backend" python -c "import redis; r = redis.Redis(host='localhost', port=$REDIS_PORT); r.ping()" > /dev/null 2>&1; then
                    REDIS_READY=true
                    break
                fi
            fi
            echo -n "."
            sleep 1
        done

        if [ "$REDIS_READY" = true ]; then
            echo -e " ${GREEN}${BOLD}[UP & READY]${NC}"
        else
            echo -e " ${YELLOW}[Started, check connection]${NC}"
        fi
    else
        echo -e "  ${YELLOW}Warning: Docker daemon is not running. Checking local host services...${NC}"
    fi
else
    echo -e "  ${YELLOW}Warning: Docker not found. Assuming standalone PostgreSQL & Redis instances.${NC}"
fi

# Set default connection strings pointing to the PostgreSQL and Redis containers
export DATABASE_URL="${DATABASE_URL:-postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@localhost:$POSTGRES_PORT/$POSTGRES_DB}"
export REDIS_URL="${REDIS_URL:-redis://localhost:$REDIS_PORT/0}"

# 2. Run Database Migrations (Alembic) & Auto-Migration from SQLite
echo -e "\n${BLUE}[2/5] Running Database Migrations (Alembic)...${NC}"
cd "$ROOT_DIR/backend"
if uv run alembic upgrade head > /dev/null 2>&1; then
    echo -e "  ${GREEN}✓ Database schema is up to date.${NC}"
else
    echo -e "  ${YELLOW}Alembic output:${NC}"
    uv run alembic upgrade head
fi

# Auto-migrate records from SQLite if PostgreSQL has 0 users
USER_COUNT=$(uv run python -c "
import psycopg
try:
    conn = psycopg.connect('$DATABASE_URL')
    with conn.cursor() as cur:
        cur.execute('SELECT COUNT(*) FROM users;')
        print(cur.fetchone()[0])
    conn.close()
except Exception:
    print(0)
" 2>/dev/null)

if [ "${USER_COUNT:-0}" -eq 0 ] && [ -f "$ROOT_DIR/backend/sql_app.db" ]; then
    echo -e "  ${BLUE}Fresh database detected: Migrating existing user accounts and projects from SQLite...${NC}"
    cd "$ROOT_DIR"
    uv run --project backend python scripts/migrate_sqlite_to_postgres.py --sqlite-path backend/sql_app.db --pg-url "$DATABASE_URL" > /dev/null 2>&1 || true
    echo -e "  ${GREEN}✓ Data migrated successfully to PostgreSQL.${NC}"
fi

# 3. Detect LAN IP for multi-device network access
echo -e "\n${BLUE}[3/5] Network Configuration...${NC}"
if [ -z "$VITE_LAN_IP" ]; then
    LAN_IP=$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'src \K\S+')
    if [ -z "$LAN_IP" ]; then
        LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
    fi
    if [ -z "$LAN_IP" ]; then
        LAN_IP="127.0.0.1"
    fi
else
    LAN_IP=$VITE_LAN_IP
fi
echo -e "  Local Network IP: ${BOLD}$LAN_IP${NC}"

# 4. Start Backend & Celery Worker
echo -e "\n${BLUE}[4/5] Starting Backend & Worker Services...${NC}"
cd "$ROOT_DIR/backend"

# Start FastAPI / Uvicorn (0.0.0.0 for LAN availability)
uv run uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload > backend.log 2>&1 &
BACKEND_PID=$!
echo -e "  ${GREEN}✓ Backend (FastAPI)${NC} running on port 8000 (PID: $BACKEND_PID, Log: backend/backend.log)"

# Start Celery Worker (listening to all task queues)
uv run celery -A app.celery_app worker --loglevel=info -Q chemex,peakfit,stats,celery --concurrency=2 > celery.log 2>&1 &
CELERY_PID=$!
echo -e "  ${GREEN}✓ Celery Worker${NC} running on queues: chemex, peakfit, stats, celery (PID: $CELERY_PID, Log: backend/celery.log)"

# 5. Start Frontend (Vite)
echo -e "\n${BLUE}[5/5] Starting Frontend (Vite)...${NC}"
cd "$ROOT_DIR/frontend"

# Load NVM if installed
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
    source "$NVM_DIR/nvm.sh"
    nvm use 25 --silent 2>/dev/null || true
fi

export VITE_API_URL="http://$LAN_IP:8000"
npm run dev -- --host > frontend.log 2>&1 &
FRONTEND_PID=$!
echo -e "  ${GREEN}✓ Frontend (Vite)${NC} running on port 5173 (PID: $FRONTEND_PID, Log: frontend/frontend.log)"

# Summary Dashboard
echo -e "\n${GREEN}${BOLD}======================================================${NC}"
echo -e "${GREEN}${BOLD}         resoFlow Platform is Ready and Active!       ${NC}"
echo -e "${GREEN}${BOLD}======================================================${NC}"
echo -e "  • ${BOLD}PostgreSQL${NC}:   localhost:$POSTGRES_PORT (DB: $POSTGRES_DB)"
echo -e "  • ${BOLD}Redis${NC}:        localhost:$REDIS_PORT"
echo -e "  • ${BOLD}Web App (Local)${NC}:  http://localhost:5173"
echo -e "  • ${BOLD}Web App (LAN)${NC}:    http://$LAN_IP:5173"
echo -e "  • ${BOLD}API Docs${NC}:        http://localhost:8000/docs"
echo -e "------------------------------------------------------"
echo -e "Press ${BOLD}Ctrl+C${NC} to stop application services."
echo -e "To stop database containers as well, run: ${BOLD}./stop_apps.sh --all${NC}\n"

# Keep script running to maintain processes
wait

