"""Unit tests for filesystem API security and path traversal prevention."""

import os
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from app.main import app
from app.routers.fs import _sanitize_path, _is_sensitive_path


def _only_root(monkeypatch, root):
    """Pin the explorer's permitted roots to `root` for one test."""
    monkeypatch.delenv("RESOFLOW_CONTAINER_DATA_ROOT", raising=False)
    monkeypatch.delenv("RESOFLOW_EXTRA_BROWSE_ROOTS", raising=False)
    monkeypatch.delenv("RESOFLOW_HOST_DATA_ROOT", raising=False)
    monkeypatch.setenv("PROJECTS_STORAGE_PATH", str(root))


def test_sanitize_path_normalization(monkeypatch):
    """Verify paths are resolved and null bytes are rejected."""
    for var in ("PROJECTS_STORAGE_PATH", "RESOFLOW_CONTAINER_DATA_ROOT",
                "RESOFLOW_EXTRA_BROWSE_ROOTS"):
        monkeypatch.delenv(var, raising=False)

    home = os.path.expanduser("~")
    assert _sanitize_path("~") == home

    with pytest.raises(Exception):
        _sanitize_path("/tmp/test\0file")


def test_sanitize_path_rejects_empty():
    """An empty path must be refused, not resolved to the process CWD.

    Path("").resolve() yields the API working directory (/app in the container),
    which is on the container overlay rather than the host bind mount -- so a
    mkdir there would report success and be invisible on the host.
    """
    for blank in ("", "   ", "\t"):
        with pytest.raises(HTTPException) as exc:
            _sanitize_path(blank)
        assert exc.value.status_code == 400


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

    result = browse_filesystem(path=None, current_user=mock_user)
    names = [item.name for item in result.items]
    assert "project_a" in names
    # The resolved directory is echoed back so the client can target it.
    assert result.path == str(test_storage.resolve())


def test_mkdir_rejects_empty_path(tmp_path, monkeypatch):
    """mkdir with no path must 400 rather than write into the process CWD."""
    from app.routers.fs import create_directory, MkdirRequest
    from app.models import User

    monkeypatch.chdir(tmp_path)
    mock_user = User(id=1, email="test@lab.org", is_active=True)

    with pytest.raises(HTTPException) as exc:
        create_directory(MkdirRequest(path="", name="new_folder"), current_user=mock_user)
    assert exc.value.status_code == 400
    assert not (tmp_path / "new_folder").exists()


def test_mkdir_creates_in_browsed_directory(tmp_path, monkeypatch):
    """The path browse reports is usable as-is for mkdir, and lands on disk."""
    from app.routers.fs import browse_filesystem, create_directory, MkdirRequest
    from app.models import User

    test_storage = tmp_path / "custom_projects"
    test_storage.mkdir()
    monkeypatch.setenv("PROJECTS_STORAGE_PATH", str(test_storage))
    monkeypatch.chdir(tmp_path)
    mock_user = User(id=1, email="test@lab.org", is_active=True)

    browsed = browse_filesystem(path=None, current_user=mock_user)
    response = create_directory(
        MkdirRequest(path=browsed.path, name="new_folder"), current_user=mock_user
    )

    created = test_storage / "new_folder"
    assert created.is_dir()
    assert response["path"] == str(created.resolve())
    # Not stranded in the working directory.
    assert not (tmp_path / "new_folder").exists()


# --- Containment to permitted roots -------------------------------------


def test_sanitize_path_rejects_outside_roots(tmp_path, monkeypatch):
    """A readable path outside every permitted root is refused."""
    root = tmp_path / "projects"
    root.mkdir()
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    _only_root(monkeypatch, root)

    assert _sanitize_path(str(root)) == str(root.resolve())

    with pytest.raises(HTTPException) as exc:
        _sanitize_path(str(outside))
    assert exc.value.status_code == 403


def test_sanitize_path_blocks_symlink_escape(tmp_path, monkeypatch):
    """A symlink inside a root may not lead out of it."""
    root = tmp_path / "projects"
    root.mkdir()
    secret = tmp_path / "outside_secrets"
    secret.mkdir()
    (root / "escape").symlink_to(secret, target_is_directory=True)
    _only_root(monkeypatch, root)

    with pytest.raises(HTTPException) as exc:
        _sanitize_path(str(root / "escape"))
    assert exc.value.status_code == 403


