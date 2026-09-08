# Copyright (C) 2026 resoFlow Authors
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

"""
Server-side feature flags, read from the environment.

Flags are resolved per call rather than cached at import, so a test can set
the environment variable with monkeypatch and a deployment can change it with
a restart of the process rather than a rebuild.
"""

from __future__ import annotations

import os
from typing import Dict

ENABLE_EXPERIMENTAL_SDM_REX = "RESOFLOW_ENABLE_EXPERIMENTAL_SDM_REX"
"""Gates chemical-exchange correction in spectral density mapping.

Default false. When disabled the API rejects any spectral density request
carrying rex_source != "none" with a 422 naming this variable, and the
frontend hides the Rex controls entirely.

The database column and the pydantic field exist regardless -- gating is at
the API layer, so an experimental record written while the flag was on still
deserialises after it is turned off.
"""

_TRUTHY = {"1", "true", "yes", "on"}


def _flag(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in _TRUTHY


def experimental_sdm_rex_enabled() -> bool:
    """Whether Rex-corrected spectral density mapping may be requested."""
    return _flag(ENABLE_EXPERIMENTAL_SDM_REX, default=False)


def capabilities() -> Dict[str, object]:
    """The capability set the frontend reads to decide what to render.

    Keys are stable identifiers; the frontend must treat an absent key as
    disabled so that an older server does not enable a newer control.
    """
    return {
        "features": {
            "experimental_sdm_rex": experimental_sdm_rex_enabled(),
        },
        "flags": {
            "experimental_sdm_rex": ENABLE_EXPERIMENTAL_SDM_REX,
        },
    }
