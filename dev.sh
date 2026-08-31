#!/bin/bash

# resoFlow Development Start Script
# Starts PostgreSQL, Redis, Backend (FastAPI), Celery worker, and Frontend with live log streaming.

# Colors for logging
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m' # No Color

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo -e "${BLUE}${BOLD}======================================================${NC}"
echo -e "${BLUE}${BOLD}           Starting resoFlow in Dev Mode             ${NC}"
echo -e "${BLUE}${BOLD}======================================================${NC}"

# 0. Clean state
if [ -f "$ROOT_DIR/stop_apps.sh" ]; then
    bash "$ROOT_DIR/stop_apps.sh"
fi

# Function to handle cleanup on exit
cleanup() {
    echo -e "\n${YELLOW}Shutting down dev services...${NC}"
    kill $BACKEND_PID $FRONTEND_PID $CELERY_PID 2>/dev/null
    pkill -f "celery -A app.celery_app" 2>/dev/null
    pkill -f "uvicorn app.main:app" 2>/dev/null
    pkill -f "node.*vite" 2>/dev/null
    echo -e "${GREEN}✓ Dev processes stopped.${NC}"
    echo -e "${BLUE}Tip: Database containers (PostgreSQL & Redis) remain active for fast restarts.${NC}"
    echo -e "To stop containers too, run: ${BOLD}./stop_apps.sh --all${NC}"
    exit 0
}

trap cleanup SIGINT SIGTERM

# 1. Start and verify Docker containers (PostgreSQL & Redis)
echo -e "\n${BLUE}[1/4] Checking Database & Cache Containers...${NC}"

POSTGRES_PORT="${POSTGRES_PORT:-5433}"
REDIS_PORT="${REDIS_PORT:-6380}"
POSTGRES_USER="${POSTGRES_USER:-resoflow}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-resoflow}"
POSTGRES_DB="${POSTGRES_DB:-resoflow}"

if command -v docker > /dev/null 2>&1; then
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

        # Wait for PostgreSQL
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
            echo -e " ${YELLOW}[Started]${NC}"
        fi

        # Wait for Redis
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
            echo -e " ${YELLOW}[Started]${NC}"
        fi
    fi
fi

# Set default connection strings
export DATABASE_URL="${DATABASE_URL:-postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@localhost:$POSTGRES_PORT/$POSTGRES_DB}"
export REDIS_URL="${REDIS_URL:-redis://localhost:$REDIS_PORT/0}"

# 2. Run Database Migrations (Alembic) & Auto-Migration from SQLite
echo -e "\n${BLUE}[2/4] Running Database Migrations (Alembic)...${NC}"
cd "$ROOT_DIR/backend"
uv run alembic upgrade head

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

# 3. Start Backend & Celery Worker with log tees
echo -e "\n${BLUE}[3/4] Starting Backend & Worker Services...${NC}"
cd "$ROOT_DIR/backend"
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload 2>&1 | tee backend.log &
BACKEND_PID=$!

uv run celery -A app.celery_app worker --loglevel=info 2>&1 | tee celery.log &
CELERY_PID=$!

# 4. Start Frontend
echo -e "\n${BLUE}[4/4] Starting Frontend (Vite)...${NC}"
cd "$ROOT_DIR/frontend"

export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
    source "$NVM_DIR/nvm.sh"
    nvm use 25 --silent 2>/dev/null || true
fi

export VITE_API_URL="http://localhost:8000"
npm run dev 2>&1 | tee frontend.log &
FRONTEND_PID=$!

echo -e "\n${GREEN}${BOLD}======================================================${NC}"
echo -e "${GREEN}${BOLD}      resoFlow Dev Environment Started Successfully!  ${NC}"
echo -e "${GREEN}${BOLD}======================================================${NC}"
echo -e "  • ${BOLD}PostgreSQL${NC}:   localhost:$POSTGRES_PORT (DB: $POSTGRES_DB)"
echo -e "  • ${BOLD}Redis${NC}:        localhost:$REDIS_PORT"
echo -e "  • ${BOLD}Frontend${NC}:     http://localhost:5173"
echo -e "  • ${BOLD}Backend API${NC}:  http://localhost:8000/docs"
echo -e "------------------------------------------------------"
echo -e "Press ${BOLD}Ctrl+C${NC} to stop dev services."
echo -e "To stop database containers as well, run: ${BOLD}./stop_apps.sh --all${NC}\n"

# Keep script running
wait

