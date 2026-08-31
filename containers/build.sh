#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Load pinned image digests
if [[ -f "${SCRIPT_DIR}/images.env" ]]; then
    # shellcheck disable=SC1091
    source "${SCRIPT_DIR}/images.env"
fi

GIT_TAG=$(git -C "${ROOT_DIR}" describe --tags --always --dirty 2>/dev/null || echo "v0.1.0")

echo "=========================================================="
echo " Building resoFlow Container Images (tag: ${GIT_TAG}) "
echo "=========================================================="

cd "${ROOT_DIR}"

# 1. Base scientific image
echo -e "\n--> [1/5] Building resoflow-base..."
podman build \
    --build-arg UV_IMAGE="${UV_IMAGE}" \
    --build-arg PYTHON_IMAGE="${PYTHON_IMAGE}" \
    -f containers/Containerfile.base \
    -t "localhost/resoflow-base:${GIT_TAG}" \
    -t "localhost/resoflow-base:latest" \
    .

# 2. API image
echo -e "\n--> [2/5] Building resoflow-api..."
podman build \
    -f containers/Containerfile.api \
    -t "localhost/resoflow-api:${GIT_TAG}" \
    -t "localhost/resoflow-api:latest" \
    .

# 3. Celery Worker image
echo -e "\n--> [3/5] Building resoflow-worker..."
podman build \
    -f containers/Containerfile.worker \
    -t "localhost/resoflow-worker:${GIT_TAG}" \
    -t "localhost/resoflow-worker:latest" \
    .

# 4. ChemEx per-job image
echo -e "\n--> [4/5] Building resoflow-chemex..."
podman build \
    --build-arg UV_IMAGE="${UV_IMAGE}" \
    --build-arg PYTHON_IMAGE="${PYTHON_IMAGE}" \
    -f containers/Containerfile.chemex \
    -t "localhost/resoflow-chemex:${GIT_TAG}" \
    -t "localhost/resoflow-chemex:latest" \
    .

# 5. Web Frontend image
echo -e "\n--> [5/5] Building resoflow-web..."
podman build \
    --build-arg NODE_IMAGE="${NODE_IMAGE}" \
    --build-arg CADDY_IMAGE="${CADDY_IMAGE}" \
    -f containers/Containerfile.web \
    -t "localhost/resoflow-web:${GIT_TAG}" \
    -t "localhost/resoflow-web:latest" \
    .

echo -e "\n=========================================================="
echo " All 5 resoFlow images built successfully! "
echo "=========================================================="
podman images "localhost/resoflow-*"
