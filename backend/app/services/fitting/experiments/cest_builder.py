import os
import json
import hashlib
import numpy as np
from typing import Dict, Any, List, Optional
from .models import GeneratedExperiment
from ..spin_system import SpinSystemKey
from ..chemex_registry import MODULE_METADATA

def _parse_f3list(path: str) -> list:
    values = []
    with open(path, "r") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            try:
                values.append(float(line))
            except ValueError:
                pass
    return values

def build_cest_experiment(
    block_settings: Dict[str, Any],
    spectrum: Any,
    out_data_dir: str,
    toml_path: str,
    include: List[str],
    exclude: List[str]
) -> GeneratedExperiment:
    """Build a CEST experiment (one spectrum -> one block)."""
    b1 = getattr(spectrum, "b1", None)
    b0 = getattr(spectrum, "b0", None)
    carrier = getattr(spectrum, "carrier", None)
    t_relax = getattr(spectrum, "t_relax", None)

    if b1 is None or b0 is None or carrier is None or t_relax is None:
        missing = [k for k, v in {"B1": b1, "B0": b0, "Carrier": carrier, "T_relax": t_relax}.items() if v is None]
        raise ValueError(f"Spectrum '{spectrum.name}' missing parameters: {', '.join(missing)}")

    if not getattr(spectrum, "f3list_path", None) or not os.path.exists(spectrum.f3list_path):
        raise ValueError(f"Spectrum '{spectrum.name}' f3list file not found")

    if not getattr(spectrum, "results_json_path", None) or not os.path.exists(spectrum.results_json_path):
        raise ValueError(f"Spectrum '{spectrum.name}' peak fitting results not found")

    # Get module metadata
    module_name = block_settings.get("module_name", "cest_15n")
    meta = MODULE_METADATA.get(module_name, {})
    xi_ratio = meta.get("xi_ratio", 0.101329118)

    # Calculate Larmor frequency
    larmor_mhz = b0 * xi_ratio

    # Parse f3list
    freq_list_ppm = _parse_f3list(spectrum.f3list_path)
    if not freq_list_ppm:
        raise ValueError(f"Spectrum '{spectrum.name}' f3list is empty or invalid")

    freq_arr = np.array(freq_list_ppm)
    offsets_hz = (freq_arr - carrier) * larmor_mhz

    os.makedirs(out_data_dir, exist_ok=True)
    os.makedirs(os.path.dirname(toml_path), exist_ok=True)

    with open(spectrum.results_json_path, "r") as f:
        fit_data = json.load(f)

    results = fit_data.get("results", [])
    use_height = block_settings.get("use_height", True)
    val_field = "height" if use_height else "amp"
    err_field = "height_err" if use_height else "amp_err"

    assignments = {}
    for peak in results:
        ass = peak.get("assignment")
        if not ass:
            continue
        if ass not in assignments:
            assignments[ass] = {
                "res_num": peak.get("res_num") or peak.get("RES_NUM"),
                "res_name": peak.get("res_name") or peak.get("RES_NAME"),
                "planes": [],
            }
        if "planes" in peak:
            for plane in sorted(peak["planes"], key=lambda p: p.get("plane", 0)):
                assignments[ass]["planes"].append(plane)
        else:
            assignments[ass]["planes"].append(peak)

    AA_MAP = {
        'ALA': 'A', 'ARG': 'R', 'ASN': 'N', 'ASP': 'D', 'CYS': 'C',
        'GLU': 'E', 'GLN': 'Q', 'GLY': 'G', 'HIS': 'H', 'ILE': 'I',
        'LEU': 'L', 'LYS': 'K', 'MET': 'M', 'PHE': 'F', 'PRO': 'P',
        'SER': 'S', 'THR': 'T', 'TRP': 'W', 'TYR': 'Y', 'VAL': 'V'
    }

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
            return True # Not in include list
        return False

    written_data_files = {}
    inspection_profiles = []
    profiles_lines = []

    for ass, data in assignments.items():
        planes = sorted(data["planes"], key=lambda p: p.get("plane", 0))
        plane_offsets = list(offsets_hz)
        if len(planes) > len(plane_offsets):
            num_refs = len(planes) - len(plane_offsets)
            plane_offsets = [-100000.0] * num_refs + plane_offsets
        
        if len(planes) != len(plane_offsets):
            continue

        res_num = data.get("res_num", "")
        res_name = data.get("res_name", "")

        if res_num and res_name:
            res_single = AA_MAP.get(res_name.upper(), res_name)
            full_residue_label = f"{res_single}{res_num}N"
        elif res_num:
            full_residue_label = f"{res_num}N"
        else:
            full_residue_label = ass.replace(" ", "")

        if res_num:
            residue_label = f"{res_num}N"
        else:
            residue_label = full_residue_label

        filename = f"{residue_label}-HN.out"
        filepath = os.path.join(out_data_dir, filename)

        lines = ["#Offset (Hz)        Intensity    Uncertainty"]
        profile_pts = []
        for i, plane in enumerate(planes):
            offset = plane_offsets[i]
            intensity = plane.get(val_field, 0.0)
            uncertainty = plane.get(err_field, 0.0)
            if uncertainty == 0.0:
                uncertainty = abs(intensity) * 0.01
            lines.append(f"  {offset:12.3e}   {intensity:15.7e}  {uncertainty:13.7e}")
            profile_pts.append({"offset": offset, "intensity": intensity, "uncertainty": uncertainty})

        with open(filepath, "w") as f:
            f.write("\n".join(lines) + "\n")

        written_data_files[residue_label] = filepath
        inspection_profiles.append({
            "residue": residue_label,
            "full_residue": full_residue_label,
            "profile": profile_pts
        })

        if is_res_excluded(residue_label):
            profiles_lines.append(f'# {residue_label} = "{filename}"')
        else:
            profiles_lines.append(f'{residue_label} = "{filename}"')

    b1_dist = block_settings.get("b1_distribution", {"type": "dephasing"})
    b1_dist_type = b1_dist.get("type", "dephasing") if isinstance(b1_dist, dict) else "dephasing"
    b1_dist_lines = [f'  [experiment.b1_distribution]', f'  type = "{b1_dist_type}"']
    if isinstance(b1_dist, dict):
        if "scale" in b1_dist and b1_dist["scale"] is not None:
            b1_dist_lines.append(f'  scale = {b1_dist["scale"]}')
        if "res" in b1_dist and b1_dist["res"] is not None:
            b1_dist_lines.append(f'  res = {b1_dist["res"]}')
        if "skew" in b1_dist and b1_dist["skew"] is not None:
            b1_dist_lines.append(f'  skew = {b1_dist["skew"]}')
    b1_dist_section = "\n".join(b1_dist_lines)

    extra_exp_lines = []
    if module_name == "cest_15n_cw":
        carrier_dec = block_settings.get("carrier_dec", 8.5)
        b1_frq_dec = block_settings.get("b1_frq_dec", 2000.0)
        extra_exp_lines.append(f'carrier_dec  = {carrier_dec}')
        extra_exp_lines.append(f'b1_frq_dec   = {b1_frq_dec}')
    elif module_name == "cest_15n_tr":
        antitrosy = block_settings.get("antitrosy", False)
        extra_exp_lines.append(f'antitrosy    = {str(bool(antitrosy)).lower()}')
    elif module_name in ("cest_1hn_ip_ap", "cest_ch3_1h_ip_ap"):
        d1_val = block_settings.get("d1", 1.0)
        taua_val = block_settings.get("taua", 0.002)
        extra_exp_lines.append(f'd1           = {d1_val}')
        extra_exp_lines.append(f'taua         = {taua_val}')
        if module_name == "cest_1hn_ip_ap":
            eta_block = block_settings.get("eta_block", False)
            extra_exp_lines.append(f'eta_block    = {str(bool(eta_block)).lower()}')

    extra_exp_str = ("\n" + "\n".join(extra_exp_lines)) if extra_exp_lines else ""

    filter_offsets = block_settings.get("filter_offsets")
    if filter_offsets is None:
        filter_offsets = [[0.0, float(b1)]]

    filter_planes = block_settings.get("filter_planes")
    data_error = block_settings.get("data_error", "scatter")

    data_filter_lines = [f'error          = "{data_error}"', f'filter_offsets = {json.dumps(filter_offsets)}']
    if filter_planes:
        data_filter_lines.append(f'filter_planes  = {json.dumps(filter_planes)}')
    data_filter_str = "\n".join(data_filter_lines)

    profiles_section = "\n".join(profiles_lines)

    rel_data_path = os.path.relpath(out_data_dir, os.path.dirname(toml_path))
    rel_data_path = rel_data_path.replace("\\", "/")

    exp_toml = f"""[experiment]
name         = "{module_name}"
time_t1      = {t_relax}
carrier      = {carrier}
b1_frq       = {b1}{extra_exp_str}
{b1_dist_section}

[conditions]
h_larmor_frq = {b0}
# temperature = {getattr(spectrum, 'temperature', None) or 298.15}

[data]
path           = "{rel_data_path}"
{data_filter_str}
  [data.profiles]
{profiles_section}
"""
    with open(toml_path, "w") as f:
        f.write(exp_toml)

    hasher = hashlib.sha256()
    hasher.update(exp_toml.encode())
    settings_hash = hasher.hexdigest()

    return GeneratedExperiment(
        toml_content=exp_toml,
        written_data_files=written_data_files,
        inspection_profiles=inspection_profiles,
        settings_hash=settings_hash
    )
