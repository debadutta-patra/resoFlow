"""
Top-level ChemEx Output Tree Parser (§1.1, §1.2).
Entry point: parse_output_tree(path) -> RunResult
Total function over arbitrary directory states, never raises on missing or malformed files.
"""

from __future__ import annotations

import tomllib
from pathlib import Path
from typing import Callable, Optional

from .data import parse_data_directory
from .grid import parse_grid_directory
from .models import (
    OutcomeModel,
    ProvenanceModel,
    RunResult,
    RunState,
    StepResult,
    StructuredWarning,
)
from .parameters import parse_parameters_directory
from .provenance import (
    locate_restart_file,
    parse_outcome_toml,
    parse_parameters_used_toml,
    parse_run_toml,
)
from .statistics import parse_statistics_toml
from .statistics_dir import parse_statistics_tree, merge_statistics_collections
from ..spin_system import SpinSystemKey


def _catalogue_plots(plot_dir: Path) -> list[str]:
    if not plot_dir.exists() or not plot_dir.is_dir():
        return []
    return [str(p) for p in sorted(plot_dir.glob("*.pdf"))]


import re
from .models import (
    OutcomeModel,
    PER_RESIDUE_DOF_CONVENTION,
    ProvenanceModel,
    RunResult,
    RunState,
    StepResidueModel,
    StepResult,
    StructuredWarning,
    UncertaintyValue,
)


_RESIDUE_REGEX = re.compile(r"^(?:[A-Za-z]{1,4})?(\d+)(?:[-_A-Za-z0-9]+)?$")


def _parse_plot_curve_file(filepath: Path) -> dict[str, dict[str, list[float]]]:
    """
    Parse a .exp or .fit file from Plots directory (§1.6).
    Section headers are [residue], columns are OFFSET (PPM), INTENSITY, ERROR.
    """
    data_by_res: dict[str, dict[str, list[float]]] = {}
    curr_res: Optional[str] = None
    try:
        lines = filepath.read_text(encoding="utf-8").splitlines()
        for line in lines:
            line_str = line.strip()
            if not line_str:
                continue
            if line_str.startswith("[") and line_str.endswith("]"):
                curr_res = line_str[1:-1].strip()
                if curr_res not in data_by_res:
                    data_by_res[curr_res] = {
                        "x": [],
                        "y": [],
                        "y_err": [],
                        "mask_x": [],
                        "mask_y": [],
                    }
            elif curr_res:
                if "# NOT USED IN THE FIT" in line_str:
                    clean = line_str.replace("#", "").replace("NOT USED IN THE FIT", "").strip()
                    parts = clean.split()
                    if len(parts) >= 2:
                        try:
                            data_by_res[curr_res]["mask_x"].append(float(parts[0]))
                            data_by_res[curr_res]["mask_y"].append(float(parts[1]))
                        except (ValueError, TypeError):
                            pass
                elif line_str.startswith("#"):
                    continue
                else:
                    parts = line_str.split()
                    if len(parts) >= 2:
                        try:
                            x_val = float(parts[0])
                            y_val = float(parts[1])
                            y_err = float(parts[2]) if len(parts) >= 3 else 0.0
                            data_by_res[curr_res]["x"].append(x_val)
                            data_by_res[curr_res]["y"].append(y_val)
                            if len(parts) >= 3:
                                data_by_res[curr_res]["y_err"].append(y_err)
                        except (ValueError, TypeError):
                            pass
    except Exception:
        pass
    return data_by_res


def _discover_b1_mappings(search_dirs: list[Path]) -> dict[str, str]:
    b1_mapping: dict[str, str] = {}
    for d in search_dirs:
        if d.exists() and d.is_dir():
            for f in d.glob("*.toml"):
                try:
                    data = tomllib.loads(f.read_text(encoding="utf-8"))
                    b1_val = data.get("experiment", {}).get("b1_frq")
                    if b1_val is not None:
                        b1_mapping[f.stem] = f"{b1_val} Hz"
                except Exception:
                    pass
    return b1_mapping


