"""Unit tests for ChemEx ephemeral per-job container runner."""

import json
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
    is_chemex_container_running,
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


def test_cancel_chemex_job_podman3_socket_fallback():
    """Verify cancellation falls back to /v3.0.0/libpod when /v4.0.0 returns 404."""
    import app.services.fitting.chemex_runner as runner
    runner._DETECTED_API_PREFIX = None

    with patch("app.services.fitting.chemex_runner._podman_socket_request") as mock_sock:
        # First call (/v4.0.0/.../stop): 404 Not Found (Podman 3.x)
        # Second call (/v3.0.0/.../stop): 204 No Content (Success on fallback)
        # Third call (/v3.0.0/...?force=true): 200 OK (Deletion)
        mock_sock.side_effect = [(404, b"Not Found"), (204, b""), (200, b"")]
        res = cancel_chemex_job("analysis-podman3", timeout=2)
        assert res is True
        assert mock_sock.call_count == 3
        # Verify calls were routed to /v3.0.0
        assert mock_sock.call_args_list[1][0][1].startswith("/v3.0.0/libpod/")
        assert mock_sock.call_args_list[2][0][1].startswith("/v3.0.0/libpod/")

    runner._DETECTED_API_PREFIX = None


def test_is_chemex_container_running_podman3_socket_fallback():
    """Verify running container check falls back to /v3.0.0/libpod when /v4.0.0 returns 404."""
    import app.services.fitting.chemex_runner as runner
    runner._DETECTED_API_PREFIX = None

    with patch("app.services.fitting.chemex_runner._podman_socket_request") as mock_sock:
        # First call (/v4.0.0): 404
        # Second call (/v3.0.0): 200 with containers JSON
        mock_sock.side_effect = [(404, b"Not Found"), (200, b'[{"Names":["rf-chemex-p3"]}]')]
        res = is_chemex_container_running("p3")
        assert res is True
        assert mock_sock.call_count == 2
        assert mock_sock.call_args_list[1][0][1].startswith("/v3.0.0/libpod/")

    runner._DETECTED_API_PREFIX = None


import time
from app.services.fitting.chemex_jobs import build_fit_spec
from app.services.fitting.launchers import (
    JobHandle,
    JobState,
    Launcher,
    LocalLauncher,
    PodmanLauncher,
    Resources,
    get_launcher,
    wait_for_job,
)
from resoflow.chemex_api.spec import FitJobSpec


class FakeLauncher:
    name = "fake"

    def __init__(self, states=None):
        self.states = list(states) if states else [JobState.DONE]
        self.cancel_called = False

    def submit(self, job_dir: Path, spec: FitJobSpec, resources: Resources) -> JobHandle:
        return JobHandle(launcher=self.name, id="fake-1", job_dir=str(job_dir))

    def poll(self, handle: JobHandle) -> JobState:
        if len(self.states) > 1:
            return self.states.pop(0)
        return self.states[0]

    def cancel(self, handle: JobHandle) -> None:
        self.cancel_called = True

    def collect(self, handle: JobHandle) -> Path:
        return Path(handle.job_dir)


def test_job_handle_serialization():
    handle = JobHandle(
        launcher="podman",
        id="rf-chemex-123",
        job_dir="/tmp/job",
        metadata={"pid": 42},
    )
    d = handle.to_dict()
    assert d == {
        "launcher": "podman",
        "id": "rf-chemex-123",
        "job_dir": "/tmp/job",
        "metadata": {"pid": 42},
    }
    reconstituted = JobHandle.from_dict(d)
    assert reconstituted.launcher == handle.launcher
    assert reconstituted.id == handle.id
    assert reconstituted.job_dir == handle.job_dir
    assert reconstituted.metadata == handle.metadata


def test_wait_for_job_progress_and_logs():
    temp_dir = tempfile.mkdtemp()
    try:
        job_dir = Path(temp_dir)
        progress_jsonl = job_dir / "progress.jsonl"
        engine_log = job_dir / "engine.log"
        log_file = job_dir / "chemex.log"

        # Write progress events and log output
        progress_jsonl.write_text(
            '{"kind": "fit", "iteration": 1, "chisqr": 100.0, "redchi": 1.5}\n'
            '{"kind": "mcmc", "done": 10, "total": 20}\n'
        )
        engine_log.write_text("Starting fit step 1\nOptimizing parameters\n")

        events = []
        fake = FakeLauncher([JobState.RUNNING, JobState.DONE])
        handle = JobHandle(launcher="fake", id="f1", job_dir=str(job_dir))

        state = wait_for_job(
            launcher=fake,
            handle=handle,
            on_progress=lambda ev: events.append(ev),
            log_file=log_file,
            poll_interval=0.01,
        )

        assert state == JobState.DONE
        assert len(events) == 2
        assert events[0]["kind"] == "fit"
        assert events[1]["kind"] == "mcmc"

        assert (job_dir / "progress.json").exists()
        assert log_file.exists()
        assert "Starting fit step 1" in log_file.read_text()
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_wait_for_job_stale_heartbeat_lost():
    temp_dir = tempfile.mkdtemp()
    try:
        job_dir = Path(temp_dir)
        heartbeat_file = job_dir / "heartbeat"
        heartbeat_file.write_text("1")
        # Set heartbeat mtime to 100 seconds in the past
        past_time = time.time() - 100
        os.utime(heartbeat_file, (past_time, past_time))

        fake = FakeLauncher([JobState.RUNNING])
        handle = JobHandle(launcher="fake", id="f2", job_dir=str(job_dir))

        state = wait_for_job(
            launcher=fake,
            handle=handle,
            poll_interval=0.01,
            stale_heartbeat_timeout=1.0,
        )

        assert state == JobState.LOST
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_wait_for_job_timeout():
    temp_dir = tempfile.mkdtemp()
    try:
        job_dir = Path(temp_dir)
        fake = FakeLauncher([JobState.RUNNING])
        handle = JobHandle(launcher="fake", id="f3", job_dir=str(job_dir))

        state = wait_for_job(
            launcher=fake,
            handle=handle,
            poll_interval=0.01,
            timeout_seconds=0.1,
        )

        assert state == JobState.CANCELLED
        assert fake.cancel_called is True
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_get_launcher_factory():
    with patch.dict(os.environ, {"RESOFLOW_LAUNCHER": "local"}, clear=True):
        l = get_launcher()
        assert isinstance(l, LocalLauncher)

    with patch.dict(os.environ, {"RESOFLOW_LAUNCHER": "podman"}, clear=True):
        l = get_launcher()
        assert isinstance(l, PodmanLauncher)

    with patch.dict(os.environ, {"RESOFLOW_LAUNCHER": "slurm"}, clear=True):
        from app.services.fitting.launchers import SlurmLauncher
        l = get_launcher()
        assert isinstance(l, SlurmLauncher)


