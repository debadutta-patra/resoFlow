from fastapi import APIRouter, Depends, HTTPException, Query
from typing import Callable, List, Optional
import logging
import os
import re
from pathlib import Path
from pydantic import BaseModel
from .. import models, security

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/fs", tags=["filesystem"])

# Cap for /read. The previews this serves are small text files (ChemEx method
# TOML, peak lists); without a limit, aiming the endpoint at a multi-gigabyte
# spectrum would pull the whole file into the API process.
MAX_READ_BYTES = 5 * 1024 * 1024

# Block access to known sensitive system, credential, and application-secret paths.
# This is the second layer: _allowed_roots() confines the explorer to the
# project data root (plus RESOFLOW_EXTRA_BROWSE_ROOTS), and these patterns then
# deny anything sensitive that happens to sit inside one of those roots. Keep it
# broad rather than exhaustive-and-narrow.
SENSITIVE_PATTERNS = [
    # System auth databases
    re.compile(r"^/etc/(shadow|gshadow|sudoers|master\.passwd)"),
    re.compile(r"^/proc/"),
    re.compile(r"^/sys/"),
    # This application's own secrets / source
    re.compile(r"resoflow\.env$"),
    re.compile(r"/\.config/resoflow/"),
    re.compile(r"(^|/)app/security\.py$"),
    # Generic env / dotenv files (".env", "app.env", ".env.production", ...)
    re.compile(r"\.env(\.[\w-]+)?$"),
    # SSH keys and known_hosts/config
    re.compile(r"/\.ssh(/|$)"),
    re.compile(r"id_rsa|id_ecdsa|id_ed25519|id_dsa"),
    # Cloud / tool credential files
    re.compile(r"/\.aws/credentials$"),
    re.compile(r"/\.netrc$"),
    re.compile(r"/\.pgpass$"),
    re.compile(r"/\.docker/config\.json$"),
    re.compile(r"/\.kube/config$"),
    re.compile(r"/\.npmrc$"),
    re.compile(r"/\.pypirc$"),
    # GPG keyrings
    re.compile(r"/\.gnupg(/|$)"),
    # Browser/password-manager credential stores
    re.compile(r"/\.mozilla/.*/(logins|key)[\w.]*\.(json|db)$"),
    re.compile(r"/\.config/google-chrome/.*/Login Data$"),
]

from ..services.path_utils import (
    get_container_data_root,
    get_host_data_root,
    to_container_path,
)

def _allowed_roots() -> List[Path]:
    """Directories the explorer is permitted to serve.

    The project data root is always allowed. RESOFLOW_EXTRA_BROWSE_ROOTS
    (os.pathsep separated) widens that for deployments keeping spectra outside
    the project tree. With nothing configured -- a bare development run -- the
    user's home directory is the boundary. A configured root that does not
    exist is ignored rather than locking the explorer out entirely.
    """
    candidates: List[Path] = []
    for raw in (
        os.environ.get("RESOFLOW_CONTAINER_DATA_ROOT"),
        os.environ.get("PROJECTS_STORAGE_PATH"),
    ):
        if raw and raw.strip():
            candidates.append(Path(raw.strip()))

    extra = os.environ.get("RESOFLOW_EXTRA_BROWSE_ROOTS")
    if extra:
        candidates.extend(Path(p.strip()) for p in extra.split(os.pathsep) if p.strip())

    roots: List[Path] = []
    for candidate in candidates:
        try:
            resolved = Path(os.path.expanduser(str(candidate))).resolve()
        except OSError:
            continue
        if resolved.is_dir() and resolved not in roots:
            roots.append(resolved)

    if not roots:
        roots.append(Path(os.path.expanduser("~")).resolve())
    return roots


def _is_within_allowed_roots(resolved_path: str) -> bool:
    """Whether an already-resolved absolute path sits inside a permitted root."""
    p = Path(resolved_path)
    for root in _allowed_roots():
        try:
            p.relative_to(root)
            return True
        except ValueError:
            continue
    return False