def _extract_step_residues(
    step_dir: Path,
    params: Optional[ParameterReportModel],
    data_files: dict[str, DataFileModel],
    warnings: list[StructuredWarning],
) -> dict[str, StepResidueModel]:
    """
    Extract canonical residues, aggregate parameters, compute resoFlow-derived chi2 (§3.12),
    and fetch exact plot curves from .exp and .fit files in Plots/.
    """
    candidate_keys: set[str] = set()
    param_keys: set[str] = set()

    if params is not None:
        for group in (params.fitted, params.fixed, params.constrained):
            for section, section_params in group.items():
                if section == "GLOBAL":
                    continue
                for k in section_params.keys():
                    k_clean = k.strip()
                    candidate_keys.add(k_clean)
                    param_keys.add(k_clean)

    for dfile in data_files.values():
        for prof_name in dfile.profiles.keys():
            candidate_keys.add(prof_name.strip())

    # Discover and parse Plots/*.exp and Plots/*.fit files
    search_exp_dirs = [
        step_dir / "Experiments",
        step_dir / "All" / "Experiments",
        step_dir.parent / "run_info" / "inputs" / "experiments",
        step_dir.parent / "Experiments",
    ]
    b1_map = _discover_b1_mappings(search_exp_dirs)

    candidate_plot_dirs = [
        step_dir / "Plots",
        step_dir / "All" / "Plots",
        step_dir.parent / "Plots",
    ]

    plots_by_exp: dict[str, dict[str, dict[str, Any]]] = {}
    for pd in candidate_plot_dirs:
        if pd.exists() and pd.is_dir():
            for f in sorted(pd.iterdir()):
                if f.suffix in (".exp", ".obs"):
                    stem = f.stem
                    if stem not in plots_by_exp:
                        plots_by_exp[stem] = {}
                    parsed_exp = _parse_plot_curve_file(f)
                    for r_k, r_pts in parsed_exp.items():
                        candidate_keys.add(r_k.strip())
                        if r_k not in plots_by_exp[stem]:
                            plots_by_exp[stem][r_k] = {}
                        plots_by_exp[stem][r_k]["exp_points"] = {
                            "x": r_pts["x"],
                            "y": r_pts["y"],
                            "y_err": r_pts["y_err"],
                        }
                        plots_by_exp[stem][r_k]["masked_points"] = {
                            "x": r_pts["mask_x"],
                            "y": r_pts["mask_y"],
                        }
                elif f.suffix == ".fit":
                    stem = f.stem
                    if stem not in plots_by_exp:
                        plots_by_exp[stem] = {}
                    parsed_fit = _parse_plot_curve_file(f)
                    for r_k, r_pts in parsed_fit.items():
                        candidate_keys.add(r_k.strip())
                        if r_k not in plots_by_exp[stem]:
                            plots_by_exp[stem][r_k] = {}
                        plots_by_exp[stem][r_k]["calc_points"] = {
                            "x": r_pts["x"],
                            "y": r_pts["y"],
                        }
                        plots_by_exp[stem][r_k]["fit_curve"] = {
                            "x": r_pts["x"],
                            "y": r_pts["y"],
                        }

    # Deduplicate candidate keys representing the same spin system entity (e.g. "32N" and "32N-H")
    grouped_keys: dict[Any, list[str]] = {}
    for k in candidate_keys:
        parsed = SpinSystemKey.parse(k)
        rnum = parsed.res_num
        sym = parsed.symbol
        spin0 = parsed.spins[0] if parsed.spins else ""
        if rnum == 0:
            gid = ("raw", k)
        else:
            gid = (rnum, sym, spin0)
        grouped_keys.setdefault(gid, []).append(k)

    canonical_keys: list[str] = []
    for gid, keys in grouped_keys.items():
        def _key_score(x: str) -> tuple[int, int, str]:
            p = SpinSystemKey.parse(x)
            is_canonical = (x == p.canonical)
            in_params = x in param_keys
            # Rank 0: in parameters and canonical form (e.g. 32N)
            # Rank 1: canonical form
            # Rank 2: in parameters (e.g. 32)
            # Rank 3: other
            if in_params and is_canonical:
                rank = 0
            elif is_canonical:
                rank = 1
            elif in_params:
                rank = 2
            else:
                rank = 3
            return (rank, len(x), x)

        best_key = sorted(keys, key=_key_score)[0]
        canonical_keys.append(best_key)

    residues: dict[str, StepResidueModel] = {}

    for raw_key in sorted(canonical_keys, key=lambda k: (SpinSystemKey.parse(k).res_num or (int(m.group(1)) if (m := _RESIDUE_REGEX.match(k)) else 999999), k)):
        m = _RESIDUE_REGEX.match(raw_key)
        is_unrec = m is None
        display_name = raw_key
        raw_parsed = SpinSystemKey.parse(raw_key)
        res_num = str(raw_parsed.res_num) if raw_parsed.res_num > 0 else (m.group(1) if m else raw_key)
        raw_spin0 = raw_parsed.spins[0] if raw_parsed.spins else ""

        res_params: dict[str, UncertaintyValue] = {}
        r2_a = None
        r2_b = None
        r1_a = None
        cs_a = None
        cs_b = None
        dw_ab = None
        kex_ab = None
        pb = None
        pa = None
        kab = None
        kba = None
        tau_b = None
        nvarys = 0

        if params is not None:
            for group_name, group in (("fitted", params.fitted), ("fixed", params.fixed), ("constrained", params.constrained)):
                for section, section_params in group.items():
                    if section == "GLOBAL":
                        continue
                    for k, param in section_params.items():
                        k_clean = k.strip()
                        k_parsed = SpinSystemKey.parse(k_clean)
                        k_m = _RESIDUE_REGEX.match(k_clean)
                        k_num = str(k_parsed.res_num) if k_parsed.res_num > 0 else (k_m.group(1) if k_m else k_clean)
                        k_spin0 = k_parsed.spins[0] if k_parsed.spins else ""

                        matches_param = (
                            k_clean == raw_key
                            or (
                                k_num == res_num
                                and (not (k_spin0 and raw_spin0) or k_spin0 == raw_spin0)
                            )
                        )

                        if matches_param:
                            res_params[section] = param
                            if group_name == "fitted":
                                nvarys += 1
                            sec_upper = section.upper()
                            if sec_upper.startswith("R2_A"):
                                r2_a = param
                            elif sec_upper.startswith("R2_B"):
                                r2_b = param
                            elif sec_upper.startswith("R1_A"):
                                r1_a = param
                            elif sec_upper.startswith("CS_A"):
                                cs_a = param
                            elif sec_upper.startswith("CS_B"):
                                cs_b = param
                            elif sec_upper.startswith("DW_AB"):
                                dw_ab = param
                            elif sec_upper.startswith("KEX_AB") or sec_upper.startswith("KEX"):
                                kex_ab = param
                            elif sec_upper.startswith("PB"):
                                pb = param
                            elif sec_upper.startswith("PA"):
                                pa = param
                            elif sec_upper.startswith("KAB"):
                                kab = param
                            elif sec_upper.startswith("KBA"):
                                kba = param
                            elif sec_upper.startswith("TAU_B"):
                                tau_b = param

            # Fallback to global parameters if not per-residue fitted
            g_map = params.get_global_parameters()
            if kex_ab is None:
                kex_ab = g_map.get("KEX_AB") or g_map.get("kex_ab") or g_map.get("KEX") or g_map.get("kex")
            if pb is None:
                pb = g_map.get("PB") or g_map.get("pb")
            if pa is None:
                pa = g_map.get("PA") or g_map.get("pa")
            if kab is None:
                kab = g_map.get("KAB") or g_map.get("kab")
            if kba is None:
                kba = g_map.get("KBA") or g_map.get("kba")

        # Derive kab, kba, tau_b per-residue if kex_ab and pb exist
        if kex_ab is not None and pb is not None and kex_ab.value is not None and pb.value is not None:
            if kab is None:
                kab_val = kex_ab.value * pb.value
                kab_err = (kex_ab.stderr * pb.value) if (kex_ab.has_stderr and kex_ab.stderr is not None) else None
                kab = UncertaintyValue(
                    name="KAB",
                    section="CONSTRAINED",
                    key="KAB",
                    value=kab_val,
                    stderr=kab_err,
                    has_stderr=kab_err is not None,
                    is_derived=True,
                )
            if kba is None:
                kba_val = kex_ab.value * (1.0 - pb.value)
                kba_err = (kex_ab.stderr * (1.0 - pb.value)) if (kex_ab.has_stderr and kex_ab.stderr is not None) else None
                kba = UncertaintyValue(
                    name="KBA",
                    section="CONSTRAINED",
                    key="KBA",
                    value=kba_val,
                    stderr=kba_err,
                    has_stderr=kba_err is not None,
                    is_derived=True,
                )
            if tau_b is None and kba is not None and kba.value is not None and kba.value > 0:
                tau_val = 1000.0 / kba.value
                tau_err = (1000.0 * kba.stderr / (kba.value ** 2)) if (kba.has_stderr and kba.stderr is not None) else None
                tau_b = UncertaintyValue(
                    name="TAU_B",
                    section="DERIVED",
                    key="TAU_B",
                    value=tau_val,
                    stderr=tau_err,
                    has_stderr=tau_err is not None,
                    is_derived=True,
                )

        # Compute per-residue chi2 from data files
        chi2_sum = 0.0
        ndata = 0
        fallback_experiments: list[dict[str, Any]] = []

        for stem, dfile in sorted(data_files.items()):
            # Find matching profile
            matching_prof = dfile.profiles.get(raw_key)
            if matching_prof is None:
                for pname, pobj in dfile.profiles.items():
                    p_parsed = SpinSystemKey.parse(pname)
                    p_m = _RESIDUE_REGEX.match(pname)
                    p_num = str(p_parsed.res_num) if p_parsed.res_num > 0 else (p_m.group(1) if p_m else pname)
                    p_spin0 = p_parsed.spins[0] if p_parsed.spins else ""
                    if p_num == res_num and (not (p_spin0 and raw_spin0) or p_spin0 == raw_spin0):
                        matching_prof = pobj
                        break

            if matching_prof is not None:
                x_col = matching_prof.columns[0] if matching_prof.columns else "x"
                exp_x: list[float] = []
                exp_y: list[float] = []
                exp_err: list[float] = []
                calc_x: list[float] = []
                calc_y: list[float] = []
                mask_x: list[float] = []
                mask_y: list[float] = []

                for pt in matching_prof.points:
                    x_val = pt.metadata.get(x_col, 0.0)
                    if pt.calc is not None:
                        calc_x.append(x_val)
                        calc_y.append(pt.calc)

                    if pt.mask:
                        if pt.exp is not None:
                            exp_x.append(x_val)
                            exp_y.append(pt.exp)
                            err_val = pt.err if (pt.err is not None and pt.err > 0) else 1.0
                            exp_err.append(err_val)
                            if pt.calc is not None and pt.err is not None and pt.err > 0:
                                residual = (pt.exp - pt.calc) / pt.err
                                chi2_sum += residual * residual
                                ndata += 1
                    else:
                        if pt.exp is not None:
                            mask_x.append(x_val)
                            mask_y.append(pt.exp)

                fallback_experiments.append({
                    "b1_label": stem,
                    "exp_points": {"x": exp_x, "y": exp_y, "y_err": exp_err},
                    "calc_points": {"x": calc_x, "y": calc_y},
                    "fit_curve": {"x": calc_x, "y": calc_y},
                    "masked_points": {"x": mask_x, "y": mask_y},
                })

        # Fetch values for plotting directly from .exp and .fit files in Plots/
        plot_experiments: list[dict[str, Any]] = []
        if plots_by_exp:
            for stem, res_dict in sorted(plots_by_exp.items()):
                matching_plot = res_dict.get(raw_key)
                if matching_plot is None:
                    for pk, pv in res_dict.items():
                        pk_parsed = SpinSystemKey.parse(pk)
                        pk_m = _RESIDUE_REGEX.match(pk)
                        pk_num = str(pk_parsed.res_num) if pk_parsed.res_num > 0 else (pk_m.group(1) if pk_m else pk)
                        pk_spin0 = pk_parsed.spins[0] if pk_parsed.spins else ""
                        if pk_num == res_num and (not (pk_spin0 and raw_spin0) or pk_spin0 == raw_spin0):
                            matching_plot = pv
                            break
                if matching_plot:
                    b1_lbl = b1_map.get(stem, stem)
                    plot_experiments.append({
                        "b1_label": b1_lbl,
                        "exp_points": matching_plot.get("exp_points", {"x": [], "y": [], "y_err": []}),
                        "calc_points": matching_plot.get("calc_points", {"x": [], "y": []}),
                        "fit_curve": matching_plot.get("fit_curve", {"x": [], "y": []}),
                        "masked_points": matching_plot.get("masked_points", {"x": [], "y": []}),
                    })

        final_experiments = plot_experiments if plot_experiments else fallback_experiments

        chi2 = float(chi2_sum) if ndata > 0 else None
        dof = max(ndata - nvarys, 1)
        chi2_red = (chi2 / dof) if chi2 is not None else None

        residues[raw_key] = StepResidueModel(
            residue=raw_key,
            raw_key=raw_key,
            display_name=display_name,
            is_unrecognized=is_unrec,
            chi2=chi2,
            chi2_red=chi2_red,
            ndata=ndata,
            nvarys=nvarys,
            dof_convention=PER_RESIDUE_DOF_CONVENTION,
            r2_a=r2_a,
            r2_b=r2_b,
            r1_a=r1_a,
            cs_a=cs_a,
            cs_b=cs_b,
            dw_ab=dw_ab,
            kex_ab=kex_ab,
            pb=pb,
            kab=kab,
            kba=kba,
            tau_b=tau_b,
            parameters=res_params,
            experiments=final_experiments,
        )

    return residues


