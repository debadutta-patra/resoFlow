"""CEST inspection inputs from an analysis config (CEST or combined Exchange layout), and
offset masks written into the generated experiment TOML.

Masks are review state: ``cest_masks = {"<b1_label>": [plane, ...]}`` in the analysis config.
ChemEx filters points per experiment (``filter_planes`` in ``[data]``), not per residue, so a
mask removes that plane for every residue of that B1 experiment. Raw data files are never
touched: only the generated experiment TOML changes.
"""

from __future__ import annotations

import json
import os
import re
import tomllib
from typing import Any, Iterable, Optional

from .cest_one_state import CestExperimentInput

DEFAULT_TIME_T1 = 0.5


def _read_profile_file(path: str) -> tuple[list[float], list[float], list[float]]:
    offsets: list[float] = []
    intens: list[float] = []
    uncs: list[float] = []
    with open(path, "r") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split()
            if len(parts) >= 2:
                offsets.append(float(parts[0]))
                intens.append(float(parts[1]))
                uncs.append(float(parts[2]) if len(parts) >= 3 else 0.0)
    return offsets, intens, uncs


def cest_profiles_from_config(cfg: dict) -> list[dict]:
    """CEST profiles ``[{residue, full_residue, experiments: [{b1, b1_actual, b0, carrier,
    offsets, intensities, uncertainties}]}]`` from either config layout."""
    if isinstance(cfg.get("cest_profiles"), list) and cfg["cest_profiles"]:
        return cfg["cest_profiles"]
    grouped: dict[str, list[dict]] = {}
    meta_all = cfg.get("metadata") or {}
    for key, path in (cfg.get("data_files") or {}).items():
        residue, _, label = key.partition(":")
        if not path or not os.path.exists(path):
            continue
        try:
            offsets, intens, uncs = _read_profile_file(path)
        except (OSError, ValueError):
            continue
        meta = meta_all.get(label, {})
        grouped.setdefault(residue, []).append({
            "b1": label,
            "b1_actual": meta.get("b1") or 0.0,
            "b0": meta.get("b0") or 600.0,
            "carrier": meta.get("carrier") or 0.0,
            "offsets": offsets,
            "intensities": intens,
            "uncertainties": uncs,
        })
    mapping = cfg.get("residue_mapping") or {}
    return [{"residue": r, "full_residue": mapping.get(r, r), "experiments": exps} for r, exps in sorted(grouped.items())]


def _exp_label(exp: dict) -> Optional[str]:
    return exp.get("b1_label") or exp.get("label")


def _is_cest_experiment(exp: dict) -> bool:
    kind = str(exp.get("type") or "").upper()
    return kind in ("", "CEST") and bool(exp.get("b1_label"))


def time_t1_by_label(cfg: dict) -> dict[str, float]:
    """Saturation time per B1 label, read from the generated experiment TOML."""
    out: dict[str, float] = {}
    for exp in cfg.get("generatedExperiments") or []:
        if not isinstance(exp, dict) or not _is_cest_experiment(exp):
            continue
        try:
            parsed = tomllib.loads(exp.get("toml_content") or "")
            t1 = float(parsed.get("experiment", {}).get("time_t1"))
        except (tomllib.TOMLDecodeError, TypeError, ValueError):
            continue
        if t1 > 0:
            out[_exp_label(exp)] = t1
    return out


def normalize_masks(raw: Any) -> dict[str, list[int]]:
    """``{label: sorted unique non-negative plane indices}``; malformed entries dropped."""
    out: dict[str, list[int]] = {}
    if not isinstance(raw, dict):
        return out
    for label, planes in raw.items():
        if not isinstance(planes, list):
            continue
        clean = sorted({int(p) for p in planes if isinstance(p, (int, float)) and int(p) >= 0 and int(p) == p})
        if clean:
            out[str(label)] = clean
    return out


