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

# Default settings
BASE_PORT="8080"
API_PORT=""
DATA_DIR="${HOME}/.local/share/resoflow/projects"
ADMIN_EMAIL=""
ADMIN_PASSWORD=""
ADMIN_NAME="Administrator"
CREATE_ADMIN=""
NON_INTERACTIVE=false
BIND_HOST="127.0.0.1"

usage() {
    cat << 'EOF'
Usage: ./deploy/install.sh [OPTIONS]

Options:
  -p, --port PORT          Base port for resoFlow services (default: 8080)
                           Allocates PORT for Web UI and PORT+1 for API (or 8000 if port is 8080)
      --api-port PORT      Override internal backend API port
      --lan                Allow access over local network (binds to 0.0.0.0 instead of 127.0.0.1)
      --bind IP            Bind IP address for Web UI (default: 127.0.0.1)
  -d, --data-dir PATH      Host storage directory for projects and spectra
                           (default: ~/.local/share/resoflow/projects)
      --admin-email EMAIL  Initial administrator account email
      --admin-password PWD Initial administrator account password
      --admin-name NAME    Initial administrator full name (default: "Administrator")
      --skip-admin         Skip administrator account creation
  -y, --non-interactive    Run non-interactively with provided flags or defaults
  -h, --help               Show this help message and exit

Examples:
  ./deploy/install.sh
  ./deploy/install.sh --lan --port 50000 --data-dir /data
  ./deploy/install.sh -y --port 8080 --admin-email admin@lab.org --admin-password secret
EOF
    exit 0
}

# Parse command-line options
while [[ $# -gt 0 ]]; do
    case "$1" in
        -p|--port)
            BASE_PORT="$2"
            shift 2
            ;;
        --api-port)
            API_PORT="$2"
            shift 2
            ;;
        --lan)
            BIND_HOST="0.0.0.0"
            shift
            ;;
        --bind)
            BIND_HOST="$2"
            shift 2
            ;;
        -d|--data-dir)
            DATA_DIR="$2"
            shift 2
            ;;
        --admin-email)
            ADMIN_EMAIL="$2"
            CREATE_ADMIN="true"
            shift 2
            ;;
        --admin-password)
            ADMIN_PASSWORD="$2"
            CREATE_ADMIN="true"
            shift 2
            ;;
        --admin-name)
            ADMIN_NAME="$2"
            shift 2
            ;;
        --skip-admin|--no-admin)
            CREATE_ADMIN="false"
            shift
            ;;
        -y|--non-interactive)
            NON_INTERACTIVE=true
            shift
            ;;
        -h|--help)
            usage
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}" >&2
            echo "Use --help for usage information." >&2
            exit 1
            ;;
    esac
done

echo -e "${BLUE}${BOLD}======================================================${NC}"
echo -e "${BLUE}${BOLD}          resoFlow Rootless Podman Installer          ${NC}"
echo -e "${BLUE}${BOLD}======================================================${NC}"

# 1. Pre-flight checks
if ! command -v podman > /dev/null 2>&1; then
    echo -e "${RED}Error: 'podman' is not installed. Please install Podman 4.x or 5.x first.${NC}" >&2
    exit 1
fi

PODMAN_RAW_VER="$(podman --version 2>&1 || true)"
PODMAN_VER="$(echo "${PODMAN_RAW_VER}" | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1)"
PODMAN_MAJOR="$(echo "${PODMAN_VER}" | cut -d. -f1)"

if [ -z "${PODMAN_MAJOR}" ] || [ "${PODMAN_MAJOR}" -lt 4 ]; then
    echo -e "${RED}Error: Podman 4.0 or higher is required.${NC}" >&2
    echo -e "${RED}Detected: ${PODMAN_RAW_VER}${NC}" >&2
    echo -e "${YELLOW}Please upgrade Podman to version 4.x or 5.x on this workstation.${NC}" >&2
    exit 1
fi

if [ "${PODMAN_MAJOR}" -ge 5 ]; then
    DEPLOY_MODE="quadlet"
else
    DEPLOY_MODE="systemd"
fi

if ! command -v systemctl > /dev/null 2>&1; then
    echo -e "${RED}Error: 'systemctl' is not available. Systemd is required for resoFlow services.${NC}" >&2
    exit 1
