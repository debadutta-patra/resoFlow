#!/usr/bin/env bash
set -euo pipefail

# resoFlow service control.
#
# Wraps the supervisor the installer picked -- systemd user units on Linux and
# WSL, launchd on macOS -- so day-to-day management is the same command
# everywhere, and nobody has to remember which unit name is the handle.

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

CONFIG_DIR="${HOME}/.config/resoflow"
ENV_FILE="${CONFIG_DIR}/resoflow.env"
SCRIPTS_DIR="${HOME}/.local/share/resoflow/scripts"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Container services in dependency order; the pod is handled separately.
CONTAINER_UNITS=(
    resoflow-postgres
    resoflow-redis
    resoflow-api
    resoflow-worker
    resoflow-web
)

usage() {
    cat << 'EOF'
Usage: resoflow <command> [options]

Manage the resoFlow deployment.

Commands:
  start                Start all resoFlow services
  stop                 Stop all resoFlow services
  restart              Restart all resoFlow services
  status               Show service and container state, and the web address
  logs [SERVICE]       Follow logs (default: api and worker)
                       SERVICE: api | worker | web | postgres | redis
  url                  Print the web address
  browse-roots ...     Manage browsable directories (see: resoflow browse-roots help)
  help                 Show this message

Examples:
  resoflow status
  resoflow restart
  resoflow logs api
  resoflow browse-roots add /mnt/spectrometer
EOF
}

if [ ! -f "${ENV_FILE}" ]; then
    echo -e "${RED}resoFlow does not look installed: ${ENV_FILE} not found.${NC}" >&2
    echo "Run ./deploy/install.sh first." >&2
    exit 1
fi

WEB_PORT="$(sed -n 's|^WEB_PORT=||p' "${ENV_FILE}" | tail -n 1)"
WEB_PORT="${WEB_PORT:-8080}"
BIND_HINT="127.0.0.1"

# Which supervisor is actually in charge here?
PLIST="${HOME}/Library/LaunchAgents/org.resoflow.pod.plist"
if command -v launchctl > /dev/null 2>&1 && [ -f "${PLIST}" ]; then
    MODE="launchd"
elif command -v systemctl > /dev/null 2>&1; then
    MODE="systemd"
else
    echo -e "${RED}No supported service manager found (systemd or launchd).${NC}" >&2
    exit 1
fi

mac_service() {
    local script="${SCRIPTS_DIR}/resoflow-service.sh"
    if [ ! -x "${script}" ]; then
        echo -e "${RED}Missing ${script}.${NC}" >&2
        exit 1
    fi
    "${script}" "$@"
}

# Units that systemd actually knows about, so a partial install does not
# produce a wall of "unit not found".
known_units() {
    local unit
    for unit in "$@"; do
        if systemctl --user cat "${unit}.service" > /dev/null 2>&1; then
            printf '%s.service\n' "${unit}"
        fi
    done
}

