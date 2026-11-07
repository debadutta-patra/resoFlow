"""Normalize saved ChemEx analysis configs (CEST / CPMG / EXCHANGE) to one key schema.

Historically each analysis page persisted its Parameters/Methods state under different
keys (``parameterConfig`` vs ``parameter_config``, ``parameters_toml`` vs
``parameter_toml``, ``fitMode`` vs ``fit_mode``). Configs on disk keep whatever keys
they were written with; every reader goes through :func:`normalize_chemex_config`, and
every writer merges through :func:`merge_chemex_config`, so the canonical snake_case keys
are always present and authoritative.
"""

from __future__ import annotations

from typing import Any

# canonical key -> legacy aliases (checked in order)
CANONICAL_ALIASES: dict[str, tuple[str, ...]] = {
    "parameter_config": ("parameterConfig",),
    "parameter_toml": ("parameters_toml",),
    "method_config": ("methodConfig",),
    "fit_mode": ("fitMode",),
}

# Legacy keys that older readers (and older frontends) still look for. Kept mirrored
# from the canonical value so a config written today stays readable by them.
_MIRRORED_LEGACY: dict[str, str] = {
    "parameters_toml": "parameter_toml",
}


def _is_empty(value: Any) -> bool:
    return value is None or value == "" or value == {} or value == []


def normalize_chemex_config(cfg: dict | None) -> dict:
    """Return a shallow copy of ``cfg`` with canonical keys filled from legacy aliases.

    A non-empty canonical value always wins over its aliases.
    """
    out: dict = dict(cfg or {})
    for canonical, aliases in CANONICAL_ALIASES.items():
        if not _is_empty(out.get(canonical)):
            continue
        for alias in aliases:
            if not _is_empty(out.get(alias)):
                out[canonical] = out[alias]
                break
    for legacy, canonical in _MIRRORED_LEGACY.items():
        if not _is_empty(out.get(canonical)):
            out[legacy] = out[canonical]
    return out


def merge_chemex_config(existing: dict | None, update: dict | None) -> dict:
    """Merge a config update into an existing config, both normalized.

    ``update`` is normalized before merging so that a legacy-keyed update (e.g. an old
    client sending ``parameterConfig``) replaces the canonical value rather than being
    shadowed by a stale canonical key already on disk.
    """
    merged = normalize_chemex_config(existing)
    merged.update(normalize_chemex_config(update))
    # Drop stale legacy aliases whose canonical counterpart was just updated, so the
    # file cannot contain two diverging copies of the same state.
    for canonical, aliases in CANONICAL_ALIASES.items():
        if canonical in (update or {}) or any(a in (update or {}) for a in aliases):
            for alias in aliases:
                if alias in merged and alias not in _MIRRORED_LEGACY:
                    merged.pop(alias, None)
    return normalize_chemex_config(merged)
