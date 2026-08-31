"""
Non-TOML Tabular Data Parser (§1.6).
Parses multi-section whitespace-delimited experimental & back-calculated profiles from Data/*.dat.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Optional

from .models import (
    DataFileModel,
    DataPointModel,
    DataProfileModel,
    StructuredWarning,
)

RE_DATA_SECTION = re.compile(r"^\s*\[(?P<name>[^\]]+)\]\s*$")


def _safe_float(token: str) -> Optional[float]:
    try:
        return float(token)
    except (ValueError, TypeError):
        return None


def parse_data_file(
    file_path: Path,
    warnings: list[StructuredWarning],
) -> Optional[DataFileModel]:
    """
    Parse a single .dat file sectioned by profiles with dynamic headers.
    """
    if not file_path.exists() or not file_path.is_file():
        return None

    try:
        lines = file_path.read_text(encoding="utf-8").splitlines()
    except Exception as exc:
        warnings.append(
            StructuredWarning(
                code="UNREADABLE_DATA_FILE",
                message=f"Could not read data file {file_path.name}: {exc}",
                path=str(file_path),
            )
        )
        return None

    profiles: dict[str, DataProfileModel] = {}
    current_profile_name: Optional[str] = None
    current_columns: list[str] = []
    current_points: list[DataPointModel] = []

    def _flush_current():
        if current_profile_name is not None:
            profiles[current_profile_name] = DataProfileModel(
                name=current_profile_name,
                columns=list(current_columns),
                points=list(current_points),
            )

    for line_idx, raw_line in enumerate(lines, start=1):
        line = raw_line.rstrip()
        if not line:
            continue

        # Check section header [15N]
        m_sec = RE_DATA_SECTION.match(line)
        if m_sec:
            _flush_current()
            current_profile_name = m_sec.group("name").strip()
            current_columns = []
            current_points = []
            continue

        # Check comment header line: # NCYC INTENSITY (EXP) ...
        # (Must be after section header or top-level)
        if line.startswith("#"):
            # Check if this is a commented data row: "# 0 3.47e4 ... # NOT USED IN THE FIT"
            comment_body = line.lstrip("#").strip()
            if "NOT USED IN THE FIT" in line or any(c.isdigit() for c in comment_body.split()[:2] if c):
                # This is a masked data row
                pass
            else:
                # This is a column header line
                tokens = comment_body.split()
                # Reconstruct multi-word column names like "INTENSITY (EXP)", "ERROR (EXP)", "OFFSET (HZ)", "TIME (S)", "SHIFT (EXP)"
                columns = []
                idx = 0
                while idx < len(tokens):
                    tok = tokens[idx]
                    if idx + 1 < len(tokens) and tokens[idx + 1].startswith("(") and tokens[idx + 1].endswith(")"):
                        columns.append(f"{tok} {tokens[idx + 1]}")
                        idx += 2
                    else:
                        columns.append(tok)
                        idx += 1
                current_columns = columns
                continue

        # If we have no profile name yet, use "DEFAULT"
        if current_profile_name is None:
            current_profile_name = "DEFAULT"

        # Determine mask: line starts with '#' => mask=False, starts with ' ' or digit => mask=True
        is_masked = line.startswith("#")
        clean_line = line.lstrip("#").strip()
        if "# NOT USED IN THE FIT" in clean_line:
            clean_line = clean_line.split("# NOT USED IN THE FIT")[0].strip()

        row_tokens = clean_line.split()
        if not row_tokens:
            continue

        # Map row tokens to columns if available
        metadata: dict[str, Any] = {}
        exp_val: Optional[float] = None
        err_val: Optional[float] = None
        calc_val: Optional[float] = None

        if current_columns and len(row_tokens) >= len(current_columns):
            for col_name, token in zip(current_columns, row_tokens):
                col_upper = col_name.upper()
                if "EXP" in col_upper and "ERROR" not in col_upper and "ERR" not in col_upper:
                    exp_val = _safe_float(token)
                elif "ERROR" in col_upper or "ERR" in col_upper:
                    err_val = _safe_float(token)
                elif "CALC" in col_upper or "FIT" in col_upper or "SIM" in col_upper:
                    calc_val = _safe_float(token)
                else:
                    # Metadata column (NCYC, OFFSET, TIME, STATE1, STATE2, NAME)
                    f_val = _safe_float(token)
                    metadata[col_name] = f_val if f_val is not None else token
        else:
            # Fallback when columns are not defined: assume standard layout (x, exp, err, calc)
            nums = [_safe_float(t) for t in row_tokens]
            if len(nums) >= 4:
                metadata["x"] = nums[0]
                exp_val = nums[1]
                err_val = nums[2]
                calc_val = nums[3]
            elif len(nums) == 3:
                metadata["x"] = nums[0]
                exp_val = nums[1]
                calc_val = nums[2]
            elif len(nums) == 2:
                metadata["x"] = nums[0]
                calc_val = nums[1]

        current_points.append(
            DataPointModel(
                metadata=metadata,
                exp=exp_val,
                err=err_val,
                calc=calc_val,
                mask=not is_masked,
            )
        )

    _flush_current()

    return DataFileModel(
        stem=file_path.stem,
        profiles=profiles,
    )


def parse_data_directory(
    data_dir: Path,
    warnings: list[StructuredWarning],
) -> dict[str, DataFileModel]:
    """
    Parse all .dat files in Data/ directory.
    """
    if not data_dir.exists() or not data_dir.is_dir():
        return {}

    result: dict[str, DataFileModel] = {}
    for dat_path in sorted(data_dir.glob("*.dat")):
        parsed = parse_data_file(dat_path, warnings)
        if parsed is not None:
            result[dat_path.stem] = parsed

    return result