def _sanitize_path(path: str) -> str:
    """Resolve a path to one the explorer is allowed to serve.

    Rejects empty paths and null bytes, translates host paths into this
    environment, then confines the result to the permitted roots. Resolution
    happens before the containment check, so a symlink cannot be used to step
    outside a root.
    """
    if not path or not path.strip():
        # Path("").resolve() silently yields the API process CWD (/app inside the
        # container), which sits on the container overlay rather than the host
        # bind mount. Refuse rather than write somewhere the caller can't see.
        raise HTTPException(status_code=400, detail="Path must not be empty")
    if "\0" in path:
        raise HTTPException(status_code=400, detail="Invalid path characters")
    expanded = os.path.expanduser(path)
    c_path = to_container_path(expanded)
    if c_path and os.path.exists(c_path):
        resolved = str(Path(c_path).resolve())
    else:
        resolved = str(Path(expanded).resolve())

    if not _is_within_allowed_roots(resolved):
        raise HTTPException(
            status_code=403, detail="Path is outside the permitted directories"
        )
    return resolved

def _display_path_mapper() -> Callable[[str], str]:
    """Build a container -> host path rewriter for one listing.

    Entries are returned in this environment's path space, which is what the
    API and database consume, but that is not what the user sees on their own
    machine when the API runs in a container. This produces the host-facing
    spelling for display only. Built once per request: to_host_path() resolves
    on every call, which is far too much work per directory entry.
    """
    host_root = get_host_data_root()
    container_root = get_container_data_root()
    if not host_root or not container_root:
        return lambda p: p

    try:
        host_str = str(Path(host_root).resolve())
        container_str = str(Path(container_root).resolve())
    except OSError:
        return lambda p: p

    prefix = container_str.rstrip(os.sep) + os.sep

    def mapper(p: str) -> str:
        if p == container_str:
            return host_str
        if p.startswith(prefix):
            return host_str.rstrip(os.sep) + os.sep + p[len(prefix):]
        return p

    return mapper


def _is_sensitive_path(path_str: str) -> bool:
    """Check if the path touches forbidden system or credential files."""
    for pattern in SENSITIVE_PATTERNS:
        if pattern.search(path_str):
            return True
    return False


class FileItem(BaseModel):
    name: str
    # Canonical path in this environment's space. This is what callers send
    # back to the API and what gets stored on the project record.
    path: str
    # The same location as the user's own machine spells it. Display only.
    display_path: str
    is_dir: bool
    is_symlink: bool = False
    # Both are None for directories and for entries that could not be stat'd
    # (a broken symlink, or one deleted mid-listing).
    size: Optional[int] = None
    modified: Optional[float] = None


class RootInfo(BaseModel):
    """A directory the explorer is permitted to serve.

    Returned so the client can offer quick access to them, and so a breadcrumb
    trail can stop at the root rather than rendering parent segments that would
    be refused on click.
    """
    name: str
    path: str
    display_path: str


def _root_info(root: Path, to_display: Callable[[str], str]) -> "RootInfo":
    """Describe a permitted root for the client's quick-access list.

    The label comes from the host-facing spelling, not the canonical one: a
    container root of /data/projects bound to the user's home would otherwise
    be labelled "projects" while showing "/home/<user>".
    """
    display = to_display(str(root))
    return RootInfo(
        name=Path(display).name or display,
        path=str(root),
        display_path=display,
    )


class BrowseResponse(BaseModel):
    """A directory listing together with the directory it was resolved from.

    The resolved path has to be echoed back: when the client browses without
    one, the server picks the default storage root, and the client would
    otherwise have no way to aim follow-up calls (mkdir) at the directory
    currently on screen.
    """
    path: str
    display_path: str
    items: List[FileItem]
    roots: List[RootInfo] = []


