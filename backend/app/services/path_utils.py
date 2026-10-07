import os
from pathlib import Path
from typing import Optional, Union

def get_host_data_root() -> Optional[str]:
    return os.getenv("RESOFLOW_HOST_DATA_ROOT")

def get_container_data_root() -> Optional[str]:
    return os.getenv("RESOFLOW_CONTAINER_DATA_ROOT") or os.getenv("PROJECTS_STORAGE_PATH")

def get_extra_mount_pairs() -> list[tuple[Path, Path]]:
    """
    Parse RESOFLOW_EXTRA_MOUNTS (e.g. host_path:container_path, ...) into list of (host_p, container_p).
    """
    raw = os.getenv("RESOFLOW_EXTRA_MOUNTS")
    if not raw:
        return []
    pairs: list[tuple[Path, Path]] = []
    tokens = [t.strip() for part in raw.split(",") for t in part.split() if t.strip()]
    for token in tokens:
        if ":" in token:
            h, c = token.split(":", 1)
            if h.strip() and c.strip():
                try:
                    pairs.append((Path(h.strip()).resolve(), Path(c.strip()).resolve()))
                except Exception:
                    pass
    return pairs

def to_container_path(path: Union[Path, str, None]) -> Optional[str]:
    """
    Translate a path (which might be a workstation host path, e.g. /home/user/...)
    to the path inside the current environment (e.g. /data/projects/...).
    If the path already exists locally, or if no mapping is configured, returns
    the normalized resolved path.
    """
    if not path:
        return None
        
    path_str = str(path).strip()
    if not path_str:
        return ""

    host_root = get_host_data_root()
    container_root = get_container_data_root()

    # If the path exists as-is, return its normalized form
    if os.path.exists(path_str):
        return str(Path(path_str).resolve())

    if host_root and container_root:
        host_root_p = Path(host_root).resolve()
        container_root_p = Path(container_root).resolve()
        try:
            p = Path(path_str).resolve()
            rel = p.relative_to(host_root_p)
            mapped = container_root_p / rel
            if os.path.exists(str(mapped)):
                return str(mapped)
            return str(mapped)
        except ValueError:
            pass

    for host_p, container_p in get_extra_mount_pairs():
        try:
            p = Path(path_str).resolve()
            rel = p.relative_to(host_p)
            mapped = container_p / rel
            if os.path.exists(str(mapped)):
                return str(mapped)
            return str(mapped)
        except ValueError:
            pass

    return str(Path(path_str).resolve())


def to_host_path(path: Union[Path, str, None]) -> Optional[str]:
    """
    Translate a path within the worker/API environment (e.g. /data/projects/...)
    to the workstation host path (e.g. /home/user/...).
    Uses RESOFLOW_HOST_DATA_ROOT and RESOFLOW_CONTAINER_DATA_ROOT environment variables.
    If not set or cannot be mapped, returns the resolved path.
    """
    if not path:
        return None

    path_str = str(path).strip()
    if not path_str:
        return ""

    try:
        p = Path(path_str).resolve()
    except Exception:
        return path_str

    host_root = get_host_data_root()
    container_root = get_container_data_root()

    if host_root and container_root:
        host_root_p = Path(host_root).resolve()
        container_root_p = Path(container_root).resolve()
        try:
            rel = p.relative_to(container_root_p)
            mapped = host_root_p / rel
            if os.path.exists(str(mapped)):
                return str(mapped)
            return str(mapped)
        except ValueError:
            pass

    for host_p, container_p in get_extra_mount_pairs():
        try:
            rel = p.relative_to(container_p)
            mapped = host_p / rel
            if os.path.exists(str(mapped)):
                return str(mapped)
            return str(mapped)
        except ValueError:
            pass

    if host_root and not container_root:
        # Check common mounts like /data or /app/data
        for candidate_root in [Path("/data"), Path("/app/data"), Path("/work")]:
            try:
                rel = p.relative_to(candidate_root)
                mapped = Path(host_root).resolve() / rel
                if os.path.exists(str(mapped)):
                    return str(mapped)
                return str(mapped)
            except ValueError:
                continue

    return str(p)


def find_existing_path(path: Union[Path, str, None], base_dir: Optional[str] = None) -> Optional[str]:
    """
    Search for where a path actually exists on disk, trying in order:
    1. Direct path as-is
    2. Container-mapped path (via RESOFLOW_CONTAINER_DATA_ROOT or RESOFLOW_EXTRA_MOUNTS)
    3. Host-mapped path (via RESOFLOW_HOST_DATA_ROOT or RESOFLOW_EXTRA_MOUNTS)
    4. Explicit check against every extra mount pair both ways
    5. Relative to base_dir (e.g. project local directory)

    Returns the string of the path that exists on disk, or None if not found.
    """
    if not path:
        return None

    path_str = str(path).strip()
    if not path_str:
        return None

    # Check 1: direct
    if os.path.exists(path_str):
        return str(Path(path_str).resolve())

    # Check 2: container mapped
    c_path = to_container_path(path_str)
    if c_path and os.path.exists(c_path):
        return str(Path(c_path).resolve())

    # Check 3: host mapped
    h_path = to_host_path(path_str)
    if h_path and os.path.exists(h_path):
        return str(Path(h_path).resolve())

    # Check 4: all extra mounts both ways
    try:
        p = Path(path_str).resolve()
        for host_p, container_p in get_extra_mount_pairs():
            try:
                rel = p.relative_to(host_p)
                cand = str(container_p / rel)
                if os.path.exists(cand):
                    return str(Path(cand).resolve())
            except ValueError:
                pass
            try:
                rel = p.relative_to(container_p)
                cand = str(host_p / rel)
                if os.path.exists(cand):
                    return str(Path(cand).resolve())
            except ValueError:
                pass
    except Exception:
        pass

    # Check 5: container mount swapping (/data/projects <-> /data/extra)
    for prefix, repl in [("/data/projects/", "/data/extra/"), ("/data/extra/", "/data/projects/")]:
        if prefix in path_str:
            alt = path_str.replace(prefix, repl, 1)
            if os.path.exists(alt):
                return str(Path(alt).resolve())
            h_alt = to_host_path(alt)
            if h_alt and os.path.exists(h_alt):
                return str(Path(h_alt).resolve())
            c_alt = to_container_path(alt)
            if c_alt and os.path.exists(c_alt):
                return str(Path(c_alt).resolve())

    # Check 6: relative to base_dir
    if base_dir:
        rel_path = os.path.join(base_dir, os.path.basename(path_str))
        if os.path.exists(rel_path):
            return str(Path(rel_path).resolve())

    return None


def check_path_exists(path: Union[Path, str, None], base_dir: Optional[str] = None) -> bool:
    """Return True if path exists directly or after container/host mapping, else False."""
    return find_existing_path(path, base_dir) is not None


def resolve_existing_path(path: Union[Path, str, None], base_dir: Optional[str] = None) -> Optional[str]:
    """
    Find where a path actually exists on disk. If found, returns the existing path.
    Otherwise falls back to container-mapped path (or normalized path) for backward compatibility.
    """
    found = find_existing_path(path, base_dir)
    if found:
        return found

    if not path:
        return None

    path_str = str(path).strip()
    if not path_str:
        return None

    c_path = to_container_path(path_str)
    return c_path or str(Path(path_str).resolve())