fi

# Check subuid/subgid mapping
if [ ! -r /etc/subuid ] || ! grep -q "^${USER}:" /etc/subuid 2>/dev/null; then
    echo -e "${YELLOW}Warning: User '${USER}' does not have a subuid mapping in /etc/subuid. Rootless Podman may fail.${NC}"
fi

# 2. Interactive configuration prompts (if TTY & interactive mode)
IS_TTY=false
if [ -t 0 ] && [ "$NON_INTERACTIVE" = false ]; then
    IS_TTY=true
fi

if [ "$IS_TTY" = true ]; then
    echo -e "\n${BOLD}--- Setup Configuration ---${NC}"

    # Port prompt
    read -r -p "Base port for resoFlow web interface [${BASE_PORT}]: " input_port
    if [ -n "${input_port}" ]; then
        BASE_PORT="${input_port}"
    fi

    # LAN prompt
    if [ "${BIND_HOST}" = "127.0.0.1" ]; then
        read -r -p "Allow access over local area network (LAN)? [y/N]: " input_lan
        case "${input_lan}" in
            [yY]|[yY][eE][sS])
                BIND_HOST="0.0.0.0"
                ;;
            *)
                BIND_HOST="127.0.0.1"
                ;;
        esac
    fi

    # Accessible filesystem prompt
    read -r -p "Host accessible storage path for projects & spectra [${DATA_DIR}]: " input_data_dir
    if [ -n "${input_data_dir}" ]; then
        DATA_DIR="${input_data_dir}"
    fi

    # Admin account prompt
    if [ -z "${CREATE_ADMIN}" ]; then
        echo ""
        read -r -p "Create an administrator account now? [Y/n]: " input_create_admin
        case "${input_create_admin}" in
            [nN]|[nN][oO])
                CREATE_ADMIN="false"
                ;;
            *)
                CREATE_ADMIN="true"
                ;;
        esac
    fi

    if [ "${CREATE_ADMIN}" = "true" ] && { [ -z "${ADMIN_EMAIL}" ] || [ -z "${ADMIN_PASSWORD}" ]; }; then
        echo -e "\n${BOLD}--- Administrator Account Setup ---${NC}"
        while [ -z "${ADMIN_EMAIL}" ]; do
            read -r -p "Admin Email: " input_email
            input_email="$(echo "${input_email}" | tr -d '[:space:]')"
            if [[ "${input_email}" == *"@"* ]]; then
                ADMIN_EMAIL="${input_email}"
            else
                echo -e "${RED}Please enter a valid email address.${NC}"
            fi
        done

        read -r -p "Admin Full Name [${ADMIN_NAME}]: " input_name
        if [ -n "${input_name}" ]; then
            ADMIN_NAME="${input_name}"
        fi

        while [ -z "${ADMIN_PASSWORD}" ]; do
            read -r -s -p "Admin Password: " pwd1
            echo ""
            read -r -s -p "Confirm Admin Password: " pwd2
            echo ""
            if [ -z "${pwd1}" ]; then
                echo -e "${RED}Password cannot be empty.${NC}"
            elif [ "${pwd1}" != "${pwd2}" ]; then
                echo -e "${RED}Passwords do not match. Please try again.${NC}"
            else
                ADMIN_PASSWORD="${pwd1}"
            fi
        done
    fi
fi

# Expand and normalize DATA_DIR
if [[ "${DATA_DIR}" == ~* ]]; then
    DATA_DIR="${HOME}${DATA_DIR#\~}"
fi
DATA_DIR="$(mkdir -p "${DATA_DIR}" 2>/dev/null && cd "${DATA_DIR}" && pwd || echo "${DATA_DIR}")"
if [ ! -w "${DATA_DIR}" ]; then
    echo -e "${YELLOW}Warning: Data directory '${DATA_DIR}' is not writable by user '${USER}'.${NC}"
    echo -e "${YELLOW}Please ensure your user has write permissions: sudo chown -R ${USER}:${USER} ${DATA_DIR}${NC}"
fi

# Resolve WEB_PORT and API_PORT
WEB_PORT="${BASE_PORT}"
if [ -z "${API_PORT}" ]; then
    if [ "${WEB_PORT}" = "8080" ]; then
        API_PORT="8000"
    else
        API_PORT="$((WEB_PORT + 1))"
    fi