@router.get("/browse", response_model=BrowseResponse)
def browse_filesystem(
    path: Optional[str] = Query(None, description="Directory path to browse"),
    current_user: models.User = Depends(security.get_current_user),
):
    if path:
        target_path = _sanitize_path(path)
    else:
        default_dir = os.environ.get("PROJECTS_STORAGE_PATH") or os.environ.get("RESOFLOW_CONTAINER_DATA_ROOT")
        if default_dir and os.path.isdir(default_dir):
            target_path = _sanitize_path(default_dir)
        else:
            target_path = _sanitize_path("~")
    
    if _is_sensitive_path(target_path):
        raise HTTPException(status_code=403, detail="Access to sensitive path forbidden")

    if not os.path.exists(target_path) or not os.path.isdir(target_path):
        raise HTTPException(status_code=400, detail="Invalid directory path")
        
    to_display = _display_path_mapper()
    items = []

    # Add parent directory entry, unless doing so would step outside the
    # permitted roots (browsing up from the data root used to reach /).
    parent_path = os.path.dirname(target_path)
    if parent_path and parent_path != target_path and _is_within_allowed_roots(parent_path):
        items.append(FileItem(
            name="..",
            path=parent_path,
            display_path=to_display(parent_path),
            is_dir=True
        ))

    try:
        dir_items = []
        file_items = []

        # scandir carries the entry type in the directory record, so is_dir()
        # is free where the filesystem provides it; the one stat per entry
        # buys the size and mtime that os.path.isdir() previously spent it on.
        with os.scandir(target_path) as scanner:
            for entry in scanner:
                # Skip hidden files
                if entry.name.startswith('.'):
                    continue

                is_symlink = entry.is_symlink()
                try:
                    is_dir = entry.is_dir()
                except OSError:
                    is_dir = False

                try:
                    stat_result = entry.stat()
                    size = None if is_dir else stat_result.st_size
                    modified = stat_result.st_mtime
                except OSError:
                    # Broken symlink, or the entry went away mid-listing. Show
                    # it, but without metadata we cannot claim a size or date.
                    size = None
                    modified = None

                item = FileItem(
                    name=entry.name,
                    path=entry.path,
                    display_path=to_display(entry.path),
                    is_dir=is_dir,
                    is_symlink=is_symlink,
                    size=size,
                    modified=modified,
                )

                if is_dir:
                    dir_items.append(item)
                else:
                    file_items.append(item)

        # Sort directories first, then alphabetically
        dir_items.sort(key=lambda x: x.name.lower())
        file_items.sort(key=lambda x: x.name.lower())

        items.extend(dir_items)
        items.extend(file_items)

        return BrowseResponse(
            path=target_path,
            display_path=to_display(target_path),
            items=items,
            roots=[
                _root_info(root, to_display)
                for root in _allowed_roots()
            ],
        )
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied to access this directory")
    except OSError:
        logger.exception("Failed to list directory %s", target_path)
        raise HTTPException(status_code=500, detail="Failed to list directory")


@router.get("/read")
def read_file_content(
    path: str = Query(..., description="Full path to the file to read"),
    current_user: models.User = Depends(security.get_current_user)
):
    """Read the content of a text file at the specified path."""
    target_path = _sanitize_path(path)

    if _is_sensitive_path(target_path):
        raise HTTPException(status_code=403, detail="Access to sensitive file forbidden")

    if not os.path.exists(target_path) or not os.path.isfile(target_path):
        raise HTTPException(status_code=404, detail="File not found")
        
    try:
        if os.path.getsize(target_path) > MAX_READ_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"File is too large to preview (limit {MAX_READ_BYTES // (1024 * 1024)} MB)",
            )
        with open(target_path, "rb") as f:
            raw = f.read(MAX_READ_BYTES)
        # A NUL in the leading block is the usual cheap test for "not text".
        if b"\0" in raw[:8192]:
            raise HTTPException(status_code=415, detail="File is not a text file")
        return {"content": raw.decode("utf-8", errors="replace"), "path": target_path}
    except HTTPException:
        raise
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied to read this file")
    except OSError:
        logger.exception("Failed to read file %s", target_path)
        raise HTTPException(status_code=500, detail="Failed to read file")


class MkdirRequest(BaseModel):
    path: str
    name: str


@router.post("/mkdir")
def create_directory(
    request: MkdirRequest,
    current_user: models.User = Depends(security.get_current_user)
):
    """Create a new directory at the specified path."""
    # Sanitize folder name to prevent path traversal
    clean_name = os.path.basename(request.name.strip())
    if not clean_name or clean_name in (".", "..") or "/" in clean_name or "\\" in clean_name:
        raise HTTPException(status_code=400, detail="Invalid directory name")

    base_dir = _sanitize_path(request.path)
    if _is_sensitive_path(base_dir):
        raise HTTPException(status_code=403, detail="Creation in sensitive path forbidden")

    full_path = os.path.join(base_dir, clean_name)
    
    if os.path.exists(full_path):
        raise HTTPException(status_code=400, detail="Directory or file already exists")
        
    try:
        os.makedirs(full_path, exist_ok=True)
        return {"detail": "Directory created successfully", "path": full_path}
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied to create directory")
    except OSError:
        logger.exception("Failed to create directory %s", full_path)
        raise HTTPException(status_code=500, detail="Failed to create directory")
