"""Residue review notes/flags flow from the analysis config into the report model."""

import json

from app.services.reporting.residue_review import collect_residue_review, load_residue_review


def test_collect_keeps_only_noted_or_flagged_rows_sorted_by_residue_number():
    book = {
        "pick_cest": {
            "statuses": {"G14N": "accepted", "3N": "no_excited_state", "9N": "accepted"},
            "notes": {"G14N": "shoulder near 121 ppm", "3N": "  "},
            "flags": {"3N": True, "9N": False},
        },
        "dispersion": {"notes": {"14N": "duplicates disagree"}},
    }
    rows = collect_residue_review(book)
    assert [(r["residue"], r["page"]) for r in rows] == [
        ("3N", "Pick CEST"),
        ("14N", "Inspect Dispersion"),
        ("G14N", "Pick CEST"),
    ]
    assert rows[0] == {"residue": "3N", "page": "Pick CEST", "status": "No excited state", "flagged": True, "note": ""}
    assert rows[1]["status"] == "Unreviewed"
    assert rows[2]["note"] == "shoulder near 121 ppm"


def test_collect_tolerates_malformed_input():
    assert collect_residue_review(None) == []
    assert collect_residue_review({"pick_cest": "nope", "dispersion": {"notes": []}}) == []


def test_load_reads_review_from_config(tmp_path):
    assert load_residue_review(tmp_path) is None
    (tmp_path / "config.json").write_text(json.dumps({
        "residue_review": {"pick_cest": {"notes": {"5N": "check"}}}
    }))
    rows = load_residue_review(tmp_path)
    assert rows == [{"residue": "5N", "page": "Pick CEST", "status": "Unreviewed", "flagged": False, "note": "check"}]
