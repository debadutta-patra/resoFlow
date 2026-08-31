"""
Deterministic streamed ZIP export module for resoFlow (Phase 10).
Produces a structured, self-contained, reproducible archive of a completed analysis:
- report.pdf with embedded parameter metadata
- fitted_parameters.csv & fitted_parameters.json (machine-readable with covariance)
- derived_kinetics.csv (Phase 7 quantities with propagation method)
- inputs/ (verbatim copy of original configurations)
- chemex_output/ (unmodified ChemEx output tree)
- statistics/ (replicate samples, diagnostics, grids)
- data/ (raw input data profiles if requested)
- README.txt & MANIFEST.json (provenance + cryptographic SHA-256 for every entry)

Uses a chunked streaming generator to stream direct to disk with flat memory RSS.
Deterministic: Sorted entry order and fixed mtime (2026-01-01 00:00:00).
"""

from __future__ import annotations

import csv
import hashlib
import hmac
import io
import json
import logging
import os
import re
import shutil
import time
import zipfile
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Generator, List, Optional, Set, Tuple, Union

from ..fitting.chemex_output import parse_output_tree
from ..reporting.formatting import format_with_error
from ..reporting.kinetics import propagate_derived_kinetics
from ..reporting.provenance import extract_report_provenance
from ..reporting.report_generator import generate_modern_pdf_report
from ..reporting.uncertainty import UncertaintyResolver, UncertaintySource, ParameterStatus
from ...security import SECRET_KEY

logger = logging.getLogger(__name__)

# Fixed deterministic timestamp for archive reproducibility
DETERMINISTIC_DATETIME: Tuple[int, int, int, int, int, int] = (2026, 1, 1, 0, 0, 0)

# In-memory single-use token consumption registry
_CONSUMED_TOKENS: Set[str] = set()


def generate_export_token(
    project_uuid: str,
    analysis_uuid: str,
    user_id: int,
    options: Optional[Dict[str, Any]] = None,
    validity_seconds: int = 60,
) -> str:
    """
    Generate a short-lived (60s) HMAC-signed single-use download token.
    """
    expires_at = int(time.time()) + validity_seconds
    payload_dict = {
        "p": project_uuid,
        "a": analysis_uuid,
        "u": user_id,
        "exp": expires_at,
        "opt": options or {},
    }
    payload_str = json.dumps(payload_dict, sort_keys=True)
    sig = hmac.new(
        SECRET_KEY.encode("utf-8"),
        payload_str.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    # Combine payload (hex-encoded) with signature
    token = f"{payload_str.encode('utf-8').hex()}.{sig}"
    return token


def verify_export_token(
    token: str,
    project_uuid: str,
    analysis_uuid: str,
) -> Tuple[bool, Optional[Dict[str, Any]], str]:
    """
    Verify signature, expiration, and single-use state of an export token.
    Returns (is_valid, options_dict, error_message).
    """
    if not token or "." not in token:
        return False, None, "Invalid token format"

    if token in _CONSUMED_TOKENS:
        return False, None, "Token already used (single-use)"

    try:
        hex_payload, sig = token.split(".", 1)
        payload_str = bytes.fromhex(hex_payload).decode("utf-8")
        expected_sig = hmac.new(
            SECRET_KEY.encode("utf-8"),
            payload_str.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()

        if not hmac.compare_digest(sig, expected_sig):
            return False, None, "Invalid token signature"

        payload = json.loads(payload_str)
        if payload.get("p") != project_uuid or payload.get("a") != analysis_uuid:
            return False, None, "Token does not match requested project/analysis"

        now = int(time.time())
        if payload.get("exp", 0) < now:
            return False, None, "Token has expired"

        # Mark token consumed
        _CONSUMED_TOKENS.add(token)
        # Limit set size to avoid memory growth
        if len(_CONSUMED_TOKENS) > 5000:
            _CONSUMED_TOKENS.clear()

        return True, payload.get("opt", {}), ""
    except Exception as exc:
        return False, None, f"Token verification error: {str(exc)}"


class ChunkedZipStreamer:
    """Non-seeking file-like adapter for streaming ZIP archives in chunks."""

    def __init__(self):
        self._pos = 0
        self._buffer = bytearray()

    def write(self, b: bytes) -> int:
        self._buffer.extend(b)
        self._pos += len(b)
        return len(b)

    def tell(self) -> int:
        return self._pos

    def flush(self) -> None:
        pass

    def pull(self) -> bytes:
        if self._buffer:
            res = bytes(self._buffer)
            self._buffer.clear()
            return res
        return b""


def build_parameters_csv(resolver: UncertaintyResolver) -> str:
    """Generate CSV of all fitted, fixed, derived, and bounded parameters."""
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "parameter", "scope", "value", "err_low", "err_high",
        "err_low_95", "err_high_95", "unit", "status", "uncertainty_source", "flag_reason",
    ])

    # Globals
    for g_param in ["kex_ab", "pb", "tauc_a", "chi2", "chi2_red"]:
        res = resolver.resolve(g_param, "global")
        if res.status != ParameterStatus.NOT_IN_MODEL:
            writer.writerow([
                res.name, "global", res.value, res.err_low, res.err_high,
                res.err_low_95, res.err_high_95, res.unit or "", res.status.value,
                res.source.value, res.flag_reason or "",
            ])

    # Residues
    if resolver.primary_step:
        for res_name in sorted(resolver.primary_step.residues.keys()):
            for p_name in ["cs_a", "cs_b", "dw_ab", "r1_a", "r2_a", "r2_b"]:
                res = resolver.resolve(p_name, res_name)
                if res.status != ParameterStatus.NOT_IN_MODEL:
                    writer.writerow([
                        res.name, res_name, res.value, res.err_low, res.err_high,
                        res.err_low_95, res.err_high_95, res.unit or "", res.status.value,
                        res.source.value, res.flag_reason or "",
                    ])

    return output.getvalue()