def _parse_step_directory(
    step_dir: Path,
    step_name: str,
    warnings: list[StructuredWarning],
    run_info_dir: Optional[Path] = None,
) -> StepResult:
    """
    Parse a single scientific result folder (root or step subfolder).
    Respects §1.2: if All/ exists and has Parameters, uses All/ as aggregate fallback.
    """
    params_dir = step_dir / "Parameters"
    data_dir = step_dir / "Data"
    stats_file = step_dir / "statistics.toml"
    grid_dir = step_dir / "Grid"
    statistics_dir = step_dir / "Statistics"
    plots_dir = step_dir / "Plots"

    # §1.2 Fallback
    if not params_dir.exists() and (step_dir / "All" / "Parameters").exists():
        all_dir = step_dir / "All"
        params_dir = all_dir / "Parameters"
        if not data_dir.exists() and (all_dir / "Data").exists():
            data_dir = all_dir / "Data"
        if not stats_file.exists() and (all_dir / "statistics.toml").exists():
            stats_file = all_dir / "statistics.toml"
        if not grid_dir.exists() and (all_dir / "Grid").exists():
            grid_dir = all_dir / "Grid"
        if not plots_dir.exists() and (all_dir / "Plots").exists():
            plots_dir = all_dir / "Plots"
        if not statistics_dir.exists() and (all_dir / "Statistics").exists():
            statistics_dir = all_dir / "Statistics"

    params = parse_parameters_directory(params_dir, warnings) if params_dir.exists() else None
    data_files = parse_data_directory(data_dir, warnings) if data_dir.exists() else {}
    stats = parse_statistics_toml(stats_file, warnings) if stats_file.exists() else None
    grid = parse_grid_directory(grid_dir, warnings, step_name=step_name, run_info_dir=run_info_dir) if grid_dir.exists() else None
    stat_analyses = parse_statistics_tree(statistics_dir, warnings) if statistics_dir.exists() else None
    plots = _catalogue_plots(plots_dir)

    # §1.2 Group-fit resampling / MCMC aggregation fallback
    if (step_dir / "Groups").exists():
        groups_dir = step_dir / "Groups"
        group_stats = []
        for g_dir in sorted(groups_dir.iterdir()):
            if g_dir.is_dir() and (g_dir / "Statistics").exists():
                g_parsed = parse_statistics_tree(g_dir / "Statistics", warnings)
                if g_parsed is not None:
                    group_stats.append(g_parsed)
        if group_stats:
            merged_group_stats = merge_statistics_collections(group_stats)
            if stat_analyses is None:
                stat_analyses = merged_group_stats
            elif merged_group_stats is not None:
                if merged_group_stats.monte_carlo and (not stat_analyses.monte_carlo or not stat_analyses.monte_carlo.correlations):
                    stat_analyses.monte_carlo = merged_group_stats.monte_carlo
                if merged_group_stats.bootstrap and (not stat_analyses.bootstrap or not stat_analyses.bootstrap.correlations):
                    stat_analyses.bootstrap = merged_group_stats.bootstrap
                if merged_group_stats.bootstrap_ns and (not stat_analyses.bootstrap_ns or not stat_analyses.bootstrap_ns.correlations):
                    stat_analyses.bootstrap_ns = merged_group_stats.bootstrap_ns
                if merged_group_stats.mcmc and (not stat_analyses.mcmc or not stat_analyses.mcmc.correlations):
                    stat_analyses.mcmc = merged_group_stats.mcmc

    # If stats is None, check if Groups/ has individual statistics.toml
    if stats is None and (step_dir / "Groups").exists():
        g_ndata = 0
        g_nvarys = 0
        g_chisqr = 0.0
        g_aics = []
        g_bics = []
        has_group_stats = False
        for g_dir in sorted((step_dir / "Groups").iterdir()):
            if g_dir.is_dir() and (g_dir / "statistics.toml").exists():
                g_s = parse_statistics_toml(g_dir / "statistics.toml", warnings)
                if g_s is not None:
                    has_group_stats = True
                    if g_s.ndata:
                        g_ndata += g_s.ndata
                    if g_s.nvarys:
                        g_nvarys += g_s.nvarys
                    if g_s.chisqr:
                        g_chisqr += g_s.chisqr
                    if g_s.aic is not None:
                        g_aics.append(g_s.aic)
                    if g_s.bic is not None:
                        g_bics.append(g_s.bic)
        if has_group_stats:
            dof = max(g_ndata - g_nvarys, 1)
            g_redchi = (g_chisqr / dof) if g_ndata > 0 else None
            g_aic = sum(g_aics) if g_aics else ((g_chisqr + 2 * g_nvarys) if g_ndata > 0 else None)
            g_bic = sum(g_bics) if g_bics else None
            from .models import GoodnessOfFitModel
            stats = GoodnessOfFitModel(
                ndata=g_ndata if g_ndata > 0 else None,
                nvarys=g_nvarys if g_nvarys > 0 else None,
                chisqr=g_chisqr if g_ndata > 0 else None,
                redchi=g_redchi,
                aic=g_aic,
                bic=g_bic,
            )

    residues = _extract_step_residues(step_dir, params, data_files, warnings)

    # Determine step status
    if params is None and stats is None and not data_files and stat_analyses is None and grid is None and not residues:
        status = "missing"
    elif (params is not None or residues) and (stats is not None or stat_analyses is not None or grid is not None):
        status = "complete"
    else:
        status = "complete" if (stat_analyses is not None or stats is not None or residues) else "partial"

    globals_dict: dict[str, UncertaintyValue] = {}
    if params is not None:
        for k, v in params.get_global_parameters().items():
            globals_dict[k] = v
            globals_dict[k.lower()] = v
            globals_dict[k.upper()] = v

    # Derive representative / mean kex_ab, pb if not in globals_dict
    if residues:
        kex_list = [r.kex_ab for r in residues.values() if r.kex_ab and r.kex_ab.value is not None]
        pb_list = [r.pb for r in residues.values() if r.pb and r.pb.value is not None]
        if ("kex_ab" not in globals_dict and "KEX_AB" not in globals_dict) and kex_list:
            kex_mean = sum(k.value for k in kex_list if k.value is not None) / len(kex_list)
            kex_err_vals = [k.stderr for k in kex_list if k.stderr is not None]
            kex_err = (sum(kex_err_vals) / len(kex_err_vals)) if kex_err_vals else None
            kex_glob = UncertaintyValue(
                name="KEX_AB", section="GLOBAL", key="KEX_AB", value=kex_mean, stderr=kex_err, has_stderr=kex_err is not None, is_derived=True
            )
            globals_dict["kex_ab"] = kex_glob
            globals_dict["KEX_AB"] = kex_glob
        if ("pb" not in globals_dict and "PB" not in globals_dict) and pb_list:
            pb_mean = sum(p.value for p in pb_list if p.value is not None) / len(pb_list)
            pb_err_vals = [p.stderr for p in pb_list if p.stderr is not None]
            pb_err = (sum(pb_err_vals) / len(pb_err_vals)) if pb_err_vals else None
            pb_glob = UncertaintyValue(
                name="PB", section="GLOBAL", key="PB", value=pb_mean, stderr=pb_err, has_stderr=pb_err is not None, is_derived=True
            )
            globals_dict["pb"] = pb_glob
            globals_dict["PB"] = pb_glob

    # Extract kinetics (KAB, KBA, PA) and derive tau_b (§1.3)
    kab = globals_dict.get("kab") or globals_dict.get("KAB")
    kba = globals_dict.get("kba") or globals_dict.get("KBA")
    pa = globals_dict.get("pa") or globals_dict.get("PA")

    # If kab/kba are not in globals_dict but kex_ab and pb are available in globals_dict:
    kex_glob = globals_dict.get("kex_ab") or globals_dict.get("KEX_AB")
    pb_glob = globals_dict.get("pb") or globals_dict.get("PB")
    if kex_glob is not None and pb_glob is not None and kex_glob.value is not None and pb_glob.value is not None:
        if kab is None:
            kab_val = kex_glob.value * pb_glob.value
            kab_err = (kex_glob.stderr * pb_glob.value) if (kex_glob.has_stderr and kex_glob.stderr is not None) else None
            kab = UncertaintyValue(
                name="KAB", section="GLOBAL", key="KAB", value=kab_val, stderr=kab_err, has_stderr=kab_err is not None, is_derived=True
            )
            globals_dict["kab"] = kab
            globals_dict["KAB"] = kab
        if kba is None:
            kba_val = kex_glob.value * (1.0 - pb_glob.value)
            kba_err = (kex_glob.stderr * (1.0 - pb_glob.value)) if (kex_glob.has_stderr and kex_glob.stderr is not None) else None
            kba = UncertaintyValue(
                name="KBA", section="GLOBAL", key="KBA", value=kba_val, stderr=kba_err, has_stderr=kba_err is not None, is_derived=True
            )
            globals_dict["kba"] = kba
            globals_dict["KBA"] = kba

    tau_b: Optional[UncertaintyValue] = globals_dict.get("tau_b") or globals_dict.get("TAU_B")
    if tau_b is None and kba is not None and kba.value is not None and kba.value > 0:
        tau_val = 1000.0 / kba.value  # in milliseconds
        if kba.has_stderr and kba.stderr is not None and kba.stderr > 0:
            tau_err = 1000.0 * kba.stderr / (kba.value * kba.value)
            tau_has_err = True
            tau_err_reason = None
        else:
            tau_err = None
            tau_has_err = False
            tau_err_reason = "Uncertainty withheld by ChemEx"

        tau_b = UncertaintyValue(
            name="TAU_B",
            section="GLOBAL",
            key="TAU_B",
            value=tau_val,
            stderr=tau_err,
            has_stderr=tau_has_err,
            error_reason=tau_err_reason,
            is_derived=True,
        )
        globals_dict["tau_b"] = tau_b
        globals_dict["TAU_B"] = tau_b

    has_stats = (
        stat_analyses is not None
        and any(
            getattr(stat_analyses, a) is not None
            for a in ("monte_carlo", "bootstrap", "bootstrap_ns", "mcmc", "covariance_evidence")
        )
    )

    has_grid = grid is not None and grid.has_grid

    return StepResult(
        name=step_name,
        status=status,
        has_grid=has_grid,
        parameters=params,
        data=data_files,
        statistics=stats,
        grid=grid,
        statistical_analyses=stat_analyses,
        plots=plots,
        residues=residues,
        globals=globals_dict,
        kab=kab,
        kba=kba,
        pa=pa,
        tau_b=tau_b,
        has_statistics=has_stats,
    )


