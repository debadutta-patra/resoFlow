from __future__ import annotations

import os
import json
import math
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.orm import Session

from .. import database, models, security
from ..services.fitting.chemex_registry import (
    MODULE_METADATA,
    SPIN_KEY_FORMATS,
    get_module_schema,
    get_chemex_module_registry,
)
from ..services.fitting.cpmg_reduction import (
    compute_r2eff_profile,
    compute_rex_and_flatness,
    estimate_delta_omega_fast_exchange,
)
from ..services.fitting.cpmg_diagnostics import evaluate_cpmg_identifiability
from ..services.fitting.spin_system import SpinSystemKey
from .deps import get_analysis

router = APIRouter(
    prefix="/api/projects/{project_uuid}/analysis",
    tags=["cpmg-analysis"],
)



@router.get("/{analysis_uuid}/cpmg/config")
def get_cpmg_config(
    analysis: models.Analysis = Depends(get_analysis),
    current_user: models.User = Depends(security.get_current_user),
):
    project = analysis.project
    run_dir = os.path.join(project.local_directory_path, "cpmg_fitting", analysis.analysis_uuid)
    config_path = os.path.join(run_dir, "cpmg_config.json")
    if os.path.exists(config_path):
        try:
            with open(config_path, "r") as f:
                data = json.load(f)
            return {"config": data, "has_backup": analysis.has_backup}
        except Exception:
            pass
    return {"config": None, "has_backup": analysis.has_backup}


@router.put("/{analysis_uuid}/cpmg/config")
def save_cpmg_config(
    request: dict,
    analysis: models.Analysis = Depends(get_analysis),
    current_user: models.User = Depends(security.get_current_user),
):
    project = analysis.project
    run_dir = os.path.join(project.local_directory_path, "cpmg_fitting", analysis.analysis_uuid)
    os.makedirs(run_dir, exist_ok=True)
    config_path = os.path.join(run_dir, "cpmg_config.json")
    with open(config_path, "w") as f:
        json.dump(request, f, indent=2)
    return {"status": "saved"}


