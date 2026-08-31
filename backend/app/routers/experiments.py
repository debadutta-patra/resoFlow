from fastapi import APIRouter, HTTPException
from typing import Dict, Any, Optional

from ..services.fitting.chemex_registry import (
    get_chemex_module_registry,
    get_module_schema,
    resolve_module_name,
)

router = APIRouter(prefix="/api/experiments", tags=["experiments"])

@router.get("/registry")
def get_registry() -> Dict[str, Any]:
    """Return all registered ChemEx experiment modules and their introspected schemas."""
    return get_chemex_module_registry()

@router.get("/registry/{module_name}")
def get_module(module_name: str) -> Dict[str, Any]:
    """Return the schema and metadata for a specific ChemEx experiment module."""
    schema = get_module_schema(module_name)
    if not schema:
        raise HTTPException(status_code=404, detail=f"Module '{module_name}' not found in ChemEx registry")
    return schema
