import os
import tempfile
from pathlib import Path
from app.services.path_utils import (
    to_container_path,
    to_host_path,
    find_existing_path,
    check_path_exists,
    resolve_existing_path,
    get_extra_mount_pairs,
)


def test_path_utils_direct_existing():
    with tempfile.NamedTemporaryFile() as tmp:
        p = tmp.name
        assert check_path_exists(p) is True
        assert find_existing_path(p) == str(Path(p).resolve())
        assert resolve_existing_path(p) == str(Path(p).resolve())


def test_path_utils_nonexistent():
    fake_path = "/nonexistent/path/to/some/file.json"
    assert check_path_exists(fake_path) is False
    assert find_existing_path(fake_path) is None
    # resolve_existing_path returns fallback
    assert resolve_existing_path(fake_path) is not None


def test_path_utils_extra_mounts(monkeypatch, tmp_path):
    host_dir = tmp_path / "host_data"
    container_dir = tmp_path / "container_data"
    host_dir.mkdir()
    container_dir.mkdir()

    # Create a file in container_dir
    test_file = container_dir / "spectrum.ft2"
    test_file.write_text("dummy")

    # Set RESOFLOW_EXTRA_MOUNTS: host_dir:container_dir
    monkeypatch.setenv("RESOFLOW_EXTRA_MOUNTS", f"{host_dir}:{container_dir}")

    # Query with host path, expecting it to find it at container path
    query_host_path = str(host_dir / "spectrum.ft2")
    assert check_path_exists(query_host_path) is True
    found = find_existing_path(query_host_path)
    assert found == str(test_file.resolve())


def test_path_utils_base_dir(tmp_path):
    project_dir = tmp_path / "my_project"
    project_dir.mkdir()
    results_file = project_dir / "results.json"
    results_file.write_text("{}")

    # Path from another machine
    foreign_path = "/old/server/path/results.json"
    assert check_path_exists(foreign_path, base_dir=str(project_dir)) is True
    assert find_existing_path(foreign_path, base_dir=str(project_dir)) == str(results_file.resolve())


def test_path_utils_projects_extra_swap(tmp_path, monkeypatch):
    extra_dir = tmp_path / "extra" / "Documents" / "test"
    extra_dir.mkdir(parents=True)
    target_file = extra_dir / "target.ft2"
    target_file.write_text("data")

    # Mock host data root / container data root mapping
    monkeypatch.setenv("RESOFLOW_HOST_DATA_ROOT", str(tmp_path))
    monkeypatch.setenv("RESOFLOW_CONTAINER_DATA_ROOT", "/data/projects")
    monkeypatch.setenv("RESOFLOW_EXTRA_MOUNTS", f"{tmp_path / 'extra'}:/data/extra")

    legacy_path = "/data/projects/Documents/test/target.ft2"
    # Should resolve via extra mount to host or container
    found = find_existing_path(legacy_path)
    assert found is not None
    assert Path(found).name == "target.ft2"