@router.post("/{analysis_uuid}/cpmg/generate")
def generate_cpmg_files(
    request: dict,
    analysis: models.Analysis = Depends(get_analysis),
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(security.get_current_user),
):
    """
    Generate CPMG data files and experiment TOMLs for selected spectra.
    """
    spectrum_ids = request.get("spectrum_ids", [])
    if not spectrum_ids:
        raise HTTPException(status_code=400, detail="No spectra selected")

    selected_module = request.get("selected_module", "cpmg_15n_ip")
    meta = MODULE_METADATA.get(selected_module, {})
    spin_fmt = meta.get("spin_system_format", "single_15n")
    xi_ratio = meta.get("xi_ratio", 0.101329118)

    time_t2_req = float(request.get("time_t2", 0.04))
    carrier_req = float(request.get("carrier", meta.get("default_carrier", 117.0)))
    pw90_req = float(request.get("pw90", 35.0e-6))
    data_error = request.get("data_error", "duplicates")
    use_height = request.get("use_height", True)
    excluded_residues = set(request.get("excluded_residues", []))

    project = analysis.project
    run_dir = os.path.join(project.local_directory_path, "cpmg_fitting", analysis.analysis_uuid)
    data_dir = os.path.join(run_dir, "data")
    experiments_dir = os.path.join(run_dir, "experiments")
    os.makedirs(data_dir, exist_ok=True)
    os.makedirs(experiments_dir, exist_ok=True)

    # Purge old .dat and .toml files to avoid lingering duplicate or legacy entries
    for f in os.listdir(data_dir):
        if f.endswith(".dat"):
            try:
                os.remove(os.path.join(data_dir, f))
            except Exception:
                pass
    for f in os.listdir(experiments_dir):
        if f.endswith(".toml"):
            try:
                os.remove(os.path.join(experiments_dir, f))
            except Exception:
                pass

    spectra = db.query(models.Spectrum).filter(models.Spectrum.id.in_(spectrum_ids)).all()
    if not spectra:
        raise HTTPException(status_code=404, detail="Spectra not found")

    val_field = "height" if use_height else "amp"
    err_field = "height_err" if use_height else "amp_err"

    # Group spectra by static field B0
    by_b0: Dict[float, List[models.Spectrum]] = {}
    for s in spectra:
        b0_val = getattr(s, "b0", None) or 600.0
        by_b0.setdefault(b0_val, []).append(s)

    warnings: List[Dict[str, str]] = []
    if len(by_b0) < 2:
        warnings.append({
            "code": "SINGLE_FIELD",
            "message": "Only one static field (B0) is selected. CPMG analyses benefit significantly from 2+ fields to break pb-dw correlation.",
        })

    experiment_tomls = []
    total_data_files = 0
    all_profiles_by_res: Dict[str, Dict[str, Any]] = {}
    skipped_reasons = []

    for b0_val, spec_list in by_b0.items():
        exp_profiles: Dict[str, List[str]] = {}

        for spectrum in spec_list:
            spec_label = f"Spectrum '{spectrum.name}' (ID: {spectrum.id})"
            if not spectrum.results_json_path or not os.path.exists(spectrum.results_json_path):
                skipped_reasons.append(f"{spec_label}: peak fitting results file not found at '{spectrum.results_json_path or ''}'")
                continue

            try:
                with open(spectrum.results_json_path, "r") as f:
                    fit_data = json.load(f)
            except Exception as e:
                skipped_reasons.append(f"{spec_label}: failed to parse results JSON ({e})")
                continue

            t2 = float(getattr(spectrum, "t_relax", None) or time_t2_req)
            if t2 <= 0:
                t2 = 0.04
            carr = float(getattr(spectrum, "carrier", None) or carrier_req)

            # Determine whether we are reading a vclist (cycle counts) or vdlist (frequencies in Hz or delays in s)
            raw_vals: List[float] = []
            is_vdlist = False
            list_path = None

            if spectrum.vdlist_path and os.path.exists(spectrum.vdlist_path):
                list_path = spectrum.vdlist_path
                is_vdlist = True
            elif spectrum.vclist_path and os.path.exists(spectrum.vclist_path):
                list_path = spectrum.vclist_path
                if "vdlist" in os.path.basename(list_path).lower():
                    is_vdlist = True

            if list_path:
                with open(list_path, "r") as f:
                    for line in f:
                        line = line.strip()
                        if line and not line.startswith("#"):
                            try:
                                raw_vals.append(float(line))
                            except ValueError:
                                pass

            # Convert raw_vals to ncycs
            ncycs: List[float] = []
            if raw_vals:
                max_val = max(raw_vals)
                if is_vdlist or max_val > 80.0:
                    # Treat values as CPMG frequencies (in Hz) or delays (in s)
                    for v in raw_vals:
                        if abs(v) < 1e-6:
                            ncycs.append(0.0)
                        elif v >= 1.0:
                            # CPMG frequency in Hz: ncyc = round(nu_cpmg * t2)
                            ncycs.append(float(round(v * t2)))
                        else:
                            # Delay time in seconds: nu_cpmg = 1 / (4 * delay)
                            nu = 1.0 / (4.0 * v) if v > 0 else 0.0
                            ncycs.append(float(round(nu * t2)))
                else:
                    # Values are already cycle counts
                    ncycs = [float(round(v)) for v in raw_vals]

            # Extract peak entries supporting both format A (results list) and format B (peak_fits dict)
            is_1h = any(k in (selected_module or "").lower() for k in ["1h", "hn", "methyl_1h", "ch3"])
            AA_MAP = {
                'ALA': 'A', 'ARG': 'R', 'ASN': 'N', 'ASP': 'D', 'CYS': 'C',
                'GLU': 'E', 'GLN': 'Q', 'GLY': 'G', 'HIS': 'H', 'ILE': 'I',
                'LEU': 'L', 'LYS': 'K', 'MET': 'M', 'PHE': 'F', 'PRO': 'P',
                'SER': 'S', 'THR': 'T', 'TRP': 'W', 'TYR': 'Y', 'VAL': 'V'
            }
            items_to_process = []
            if "results" in fit_data and isinstance(fit_data["results"], list):
                for peak in fit_data["results"]:
                    ass = peak.get("assignment")
                    res_num = peak.get("res_num") or peak.get("RES_NUM")
                    res_name = peak.get("res_name") or peak.get("RES_NAME")
                    res_raw = ass or f"{res_name or ''}{res_num or ''}"
                    if not res_raw:
                        continue
                    planes = peak.get("planes", [])
                    if not planes:
                        planes = [peak]
                    sorted_planes = sorted(planes, key=lambda p: p.get("plane", 0))
                    plane_intensities = [float(p.get(val_field, 0.0)) for p in sorted_planes]
                    plane_errors = [float(p.get(err_field, 0.02 * p.get(val_field, 0.0) if p.get(val_field, 0.0) else 1.0)) for p in sorted_planes]
                    cs_val = float(peak.get("center_x_ppm" if is_1h else "center_y_ppm") or peak.get("X_PPM" if is_1h else "Y_PPM") or peak.get("cs") or 0.0)
                    items_to_process.append((res_raw, plane_intensities, plane_errors, cs_val, res_num, res_name))
            elif "peak_fits" in fit_data and isinstance(fit_data["peak_fits"], dict):
                for res_raw, p_list in fit_data["peak_fits"].items():
                    p_entry = p_list[0] if isinstance(p_list, list) and len(p_list) > 0 else {}
                    plane_vals = p_entry.get("values_by_plane", {})
                    plane_keys = sorted(plane_vals.keys(), key=lambda k: int(k) if k.isdigit() else k)
                    plane_intensities = [float(plane_vals[k].get(val_field, 0.0)) for k in plane_keys]
                    plane_errors = [float(plane_vals[k].get(err_field, 0.02 * plane_vals[k].get(val_field, 0.0) if plane_vals[k].get(val_field, 0.0) else 1.0)) for k in plane_keys]
                    cs_val = float(p_entry.get("center_x_ppm" if is_1h else "center_y_ppm") or p_entry.get("X_PPM" if is_1h else "Y_PPM") or 0.0)
                    items_to_process.append((res_raw, plane_intensities, plane_errors, cs_val, None, None))

            max_planes = max((len(p_ints) for _, p_ints, _, _, _, _ in items_to_process), default=0)
            if len(ncycs) < max_planes:
                default_ncycs = [0.0, 2.0, 4.0, 6.0, 8.0, 10.0, 12.0, 14.0, 16.0, 20.0, 24.0, 28.0, 32.0]
                ncycs = default_ncycs[:max_planes] if max_planes <= len(default_ncycs) else [float(i * 2) for i in range(max_planes)]

            for res_raw, intensities, uncertainties, cs_val, rnum_hint, rname_hint in items_to_process:
                parsed = SpinSystemKey.parse(res_raw)
                rnum = parsed.res_num or (int(rnum_hint) if rnum_hint and str(rnum_hint).isdigit() else 0)
                sym = parsed.symbol or (AA_MAP.get(str(rname_hint).upper(), "") if rname_hint else "")

                if rnum > 0:
                    if parsed.spins and len(parsed.spins) > 1:
                        residue_label = parsed.short
                        full_residue_label = parsed.short
                    elif is_1h:
                        residue_label = f"{rnum}HN"
                        full_residue_label = f"{rnum}HN"
                    elif "13c" in (selected_module or "").lower():
                        residue_label = f"{rnum}C"
                        full_residue_label = f"{rnum}C"
                    else:
                        residue_label = f"{rnum}N"
                        full_residue_label = f"{rnum}N"
                else:
                    residue_label = parsed.canonical or res_raw
                    full_residue_label = residue_label

                spin_key = residue_label

                if res_raw in excluded_residues or spin_key in excluded_residues or full_residue_label in excluded_residues:
                    continue

                if not intensities or len(intensities) < 2:
                    continue

                cur_ncycs = ncycs[:len(intensities)]
                if len(cur_ncycs) < len(intensities):
                    intensities = intensities[:len(cur_ncycs)]
                    uncertainties = uncertainties[:len(cur_ncycs)]

                # For RC-CPMG (and other relaxation-compensated modules requiring even ncycs),
                # automatically filter out odd cycle points
                is_rc = "rc" in (selected_module or "").lower() or selected_module == "cpmg_15n_rc"
                if is_rc:
                    filtered_points = [
                        (ncyc_v, i_v, e_v)
                        for ncyc_v, i_v, e_v in zip(cur_ncycs, intensities, uncertainties)
                        if int(round(ncyc_v)) % 2 == 0
                    ]
                    if len(filtered_points) >= 2:
                        cur_ncycs = [p[0] for p in filtered_points]
                        intensities = [p[1] for p in filtered_points]
                        uncertainties = [p[2] for p in filtered_points]

                # Write data file
                dat_filename = f"{spin_key}_{b0_val:.0f}MHz.dat"
                dat_path = os.path.join(data_dir, dat_filename)

                with open(dat_path, "w") as f:
                    f.write("# ncyc    intensity    uncertainty\n")
                    for ncyc_v, i_v, e_v in zip(cur_ncycs, intensities, uncertainties):
                        f.write(f"{ncyc_v:8.1f}  {i_v:14.4f}  {e_v:14.4f}\n")

                total_data_files += 1
                exp_profiles.setdefault(spin_key, []).append(dat_filename)

                # Calculate R2eff & Rex for inspection
                r2_res = compute_r2eff_profile(cur_ncycs, intensities, uncertainties, t2)
                rex_res = compute_rex_and_flatness(r2_res["nu_cpmg"], r2_res["r2eff"], r2_res["r2eff_err"])

                all_profiles_by_res.setdefault(spin_key, {
                    "residue": spin_key,
                    "full_residue": full_residue_label,
                    "cs_a": cs_val,
                    "experiments": [],
                })
                if cs_val > 0:
                    all_profiles_by_res[spin_key]["cs_a"] = cs_val
                all_profiles_by_res[spin_key]["experiments"].append({
                    "b0": b0_val,
                    "time_t2": t2,
                    "carrier": carr,
                    "nu_cpmg": r2_res["nu_cpmg"],
                    "r2eff": r2_res["r2eff"],
                    "r2eff_err": r2_res["r2eff_err"],
                    "rex": rex_res["rex"],
                    "rex_err": rex_res["rex_err"],
                    "chi2_red": rex_res["chi2_red"],
                    "is_flat": rex_res["is_flat"],
                })

        # Write experiment TOML for this B0
        exp_filename = f"exp_{b0_val:.0f}MHz.toml"
        exp_path = os.path.join(experiments_dir, exp_filename)

        lines = [
            "[experiment]",
            f'name = "{selected_module}"',
            f"time_t2 = {time_t2_req}",
        ]
        if selected_module != "cpmg_ch3_mq":
            if "carrier_h" in meta.get("flags", []) or "carrier_h" in request:
                lines.append(f'carrier_h = {request.get("carrier_h", 8.5)}')
                lines.append(f'carrier_n = {request.get("carrier_n", 117.0)}')
                lines.append(f'pw90_h = {request.get("pw90_h", 10.0e-6)}')
                lines.append(f'pw90_n = {request.get("pw90_n", 35.0e-6)}')
            else:
                lines.append(f"carrier = {carrier_req}")
                lines.append(f"pw90 = {pw90_req}")

        # Module-specific options
        if selected_module == "cpmg_15n_rc" or "taub" in request:
            taub_val = request.get("taub", 2.68e-3)
            lines.append(f"taub = {float(taub_val)}")
        if "antitrosy" in request and request.get("antitrosy"):
            lines.append(f"antitrosy = {str(request['antitrosy']).lower()}")
        if "t_zeta" in request:
            lines.append(f"t_zeta = {request['t_zeta']}")
        if "small_protein" in request and request.get("small_protein"):
            lines.append(f"small_protein = {str(request['small_protein']).lower()}")
        if selected_module == "cpmg_15n_rc" or "0013" in selected_module or "ncyc_max" in request:
            is_rc = "rc" in (selected_module or "").lower() or selected_module == "cpmg_15n_rc"
            even_ncycs = [c for c in ncycs if (int(round(c)) % 2 == 0 if is_rc else True)]
            max_c = max(even_ncycs) if even_ncycs and max(even_ncycs) > 0 else 20
            ncyc_val = request.get("ncyc_max") or max_c
            lines.append(f"ncyc_max = {int(ncyc_val)}")
        if "dq_flg" in request and request.get("dq_flg"):
            lines.append(f"dq_flg = {str(request['dq_flg']).lower()}")

        lines.extend([
            "",
            "[conditions]",
            f"h_larmor_frq = {b0_val}",
            "",
            "[data]",
            'path = "../data"',
            f'error = "{data_error}"',
            "[data.profiles]",
        ])
        for s_key, f_list in sorted(exp_profiles.items()):
            files_str = ", ".join(f'"{fn}"' for fn in f_list)
            lines.append(f'"{s_key}" = [{files_str}]')

        toml_content_str = "\n".join(lines) + "\n"
        with open(exp_path, "w") as f:
            f.write(toml_content_str)

        experiment_tomls.append({
            "b0": b0_val,
            "path": exp_path,
            "filename": exp_filename,
            "profiles_count": len(exp_profiles),
            "toml_content": toml_content_str,
        })

    if total_data_files == 0 or len(experiment_tomls) == 0:
        error_detail = "Failed to generate CPMG data files. " + "; ".join(skipped_reasons) if skipped_reasons else "No valid peaks or profiles found in the selected CPMG spectra."
        raise HTTPException(status_code=400, detail=error_detail)

    # Prepare profiles list with estimated dw seeds
    profiles_list = list(all_profiles_by_res.values())
    for prof in profiles_list:
        max_rex = max((e["rex"] for e in prof["experiments"]), default=0.0)
        prof["overall_rex"] = max_rex
        prof["estimated_dw"] = estimate_delta_omega_fast_exchange(
            rex=max_rex,
            kex=500.0,
            pb=0.05,
            b0_mhz=prof["experiments"][0]["b0"] if prof["experiments"] else 600.0,
            xi_ratio=xi_ratio,
        )

    # Save cpmg_config.json
    cpmg_cfg = {
        "experiments": experiment_tomls,
        "profiles": profiles_list,
        "selected_module": selected_module,
        "time_t2": time_t2_req,
        "carrier": carrier_req,
        "pw90": pw90_req,
        "data_error": data_error,
        "use_height": use_height,
        "excluded_residues": list(excluded_residues),
        "total_data_files": total_data_files,
        "experiments_dir": experiments_dir,
        "data_dir": data_dir,
        "residue_mapping": {p["residue"]: p.get("full_residue", p["residue"]) for p in profiles_list},
    }
    config_path = os.path.join(run_dir, "cpmg_config.json")
    with open(config_path, "w") as f:
        json.dump(cpmg_cfg, f, indent=2)

    params = json.loads(analysis.parameters) if analysis.parameters else {}
    params["cpmg_config_path"] = config_path
    analysis.parameters = json.dumps(params)
    db.commit()

    return {
        "status": "success",
        "total_data_files": total_data_files,
        "experiments": experiment_tomls,
        "profiles": profiles_list,
        "residue_mapping": {p["residue"]: p.get("full_residue", p["residue"]) for p in profiles_list},
        "warnings": warnings,
    }