def test_extra_browse_roots_are_honoured(tmp_path, monkeypatch):
    """RESOFLOW_EXTRA_BROWSE_ROOTS widens the permitted set."""
    root = tmp_path / "projects"
    root.mkdir()
    spectra = tmp_path / "spectra"
    spectra.mkdir()
    _only_root(monkeypatch, root)

    with pytest.raises(HTTPException):
        _sanitize_path(str(spectra))

    monkeypatch.setenv("RESOFLOW_EXTRA_BROWSE_ROOTS", str(spectra))
    assert _sanitize_path(str(spectra)) == str(spectra.resolve())


def test_nonexistent_configured_root_falls_back_to_home(tmp_path, monkeypatch):
    """A misconfigured root must not lock the explorer out completely."""
    _only_root(monkeypatch, tmp_path / "does_not_exist")
    home = os.path.expanduser("~")
    assert _sanitize_path(home) == str(Path(home).resolve())


def test_browse_omits_parent_entry_at_root(tmp_path, monkeypatch):
    """`..` is not offered when it would step outside the permitted roots."""
    from app.routers.fs import browse_filesystem
    from app.models import User

    root = tmp_path / "projects"
    root.mkdir()
    (root / "child").mkdir()
    _only_root(monkeypatch, root)
    mock_user = User(id=1, email="test@lab.org", is_active=True)

    at_root = browse_filesystem(path=str(root), current_user=mock_user)
    assert ".." not in [item.name for item in at_root.items]

    inside = browse_filesystem(path=str(root / "child"), current_user=mock_user)
    assert ".." in [item.name for item in inside.items]


# --- /read limits --------------------------------------------------------


def test_read_rejects_oversized_file(tmp_path, monkeypatch):
    """Files past the preview cap are refused rather than loaded into memory."""
    from app.routers.fs import read_file_content, MAX_READ_BYTES
    from app.models import User

    _only_root(monkeypatch, tmp_path)
    big = tmp_path / "huge.txt"
    big.write_bytes(b"a" * (MAX_READ_BYTES + 1))
    mock_user = User(id=1, email="test@lab.org", is_active=True)

    with pytest.raises(HTTPException) as exc:
        read_file_content(path=str(big), current_user=mock_user)
    assert exc.value.status_code == 413


def test_read_rejects_binary_file(tmp_path, monkeypatch):
    """Binary content is refused instead of returned as replacement chars."""
    from app.routers.fs import read_file_content
    from app.models import User

    _only_root(monkeypatch, tmp_path)
    binary = tmp_path / "spectrum.ft2"
    binary.write_bytes(b"\x00\x01\x02\x03" * 64)
    mock_user = User(id=1, email="test@lab.org", is_active=True)

    with pytest.raises(HTTPException) as exc:
        read_file_content(path=str(binary), current_user=mock_user)
    assert exc.value.status_code == 415


def test_read_returns_text_file(tmp_path, monkeypatch):
    """The ordinary case still works."""
    from app.routers.fs import read_file_content
    from app.models import User

    _only_root(monkeypatch, tmp_path)
    toml = tmp_path / "method.toml"
    toml.write_text("[fit]\nmodel = \"2st\"\n")
    mock_user = User(id=1, email="test@lab.org", is_active=True)

    result = read_file_content(path=str(toml), current_user=mock_user)
    assert result["content"] == '[fit]\nmodel = "2st"\n'
    assert result["path"] == str(toml.resolve())


# --- Listing metadata ----------------------------------------------------


def _browse(path, monkeypatch=None):
    from app.routers.fs import browse_filesystem
    from app.models import User

    return browse_filesystem(
        path=str(path), current_user=User(id=1, email="test@lab.org", is_active=True)
    )


