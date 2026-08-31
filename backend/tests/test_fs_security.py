"""Unit tests for filesystem API security and path traversal prevention."""

import os
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.routers.fs import _sanitize_path, _is_sensitive_path


def test_sanitize_path_normalization():
    """Verify paths are resolved and null bytes are rejected."""
    home = os.path.expanduser("~")
    assert _sanitize_path("~") == home

    with pytest.raises(Exception):
        _sanitize_path("/tmp/test\0file")


def test_sensitive_path_detection():
    """Verify sensitive system files and credentials are recognized."""
    assert _is_sensitive_path("/etc/shadow") is True
    assert _is_sensitive_path("/proc/1/cmdline") is True
    assert _is_sensitive_path("/sys/kernel/debug") is True
    assert _is_sensitive_path("/home/user/.config/resoflow/resoflow.env") is True
    assert _is_sensitive_path("/home/user/.ssh/id_rsa") is True

    # Benign paths should pass
    assert _is_sensitive_path("/home/user/my_nmr_project/parameters.toml") is False
    assert _is_sensitive_path("/data/projects/proj1/cpmg_fitting") is False


def test_browse_filesystem_default_storage(tmp_path, monkeypatch):
    """Verify browse_filesystem defaults to PROJECTS_STORAGE_PATH when path is None."""
    from app.routers.fs import browse_filesystem
    from app.models import User

    test_storage = tmp_path / "custom_projects"
    test_storage.mkdir()
    (test_storage / "project_a").mkdir()

    monkeypatch.setenv("PROJECTS_STORAGE_PATH", str(test_storage))
    mock_user = User(id=1, email="test@lab.org", is_active=True)

    items = browse_filesystem(path=None, current_user=mock_user)
    names = [item.name for item in items]
    assert "project_a" in names

