"""
Parameter Reports Parser (§1.5).
Custom comment-preserving grammar parser for fitted.toml, fixed.toml, constrained.toml.
Never rescales covariance errors by reduced chi-square.
"""

from __future__ import annotations

import math
import re
from pathlib import Path
from typing import Optional

from .models import (
    ParameterReportModel,
    StructuredWarning,
    UncertaintyValue,
)

RE_SECTION = re.compile(r"^\s*\[(?P<section>[^\]]+)\]\s*$")
RE_KEY_VALUE = re.compile(
    r"^\s*(?P<key>\"[^\"]+\"|'[^']+'|[^\s=]+)\s*=\s*(?P<value>[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|nan|inf|-inf)(?:\s*#\s*(?P<comment>.*))?$",
    re.IGNORECASE,
)
RE_STDERR = re.compile(r"^[±\+\-]\s*(?P<stderr>[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)(?:\s*\((?P<expr>.*)\))?$")
RE_EXPR_ONLY = re.compile(r"^\s*\((?P<expr>.*)\)\s*$")
RE_FIXED = re.compile(r"^\s*\(fixed\)\s*$", re.IGNORECASE)
RE_NOT_CALCULATED = re.compile(r"^\s*\(error\s+not\s+calculated\)\s*$", re.IGNORECASE)


def _clean_token(token: str) -> str:
    token = token.strip()
    if (token.startswith('"') and token.endswith('"')) or (token.startswith("'") and token.endswith("'")):
        return token[1:-1]
    return token


def _parse_comment(
    comment_raw: Optional[str],
    status: str,
) -> tuple[Optional[float], bool, Optional[str], Optional[str]]:
    """
    Parse trailing comment into (stderr, has_stderr, error_reason, expression).
    """
    if not comment_raw:
        return (None, False, None if status != "fitted" else "NO_COMMENT", None)

    comment = comment_raw.strip()

    if status == "fixed" or RE_FIXED.match(comment):
        return (None, False, "FIXED", None)

    if RE_NOT_CALCULATED.match(comment):
        return (None, False, "NOT_CALCULATED", None)

    m_err = RE_STDERR.match(comment)
    if m_err:
        try:
            err_val = float(m_err.group("stderr"))
            expr = m_err.group("expr")
            return (err_val, True, None, expr.strip() if expr else None)
        except (ValueError, TypeError):
            pass

    m_expr = RE_EXPR_ONLY.match(comment)
    if m_expr:
        expr = m_expr.group("expr")
        return (None, False, "EXPRESSION_ONLY" if status == "constrained" else None, expr.strip() if expr else None)

    return (None, False, f"UNRECOGNIZED: {comment}", None)


def parse_parameter_file(
    file_path: Path,
    status: str,  # "fitted" | "fixed" | "constrained"
    warnings: list[StructuredWarning],
) -> dict[str, dict[str, UncertaintyValue]]:
    """
    Parse a single comment-annotated parameter TOML file.
    Returns mapping of section -> key -> UncertaintyValue.
    """
    if not file_path.exists() or not file_path.is_file():
        return {}

    try:
        lines = file_path.read_text(encoding="utf-8").splitlines()
    except Exception as exc:
        warnings.append(
            StructuredWarning(
                code="UNREADABLE_PARAMETER_FILE",
                message=f"Failed to read {file_path.name}: {exc}",
                path=str(file_path),
            )
        )
        return {}

    current_section = "GLOBAL"
    result: dict[str, dict[str, UncertaintyValue]] = {}

    for line_idx, raw_line in enumerate(lines, start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue

        # Check section header
        m_sec = RE_SECTION.match(line)
        if m_sec:
            current_section = _clean_token(m_sec.group("section"))
            if current_section not in result:
                result[current_section] = {}
            continue

        # Check key-value line
        m_kv = RE_KEY_VALUE.match(line)
        if not m_kv:
            warnings.append(
                StructuredWarning(
                    code="MALFORMED_PARAMETER_LINE",
                    message=f"Line {line_idx} does not match parameter grammar: {raw_line!r}",
                    path=str(file_path),
                    details={"line_number": line_idx, "content": raw_line},
                )
            )
            continue

        raw_key = m_kv.group("key")
        key = _clean_token(raw_key)
        val_str = m_kv.group("value")
        comment_str = m_kv.group("comment")

        try:
            val = float(val_str)
        except ValueError:
            val = None

        stderr, has_stderr, error_reason, expr = _parse_comment(comment_str, status)

        name = f"[{current_section}]/{key}" if current_section != "GLOBAL" else key
        is_fixed = (status == "fixed" or error_reason == "FIXED")
        is_constrained = (status == "constrained" or bool(expr))

        if current_section not in result:
            result[current_section] = {}

        result[current_section][key] = UncertaintyValue(
            name=name,
            section=current_section,
            key=key,
            value=val,
            stderr=stderr,
            has_stderr=has_stderr,
            error_reason=error_reason,
            expression=expr,
            is_fixed=is_fixed,
            is_constrained=is_constrained,
            near_boundary=False,
        )

    return result


def parse_parameters_directory(
    parameters_dir: Path,
    warnings: list[StructuredWarning],
) -> ParameterReportModel:
    """
    Parse Parameters/ directory containing fitted.toml, fixed.toml, constrained.toml.
    """
    fitted = parse_parameter_file(parameters_dir / "fitted.toml", "fitted", warnings)
    fixed = parse_parameter_file(parameters_dir / "fixed.toml", "fixed", warnings)
    constrained = parse_parameter_file(parameters_dir / "constrained.toml", "constrained", warnings)

    return ParameterReportModel(
        fitted=fitted,
        fixed=fixed,
        constrained=constrained,
    )