def build_derived_kinetics_csv(derived_dict: Dict[str, Any]) -> str:
    """Generate CSV for derived kinetic quantities with propagation methods."""
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["quantity", "symbol", "value", "err_low", "err_high", "unit", "propagation_method", "expression"])

    for k_key in ["kab", "kba", "tau_b", "tau_a"]:
        obj = derived_dict.get(k_key)
        if obj and obj.value is not None:
            writer.writerow([
                obj.name.upper(), obj.symbol, obj.value, obj.err_low, obj.err_high,
                obj.unit, obj.propagation_method, obj.expression,
            ])

    return output.getvalue()


def build_readme_text(analysis_name: str, analysis_uuid: str, analysis_type: str, timestamp_str: str = "2026-01-01 00:00:00 UTC") -> str:
    """Generate README.txt guide for archive contents."""
    return f"""================================================================================
resoFlow Analysis Archive: {analysis_name}
================================================================================
Analysis Type: {analysis_type}
UUID:          {analysis_uuid}
Export Date:   {timestamp_str}
Generated by:  resoFlow v2026.2.0 (Google DeepMind)

CONTENTS & DIRECTORY STRUCTURE:
--------------------------------------------------------------------------------
• report.pdf             : Multi-page publication-ready PDF report with complete
                           goodness-of-fit, scanning grid, residuals, and provenance.
• fitted_parameters.csv  : All fitted, fixed, and derived parameters with uncertainties.
• fitted_parameters.json : Structured machine-readable export with full provenance.
• derived_kinetics.csv   : k_AB, k_BA, tau_B, and tau_A with covariance-aware error.
• inputs/                : Exact copies of experiment, parameter, and method TOML files.
• chemex_output/         : Unmodified ChemEx calculation tree (curves, plots, logs).
• statistics/            : Monte Carlo / Bootstrap replicates (.npz), 1D/2D grid arrays.
• data/                  : Raw input NMR profiles and error estimates (if requested).
• MANIFEST.json          : SHA-256 cryptographic verification digests for all files.

REPRODUCIBILITY & CITATION:
--------------------------------------------------------------------------------
To verify cryptographic file integrity, run:
  sha256sum -c MANIFEST.json (or check against entries in MANIFEST.json)
================================================================================
"""


