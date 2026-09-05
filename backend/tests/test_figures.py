# backend/tests/test_figures.py
"""Unit tests for standalone figure generation in app.services.reporting.figures."""

import numpy as np
import pytest

from app.services.reporting.figures import (
    format_param_label,
    dispersion_curve,
    residuals_strip,
    detailed_residue_plot,
    kinetic_correlation_plot,
    parameter_distribution_plot,
    covariance_distribution_plot,
    correlation_matrix_plot,
    grid_1d_profile_plot,
)
from app.services.reporting.uncertainty import ParameterStatus, ResolvedParameter, UncertaintySource


class MockParam:
    def __init__(self, value, status="FITTED", sigma=None, unit=None):
        self.value = value
        self.status = ParameterStatus.FITTED if status == "FITTED" else ParameterStatus.FIXED
        self.sigma = sigma
        self.unit = unit


@pytest.fixture
def sample_residue_record():
    return {
        "display_name": "10N",
        "dw": MockParam(2.5),
        "csa": MockParam(118.5),
        "csb": MockParam(121.0),
        "experiments": [
            {
                "b1_label": "B1 = 25 Hz",
                "exp_points": {
                    "x": [115.0, 118.5, 121.0, 125.0],
                    "y": [0.98, 0.35, 0.75, 0.99],
                    "y_err": [0.02, 0.02, 0.02, 0.02],
                },
                "fit_curve": {
                    "x": [115.0, 118.0, 118.5, 120.0, 121.0, 125.0],
                    "y": [0.98, 0.50, 0.35, 0.60, 0.75, 0.99],
                },
            }
        ],
    }


def test_format_param_label():
    assert "k_ex" in format_param_label("kex_ab")
    assert "p_b" in format_param_label("pb")
    assert "Δω" in format_param_label("dw_ab")
    assert "R₂A" in format_param_label("r2_a")


def test_dispersion_curve_svg(sample_residue_record):
    svg = dispersion_curve(sample_residue_record, analysis_type="CEST")
    assert isinstance(svg, str)
    assert svg.startswith("<svg")
    assert "</svg>" in svg
    # Text converted to paths per design spec §4
    assert 'xmlns="http://www.w3.org/2000/svg"' in svg


def test_residuals_strip_svg(sample_residue_record):
    svg = residuals_strip(sample_residue_record, analysis_type="CEST")
    assert isinstance(svg, str)
    assert svg.startswith("<svg")
    assert "</svg>" in svg


def test_detailed_residue_plot_svg(sample_residue_record):
    svg = detailed_residue_plot(sample_residue_record, analysis_type="CEST")
    assert isinstance(svg, str)
    assert svg.startswith("<svg")
    assert "</svg>" in svg


def test_kinetic_correlation_plot_png_and_svg():
    grid_prof_2d = (
        {
            "x": [0.01, 0.05, 0.10],
            "y": [200.0, 500.0, 1000.0],
            "z_delta": [
                [10.0, 4.0, 15.0],
                [5.0, 0.0, 8.0],
                [12.0, 6.0, 20.0],
            ],
            "x_param": "pb",
            "y_param": "kex_ab",
        },
        {"coordinates": {"pb": 0.05, "kex_ab": 500.0}},
    )
    # Default is 300 dpi base64 PNG data URI
    png_uri = kinetic_correlation_plot(grid_prof_2d=grid_prof_2d)
    assert isinstance(png_uri, str)
    assert png_uri.startswith("data:image/png;base64,")

    # SVG format requested explicitly
    svg = kinetic_correlation_plot(grid_prof_2d=grid_prof_2d, fmt="svg")
    assert isinstance(svg, str)
    assert svg.startswith("<svg")
    assert "</svg>" in svg

    # Resampling samples_2d fallback
    samples_2d = (np.array([0.04, 0.05, 0.06]), np.array([480.0, 500.0, 520.0]))
    png_samples = kinetic_correlation_plot(samples_2d=samples_2d, best_fit=(0.05, 500.0))
    assert png_samples.startswith("data:image/png;base64,")


def test_parameter_distribution_plot_svg():
    col_data = np.random.normal(500.0, 25.0, size=100)
    svg = parameter_distribution_plot(col_data, "kex_ab")
    assert isinstance(svg, str)
    assert svg.startswith("<svg")
    assert "</svg>" in svg


def test_covariance_distribution_plot_svg():
    param = ResolvedParameter(
        name="kex_ab",
        scope="global",
        status=ParameterStatus.FITTED,
        value=500.0,
        err_low=35.0,
        err_high=35.0,
        source=UncertaintySource.COVARIANCE,
        unit="s⁻¹",
    )
    svg = covariance_distribution_plot("k_ex (s⁻¹)", param)
    assert isinstance(svg, str)
    assert svg.startswith("<svg")
    assert "</svg>" in svg


def test_correlation_matrix_plot_png_and_svg():
    corr_mat = np.array([[1.0, -0.65], [-0.65, 1.0]])
    labels = ["k_ex (s⁻¹)", "p_b (%)"]

    # Default is base64 PNG data URI
    png_uri = correlation_matrix_plot(corr_mat, labels)
    assert isinstance(png_uri, str)
    assert png_uri.startswith("data:image/png;base64,")

    # SVG format
    svg = correlation_matrix_plot(corr_mat, labels, fmt="svg")
    assert isinstance(svg, str)
    assert svg.startswith("<svg")
    assert "</svg>" in svg


def test_grid_1d_profile_plot_svg():
    prof = {
        "parameter": "kex_ab",
        "x": [300.0, 400.0, 500.0, 600.0, 700.0],
        "delta_chisqr": [8.5, 2.1, 0.0, 2.3, 9.0],
    }
    svg = grid_1d_profile_plot(prof)
    assert isinstance(svg, str)
    assert svg.startswith("<svg")
    assert "</svg>" in svg
