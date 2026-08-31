#!/usr/bin/env bash
# resoFlow Root Stop Forwarder
# Note: For production rootless Podman deployments, use: ./deploy/uninstall.sh
# For local live-reloading development, delegating to dev/stop_apps.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "${SCRIPT_DIR}/dev/stop_apps.sh" "$@"
