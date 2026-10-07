import os
import json
import hashlib
from typing import Dict, Any, List
from .models import GeneratedExperiment
from ..spin_system import SpinSystemKey
from ..chemex_registry import MODULE_METADATA
from ..cpmg_reduction import compute_r2eff_profile, compute_rex_and_flatness, estimate_delta_omega_fast_exchange

def build_cpmg_experiment(
    block_settings: Dict[str, Any],
    spectrum: Any,
    out_data_dir: str,
    toml_path: str,
    include: List[str],
    exclude: List[str]
) -> GeneratedExperiment:
    """Build a CPMG experiment (one spectrum -> one block)."""
    b0_val = getattr(spectrum, "b0", None)
    if b0_val is None:
        raise ValueError(f"Spectrum '{spectrum.name}' is missing B0 (static field)")

    t2 = getattr(spectrum, "t_relax", None)
    if t2 is None or t2 <= 0:
        # Fallback to the block setting if missing, but typically we want spectrum's t_relax
        t2 = float(block_settings.get("time_t2", 0.04))

    carr = getattr(spectrum, "carrier", None)
    if carr is None:
        carr = float(block_settings.get("carrier", 117.0))

    if not getattr(spectrum, "results_json_path", None) or not os.path.exists(spectrum.results_json_path):
        raise ValueError(f"Spectrum '{spectrum.name}' peak fitting results not found")

    selected_module = block_settings.get("module_name", "cpmg_15n_ip")
    meta = MODULE_METADATA.get(selected_module, {})
    xi_ratio = meta.get("xi_ratio", 0.101329118)

    use_height = block_settings.get("use_height", True)
    val_field = "height" if use_height else "amp"
    err_field = "height_err" if use_height else "amp_err"

    raw_vals = []
    is_vdlist = False
    list_path = None

    if getattr(spectrum, "vdlist_path", None) and os.path.exists(spectrum.vdlist_path):
        list_path = spectrum.vdlist_path
        is_vdlist = True
    elif getattr(spectrum, "vclist_path", None) and os.path.exists(spectrum.vclist_path):
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

    ncycs = []
    if raw_vals:
        max_val = max(raw_vals)
        if is_vdlist or max_val > 80.0:
            for v in raw_vals:
                if abs(v) < 1e-6:
                    ncycs.append(0.0)
                elif v >= 1.0:
                    ncycs.append(float(round(v * t2)))
                else:
                    nu = 1.0 / (4.0 * v) if v > 0 else 0.0
                    ncycs.append(float(round(nu * t2)))
        else:
            ncycs = [float(round(v)) for v in raw_vals]

    is_1h = any(k in selected_module.lower() for k in ["1h", "hn", "methyl_1h", "ch3"])
    AA_MAP = {
        'ALA': 'A', 'ARG': 'R', 'ASN': 'N', 'ASP': 'D', 'CYS': 'C',
        'GLU': 'E', 'GLN': 'Q', 'GLY': 'G', 'HIS': 'H', 'ILE': 'I',
        'LEU': 'L', 'LYS': 'K', 'MET': 'M', 'PHE': 'F', 'PRO': 'P',
        'SER': 'S', 'THR': 'T', 'TRP': 'W', 'TYR': 'Y', 'VAL': 'V'
    }

    with open(spectrum.results_json_path, "r") as f:
        fit_data = json.load(f)

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

    parsed_exclusions = [SpinSystemKey.parse(str(r)) for r in exclude]
    excluded_nums = {sp.res_num for sp in parsed_exclusions if sp.res_num > 0}
    excluded_canonical = {sp.canonical.upper() for sp in parsed_exclusions if sp.canonical}
    excluded_raw = {str(r).strip().upper() for r in exclude}

    parsed_inclusions = [SpinSystemKey.parse(str(r)) for r in include] if include else []
    included_nums = {sp.res_num for sp in parsed_inclusions if sp.res_num > 0}
    included_canonical = {sp.canonical.upper() for sp in parsed_inclusions if sp.canonical}
    included_raw = {str(r).strip().upper() for r in include}

    def is_res_excluded(res_str: str) -> bool:
        if res_str.upper() in excluded_raw:
            return True
        sp = SpinSystemKey.parse(res_str)
        if sp.canonical and sp.canonical.upper() in excluded_canonical:
            return True
        if sp.res_num and sp.res_num in excluded_nums:
            return True
        if include:
            if res_str.upper() in included_raw:
                return False
            if sp.canonical and sp.canonical.upper() in included_canonical:
                return False
            if sp.res_num and sp.res_num in included_nums:
                return False
            return True
        return False

    os.makedirs(out_data_dir, exist_ok=True)
    os.makedirs(os.path.dirname(toml_path), exist_ok=True)

    written_data_files = {}
    inspection_profiles = []
    exp_profiles = {}

    for res_raw, intensities, uncertainties, cs_val, rnum_hint, rname_hint in items_to_process:
        parsed = SpinSystemKey.parse(res_raw)
        rnum = parsed.res_num or (int(rnum_hint) if rnum_hint and str(rnum_hint).isdigit() else 0)
        
        if rnum > 0:
            if parsed.spins and len(parsed.spins) > 1:
                residue_label = parsed.short
                full_residue_label = parsed.short
            elif is_1h:
                residue_label = f"{rnum}HN"
                full_residue_label = f"{rnum}HN"
            elif "13c" in selected_module.lower():
                residue_label = f"{rnum}C"
                full_residue_label = f"{rnum}C"
            else:
                residue_label = f"{rnum}N"
                full_residue_label = f"{rnum}N"
        else:
            residue_label = parsed.canonical or res_raw
            full_residue_label = residue_label

        spin_key = residue_label

        if not intensities or len(intensities) < 2:
            continue

        cur_ncycs = ncycs[:len(intensities)]
        if len(cur_ncycs) < len(intensities):
            intensities = intensities[:len(cur_ncycs)]
            uncertainties = uncertainties[:len(cur_ncycs)]

        is_rc = "rc" in selected_module.lower() or selected_module == "cpmg_15n_rc"
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

        # Name based on spectrum ID to avoid collisions
        dat_filename = f"{spin_key}_{b0_val:.0f}MHz_{spectrum.id}.dat"
        dat_path = os.path.join(out_data_dir, dat_filename)

        with open(dat_path, "w") as f:
            f.write("# ncyc    intensity    uncertainty\n")
            for ncyc_v, i_v, e_v in zip(cur_ncycs, intensities, uncertainties):
                f.write(f"{ncyc_v:8.1f}  {i_v:14.4f}  {e_v:14.4f}\n")

        written_data_files[spin_key] = dat_path
        
        if not is_res_excluded(spin_key):
            exp_profiles.setdefault(spin_key, []).append(dat_filename)

        r2_res = compute_r2eff_profile(cur_ncycs, intensities, uncertainties, t2)
        rex_res = compute_rex_and_flatness(r2_res["nu_cpmg"], r2_res["r2eff"], r2_res["r2eff_err"])
        est_dw = estimate_delta_omega_fast_exchange(
            rex=rex_res["rex"],
            kex=500.0,
            pb=0.05,
            b0_mhz=b0_val,
            xi_ratio=xi_ratio
        )

        inspection_profiles.append({
            "residue": spin_key,
            "full_residue": full_residue_label,
            "cs_a": cs_val,
            "overall_rex": rex_res["rex"],
            "estimated_dw": est_dw,
            "experiments": [{
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
            }]
        })

    data_error = block_settings.get("data_error", "duplicates")
    lines = [
        "[experiment]",
        f'name = "{selected_module}"',
        f"time_t2 = {t2}", # Use spectrum's t2
    ]

    pw90_req = float(block_settings.get("pw90", 35.0e-6))
    if selected_module != "cpmg_ch3_mq":
        if "carrier_h" in meta.get("flags", []) or "carrier_h" in block_settings:
            lines.append(f'carrier_h = {block_settings.get("carrier_h", 8.5)}')
            lines.append(f'carrier_n = {block_settings.get("carrier_n", 117.0)}')
            lines.append(f'pw90_h = {block_settings.get("pw90_h", 10.0e-6)}')
            lines.append(f'pw90_n = {block_settings.get("pw90_n", 35.0e-6)}')
        else:
            lines.append(f"carrier = {carr}") # Use spectrum's carrier
            lines.append(f"pw90 = {pw90_req}")

    if selected_module == "cpmg_15n_rc" or "taub" in block_settings:
        taub_val = block_settings.get("taub", 2.68e-3)
        lines.append(f"taub = {float(taub_val)}")
    if "antitrosy" in block_settings and block_settings.get("antitrosy"):
        lines.append(f"antitrosy = {str(block_settings['antitrosy']).lower()}")
    if "t_zeta" in block_settings:
        lines.append(f"t_zeta = {block_settings['t_zeta']}")
    if "small_protein" in block_settings and block_settings.get("small_protein"):
        lines.append(f"small_protein = {str(block_settings['small_protein']).lower()}")
    
    if selected_module == "cpmg_15n_rc" or "0013" in selected_module or "ncyc_max" in block_settings:
        is_rc = "rc" in selected_module.lower() or selected_module == "cpmg_15n_rc"
        even_ncycs = [c for c in ncycs if (int(round(c)) % 2 == 0 if is_rc else True)]
        max_c = max(even_ncycs) if even_ncycs and max(even_ncycs) > 0 else 20
        ncyc_val = block_settings.get("ncyc_max") or max_c
        lines.append(f"ncyc_max = {int(ncyc_val)}")
    if "dq_flg" in block_settings and block_settings.get("dq_flg"):
        lines.append(f"dq_flg = {str(block_settings['dq_flg']).lower()}")

    rel_data_path = os.path.relpath(out_data_dir, os.path.dirname(toml_path)).replace("\\", "/")

    lines.extend([
        "",
        "[conditions]",
        f"h_larmor_frq = {b0_val}",
        "",
        "[data]",
        f'path = "{rel_data_path}"',
        f'error = "{data_error}"',
        "[data.profiles]",
    ])
    for s_key, f_list in sorted(exp_profiles.items()):
        files_str = ", ".join(f'"{fn}"' for fn in f_list)
        lines.append(f'"{s_key}" = [{files_str}]')

    toml_content_str = "\n".join(lines) + "\n"
    with open(toml_path, "w") as f:
        f.write(toml_content_str)

    hasher = hashlib.sha256()
    hasher.update(toml_content_str.encode())
    settings_hash = hasher.hexdigest()

    return GeneratedExperiment(
        toml_content=toml_content_str,
        written_data_files=written_data_files,
        inspection_profiles=inspection_profiles,
        settings_hash=settings_hash
    )
