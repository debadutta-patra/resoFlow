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

"""Resolve and validate ChemEx 2026.6.x progress patch targets."""

from __future__ import annotations

import inspect
import subprocess
from importlib.metadata import version as get_package_version
from pathlib import Path
from typing import Any, Optional, TypedDict


class ChemExLayoutError(Exception):
    """Raised when the installed ChemEx package layout or signatures do not match expectations."""


class ChemExBuildInfo(TypedDict):
    version: str
    path: str
    git_sha: Optional[str]
    dirty: Optional[bool]


def get_chemex_version() -> str:
    """Return installed ChemEx distribution version or 'unknown'."""
    try:
        return get_package_version("chemex")
    except Exception:
        return "unknown"


def chemex_build() -> ChemExBuildInfo:
    """
    Return build identity metadata for the installed ChemEx package.

    Returns:
        ChemExBuildInfo with version, resolved package path, and git commit SHA / dirty flag
        if installed from a git checkout.
    """
    ver = get_chemex_version()
    pkg_path = "unknown"
    pkg_dir: Optional[Path] = None

    try:
        import chemex

        if hasattr(chemex, "__file__") and chemex.__file__:
            p = Path(chemex.__file__).resolve()
            pkg_path = str(p)
            pkg_dir = p.parent
    except Exception:
        pass

    git_sha: Optional[str] = None
    dirty: Optional[bool] = None

    if pkg_dir is not None:
        curr = pkg_dir
        git_root: Optional[Path] = None
        while curr != curr.parent:
            if (curr / ".git").exists():
                git_root = curr
                break
            curr = curr.parent

        if git_root is not None:
            try:
                sha_res = subprocess.run(
                    ["git", "-C", str(git_root), "rev-parse", "HEAD"],
                    capture_output=True,
                    text=True,
                    timeout=3,
                )
                if sha_res.returncode == 0 and sha_res.stdout.strip():
                    git_sha = sha_res.stdout.strip()

                stat_res = subprocess.run(
                    ["git", "-C", str(git_root), "status", "--porcelain"],
                    capture_output=True,
                    text=True,
                    timeout=3,
                )
                if stat_res.returncode == 0:
                    dirty = bool(stat_res.stdout.strip())
            except Exception:
                pass

    return {
        "version": ver,
        "path": pkg_path,
        "git_sha": git_sha,
        "dirty": dirty,
    }


def verify() -> None:
    """
    Verify that all four ChemEx patch targets exist and conform to expected signatures.

    Raises:
        ChemExLayoutError: If any target attribute or required method signature is missing or altered.
    """
    ver = get_chemex_version()

    # 1. Gridding track
    try:
        import chemex.optimize.gridding as g
    except Exception as e:
        raise ChemExLayoutError(
            f"Failed to import chemex.optimize.gridding in ChemEx {ver}: {e}"
        ) from e

    if not hasattr(g, "track") or not callable(g.track):
        raise ChemExLayoutError(
            f"Target 'chemex.optimize.gridding.track' is missing or not callable in ChemEx {ver}"
        )

    # 2. Resampling track
    try:
        import chemex.optimize.resampling as r
    except Exception as e:
        raise ChemExLayoutError(
            f"Failed to import chemex.optimize.resampling in ChemEx {ver}: {e}"
        ) from e

    if not hasattr(r, "track") or not callable(r.track):
        raise ChemExLayoutError(
            f"Target 'chemex.optimize.resampling.track' is missing or not callable in ChemEx {ver}"
        )

    # 3. MCMC _RichEmceeProgressBar
    try:
        import chemex.optimize.mcmc as m
    except Exception as e:
        raise ChemExLayoutError(
            f"Failed to import chemex.optimize.mcmc in ChemEx {ver}: {e}"
        ) from e

    if not hasattr(m, "_RichEmceeProgressBar") or not inspect.isclass(m._RichEmceeProgressBar):
        raise ChemExLayoutError(
            f"Target 'chemex.optimize.mcmc._RichEmceeProgressBar' class is missing in ChemEx {ver}"
        )

    cls = m._RichEmceeProgressBar
    init_func = getattr(cls, "__init__", None)
    if not callable(init_func):
        raise ChemExLayoutError(
            f"Target 'chemex.optimize.mcmc._RichEmceeProgressBar.__init__' is missing in ChemEx {ver}"
        )
    init_sig = inspect.signature(init_func)
    init_params = list(init_sig.parameters.keys())
    if "total" not in init_params:
        raise ChemExLayoutError(
            f"Expected 'total' in chemex.optimize.mcmc._RichEmceeProgressBar.__init__ signature, got {init_sig} in ChemEx {ver}"
        )

    update_func = getattr(cls, "update", None)
    if not callable(update_func):
        raise ChemExLayoutError(
            f"Target 'chemex.optimize.mcmc._RichEmceeProgressBar.update' is missing in ChemEx {ver}"
        )
    update_sig = inspect.signature(update_func)
    update_params = list(update_sig.parameters.keys())
    if "count" not in update_params:
        raise ChemExLayoutError(
            f"Expected 'count' in chemex.optimize.mcmc._RichEmceeProgressBar.update signature, got {update_sig} in ChemEx {ver}"
        )

    # 4. Minimizer Reporter.print_line
    try:
        import chemex.optimize.minimizer as mi
    except Exception as e:
        raise ChemExLayoutError(
            f"Failed to import chemex.optimize.minimizer in ChemEx {ver}: {e}"
        ) from e

    if not hasattr(mi, "Reporter") or not inspect.isclass(mi.Reporter):
        raise ChemExLayoutError(
            f"Target 'chemex.optimize.minimizer.Reporter' class is missing in ChemEx {ver}"
        )

    print_line = getattr(mi.Reporter, "print_line", None)
    if not callable(print_line):
        raise ChemExLayoutError(
            f"Target 'chemex.optimize.minimizer.Reporter.print_line' is missing in ChemEx {ver}"
        )

    pl_sig = inspect.signature(print_line)
    pl_params = list(pl_sig.parameters.keys())
    for expected_param in ("iteration", "chisqr", "redchi"):
        if expected_param not in pl_params:
            raise ChemExLayoutError(
                f"Expected '{expected_param}' in chemex.optimize.minimizer.Reporter.print_line signature, got {pl_sig} in ChemEx {ver}"
            )


# Fail loudly at import time if targets cannot be verified
verify()
