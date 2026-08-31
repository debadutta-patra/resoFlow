import os
import re
from typing import Optional

ERROR_PATTERNS = [
    re.compile(r"^(?:ERROR|CRITICAL|FATAL):\s*(.+)$", re.IGNORECASE),
    re.compile(r"^(?:\[ERROR\]|\[CRITICAL\])\s*(.+)$", re.IGNORECASE),
    re.compile(r"^([A-Za-z_]+Error:\s*.+)$"),
    re.compile(r"^([A-Za-z_]+Exception:\s*.+)$"),
    re.compile(r"^(RuntimeError:\s*.+)$"),
    re.compile(r"^(ValueError:\s*.+)$"),
    re.compile(r"^(KeyError:\s*.+)$"),
    re.compile(r"^(FileNotFoundError:\s*.+)$"),
    re.compile(r"^(ChemEx exited with .+)"),
    re.compile(r"^(Error:\s*.+)", re.IGNORECASE),
]

def extract_failure_reason(log_path: Optional[str], fallback_error: Optional[str] = None) -> Optional[str]:
    """
    Extract the most concise and meaningful failure reason from a run's log file.
    Falls back to fallback_error or generic message if log is not available.
    """
    if fallback_error and fallback_error.strip():
        clean_fallback = fallback_error.strip().splitlines()[-1].strip()
        if not log_path or not os.path.exists(log_path):
            return clean_fallback[:250]

    if not log_path or not os.path.exists(log_path):
        return fallback_error[:250] if fallback_error else None

    try:
        with open(log_path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.read().splitlines()
    except Exception:
        return fallback_error or "Unable to read log file"

    found_errors = []
    
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("===") or stripped.startswith("---") or stripped.startswith("$"):
            continue

        for pattern in ERROR_PATTERNS:
            m = pattern.match(stripped)
            if m:
                found_errors.append(m.group(1) if m.groups() else stripped)
                break

    if found_errors:
        reason = found_errors[-1].strip()
        reason = re.sub(r"^\d{4}-\d{2}-\d{2}[^-\n]+-\s*(?:ERROR|CRITICAL)\s*-\s*", "", reason, flags=re.IGNORECASE)
        return reason[:250]

    if lines:
        for line in reversed(lines):
            stripped = line.strip()
            if stripped and not stripped.startswith("===") and not stripped.startswith("Completed at") and not stripped.startswith("$"):
                return stripped[:250]

    return fallback_error or "Run failed (check logs for details)"


def extract_current_step(log_path: Optional[str], status: str, total_items: int = 0, completed_items: int = 0) -> Optional[str]:
    """
    Extract the active method or fitting step from a running process's log or DB counters.
    """
    if status != "RUNNING":
        return None

    if total_items > 0:
        return f"Step {completed_items + 1} of {total_items}"

    if not log_path or not os.path.exists(log_path):
        return "Running..."

    try:
        with open(log_path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.read().splitlines()[-40:]  # last 40 lines
    except Exception:
        return "Running..."

    # Check for specific residue / cluster progress lines first (most specific to least specific)
    for line in reversed(lines):
        stripped = line.strip()
        res_m = re.match(r"^---\s*Fitting Residue\s*(\d+/\d+):\s*(.+?)\s*---", stripped, re.IGNORECASE)
        if res_m:
            return f"Residue {res_m.group(2)} ({res_m.group(1)})"
        clust_m = re.match(r"^---\s*Cluster\s*(\d+)\s*---", stripped, re.IGNORECASE)
        if clust_m:
            return f"Fitting Cluster {clust_m.group(1)}"

    # Check for broader steps
    for line in reversed(lines):
        stripped = line.strip()
        if "$ chemex fit" in stripped:
            return "ChemEx fitting in progress"

    return "Running..."

