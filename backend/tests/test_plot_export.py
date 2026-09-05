"""
Comprehensive test suite for high-resolution plot export in ZIP archives.
Tests 300 DPI PNG and vector PDF generation, color palette theming,
directory layout (single-step and multi-step), and ZIP integrity.
"""

import io
import zipfile
from pathlib import Path
import pytest

from app.services.export.plot_export import export_all_plots_zip

FIXTURES_ROOT = Path(__file__).parent / "fixtures" / "chemex_trees"


class TestPlotExport:
    """Test suite for high-resolution plot export."""

    def test_single_step_plot_export_png_and_pdf(self, tmp_path):
        """Test single-step analysis generates 300 DPI PNGs, vector PDFs, and README."""
        fixture_dir = FIXTURES_ROOT / "single_step"
        assert fixture_dir.is_dir()

        out_zip_file = tmp_path / "test_plots.zip"

        zip_buf = export_all_plots_zip(
            analysis_dir=fixture_dir,
            analysis_name="test_single_analysis",
            analysis_type="CEST",
            palette="emerald_green",
            style="publication",
            output_path=out_zip_file,
        )
        zip_bytes = zip_buf.getvalue()

        assert out_zip_file.exists()
        assert len(zip_bytes) > 0
        assert out_zip_file.stat().st_size == len(zip_bytes)

        # Inspect ZIP contents
        with zipfile.ZipFile(io.BytesIO(zip_bytes), "r") as archive:
            namelist = archive.namelist()

            # Verify README
            readme_path = [n for n in namelist if n.endswith("README.txt")]
            assert len(readme_path) == 1
            readme_content = archive.read(readme_path[0]).decode("utf-8")
            assert "test_single_analysis" in readme_content
            assert "emerald_green" in readme_content
            assert "300 DPI" in readme_content

            # Verify PNG and PDF entries exist
            png_files = [n for n in namelist if n.endswith(".png")]
            pdf_files = [n for n in namelist if n.endswith(".pdf")]

            assert len(png_files) > 0, "No PNG files generated"
            assert len(pdf_files) > 0, "No PDF files generated"
            assert len(png_files) == len(pdf_files), "Mismatch between PNG and PDF counts"

            # Check magic bytes for PNG and PDF
            first_png = archive.read(png_files[0])
            assert first_png.startswith(b"\x89PNG\r\n\x1a\n"), "Invalid PNG header"

            first_pdf = archive.read(pdf_files[0])
            assert first_pdf.startswith(b"%PDF"), "Invalid PDF header"

            # Check directory structure
            has_detailed_png = any("png/residues/detailed" in n for n in png_files)
            has_detailed_pdf = any("pdf/residues/detailed" in n for n in pdf_files)
            assert has_detailed_png
            assert has_detailed_pdf

    def test_custom_hex_palette_plot_export(self, tmp_path):
        """Test custom hex color code works seamlessly without error."""
        fixture_dir = FIXTURES_ROOT / "single_step"
        assert fixture_dir.is_dir()

        zip_buf = export_all_plots_zip(
            analysis_dir=fixture_dir,
            analysis_name="custom_hex_analysis",
            analysis_type="CEST",
            palette="#E11D48",
            style="publication",
        )
        zip_bytes = zip_buf.getvalue()

        with zipfile.ZipFile(io.BytesIO(zip_bytes), "r") as archive:
            namelist = archive.namelist()
            readme_path = [n for n in namelist if n.endswith("README.txt")][0]
            assert readme_path
            readme_content = archive.read(readme_path).decode("utf-8")
            assert "#E11D48" in readme_content

    def test_multi_step_plot_export_partitioning(self, tmp_path):
        """Test multi-step analysis generates clean per-step folders for PNG and PDF."""
        fixture_dir = FIXTURES_ROOT / "multi_step"
        assert fixture_dir.is_dir()

        zip_buf = export_all_plots_zip(
            analysis_dir=fixture_dir,
            analysis_name="test_multi_analysis",
            analysis_type="CEST",
            palette="okabe_ito",
            style="publication",
        )
        zip_bytes = zip_buf.getvalue()

        with zipfile.ZipFile(io.BytesIO(zip_bytes), "r") as archive:
            namelist = archive.namelist()

            # Should contain step folders like png/step_.../
            step_pngs = [n for n in namelist if "png/step_" in n]
            step_pdfs = [n for n in namelist if "pdf/step_" in n]

            assert len(step_pngs) > 0, "No multi-step PNG files found"
            assert len(step_pdfs) > 0, "No multi-step PDF files found"
            assert len(step_pngs) == len(step_pdfs)

    def test_export_plots_zip_task(self, tmp_path):
        """Test celery task export_plots_zip_task with mocked db analysis model."""
        from unittest.mock import MagicMock
        from app.services.reporting.tasks import export_plots_zip_task

        fixture_dir = FIXTURES_ROOT / "single_step"
        assert fixture_dir.is_dir()

        mock_project = MagicMock()
        mock_project.local_directory_path = str(tmp_path)

        mock_analysis = MagicMock()
        mock_analysis.analysis_uuid = "test-analysis-task-uuid"
        mock_analysis.name = "task_analysis"
        mock_analysis.analysis_type = "CEST"
        mock_analysis.results_path = str(fixture_dir / "Output")
        mock_analysis.project = mock_project
        mock_analysis.chemex_image_digest = None

        mock_db = MagicMock()
        mock_db.query.return_value.filter.return_value.first.return_value = mock_analysis

        res = export_plots_zip_task(
            analysis_uuid="test-analysis-task-uuid",
            palette="crimson_rose",
            style="publication",
            db=mock_db,
        )

        assert res["status"] == "COMPLETED"
        assert res["analysis_uuid"] == "test-analysis-task-uuid"
        assert res["palette"] == "crimson_rose"
        assert Path(res["zip_path"]).is_file()
        assert res["size_bytes"] > 0

    def test_plots_export_token_generation_and_verification(self):
        """Test token generation with palette options and validation."""
        from app.services.export.zip_export import generate_export_token, verify_export_token

        p_uuid = "test-proj-789"
        a_uuid = "test-analysis-789"
        user_id = 42
        opts = {"palette": "#10B981", "style": "publication"}

        token = generate_export_token(p_uuid, a_uuid, user_id, options=opts, validity_seconds=120)
        assert isinstance(token, str)

        valid, token_opts, err = verify_export_token(token, p_uuid, a_uuid)
        assert valid is True
        assert token_opts == opts
        assert err == ""

    def test_render_or_serve_plots_zip_helper(self, tmp_path):
        """Test _render_or_serve_plots_zip returns FileResponse or StreamingResponse without NameError."""
        from unittest.mock import MagicMock
        from app.routers.analysis import _render_or_serve_plots_zip

        fixture_dir = FIXTURES_ROOT / "single_step"
        assert fixture_dir.is_dir()

        mock_project = MagicMock()
        mock_project.local_directory_path = str(tmp_path)

        mock_analysis = MagicMock()
        mock_analysis.analysis_uuid = "test-serve-uuid"
        mock_analysis.name = "Special Analysis 100%"
        mock_analysis.analysis_type = "CEST"
        mock_analysis.results_path = str(fixture_dir)
        mock_analysis.project = mock_project
        mock_analysis.chemex_image_digest = None

        response = _render_or_serve_plots_zip(mock_analysis, palette="emerald_green", style="publication")
        assert response.status_code == 200
        assert response.media_type == "application/zip"


