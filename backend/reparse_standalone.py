import os
import json
import toml
import re

def parse_plot(filepath):
    data_by_res = {}
    curr = None
    if not os.path.exists(filepath): return data_by_res
    try:
        with open(filepath, "r") as pf:
            for line in pf:
                line = line.strip()
                if not line or line.startswith("#"): continue
                if line.startswith("[") and line.endswith("]"):
                    curr = line[1:-1]
                    data_by_res[curr] = {"x":[], "y":[]}
                elif curr:
                    pts = line.split()
                    if len(pts) >= 2:
                        try:
                            data_by_res[curr]["x"].append(float(pts[0]))
                            data_by_res[curr]["y"].append(float(pts[1]))
                        except (ValueError, IndexError):
                             continue
                elif not line.startswith("#"):
                    # Individual plot (no header)
                    # We might need to know the residue from the context
                    pass
    except Exception: pass
    return data_by_res

def parse_individual_plot(filepath):
    pts = {"x":[], "y":[]}
    try:
        with open(filepath, "r") as f:
             for line in f:
                line = line.strip()
                if not line or line.startswith("#") or line.startswith("["): continue
                parts = line.split()
                if len(parts) >= 2:
                    pts["x"].append(float(parts[0]))
                    pts["y"].append(float(parts[1]))
    except: pass
    return pts

