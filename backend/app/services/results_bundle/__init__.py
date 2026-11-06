"""Results Bundle Package (§3.11)."""

from .schema import BUNDLE_SCHEMA_VERSION, PARSER_VERSION, ManifestModel, SummaryModel
from .fingerprint import compute_bundle_fingerprint, invalidate_fingerprint_cache
from .ingest import ingest_results
from .store import (
    is_bundle_valid,
    get_manifest,
    get_summary,
    get_report_model,
    get_residue,
    query_profiles,
    query_residuals,
    query_statistics_summary,
    query_grid_1d,
    get_etag,
)
from .artifacts import (
    REPORT_TEMPLATE_VERSION,
    render_key,
    get_or_render_artifact,
    get_artifact_path,
    prune_artifacts_lru,
)

__all__ = [
    "BUNDLE_SCHEMA_VERSION",
    "PARSER_VERSION",
    "ManifestModel",
    "SummaryModel",
    "compute_bundle_fingerprint",
    "invalidate_fingerprint_cache",
    "ingest_results",
    "is_bundle_valid",
    "get_manifest",
    "get_summary",
    "get_report_model",
    "get_residue",
    "query_profiles",
    "query_residuals",
    "query_statistics_summary",
    "query_grid_1d",
    "get_etag",
    "REPORT_TEMPLATE_VERSION",
    "render_key",
    "get_or_render_artifact",
    "get_artifact_path",
    "prune_artifacts_lru",
]
