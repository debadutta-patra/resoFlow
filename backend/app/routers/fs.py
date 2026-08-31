from fastapi import APIRouter, Depends, HTTPException, Query
from typing import List, Optional
import os
import re
from pathlib import Path
from pydantic import BaseModel
from .. import models, security

router = APIRouter(prefix="/api/fs", tags=["filesystem"])

# Block access to known sensitive system, credential, and application-secret paths.
# This is a denylist, not a sandbox: any path not matched here is still
# readable/browsable by any authenticated user. Keep it broad rather than
# exhaustive-and-narrow.
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

def _sanitize_path(path: str) -> str:
    """Normalize and resolve path safely, checking for null-byte injection."""
    if "\0" in path:
        raise HTTPException(status_code=400, detail="Invalid path characters")
    expanded = os.path.expanduser(path)
    return str(Path(expanded).resolve())

def _is_sensitive_path(path_str: str) -> bool:
    """Check if the path touches forbidden system or credential files."""
    for pattern in SENSITIVE_PATTERNS:
        if pattern.search(path_str):
            return True
    return False


class FileItem(BaseModel):
    name: str
    path: str
    is_dir: bool


@router.get("/browse", response_model=List[FileItem])
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
        
    items = []
    
    # Add parent directory entry if not at root
    parent_path = os.path.dirname(target_path)
    if parent_path and parent_path != target_path:
        items.append(FileItem(
            name="..",
            path=parent_path,
            is_dir=True
        ))
        
    try:
        entries = os.listdir(target_path)
        
        dir_items = []
        file_items = []
        
        for entry in entries:
            # Skip hidden files
            if entry.startswith('.'):
                continue
                
            full_path = os.path.join(target_path, entry)
            is_dir = os.path.isdir(full_path)
            item = FileItem(
                name=entry,
                path=full_path,
                is_dir=is_dir
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
        
        return items
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied to access this directory")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


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
        with open(target_path, "r", errors="replace") as f:
            content = f.read()
        return {"content": content, "path": target_path}
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied to read this file")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


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
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