fi

echo -e "\n${BLUE}Configuration summary:${NC}"
echo -e "  - Podman Version:      ${BOLD}${PODMAN_VER} (mode: ${DEPLOY_MODE})${NC}"
echo -e "  - Web UI Port:         ${BOLD}${WEB_PORT}${NC}"
echo -e "  - Backend API Port:    ${BOLD}${API_PORT}${NC}"
echo -e "  - Accessible Data Dir: ${BOLD}${DATA_DIR}${NC}"
if [ "${BIND_HOST}" = "0.0.0.0" ]; then
    echo -e "  - Network Access:      ${BOLD}${GREEN}LAN Enabled (0.0.0.0)${NC}"
else
    echo -e "  - Network Access:      ${BOLD}Localhost Only (127.0.0.1)${NC}"
fi
if [ "${CREATE_ADMIN}" = "true" ] && [ -n "${ADMIN_EMAIL}" ]; then
    echo -e "  - Administrator:       ${BOLD}${ADMIN_EMAIL}${NC}"
fi

# 3. Load offline images if present in bundle
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

# Verify required container images are present locally
MISSING_IMAGES=()
for img in "localhost/resoflow-api:latest" "localhost/resoflow-worker:latest" "localhost/resoflow-web:latest"; do
    if ! podman image exists "${img}" 2>/dev/null; then
        MISSING_IMAGES+=("${img}")
    fi
done

if [ ${#MISSING_IMAGES[@]} -gt 0 ]; then
    echo -e "\n${YELLOW}Notice: The following resoFlow container images are missing locally:${NC}"
    for img in "${MISSING_IMAGES[@]}"; do
        echo -e "  - ${img}"
    done

    BUILD_SCRIPT="${REPO_ROOT}/containers/build.sh"
    if [ -f "${BUILD_SCRIPT}" ]; then
        DO_BUILD="true"
        if [ "$IS_TTY" = true ] && [ "$NON_INTERACTIVE" = false ]; then
            read -r -p "Build missing container images now using ./containers/build.sh? [Y/n]: " input_build
            case "${input_build}" in
                [nN]|[nN][oO])
                    DO_BUILD="false"
                    ;;
                *)
                    DO_BUILD="true"
                    ;;
            esac
        fi
        if [ "${DO_BUILD}" = "true" ]; then
            echo -e "\n${BLUE}Building container images via ${BUILD_SCRIPT}...${NC}"
            "${BUILD_SCRIPT}"
            echo -e "${GREEN}✓ Container images built successfully.${NC}"
        else
            echo -e "${RED}Error: Cannot start resoFlow without required container images.${NC}" >&2
            echo -e "Please build them with: ./containers/build.sh" >&2
            exit 1
        fi
    else
        echo -e "\n${RED}Error: Required container images are missing and build script was not found.${NC}" >&2
        echo -e "If installing from an offline bundle, ensure the 'images/' directory contains the image tarballs." >&2
        exit 1
    fi
fi

# 4. Directory setup
QUADLET_DIR="${HOME}/.config/containers/systemd"
CONFIG_DIR="${HOME}/.config/resoflow"

mkdir -p "${QUADLET_DIR}" "${CONFIG_DIR}" "${DATA_DIR}"
chmod 700 "${CONFIG_DIR}"

# 5. Dynamic Secrets and Environment Generation
ENV_FILE="${CONFIG_DIR}/resoflow.env"

gen_secret() {
    if command -v openssl > /dev/null 2>&1; then
        openssl rand -hex "$1"
    else
        python3 -c "import secrets; print(secrets.token_hex($1))"
    fi
}

if [ ! -f "${ENV_FILE}" ]; then
    echo -e "\n${BLUE}[1/5] Generating secure environment secrets in ${ENV_FILE}...${NC}"
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
WEB_PORT=${WEB_PORT}
API_PORT=${API_PORT}
EOF
    chmod 600 "${ENV_FILE}"
    echo -e "${GREEN}✓ Generated ${ENV_FILE} with permissions 600.${NC}"