def reparse():
    analysis_dir = "/home/debadutta/Documents/drb2d1_relaxation/high_conc/drb2d1/cest_fitting/785a5349-2366-43df-acc4-fb51a44a03af"
    output_dir = os.path.join(analysis_dir, "Output")
    
    results = {
        "global": {},
        "residues": {},
        "fit_mode": "global",
        "output_files": []
    }

    # 1. Discovery
    residue_folders = [d for d in os.listdir(output_dir) if os.path.isdir(os.path.join(output_dir, d)) 
                       and (re.match(r'^\d+[A-Z]?$', d) or re.match(r'^[A-Za-z]\d+[A-Z]?(-HN)?$', d))]
    
    if residue_folders:
        results["fit_mode"] = "individual"

    # 2. Harvest Params
    def harvest(toml_path, target_dict, res_label=None):
        if not os.path.exists(toml_path): return
        try:
            with open(toml_path, "r") as tf:
                data = toml.load(tf)
            
            # Simple global params (chi2)
            for k, v in data.items():
                if not isinstance(v, dict):
                    ku = k.upper()
                    if "CHI2" in ku or "CHI-SQUARE" in ku:
                        key = "chi2" if "REDUCED" not in ku else "chi2_red"
                        target_dict[key] = v

            # Nested sections
            for section_name, section_data in data.items():
                if not isinstance(section_data, dict): continue
                upper_section = section_name.upper()

                # Global kinetics
                if upper_section in ["GLOBAL", "PB", "KEX_AB"]:
                    for k, v in section_data.items():
                        ku = k.upper()
                        if ku in ["PB", "PB_AB"]: target_dict["pb"] = v
                        if ku in ["KEX", "KEX_AB"]: target_dict["kex_ab"] = v
                
                # Residue parameters (R1, R2, CS, DW)
                matched_key = None
                for p_prefix in ["CS_A", "DW_AB", "DW_AC", "CS_B", "CS_C", "R1_A", "R2_A", "R2_B", "R1", "R2"]:
                    if upper_section == p_prefix or upper_section.startswith(p_prefix + ","):
                        matched_key = p_prefix.lower()
                        break
                
                if matched_key:
                    for k, v in section_data.items():
                        if res_label:
                            if k == res_label: target_dict[matched_key] = v
                        else:
                            # Global mode discovery
                            if k not in results["residues"]:
                                results["residues"][k] = {"parameters": {}, "experiments": []}
                            results["residues"][k]["parameters"][matched_key] = v
        except Exception as e:
            print(f"Error harvesting {toml_path}: {e}")

    # A. Root Params
    for root_f in ["parameters.toml", "fixed.toml", "constrained.toml", "fitted.toml", "statistics.toml"]:
        search_paths = [
            output_dir, 
            os.path.join(output_dir, "Parameters"),
            os.path.join(analysis_dir, "Parameters")
        ]
        for root_d in search_paths:
            if os.path.isdir(root_d):
                harvest(os.path.join(root_d, root_f), results["global"])

    # B. B1 Label Discovery
    b1_mapping = {}
    exp_dir = os.path.join(analysis_dir, "Experiments")
    print(f"Checking for experiments in: {exp_dir}")
    if os.path.isdir(exp_dir):
        toml_files = [f for f in os.listdir(exp_dir) if f.endswith(".toml")]
        print(f"Found experiment files: {toml_files}")
        for f in toml_files:
            try:
                with open(os.path.join(exp_dir, f), "r") as tf:
                    exp_data = toml.load(tf)
                    b1_val = exp_data.get("experiment", {}).get("b1_frq")
                    if b1_val:
                        pretty = f"{b1_val} Hz"
                        b1_mapping[f.replace(".toml", "")] = pretty
                        print(f"Mapped {f} -> {pretty}")
                    else:
                        print(f"Warning: No b1_frq found in {f}. Data: {exp_data.get('experiment')}")
            except Exception as e:
                print(f"Error reading {f}: {e}")
    else:
        print(f"Error: Experiments directory NOT FOUND at {exp_dir}")

    # C. Root Plots (Aggregated)
    plot_dirs = [os.path.join(output_dir, "Plots"), os.path.join(output_dir, "Output", "Plots")]
    for p_dir in plot_dirs:
        if not os.path.isdir(p_dir): continue
        for f in os.listdir(p_dir):
            if not (f.endswith(".fit") or f.endswith(".exp") or f.endswith(".obs")): continue
            b1_id = f.replace(".fit", "").replace(".exp", "").replace(".obs", "")
            b1_pretty = b1_mapping.get(b1_id, b1_id)
            
            extracted = parse_plot(os.path.join(p_dir, f))
            
            for res, pts in extracted.items():
                if res not in results["residues"]:
                    results["residues"][res] = {"parameters": {}, "experiments": []}
                
                # Find or create experiment entry
                ex_entry = next((e for e in results["residues"][res]["experiments"] if e["b1_label"] == b1_pretty), None)
                if not ex_entry:
                    ex_entry = {"b1_label": b1_pretty, "fit_curve": {"x":[], "y":[]}, "exp_points": {"x":[], "y":[], "y_err":[]}}
                    results["residues"][res]["experiments"].append(ex_entry)
                
                if f.endswith(".fit"):
                    ex_entry["fit_curve"] = pts
                else:
                    ex_entry["exp_points"] = pts

    # D. Residue Folders (Individual fits or split plots)
    for res in residue_folders:
        res_dir = os.path.join(output_dir, res)
        if res not in results["residues"]:
            results["residues"][res] = {"parameters": {}, "experiments": []}
        
        # Harvest from internal TOMLs
        for pf in ["fitted.toml", "parameters.toml", "statistics.toml", "Parameters/fitted.toml"]:
            harvest(os.path.join(res_dir, pf), results["residues"][res]["parameters"], res)
        
        # Individual plots
        res_p_dir = os.path.join(res_dir, "Plots")
        if not os.path.isdir(res_p_dir): res_p_dir = res_dir
        
        if os.path.isdir(res_p_dir):
            for f in os.listdir(res_p_dir):
                if not (f.endswith(".fit") or f.endswith(".exp") or f.endswith(".obs")): continue
                b1_id = f.replace(".fit", "").replace(".exp", "").replace(".obs", "")
                b1_pretty = b1_mapping.get(b1_id, b1_id)
                
                pts = parse_individual_plot(os.path.join(res_p_dir, f))
                
                ex_entry = next((e for e in results["residues"][res]["experiments"] if e["b1_label"] == b1_pretty), None)
                if not ex_entry:
                    ex_entry = {"b1_label": b1_pretty, "fit_curve": {"x":[], "y":[]}, "exp_points": {"x":[], "y":[], "y_err":[]}}
                    results["residues"][res]["experiments"].append(ex_entry)
                
                if f.endswith(".fit"): ex_entry["fit_curve"] = pts
                else: ex_entry["exp_points"] = pts

    # 3. Final Pass
    final_residues = {}
    for res, r_data in results["residues"].items():
        # Only include residues that have experimental data
        if not r_data["experiments"]:
            continue
            
        p = r_data["parameters"]
        if "cs_a" in p:
            if "dw_ab" in p and "cs_b" not in p: p["cs_b"] = p["cs_a"] + p["dw_ab"]
            if "dw_ab" in p: p["dw"] = p["dw_ab"]
        
        # Propagate global chi2 if missing
        if "chi2" not in p and "chi2" in results["global"]: p["chi2"] = results["global"]["chi2"]
        if "chi2_red" not in p and "chi2_red" in results["global"]: p["chi2_red"] = results["global"]["chi2_red"]
        # Propagate global kinetics if missing
        for gk in ["pb", "kex_ab"]:
            if gk not in p and gk in results["global"]:
                p[gk] = results["global"][gk]
        
        final_residues[res] = r_data

    results["residues"] = final_residues

    with open(os.path.join(analysis_dir, "results.json"), "w") as f:
        json.dump(results, f, indent=2)
    print(f"Reparsed {len(results['residues'])} residues successfully.")

if __name__ == "__main__":
    reparse()
