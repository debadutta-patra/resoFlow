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

"""In-process runtime patching for ChemEx 2026.6.x progress reporting."""

from __future__ import annotations

from typing import Any, Callable, Iterator, Optional


def _safe_emit(emit: Callable[[dict[str, Any]], None], event: dict[str, Any]) -> None:
    """Emit an event dictionary, swallowing any exceptions to avoid breaking ChemEx fits."""
    try:
        emit(event)
    except Exception:
        pass


def _create_track_wrapper(kind: str, emit: Callable[[dict[str, Any]], None]) -> Callable:
    """
    Create a track generator replacement that emits progress events before and during iteration.
    """

    def track(
        sequence: Any,
        total: Optional[Any] = None,
        description: str = "",
        **kwargs: Any,
    ) -> Iterator[Any]:
        calc_total: Optional[int] = None
        if total is not None:
            try:
                calc_total = int(total)
            except (ValueError, TypeError):
                calc_total = None
        elif hasattr(sequence, "__len__"):
            try:
                calc_total = len(sequence)
            except Exception:
                calc_total = None

        done = 0
        _safe_emit(emit, {"kind": kind, "done": done, "total": calc_total})

        for item in sequence:
            yield item
            done += 1
            _safe_emit(emit, {"kind": kind, "done": done, "total": calc_total})

    return track


def _create_mcmc_progress_bar_class(orig_cls: type, emit: Callable[[dict[str, Any]], None]) -> type:
    """
    Create a replacement _RichEmceeProgressBar class recording progress and delegating to original.
    """

    class _RichEmceeProgressBar:
        def __init__(self, total: int) -> None:
            self._orig = orig_cls(total)
            self._total: Optional[int] = None
            if total is not None:
                try:
                    self._total = int(total)
                except (ValueError, TypeError):
                    self._total = None
            self._done = 0
            _safe_emit(emit, {"kind": "mcmc", "done": self._done, "total": self._total})

        def __enter__(self) -> Any:
            self._orig.__enter__()
            return self

        def __exit__(
            self,
            exc_type: Optional[type] = None,
            exc_val: Optional[BaseException] = None,
            exc_tb: Optional[Any] = None,
        ) -> Any:
            return self._orig.__exit__(exc_type, exc_val, exc_tb)

        def update(self, count: int) -> None:
            if count is not None:
                try:
                    self._done += int(count)
                except (ValueError, TypeError):
                    pass
            _safe_emit(emit, {"kind": "mcmc", "done": self._done, "total": self._total})
            self._orig.update(count)

        def __getattr__(self, name: str) -> Any:
            return getattr(self._orig, name)

    return _RichEmceeProgressBar


def _create_print_line_wrapper(
    orig_print_line: Callable[..., None],
    emit: Callable[[dict[str, Any]], None],
) -> Callable[..., None]:
    """
    Create a wrapper for Reporter.print_line emitting a fit event before calling original.
    """

    def print_line(self: Any, iteration: int, chisqr: float, redchi: float) -> None:
        _safe_emit(
            emit,
            {
                "kind": "fit",
                "iteration": int(iteration),
                "chisqr": float(chisqr),
                "redchi": float(redchi),
            },
        )
        orig_print_line(self, iteration, chisqr, redchi)

    return print_line


_installed = False
_orig_grid_track: Optional[Any] = None
_orig_resample_track: Optional[Any] = None
_orig_mcmc_bar: Optional[Any] = None
_orig_print_line: Optional[Any] = None


def install(emit: Callable[[dict[str, Any]], None]) -> None:
    """
    Idempotently install ChemEx progress hooks with the provided emit callback.

    Args:
        emit: Callable receiving flat event dictionaries.
    """
    global _installed, _orig_grid_track, _orig_resample_track, _orig_mcmc_bar, _orig_print_line

    if _installed:
        return

    import chemex.optimize.gridding as g
    import chemex.optimize.resampling as r
    import chemex.optimize.mcmc as m
    import chemex.optimize.minimizer as mi

    # Save exact original references
    _orig_grid_track = g.track
    _orig_resample_track = r.track
    _orig_mcmc_bar = m._RichEmceeProgressBar
    _orig_print_line = mi.Reporter.print_line

    # Apply patches
    g.track = _create_track_wrapper("grid", emit)
    r.track = _create_track_wrapper("resample", emit)
    m._RichEmceeProgressBar = _create_mcmc_progress_bar_class(_orig_mcmc_bar, emit)
    mi.Reporter.print_line = _create_print_line_wrapper(_orig_print_line, emit)

    _installed = True


def uninstall() -> None:
    """
    Restore the original unpatched ChemEx objects. Idempotent.
    """
    global _installed, _orig_grid_track, _orig_resample_track, _orig_mcmc_bar, _orig_print_line

    if not _installed:
        return

    import chemex.optimize.gridding as g
    import chemex.optimize.resampling as r
    import chemex.optimize.mcmc as m
    import chemex.optimize.minimizer as mi

    g.track = _orig_grid_track
    r.track = _orig_resample_track
    m._RichEmceeProgressBar = _orig_mcmc_bar
    mi.Reporter.print_line = _orig_print_line

    _orig_grid_track = None
    _orig_resample_track = None
    _orig_mcmc_bar = None
    _orig_print_line = None

    _installed = False


def is_installed() -> bool:
    """Return True if progress patches are currently installed."""
    return _installed
