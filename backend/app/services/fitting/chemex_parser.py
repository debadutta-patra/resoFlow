"""
Parser for ChemEx output files (fitted.toml, parameters.toml, statistics.toml).
Extracts fitted parameter values and uncertainties from ChemEx output files,
and provides inverse-variance weighting for collapsing individual fit results.
"""

import os
import re
import math
import json
from typing import Dict, Any, Optional, List, Tuple
from .spin_system import SpinSystemKey


# Regex for section headers, e.g. [GLOBAL], [CS_A], ["R1_A, B0->600.3MHZ"]
SECTION_REGEX = re.compile(r'^\s*\["?([^"\]]+)"?\]\s*$')

# Regex for key = value # comment
# Supports:
#   3N = 120.19 # (fixed)
#   "KEX_AB, T->25.0C" = 1.14659e+03 # ±2.11629e+02
#   32N-H = -93.0 # (fixed)
PARAM_LINE_REGEX = re.compile(
    r'^\s*(?:"([^"]+)"|\'([^\']+)\'|([^\s=]+))\s*=\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)(?:\s*#\s*(.*))?$'
)

# Regex to extract uncertainty after ± or +/-
UNCERTAINTY_REGEX = re.compile(r'(?:±|\+\/-|\+\s*\/\s*-)\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)')


def extract_base_name(name: str) -> str:
    """Extract clean base parameter or section name (e.g. 'CS_A, T->25.0C' -> 'CS_A')."""
    clean = name.strip().strip('"').strip("'")
    if "," in clean:
        clean = clean.split(",")[0].strip()
    return clean.upper()


def parse_fitted_toml_content(content: str) -> Dict[str, Dict[str, Dict[str, Any]]]:
    """
    Parse a ChemEx fitted.toml / fixed.toml / constrained.toml text content into a structured dict
    preserving uncertainties and comments.

    Returns:
      {
        section_name: {
          param_or_res_key: {
            "value": float,
            "err": float | None,
            "is_fixed": bool,
            "comment": str | None
          }
        }
      }
    """
    sections: Dict[str, Dict[str, Dict[str, Any]]] = {}
    current_section = "GLOBAL"

    for line in content.splitlines():
        line_str = line.strip()
        if not line_str:
            continue

        sec_match = SECTION_REGEX.match(line_str)
        if sec_match:
            current_section = sec_match.group(1).strip()
            if current_section not in sections:
                sections[current_section] = {}
            continue

        param_match = PARAM_LINE_REGEX.match(line_str)
        if param_match:
            raw_key = (param_match.group(1) or param_match.group(2) or param_match.group(3) or "").strip()
            val_str = param_match.group(4).strip()
            comment_str = (param_match.group(5) or "").strip()

            try:
                val = float(val_str)
            except ValueError:
                continue

            err = None
            is_fixed = "(fixed)" in comment_str.lower()

            if comment_str:
                err_match = UNCERTAINTY_REGEX.search(comment_str)
                if err_match:
                    try:
                        err = float(err_match.group(1))
                    except ValueError:
                        err = None

            if current_section not in sections:
                sections[current_section] = {}

            sections[current_section][raw_key] = {
                "value": val,
                "err": err,
                "is_fixed": is_fixed,
                "comment": comment_str if comment_str else None,
            }

    return sections


def parse_fitted_toml_file(filepath: str) -> Dict[str, Dict[str, Dict[str, Any]]]:
    """Parse a ChemEx fitted.toml file from disk."""
    if not os.path.exists(filepath):
        return {}
    with open(filepath, "r", encoding="utf-8", errors="replace") as f:
        return parse_fitted_toml_content(f.read())


