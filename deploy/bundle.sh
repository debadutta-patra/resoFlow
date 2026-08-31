#!/usr/bin/env bash
set -euo pipefail

# resoFlow Offline Distribution Bundle Generator
# Packages all container images, quadlet units, and installation scripts into a self-contained archive.

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

VERSION="${1:-$(git describe --tags --always --dirty 2>/dev/null || echo "v0.1.0")}"
DIST_DIR="${REPO_ROOT}/dist"
BUNDLE_NAME="resoflow-${VERSION}-offline-bundle"
BUNDLE_DIR="${DIST_DIR}/${BUNDLE_NAME}"
ARCHIVE_PATH="${DIST_DIR}/${BUNDLE_NAME}.tar.gz"

echo -e "${BLUE}${BOLD}======================================================${NC}"
echo -e "${BLUE}${BOLD}     Building resoFlow Offline Bundle (${VERSION})    ${NC}"
echo -e "${BLUE}${BOLD}======================================================${NC}"

# 1. Clean and prepare output directory
rm -rf "${BUNDLE_DIR}" "${ARCHIVE_PATH}"
mkdir -p "${BUNDLE_DIR}/images" "${BUNDLE_DIR}/quadlet"

# 2. Copy Quadlet units and lifecycle scripts
echo -e "\n${BLUE}[1/4] Copying deployment scripts and Quadlet units...${NC}"
cp -f "${SCRIPT_DIR}/quadlet/"* "${BUNDLE_DIR}/quadlet/"
cp -f "${SCRIPT_DIR}/install.sh" "${BUNDLE_DIR}/install.sh"
cp -f "${SCRIPT_DIR}/uninstall.sh" "${BUNDLE_DIR}/uninstall.sh"
chmod +x "${BUNDLE_DIR}/install.sh" "${BUNDLE_DIR}/uninstall.sh"

# 3. Generate INSTALL.md
echo -e "\n${BLUE}[2/4] Generating INSTALL.md documentation...${NC}"
cat << 'EOF' > "${BUNDLE_DIR}/INSTALL.md"
# resoFlow Offline Installation Guide

This archive is a standalone, self-contained distribution bundle for deploying **resoFlow** on Linux lab workstations without requiring internet access or root/sudo privileges.

---

## Prerequisites

1. **Linux Workstation** (RHEL 9, Rocky Linux 9, Fedora, Ubuntu 22.04+, Debian 12+).
2. **Podman 5.x** installed with user subuid/subgid configured:
   - Check with: `podman --version` and `grep "^$USER:" /etc/subuid`
3. **Systemd User Session**:
   - Check with: `systemctl --user is-system-running`

---

## Quick Installation

Extract the bundle and run the installer:

```bash
tar -xzf resoflow-*-offline-bundle.tar.gz
cd resoflow-*-offline-bundle
./install.sh
```

The installer will:
1. Automatically load all container images from `images/` into your local Podman storage.
2. Generate secure dynamic secrets and configuration in `~/.config/resoflow/resoflow.env`.
3. Install Quadlet units into `~/.config/containers/systemd/`.
4. Enable the user Podman API socket and configure systemd lingering.
5. Start the resoFlow rootless pod service.

---

## Accessing resoFlow

Once started, navigate to:
```
http://127.0.0.1:8080
```

---

## Service Management

All services run under your regular user account via systemd:

- **Check status**: `systemctl --user status resoflow-pod.service`
- **View live logs**: `journalctl --user -u resoflow-api -u resoflow-worker -f`
- **Restart services**: `systemctl --user restart resoflow-pod.service`
- **Stop services**: `systemctl --user stop resoflow-pod.service`

---

## Uninstallation

To remove services and Quadlet units while preserving your project data:
```bash
./uninstall.sh
```

To remove all services, configuration, and delete project data/databases:
```bash
./uninstall.sh --purge-data
```
EOF

# 4. Source image references
IMAGES_ENV="${REPO_ROOT}/containers/images.env"
if [ -f "${IMAGES_ENV}" ]; then
    # shellcheck source=/dev/null
    source "${IMAGES_ENV}"
fi

POSTGRES_IMAGE="${POSTGRES_IMAGE:-docker.io/library/postgres:16-alpine}"
REDIS_IMAGE="${REDIS_IMAGE:-docker.io/library/redis:7-alpine}"

# 5. Export Container Images
echo -e "\n${BLUE}[3/4] Exporting container images to ${BUNDLE_DIR}/images/ (this may take a few minutes)...${NC}"

IMAGES_TO_SAVE=(
    "localhost/resoflow-api:latest"
    "localhost/resoflow-worker:latest"
    "localhost/resoflow-chemex:latest"
    "localhost/resoflow-web:latest"
    "docker.io/library/postgres:16-alpine"
    "docker.io/library/redis:7-alpine"
)

echo "  Saving images: ${IMAGES_TO_SAVE[*]}"
podman save -o "${BUNDLE_DIR}/images/resoflow-images.tar" "${IMAGES_TO_SAVE[@]}"

echo -e "  Compressing container images archive..."
gzip -1 "${BUNDLE_DIR}/images/resoflow-images.tar"
echo -e "${GREEN}✓ Container images packaged (${BUNDLE_DIR}/images/resoflow-images.tar.gz).${NC}"

# 6. Create Tarball
echo -e "\n${BLUE}[4/4] Creating final distribution archive...${NC}"
tar -czf "${ARCHIVE_PATH}" -C "${DIST_DIR}" "${BUNDLE_NAME}"
rm -rf "${BUNDLE_DIR}"

ARCHIVE_SIZE="$(du -h "${ARCHIVE_PATH}" | cut -f1)"
echo -e "\n${GREEN}${BOLD}======================================================${NC}"
echo -e "${GREEN}${BOLD}✓ Offline bundle successfully generated!${NC}"
echo -e "  Location: ${BOLD}${ARCHIVE_PATH}${NC}"
echo -e "  Size:     ${BOLD}${ARCHIVE_SIZE}${NC}"
echo -e "${GREEN}${BOLD}======================================================${NC}"
