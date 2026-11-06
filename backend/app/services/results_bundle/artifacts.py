"""Artifact Management, Deterministic Render Keys, and LRU Cache (§3.11).

Key calculation:
    render_key = sha256(bundle_fingerprint, kind, style, palette,
                        sorted(excluded_residues), noe_threshold,
                        REPORT_TEMPLATE_VERSION)[:16]

Caches generated PDFs and plot-ZIPs under results/artifacts/ and prunes old
variants when count > 8, always protecting the default variant.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Union

from .fingerprint import compute_bundle_fingerprint
from .schema import ArtifactIndexEntry

logger = logging.getLogger(__name__)

REPORT_TEMPLATE_VERSION = "1.0.0"
MAX_ARTIFACTS_PER_RUN = 8


def render_key(
    bundle_fingerprint: str,
    kind: str,
    style: str = "publication",
    palette: str = "okabe_ito",
    excluded_residues: Optional[Sequence[str]] = None,
    noe_threshold: Any = None,
    template_version: str = REPORT_TEMPLATE_VERSION,
) -> str:
    """
    Compute a 16-character hex render key deterministic across all styling,
    filtering, and template variables.
    """
    ex_list = sorted([str(r).strip().upper() for r in (excluded_residues or []) if str(r).strip()])
    ex_str = ",".join(ex_list)
    noe_str = "" if (noe_threshold is None or str(noe_threshold) == "-1") else str(noe_threshold)
    palette_clean = str(palette or "okabe_ito").strip().lower()
    style_clean = str(style or "publication").strip().lower()

    key_input = (
        f"{bundle_fingerprint}:{kind}:{style_clean}:{palette_clean}:{ex_str}:{noe_str}:{template_version}"
    )
    return hashlib.sha256(key_input.encode("utf-8")).hexdigest()[:16]


def get_artifact_path(
    run_dir: Union[str, Path],
    kind: str,
    key: str,
) -> Path:
    """Return the absolute path for an artifact within the results/artifacts directory."""
    ext = "pdf" if kind == "report" else "zip"
    artifacts_dir = Path(run_dir) / "results" / "artifacts"
    return artifacts_dir / f"{kind}-{key}.{ext}"


def prune_artifacts_lru(
    run_dir: Union[str, Path],
    default_keys: Optional[set[str]] = None,
    max_variants: int = MAX_ARTIFACTS_PER_RUN,
) -> None:
    """
    Prune artifacts in results/artifacts/ when total count exceeds max_variants.
    Always preserves entries in default_keys.
    """
    artifacts_dir = Path(run_dir) / "results" / "artifacts"
    if not artifacts_dir.exists():
        return

    default_keys = default_keys or set()
    files: list[tuple[Path, float]] = []

    for f in artifacts_dir.iterdir():
        if f.is_file() and (f.suffix in (".pdf", ".zip")):
            try:
                mtime = f.stat().st_mtime
                files.append((f, mtime))
            except OSError:
                continue

    if len(files) <= max_variants:
        return

    # Sort files oldest first
    files.sort(key=lambda x: x[1])

    manifest_path = Path(run_dir) / "results" / "manifest.json"
    manifest_data: dict[str, Any] = {}
    if manifest_path.is_file():
        try:
            manifest_data = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception:
            pass

    to_prune_count = len(files) - max_variants
    pruned = 0

    for file_path, _ in files:
        if pruned >= to_prune_count:
            break

        # Check if protected by default_keys
        # Filename shape: {kind}-{key}.{ext}
        name_parts = file_path.stem.split("-", 1)
        item_key = name_parts[1] if len(name_parts) == 2 else file_path.stem

        if item_key in default_keys:
            continue

        try:
            file_path.unlink(missing_ok=True)
            pruned += 1
            if "artifacts" in manifest_data and item_key in manifest_data["artifacts"]:
                manifest_data["artifacts"].pop(item_key, None)
        except OSError:
            pass

    if manifest_data and manifest_path.is_file():
        try:
            manifest_path.write_text(json.dumps(manifest_data, indent=2), encoding="utf-8")
        except Exception:
            pass


def get_or_render_artifact(
    run_dir: Union[str, Path],
    kind: str,
    analysis_name: str,
    analysis_type: str = "CEST",
    style: str = "publication",
    palette: str = "okabe_ito",
    excluded_residues: Optional[Sequence[str]] = None,
    noe_threshold: Any = None,
    chemex_image_digest: Optional[str] = None,
) -> Path:
    """
    Retrieve cached artifact by deterministic render key, or render and cache it.
    """
    r_dir = Path(run_dir)
    fingerprint = compute_bundle_fingerprint(r_dir)
    key = render_key(
        bundle_fingerprint=fingerprint,
        kind=kind,
        style=style,
        palette=palette,
        excluded_residues=excluded_residues,
        noe_threshold=noe_threshold,
    )

    target_path = get_artifact_path(r_dir, kind, key)
    if target_path.is_file() and target_path.stat().st_size > 0:
        return target_path

    # Ensure artifacts directory exists
    target_path.parent.mkdir(parents=True, exist_ok=True)

    # Compute default key to protect it from eviction
    default_key = render_key(
        bundle_fingerprint=fingerprint,
        kind=kind,
        style="publication",
        palette="okabe_ito",
        excluded_residues=excluded_residues,
        noe_threshold=noe_threshold,
    )

    from ..reporting.model import build_report_model
    from ..reporting.report_generator import ReportBuilder
    from ..export.plot_export import export_all_plots_zip

    report_model = build_report_model(
        analysis_dir=r_dir,
        analysis_name=analysis_name,
        analysis_type=analysis_type,
        chemex_image_digest=chemex_image_digest,
        excluded_residues=excluded_residues,
        noe_threshold=noe_threshold,
    )

    tmp_path = target_path.with_suffix(f".tmp.{os.getpid()}")

    try:
        if kind == "report":
            builder = ReportBuilder(
                model=report_model,
                style=style,
                palette=palette,
            )
            buf = builder.render_pdf()
            with open(tmp_path, "wb") as f:
                f.write(buf.getvalue())
        elif kind == "plots":
            buf = export_all_plots_zip(
                analysis_dir=report_model,
                palette=palette,
                style=style,
            )
            with open(tmp_path, "wb") as f:
                f.write(buf.getvalue())
        else:
            raise ValueError(f"Unknown artifact kind: {kind}")

        # Atomic promotion
        os.replace(tmp_path, target_path)

        # Update manifest index
        manifest_path = r_dir / "results" / "manifest.json"
        if manifest_path.is_file():
            try:
                manifest_data = json.loads(manifest_path.read_text(encoding="utf-8"))
                hasher = hashlib.sha256()
                with open(target_path, "rb") as f:
                    for chunk in iter(lambda: f.read(65536), b""):
                        hasher.update(chunk)
                file_sha = hasher.hexdigest()

                if "artifacts" not in manifest_data:
                    manifest_data["artifacts"] = {}

                rel_artifact_path = f"artifacts/{target_path.name}"
                manifest_data["artifacts"][key] = {
                    "path": rel_artifact_path,
                    "sha256": file_sha,
                    "render_key": key,
                    "kind": kind,
                    "status": "ready",
                }
                manifest_path.write_text(json.dumps(manifest_data, indent=2), encoding="utf-8")
            except Exception as m_exc:
                logger.warning("Could not update manifest.json with new artifact: %s", m_exc)

        # Run LRU eviction
        prune_artifacts_lru(r_dir, default_keys={default_key, key})
        return target_path

    except Exception:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)
        raise
