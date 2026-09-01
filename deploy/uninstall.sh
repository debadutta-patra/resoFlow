#!/usr/bin/env bash
set -euo pipefail

# resoFlow Rootless Podman Quadlet Uninstallation Script

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

PURGE_DATA=false
if [[ "${1:-}" == "--purge-data" || "${1:-}" == "-p" ]]; then
    PURGE_DATA=true
fi

echo -e "${BLUE}${BOLD}======================================================${NC}"
echo -e "${BLUE}${BOLD}         resoFlow Rootless Podman Uninstaller         ${NC}"
echo -e "${BLUE}${BOLD}======================================================${NC}"

# 1. Stop systemd services
echo -e "\n${BLUE}[1/3] Stopping resoFlow systemd services...${NC}"
systemctl --user disable --now resoflow-backup.timer > /dev/null 2>&1 || true
systemctl --user stop resoflow-pod.service \
    resoflow-api.service \
    resoflow-worker.service \
    resoflow-web.service \
    resoflow-postgres.service \
    resoflow-redis.service \
    resoflow-backup.service > /dev/null 2>&1 || true
podman pod rm -f resoflow > /dev/null 2>&1 || true
echo -e "${GREEN}✓ Services stopped.${NC}"

# 2. Remove Quadlet and systemd unit files
echo -e "\n${BLUE}[2/3] Removing Quadlet and systemd unit files...${NC}"
QUADLET_DIR="${HOME}/.config/containers/systemd"
USER_SYSTEMD_DIR="${HOME}/.config/systemd/user"

rm -f "${QUADLET_DIR}/resoflow.pod" \
      "${QUADLET_DIR}/resoflow-"*.container \
      "${QUADLET_DIR}/resoflow-"*.volume \
      "${USER_SYSTEMD_DIR}/resoflow-"*.service \
      "${USER_SYSTEMD_DIR}/resoflow-"*.timer 2>/dev/null || true

systemctl --user daemon-reload
echo -e "${GREEN}✓ Unit files removed and systemd daemon reloaded.${NC}"

# 3. Optional data purge
echo -e "\n${BLUE}[3/3] Checking data volumes and configuration...${NC}"
CONFIG_DIR="${HOME}/.config/resoflow"
DATA_DIR="${HOME}/.local/share/resoflow/projects"
ENV_FILE="${CONFIG_DIR}/resoflow.env"

if [ -f "${ENV_FILE}" ]; then
    HOST_DATA_ROOT="$(grep '^RESOFLOW_HOST_DATA_ROOT=' "${ENV_FILE}" 2>/dev/null | cut -d'=' -f2- || true)"
    if [ -n "${HOST_DATA_ROOT}" ]; then
        DATA_DIR="${HOST_DATA_ROOT}"
    fi
fi

if [ "$PURGE_DATA" = true ]; then
    echo -e "${YELLOW}Purging data volumes and secrets (--purge-data requested)...${NC}"
    podman volume rm -f resoflow-pgdata resoflow-redisdata 2>/dev/null || true
    rm -rf "${CONFIG_DIR}"
    if [ -d "${DATA_DIR}" ]; then
        rm -rf "${DATA_DIR}"
    fi
    rm -rf "${HOME}/.local/share/resoflow"
    echo -e "${GREEN}✓ Data directories, volumes, and secrets purged.${NC}"
else
    echo -e "User data and database volumes preserved in:"
    echo -e "  - Configuration & secrets: ${BOLD}${CONFIG_DIR}/${NC}"
    echo -e "  - Projects & fit results:  ${BOLD}${DATA_DIR}/${NC}"
    echo -e "  - Podman persistent volumes: ${BOLD}resoflow-pgdata, resoflow-redisdata${NC}"
    echo -e "\n${YELLOW}To purge all data on uninstall, run: ./deploy/uninstall.sh --purge-data${NC}"
fi

echo -e "\n${GREEN}${BOLD}✓ resoFlow uninstallation completed successfully.${NC}"
