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
systemctl --user stop resoflow-pod.service \
    resoflow-api.service \
    resoflow-worker.service \
    resoflow-web.service \
    resoflow-postgres.service \
    resoflow-redis.service > /dev/null 2>&1 || true
echo -e "${GREEN}✓ Services stopped.${NC}"

# 2. Remove Quadlet unit files
echo -e "\n${BLUE}[2/3] Removing Quadlet unit files from ~/.config/containers/systemd/...${NC}"
QUADLET_DIR="${HOME}/.config/containers/systemd"
rm -f "${QUADLET_DIR}/resoflow.pod" \
      "${QUADLET_DIR}/resoflow-"*.container \
      "${QUADLET_DIR}/resoflow-"*.volume 2>/dev/null || true

systemctl --user daemon-reload
echo -e "${GREEN}✓ Quadlet units removed and systemd daemon reloaded.${NC}"

# 3. Optional data purge
echo -e "\n${BLUE}[3/3] Checking data volumes and configuration...${NC}"
if [ "$PURGE_DATA" = true ]; then
    echo -e "${YELLOW}Purging data volumes and secrets (--purge-data requested)...${NC}"
    podman volume rm -f resoflow-pgdata resoflow-redisdata 2>/dev/null || true
    rm -rf "${HOME}/.config/resoflow"
    rm -rf "${HOME}/.local/share/resoflow"
    echo -e "${GREEN}✓ Data directories, volumes, and secrets purged.${NC}"
else
    echo -e "User data and database volumes preserved in:"
    echo -e "  - Configuration & secrets: ${BOLD}~/.config/resoflow/${NC}"
    echo -e "  - Projects & fit results:  ${BOLD}~/.local/share/resoflow/projects/${NC}"
    echo -e "  - Podman persistent volumes: ${BOLD}resoflow-pgdata, resoflow-redisdata${NC}"
    echo -e "\n${YELLOW}To purge all data on uninstall, run: ./deploy/uninstall.sh --purge-data${NC}"
fi

echo -e "\n${GREEN}${BOLD}✓ resoFlow uninstallation completed successfully.${NC}"
