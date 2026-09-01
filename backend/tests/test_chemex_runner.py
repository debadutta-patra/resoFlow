"""Unit tests for ChemEx ephemeral per-job container runner."""

import os
import shutil
import tempfile
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest
from app.services.fitting.chemex_runner import (
    get_container_name,
    to_host_path,
    get_chemex_image_info,
    cancel_chemex_job,
    run_chemex_job,
    reap_orphaned_chemex_containers,
)


def test_get_container_name():
    """Verify deterministic container naming with sanitization."""
    assert get_container_name("12345") == "rf-chemex-12345"
    assert get_container_name("analysis_abc-123") == "rf-chemex-analysis_abc-123"
    # Special characters should be sanitized to dashes
    assert get_container_name("job:name/with!spaces") == "rf-chemex-job-name-with-spaces"


def test_to_host_path_without_env():
    """Without RESOFLOW_HOST_DATA_ROOT, returns local path."""
    with patch.dict(os.environ, {}, clear=True):
        p = Path("/tmp/somedir/project1")
        assert to_host_path(p) == str(p.resolve())


def test_to_host_path_with_env():
    """With RESOFLOW_HOST_DATA_ROOT and CONTAINER_DATA_ROOT, translates correctly."""
    env = {
        "RESOFLOW_HOST_DATA_ROOT": "/home/user/resoFlow_data",
        "RESOFLOW_CONTAINER_DATA_ROOT": "/data/projects",
    }
    with patch.dict(os.environ, env, clear=True):
        container_path = "/data/projects/proj1/cpmg_fitting/abc"
        expected = "/home/user/resoFlow_data/proj1/cpmg_fitting/abc"
        assert to_host_path(container_path) == expected


def test_get_chemex_image_info_mocked():
    """Verify image metadata retrieval via podman inspect and run."""
    with patch("subprocess.run") as mock_run:
        # Mock inspect output
        mock_inspect = MagicMock()
        mock_inspect.returncode = 0
        mock_inspect.stdout = "sha256:abcd1234ef5678\n"

        # Mock version output
        mock_version = MagicMock()
        mock_version.returncode = 0
        mock_version.stdout = "chemex 0.9.2\n"

        mock_run.side_effect = [mock_inspect, mock_version]

        digest, ver = get_chemex_image_info("test-image:latest")
        assert digest == "sha256:abcd1234ef5678"
        assert ver == "0.9.2"


def test_cancel_chemex_job_mocked():
    """Verify podman stop and rm commands during cancellation."""
    with patch("app.services.fitting.chemex_runner._podman_socket_request", return_value=None), \
         patch("subprocess.run") as mock_run:
        mock_ps = MagicMock(returncode=0, stdout="c12345\n")
        mock_stop = MagicMock(returncode=0, stdout="")
        mock_rm = MagicMock(returncode=0, stdout="")
        mock_run.side_effect = [mock_ps, mock_stop, mock_rm]

        res = cancel_chemex_job("analysis-123", timeout=2)
        assert res is True
        assert mock_run.call_count == 3
        # Check container name
        assert mock_run.call_args_list[0][0][0][4] == "name=rf-chemex-analysis-123"


def test_cancel_chemex_job_socket():
    """Verify cancellation via podman socket API."""
    with patch("app.services.fitting.chemex_runner._podman_socket_request") as mock_sock:
        mock_sock.side_effect = [(204, b""), (200, b"")]
        res = cancel_chemex_job("analysis-456", timeout=2)
        assert res is True
        assert mock_sock.call_count == 2


