"""
Uncertainty Resolution Engine for resoFlow reports.
Implements the strict Phase 1b precedence hierarchy:
  1. GRID       - Delta-chi2 confidence interval from 1D grid search (asymmetric, highest precedence)
  2. RESAMPLED  - Percentile interval from Monte Carlo / Bootstrap / MCMC samples (16/84% and 2.5/97.5%)
  3. COVARIANCE - Symmetric sigma from fit covariance matrix
  4. NONE       - Explicitly marked as unavailable

Also determines parameter status (Phase 2):
  - FITTED, FIXED, DERIVED, AT_BOUND, NOT_IN_MODEL
  - Checks bound proximity (flagging within 1% of boundary)
"""

from __future__ import annotations

import hashlib
import math
import os
import json
import logging
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

import numpy as np

from ..fitting.chemex_output import parse_output_tree, RunResult, StepResult
from ..fitting.chemex_output.grid_parser import (
    get_grid_data_for_group,
    compute_1d_profiles,
)
from ..fitting.statistics_engine import load_replicates_or_fallback, clean_param_name

logger = logging.getLogger(__name__)


class UncertaintySource(StrEnum):
    GRID = "GRID"
    RESAMPLED = "RESAMPLED"
    COVARIANCE = "COVARIANCE"
    NONE = "NONE"


class ParameterStatus(StrEnum):
    FITTED = "FITTED"
    FIXED = "FIXED"
    DERIVED = "DERIVED"
    AT_BOUND = "AT_BOUND"
    NOT_IN_MODEL = "NOT_IN_MODEL"


PARAMETER_UNITS: Dict[str, str] = {
    "kex_ab": "s⁻¹",
    "kex_ac": "s⁻¹",
    "kex_bc": "s⁻¹",
    "kex": "s⁻¹",
    "kab": "s⁻¹",
    "kba": "s⁻¹",
    "r1_a": "s⁻¹",
    "r1_b": "s⁻¹",
    "r2_a": "s⁻¹",
    "r2_b": "s⁻¹",
    "r2_c": "s⁻¹",
    "r1": "s⁻¹",
    "r2": "s⁻¹",
    "pb": "%",
    "pa": "%",
    "pc": "%",
    "cs_a": "ppm",
    "cs_b": "ppm",
    "cs_c": "ppm",
    "dw_ab": "ppm",
    "dw_ac": "ppm",
    "dw": "ppm",
    "tau_b": "ms",
    "tau_a": "ms",
    "tauc_a": "ns",
}


@dataclass
class ResolvedParameter:
    """Standardized parameter result with uncertainty, provenance, and status."""
    name: str
    scope: str  # "global" or residue name like "14N"
    value: Optional[float]
    err_low: Optional[float] = None
    err_high: Optional[float] = None
    err_low_95: Optional[float] = None
    err_high_95: Optional[float] = None
    source: UncertaintySource = UncertaintySource.NONE
    status: ParameterStatus = ParameterStatus.FITTED
    unit: Optional[str] = None
    n_samples: Optional[int] = None
    expression: Optional[str] = None
    is_near_bound: bool = False
    bound_low: Optional[float] = None
    bound_high: Optional[float] = None
    flag_reason: Optional[str] = None
    is_asymmetric: bool = False
    method_name: Optional[str] = None

    @property
    def sigma(self) -> Optional[float]:
        """Convenience accessor for symmetric or average 1-sigma uncertainty."""
        if self.err_low is None and self.err_high is None:
            return None
        if self.err_low is not None and self.err_high is None:
            return self.err_low
        if self.err_low is None and self.err_high is not None:
            return self.err_high
        return (self.err_low + self.err_high) / 2.0


