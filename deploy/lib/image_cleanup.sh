#!/usr/bin/env bash
# Shared logic for reclaiming disk from superseded resoFlow container images.
#
# Every build tags its output twice -- `:latest`, which the service units
# reference, and a git-describe version -- so the images an update replaces
# stay on disk under their old version tag, and the multi-stage builds orphan
# their intermediate layers on top of that. A few updates in, that is several
# gigabytes doing nothing.
#
# What this removes is deliberately narrow:
#
#   1. superseded `localhost/resoflow-*:<version>` tags, keeping the newest
#      KEEP of them so there is still something to roll back to, and
#   2. untagged images carrying the io.resoflow.managed label -- layers this
#      project's own builds orphaned.
#
# Base images (postgres, redis, python, node, caddy) are never touched: on an
# air-gapped workstation they cannot be pulled back. Neither is any image a
# container still references -- during a rebuild the running pod still holds
# the previous `:latest`, and those are reclaimed by the next cleanup, once a
# restart has released them.
#
# Sourced by containers/build.sh, deploy/install.sh and deploy/resoflow-ctl.sh.
# Callers may set PODMAN_BIN; RESOFLOW_IMAGE_CLEANUP=0 disables cleanup
# everywhere, RESOFLOW_KEEP_IMAGES sets the default retention.

RF_IC_LABEL="io.resoflow.managed=true"
RF_IC_REFERENCE="localhost/resoflow-*"
RF_IC_KEEP_DEFAULT="${RESOFLOW_KEEP_IMAGES:-1}"

# Populated by rf_image_cleanup; the helpers below read them rather than
# passing five arguments around.
RF_IC_PODMAN="podman"
RF_IC_DRY_RUN=false
RF_IC_QUIET=false
RF_IC_IN_USE=""
RF_IC_REMOVED=0
RF_IC_SKIPPED=0

rf_ic_say() {
    [ "${RF_IC_QUIET}" = true ] && return 0
    echo -e "$@"
}

rf_ic_human() {
    awk -v b="${1:-0}" 'BEGIN {
        split("B KB MB GB TB", unit, " ")
        i = 1
        while (b >= 1024 && i < 5) { b /= 1024; i++ }
        if (i == 1) { printf "%d %s\n", b, unit[i] } else { printf "%.1f %s\n", b, unit[i] }
    }'
}

# Total bytes the image store occupies, for a before/after difference.
# Older podman releases word this output differently; an empty answer just
# means the summary line is skipped.
rf_ic_store_bytes() {
    "${RF_IC_PODMAN}" system df --format json 2>/dev/null \
        | grep -o '"RawSize":[0-9]*' | head -1 | cut -d: -f2 || true
}

# Image IDs some container still references. podman refuses to remove those
# anyway; filtering them out first keeps the output free of errors nobody can
# act on. ps prints full IDs, `podman images` short ones, hence the prefix
# match in rf_ic_remove.
rf_ic_in_use_ids() {
    "${RF_IC_PODMAN}" ps -a --format '{{.ImageID}}' 2>/dev/null | sort -u || true
}

rf_ic_remove() {
    local ref="$1" id="$2"

    if [ -n "${id}" ] && printf '%s\n' "${RF_IC_IN_USE}" | grep -q "^${id}"; then
        RF_IC_SKIPPED=$((RF_IC_SKIPPED + 1))
        return 0
    fi

    if [ "${RF_IC_DRY_RUN}" = true ]; then
        rf_ic_say "  would remove ${ref}"
        RF_IC_REMOVED=$((RF_IC_REMOVED + 1))
        return 0
    fi

    if "${RF_IC_PODMAN}" rmi "${ref}" > /dev/null 2>&1; then
        rf_ic_say "  removed ${ref}"
        RF_IC_REMOVED=$((RF_IC_REMOVED + 1))
    else
        # Typically a child image or a container that appeared mid-sweep.
        RF_IC_SKIPPED=$((RF_IC_SKIPPED + 1))
    fi
}

