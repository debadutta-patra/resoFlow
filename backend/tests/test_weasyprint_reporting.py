# backend/tests/test_weasyprint_reporting.py
"""
Structural and template tests for WeasyPrint reporting pipeline per Phase C.
Validates:
1. Structural PDF assertions (outlines, text extraction, no rendering errors).
2. Cross-reference pagination (resolves to real page numbers, not p. 0).
3. Repeating index table headers across multi-page index tables (50+ residues).
4. StrictUndefined template smoke tests with None/empty edge cases.
"""

from __future__ import annotations

import io
from pathlib import Path
import jinja2
import numpy as np
import pypdf
import pytest

from app.services.reporting.formatting import format_with_error
from app.services.reporting.model import (
    ReportModel,
    ResidueRecord,
    build_report_model,
)
from app.services.reporting.provenance import (
    DegreeOfFreedomAccounting,
    ReportProvenance,
)
from app.services.reporting.render import (
    build_index_data,
    build_provenance_data,
    build_summary_data,
    create_jinja_env,
    render_weasy_pdf,
    render_html,
    render_pdf,
    stitch_pdf_report,
)
from app.services.reporting.report_generator import generate_modern_pdf_report
from app.services.reporting.uncertainty import (
    ParameterStatus,
    ResolvedParameter,
    UncertaintySource,
)


def test_html_format_with_error():
    """Verify format_with_error produces expected HTML spans and sub/superscripts."""
    param = ResolvedParameter(
        name="kex_ab",
        scope="global",
        status=ParameterStatus.FITTED,
        value=500.0,
        err_low=25.0,
        err_high=25.0,
        source=UncertaintySource.RESAMPLED,
        unit="s⁻¹",
    )
    html = format_with_error(param, style="html")
    assert '<span class="v">500</span>' in html
    assert '<span class="pm">&plusmn;25</span>' in html
    assert '<sup>ᵐ</sup>' in html
    assert 's⁻¹' in html

    # Asymmetric error
    param_asym = ResolvedParameter(
        name="pb",
        scope="global",
        status=ParameterStatus.FITTED,
        value=5.0,
        err_low=0.4,
        err_high=0.8,
        source=UncertaintySource.GRID,
        unit="%",
    )
    html_asym = format_with_error(param_asym, style="html")
    assert '<span class="v">5.0</span>' in html_asym
    assert '<sup>+0.8</sup>' in html_asym
    assert '<sub>&minus;0.4</sub>' in html_asym
    assert '<sup>ᵍ</sup>' in html_asym


def test_structural_pdf_assertions_single_step():
    """Assert PDF outline, residue anchors in extracted text, and no error messages."""
    fixture_dir = Path(__file__).parent / "fixtures" / "chemex_trees" / "single_step"
    pdf_buf = generate_modern_pdf_report(fixture_dir, "Single Step Verification")

    reader = pypdf.PdfReader(pdf_buf)
    assert len(reader.pages) >= 3

    # 1. Structural outline check (supports hierarchical WeasyPrint bookmark levels)
    assert reader.outline is not None
    def count_outline_nodes(nodes):
        count = 0
        for node in nodes:
            if isinstance(node, list):
                count += count_outline_nodes(node)
            else:
                count += 1
        return count

    total_outline_items = count_outline_nodes(reader.outline)
    assert total_outline_items >= 8

    # 2. Extract full text from all pages
    all_text = ""
    for page in reader.pages:
        all_text += page.extract_text() + "\n"

    # 3. Assert no error strings
    assert "Error rendering page" not in all_text

    # 4. Check for anchor text in extracted pages
    model = build_report_model(fixture_dir, "Single Step Verification")
    for r in model.residues:
        assert r.anchor in all_text