def parse_statistics_toml(filepath: str) -> Dict[str, Any]:
    """Parse a ChemEx statistics.toml file."""
    stats = {}
    if not os.path.exists(filepath):
        return stats

    with open(filepath, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line_str = line.strip()
            if not line_str or line_str.startswith("#"):
                continue
            if "=" in line_str:
                parts = line_str.split("=", 1)
                k = parts[0].strip().strip('"').strip("'").lower()
                v_str = parts[1].strip()
                # Remove inline comment if any
                if "#" in v_str:
                    v_str = v_str.split("#", 1)[0].strip()
                try:
                    v = float(v_str) if "." in v_str or "e" in v_str.lower() else int(v_str)
                except ValueError:
                    v = v_str
                stats[k] = v

    # Normalize standard keys
    normalized = {}
    for k, v in stats.items():
        if k in ["reduced-chi-square", "reduced_chi_square", "chi2_red", "reduced-chi2"]:
            normalized["chi2_red"] = float(v)
        elif k in ["chi-square", "chi_square", "chi2"]:
            normalized["chi2"] = float(v)
        elif k in ["number of data points", "data_points"]:
            normalized["data_points"] = int(v)
        elif k in ["number of variables", "variables"]:
            normalized["variables"] = int(v)
        else:
            normalized[k] = v

    return normalized


def compute_inverse_variance_stats(items: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Given a list of parameter items (each containing 'value': float and optionally 'err': float | None),
    calculate inverse-variance weighted mean, its standard error, and spread metrics.

    Returns:
      {
        "value": float,           # Weighted mean (or arithmetic mean if no errors)
        "err": float | None,      # Uncertainty on the mean
        "mean": float,            # Arithmetic mean
        "median": float,
        "q25": float,
        "q75": float,
        "iqr": float,
        "min": float,
        "max": float,
        "count": int,
        "valid_err_count": int,
        "relative_error": float | None
      }
    """
    valid_items = [i for i in items if i and "value" in i and i["value"] is not None and not math.isnan(i["value"])]
    if not valid_items:
        return {
            "value": 0.0,
            "err": None,
            "mean": 0.0,
            "median": 0.0,
            "q25": 0.0,
            "q75": 0.0,
            "iqr": 0.0,
            "min": 0.0,
            "max": 0.0,
            "count": 0,
            "valid_err_count": 0,
            "relative_error": None,
        }

    values = [float(i["value"]) for i in valid_items]
    values_sorted = sorted(values)
    n = len(values)

    # Spread metrics
    def percentile(arr, p):
        idx = (len(arr) - 1) * p
        lower = int(math.floor(idx))
        upper = int(math.ceil(idx))
        if lower == upper:
            return arr[lower]
        return arr[lower] * (upper - idx) + arr[upper] * (idx - lower)

    median = percentile(values_sorted, 0.5)
    q25 = percentile(values_sorted, 0.25)
    q75 = percentile(values_sorted, 0.75)
    iqr = q75 - q25
    min_val = values_sorted[0]
    max_val = values_sorted[-1]
    arithmetic_mean = sum(values) / n

    # Weighted mean calculation using inverse-variance weights: w_i = 1 / sigma_i^2
    weighted_sum = 0.0
    weight_sum = 0.0
    valid_err_count = 0

    for i in valid_items:
        err = i.get("err")
        if err is not None and isinstance(err, (int, float)) and not math.isnan(err) and err > 0:
            w = 1.0 / (err * err)
            weighted_sum += w * float(i["value"])
            weight_sum += w
            valid_err_count += 1

    if weight_sum > 0 and valid_err_count > 0:
        weighted_mean = weighted_sum / weight_sum
        weighted_err = math.sqrt(1.0 / weight_sum)
    else:
        # Fallback to arithmetic mean
        weighted_mean = arithmetic_mean
        if n > 1:
            var = sum((x - arithmetic_mean) ** 2 for x in values) / (n - 1)
            weighted_err = math.sqrt(var / n)
        else:
            weighted_err = None

    rel_err = (abs(weighted_err / weighted_mean)) if (weighted_err is not None and weighted_mean != 0) else None

    return {
        "value": weighted_mean,
        "err": weighted_err,
        "mean": arithmetic_mean,
        "median": median,
        "q25": q25,
        "q75": q75,
        "iqr": iqr,
        "min": min_val,
        "max": max_val,
        "count": n,
        "valid_err_count": valid_err_count,
        "relative_error": rel_err,
    }


def parse_chemex_run_parameters(run_dir: str) -> Dict[str, Any]:
    """
    Parse a completed ChemEx analysis run directory into queryable parameter dictionaries,
    supporting both Global and Individual fit runs.

    Returns:
      {
        "fit_mode": "global" | "individual",
        "globals": {
          "kex_ab": { "value": float, "err": float | None, "stats": dict | None },
          "pb": { "value": float, "err": float | None, "stats": dict | None },
          "tauc_a": { "value": float, "err": float | None }
        },
        "residues": {
          "3N": {
            "cs_a": { "value": float, "err": float | None },
            "dw_ab": { "value": float, "err": float | None },
            "r1_a": { "value": float, "err": float | None },
            "r2_a": { "value": float, "err": float | None },
            "kex_ab": { "value": float, "err": float | None }, # in individual mode
            "pb": { "value": float, "err": float | None }       # in individual mode
          }
        },
        "statistics": {
          "chi2": float | None,
          "chi2_red": float | None
        }
      }
    """
    # Detect output directory (handle whether run_dir or output_dir itself is passed)
    candidate_output = os.path.join(run_dir, "Output")
    if os.path.isdir(candidate_output):
        output_dir = candidate_output
    elif (
        os.path.isdir(os.path.join(run_dir, "Groups"))
        or os.path.isdir(os.path.join(run_dir, "All"))
        or os.path.isdir(os.path.join(run_dir, "Parameters"))
        or os.path.exists(os.path.join(run_dir, "statistics.toml"))
        or os.path.exists(os.path.join(run_dir, "fitted.toml"))
    ):
        output_dir = run_dir
    else:
        output_dir = run_dir

    result: Dict[str, Any] = {
        "fit_mode": "global",
        "globals": {},
        "residues": {},
        "statistics": {},
        "excluded_residues": [],
    }

    # Extract excluded residues from config.json or parameters.toml if available
    excluded_set = set()
    possible_config_paths = [
        os.path.join(run_dir, "config.json"),
        os.path.join(output_dir, "config.json"),
        os.path.join(os.path.dirname(run_dir), "config.json"),
    ]
    for cp in possible_config_paths:
        if os.path.exists(cp):
            try:
                with open(cp, "r") as cf:
                    cfg = json.load(cf)
                    p_cfg = cfg.get("parameter_config") or {}
                    if isinstance(p_cfg, dict) and p_cfg.get("excludedResidues"):
                        for r in p_cfg["excludedResidues"]:
                            excluded_set.add(str(r))
                    elif cfg.get("excluded_residues"):
                        for r in cfg["excluded_residues"]:
                            excluded_set.add(str(r))
            except Exception:
                pass

    possible_param_paths = [
        os.path.join(run_dir, "parameters.toml"),
        os.path.join(run_dir, "Parameters", "parameters.toml"),
        os.path.join(output_dir, "parameters.toml"),
        os.path.join(output_dir, "Parameters", "parameters.toml"),
    ]
    for pp in possible_param_paths:
        if os.path.exists(pp):
            try:
                with open(pp, "r") as pf:
                    for line in pf:
                        line_str = line.strip()
                        m = re.match(r"^#\s*([A-Za-z0-9_]+)\s*=", line_str)
                        if m:
                            res = m.group(1).strip()
                            if any(c.isdigit() for c in res) and res.upper() not in ["GLOBAL", "STEP1", "STEP2", "GRID", "FIT", "FIX", "PB", "KEX_AB", "TAUC_A"]:
                                excluded_set.add(res)
            except Exception:
                pass

    result["excluded_residues"] = sorted(list(excluded_set), key=lambda r: (int(re.findall(r'\d+', r)[0]) if re.findall(r'\d+', r) else 0, r))

    # 1. Check for statistics.toml
    stats_paths = [
        os.path.join(output_dir, "statistics.toml"),
        os.path.join(output_dir, "All", "statistics.toml"),
    ]
    if os.path.isdir(output_dir):
        for step_candidate in sorted([d for d in os.listdir(output_dir) if d.upper().startswith("STEP")], reverse=True):
            s_path = os.path.join(output_dir, step_candidate)
            if os.path.isdir(s_path):
                stats_paths.extend([
                    os.path.join(s_path, "statistics.toml"),
                    os.path.join(s_path, "All", "statistics.toml"),
                ])
    stats_paths.append(os.path.join(run_dir, "statistics.toml"))
    for sp in stats_paths:
        if os.path.exists(sp) and os.path.isfile(sp):
            result["statistics"] = parse_statistics_toml(sp)
            break

    # 2. Discover residue subdirectories for individual fits
    residue_subdirs = []
    containers = [output_dir]
    if os.path.isdir(os.path.join(output_dir, "Groups")):
        containers.append(os.path.join(output_dir, "Groups"))
    if os.path.isdir(os.path.join(output_dir, "Output", "Groups")):
        containers.append(os.path.join(output_dir, "Output", "Groups"))

    for cont in containers:
        if not os.path.isdir(cont):
            continue
        try:
            for d in os.listdir(cont):
                full_d = os.path.join(cont, d)
                if not os.path.isdir(full_d):
                    continue
                if d in ["All", "Groups", "Parameters", "Plots", "Data", "Experiments", "Output", "run_info"] or d.upper().startswith("STEP"):
                    continue
                if any(char.isdigit() for char in d):
                    residue_subdirs.append(full_d)
        except Exception:
            pass

    if residue_subdirs:
        result["fit_mode"] = "individual"

    # Helper function to assign standard parameter keys
    def assign_parameter(target_dict: dict, section_name: str, key_name: str, item_dict: dict):
        sec_base = extract_base_name(section_name)
        key_base = extract_base_name(key_name)

        val = item_dict.get("value")
        err = item_dict.get("err")
        is_fixed = item_dict.get("is_fixed", False)
        entry = {"value": val, "err": err, "is_fixed": is_fixed}

        # Global kinetics
        if sec_base in ["GLOBAL", "POPULATIONS", "KINETICS"]:
            if key_base in ["KEX_AB", "KEX"]:
                target_dict["kex_ab"] = entry
            elif key_base in ["PB", "PB_AB"]:
                target_dict["pb"] = entry
            elif key_base in ["KEX_AC"]:
                target_dict["kex_ac"] = entry
            elif key_base in ["KEX_BC"]:
                target_dict["kex_bc"] = entry
            elif key_base in ["PC"]:
                target_dict["pc"] = entry
            elif key_base == "TAUC_A":
                target_dict["tauc_a"] = entry
            elif key_base in ["KAB", "KBA", "PA"]:
                target_dict[key_base.lower()] = entry
            else:
                target_dict[key_base.lower()] = entry
        elif sec_base in ["PB", "PC", "KEX_AB", "KEX_AC", "KEX_BC", "TAUC_A"]:
            target_dict[sec_base.lower()] = entry
        # Residue parameters
        else:
            matched = None
            for prefix in [
                "CS_A", "CS_B", "CS_C", "CS_D", "CS_E", "CS_F",
                "DW_AB", "DW_AC", "DW_AD", "DW_AE", "DW_AF",
                "R1_A", "R1_B", "R1_C", "R2_A", "R2_B", "R2_C",
                "R1A_A", "R1A_B", "R2A_A", "R2A_B",
                "ETAXY_A", "ETAXY_B", "ETAZ_A", "ETAZ_B", "J_A", "J_B",
                "R1", "R2", "PB", "KEX_AB"
            ]:
                if sec_base == prefix:
                    matched = prefix.lower()
                    break
            if matched:
                target_dict[matched] = entry
            else:
                target_dict[sec_base.lower()] = entry

    # 3. Harvest Global Parameters from ALL files in order:
    # fixed.toml -> constrained.toml -> parameters.toml -> fitted.toml
    param_file_types = ["fixed.toml", "constrained.toml", "parameters.toml", "fitted.toml"]
    search_dirs = [
        os.path.join(output_dir, "Parameters"),
        os.path.join(output_dir, "All", "Parameters"),
        output_dir,
        os.path.join(output_dir, "All"),
    ]
    if os.path.isdir(output_dir):
        for step_candidate in sorted([d for d in os.listdir(output_dir) if d.upper().startswith("STEP")], reverse=True):
            s_path = os.path.join(output_dir, step_candidate)
            if os.path.isdir(s_path):
                search_dirs.extend([
                    os.path.join(s_path, "Parameters"),
                    os.path.join(s_path, "All", "Parameters"),
                    s_path,
                    os.path.join(s_path, "All"),
                ])
    search_dirs.extend([
        os.path.join(run_dir, "Parameters"),
        run_dir,
    ])

    for s_dir in search_dirs:
        found_in_sdir = False
        for p_type in param_file_types:
            p_path = os.path.join(s_dir, p_type)
            if os.path.exists(p_path) and os.path.isfile(p_path):
                parsed_dict = parse_fitted_toml_file(p_path)
                for sec_name, sec_items in parsed_dict.items():
                    sec_base = extract_base_name(sec_name)
                    if sec_base in ["GLOBAL", "POPULATIONS", "KINETICS", "PB", "PC", "KEX_AB", "KEX_AC", "TAUC_A"]:
                        for k, v in sec_items.items():
                            if k.lower() not in result["globals"] or result["globals"][k.lower()]["value"] is None:
                                assign_parameter(result["globals"], sec_name, k, v)
                    else:
                        for res_key, res_item in sec_items.items():
                            sp = SpinSystemKey.parse(res_key)
                            normalized_res = sp.canonical if sp.res_num else res_key
                            if normalized_res not in result["residues"]:
                                result["residues"][normalized_res] = {}
                            assign_parameter(result["residues"][normalized_res], sec_name, res_key, res_item)
                found_in_sdir = True
        if found_in_sdir:
            break

    # 4. Harvest Individual Fits (if any)
    individual_kex_list = []
    individual_pb_list = []

    for res_dir in residue_subdirs:
        res_folder_name = os.path.basename(res_dir)
        clean_folder_name = res_folder_name[:-3] if res_folder_name.endswith("-HN") else res_folder_name

        group_parts = [part for part in clean_folder_name.split("_") if part.isdigit() or re.match(r'^[A-Za-z]?\d+[A-Z]?$', part)]
        group_residues = []
        for part in group_parts:
            sp = SpinSystemKey.parse(part)
            if sp.res_num:
                group_residues.append(sp.canonical)

        if not group_residues:
            sp = SpinSystemKey.parse(clean_folder_name)
            if sp.res_num:
                group_residues.append(sp.canonical)

        sub_search_dirs = [
            os.path.join(res_dir, "Parameters"),
            res_dir,
        ]

        for p_type in param_file_types:
            for s_dir in sub_search_dirs:
                st = os.path.join(s_dir, p_type)
                if os.path.exists(st) and os.path.isfile(st):
                    sub_parsed = parse_fitted_toml_file(st)
                    for sec_name, sec_items in sub_parsed.items():
                        sec_base = extract_base_name(sec_name)
                        for k, v in sec_items.items():
                            sp_k = SpinSystemKey.parse(k)
                            res_for_key = sp_k.canonical if sp_k.res_num else (group_residues[0] if group_residues else k)

                            if res_for_key not in result["residues"]:
                                result["residues"][res_for_key] = {}

                            assign_parameter(result["residues"][res_for_key], sec_name, k, v)

                            # Collect per-residue kex and pb for individual-fit collapsing (from fitted.toml)
                            if p_type == "fitted.toml":
                                if sec_base in ["KEX_AB", "KEX"] or extract_base_name(k) in ["KEX_AB", "KEX"]:
                                    individual_kex_list.append(v)
                                elif sec_base in ["PB", "PB_AB"] or extract_base_name(k) in ["PB", "PB_AB"]:
                                    individual_pb_list.append(v)
                    break

    # 5. Enforce derived shifts cs_b = cs_a + dw_ab and cs_c = cs_a + dw_ac if missing
    for res_key, res_dict in result["residues"].items():
        if "cs_a" in res_dict:
            if "dw_ab" in res_dict and "cs_b" not in res_dict:
                res_dict["cs_b"] = {
                    "value": res_dict["cs_a"]["value"] + res_dict["dw_ab"]["value"],
                    "err": res_dict["dw_ab"].get("err"),
                    "is_fixed": False,
                }
            if "dw_ac" in res_dict and "cs_c" not in res_dict:
                res_dict["cs_c"] = {
                    "value": res_dict["cs_a"]["value"] + res_dict["dw_ac"]["value"],
                    "err": res_dict["dw_ac"].get("err"),
                    "is_fixed": False,
                }

    # 6. If Individual mode, collapse per-residue kex_ab and pb to global seed with inverse-variance weighted stats
    if result["fit_mode"] == "individual":
        if individual_kex_list:
            kex_stats = compute_inverse_variance_stats(individual_kex_list)
            result["globals"]["kex_ab"] = {
                "value": kex_stats["value"],
                "err": kex_stats["err"],
                "stats": kex_stats,
            }
        if individual_pb_list:
            pb_stats = compute_inverse_variance_stats(individual_pb_list)
            result["globals"]["pb"] = {
                "value": pb_stats["value"],
                "err": pb_stats["err"],
                "stats": pb_stats,
            }

    # 7. Compute reduced chi-squared fallback if not present in statistics
    if "chi2_red" not in result["statistics"] and result["globals"].get("chi2_red"):
        result["statistics"]["chi2_red"] = result["globals"]["chi2_red"]["value"]

    # 8. Ingest Uncertainty Statistics (Monte Carlo, Bootstrap, BootstrapNS, MCMC)
    # never overwrites deterministic fit parameters or covariance errors
    try:
        from .statistics_parser import parse_statistics_directory
        stat_res = parse_statistics_directory(run_dir)
        if not stat_res.get("has_statistics"):
            stat_res = parse_statistics_directory(output_dir)
        result["uncertainty_statistics"] = stat_res
    except Exception:
        result["uncertainty_statistics"] = {"has_statistics": False, "methods": {}, "steps": {}}

    return result


def evaluate_source_compatibility(source_meta: dict, target_meta: dict) -> Tuple[bool, List[str], List[str]]:
    """
    Evaluate compatibility rules:
    - Block on different kinetic model (2-state vs 3-state).
    - Block on different nucleus.
    - Block on non-CEST experiment type.
    - Warn prominently on different temperature.
    - Allow different static field (B0).
    """
    is_compatible = True
    block_reasons = []
    warning_reasons = []

    # Check Analysis Type
    src_type = (source_meta.get("analysis_type") or "").upper()
    if src_type not in ["15N-CEST", "CEST"]:
        is_compatible = False
        block_reasons.append(f"Incompatible experiment type: {source_meta.get('analysis_type')}")

    # Check Kinetic Model (2-state vs 3-state)
    src_model = (source_meta.get("model") or "2st").lower()
    tgt_model = (target_meta.get("model") or "2st").lower()
    src_is_3st = "3" in src_model
    tgt_is_3st = "3" in tgt_model
    if src_is_3st != tgt_is_3st:
        is_compatible = False
        block_reasons.append(f"Different kinetic model: {source_meta.get('model', '2st')} vs {target_meta.get('model', '2st')}")

    # Check Nucleus
    src_nuc = (source_meta.get("nucleus") or "15N").upper()
    tgt_nuc = (target_meta.get("nucleus") or "15N").upper()
    if src_nuc != tgt_nuc:
        is_compatible = False
        block_reasons.append(f"Different nucleus: {src_nuc} vs {tgt_nuc}")

    # Check Temperature
    src_temp = source_meta.get("temperature") or 298.15
    tgt_temp = target_meta.get("temperature") or 298.15
    if abs(src_temp - tgt_temp) > 1.0:
        warning_reasons.append(
            f"Different temperature: {src_temp:.1f} K vs {tgt_temp:.1f} K (kex_ab is strongly temperature-dependent)"
        )

    return is_compatible, block_reasons, warning_reasons