do_start() {
    if [ "${MODE}" = "launchd" ]; then
        mac_service start
        return
    fi
    echo -e "${BLUE}Starting resoFlow...${NC}"
    systemctl --user start resoflow-pod.service 2>/dev/null || true
    local units
    # shellcheck disable=SC2207
    units=($(known_units "${CONTAINER_UNITS[@]}"))
    if [ ${#units[@]} -gt 0 ]; then
        systemctl --user start "${units[@]}"
    fi
    echo -e "${GREEN}✓ Started.${NC}"
}

do_stop() {
    if [ "${MODE}" = "launchd" ]; then
        mac_service stop
        return
    fi
    echo -e "${BLUE}Stopping resoFlow...${NC}"
    local units reversed=() i
    # shellcheck disable=SC2207
    units=($(known_units "${CONTAINER_UNITS[@]}"))
    # Stop in reverse dependency order so the database outlives its clients.
    for (( i=${#units[@]}-1 ; i>=0 ; i-- )); do
        reversed+=("${units[i]}")
    done
    if [ ${#reversed[@]} -gt 0 ]; then
        systemctl --user stop "${reversed[@]}"
    fi
    systemctl --user stop resoflow-pod.service 2>/dev/null || true
    echo -e "${GREEN}✓ Stopped.${NC}"
}

do_restart() {
    if [ "${MODE}" = "launchd" ]; then
        mac_service restart
        return
    fi
    echo -e "${BLUE}Restarting resoFlow...${NC}"
    # Pick up any unit-file edits (e.g. new browse roots) before restarting.
    systemctl --user daemon-reload
    systemctl --user restart resoflow-pod.service
    local units
    # shellcheck disable=SC2207
    units=($(known_units "${CONTAINER_UNITS[@]}"))
    if [ ${#units[@]} -gt 0 ]; then
        systemctl --user restart "${units[@]}"
    fi
    echo -e "${GREEN}✓ Restarted.${NC}"
}

wait_for_web() {
    command -v curl > /dev/null 2>&1 || return 0
    local i
    for i in $(seq 1 20); do
        if curl -s -o /dev/null -w "%{http_code}" "http://${BIND_HINT}:${WEB_PORT}" 2>/dev/null \
            | grep -qE "200|301|302|404"; then
            return 0
        fi
        sleep 1
    done
    return 1
}

do_status() {
    echo -e "${BOLD}Services${NC}"
    if [ "${MODE}" = "launchd" ]; then
        mac_service status
    else
        local unit state
        for unit in resoflow-pod "${CONTAINER_UNITS[@]}"; do
            if systemctl --user cat "${unit}.service" > /dev/null 2>&1; then
                state="$(systemctl --user is-active "${unit}.service" 2>/dev/null || true)"
                case "${state}" in
                    active) printf "  ${GREEN}%-10s${NC} %s\n" "${state}" "${unit}" ;;
                    *)      printf "  ${YELLOW}%-10s${NC} %s\n" "${state:-unknown}" "${unit}" ;;
                esac
            else
                printf "  ${YELLOW}%-10s${NC} %s\n" "absent" "${unit}"
            fi
        done
    fi

    if command -v podman > /dev/null 2>&1; then
        echo -e "\n${BOLD}Containers${NC}"
        local ps_out
        ps_out="$(podman ps --filter pod=resoflow --format "  {{.Names}}\t{{.Status}}" 2>/dev/null || true)"
        if [ -n "${ps_out}" ]; then
            echo "${ps_out}"
        else
            # Usually means this shell's podman is pointed at a different image
            # store than the services use -- a snap or flatpak terminal will do
            # this by redirecting XDG_DATA_HOME.
            echo -e "  ${YELLOW}none visible to this podman${NC}"
            echo "  (store: $(podman info --format '{{.Store.GraphRoot}}' 2>/dev/null || echo unknown))"
        fi
    fi

    echo -e "\n${BOLD}Web interface${NC}"
    if wait_for_web; then
        echo -e "  ${GREEN}reachable${NC}  http://${BIND_HINT}:${WEB_PORT}"
    else
        echo -e "  ${YELLOW}not responding${NC}  http://${BIND_HINT}:${WEB_PORT}"
    fi
}

do_logs() {
    local target="${1:-}"
    if [ "${MODE}" = "launchd" ]; then
        if [ -n "${target}" ]; then
            podman logs -f "resoflow-${target}"
        else
            echo -e "${YELLOW}Pick one: api, worker, web, postgres, redis.${NC}"
            podman logs -f resoflow-api
        fi
        return
    fi
    if [ -n "${target}" ]; then
        journalctl --user -u "resoflow-${target}" -f
    else
        journalctl --user -u resoflow-api -u resoflow-worker -f
    fi
}

COMMAND="${1:-help}"
shift || true

case "${COMMAND}" in
    start)   do_start ;;
    stop)    do_stop ;;
    restart) do_restart ;;
    status)  do_status ;;
    logs)    do_logs "${1:-}" ;;
    url)     echo "http://${BIND_HINT}:${WEB_PORT}" ;;
    browse-roots)
        for candidate in "${SCRIPT_DIR}/browse-roots.sh" "${SCRIPTS_DIR}/browse-roots.sh"; do
            if [ -x "${candidate}" ]; then
                exec "${candidate}" ${1+"$@"}
            fi
        done
        echo -e "${RED}browse-roots.sh not found.${NC}" >&2
        exit 1
        ;;
    help|-h|--help) usage ;;
    *)
        echo -e "${RED}Unknown command: ${COMMAND}${NC}" >&2
        usage
        exit 1
        ;;
esac
