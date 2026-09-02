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

"""Unit tests for ChemEx progress capture layer."""

import inspect
import json
import os
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

import chemex.optimize.gridding as g
import chemex.optimize.mcmc as m
import chemex.optimize.minimizer as mi
import chemex.optimize.resampling as r

from resoflow.progress.targets import ChemExLayoutError, chemex_build, verify
from resoflow.progress.shim import install, is_installed, uninstall
from resoflow.progress.__main__ import _get_progress_stream
from app.services.fitting.chemex_runner import run_chemex_job


@pytest.fixture(autouse=True)
def ensure_uninstalled():
    """Ensure every test starts and ends with clean unpatched ChemEx modules."""
    uninstall()
    yield
    uninstall()


def test_canary_chemex_patch_targets():
    """
    Canary test asserting every ChemEx patch target resolves and signature is unchanged.
    Must fail loudly if ChemEx layout changes in a future release.
    """
    # Verify patch points resolve without error on the pinned ChemEx
    verify()

    # Verify each target specifically
    assert hasattr(g, "track") and callable(g.track)
    assert hasattr(r, "track") and callable(r.track)
    assert hasattr(m, "_RichEmceeProgressBar") and inspect.isclass(m._RichEmceeProgressBar)
    assert hasattr(mi, "Reporter") and inspect.isclass(mi.Reporter)
    assert hasattr(mi.Reporter, "print_line") and callable(mi.Reporter.print_line)

    # Check method signatures
    init_sig = inspect.signature(m._RichEmceeProgressBar.__init__)
    assert "total" in init_sig.parameters

    update_sig = inspect.signature(m._RichEmceeProgressBar.update)
    assert "count" in update_sig.parameters

    pl_sig = inspect.signature(mi.Reporter.print_line)
    for param in ("iteration", "chisqr", "redchi"):
        assert param in pl_sig.parameters


def test_verify_detects_layout_breakage():
    """Verify that verify() raises ChemExLayoutError when attributes or signatures change."""
    # Test missing attribute
    with patch.object(g, "track", new=None):
        delattr(g, "track")
        with pytest.raises(ChemExLayoutError, match="track"):
            verify()

    # Test signature mismatch
    def broken_print_line(self, foo):
        pass

    with patch.object(mi.Reporter, "print_line", broken_print_line):
        with pytest.raises(ChemExLayoutError, match="Reporter.print_line"):
            verify()


def test_chemex_build_metadata():
    """Verify chemex_build returns version, package path, and checkout details."""
    build_info = chemex_build()
    assert "version" in build_info
    assert "path" in build_info
    assert "git_sha" in build_info
    assert "dirty" in build_info
    assert build_info["version"] != "unknown"
    assert build_info["path"].endswith(".py")


def test_patched_track_generator():
    """
    Patched track yields original items in order, handles float total,
    handles iterators without __len__, and emits done from 0 to total inclusive.
    """
    events = []
    install(events.append)

    # 1. Float total (as passed by gridding: itertools.product with total=float(grid_size))
    items = ["item0", "item1", "item2"]
    gen = (x for x in items)  # iterator with no __len__
    assert not hasattr(gen, "__len__")

    consumed = list(g.track(gen, total=3.0, description="   "))
    assert consumed == items

    assert len(events) == 4  # done=0 before loop, done=1, 2, 3
    assert events[0] == {"kind": "grid", "done": 0, "total": 3}
    assert events[1] == {"kind": "grid", "done": 1, "total": 3}
    assert events[2] == {"kind": "grid", "done": 2, "total": 3}
    assert events[3] == {"kind": "grid", "done": 3, "total": 3}

    # 2. Resampling track unpacks (sample_values, chisqr) tuples untouched
    events.clear()
    sample_tuples = [([1.0, 2.0], 10.5), ([1.1, 2.1], 9.8)]
    consumed_samples = list(r.track(sample_tuples, total=2))
    assert consumed_samples == sample_tuples
    assert events[0] == {"kind": "resample", "done": 0, "total": 2}
    assert events[1] == {"kind": "resample", "done": 1, "total": 2}
    assert events[2] == {"kind": "resample", "done": 2, "total": 2}

    # 3. Sequence without total but with __len__
    events.clear()
    consumed_list = list(g.track([100, 200]))
    assert consumed_list == [100, 200]
    assert events[0] == {"kind": "grid", "done": 0, "total": 2}
    assert events[-1] == {"kind": "grid", "done": 2, "total": 2}

    # 4. Sequence without total and without __len__
    events.clear()
    consumed_gen = list(g.track((x for x in [1, 2])))
    assert consumed_gen == [1, 2]
    assert events[0] == {"kind": "grid", "done": 0, "total": None}
    assert events[1] == {"kind": "grid", "done": 1, "total": None}
    assert events[2] == {"kind": "grid", "done": 2, "total": None}