@router.get("/{analysis_uuid}/cpmg/profiles")
def get_cpmg_profiles(
    analysis: models.Analysis = Depends(get_analysis),
    current_user: models.User = Depends(security.get_current_user),
):
    """
    Retrieve calculated dispersion profiles for the inspection tab.
    """
    project = analysis.project
    run_dir = os.path.join(project.local_directory_path, "cpmg_fitting", analysis.analysis_uuid)
    config_path = os.path.join(run_dir, "cpmg_config.json")
    if os.path.exists(config_path):
        try:
            with open(config_path, "r") as f:
                cfg = json.load(f)
            if "profiles" in cfg:
                return {"profiles": cfg["profiles"]}
        except Exception:
            pass
    return {"profiles": []}


@router.get("/{analysis_uuid}/cpmg/diagnostics")
def get_cpmg_diagnostics(
    analysis: models.Analysis = Depends(get_analysis),
    current_user: models.User = Depends(security.get_current_user),
):
    """
    Calculate identifiability diagnostics for CPMG fitting results.
    """
    project = analysis.project
    run_dir = os.path.join(project.local_directory_path, "cpmg_fitting", analysis.analysis_uuid)
    results_path = os.path.join(run_dir, "results.json")

    if not os.path.exists(results_path):
        return {"warnings": [], "regimes": {}, "fast_exchange_count": 0, "total_residues": 0}

    try:
        with open(results_path, "r") as f:
            res_data = json.load(f)
        global_params = res_data.get("global_parameters", {})
        residue_params = res_data.get("residues", {})
        num_fields = len(res_data.get("experiments", [1]))
        return evaluate_cpmg_identifiability(global_params, residue_params, num_fields=num_fields)
    except Exception as e:
        return {"error": str(e), "warnings": [], "regimes": {}}


