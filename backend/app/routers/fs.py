from fastapi import APIRouter, Depends, HTTPException, Query
from typing import List, Optional
import os
from pydantic import BaseModel
from .. import models, security

router = APIRouter(prefix="/api/fs", tags=["filesystem"])

class FileItem(BaseModel):
    name: str
    path: str
    is_dir: bool

@router.get("/browse", response_model=List[FileItem])
def browse_filesystem(
    path: Optional[str] = Query(None, description="Directory path to browse"),
    current_user: models.User = Depends(security.get_current_user)
):
    if not path:
        path = os.path.expanduser("~")
    
    if not os.path.exists(path) or not os.path.isdir(path):
        raise HTTPException(status_code=400, detail="Invalid directory path")
        
    items = []
    
    # Add parent directory entry if not at root
    parent_path = os.path.dirname(path)
    if parent_path and parent_path != path:
        items.append(FileItem(
            name="..",
            path=parent_path,
            is_dir=True
        ))
        
    try:
        entries = os.listdir(path)
        
        dir_items = []
        file_items = []
        
        for entry in entries:
            # Skip hidden files
            if entry.startswith('.'):
                continue
                
            full_path = os.path.join(path, entry)
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
    if not os.path.exists(path) or not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="File not found")
        
    try:
        with open(path, "r") as f:
            content = f.read()
        return {"content": content, "path": path}
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
    full_path = os.path.join(request.path, request.name)
    
    if os.path.exists(full_path):
        raise HTTPException(status_code=400, detail="Directory or file already exists")
        
    try:
        os.makedirs(full_path, exist_ok=True)
        return {"detail": "Directory created successfully", "path": full_path}
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied to create directory")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