def test_install_twice_and_uninstall_identity():
    """
    install() called twice then uninstall() restores exact original objects (assert identity, not equality).
    """
    orig_grid_track = g.track
    orig_resample_track = r.track
    orig_mcmc_bar = m._RichEmceeProgressBar
    orig_print_line = mi.Reporter.print_line

    events = []
    # First install
    install(events.append)
    assert is_installed()
    first_installed_track = g.track
    assert first_installed_track is not orig_grid_track

    # Second install (must be idempotent and not double-wrap)
    install(events.append)
    assert g.track is first_installed_track

    # Uninstall
    uninstall()
    assert not is_installed()

    # Exact object identity restored
    assert g.track is orig_grid_track
    assert r.track is orig_resample_track
    assert m._RichEmceeProgressBar is orig_mcmc_bar
    assert mi.Reporter.print_line is orig_print_line


def test_emit_exception_safety():
    """An emit that raises an exception does not propagate out of track, print_line, or mcmc."""
    def broken_emit(event):
        raise RuntimeError("Pipe broken / connection reset")

    install(broken_emit)

    # 1. track should not raise
    results = list(g.track([1, 2, 3], total=3.0))
    assert results == [1, 2, 3]

    # 2. print_line should not raise
    rep = mi.Reporter()
    rep.print_line(iteration=1, chisqr=42.0, redchi=1.2)

    # 3. _RichEmceeProgressBar should not raise
    with m._RichEmceeProgressBar(total=10) as bar:
        bar.update(2)
        bar.update(3)


def test_reporter_print_line_callthrough():
    """Reporter.print_line emits fit event and calls through to original function."""
    events = []
    install(events.append)

    rep = mi.Reporter()
    with patch("chemex.optimize.minimizer.print_chi2_table_line") as mock_table:
        rep.print_line(iteration=5, chisqr=123.456, redchi=1.234)
        mock_table.assert_called_once_with(5, 123.456, 1.234)

    assert len(events) == 1
    assert events[0] == {
        "kind": "fit",
        "iteration": 5,
        "chisqr": 123.456,
        "redchi": 1.234,
    }


def test_mcmc_progress_bar():
    """_RichEmceeProgressBar records total, opening event, and accumulates update counts."""
    events = []
    install(events.append)

    with m._RichEmceeProgressBar(total=50) as bar:
        bar.update(10)
        bar.update(15)

    assert len(events) == 3
    assert events[0] == {"kind": "mcmc", "done": 0, "total": 50}
    assert events[1] == {"kind": "mcmc", "done": 10, "total": 50}
    assert events[2] == {"kind": "mcmc", "done": 25, "total": 50}


def test_entrypoint_fallback_to_stderr(monkeypatch):
    """Entry point falls back to stderr when RESOFLOW_PROGRESS_FD is unset or invalid."""
    monkeypatch.delenv("RESOFLOW_PROGRESS_FD", raising=False)
    stream = _get_progress_stream()
    assert stream is sys.stderr

    monkeypatch.setenv("RESOFLOW_PROGRESS_FD", "invalid_fd_string")
    stream_invalid = _get_progress_stream()
    assert stream_invalid is sys.stderr


def test_job_runner_progress_pipe_integration(tmp_path):
    """
    Test run_chemex_job drains the progress pipe, invokes callback,
    and skips malformed JSON lines without error.
    """
    received_events = []

    def mock_popen(cmd, *args, **kwargs):
        # Emulate ChemEx emitting structured events and normal stdout
        w_fd_val = int(kwargs["env"]["RESOFLOW_PROGRESS_FD"])
        with os.fdopen(w_fd_val, "w", encoding="utf-8") as pf:
            pf.write(json.dumps({"kind": "grid", "done": 0, "total": 2}) + "\n")
            pf.write("malformed non-json line\n")  # should be skipped
            pf.write(json.dumps({"kind": "grid", "done": 1, "total": 2}) + "\n")
            pf.write(json.dumps({"kind": "grid", "done": 2, "total": 2}) + "\n")
            pf.flush()

        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.stdout.readline.side_effect = ["Chi2 Table Header\n", "1  10.0  1.0\n", ""]
        mock_proc.wait.return_value = 0
        return mock_proc

    log_file = tmp_path / "chemex.log"

    with patch("subprocess.Popen", side_effect=mock_popen):
        rc = run_chemex_job(
            job_id="test-progress-run",
            work_dir=tmp_path,
            cmd_args=["fit", "-o", "Output"],
            log_file=log_file,
            progress_callback=received_events.append,
        )

    assert rc == 0
    assert len(received_events) == 3
    assert received_events[0] == {"kind": "grid", "done": 0, "total": 2}
    assert received_events[1] == {"kind": "grid", "done": 1, "total": 2}
    assert received_events[2] == {"kind": "grid", "done": 2, "total": 2}

    # Verify stdout was also captured into chemex.log
    log_content = log_file.read_text(encoding="utf-8")
    assert "Chi2 Table Header" in log_content
    assert "1  10.0  1.0" in log_content