else
    echo -e "\n${BLUE}[1/5] Updating environment configuration at ${ENV_FILE}...${NC}"
    # Update existing env file with new data root and ports if modified
    update_env_var() {
        local key="$1"
        local val="$2"
        if grep -q "^${key}=" "${ENV_FILE}"; then
            sed -i "s|^${key}=.*|${key}=${val}|g" "${ENV_FILE}"
        else
            echo "${key}=${val}" >> "${ENV_FILE}"
        fi
    }
    update_env_var "RESOFLOW_HOST_DATA_ROOT" "${DATA_DIR}"
    update_env_var "WEB_PORT" "${WEB_PORT}"
    update_env_var "API_PORT" "${API_PORT}"
    echo -e "${GREEN}✓ Updated ${ENV_FILE}.${NC}"
fi

# 6. Copy and configure Service Unit Files & Backup Timers
USER_SYSTEMD_DIR="${HOME}/.config/systemd/user"
mkdir -p "${USER_SYSTEMD_DIR}"

if [ "${DEPLOY_MODE}" = "quadlet" ]; then
    echo -e "\n${BLUE}[2/5] Installing and tailoring Podman 5.x Quadlet unit files...${NC}"
    # Clean any legacy direct systemd unit files to avoid conflicts
    rm -f "${USER_SYSTEMD_DIR}/resoflow-pod.service" \
          "${USER_SYSTEMD_DIR}/resoflow-postgres.service" \
          "${USER_SYSTEMD_DIR}/resoflow-redis.service" \
          "${USER_SYSTEMD_DIR}/resoflow-api.service" \
          "${USER_SYSTEMD_DIR}/resoflow-worker.service" \
          "${USER_SYSTEMD_DIR}/resoflow-web.service" 2>/dev/null || true

    cp -f "${SCRIPT_DIR}/quadlet/"*.volume "${QUADLET_DIR}/" 2>/dev/null || true
    cp -f "${SCRIPT_DIR}/quadlet/resoflow-postgres.container" "${QUADLET_DIR}/" 2>/dev/null || true
    cp -f "${SCRIPT_DIR}/quadlet/resoflow-redis.container" "${QUADLET_DIR}/" 2>/dev/null || true
    cp -f "${SCRIPT_DIR}/quadlet/resoflow-web.container" "${QUADLET_DIR}/" 2>/dev/null || true

    # Copy & customize resoflow.pod (PublishPort)
    sed "s|PublishPort=.*|PublishPort=${BIND_HOST}:${WEB_PORT}:${WEB_PORT}|g" \
        "${SCRIPT_DIR}/quadlet/resoflow.pod" > "${QUADLET_DIR}/resoflow.pod"

    # Copy & customize resoflow-api.container (Volume & Port)
    sed -e "s|Volume=.*:/data/projects:z|Volume=${DATA_DIR}:/data/projects:z|g" \
        "${SCRIPT_DIR}/quadlet/resoflow-api.container" > "${QUADLET_DIR}/resoflow-api.container"

    # Copy & customize resoflow-worker.container (Volume)
    sed "s|Volume=.*:/data/projects:z|Volume=${DATA_DIR}:/data/projects:z|g" \
        "${SCRIPT_DIR}/quadlet/resoflow-worker.container" > "${QUADLET_DIR}/resoflow-worker.container"

    echo -e "${GREEN}✓ Quadlet units installed with customized ports and storage.${NC}"
