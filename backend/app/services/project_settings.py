"""resoFlow-only Methods-page metadata stored per project (shared by every viewer)
and per user. Nothing here is ever written into a ChemEx input file.

Project settings (``projects.settings``):
  * ``sequence_offset`` — residue number of sequence letter *i* (0-based) is ``i + 1 + offset``;
    the sequence itself is ``projects.protein_sequence``.
  * ``scientific_checks`` — per-check ``{"enabled": bool, "threshold": float?}`` (Phase C hints).
  * ``named_selections`` — saved residue selections.
  * ``method_templates`` — project-level user method templates.

User preferences (``users.preferences``):
  * ``method_templates`` — user-level method templates (visible in every project).

Updates are partial: each top-level key given replaces that key only, so two
viewers editing different settings never clobber each other.
"""

from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field


class ScientificCheckSetting(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool = True
    threshold: Optional[float] = None


class NamedSelection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=120)
    residues: list[str] = Field(default_factory=list)
    created_at: Optional[str] = None


class UserMethodTemplate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)
    family: Optional[str] = None
    # A MethodConfig as saved by the frontend (structure validated there and by ChemEx on use).
    config: dict[str, Any]
    created_at: Optional[str] = None


class ProjectSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sequence_offset: int = 0
    scientific_checks: dict[str, ScientificCheckSetting] = Field(default_factory=dict)
    named_selections: list[NamedSelection] = Field(default_factory=list)
    method_templates: list[UserMethodTemplate] = Field(default_factory=list)


class ProjectSettingsUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sequence_offset: Optional[int] = None
    scientific_checks: Optional[dict[str, ScientificCheckSetting]] = None
    named_selections: Optional[list[NamedSelection]] = None
    method_templates: Optional[list[UserMethodTemplate]] = None


class UserPreferences(BaseModel):
    model_config = ConfigDict(extra="forbid")
    method_templates: list[UserMethodTemplate] = Field(default_factory=list)


class UserPreferencesUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    method_templates: Optional[list[UserMethodTemplate]] = None


def _load(model: type[BaseModel], raw: Any) -> BaseModel:
    """Parse stored JSON leniently: unknown keys (from a newer version) are dropped, bad values reset."""
    data = raw if isinstance(raw, dict) else {}
    known = {k: v for k, v in data.items() if k in model.model_fields}
    try:
        return model(**known)
    except Exception:
        out: dict[str, Any] = {}
        for k, v in known.items():
            try:
                model(**{k: v})
                out[k] = v
            except Exception:
                continue
        return model(**out)


def load_project_settings(raw: Any) -> ProjectSettings:
    return _load(ProjectSettings, raw)  # type: ignore[return-value]


def merge_project_settings(raw: Any, update: ProjectSettingsUpdate) -> ProjectSettings:
    current = load_project_settings(raw).model_dump()
    current.update(update.model_dump(exclude_unset=True, exclude_none=True))
    return ProjectSettings(**current)


def load_user_preferences(raw: Any) -> UserPreferences:
    return _load(UserPreferences, raw)  # type: ignore[return-value]


def merge_user_preferences(raw: Any, update: UserPreferencesUpdate) -> UserPreferences:
    current = load_user_preferences(raw).model_dump()
    current.update(update.model_dump(exclude_unset=True, exclude_none=True))
    return UserPreferences(**current)
