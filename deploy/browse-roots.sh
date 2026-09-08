#!/usr/bin/env bash
set -euo pipefail

# Manage the directories the resoFlow file explorer may browse, after install.
#
# Adding a root wires up both halves that make it work -- the bind mount into
# the api and worker containers, and RESOFLOW_EXTRA_BROWSE_ROOTS -- then
# restarts the affected services. No config file needs editing by hand.

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

QUADLET_DIR="${HOME}/.config/containers/systemd"
CONFIG_DIR="${HOME}/.config/resoflow"
USER_SYSTEMD_DIR="${HOME}/.config/systemd/user"
ENV_FILE="${CONFIG_DIR}/resoflow.env"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The library sits next to this script both in the repo (deploy/lib) and where
# the installer copies it (~/.local/share/resoflow/scripts/lib).
for candidate in "${SCRIPT_DIR}/lib/browse_roots.sh" "${SCRIPT_DIR}/../lib/browse_roots.sh"; do
    if [ -f "${candidate}" ]; then
        # shellcheck source=lib/browse_roots.sh
        . "${candidate}"
        BR_LIB_FOUND=true
        break
    fi
done

if [ "${BR_LIB_FOUND:-false}" != true ]; then
    echo -e "${RED}Cannot find browse_roots.sh library next to this script.${NC}" >&2
    exit 1
fi

usage() {
    cat << 'EOF'
Usage: resoflow-browse-roots <command> [PATH...]

Controls which directories the resoFlow file explorer can browse, in addition
to the project data directory chosen at install time.

Commands:
  list                 Show the currently configured extra directories
  add PATH [PATH...]   Allow the explorer into these host directories
  remove PATH [...]    Stop allowing these directories
  help                 Show this message

Notes:
  Give host paths, as your shell sees them. The mount into the containers and
  the backend setting are derived and kept in sync for you.

  Directories inside the project data directory are already browsable and are
  skipped. Paths containing spaces are rejected: they cannot be expressed in
  the container unit files.

  Services are restarted automatically so changes take effect immediately.

Examples:
  resoflow-browse-roots list
  resoflow-browse-roots add /mnt/spectrometer
  resoflow-browse-roots add /srv/nas/nmr /media/backup
  resoflow-browse-roots remove /mnt/spectrometer
EOF
}

if [ ! -f "${ENV_FILE}" ]; then
    echo -e "${RED}resoFlow does not look installed: ${ENV_FILE} not found.${NC}" >&2
    echo "Run ./deploy/install.sh first." >&2
    exit 1
fi

DATA_DIR="$(br_env_get RESOFLOW_HOST_DATA_ROOT)"

restart_services() {
    echo -e "\n${BLUE}Applying changes...${NC}"
    if command -v systemctl > /dev/null 2>&1 && systemctl --user list-unit-files 2>/dev/null | grep -q resoflow-api; then
        systemctl --user daemon-reload
        systemctl --user restart resoflow-api resoflow-worker
        echo -e "${GREEN}✓ resoflow-api and resoflow-worker restarted.${NC}"
    elif command -v launchctl > /dev/null 2>&1; then
        # macOS reads the mounts from the env file when it recreates the pod.
        launchctl unload "${HOME}/Library/LaunchAgents/org.resoflow.pod.plist" 2>/dev/null || true
        launchctl load "${HOME}/Library/LaunchAgents/org.resoflow.pod.plist" 2>/dev/null || true
        echo -e "${GREEN}✓ resoFlow pod reloaded.${NC}"
    else
        echo -e "${YELLOW}No running service manager found; changes apply on next start.${NC}"
    fi
}

COMMAND="${1:-help}"
shift || true

case "${COMMAND}" in
    list|ls)
        echo -e "${BOLD}Project data directory (always browsable):${NC}"
        echo "  ${DATA_DIR:-<unset>}"
        echo -e "\n${BOLD}Extra browsable directories:${NC}"
        br_list
        ;;

    add)
        [ $# -gt 0 ] || { echo -e "${RED}add needs at least one path.${NC}" >&2; usage; exit 1; }
        changed=false
        for path in "$@"; do
            status="$(br_mounts_add "${path}" "${DATA_DIR}" || true)"
            case "${status}" in
                added)
                    echo -e "${GREEN}✓ Added ${path}${NC}"
                    changed=true
                    ;;
                exists)
                    echo -e "${YELLOW}• ${path} is already configured.${NC}"
                    ;;
                covered)
                    echo -e "${YELLOW}• ${path} is inside the project data directory and is already browsable.${NC}"
                    ;;
                missing)
                    echo -e "${RED}✗ ${path} does not exist or is not a directory.${NC}"
                    ;;
                whitespace)
                    echo -e "${RED}✗ ${path} contains whitespace, which the container unit files cannot express.${NC}"
                    ;;
                *)
                    echo -e "${RED}✗ ${path}: unexpected result '${status}'.${NC}"
                    ;;
            esac
        done
        if [ "${changed}" = true ]; then
            br_sync
            restart_services
            echo -e "\n${BOLD}Now browsable:${NC}"
            br_list
        fi
        ;;

    remove|rm)
        [ $# -gt 0 ] || { echo -e "${RED}remove needs at least one path.${NC}" >&2; usage; exit 1; }
        changed=false
        for path in "$@"; do
            status="$(br_mounts_remove "${path}" || true)"
            if [ "${status}" = "removed" ]; then
                echo -e "${GREEN}✓ Removed ${path}${NC}"
                changed=true
            else
                echo -e "${YELLOW}• ${path} was not configured.${NC}"
            fi
        done
        if [ "${changed}" = true ]; then
            br_sync
            restart_services
            echo -e "\n${BOLD}Now browsable:${NC}"
            br_list
        fi
        ;;

    help|-h|--help)
        usage
        ;;

    *)
        echo -e "${RED}Unknown command: ${COMMAND}${NC}" >&2
        usage
        exit 1
        ;;
esac
