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

"""Subprocess entry point for ChemEx progress capture.

This module provides process isolation for Celery jobs while intercepting ChemEx
progress events and streaming structured JSON records across a dedicated pipe.

Progress File Descriptor Contract:
    - Reads the target file descriptor from the `RESOFLOW_PROGRESS_FD` environment variable.
    - If `RESOFLOW_PROGRESS_FD` is unset or invalid, defaults to `sys.stderr` line-buffered,
      allowing the module to remain directly runnable by hand from the command line.
    - Writes exactly one flat JSON object per line, followed by a newline and flush.

CRITICAL PARENT PROCESS REQUIREMENT:
    The parent process **must drain the fd**. An unread pipe buffer (typically 64 KiB
    on Linux) will fill up and block the child process, stalling the fit indefinitely.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any, TextIO

from .shim import install


def _get_progress_stream() -> TextIO:
    """Resolve line-buffered progress output stream from RESOFLOW_PROGRESS_FD or fallback to stderr."""
    fd_str = os.environ.get("RESOFLOW_PROGRESS_FD")
    if fd_str:
        try:
            fd = int(fd_str)
            return os.fdopen(fd, mode="w", buffering=1, encoding="utf-8")
        except Exception:
            pass
    return sys.stderr


def main() -> None:
    """Install progress hooks and execute chemex.chemex.main() forwarding argv and exit code."""
    stream = _get_progress_stream()

    def emit(event: dict[str, Any]) -> None:
        try:
            stream.write(json.dumps(event) + "\n")
            stream.flush()
        except Exception:
            pass

    install(emit)

    import chemex.chemex

    try:
        exit_code = chemex.chemex.main()
        sys.exit(exit_code or 0)
    except SystemExit as e:
        sys.exit(e.code)


if __name__ == "__main__":
    main()