@router.get("/{analysis_uuid}/cpmg/logs")
def get_cpmg_logs(
    analysis: models.Analysis = Depends(get_analysis),
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(security.get_current_user),
):
    """Return the live log content from the ChemEx CPMG run."""
    db.refresh(analysis)
    if not analysis.log_path or not os.path.exists(analysis.log_path):
        return {"logs": "", "status": analysis.status}

    with open(analysis.log_path, "r") as f:
        logs = f.read()

    return {"logs": logs, "status": analysis.status}


@router.get("/{analysis_uuid}/cpmg/method-parameters")
def get_cpmg_method_parameters(
    model: str = "2st",
    analysis: models.Analysis = Depends(get_analysis),
    current_user: models.User = Depends(security.get_current_user),
):
    """
    Return parameter definitions, glosses, and metadata for CPMG fitting in ChemEx.
    """
    # Base parameters available for 2-state models
    params_2st = [
        {
            "name": "PB",
            "gloss": "Population of minor state B (0 - 0.5)",
            "scope": "global",
            "default_mode": "default",
            "default_bounds": "< 0.5",
            "category": "kinetic",
            "is_primary": True,
        },
        {
            "name": "KEX_AB",
            "gloss": "Exchange rate between states A and B (s⁻¹)",
            "scope": "global",
            "default_mode": "default",
            "category": "kinetic",
            "is_primary": True,
        },
        {
            "name": "CS_A",
            "gloss": "Chemical shift of major ground state A (ppm)",
            "scope": "residue",
            "default_mode": "default",
            "category": "chemical_shift",
            "is_primary": True,
        },
        {
            "name": "DW_AB",
            "gloss": "Chemical shift difference between states B and A: CS_B - CS_A (ppm)",
            "scope": "residue",
            "default_mode": "default",
            "category": "chemical_shift",
            "is_primary": True,
        },
        {
            "name": "R1_A",
            "gloss": "Longitudinal relaxation rate of state A (s⁻¹)",
            "scope": "residue",
            "default_mode": "default",
            "category": "relaxation",
            "is_primary": True,
        },
        {
            "name": "R2_A",
            "gloss": "Transverse relaxation rate of state A (s⁻¹)",
            "scope": "residue",
            "default_mode": "default",
            "category": "relaxation",
            "is_primary": True,
        },
        {
            "name": "R1_B",
            "gloss": "Longitudinal relaxation rate of state B (s⁻¹)",
            "scope": "residue",
            "default_mode": "default",
            "default_expression": "[R1_A]",
            "category": "relaxation",
            "is_primary": True,
        },
        {
            "name": "R2_B",
            "gloss": "Transverse relaxation rate of state B (s⁻¹)",
            "scope": "residue",
            "default_mode": "default",
            "default_expression": "[R2_A]",
            "category": "relaxation",
            "is_primary": True,
        },
        {
            "name": "TAUC_A",
            "gloss": "Rotational correlation time of state A (ns)",
            "scope": "global",
            "default_mode": "default",
            "category": "hydrodynamic",
            "is_primary": False,
        },
    ]

    # Parameters for 3-state models
    params_3st = [
        {
            "name": "PB",
            "gloss": "Population of state B (0 - 1)",
            "scope": "global",
            "default_mode": "default",
            "category": "kinetic",
            "is_primary": True,
        },
        {
            "name": "PC",
            "gloss": "Population of state C (0 - 1)",
            "scope": "global",
            "default_mode": "default",
            "category": "kinetic",
            "is_primary": True,
        },
        {
            "name": "KEX_AB",
            "gloss": "Exchange rate between states A and B (s⁻¹)",
            "scope": "global",
            "default_mode": "default",
            "category": "kinetic",
            "is_primary": True,
        },
        {
            "name": "KEX_AC",
            "gloss": "Exchange rate between states A and C (s⁻¹)",
            "scope": "global",
            "default_mode": "default",
            "category": "kinetic",
            "is_primary": True,
        },
        {
            "name": "KEX_BC",
            "gloss": "Exchange rate between states B and C (s⁻¹)",
            "scope": "global",
            "default_mode": "default",
            "category": "kinetic",
            "is_primary": False,
        },
        {
            "name": "CS_A",
            "gloss": "Chemical shift of major state A (ppm)",
            "scope": "residue",
            "default_mode": "default",
            "category": "chemical_shift",
            "is_primary": True,
        },
        {
            "name": "DW_AB",
            "gloss": "Chemical shift difference CS_B - CS_A (ppm)",
            "scope": "residue",
            "default_mode": "default",
            "category": "chemical_shift",
            "is_primary": True,
        },
        {
            "name": "DW_AC",
            "gloss": "Chemical shift difference CS_C - CS_A (ppm)",
            "scope": "residue",
            "default_mode": "default",
            "category": "chemical_shift",
            "is_primary": True,
        },
        {
            "name": "R1_A",
            "gloss": "Longitudinal relaxation rate of state A (s⁻¹)",
            "scope": "residue",
            "default_mode": "default",
            "category": "relaxation",
            "is_primary": True,
        },
        {
            "name": "R2_A",
            "gloss": "Transverse relaxation rate of state A (s⁻¹)",
            "scope": "residue",
            "default_mode": "default",
            "category": "relaxation",
            "is_primary": True,
        },
        {
            "name": "R1_B",
            "gloss": "Longitudinal relaxation rate of state B (s⁻¹)",
            "scope": "residue",
            "default_mode": "default",
            "default_expression": "[R1_A]",
            "category": "relaxation",
            "is_primary": True,
        },
        {
            "name": "R2_B",
            "gloss": "Transverse relaxation rate of state B (s⁻¹)",
            "scope": "residue",
            "default_mode": "default",
            "default_expression": "[R2_A]",
            "category": "relaxation",
            "is_primary": True,
        },
        {
            "name": "R1_C",
            "gloss": "Longitudinal relaxation rate of state C (s⁻¹)",
            "scope": "residue",
            "default_mode": "default",
            "default_expression": "[R1_A]",
            "category": "relaxation",
            "is_primary": True,
        },
        {
            "name": "R2_C",
            "gloss": "Transverse relaxation rate of state C (s⁻¹)",
            "scope": "residue",
            "default_mode": "default",
            "default_expression": "[R2_A]",
            "category": "relaxation",
            "is_primary": True,
        },
        {
            "name": "TAUC_A",
            "gloss": "Rotational correlation time of state A (ns)",
            "scope": "global",
            "default_mode": "default",
            "category": "hydrodynamic",
            "is_primary": False,
        },
    ]

    model_clean = (model or "2st").lower()
    if "3st" in model_clean or "3" in model_clean:
        return {"model": model, "parameters": params_3st}

    return {"model": model, "parameters": params_2st}



