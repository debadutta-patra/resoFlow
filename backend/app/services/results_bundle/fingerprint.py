"""Fingerprint Calculation and In-Process Caching for Results Bundle (§3.11).

bundle_fingerprint = sha256(parser_version, bundle_schema, sorted((relpath, size, mtime_ns)))
Cached in-process for 60 seconds at read time to avoid repeated disk stat traversals.
"""

from __future__ import annotations

import hashlib
import os
import time
from pathlib import Path
from typing import Dict, Tuple, Union

from .schema import BUNDLE_SCHEMA_VERSION, PARSER_VERSION

# In-process cache: resolved path -> (timestamp_seconds, fingerprint_hex)
_FINGERPRINT_CACHE: Dict[str, Tuple[float, str]] = {}
CACHE_TTL_SECONDS = 60.0

IGNORED_DIRS = {
    "results",
    "results.tmp",
    "results.old",
    "__pycache__",
    ".git",
    "artifacts",
}

IGNORED_FILES = {
    "chemex.log",
    "progress.jsonl",
    "heartbeat",
    "chemex.pid",
    "results.json",
    "results.json.tmp",
    ".DS_Store",
}

IGNORED_EXTENSIONS = {
    ".tmp",
    ".log",
}


def compute_bundle_fingerprint(
    run_dir: Union[str, Path],
    *,
    use_cache: bool = True,
) -> str:
    """
    Compute deterministic SHA-256 fingerprint for a ChemEx run directory.
    Includes input, configuration, run_info, and ChemEx output files while
    excluding temporary progress files, logs, and prebuilt bundle artifacts.
    """
    canonical_root = Path(run_dir).resolve()
    cache_key = str(canonical_root)

    if use_cache and cache_key in _FINGERPRINT_CACHE:
        cached_time, cached_fp = _FINGERPRINT_CACHE[cache_key]
        if (time.time() - cached_time) < CACHE_TTL_SECONDS:
            return cached_fp

    if not canonical_root.exists():
        hasher = hashlib.sha256(f"{PARSER_VERSION}:{BUNDLE_SCHEMA_VERSION}:missing:{cache_key}".encode("utf-8"))
        return hasher.hexdigest()

    file_entries: list[Tuple[str, int, int]] = []

    for root, dirs, files in os.walk(canonical_root):
        # Prune ignored directories
        dirs[:] = [d for d in dirs if d not in IGNORED_DIRS and not d.endswith(".tmp")]

        rel_root = os.path.relpath(root, canonical_root)
        if rel_root != ".":
            top_part = rel_root.split(os.sep)[0]
            if top_part in IGNORED_DIRS:
                continue

        for f in files:
            if f in IGNORED_FILES or any(f.endswith(ext) for ext in IGNORED_EXTENSIONS):
                continue
            # Also ignore any PDF or ZIP created directly in root
            if rel_root == "." and (f.endswith(".pdf") or f.endswith(".zip")):
                continue

            full_path = os.path.join(root, f)
            rel_path = os.path.relpath(full_path, canonical_root).replace("\\", "/")

            try:
                stat = os.stat(full_path)
                file_entries.append((rel_path, stat.st_size, stat.st_mtime_ns))
            except OSError:
                continue

    file_entries.sort(key=lambda x: x[0])

    hasher = hashlib.sha256()
    hasher.update(f"{PARSER_VERSION}:{BUNDLE_SCHEMA_VERSION}\n".encode("utf-8"))

    for rel_path, size, mtime_ns in file_entries:
        hasher.update(f"{rel_path}:{size}:{mtime_ns}\n".encode("utf-8"))

    fingerprint = hasher.hexdigest()

    _FINGERPRINT_CACHE[cache_key] = (time.time(), fingerprint)
    return fingerprint


def invalidate_fingerprint_cache(run_dir: Union[str, Path]) -> None:
    """Evict a run directory from the in-process fingerprint cache."""
    canonical_root = str(Path(run_dir).resolve())
    _FINGERPRINT_CACHE.pop(canonical_root, None)


def clear_all_fingerprint_cache() -> None:
    """Clear entire fingerprint cache (primarily for tests)."""
    _FINGERPRINT_CACHE.clear()
