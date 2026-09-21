#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

KEEP_IMAGES="${RESOFLOW_KEEP_IMAGES:-1}"

usage() {
    cat << 'EOF'
Usage: ./containers/build.sh [OPTIONS]

Build the five resoFlow container images, then reclaim the disk the builds
they replace were holding.

Options:
      --keep N       Superseded builds to keep per image (default: 1)
      --no-cleanup   Build only; leave superseded images on disk
  -h, --help         Show this message

The same can be set through the environment: RESOFLOW_KEEP_IMAGES=N, or
RESOFLOW_IMAGE_CLEANUP=0 to skip the cleanup.
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --keep)       KEEP_IMAGES="${2:-1}"; shift 2 ;;
        --no-cleanup) RESOFLOW_IMAGE_CLEANUP=0; shift ;;
        -h|--help)    usage; exit 0 ;;
        *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
    esac
done

if [[ ! "${KEEP_IMAGES}" =~ ^[0-9]+$ ]]; then
    echo "--keep expects a number, got '${KEEP_IMAGES}'" >&2
    exit 1
fi

# Load pinned image digests
if [[ -f "${SCRIPT_DIR}/images.env" ]]; then
    # shellcheck disable=SC1091
    source "${SCRIPT_DIR}/images.env"
fi

# shellcheck source=../deploy/lib/image_cleanup.sh
source "${ROOT_DIR}/deploy/lib/image_cleanup.sh"

# The installer may have resolved a static Podman that is not the one on
# PATH. Building with one and cleaning up with the other would address two
# different image stores.
PODMAN="${PODMAN_BIN:-podman}"

GIT_TAG=$(git -C "${ROOT_DIR}" describe --tags --always --dirty 2>/dev/null || echo "v0.1.0")

echo "=========================================================="
echo " Building resoFlow Container Images (tag: ${GIT_TAG}) "
echo "=========================================================="

cd "${ROOT_DIR}"

# 1. Base scientific image
echo -e "\n--> [1/5] Building resoflow-base..."
"${PODMAN}" build \
    --build-arg UV_IMAGE="${UV_IMAGE}" \
    --build-arg PYTHON_IMAGE="${PYTHON_IMAGE}" \
    -f containers/Containerfile.base \
    -t "localhost/resoflow-base:${GIT_TAG}" \
    -t "localhost/resoflow-base:latest" \
    .

# 2. API image
echo -e "\n--> [2/5] Building resoflow-api..."
"${PODMAN}" build \
    -f containers/Containerfile.api \
    -t "localhost/resoflow-api:${GIT_TAG}" \
    -t "localhost/resoflow-api:latest" \
    .

# 3. Celery Worker image
echo -e "\n--> [3/5] Building resoflow-worker..."
"${PODMAN}" build \
    -f containers/Containerfile.worker \
    -t "localhost/resoflow-worker:${GIT_TAG}" \
    -t "localhost/resoflow-worker:latest" \
    .

# 4. ChemEx per-job image
echo -e "\n--> [4/5] Building resoflow-chemex..."
"${PODMAN}" build \
    --build-arg UV_IMAGE="${UV_IMAGE}" \
    --build-arg PYTHON_IMAGE="${PYTHON_IMAGE}" \
    -f containers/Containerfile.chemex \
    -t "localhost/resoflow-chemex:${GIT_TAG}" \
    -t "localhost/resoflow-chemex:latest" \
    .

# 5. Web Frontend image
echo -e "\n--> [5/5] Building resoflow-web..."
"${PODMAN}" build \
    --build-arg NODE_IMAGE="${NODE_IMAGE}" \
    --build-arg CADDY_IMAGE="${CADDY_IMAGE}" \
    -f containers/Containerfile.web \
    -t "localhost/resoflow-web:${GIT_TAG}" \
    -t "localhost/resoflow-web:latest" \
    .

echo -e "\n=========================================================="
echo " All 5 resoFlow images built successfully! "
echo "=========================================================="

# Only now, with every build finished, are the images this run replaced safe
# to drop -- a failure above leaves the previous build in place to fall back
# on. Containers still holding the old `:latest` are skipped and reclaimed by
# the cleanup that follows the restart.
echo -e "\n--> Reclaiming disk from superseded images..."
rf_image_cleanup --keep "${KEEP_IMAGES}" --podman "${PODMAN}" || true

echo ""
"${PODMAN}" images "localhost/resoflow-*"
