#!/usr/bin/env bash
# Shared logic for managing extra file-explorer browse roots.
#
# The file explorer is confined to the project data root. Directories outside
# it (an instrument drive, a NAS share) need two things wired up together, or
# they silently do nothing:
#
#   1. a bind mount into the api and worker containers, and
#   2. RESOFLOW_EXTRA_BROWSE_ROOTS naming the *container-side* path.
#
# Getting either half wrong fails quietly: an unmounted path does not exist
# inside the container, so the backend drops it from the permitted roots
# without an error. This library keeps both halves in step so nobody has to
# hand-edit a unit file.
#
# Sourced by deploy/install.sh (install time) and deploy/browse-roots.sh
# (post-install). Callers must set: ENV_FILE, QUADLET_DIR, USER_SYSTEMD_DIR.

BR_MOUNT_PREFIX="/data/extra"
BR_MOUNTS_KEY="RESOFLOW_EXTRA_MOUNTS"
BR_ROOTS_KEY="RESOFLOW_EXTRA_BROWSE_ROOTS"

# --- env file helpers ----------------------------------------------------

br_env_get() {
    local key="$1" file="${2:-${ENV_FILE}}"
    [ -f "${file}" ] || return 0
    sed -n "s|^${key}=||p" "${file}" | tail -n 1
}

br_env_set() {
    local key="$1" value="$2" file="${3:-${ENV_FILE}}"
    mkdir -p "$(dirname "${file}")"
    touch "${file}"
    if grep -q "^${key}=" "${file}" 2>/dev/null; then
        # Portable in-place edit: BSD sed needs an explicit backup suffix.
        sed -i.bak "s|^${key}=.*|${key}=${value}|" "${file}" 2>/dev/null \
            || sed -i '' "s|^${key}=.*|${key}=${value}|" "${file}"
        rm -f "${file}.bak"
    else
        printf '%s=%s\n' "${key}" "${value}" >> "${file}"
    fi
}

# --- path helpers --------------------------------------------------------

br_normalize_host_path() {
    local p="$1"
    case "${p}" in
        "~") p="${HOME}" ;;
        "~/"*) p="${HOME}/${p#\~/}" ;;
    esac
    # Resolve to an absolute, symlink-free path when it exists.
    if [ -d "${p}" ]; then
        (cd "${p}" 2>/dev/null && pwd) || printf '%s' "${p}"
    else
        printf '%s' "${p}"
    fi
}

# Container-side path for a host directory: /data/extra/<slug>, made unique
# against the slugs already in use (passed as a space-separated list).
br_container_path() {
    local host_path="$1" used="${2:-}"
    local slug
    slug="$(basename "${host_path}" | tr -c '[:alnum:]._-' '_' | sed 's|_*$||')"
    [ -n "${slug}" ] || slug="root"

    local candidate="${BR_MOUNT_PREFIX}/${slug}"
    local n=2
    # Pattern match on a space-padded list: word splitting would drop the
    # leading space and make the first entry unmatchable.
    while case " ${used} " in *" ${candidate} "*) true ;; *) false ;; esac; do
        candidate="${BR_MOUNT_PREFIX}/${slug}_${n}"
        n=$((n + 1))
    done
    printf '%s' "${candidate}"
}

# --- mount list (persisted as host:container;host:container) --------------

br_mounts_get() {
    br_env_get "${BR_MOUNTS_KEY}"
}

# Print current mounts one "host container" pair per line.
br_mounts_each() {
    local raw pair
    raw="$(br_mounts_get)"
    [ -n "${raw}" ] || return 0
    local IFS=';'
    for pair in ${raw}; do
        [ -n "${pair}" ] || continue
        printf '%s %s\n' "${pair%%:*}" "${pair#*:}"
    done
}

# Add a host directory. Echoes a status word: added | exists | covered | missing
br_mounts_add() {
    local host_path="$1" data_dir="${2:-}"
    host_path="$(br_normalize_host_path "${host_path}")"

    if [ ! -d "${host_path}" ]; then
        printf 'missing'
        return 1
    fi
    case "${host_path}" in
        *[[:space:]]*)
            # A path with whitespace cannot survive the podman run ExecStart line.
            printf 'whitespace'
            return 1
            ;;
    esac

    local existing_host existing_cont used="" pairs=""
    while read -r existing_host existing_cont; do
        [ -n "${existing_host}" ] || continue
        if [ "${existing_host}" = "${host_path}" ]; then
            printf 'exists'
            return 0
        fi
        used="${used} ${existing_cont}"
        pairs="${pairs}${existing_host}:${existing_cont};"
    done <<EOF
