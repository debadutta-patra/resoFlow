"""Unit tests for artifact render keys and LRU caching (§3.11).

Verifies:
- Deterministic key generation
- Invariance to excluded residue order and casing
- Sensitivity to style, palette, excluded residues, noe_threshold, template version, and bundle fingerprint
- LRU artifact pruning with default key protection
"""

import json
import time
from pathlib import Path

import pytest

from app.services.results_bundle.artifacts import (
    MAX_ARTIFACTS_PER_RUN,
    REPORT_TEMPLATE_VERSION,
    get_artifact_path,
    prune_artifacts_lru,
    render_key,
)


def test_render_key_determinism() -> None:
    fp = "abcd1234ef567890"
    k1 = render_key(fp, "report", style="publication", palette="okabe_ito", excluded_residues=["14N", "20G"])
    k2 = render_key(fp, "report", style="publication", palette="okabe_ito", excluded_residues=["14N", "20G"])
    assert k1 == k2
    assert len(k1) == 16


def test_render_key_excluded_residues_invariance() -> None:
    fp = "abcd1234ef567890"
    # Order independence & casing normalization
    k1 = render_key(fp, "report", excluded_residues=["14N", "55N", "20G"])
    k2 = render_key(fp, "report", excluded_residues=["20g", "14n", "55N"])
    assert k1 == k2


def test_render_key_sensitivity() -> None:
    base_fp = "abcd1234ef567890"
    base_key = render_key(
        base_fp,
        kind="report",
        style="publication",
        palette="okabe_ito",
        excluded_residues=["14N"],
        noe_threshold=0.5,
        template_version=REPORT_TEMPLATE_VERSION,
    )

    # Change fingerprint
    assert render_key(
        "different_fp_123",
        kind="report",
        style="publication",
        palette="okabe_ito",
        excluded_residues=["14N"],
        noe_threshold=0.5,
    ) != base_key

    # Change kind
    assert render_key(
        base_fp,
        kind="plots",
        style="publication",
        palette="okabe_ito",
        excluded_residues=["14N"],
        noe_threshold=0.5,
    ) != base_key

    # Change style
    assert render_key(
        base_fp,
        kind="report",
        style="presentation",
        palette="okabe_ito",
        excluded_residues=["14N"],
        noe_threshold=0.5,
    ) != base_key

    # Change palette
    assert render_key(
        base_fp,
        kind="report",
        style="publication",
        palette="colorblind",
        excluded_residues=["14N"],
        noe_threshold=0.5,
    ) != base_key

    # Change excluded residues
    assert render_key(
        base_fp,
        kind="report",
        style="publication",
        palette="okabe_ito",
        excluded_residues=["14N", "20G"],
        noe_threshold=0.5,
    ) != base_key

    # Change noe_threshold
    assert render_key(
        base_fp,
        kind="report",
        style="publication",
        palette="okabe_ito",
        excluded_residues=["14N"],
        noe_threshold=1.0,
    ) != base_key

    # Change template version
    assert render_key(
        base_fp,
        kind="report",
        style="publication",
        palette="okabe_ito",
        excluded_residues=["14N"],
        noe_threshold=0.5,
        template_version="2.0.0",
    ) != base_key


def test_prune_artifacts_lru_protection(tmp_path: Path) -> None:
    """Verifies that LRU eviction removes oldest variants while protecting default key."""
    run_dir = tmp_path / "run"
    artifacts_dir = run_dir / "results" / "artifacts"
    artifacts_dir.mkdir(parents=True, exist_ok=True)

    default_key = "default_key_123"
    default_file = artifacts_dir / f"report-{default_key}.pdf"
    default_file.write_text("default content")

    # Set mtime of default file to be the oldest
    old_time = time.time() - 1000
    import os
    os.utime(default_file, (old_time, old_time))

    # Create 10 other artifact files (total 11 files > MAX_ARTIFACTS_PER_RUN = 8)
    other_keys = []
    for i in range(10):
        k = f"key_{i:04d}"
        other_keys.append(k)
        f = artifacts_dir / f"report-{k}.pdf"
        f.write_text(f"content {i}")
        t = old_time + (i + 1) * 10
        os.utime(f, (t, t))

    # Also write a manifest.json
    manifest_file = run_dir / "results" / "manifest.json"
    manifest_data = {
        "artifacts": {
            default_key: {"path": str(default_file), "kind": "report"},
            **{k: {"path": f"report-{k}.pdf", "kind": "report"} for k in other_keys},
        }
    }
    manifest_file.write_text(json.dumps(manifest_data))

    # Run pruning
    prune_artifacts_lru(run_dir, default_keys={default_key}, max_variants=8)

    remaining_files = list(artifacts_dir.glob("*.pdf"))
    assert len(remaining_files) == 8

    # Default file MUST still exist despite being the oldest
    assert default_file.exists()

    # The oldest non-default files should have been removed
    # We had 1 default + 10 others = 11. 3 had to be pruned.
    # Default is protected, so key_0000, key_0001, key_0002 should be pruned.
    assert not (artifacts_dir / f"report-{other_keys[0]}.pdf").exists()
    assert not (artifacts_dir / f"report-{other_keys[1]}.pdf").exists()
    assert not (artifacts_dir / f"report-{other_keys[2]}.pdf").exists()
    assert (artifacts_dir / f"report-{other_keys[3]}.pdf").exists()

    # Manifest should have pruned entries removed
    updated_manifest = json.loads(manifest_file.read_text())
    assert default_key in updated_manifest["artifacts"]
    assert other_keys[0] not in updated_manifest["artifacts"]
    assert other_keys[3] in updated_manifest["artifacts"]