# Drop this repository's version tags beyond the newest KEEP, never touching
# `:latest` or whatever `:latest` currently points at.
rf_ic_sweep_repo() {
    local repo="$1" keep="$2"
    local latest_id rows created tag id protected=false

    latest_id="$("${RF_IC_PODMAN}" images --filter "reference=${repo}:latest" \
        --format '{{.ID}}' 2>/dev/null | head -1 || true)"

    # CreatedAt is a fixed-width UTC stamp, so a reverse string sort is a
    # newest-first sort, without depending on `podman images --sort`
    # ordering, which has flipped between releases.
    rows="$("${RF_IC_PODMAN}" images --filter "reference=${repo}" \
        --format '{{.CreatedAt}}|{{.Tag}}|{{.ID}}' 2>/dev/null | sort -r || true)"

    while IFS='|' read -r created tag id; do
        [ -n "${tag}" ] || continue
        [ "${tag}" = "latest" ] && continue
        [ "${tag}" = "<none>" ] && continue
        [ -n "${latest_id}" ] && [ "${id}" = "${latest_id}" ] && continue

        # With no `:latest` to anchor it, keep the newest version tag
        # regardless: it is what the next restart would have to fall back on.
        if [ -z "${latest_id}" ] && [ "${protected}" = false ]; then
            protected=true
            continue
        fi

        if [ "${keep}" -gt 0 ]; then
            keep=$((keep - 1))
            continue
        fi

        rf_ic_remove "${repo}:${tag}" "${id}"
    done <<< "${rows}"
}

# rf_image_cleanup [--keep N] [--dry-run] [--all-dangling] [--podman BIN] [--quiet]
#
#   --keep N         superseded builds to retain per image (default 1)
#   --dry-run        report what would go, remove nothing
#   --all-dangling   also sweep untagged images without the resoFlow label --
#                    images built before labelling existed, and other
#                    projects' leftovers
rf_image_cleanup() {
    local keep="${RF_IC_KEEP_DEFAULT}" all_dangling=false
    local before after freed ids id

    RF_IC_PODMAN="${PODMAN_BIN:-podman}"
    RF_IC_DRY_RUN=false
    RF_IC_QUIET=false
    RF_IC_REMOVED=0
    RF_IC_SKIPPED=0

    while [ $# -gt 0 ]; do
        case "$1" in
            --keep)          keep="${2:-1}"; shift 2 ;;
            --podman)        RF_IC_PODMAN="${2:-podman}"; shift 2 ;;
            --dry-run)       RF_IC_DRY_RUN=true; shift ;;
            --quiet)         RF_IC_QUIET=true; shift ;;
            --all-dangling)  all_dangling=true; shift ;;
            *) echo "rf_image_cleanup: unknown option $1" >&2; return 2 ;;
        esac
    done

    case "${RESOFLOW_IMAGE_CLEANUP:-1}" in
        0|no|false|off) return 0 ;;
    esac

    case "${keep}" in
        ''|*[!0-9]*) echo "rf_image_cleanup: --keep expects a number, got '${keep}'" >&2; return 2 ;;
    esac

    if ! command -v "${RF_IC_PODMAN}" > /dev/null 2>&1 && [ ! -x "${RF_IC_PODMAN}" ]; then
        return 0
    fi

    before="$(rf_ic_store_bytes)"
    RF_IC_IN_USE="$(rf_ic_in_use_ids)"

    local repos repo
    repos="$("${RF_IC_PODMAN}" images --filter "reference=${RF_IC_REFERENCE}" \
        --format '{{.Repository}}' 2>/dev/null | sort -u || true)"
    while IFS= read -r repo; do
        [ -n "${repo}" ] || continue
        rf_ic_sweep_repo "${repo}" "${keep}"
    done <<< "${repos}"

    if [ "${all_dangling}" = true ]; then
        ids="$("${RF_IC_PODMAN}" images --filter dangling=true \
            --format '{{.ID}}' 2>/dev/null || true)"
    else
        ids="$("${RF_IC_PODMAN}" images --filter dangling=true --filter "label=${RF_IC_LABEL}" \
            --format '{{.ID}}' 2>/dev/null || true)"
    fi
    while IFS= read -r id; do
        [ -n "${id}" ] || continue
        rf_ic_remove "${id}" "${id}"
    done <<< "${ids}"

    if [ "${RF_IC_REMOVED}" -eq 0 ]; then
        rf_ic_say "  Nothing to reclaim."
    elif [ "${RF_IC_DRY_RUN}" = true ]; then
        rf_ic_say "  ${RF_IC_REMOVED} image(s) would be removed."
    else
        after="$(rf_ic_store_bytes)"
        if [ -n "${before}" ] && [ -n "${after}" ] && [ "${before}" -gt "${after}" ]; then
            freed="$(rf_ic_human "$((before - after))")"
            rf_ic_say "  Removed ${RF_IC_REMOVED} image(s), reclaimed ${freed}."
        else
            rf_ic_say "  Removed ${RF_IC_REMOVED} image(s)."
        fi
    fi

    if [ "${RF_IC_SKIPPED}" -gt 0 ]; then
        rf_ic_say "  ${RF_IC_SKIPPED} still in use by a container; reclaimed after the next restart."
    fi

    return 0
}