@router.post("/{analysis_uuid}/cpmg/run")

def run_cpmg_analysis(
    request: dict,
    analysis: models.Analysis = Depends(get_analysis),
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(security.get_current_user),
):
    """
    Launch a ChemEx CPMG fitting job.
    """
    from ..services.fitting.cpmg_tasks import run_cpmg_analysis_task
    import uuid

    project = analysis.project
    run_dir = os.path.join(project.local_directory_path, "cpmg_fitting", analysis.analysis_uuid)
    os.makedirs(run_dir, exist_ok=True)

    config_path = os.path.join(run_dir, "cpmg_config.json")
    existing_config = {}
    if os.path.exists(config_path):
        try:
            with open(config_path, "r") as f:
                existing_config = json.load(f)
        except Exception:
            pass

    existing_config.update(request)
    with open(config_path, "w") as f:
        json.dump(existing_config, f, indent=2)

    analysis.log_path = os.path.join(run_dir, "chemex.log")
    analysis.results_path = os.path.join(run_dir, "results.json")
    analysis.status = "PENDING"

    task_id = str(uuid.uuid4())
    params = json.loads(analysis.parameters) if analysis.parameters else {}
    params["cpmg_config_path"] = config_path
    params["task_id"] = task_id
    analysis.parameters = json.dumps(params)
    db.commit()

    run_cpmg_analysis_task.apply_async(
        args=[analysis.analysis_uuid, existing_config],
        task_id=task_id,
    )

    return {"message": "CPMG analysis started", "analysis_uuid": analysis.analysis_uuid, "task_id": task_id, "status": "PENDING"}