def test_chemex_selinux_flag():
    """Verify :z flag is omitted when RESOFLOW_SELINUX_MOUNT=false."""
    with patch.dict(os.environ, {"RESOFLOW_SELINUX_MOUNT": "false"}):
        with patch("subprocess.Popen") as mock_popen, \
             patch("app.services.fitting.chemex_runner.get_chemex_image_info", return_value=("sha256:1", "1.0")):
            mock_proc = MagicMock()
            mock_proc.stdout.readline.side_effect = [b"done\n", b""]
            mock_proc.poll.side_effect = [None, 0]
            mock_proc.returncode = 0
            mock_popen.return_value = mock_proc

            temp_dir = tempfile.mkdtemp()
            try:
                run_chemex_job(
                    job_id="test-selinux",
                    work_dir=temp_dir,
                    cmd_args=["fit", "-e", "experiments.toml"],
                )
                cmd_launched = mock_popen.call_args[0][0]
                vol_arg = cmd_launched[cmd_launched.index("-v") + 1]
                assert vol_arg.endswith(":/work")
                assert not vol_arg.endswith(":/work:z")
            finally:
                shutil.rmtree(temp_dir, ignore_errors=True)


def test_reap_orphaned_containers_mocked():
    """Verify orphan container reaping."""
    with patch("subprocess.run") as mock_run:
        mock_ps = MagicMock(
            returncode=0,
            stdout="rf-chemex-job1\nrf-chemex-job2\nother-container\n",
        )
        mock_rm1 = MagicMock(returncode=0)
        mock_rm2 = MagicMock(returncode=0)
        mock_run.side_effect = [mock_ps, mock_rm1, mock_rm2]

        reaped = reap_orphaned_chemex_containers()
        assert reaped == ["rf-chemex-job1", "rf-chemex-job2"]


def test_atomic_output_promotion():
    """Verify output staging (.tmp) and atomic promotion upon success."""
    temp_dir = tempfile.mkdtemp()
    try:
        work_dir = Path(temp_dir)
        final_output = work_dir / "Output"
        tmp_output = work_dir / "Output.tmp"
        log_file = work_dir / "chemex.log"

        # Simulate a successful ChemEx run where container writes to Output.tmp
        def mock_popen(*args, **kwargs):
            # Create files in Output.tmp as if ChemEx ran
            tmp_output.mkdir(parents=True, exist_ok=True)
            (tmp_output / "parameters.toml").write_text("pb = 0.05")
            process = MagicMock()
            process.returncode = 0
            process.stdout = None
            process.wait.return_value = 0
            return process

        with patch("subprocess.Popen", side_effect=mock_popen):
            rc = run_chemex_job(
                job_id="test-job",
                work_dir=work_dir,
                cmd_args=["fit", "-o", "Output"],
                log_file=log_file,
            )

            assert rc == 0
            # Output.tmp should have been atomically moved to Output
            assert final_output.exists()
            assert (final_output / "parameters.toml").exists()
            assert not tmp_output.exists()
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_cancellation_cleanup():
    """Verify non-zero / cancelled exit cleans up staging .tmp without overwriting final Output."""
    temp_dir = tempfile.mkdtemp()
    try:
        work_dir = Path(temp_dir)
        final_output = work_dir / "Output"
        final_output.mkdir(parents=True, exist_ok=True)
        (final_output / "old_result.txt").write_text("pre-existing good output")

        tmp_output = work_dir / "Output.tmp"
        log_file = work_dir / "chemex.log"

        # Simulate a cancelled run (exit code 137)
        def mock_popen(*args, **kwargs):
            tmp_output.mkdir(parents=True, exist_ok=True)
            (tmp_output / "partial.txt").write_text("corrupted partial data")
            process = MagicMock()
            process.returncode = 137
            process.stdout = None
            process.wait.return_value = 137
            return process

        with patch("subprocess.Popen", side_effect=mock_popen):
            rc = run_chemex_job(
                job_id="test-job",
                work_dir=work_dir,
                cmd_args=["fit", "-o", "Output"],
                log_file=log_file,
            )

            assert rc == 137
            # Staging directory must be cleaned up
            assert not tmp_output.exists()
            # Original output must remain intact
            assert final_output.exists()
            assert (final_output / "old_result.txt").read_text() == "pre-existing good output"
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)