else
    echo -e "\n${BLUE}[2/5] Installing and tailoring Podman 4.x systemd user units...${NC}"
    # Clean any quadlet units that Podman 4 cannot handle
    rm -f "${QUADLET_DIR}/resoflow.pod" \
          "${QUADLET_DIR}/resoflow-"*.container \
          "${QUADLET_DIR}/resoflow-"*.volume 2>/dev/null || true

    # Ensure persistent named volumes exist
    podman volume exists resoflow-pgdata 2>/dev/null || podman volume create resoflow-pgdata >/dev/null
    podman volume exists resoflow-redisdata 2>/dev/null || podman volume create resoflow-redisdata >/dev/null

    # Tailor and install systemd service units
    sed -e "s|__BIND_HOST__|${BIND_HOST}|g" \
        -e "s|__WEB_PORT__|${WEB_PORT}|g" \
        "${SCRIPT_DIR}/systemd/resoflow-pod.service" > "${USER_SYSTEMD_DIR}/resoflow-pod.service"

    sed -e "s|__DATA_DIR__|${DATA_DIR}|g" \
        -e "s|__API_PORT__|${API_PORT}|g" \
        "${SCRIPT_DIR}/systemd/resoflow-api.service" > "${USER_SYSTEMD_DIR}/resoflow-api.service"

    sed -e "s|__DATA_DIR__|${DATA_DIR}|g" \
        "${SCRIPT_DIR}/systemd/resoflow-worker.service" > "${USER_SYSTEMD_DIR}/resoflow-worker.service"

    cp -f "${SCRIPT_DIR}/systemd/resoflow-postgres.service" "${USER_SYSTEMD_DIR}/resoflow-postgres.service"
    cp -f "${SCRIPT_DIR}/systemd/resoflow-redis.service" "${USER_SYSTEMD_DIR}/resoflow-redis.service"
    cp -f "${SCRIPT_DIR}/systemd/resoflow-web.service" "${USER_SYSTEMD_DIR}/resoflow-web.service"

    echo -e "${GREEN}✓ Systemd user units installed with customized ports and storage.${NC}"
fi

# Install backup scripts and timer (common to both modes)
SCRIPTS_DIR="${HOME}/.local/share/resoflow/scripts"
mkdir -p "${SCRIPTS_DIR}"
cp -f "${SCRIPT_DIR}/backup.sh" "${SCRIPTS_DIR}/backup.sh"
chmod +x "${SCRIPTS_DIR}/backup.sh"

if [ -f "${SCRIPT_DIR}/systemd/resoflow-backup.service" ]; then
    cp -f "${SCRIPT_DIR}/systemd/resoflow-backup.service" "${USER_SYSTEMD_DIR}/"
    cp -f "${SCRIPT_DIR}/systemd/resoflow-backup.timer" "${USER_SYSTEMD_DIR}/"
else
    cp -f "${SCRIPT_DIR}/quadlet/resoflow-backup.service" "${USER_SYSTEMD_DIR}/" 2>/dev/null || true
    cp -f "${SCRIPT_DIR}/quadlet/resoflow-backup.timer" "${USER_SYSTEMD_DIR}/" 2>/dev/null || true
fi

echo -e "${GREEN}✓ Service units and backup timers installed.${NC}"

# 7. Enable Podman Socket, Backup Timer, and Linger
echo -e "\n${BLUE}[3/5] Configuring systemd user services, backup timer & Podman socket...${NC}"
systemctl --user daemon-reload
systemctl --user enable --now podman.socket > /dev/null 2>&1 || true
systemctl --user enable --now resoflow-backup.timer > /dev/null 2>&1 || true

if command -v loginctl > /dev/null 2>&1; then
    loginctl enable-linger "${USER}" 2>/dev/null || true
fi

# 8. Daemon reload and start pod
echo -e "\n${BLUE}[4/5] Reloading systemd user daemon and starting resoFlow pod...${NC}"
systemctl --user daemon-reload

if ! systemctl --user list-unit-files resoflow-pod.service > /dev/null 2>&1 && ! systemctl --user cat resoflow-pod.service > /dev/null 2>&1; then
    echo -e "${RED}Error: 'resoflow-pod.service' was not registered with systemd.${NC}" >&2
    if [ "${DEPLOY_MODE}" = "quadlet" ]; then
        echo -e "${YELLOW}Investigating Quadlet generator output:${NC}" >&2
        QUADLET_BIN=""
        for bin in /usr/libexec/podman/quadlet /usr/lib/podman/quadlet; do
            if [ -x "$bin" ]; then
                QUADLET_BIN="$bin"
                break
            fi
        done
        if [ -n "$QUADLET_BIN" ]; then
            "$QUADLET_BIN" -dryrun -user 2>&1 || true
        else
            echo -e "${RED}Could not locate the quadlet generator binary in /usr/libexec/podman/ or /usr/lib/podman/.${NC}" >&2
        fi
    fi
    echo -e "\n${RED}Please verify that Podman (v4 or v5) and systemd user services are functioning.${NC}" >&2
    exit 1
fi

systemctl --user restart resoflow-pod.service

# 9. Health & Readiness Verification
echo -e "\n${BLUE}[5/5] Verifying service readiness...${NC}"
echo -n "  Waiting for web interface (http://127.0.0.1:${WEB_PORT})..."