@router.post("/{analysis_uuid}/cpmg/stop")
@router.post("/{analysis_uuid}/cancel")
def stop_cpmg_analysis(
    analysis: models.Analysis = Depends(get_analysis),
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(security.get_current_user),
):
    """Terminate a running CPMG fitting job inside its ephemeral container."""
    from ...celery_app import celery_app
    from datetime import datetime

    if analysis.status not in ["RUNNING", "PENDING"]:
        return {"message": f"Analysis is already in {analysis.status} state"}

    # 1. Terminate Celery task if recorded
    task_id = analysis.celery_task_id
    if not task_id and analysis.parameters:
        try:
            params = json.loads(analysis.parameters)
            task_id = params.get("task_id")
        except Exception:
            pass
    if task_id:
        try:
            celery_app.control.revoke(task_id, terminate=True, signal="SIGTERM")
        except Exception:
            pass

    # 2. Terminate ChemEx ephemeral container
    from ..services.fitting.chemex_runner import cancel_chemex_job
    cancel_chemex_job(analysis.analysis_uuid)

    # 3. Update analysis status
    analysis.cancel_requested = True
    analysis.status = "CANCELLED"
    analysis.error_message = "Cancelled by user"
    analysis.completed_at = datetime.utcnow()
    db.commit()

    if analysis.log_path and os.path.exists(analysis.log_path):
        try:
            with open(analysis.log_path, "a") as f:
                f.write(f"\n\n{'=' * 60}\n")
                f.write(f"ANALYSIS CANCELLED BY USER AT: {datetime.utcnow().isoformat()}\n")
                f.write(f"{'=' * 60}\n")
        except Exception:
            pass

    return {"message": "Analysis cancelled successfully", "status": "CANCELLED"}

