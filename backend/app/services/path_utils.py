import os
from pathlib import Path
from typing import Optional, Union

def get_host_data_root() -> Optional[str]:
    return os.getenv("RESOFLOW_HOST_DATA_ROOT")

def get_container_data_root() -> Optional[str]:
    return os.getenv("RESOFLOW_CONTAINER_DATA_ROOT") or os.getenv("PROJECTS_STORAGE_PATH")

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

    p = Path(path_str).resolve()
    host_root = get_host_data_root()
    container_root = get_container_data_root()

    if host_root and container_root:
        host_root_p = Path(host_root).resolve()
        container_root_p = Path(container_root).resolve()
        try:
            rel = p.relative_to(container_root_p)
            return str(host_root_p / rel)
        except ValueError:
            pass
    elif host_root and not container_root:
        # Check common mounts like /data or /app/data
        for candidate_root in [Path("/data"), Path("/app/data"), Path("/work")]:
            try:
                rel = p.relative_to(candidate_root)
                return str(Path(host_root).resolve() / rel)
            except ValueError:
                continue

    return str(p)


def resolve_existing_path(path: Union[Path, str, None], base_dir: Optional[str] = None) -> Optional[str]:
    """
    Find where a path actually exists, trying:
    1. Direct path
    2. to_container_path(path)
    3. to_host_path(path)
    4. Relative to base_dir (if provided)
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
        return c_path

    # Check 3: host mapped
    h_path = to_host_path(path_str)
    if h_path and os.path.exists(h_path):
        return h_path

    # Check 4: relative to base_dir
    if base_dir:
        rel_path = os.path.join(base_dir, os.path.basename(path_str))
        if os.path.exists(rel_path):
            return str(Path(rel_path).resolve())

    # Fallback to container path if mapped, else direct
    return c_path or str(Path(path_str).resolve())
