"""Residue review annotations (statuses, notes, flags) for the report.

The Pick CEST and Inspect Dispersion pages save their review under ``residue_review`` in the
analysis config::

    {"pick_cest": {"statuses": {...}, "notes": {...}, "flags": {...}},
     "dispersion": {...}}

Only residues carrying a note or a flag are reported; plain statuses are visible in the app
and exports and would only add noise to the PDF.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

from ..fitting.spin_system import SpinSystemKey

PAGE_LABELS = {"pick_cest": "Pick CEST", "dispersion": "Inspect Dispersion"}
STATUS_LABELS = {"accepted": "Accepted", "no_excited_state": "No excited state"}

CONFIG_FILES = ("config.json", "cpmg_config.json")


def collect_residue_review(review_book: Any) -> list[dict[str, Any]]:
    """Flatten a saved ``residue_review`` into report rows sorted by residue number."""
    if not isinstance(review_book, dict):
        return []
    rows: list[dict[str, Any]] = []
    for page, label in PAGE_LABELS.items():
        review = review_book.get(page)
        if not isinstance(review, dict):
            continue
        notes = review.get("notes") if isinstance(review.get("notes"), dict) else {}
        flags = review.get("flags") if isinstance(review.get("flags"), dict) else {}
        statuses = review.get("statuses") if isinstance(review.get("statuses"), dict) else {}
        for residue in set(notes) | {k for k, v in flags.items() if v is True}:
            note = notes.get(residue)
            note = note.strip() if isinstance(note, str) else ""
            flagged = flags.get(residue) is True
            if not note and not flagged:
                continue
            rows.append({
                "residue": str(residue),
                "page": label,
                "status": STATUS_LABELS.get(statuses.get(residue), "Unreviewed"),
                "flagged": flagged,
                "note": note,
            })
    rows.sort(key=lambda r: (SpinSystemKey.parse(r["residue"]).res_num, r["residue"], r["page"]))
    return rows


def load_residue_review(analysis_dir: Path) -> Optional[list[dict[str, Any]]]:
    """Report rows from the first analysis config that carries a review; None when absent."""
    for name in CONFIG_FILES:
        path = Path(analysis_dir) / name
        if not path.is_file():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(data, dict) and data.get("residue_review"):
            rows = collect_residue_review(data["residue_review"])
            return rows or None
    return None
