#!/usr/bin/env bash
# resoFlow Root Bootstrap Forwarder
# Note: For production rootless Podman deployments, use: ./deploy/install.sh
# For local live-reloading development, delegating to dev/start_apps.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "${SCRIPT_DIR}/dev/start_apps.sh" "$@"