def test_multi_page_index_header_repeats_and_cross_ref():
    """
    Render synthetic 60-residue model (50+ residues requirement).
    Assert that the index table header repeats on every page it spans,
    and cross-references resolve to real page numbers (not p. 0 or p. ).
    """
    residues = []
    for i in range(1, 61):
        res_name = f"{i}N"
        r_rec = ResidueRecord(
            raw_key=res_name,
            display_name=res_name,
            chi2_red=1.05,
            dw=ResolvedParameter(f"dw_{res_name}", res_name, 2.5, 0.1, 0.1, source=UncertaintySource.COVARIANCE),
            r1a=ResolvedParameter(f"r1a_{res_name}", res_name, 1.8, 0.05, 0.05, source=UncertaintySource.COVARIANCE),
            r2a=ResolvedParameter(f"r2a_{res_name}", res_name, 8.5, 0.3, 0.3, source=UncertaintySource.COVARIANCE),
            r2b=ResolvedParameter(f"r2b_{res_name}", res_name, 8.5, 0.3, 0.3, source=UncertaintySource.COVARIANCE),
            csa=ResolvedParameter(f"csa_{res_name}", res_name, 118.0),
            csb=ResolvedParameter(f"csb_{res_name}", res_name, 120.5),
            flags=["χ²ᵣ=2.50"] if i % 10 == 0 else [],
            experiments=[],
        )
        residues.append(r_rec)

    dof = DegreeOfFreedomAccounting(
        n_data_global=1200,
        n_global_params=2,
        n_local_params_total=240,
        n_varys_global=242,
        dof_global=958,
        chi2_global=1005.0,
        chi2_red_global=1.05,
    )
    prov = ReportProvenance(
        timestamp_iso="2026-09-04T12:00:00Z",
        resoflow_version="2026.2.0",
        git_sha="test",
        chemex_version="2026.6.1",
        chemex_image_digest="sha256:abc",
        analysis_name="Synthetic 60-Residue Analysis",
        analysis_uuid="test-uuid",
        analysis_type="CEST",
        model_name="2ST",
        minimizer="leastsq",
        convergence_status="CONVERGED",
        b0_fields=["800 MHz"],
        temperature_k=298.15,
        carrier_ppm=119.0,
        b1_fields=[],
        input_files=[],
        dof_accounting=dof,
        delta_omega_convention="omega_B - omega_A",
        uncertainty_sources_used=["COVARIANCE"],
        has_statistics_runs=False,
    )

    model = ReportModel(
        analysis_name="Synthetic 60-Residue Analysis",
        analysis_type="CEST",
        analysis_dir=Path("/tmp"),
        results={},
        provenance=prov,
        derived_kinetics={},
        residues=residues,
        global_params=[
            ("kex_ab", ResolvedParameter("kex_ab", "global", 500.0, 25.0, 25.0, source=UncertaintySource.COVARIANCE, unit="s⁻¹")),
            ("pb", ResolvedParameter("pb", "global", 5.0, 0.2, 0.2, source=UncertaintySource.COVARIANCE, unit="%")),
        ],
        resampled={},
        grid_1d={},
        ledger={"COVARIANCE": 242},
    )

    summary_data = build_summary_data(model)
    index_data = build_index_data(model, front_pages=3)
    ctx_front = {
        "model": model,
        "summary_data": summary_data,
        "index_data": index_data,
        "style": "publication",
    }
    pdf_bytes = render_weasy_pdf("front.html", ctx_front)
    reader = pypdf.PdfReader(io.BytesIO(pdf_bytes))

    # Should span multiple pages (1 summary + 2 index pages = 3 pages)
    assert len(reader.pages) >= 3

    # Check page 2 and page 3 both have the repeated index table header
    page2_text = reader.pages[1].extract_text()
    page3_text = reader.pages[2].extract_text()
    assert "Residue Results Index" in page2_text or "Residue Red. χ²" in page2_text
    assert "Residue Red. χ²" in page3_text

    # Verify cross-reference pagination resolves to real page numbers (not 'p. 0' or 'p. ')
    for p in reader.pages[1:]:
        t = p.extract_text()
        assert "p. 0" not in t
        assert "p. \n" not in t
        # Cross reference exists
        assert "p. " in t


def test_template_smoke_strict_undefined():
    """
    Template smoke test: Verify that undefined context keys fail loudly with StrictUndefined
    rather than rendering empty blanks.
    """
    env = create_jinja_env()
    tpl = env.from_string("<div>{{ missing_var.foo }}</div>")
    with pytest.raises(jinja2.UndefinedError):
        tpl.render()