def _extract_step_names_from_methods(
    run_info_dir: Path,
    warnings: list[StructuredWarning],
) -> list[str]:
    """
    Extract declared step names from archived method files in run_info/inputs/methods/.
    """
    methods_dir = run_info_dir / "inputs" / "methods"
    if not methods_dir.exists() or not methods_dir.is_dir():
        return []

    step_names: list[str] = []
    for method_file in sorted(methods_dir.glob("*.toml")):
        try:
            data = tomllib.loads(method_file.read_text(encoding="utf-8"))
            for section in data.keys():
                if section and section not in step_names:
                    step_names.append(section)
        except Exception as exc:
            warnings.append(
                StructuredWarning(
                    code="CORRUPT_METHOD_INPUT",
                    message=f"Could not parse archived method file {method_file.name}: {exc}",
                    path=str(method_file),
                )
            )
    return step_names


def parse_output_tree(
    output_path: Path | str,
    *,
    staleness_minutes: float = 5.0,
    is_task_active_fn: Optional[Callable[[], bool]] = None,
) -> RunResult:
    """
    Main entry point for parsing ChemEx output trees (§1.1–§1.11).
    Total function: never raises on missing, partial, or corrupted output trees.
    """
    root = Path(output_path).resolve()
    warnings: list[StructuredWarning] = []

    if not root.exists():
        warnings.append(
            StructuredWarning(
                code="DIRECTORY_NOT_FOUND",
                message=f"Output directory does not exist: {root}",
                path=str(root),
            )
        )
        outcome = OutcomeModel(
            status=RunState.UNKNOWN,
            is_provisional=True,
            failure_reason=f"Directory not found: {root}",
        )
        return RunResult(
            output_path=str(root),
            state=RunState.UNKNOWN,
            is_provisional=True,
            is_multi_step=False,
            outcome=outcome,
            warnings=warnings,
        )

    # 1. Trust Gate & Provenance
    outcome = parse_outcome_toml(
        root,
        warnings,
        staleness_minutes=staleness_minutes,
        is_task_active_fn=is_task_active_fn,
    )
    provenance = parse_run_toml(root, warnings)
    starting_params = parse_parameters_used_toml(root, warnings)
    restart_path, can_continue, continue_expl = locate_restart_file(root)

    # Check revision divergence (§1.3)
    if (
        outcome.latest_committed_revision is not None
        and outcome.latest_restart_revision is not None
        and outcome.latest_committed_revision > outcome.latest_restart_revision
    ):
        warnings.append(
            StructuredWarning(
                code="REVISION_DIVERGENCE",
                message=(
                    f"Parameters reflect committed revision {outcome.latest_committed_revision}, "
                    f"but restart checkpoint is at revision {outcome.latest_restart_revision}."
                ),
                details={
                    "committed_revision": outcome.latest_committed_revision,
                    "restart_revision": outcome.latest_restart_revision,
                },
            )
        )

    # 2. Layout Discrimination (§1.1, chemex/optimize/fitting.py:154)
    declared_steps = _extract_step_names_from_methods(root / "run_info", warnings)
    if not declared_steps:
        # If root itself has scientific outputs, it is a single-step run
        if (root / "Parameters").exists() or (root / "Data").exists() or (root / "statistics.toml").exists():
            declared_steps = []
        else:
            # Fallback to discovering step directories on disk
            ignored_names = {"run_info", "Parameters", "Data", "Plots", "Grid", "Statistics", "All", "Groups", "Output"}
            candidate_dirs = [
                d for d in root.iterdir()
                if d.is_dir() and d.name not in ignored_names and not d.name.startswith(".")
                and ((d / "Parameters").exists() or (d / "Data").exists() or (d / "statistics.toml").exists() or (d / "All").exists() or (d / "Groups").exists() or (d / "Statistics").exists())
            ]
            if candidate_dirs:
                def _step_sort_key(d: Path) -> tuple[int, str]:
                    m = re.search(r"(\d+)", d.name)
                    return (int(m.group(1)) if m else 999999, d.name)

                # Natural numeric sort: STEP1, STEP2, ..., STEP10
                declared_steps = [d.name for d in sorted(candidate_dirs, key=_step_sort_key)]

    is_multi_step = len(declared_steps) > 1 or (len(declared_steps) == 1 and declared_steps[0] != "" and (root / declared_steps[0]).exists())

    steps: dict[str, StepResult] = {}
    step_order: list[str] = []

    if is_multi_step:
        for sname in declared_steps:
            s_dir = root / sname
            if s_dir.exists() and s_dir.is_dir():
                step_res = _parse_step_directory(s_dir, sname, warnings, run_info_dir=root / "run_info")
                steps[sname] = step_res
                step_order.append(sname)
            else:
                # Step was planned but not reached / created
                steps[sname] = StepResult(name=sname)
                step_order.append(sname)
                warnings.append(
                    StructuredWarning(
                        code="MISSING_STEP_DIRECTORY",
                        message=f"Planned step {sname!r} directory not found on disk.",
                        path=str(s_dir),
                    )
                )

        # Check for lingering root-level outputs on directory reuse (§1.10)
        if (root / "Parameters").exists():
            warnings.append(
                StructuredWarning(
                    code="STALE_ROOT_ARTIFACTS",
                    message="Root-level scientific directories detected in multi-step run; ignoring stale root outputs.",
                    path=str(root),
                )
            )
    else:
        # Single-step run
        step_res = _parse_step_directory(root, "", warnings, run_info_dir=root / "run_info")
        steps[""] = step_res
        step_order.append("")

        # Check for lingering step directories from previous runs (§1.10)
        for child in root.iterdir():
            if child.is_dir() and child.name not in ("run_info", "Parameters", "Data", "Plots", "Grid", "Statistics", "All", "Groups"):
                if not child.name.startswith("."):
                    warnings.append(
                        StructuredWarning(
                            code="STALE_STEP_DIRECTORY",
                            message=f"Lingering subdirectory {child.name!r} detected in single-step run; ignoring stale directory.",
                            path=str(child),
                        )
                    )

    # Determine primary step
    primary_step: Optional[StepResult] = None
    if "" in steps:
        primary_step = steps[""]
    elif step_order:
        # Pick the last step with parameters, or the last declared step
        for sname in reversed(step_order):
            if steps[sname].parameters is not None:
                primary_step = steps[sname]
                break
        if primary_step is None and step_order:
            primary_step = steps[step_order[0]]

    return RunResult(
        output_path=str(root),
        state=outcome.status,
        is_provisional=outcome.is_provisional,
        is_multi_step=is_multi_step,
        outcome=outcome,
        provenance=provenance,
        starting_parameters=starting_params,
        restart_file_path=restart_path,
        can_continue_fit=can_continue,
        continue_explanation=continue_expl,
        steps=steps,
        step_order=step_order,
        primary_step=primary_step,
        warnings=warnings,
    )
