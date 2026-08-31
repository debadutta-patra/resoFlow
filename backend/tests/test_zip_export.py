"""
Comprehensive test suite for streamed deterministic ZIP export (Phase 10).
Tests token signing, single-use consumption, archive streaming, MANIFEST verification,
and byte-identical deterministic reproducibility.
"""

import hashlib
import io
import json
import time
import zipfile
from pathlib import Path
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services.export.zip_export import (
    generate_export_token,
    verify_export_token,
    stream_analysis_zip,
)

FIXTURES_ROOT = Path(__file__).parent / "fixtures" / "chemex_trees"


class TestZipExport:
    """Test suite for ZIP export generator and authentication tokens."""

    def test_export_token_lifecycle(self):
        """Test token creation, successful verification, and single-use consumption."""
        p_uuid = "proj-123"
        a_uuid = "analysis-456"
        user_id = 1
        opts = {"include_data": True, "style": "publication"}

        token = generate_export_token(p_uuid, a_uuid, user_id, options=opts, validity_seconds=60)
        assert isinstance(token, str) and "." in token

        # 1. First verification should succeed
        valid, token_opts, err = verify_export_token(token, p_uuid, a_uuid)
        assert valid is True
        assert token_opts == opts
        assert err == ""

        # 2. Replay of consumed token must fail
        valid_again, _, err_again = verify_export_token(token, p_uuid, a_uuid)
        assert valid_again is False
        assert "already used" in err_again

    def test_export_token_tampering_and_mismatch(self):
        """Test that tampered tokens or mismatched IDs are rejected."""
        p_uuid = "proj-123"
        a_uuid = "analysis-456"
        token = generate_export_token(p_uuid, a_uuid, user_id=1, validity_seconds=60)

        # Mismatched analysis UUID
        valid, _, err = verify_export_token(token, p_uuid, "wrong-analysis")
        assert valid is False

        # Tampered token
        tampered = token[:-4] + "abcd"
        valid, _, err = verify_export_token(tampered, p_uuid, a_uuid)
        assert valid is False
        assert "signature" in err.lower()

    def test_export_token_expiration(self):
        """Test that expired tokens are rejected."""
        p_uuid = "proj-123"
        a_uuid = "analysis-456"
        token = generate_export_token(p_uuid, a_uuid, user_id=1, validity_seconds=-5)

        valid, _, err = verify_export_token(token, p_uuid, a_uuid)
        assert valid is False
        assert "expired" in err.lower()

    def test_streaming_zip_generation_and_manifest(self):
        """Test that stream_analysis_zip produces a valid archive with verified MANIFEST.json."""
        fixture_dir = FIXTURES_ROOT / "cest_step_grid"
        assert fixture_dir.is_dir()

        chunks = list(stream_analysis_zip(
            analysis_dir=fixture_dir,
            analysis_name="test_cest",
            analysis_type="CEST",
            include_data=True,
            include_plots=True,
            include_statistics=True,
        ))

        zip_bytes = b"".join(chunks)
        assert len(zip_bytes) > 10000

        # Open and inspect archive
        archive = zipfile.ZipFile(io.BytesIO(zip_bytes))
        namelist = archive.namelist()

        # Find root folder
        root_name = namelist[0].split("/")[0]
        assert "resoflow_test_cest" in root_name

        # Verify required core files exist
        assert f"{root_name}/MANIFEST.json" in namelist
        assert f"{root_name}/README.txt" in namelist
        assert f"{root_name}/report.pdf" in namelist
        assert f"{root_name}/fitted_parameters.csv" in namelist
        assert f"{root_name}/fitted_parameters.json" in namelist
        assert f"{root_name}/derived_kinetics.csv" in namelist
        assert any(n.startswith(f"{root_name}/inputs/") for n in namelist)
        assert any(n.startswith(f"{root_name}/chemex_output/") for n in namelist)

        # Cryptographic verification against MANIFEST.json
        manifest_data = json.loads(archive.read(f"{root_name}/MANIFEST.json").decode("utf-8"))
        assert "files" in manifest_data

        for rel_path, expected_sha in manifest_data["files"].items():
            full_arch_path = f"{root_name}/{rel_path}"
            assert full_arch_path in namelist, f"Manifest entry {full_arch_path} missing in archive"
            file_bytes = archive.read(full_arch_path)
            actual_sha = hashlib.sha256(file_bytes).hexdigest()
            assert actual_sha == expected_sha, f"SHA-256 mismatch for {rel_path}"

    def test_deterministic_reproducibility(self):
        """
        Verify that streaming the ZIP archive twice over unchanged inputs produces
        100% byte-identical archives.
        """
        fixture_dir = FIXTURES_ROOT / "cest_step_grid"

        zip1 = b"".join(stream_analysis_zip(
            analysis_dir=fixture_dir,
            analysis_name="test_cest",
            analysis_type="CEST",
        ))

        zip2 = b"".join(stream_analysis_zip(
            analysis_dir=fixture_dir,
            analysis_name="test_cest",
            analysis_type="CEST",
        ))

        # Assert byte-for-byte identity
        assert len(zip1) == len(zip2)
        assert zip1 == zip2
        assert hashlib.sha256(zip1).hexdigest() == hashlib.sha256(zip2).hexdigest()