def test_run_chemex_job_e2e_local():
    """Verify run_chemex_job executes an actual fit end-to-end via LocalLauncher."""
    fixture_inputs = Path(__file__).parent / "fixtures" / "baselines" / "2026.6.1" / "cpmg_15n_ip" / "inputs"
    if not fixture_inputs.exists():
        pytest.skip("Baseline fixture inputs not found")

    with tempfile.TemporaryDirectory() as tmp_dir:
        job_dir = Path(tmp_dir)
        # Copy input tree into job_dir
        shutil.copytree(fixture_inputs, job_dir, dirs_exist_ok=True)

        dirs = {
            "experiments_dir": job_dir / "Experiments",
            "parameters_dir": job_dir / "Parameters",
            "methods_dir": job_dir / "Methods",
            "output_dir": job_dir / "Output",
        }
        config = {
            "analysis_uuid": "e2e-local-test",
            "model": "2st",
            "include": ["15N"],  # Restrict to 1 residue for fast execution
        }

        spec = build_fit_spec(dirs, config, job_dir=job_dir)
        log_file = job_dir / "chemex.log"

        events = []
        rc = run_chemex_job(
            job_id="e2e-local-test",
            work_dir=job_dir,
            spec=spec,
            log_file=log_file,
            launcher_name="local",
            progress_callback=lambda ev: events.append(ev),
        )

        assert rc == 0
        final_output = job_dir / "Output"
        assert final_output.exists()
        assert not (job_dir / "Output.tmp").exists()
        assert (final_output / "STEP1" / "Parameters" / "fitted.toml").exists()
        assert (final_output / "run_info" / "outcome.toml").exists()
        assert (job_dir / "engine_result.json").exists()
        result_data = json.loads((job_dir / "engine_result.json").read_text(encoding="utf-8"))
        assert result_data["status"] == "complete"
        assert result_data["exit_code"] == 0
        assert len(events) >= 1
        assert log_file.exists()




def test_wait_for_job_tracks_current_step():
    """progress.json carries the running method step alongside live fit statistics."""
    temp_dir = tempfile.mkdtemp()
    try:
        job_dir = Path(temp_dir)
        (job_dir / "progress.jsonl").write_text(
            '{"kind": "step", "name": "GLOBAL_FIT", "index": 1, "total": 2, "t": 100.0}\n'
            '{"kind": "fit", "iteration": 3, "chisqr": 10.0, "redchi": 1.1}\n'
            '{"kind": "step", "name": "LOCAL_FITS", "index": 2, "total": 2, "t": 200.0}\n'
            '{"kind": "grid", "done": 3, "total": 12}\n'
            '{"kind": "fit", "iteration": 7, "chisqr": 9.0, "redchi": 1.05}\n'
        )
        log_file = job_dir / "chemex.log"
        snapshots = []
        orig = Path.replace

        def spy(self, target):
            if Path(target).name == "progress.json":
                snapshots.append(json.loads(Path(self).read_text()))
            return orig(self, target)

        Path.replace = spy
        try:
            wait_for_job(
                launcher=FakeLauncher([JobState.RUNNING, JobState.DONE]),
                handle=JobHandle(launcher="fake", id="f2", job_dir=str(job_dir)),
                log_file=log_file,
                poll_interval=0.01,
            )
        finally:
            Path.replace = orig

        steps_seen = [(s.get("step") or {}).get("name") for s in snapshots if s.get("kind") in ("step", "fit")]
        assert "GLOBAL_FIT" in steps_seen and "LOCAL_FITS" in steps_seen
        # Both step changes are written even though they arrive within the 250 ms throttle window.
        assert [s["step"]["name"] for s in snapshots if s.get("kind") == "step"] == ["GLOBAL_FIT", "LOCAL_FITS"]
        assert snapshots[-1]["kind"] == "completed"
        log_text = log_file.read_text()
        assert "Step 1/2: GLOBAL_FIT" in log_text and "Step 2/2: LOCAL_FITS" in log_text

        # Per-step wall-clock durations for the next run's estimates.
        timings = json.loads((job_dir / "step_timings.json").read_text())
        assert timings["state"] == "DONE"
        g, l = timings["steps"]
        assert (g["name"], g["seconds"], g["grid_points"]) == ("GLOBAL_FIT", 100.0, None)
        assert l["name"] == "LOCAL_FITS" and l["grid_points"] == 12 and l["seconds"] is not None and not l.get("incomplete")
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)