def test_smoke_zero_residues_and_empty_caches():
    """
    Test rendering when model has 0 residues, empty grid cache, and no statistics runs.
    Ensures templates render cleanly without crash or blank error artifacts.
    """
    dof = DegreeOfFreedomAccounting(
        n_data_global=0,
        n_global_params=0,
        n_local_params_total=0,
        n_varys_global=0,
        dof_global=0,
        chi2_global=0.0,
        chi2_red_global=0.0,
    )
    prov = ReportProvenance(
        timestamp_iso="2026-09-04T12:00:00Z",
        resoflow_version="2026.2.0",
        git_sha="test",
        chemex_version="2026.6.1",
        chemex_image_digest="sha256:abc",
        analysis_name="Empty Model Test",
        analysis_uuid="empty-uuid",
        analysis_type="CEST",
        model_name="2ST",
        minimizer="leastsq",
        convergence_status="CONVERGED",
        b0_fields=[],
        temperature_k=None,
        carrier_ppm=None,
        b1_fields=[],
        input_files=[],
        dof_accounting=dof,
        delta_omega_convention="omega_B - omega_A",
        uncertainty_sources_used=["COVARIANCE"],
        has_statistics_runs=False,
    )

    model = ReportModel(
        analysis_name="Empty Model Test",
        analysis_type="CEST",
        analysis_dir=Path("/tmp"),
        results={},
        provenance=prov,
        derived_kinetics={},
        residues=[],
        global_params=[],
        resampled={},
        grid_1d={},
        ledger={},
    )

    summary_data = build_summary_data(model)
    index_data = build_index_data(model, front_pages=2)
    prov_data = build_provenance_data(model)

    pdf_front = render_weasy_pdf("front.html", {
        "model": model,
        "summary_data": summary_data,
        "index_data": index_data,
        "style": "publication",
    })
    pdf_back = render_weasy_pdf("back.html", {
        "model": model,
        "prov": model.provenance,
        "prov_data": prov_data,
        "style": "publication",
    })

    assert len(pypdf.PdfReader(io.BytesIO(pdf_front)).pages) >= 1
    assert len(pypdf.PdfReader(io.BytesIO(pdf_back)).pages) >= 1


def test_render_html_and_pdf_size_check():
    """
    Verify render_html produces valid HTML and render_pdf generates a clean,
    compact PDF within size budget (e.g. ~100-200 KB for single_step) using
    300 dpi base64 PNG for dense heatmaps and SVG for vector profiles.
    """
    fixture_dir = Path(__file__).parent / "fixtures" / "chemex_trees" / "single_step"
    model = build_report_model(fixture_dir, "single_step", "CPMG")

    # 1. HTML rendering check
    html_str = render_html(model, style="screen")
    assert "<!DOCTYPE html>" in html_str
    assert "single_step" in html_str
    assert "<svg" in html_str
    assert "data:image/png;base64," in html_str

    # 2. PDF rendering check
    pdf_buf = render_pdf(model, style="publication")
    pdf_bytes = pdf_buf.getvalue()
    size_kb = len(pdf_bytes) / 1024

    # Assert PDF validity
    reader = pypdf.PdfReader(io.BytesIO(pdf_bytes))
    assert len(reader.pages) >= 5

    # Size check: 7 pages with 8 embedded figures was reference ~91 KB;
    # Ensure it is well within reasonable bounds (< 300 KB)
    assert size_kb < 300, f"PDF file size too large: {size_kb:.1f} KB (dense artist might be emitting raw SVG)"


def test_retire_matplotlib_assembler():
    """
    Verify that report_generator.py has retired matplotlib page assembly,
    PdfPages, _draw_header_footer, and ax.table, acting as a thin coordinator shim.
    """
    import inspect
    from app.services.reporting import report_generator

    source = inspect.getsource(report_generator)
    assert "PdfPages" not in source
    assert "_draw_header_footer" not in source
    assert "ax.table" not in source
    assert "page_generators" not in source
    assert "GridSpec" not in source