$(br_mounts_each)
EOF

    # Anything inside the data root is already reachable; a second mount would
    # only produce a duplicate entry in the picker.
    if [ -n "${data_dir}" ] && { [ "${host_path}" = "${data_dir}" ] || case "${host_path}" in "${data_dir}"/*) true ;; *) false ;; esac; }; then
        printf 'covered'
        return 0
    fi

    local container_path
    container_path="$(br_container_path "${host_path}" "${used}")"
    br_env_set "${BR_MOUNTS_KEY}" "${pairs}${host_path}:${container_path}"
    printf 'added'
}

# Remove a host directory. Echoes: removed | absent
br_mounts_remove() {
    local target="$1"
    target="$(br_normalize_host_path "${target}")"

    local h c pairs="" found=false
    while read -r h c; do
        [ -n "${h}" ] || continue
        if [ "${h}" = "${target}" ]; then
            found=true
            continue
        fi
        pairs="${pairs}${h}:${c};"
    done <<EOF
$(br_mounts_each)
EOF

    if [ "${found}" = true ]; then
        br_env_set "${BR_MOUNTS_KEY}" "${pairs}"
        printf 'removed'
    else
        printf 'absent'
        return 1
    fi
}

# --- unit file patching --------------------------------------------------

# Rewrite the extra Volume= lines of a quadlet .container file.
br_patch_quadlet_unit() {
    local unit="$1"
    [ -f "${unit}" ] || return 0

    local h c inserts=""
    while read -r h c; do
        [ -n "${h}" ] || continue
        inserts="${inserts}Volume=${h}:${c}:z\n"
    done <<EOF
$(br_mounts_each)
EOF

    awk -v inserts="${inserts}" '
        # Drop previously generated extra mounts; they are rebuilt below.
        /^Volume=.*:\/data\/extra\// { next }
        { print }
        /^Volume=.*:\/data\/projects:z$/ {
            if (inserts != "") { printf "%s", inserts }
        }
    ' "${unit}" > "${unit}.tmp" && mv "${unit}.tmp" "${unit}"
}

# Rewrite the extra -v flags inside a systemd unit's ExecStart line.
br_patch_systemd_unit() {
    local unit="$1"
    [ -f "${unit}" ] || return 0

    local h c flags=""
    while read -r h c; do
        [ -n "${h}" ] || continue
        flags="${flags} -v ${h}:${c}:z"
    done <<EOF
$(br_mounts_each)
EOF

    awk -v flags="${flags}" '
        /^ExecStart=/ {
            gsub(/ -v [^ ]+:\/data\/extra\/[^ ]+:z/, "")
            if (flags != "") {
                sub(/-v [^ ]+:\/data\/projects:z/, "&" flags)
            }
        }
        { print }
    ' "${unit}" > "${unit}.tmp" && mv "${unit}.tmp" "${unit}"
}

# --- top-level sync ------------------------------------------------------

# Derive RESOFLOW_EXTRA_BROWSE_ROOTS from the mount list and patch every unit
# file that exists. Safe to call repeatedly.
br_sync() {
    local h c roots=""
    while read -r h c; do
        [ -n "${h}" ] || continue
        if [ -n "${roots}" ]; then roots="${roots}:${c}"; else roots="${c}"; fi
    done <<EOF
$(br_mounts_each)
EOF

    br_env_set "${BR_ROOTS_KEY}" "${roots}"

    br_patch_quadlet_unit "${QUADLET_DIR}/resoflow-api.container"
    br_patch_quadlet_unit "${QUADLET_DIR}/resoflow-worker.container"
    br_patch_systemd_unit "${USER_SYSTEMD_DIR}/resoflow-api.service"
    br_patch_systemd_unit "${USER_SYSTEMD_DIR}/resoflow-worker.service"
}

# Human-readable listing of the configured extra roots.
br_list() {
    local h c any=false
    while read -r h c; do
        [ -n "${h}" ] || continue
        any=true
        printf '  %s\n      seen by resoFlow as %s\n' "${h}" "${c}"
    done <<EOF
$(br_mounts_each)
EOF
    [ "${any}" = true ] || printf '  (none configured)\n'
}
