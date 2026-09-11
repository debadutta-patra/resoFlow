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

# Pinned podman-static version for consistent behavior across installations
PODMAN_STATIC_VER="5.8.4"

echo -e "${BLUE}${BOLD}======================================================${NC}"
echo -e "${BLUE}${BOLD}     Building resoFlow Offline Bundle (${VERSION})    ${NC}"
echo -e "${BLUE}${BOLD}======================================================${NC}"

# 1. Clean and prepare output directory
rm -rf "${BUNDLE_DIR}" "${ARCHIVE_PATH}"
mkdir -p "${BUNDLE_DIR}/images" "${BUNDLE_DIR}/quadlet" "${BUNDLE_DIR}/systemd" "${BUNDLE_DIR}/macos" "${BUNDLE_DIR}/windows" "${BUNDLE_DIR}/podman" "${BUNDLE_DIR}/lib"

# 2. Copy Quadlet units, systemd templates, macOS/Windows assets, and lifecycle scripts
echo -e "\n${BLUE}[1/5] Copying deployment scripts and platform assets...${NC}"
cp -f "${SCRIPT_DIR}/quadlet/"* "${BUNDLE_DIR}/quadlet/"
cp -f "${SCRIPT_DIR}/systemd/"* "${BUNDLE_DIR}/systemd/" 2>/dev/null || true
cp -f "${SCRIPT_DIR}/macos/"* "${BUNDLE_DIR}/macos/" 2>/dev/null || true
cp -f "${SCRIPT_DIR}/windows/"* "${BUNDLE_DIR}/windows/" 2>/dev/null || true
cp -f "${SCRIPT_DIR}/backup.sh" "${BUNDLE_DIR}/backup.sh"
cp -f "${SCRIPT_DIR}/install.sh" "${BUNDLE_DIR}/install.sh"
cp -f "${SCRIPT_DIR}/uninstall.sh" "${BUNDLE_DIR}/uninstall.sh"
# install.sh sources lib/browse_roots.sh, and installs browse-roots.sh for
# post-install use; both must travel with the bundle.
cp -f "${SCRIPT_DIR}/lib/"* "${BUNDLE_DIR}/lib/"
cp -f "${SCRIPT_DIR}/browse-roots.sh" "${BUNDLE_DIR}/browse-roots.sh"
cp -f "${SCRIPT_DIR}/resoflow-ctl.sh" "${BUNDLE_DIR}/resoflow-ctl.sh"
chmod +x "${BUNDLE_DIR}/install.sh" "${BUNDLE_DIR}/uninstall.sh" "${BUNDLE_DIR}/backup.sh" "${BUNDLE_DIR}/browse-roots.sh" "${BUNDLE_DIR}/resoflow-ctl.sh" "${BUNDLE_DIR}/macos/resoflow-service.sh" 2>/dev/null || true

# 2b. Download podman-static binaries (Linux only)
echo -e "\n${BLUE}[1b/5] Downloading podman-static v${PODMAN_STATIC_VER} for Linux...${NC}"
PODMAN_STATIC_BASE="https://github.com/mgoltzsche/podman-static/releases/download/v${PODMAN_STATIC_VER}"
for arch in amd64 arm64; do
    ARCHIVE_NAME="podman-linux-${arch}.tar.gz"
    DEST="${BUNDLE_DIR}/podman/${ARCHIVE_NAME}"
    echo -e "  Downloading ${ARCHIVE_NAME}..."
    if curl -fsSL -o "${DEST}" "${PODMAN_STATIC_BASE}/${ARCHIVE_NAME}"; then
        echo -e "  ${GREEN}✓ ${ARCHIVE_NAME} downloaded.${NC}"
    else
        echo -e "  ${YELLOW}⚠ Could not download ${ARCHIVE_NAME} (architecture may not be available). Skipping.${NC}"
        rm -f "${DEST}"
    fi
done
# Record the pinned version for the installer
echo "${PODMAN_STATIC_VER}" > "${BUNDLE_DIR}/podman/VERSION"
echo -e "${GREEN}✓ Podman static binaries packaged.${NC}"

# 3. Generate INSTALL.md
echo -e "\n${BLUE}[2/5] Generating INSTALL.md documentation...${NC}"
cat << 'EOF' > "${BUNDLE_DIR}/INSTALL.md"
# resoFlow Offline Installation Guide

This archive is a standalone, self-contained distribution bundle for deploying **resoFlow** on Linux lab workstations without requiring internet access or root/sudo privileges.

---

## Prerequisites

1. **Linux Workstation** (RHEL 9, Rocky Linux 9, Fedora, Ubuntu 22.04+, Debian 12+).
2. **Podman 3.4+ or 5.x** — if not installed on the system, the installer will automatically set up a
   bundled static Podman binary (no root required). The only host-level dependencies are:
   - `newuidmap` / `newgidmap` (from `uidmap` or `shadow-utils`)
   - Entries in `/etc/subuid` and `/etc/subgid` for the installing user
   - Check with: `grep "^$USER:" /etc/subuid`
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

The installer will interactively prompt for:
1. **Service Port**: Choose the base port (e.g. `50000` or default `8080`). The port series will automatically be allocated for container services.
2. **Accessible File System / Storage Path**: Set your preferred host directory for storing NMR spectra, project databases, and fit outputs (default: `~/.local/share/resoflow/projects`).
3. **Admin Account**: Prompt to create an initial administrator login (email, full name, secure password).

For headless or automated deployments, pass CLI flags:
```bash
./install.sh -y --port 50000 --data-dir /mnt/nmr_data --admin-email admin@lab.org --admin-password secret
```

---

## Accessing resoFlow

Once started, navigate to your configured port (e.g., http://127.0.0.1:8080 or http://127.0.0.1:50000).

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
echo -e "\n${BLUE}[3/5] Exporting container images to ${BUNDLE_DIR}/images/ (this may take a few minutes)...${NC}"

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
echo -e "\n${BLUE}[5/5] Creating final distribution archive...${NC}"
tar -czf "${ARCHIVE_PATH}" -C "${DIST_DIR}" "${BUNDLE_NAME}"
rm -rf "${BUNDLE_DIR}"

ARCHIVE_SIZE="$(du -h "${ARCHIVE_PATH}" | cut -f1)"
echo -e "\n${GREEN}${BOLD}======================================================${NC}"
echo -e "${GREEN}${BOLD}✓ Offline bundle successfully generated!${NC}"
echo -e "  Location: ${BOLD}${ARCHIVE_PATH}${NC}"
echo -e "  Size:     ${BOLD}${ARCHIVE_SIZE}${NC}"
echo -e "${GREEN}${BOLD}======================================================${NC}"
