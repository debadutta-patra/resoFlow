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