READY=false
for i in {1..35}; do
    if curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${WEB_PORT}" 2>/dev/null | grep -qE "200|301|302|404"; then
        READY=true
        break
    fi
    echo -n "."
    sleep 1
done
echo ""

# 10. Bootstrap administrator account if requested
if [ "${CREATE_ADMIN}" = "true" ] && [ -n "${ADMIN_EMAIL}" ] && [ -n "${ADMIN_PASSWORD}" ]; then
    echo -e "\n${BLUE}Configuring administrator account (${ADMIN_EMAIL})...${NC}"
    if podman exec -i \
        -e ADMIN_EMAIL="${ADMIN_EMAIL}" \
        -e ADMIN_PASSWORD="${ADMIN_PASSWORD}" \
        -e ADMIN_NAME="${ADMIN_NAME}" \
        resoflow-api python - << 'PYEOF' > /dev/null 2>&1
import os
import sys
from app import database, models, security

email = os.environ.get("ADMIN_EMAIL", "").strip()
password = os.environ.get("ADMIN_PASSWORD", "")
full_name = os.environ.get("ADMIN_NAME", "Administrator").strip()

if not email or not password:
    sys.exit(0)

db = database.SessionLocal()
try:
    user = db.query(models.User).filter(models.User.email == email).first()
    hashed = security.get_password_hash(password)
    if user:
        user.hashed_password = hashed
        user.full_name = full_name or user.full_name
        user.is_active = True
        user.is_superuser = True
        db.commit()
    else:
        user = models.User(
            email=email,
            hashed_password=hashed,
            full_name=full_name or "Administrator",
            is_active=True,
            is_superuser=True
        )
        db.add(user)
        db.commit()
except Exception as e:
    db.rollback()
    sys.exit(1)
finally:
    db.close()
PYEOF
    then
        echo -e "${GREEN}✓ Administrator account configured successfully.${NC}"
    else
        echo -e "${YELLOW}Warning: Could not create admin account automatically. You can create one anytime with:${NC}"
        echo -e "  ${BOLD}podman exec -it resoflow-api python create_superuser.py${NC}"
    fi
fi

if [ "$READY" = true ]; then
    echo -e "\n${GREEN}${BOLD}======================================================${NC}"
    echo -e "${GREEN}${BOLD}✓ resoFlow is successfully installed and running!     ${NC}"
    echo -e "${GREEN}${BOLD}======================================================${NC}"
    echo -e "\n${BLUE}${BOLD}Access resoFlow in your web browser:${NC}"
    echo -e "  Local: ${GREEN}${BOLD}http://127.0.0.1:${WEB_PORT}${NC}"
    if [ "${BIND_HOST}" = "0.0.0.0" ]; then
        LAN_IP="$(ip route get 1 2>/dev/null | awk '{print $7;exit}' || hostname -I 2>/dev/null | awk '{print $1}')"
        if [ -n "${LAN_IP}" ]; then
            echo -e "  LAN:   ${GREEN}${BOLD}http://${LAN_IP}:${WEB_PORT}${NC}"
        fi
    fi
    echo -e "\n${BLUE}Configuration details:${NC}"
    echo -e "  - Accessible storage: ${BOLD}${DATA_DIR}${NC}"
    if [ "${CREATE_ADMIN}" = "true" ] && [ -n "${ADMIN_EMAIL}" ]; then
        echo -e "  - Admin login email:  ${BOLD}${ADMIN_EMAIL}${NC}"
    fi
    echo -e "\n${BLUE}Systemd management commands:${NC}"
    echo -e "  Status:  ${BOLD}systemctl --user status resoflow-pod.service${NC}"
    echo -e "  Logs:    ${BOLD}journalctl --user -u resoflow-api -u resoflow-worker -f${NC}"
    echo -e "  Stop:    ${BOLD}systemctl --user stop resoflow-pod.service${NC}"
    echo -e "  Restart: ${BOLD}systemctl --user restart resoflow-pod.service${NC}"
else
    echo -e "${YELLOW}Warning: Services started, but healthcheck timed out. Check container logs:${NC}"
    echo -e "  ${BOLD}journalctl --user -u resoflow-api.service -n 50${NC}"
fi

