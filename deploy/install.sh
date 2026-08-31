#!/usr/bin/env bash
set -euo pipefail

# resoFlow Rootless Podman Quadlet Deployment Script

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo -e "${BLUE}${BOLD}======================================================${NC}"
echo -e "${BLUE}${BOLD}          resoFlow Rootless Podman Installer          ${NC}"
echo -e "${BLUE}${BOLD}======================================================${NC}"

# 1. Pre-flight checks
if ! command -v podman > /dev/null 2>&1; then
    echo -e "${RED}Error: 'podman' is not installed. Please install Podman 5.x first.${NC}" >&2
    exit 1
fi

if ! command -v systemctl > /dev/null 2>&1; then
    echo -e "${RED}Error: 'systemctl' is not available. Systemd is required for Quadlet.${NC}" >&2
    exit 1
fi

# Check subuid/subgid mapping
if [ ! -r /etc/subuid ] || ! grep -q "^${USER}:" /etc/subuid 2>/dev/null; then
    echo -e "${YELLOW}Warning: User '${USER}' does not have a subuid mapping in /etc/subuid. Rootless Podman may fail.${NC}"
fi

# 1b. Load offline images if present in bundle
if [ -d "${SCRIPT_DIR}/images" ]; then
    echo -e "\n${BLUE}[0/5] Loading offline container images from ${SCRIPT_DIR}/images...${NC}"
    for archive in "${SCRIPT_DIR}/images/"*.tar*; do
        if [ -f "${archive}" ]; then
            echo -e "  Loading ${archive}..."
            podman load -i "${archive}"
        fi
    done
    echo -e "${GREEN}✓ Offline images loaded.${NC}"
fi

# 2. Directory setup
QUADLET_DIR="${HOME}/.config/containers/systemd"
CONFIG_DIR="${HOME}/.config/resoflow"
DATA_DIR="${HOME}/.local/share/resoflow/projects"

mkdir -p "${QUADLET_DIR}" "${CONFIG_DIR}" "${DATA_DIR}"
chmod 700 "${CONFIG_DIR}"

# 3. Dynamic Secrets Generation
ENV_FILE="${CONFIG_DIR}/resoflow.env"
if [ ! -f "${ENV_FILE}" ]; then
    echo -e "\n${BLUE}[1/5] Generating secure environment secrets in ${ENV_FILE}...${NC}"
    
    gen_secret() {
        if command -v openssl > /dev/null 2>&1; then
            openssl rand -hex "$1"
        else
            python3 -c "import secrets; print(secrets.token_hex($1))"
        fi
    }

    PG_PASS="$(gen_secret 16)"
    SECRET_KEY="$(gen_secret 32)"
    PG_USER="resoflow"
    PG_DB="resoflow"

    cat <<EOF > "${ENV_FILE}"
# resoFlow Runtime Environment Configuration
POSTGRES_USER=${PG_USER}
POSTGRES_PASSWORD=${PG_PASS}
POSTGRES_DB=${PG_DB}
DATABASE_URL=postgresql://${PG_USER}:${PG_PASS}@127.0.0.1:5432/${PG_DB}
REDIS_URL=redis://127.0.0.1:6379/0
SECRET_KEY=${SECRET_KEY}
ALGORITHM=HS256
ACCESS_TOKEN_EXPIRE_MINUTES=1440
PROJECTS_STORAGE_PATH=/data/projects
RESOFLOW_HOST_DATA_ROOT=${DATA_DIR}
RESOFLOW_CONTAINER_DATA_ROOT=/data/projects
RESOFLOW_CHEMEX_IMAGE=localhost/resoflow-chemex:latest
EOF
    chmod 600 "${ENV_FILE}"
    echo -e "${GREEN}✓ Generated ${ENV_FILE} with permissions 600.${NC}"
else
    echo -e "\n${BLUE}[1/5] Using existing environment configuration at ${ENV_FILE}.${NC}"
fi

# 4. Copy Quadlet Unit Files
echo -e "\n${BLUE}[2/5] Installing Quadlet unit files into ${QUADLET_DIR}...${NC}"
cp -f "${SCRIPT_DIR}/quadlet/"*.pod "${QUADLET_DIR}/" 2>/dev/null || true
cp -f "${SCRIPT_DIR}/quadlet/"*.volume "${QUADLET_DIR}/" 2>/dev/null || true
cp -f "${SCRIPT_DIR}/quadlet/"*.container "${QUADLET_DIR}/" 2>/dev/null || true
echo -e "${GREEN}✓ Quadlet units installed.${NC}"

# 5. Enable Podman Socket and Linger
echo -e "\n${BLUE}[3/5] Configuring systemd user services & Podman socket...${NC}"
systemctl --user enable --now podman.socket > /dev/null 2>&1 || true

if command -v loginctl > /dev/null 2>&1; then
    loginctl enable-linger "${USER}" 2>/dev/null || true
fi

# 6. Daemon reload and start pod
echo -e "\n${BLUE}[4/5] Reloading systemd user daemon and starting resoFlow pod...${NC}"
systemctl --user daemon-reload
systemctl --user restart resoflow-pod.service

# 7. Health & Readiness Verification
echo -e "\n${BLUE}[5/5] Verifying service readiness...${NC}"
echo -n "  Waiting for web interface (http://127.0.0.1:8080)..."

READY=false
for i in {1..30}; do
    if curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8080 2>/dev/null | grep -qE "200|301|302|404"; then
        READY=true
        break
    fi
    echo -n "."
    sleep 1
done

echo ""
if [ "$READY" = true ]; then
    echo -e "${GREEN}${BOLD}✓ resoFlow is successfully running!${NC}"
    echo -e "\n${BLUE}${BOLD}Access resoFlow in your web browser:${NC}"
    echo -e "  ${GREEN}${BOLD}http://127.0.0.1:8080${NC}\n"
    echo -e "${BLUE}Systemd management commands:${NC}"
    echo -e "  Status:  ${BOLD}systemctl --user status resoflow-pod.service${NC}"
    echo -e "  Logs:    ${BOLD}journalctl --user -u resoflow-api -u resoflow-worker -f${NC}"
    echo -e "  Stop:    ${BOLD}systemctl --user stop resoflow-pod.service${NC}"
    echo -e "  Restart: ${BOLD}systemctl --user restart resoflow-pod.service${NC}"
else
    echo -e "${YELLOW}Warning: Services started, but healthcheck timed out. Check container logs:${NC}"
    echo -e "  ${BOLD}journalctl --user -u resoflow-api.service -n 50${NC}"
fi