class UncertaintyResolver:
    """
    Unified uncertainty resolver for an entire ChemEx analysis run directory.
    Queries GRID -> RESAMPLED -> COVARIANCE -> NONE and evaluates run-state honesty.
    """

    def __init__(
        self,
        analysis_dir: Union[str, Path],
        step_name: Optional[str] = None,
        results_data: Optional[Dict[str, Any]] = None,
    ):
        self.analysis_dir = Path(analysis_dir)
        self.output_dir = self.analysis_dir / "Output" if (self.analysis_dir / "Output").is_dir() else self.analysis_dir
        self.step_name = step_name

        # Parse output tree protocol model
        try:
            self.run_result: Optional[RunResult] = parse_output_tree(str(self.output_dir))
        except Exception as exc:
            logger.warning("Could not parse output tree in %s: %s", self.output_dir, exc)
            self.run_result = None

        # Determine primary step
        self.primary_step: Optional[StepResult] = None
        if self.run_result:
            if self.step_name and self.step_name in self.run_result.steps:
                self.primary_step = self.run_result.steps[self.step_name]
            else:
                self.primary_step = self.run_result.primary_step
                if self.primary_step is None and self.run_result.step_order:
                    self.primary_step = self.run_result.steps.get(self.run_result.step_order[-1])

        # Load results.json if available for legacy/fallback support
        self.results_json: Dict[str, Any] = results_data or {}
        if not self.results_json:
            res_file = self.analysis_dir / "results.json"
            if res_file.is_file():
                try:
                    self.results_json = json.loads(res_file.read_text(encoding="utf-8"))
                except Exception:
                    pass

        # Cache starting parameter bounds for boundary proximity checks
        self.starting_bounds: Dict[str, Tuple[Optional[float], Optional[float]]] = self._load_starting_bounds()

        # Cache loaded grid profiles and resampled samples
        self._1d_grid_cache: Dict[Any, Dict[str, Any]] = {}
        self._resampled_cache: Dict[str, Dict[str, Any]] = {}
        self.resolution_ledger: Dict[str, ResolvedParameter] = {}
        
        self._load_grid_and_resampling_data()

    @property
    def resampled_cache(self) -> Dict[str, Dict[str, Any]]:
        """Access loaded resampled samples cache."""
        return self._resampled_cache

    @property
    def grid_1d_cache(self) -> Dict[Any, Dict[str, Any]]:
        """Access loaded 1D grid profiles cache."""
        return self._1d_grid_cache

    def get_ledger_summary(self) -> Dict[str, int]:
        """Summarize how many parameters resolved to each UncertaintySource."""
        summary = {source.value: 0 for source in UncertaintySource}
        for res in self.resolution_ledger.values():
            if res.source:
                summary[res.source.value] += 1
        return summary

    def _load_starting_bounds(self) -> Dict[str, Tuple[Optional[float], Optional[float]]]:
        """Extract parameter bounds from starting_parameters or config.json."""
        bounds: Dict[str, Tuple[Optional[float], Optional[float]]] = {}
        if self.run_result and self.run_result.starting_parameters:
            for sec, p_dict in self.run_result.starting_parameters.items():
                for k, p_obj in p_dict.items():
                    key_norm = f"{sec}/{k}".upper()
                    bounds[key_norm] = (p_obj.min_val, p_obj.max_val)
                    bounds[k.upper()] = (p_obj.min_val, p_obj.max_val)

        # Check config.json if starting_parameters lacked bounds
        cfg_path = self.analysis_dir / "config.json"
        if cfg_path.is_file():
            try:
                cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
                p_cfg = cfg.get("parameter_config", {})
                for k, v in p_cfg.items():
                    if isinstance(v, dict) and ("min" in v or "max" in v):
                        bounds[k.upper()] = (v.get("min"), v.get("max"))
            except Exception:
                pass

        return bounds

    def _discover_statistics_roots(self) -> List[Tuple[str, Path]]:
        """
        Discover all Statistics/ directories following the chemex-output-protocol §3.9.3.

        Returns a list of (scope_tag, statistics_dir_path) tuples where scope_tag is:
        - 'global' for root-level or step-level Statistics/
        - '<group_name>' for group-scoped Statistics/ (e.g. '1_32', '2_55')

        Handles all valid layouts:
        - Single-step: <output>/Statistics/
        - Multi-step: <output>/<STEP>/Statistics/
        - Group-scoped: <output>/Groups/<group>/Statistics/
        - Groups-within-steps: <output>/<STEP>/Groups/<group>/Statistics/
        """
        candidates: List[Tuple[str, Path]] = []
        seen_resolved: set = set()

        def _add_candidate(scope: str, path: Path) -> None:
            """Add a candidate if its resolved path hasn't been seen (deduplication)."""
            try:
                resolved = path.resolve()
            except (OSError, ValueError):
                resolved = path
            if resolved not in seen_resolved and path.is_dir():
                seen_resolved.add(resolved)
                candidates.append((scope, path))

        def _scan_groups_dir(groups_dir: Path) -> None:
            """Descend into Groups/<group_name>/ children and find Statistics/ in each."""
            if not groups_dir.is_dir():
                return
            for group_child in sorted(groups_dir.iterdir()):
                if group_child.is_dir() and group_child.name not in (".", ".."):
                    group_stat = group_child / "Statistics"
                    _add_candidate(group_child.name, group_stat)

        def _scan_container(container: Path) -> None:
            """Scan a container directory (output_dir or analysis_dir) for all statistics locations."""
            if not container.is_dir():
                return

            # Direct Statistics/ under container
            _add_candidate("global", container / "Statistics")

            for child in sorted(container.iterdir()):
                if not child.is_dir():
                    continue

                if child.name.upper().startswith("STEP"):
                    # Step directory: check Statistics/ directly and Groups/ inside
                    _add_candidate("global", child / "Statistics")
                    _scan_groups_dir(child / "Groups")

                elif child.name == "Groups":
                    # Top-level Groups/ (CPMG 2st_rs layout): descend into each group child
                    _scan_groups_dir(child)

        # 1. Primary step (highest priority)
        if self.primary_step and self.primary_step.name:
            step_name = self.primary_step.name
            _add_candidate("global", self.output_dir / step_name / "Statistics")
            _add_candidate("global", self.analysis_dir / step_name / "Statistics")
            # Groups within primary step
            _scan_groups_dir(self.output_dir / step_name / "Groups")
            _scan_groups_dir(self.analysis_dir / step_name / "Groups")

        # 2. Scan output_dir and analysis_dir for all remaining locations
        _scan_container(self.output_dir)
        if self.output_dir != self.analysis_dir:
            _scan_container(self.analysis_dir)

        return candidates

    def _load_grid_and_resampling_data(self) -> None:
        """Discover and index grid search profiles and Monte Carlo / Bootstrap / MCMC replicate arrays."""
        # 1. Grid search indexing — use same discovery pattern as resampling
        grid_candidates: List[Path] = []
        seen_grid: set = set()

        def _add_grid(path: Path) -> None:
            try:
                resolved = path.resolve()
            except (OSError, ValueError):
                resolved = path
            if resolved not in seen_grid and path.is_dir():
                seen_grid.add(resolved)
                grid_candidates.append(path)

        def _scan_grid_container(container: Path) -> None:
            if not container.is_dir():
                return
            _add_grid(container / "Grid")
            for child in sorted(container.iterdir()):
                if not child.is_dir():
                    continue
                if child.name.upper().startswith("STEP"):
                    _add_grid(child / "Grid")
                    if (child / "Groups").is_dir():
                        for g_c in (child / "Groups").iterdir():
                            if g_c.is_dir():
                                _add_grid(g_c / "Grid")
                elif child.name == "Groups":
                    for g_c in child.iterdir():
                        if g_c.is_dir():
                            _add_grid(g_c / "Grid")

        if self.primary_step and self.primary_step.name:
            _add_grid(self.output_dir / self.primary_step.name / "Grid")
            _add_grid(self.analysis_dir / self.primary_step.name / "Grid")

        _scan_grid_container(self.output_dir)
        if self.output_dir != self.analysis_dir:
            _scan_grid_container(self.analysis_dir)

        from ..fitting.param_canonicalizer import canonicalize

        for gd in grid_candidates:
            try:
                pnames, agg_data, _ = get_grid_data_for_group(gd, None)
                if pnames and agg_data:
                    profs = compute_1d_profiles(pnames, agg_data)
                    for prof in profs:
                        c_key = canonicalize(prof["parameter"])
                        self._1d_grid_cache[c_key] = prof
            except Exception as exc:
                logger.debug("Grid discovery in %s: %s", gd, exc)

        # 2. Resampling indexing — protocol-driven discovery (§3.9.3)
        stat_methods = ["MonteCarlo", "Bootstrap", "BootstrapNS", "MCMC"]
        stat_roots = self._discover_statistics_roots()

        # Track seen sample content hashes for deduplication
        seen_hashes: Dict[str, str] = {}  # hash -> first cache key

        for scope_tag, s_root in stat_roots:
            for sm in stat_methods:
                # Match case-insensitively
                for m_dir in s_root.iterdir():
                    if m_dir.is_dir() and m_dir.name.lower() == sm.lower():
                        rep_dict = load_replicates_or_fallback(m_dir, sm)
                        if rep_dict and rep_dict.get("replicates") is not None:
                            # Content-hash deduplication: hash the sample array to detect
                            # identical data reached via multiple discovery paths
                            reps_array = rep_dict["replicates"]
                            content_hash = hashlib.sha256(reps_array.tobytes()).hexdigest()[:16]
                            method_key = sm.upper()
                            dedup_key = f"{method_key}_{content_hash}"

                            if dedup_key in seen_hashes:
                                # Identical data already loaded — skip duplicate
                                logger.debug(
                                    "Skipping duplicate %s in %s (same content as %s)",
                                    method_key, s_root, seen_hashes[dedup_key],
                                )
                                continue

                            # Build cache key with group scope tag
                            if scope_tag != "global":
                                cache_key = f"{method_key}_{scope_tag}"
                            else:
                                cache_key = method_key

                            # Avoid overwriting existing entries with different data
                            if cache_key in self._resampled_cache:
                                # Try with parent directory name as disambiguation
                                cache_key = f"{method_key}_{s_root.parent.name}"

                            self._resampled_cache[cache_key] = rep_dict
                            seen_hashes[dedup_key] = cache_key

    def _resolve_grid_uncertainty(
        self,
        param_name: str,
        scope: str,
        best_val: float,
    ) -> Optional[Tuple[float, float, Optional[float], Optional[float]]]:
        """
        Calculate asymmetric 68% (Delta-chi2 = 1.00) and 95% (Delta-chi2 = 3.84) confidence intervals from 1D grid.
        Returns (err_low_68, err_high_68, err_low_95, err_high_95).
        """
        prof = None
        for c_key, p in self._1d_grid_cache.items():
            if c_key.matches(param_name, scope):
                prof = p
                break
                
        if not prof or not prof.get("x") or not prof.get("delta_chisqr"):
            return None

        x_arr = np.array(prof["x"], dtype=np.float64)
        dchi_arr = np.array(prof["delta_chisqr"], dtype=np.float64)

        if len(x_arr) < 3:
            return None

        # Find crossings for delta_chi2 = 1.00 and 3.84
        def find_crossings(threshold: float) -> Tuple[Optional[float], Optional[float]]:
            # Left side (x < best_val)
            left_mask = x_arr <= best_val
            right_mask = x_arr >= best_val

            x_left = None
            x_right = None

            if np.any(left_mask):
                x_sub = x_arr[left_mask]
                d_sub = dchi_arr[left_mask]
                # Find interpolation crossing where d_sub crosses threshold
                for i in range(len(x_sub) - 1):
                    if (d_sub[i] - threshold) * (d_sub[i + 1] - threshold) <= 0:
                        denom = (d_sub[i + 1] - d_sub[i])
                        if abs(denom) > 1e-12:
                            frac = (threshold - d_sub[i]) / denom
                            x_left = x_sub[i] + frac * (x_sub[i + 1] - x_sub[i])
                            break

            if np.any(right_mask):
                x_sub = x_arr[right_mask]
                d_sub = dchi_arr[right_mask]
                for i in range(len(x_sub) - 1):
                    if (d_sub[i] - threshold) * (d_sub[i + 1] - threshold) <= 0:
                        denom = (d_sub[i + 1] - d_sub[i])
                        if abs(denom) > 1e-12:
                            frac = (threshold - d_sub[i]) / denom
                            x_right = x_sub[i] + frac * (x_sub[i + 1] - x_sub[i])
                            break

            return x_left, x_right

        x_l_68, x_r_68 = find_crossings(1.00)
        x_l_95, x_r_95 = find_crossings(3.84)

        if x_l_68 is not None or x_r_68 is not None:
            err_low_68 = float(best_val - x_l_68) if x_l_68 is not None else float(x_arr[-1] - x_arr[0])
            err_high_68 = float(x_r_68 - best_val) if x_r_68 is not None else float(x_arr[-1] - x_arr[0])
            err_low_95 = float(best_val - x_l_95) if x_l_95 is not None else None
            err_high_95 = float(x_r_95 - best_val) if x_r_95 is not None else None
            return err_low_68, err_high_68, err_low_95, err_high_95

        return None

    def _resolve_resampled_uncertainty(
        self,
        param_name: str,
        scope: str,
        det_val: float,
    ) -> Optional[Tuple[float, float, float, float, int, str]]:
        """
        Calculate 68% (16/84%) and 95% (2.5/97.5%) percentile intervals from replicate samples.
        Returns (err_low_68, err_high_68, err_low_95, err_high_95, n_samples, method_name).
        """
        from ..fitting.param_canonicalizer import canonicalize, match_param_in_keys

        for method_name, rep_dict in self._resampled_cache.items():
            p_names = rep_dict.get("parameter_names", [])
            replicates = rep_dict.get("replicates")
            if replicates is None or replicates.shape[0] < 2:
                continue

            # Convert to canonical keys and find match
            c_keys = [canonicalize(pn) for pn in p_names]
            col_idx = match_param_in_keys(param_name, scope, c_keys)

            if col_idx is not None:
                col = replicates[:, col_idx]
                valid = col[~np.isnan(col)]
                n_valid = len(valid)
                if n_valid >= 2:
                    p16 = float(np.percentile(valid, 15.8655))
                    p84 = float(np.percentile(valid, 84.1345))
                    p2_5 = float(np.percentile(valid, 2.5))
                    p97_5 = float(np.percentile(valid, 97.5))
                    median_val = float(np.median(valid))
                    ref_val = det_val if (det_val is not None and math.isfinite(det_val)) else median_val

                    err_low_68 = max(0.0, ref_val - p16)
                    err_high_68 = max(0.0, p84 - ref_val)
                    err_low_95 = max(0.0, ref_val - p2_5)
                    err_high_95 = max(0.0, p97_5 - ref_val)

                    if err_low_68 < 1e-12 and err_high_68 < 1e-12:
                        continue  # Parameter was likely held fixed in this resampling run

                    return err_low_68, err_high_68, err_low_95, err_high_95, n_valid, method_name

        return None

    def resolve(
        self,
        param_name: str,
        scope: str = "global",
    ) -> ResolvedParameter:
        """
        Main query interface: resolve uncertainty and status for (param_name, scope).

        Parameters:
          param_name: Parameter key (e.g. "kex_ab", "pb", "r1_a", "r2_a", "dw_ab", "cs_a", "tauc_a")
          scope: "global" or residue identifier (e.g. "14N", "55N")

        Returns:
          ResolvedParameter populated strictly by precedence rules.
        """
        p_clean = param_name.lower().strip()
        scope_clean = str(scope).strip()
        is_global = (scope_clean.lower() == "global")
        unit = PARAMETER_UNITS.get(p_clean)

        # 1. Fetch value, covariance stderr, fixed/derived attributes from primary step or results_json
        value: Optional[float] = None
        cov_stderr: Optional[float] = None
        is_fixed = False
        is_derived = False
        expression: Optional[str] = None
        status = ParameterStatus.FITTED
        flag_reason: Optional[str] = None

        if is_global:
            if self.primary_step and self.primary_step.globals:
                g_obj = self.primary_step.globals.get(p_clean) or self.primary_step.globals.get(p_clean.upper())
                if g_obj:
                    value = g_obj.value
                    cov_stderr = g_obj.stderr if g_obj.has_stderr else None
                    is_fixed = g_obj.is_fixed
                    is_derived = g_obj.is_derived or getattr(g_obj, "is_constrained", False) or bool(getattr(g_obj, "expression", None))
                    expression = g_obj.expression
            # Fallback to results_json["global"]
            if value is None and self.results_json.get("global"):
                g_dict = self.results_json["global"]
                if p_clean in g_dict:
                    val_entry = g_dict[p_clean]
                    if isinstance(val_entry, (int, float)):
                        value = float(val_entry)
                        cov_stderr = g_dict.get(f"{p_clean}_err")
                    elif isinstance(val_entry, dict):
                        value = val_entry.get("value")
                        cov_stderr = val_entry.get("err")
                        is_fixed = val_entry.get("is_fixed", False)
                        is_derived = val_entry.get("is_derived", False) or bool(val_entry.get("expression"))
        else:
            # Residue parameter lookup
            if self.primary_step and scope_clean in self.primary_step.residues:
                res_obj = self.primary_step.residues[scope_clean]
                # Check specific attributes
                attr_val = getattr(res_obj, p_clean, None)
                if attr_val is not None and hasattr(attr_val, "value"):
                    value = attr_val.value
                    cov_stderr = attr_val.stderr if attr_val.has_stderr else None
                    is_fixed = attr_val.is_fixed
                    is_derived = attr_val.is_derived or getattr(attr_val, "is_constrained", False) or bool(getattr(attr_val, "expression", None))
                    expression = attr_val.expression
                elif p_clean.upper() in res_obj.parameters:
                    p_val = res_obj.parameters[p_clean.upper()]
                    value = p_val.value
                    cov_stderr = p_val.stderr if p_val.has_stderr else None
                    is_fixed = p_val.is_fixed
                    is_derived = p_val.is_derived or getattr(p_val, "is_constrained", False) or bool(getattr(p_val, "expression", None))
                    expression = p_val.expression

            # Fallback to results_json["residues"]
            if value is None and self.results_json.get("residues"):
                res_dict = self.results_json["residues"].get(scope_clean, {})
                params_dict = res_dict.get("parameters", {})
                if p_clean in params_dict:
                    value = params_dict[p_clean]
                    cov_stderr = params_dict.get(f"{p_clean}_err")
                    if p_clean.startswith("cs_b") or p_clean.startswith("kab") or p_clean.startswith("kba") or p_clean.startswith("tau_b"):
                        is_derived = True

        if is_global and p_clean in ("kex_ab", "pb", "kex"):
            if not is_fixed:
                is_derived = False

        # 2. Check NOT_IN_MODEL
        if p_clean in ("tauc_a", "tau_c"):
            # Check if tau_c was actually in the model / starting parameters
            has_tauc_in_starting = any(
                "TAUC" in k.upper() for k in self.starting_bounds.keys()
            )
            if not has_tauc_in_starting and (value is None or value == 0.0):
                return ResolvedParameter(
                    name=param_name,
                    scope=scope,
                    value=None,
                    status=ParameterStatus.NOT_IN_MODEL,
                    unit=unit,
                )

        if value is None:
            return ResolvedParameter(
                name=param_name,
                scope=scope,
                value=None,
                status=ParameterStatus.NOT_IN_MODEL,
                unit=unit,
            )

        # 3. Check Bound Proximity (Phase 2 requirement)
        bound_low, bound_high = self.starting_bounds.get(p_clean.upper(), (None, None))

        # Scale populations (pb, pa, pc) to percentages when unit is %
        if p_clean in ("pb", "pa", "pc") and unit == "%":
            if value is not None and abs(value) <= 1.0:
                value = value * 100.0
                if cov_stderr is not None:
                    cov_stderr = cov_stderr * 100.0
                if bound_low is not None and abs(bound_low) <= 1.0:
                    bound_low = bound_low * 100.0
                if bound_high is not None and abs(bound_high) <= 1.0:
                    bound_high = bound_high * 100.0

        # 4. Parameter Status determination
        if is_fixed:
            status = ParameterStatus.FIXED
        elif is_derived:
            status = ParameterStatus.DERIVED

        is_near_bound = False
        if bound_low is not None and bound_high is not None and math.isfinite(bound_low) and math.isfinite(bound_high):
            span = bound_high - bound_low
            if span > 0 and value is not None and math.isfinite(value):
                dist_low = (value - bound_low) / span
                dist_high = (bound_high - value) / span
                if dist_low <= 0.01:
                    is_near_bound = True
                    flag_reason = f"Within 1% of lower bound ({bound_low})"
                    if status == ParameterStatus.FITTED:
                        status = ParameterStatus.AT_BOUND
                elif dist_high <= 0.01:
                    is_near_bound = True
                    flag_reason = f"Within 1% of upper bound ({bound_high})"
                    if status == ParameterStatus.FITTED:
                        status = ParameterStatus.AT_BOUND

        # 5. Apply Uncertainty Precedence Hierarchy
        res = None

        # Priority 1: GRID
        grid_res = self._resolve_grid_uncertainty(param_name, scope_clean, value)
        if grid_res is not None:
            err_l, err_h, err_l_95, err_h_95 = grid_res
            res = ResolvedParameter(
                name=param_name,
                scope=scope,
                value=value,
                err_low=err_l,
                err_high=err_h,
                err_low_95=err_l_95,
                err_high_95=err_h_95,
                source=UncertaintySource.GRID,
                status=status,
                unit=unit,
                expression=expression,
                is_near_bound=is_near_bound,
                bound_low=bound_low,
                bound_high=bound_high,
                flag_reason=flag_reason,
                is_asymmetric=bool(abs(err_l - err_h) > 1e-6),
                method_name="Grid 1D",
            )

        # Priority 2: RESAMPLED (Monte Carlo / Bootstrap / MCMC)
        if res is None:
            resample_res = self._resolve_resampled_uncertainty(param_name, scope_clean, value)
            if resample_res is not None:
                err_l, err_h, err_l_95, err_h_95, n_s, m_name = resample_res
                res = ResolvedParameter(
                    name=param_name,
                    scope=scope,
                    value=value,
                    err_low=err_l,
                    err_high=err_h,
                    err_low_95=err_l_95,
                    err_high_95=err_h_95,
                    source=UncertaintySource.RESAMPLED,
                    status=status,
                    unit=unit,
                    n_samples=n_s,
                    expression=expression,
                    is_near_bound=is_near_bound,
                    bound_low=bound_low,
                    bound_high=bound_high,
                    flag_reason=flag_reason,
                    is_asymmetric=bool(abs(err_l - err_h) > 1e-6),
                    method_name=m_name,
                )

        # Priority 3: COVARIANCE
        if res is None:
            if cov_stderr is not None and math.isfinite(cov_stderr) and cov_stderr > 0:
                res = ResolvedParameter(
                    name=param_name,
                    scope=scope,
                    value=value,
                    err_low=cov_stderr,
                    err_high=cov_stderr,
                    err_low_95=cov_stderr * 1.96,
                    err_high_95=cov_stderr * 1.96,
                    source=UncertaintySource.COVARIANCE,
                    status=status,
                    unit=unit,
                    expression=expression,
                    is_near_bound=is_near_bound,
                    bound_low=bound_low,
                    bound_high=bound_high,
                    flag_reason=flag_reason,
                    is_asymmetric=False,
                    method_name="Covariance",
                )

        # Priority 4: NONE
        if res is None:
            res = ResolvedParameter(
                name=param_name,
                scope=scope,
                value=value,
                err_low=None,
                err_high=None,
                source=UncertaintySource.NONE,
                status=status,
                unit=unit,
                expression=expression,
                is_near_bound=is_near_bound,
                bound_low=bound_low,
                bound_high=bound_high,
                flag_reason=flag_reason,
                is_asymmetric=False,
            )

        self.resolution_ledger[f"{param_name}_{scope}"] = res
        return res