def test_listing_carries_size_and_mtime(tmp_path, monkeypatch):
    """Files report a size and mtime; directories report neither size."""
    _only_root(monkeypatch, tmp_path)
    (tmp_path / "sub").mkdir()
    (tmp_path / "peaks.tsv").write_text("a\tb\n" * 10)

    by_name = {item.name: item for item in _browse(tmp_path).items}

    assert by_name["peaks.tsv"].size == len("a\tb\n" * 10)
    assert by_name["peaks.tsv"].modified is not None
    assert by_name["sub"].is_dir is True
    assert by_name["sub"].size is None
    assert by_name["sub"].modified is not None


def test_listing_still_skips_hidden_entries(tmp_path, monkeypatch):
    """The scandir rewrite must keep hiding dotfiles."""
    _only_root(monkeypatch, tmp_path)
    (tmp_path / ".hidden").write_text("x")
    (tmp_path / "visible.toml").write_text("x")

    names = [item.name for item in _browse(tmp_path).items]
    assert "visible.toml" in names
    assert ".hidden" not in names


def test_broken_symlink_is_flagged_not_fatal(tmp_path, monkeypatch):
    """A dangling symlink is listed without metadata rather than 500ing."""
    _only_root(monkeypatch, tmp_path)
    (tmp_path / "dangling").symlink_to(tmp_path / "no_such_target")
    (tmp_path / "real.toml").write_text("x")

    by_name = {item.name: item for item in _browse(tmp_path).items}

    assert by_name["dangling"].is_symlink is True
    assert by_name["dangling"].size is None
    assert by_name["dangling"].modified is None
    # The rest of the listing survives.
    assert by_name["real.toml"].modified is not None


# --- Host-facing display paths -------------------------------------------


def test_display_path_maps_to_host_spelling(tmp_path, monkeypatch):
    """Entries carry the host spelling for display, canonical path unchanged."""
    monkeypatch.delenv("PROJECTS_STORAGE_PATH", raising=False)
    monkeypatch.delenv("RESOFLOW_EXTRA_BROWSE_ROOTS", raising=False)
    monkeypatch.setenv("RESOFLOW_CONTAINER_DATA_ROOT", str(tmp_path))
    monkeypatch.setenv("RESOFLOW_HOST_DATA_ROOT", "/home/lab/resoflow_data")
    (tmp_path / "project_a").mkdir()

    result = _browse(tmp_path)
    assert result.display_path == "/home/lab/resoflow_data"

    # The quick-access label follows the host spelling, not the container one.
    assert [r.name for r in result.roots] == ["resoflow_data"]
    assert result.roots[0].display_path == "/home/lab/resoflow_data"

    entry = next(i for i in result.items if i.name == "project_a")
    # Canonical path stays in this environment's space...
    assert entry.path == str((tmp_path / "project_a").resolve())
    # ...while display shows what the user would see on their own machine.
    assert entry.display_path == "/home/lab/resoflow_data/project_a"


def test_display_path_is_identity_without_mapping(tmp_path, monkeypatch):
    """With no host mapping configured, display equals the canonical path."""
    _only_root(monkeypatch, tmp_path)
    (tmp_path / "project_a").mkdir()

    result = _browse(tmp_path)
    assert result.display_path == result.path
    for item in result.items:
        assert item.display_path == item.path


def test_browse_reports_permitted_roots(tmp_path, monkeypatch):
    """Roots come back so the client can offer quick access and trim crumbs."""
    monkeypatch.delenv("PROJECTS_STORAGE_PATH", raising=False)
    monkeypatch.delenv("RESOFLOW_HOST_DATA_ROOT", raising=False)
    data = tmp_path / "projects"
    data.mkdir()
    spectra = tmp_path / "spectra"
    spectra.mkdir()
    monkeypatch.setenv("RESOFLOW_CONTAINER_DATA_ROOT", str(data))
    monkeypatch.setenv("RESOFLOW_EXTRA_BROWSE_ROOTS", str(spectra))

    result = _browse(data)
    by_name = {r.name: r for r in result.roots}

    assert set(by_name) == {"projects", "spectra"}
    assert by_name["projects"].path == str(data.resolve())
    # Without a host mapping, display mirrors the canonical path.
    assert by_name["spectra"].display_path == str(spectra.resolve())