def experiment_inputs(
    profile: dict,
    t1_by_label: dict[str, float],
    masks: dict[str, list[int]],
) -> list[CestExperimentInput]:
    out = []
    for exp in profile.get("experiments") or []:
        if exp.get("error") or not exp.get("offsets"):
            continue
        label = str(exp.get("b1"))
        b1_hz = exp.get("b1_actual") or _b1_from_label(label)
        if not b1_hz:
            continue
        out.append(CestExperimentInput(
            label=label,
            b0_mhz=float(exp.get("b0") or 600.0),
            b1_hz=float(b1_hz),
            carrier_ppm=float(exp.get("carrier") or 0.0),
            time_t1=t1_by_label.get(label, DEFAULT_TIME_T1),
            offsets_hz=exp.get("offsets") or [],
            intensities=exp.get("intensities") or [],
            uncertainties=exp.get("uncertainties"),
            masked_planes=masks.get(label, []),
        ))
    return out


def _b1_from_label(label: str) -> Optional[float]:
    m = re.search(r"([\d.]+)\s*hz", label, re.IGNORECASE)
    return float(m.group(1)) if m else None


# ── Masks → experiment TOML ──────────────────────────────────────────────

_SECTION = re.compile(r"^\s*\[([A-Za-z0-9_.\-]+)\]\s*$")
_FILTER_PLANES = re.compile(r"^\s*filter_planes\s*=")


def apply_plane_filter(toml_content: str, planes: Iterable[int]) -> str:
    """Set ``filter_planes`` in the ``[data]`` section (removing it when ``planes`` is empty)."""
    planes = sorted(set(int(p) for p in planes))
    lines = toml_content.splitlines()
    out: list[str] = []
    section = None
    data_start = None
    replaced = False
    for line in lines:
        m = _SECTION.match(line)
        if m:
            section = m.group(1).lower()
            out.append(line)
            if section == "data":
                data_start = len(out)
            continue
        if section == "data" and _FILTER_PLANES.match(line):
            if planes and not replaced:
                out.append(f"filter_planes  = {json.dumps(planes)}")
            replaced = True
            continue
        out.append(line)
    if planes and not replaced and data_start is not None:
        # Insert after the last plain key of [data] (before any sub-table such as [data.profiles]).
        insert_at = data_start
        for i in range(data_start, len(out)):
            if _SECTION.match(out[i]):
                break
            if out[i].strip() and not out[i].strip().startswith("#"):
                insert_at = i + 1
        out.insert(insert_at, f"filter_planes  = {json.dumps(planes)}")
    return "\n".join(out) + ("\n" if toml_content.endswith("\n") else "")


def sync_masks_into_experiments(cfg: dict) -> list[dict]:
    """Rewrite each CEST experiment's ``filter_planes`` from the global ``filter_planes`` plus
    its ``cest_masks`` entry. Returns the updated ``generatedExperiments`` list (also stored
    back into ``cfg``)."""
    masks = normalize_masks(cfg.get("cest_masks"))
    global_planes = [int(p) for p in (cfg.get("filter_planes") or []) if isinstance(p, (int, float))]
    exps = cfg.get("generatedExperiments") or []
    for exp in exps:
        if not isinstance(exp, dict) or not _is_cest_experiment(exp) or not exp.get("toml_content"):
            continue
        planes = set(global_planes) | set(masks.get(_exp_label(exp), []))
        exp["toml_content"] = apply_plane_filter(exp["toml_content"], planes)
    cfg["generatedExperiments"] = exps
    return exps


def write_experiment_tomls(exps: list[dict]) -> None:
    """Write generated TOML back to the experiment files (generated output, never raw data)."""
    for exp in exps:
        path = exp.get("path") if isinstance(exp, dict) else None
        if path and exp.get("toml_content") and os.path.isdir(os.path.dirname(path)) and path.endswith(".toml"):
            try:
                with open(path, "w") as f:
                    f.write(exp["toml_content"])
            except OSError:
                pass