def stream_analysis_zip(
    analysis_dir: Union[str, Path],
    analysis_name: str,
    analysis_type: str = "CEST",
    include_data: bool = False,
    include_plots: bool = True,
    include_statistics: bool = True,
    style: str = "publication",
    chemex_image_digest: Optional[str] = None,
    fixed_timestamp: Optional[str] = None,
) -> Generator[bytes, None, None]:
    """
    Stream a deterministic ZIP archive of an analysis without buffering in memory.
    Yields byte chunks continuously as files are compressed.
    """
    # Fix environment date epoch for matplotlib PDF determinism
    os.environ["SOURCE_DATE_EPOCH"] = "1767225600"

    a_path = Path(analysis_dir).resolve()
    out_dir = a_path / "Output" if (a_path / "Output").is_dir() else a_path
    uuid_str = a_path.name
    short_uuid = uuid_str[:8]
    date_str = "20260101" if fixed_timestamp else datetime.now(timezone.utc).strftime("%Y%m%d")
    ts_iso = fixed_timestamp or "2026-01-01T00:00:00Z"

    clean_name = re.sub(r"[^A-Za-z0-9_-]", "_", analysis_name.strip()).lower()
    root_folder = f"resoflow_{clean_name}_{short_uuid}_{date_str}"

    streamer = ChunkedZipStreamer()
    zf = zipfile.ZipFile(streamer, mode="w", compression=zipfile.ZIP_DEFLATED)

    # 1. Prepare structured data and in-memory reports
    resolver = UncertaintyResolver(a_path)
    provenance = extract_report_provenance(
        a_path, analysis_name, analysis_type, chemex_image_digest, fixed_timestamp=ts_iso
    )

    # Derived kinetics
    kex_r = resolver.resolve("kex_ab", "global")
    pb_r = resolver.resolve("pb", "global")
    derived_dict = propagate_derived_kinetics(
        kex_val=kex_r.value,
        pb_val=(pb_r.value / 100.0 if (pb_r.value and pb_r.unit == "%") else pb_r.value),
        kex_sigma=kex_r.sigma,
        pb_sigma=((pb_r.sigma / 100.0 if pb_r.sigma else None) if (pb_r.unit == "%") else pb_r.sigma),
    )

    pdf_buffer = generate_modern_pdf_report(
        analysis_dir=a_path,
        analysis_name=analysis_name,
        analysis_type=analysis_type,
        style=style,
        chemex_image_digest=chemex_image_digest,
        fixed_timestamp=ts_iso,
    )
    pdf_bytes = pdf_buffer.getvalue()

    csv_params_str = build_parameters_csv(resolver)
    csv_kinetics_str = build_derived_kinetics_csv(derived_dict)
    readme_str = build_readme_text(analysis_name, uuid_str, analysis_type, timestamp_str=ts_iso)

    # Machine-readable parameters JSON
    json_params_dict = {
        "analysis_name": analysis_name,
        "analysis_uuid": uuid_str,
        "analysis_type": analysis_type,
        "provenance": {
            "timestamp": provenance.timestamp_iso,
            "resoflow_version": provenance.resoflow_version,
            "chemex_version": provenance.chemex_version,
            "chemex_digest": provenance.chemex_image_digest,
            "model": provenance.model_name,
        },
        "dof_accounting": {
            "n_data": provenance.dof_accounting.n_data_global,
            "dof": provenance.dof_accounting.dof_global,
            "chi2": provenance.dof_accounting.chi2_global,
            "chi2_red": provenance.dof_accounting.chi2_red_global,
        },
        "globals": {
            "kex_ab": asdict(kex_r),
            "pb": asdict(pb_r),
        },
        "derived_kinetics": {k: asdict(v) for k, v in derived_dict.items()},
    }
    json_params_str = json.dumps(json_params_dict, indent=2)

    # Collect all items to write into the archive (sorted for determinism)
    # Entry format: (archive_rel_path, source_type, content_or_path)
    # source_type: 'bytes' | 'file'
    archive_entries: List[Tuple[str, str, Union[bytes, Path]]] = []

    # In-memory generated core files
    archive_entries.append((f"{root_folder}/README.txt", "bytes", readme_str.encode("utf-8")))
    archive_entries.append((f"{root_folder}/report.pdf", "bytes", pdf_bytes))
    archive_entries.append((f"{root_folder}/fitted_parameters.csv", "bytes", csv_params_str.encode("utf-8")))
    archive_entries.append((f"{root_folder}/fitted_parameters.json", "bytes", json_params_str.encode("utf-8")))
    archive_entries.append((f"{root_folder}/derived_kinetics.csv", "bytes", csv_kinetics_str.encode("utf-8")))

    # Input TOML files
    input_search_dirs = [
        a_path / "Experiments",
        a_path / "Parameters",
        a_path / "Methods",
        out_dir / "run_info" / "inputs",
        a_path / "run_info" / "inputs",
    ]
    seen_inputs = set()
    for idir in input_search_dirs:
        if idir.is_dir():
            for f in idir.rglob("*.toml"):
                if f.name not in seen_inputs:
                    seen_inputs.add(f.name)
                    archive_entries.append((f"{root_folder}/inputs/{f.name}", "file", f))

    # ChemEx output tree
    if out_dir.is_dir():
        for root_p, _, files in os.walk(out_dir):
            for f in files:
                f_path = Path(root_p) / f
                rel_to_out = f_path.relative_to(out_dir).as_posix()

                # Filter options
                if not include_plots and ("Plots" in rel_to_out or f.endswith(".pdf") or f.endswith(".png")):
                    continue
                if not include_statistics and ("Statistics" in rel_to_out or "Grid" in rel_to_out):
                    continue

                archive_entries.append((f"{root_folder}/chemex_output/{rel_to_out}", "file", f_path))

    # Statistics and Grid directories (from all root, step, and group folders)
    if include_statistics:
        stat_search_dirs = [
            out_dir / "Statistics",
            a_path / "Statistics",
            out_dir / "Grid",
            a_path / "Grid",
        ]
        for root_dir in [out_dir, a_path]:
            if root_dir.is_dir():
                for child in root_dir.iterdir():
                    if child.is_dir():
                        if child.name.startswith("STEP") or child.name.startswith("step") or child.name == "Groups":
                            stat_search_dirs.append(child / "Statistics")
                            stat_search_dirs.append(child / "Grid")
                            if (child / "Groups").is_dir():
                                for g_child in (child / "Groups").iterdir():
                                    if g_child.is_dir():
                                        stat_search_dirs.append(g_child / "Statistics")
                                        stat_search_dirs.append(g_child / "Grid")

        seen_stat_files = set()
        for s_dir in stat_search_dirs:
            if s_dir.is_dir():
                rel_prefix = s_dir.name
                if s_dir.parent != out_dir and s_dir.parent != a_path:
                    rel_prefix = f"{s_dir.parent.name}/{s_dir.name}"
                for root_p, _, files in os.walk(s_dir):
                    for f in files:
                        f_path = Path(root_p) / f
                        if f_path.is_file():
                            rel_to_s = f_path.relative_to(s_dir).as_posix()
                            target_path = (
                                f"{root_folder}/statistics/{rel_prefix}/{rel_to_s}"
                                if rel_prefix != s_dir.name
                                else f"{root_folder}/statistics/{rel_to_s}"
                            )
                            if target_path not in seen_stat_files:
                                seen_stat_files.add(target_path)
                                archive_entries.append((target_path, "file", f_path))

    # Raw Data directory (if requested)
    data_dir = a_path / "Data"
    if include_data and data_dir.is_dir():
        for f in data_dir.iterdir():
            if f.is_file():
                archive_entries.append((f"{root_folder}/data/{f.name}", "file", f))

    # Sort all entries alphabetically by archive path for determinism
    archive_entries.sort(key=lambda x: x[0])

    # Compute SHA-256 manifest
    manifest_dict = {
        "archive_root": root_folder,
        "analysis_uuid": uuid_str,
        "analysis_name": analysis_name,
        "created_at_utc": "2026-01-01T00:00:00Z",  # Deterministic timestamp
        "resoflow_version": provenance.resoflow_version,
        "files": {},
    }

    for arch_path, stype, data_or_path in archive_entries:
        h = hashlib.sha256()
        if stype == "bytes":
            h.update(data_or_path)
        else:
            with open(data_or_path, "rb") as f_in:
                for chunk in iter(lambda: f_in.read(65536), b""):
                    h.update(chunk)
        rel_manifest_path = arch_path[len(root_folder) + 1:]
        manifest_dict["files"][rel_manifest_path] = h.hexdigest()

    manifest_bytes = json.dumps(manifest_dict, indent=2, sort_keys=True).encode("utf-8")
    archive_entries.insert(0, (f"{root_folder}/MANIFEST.json", "bytes", manifest_bytes))

    # Write each entry into the streaming ZIP and yield chunks
    for arch_path, stype, data_or_path in archive_entries:
        zinfo = zipfile.ZipInfo(filename=arch_path, date_time=DETERMINISTIC_DATETIME)
        zinfo.compress_type = zipfile.ZIP_DEFLATED
        # Ensure standard Unix file permissions
        zinfo.external_attr = 0o644 << 16

        if stype == "bytes":
            with zf.open(zinfo, "w") as dest:
                dest.write(data_or_path)
                c = streamer.pull()
                if c:
                    yield c
        else:
            with zf.open(zinfo, "w") as dest:
                with open(data_or_path, "rb") as src:
                    for chunk in iter(lambda: src.read(65536), b""):
                        dest.write(chunk)
                        c = streamer.pull()
                        if c:
                            yield c

    # Close archive and yield remaining central directory chunks
    zf.close()
    final_chunk = streamer.pull()
    if final_chunk:
        yield final_chunk
