import os
import json
import tomllib
import re
import logging

# Minimal shim to mimic the fixed _parse_chemex_output behavior
def reparse():
    analysis_dir = "/home/debadutta/Documents/drb2d1_relaxation/high_conc/drb2d1/cest_fitting/785a5349-2366-43df-acc4-fb51a44a03af"
    output_dir = os.path.join(analysis_dir, "Output")
    params_dir = os.path.join(output_dir, "Parameters")
    
    results = {
        "analysis_uuid": "785a5349-2366-43df-acc4-fb51a44a03af",
        "timestamp": "2026-04-15",
        "fit_mode": "global", # Explicitly set to global for this fix
        "global": {},
        "residues": {},
        "output_files": []
    }
    
    # 1. Collect output files
    for root, dirs, files in os.walk(output_dir):
        for f in files:
            rel = os.path.relpath(os.path.join(root, f), output_dir)
            results["output_files"].append(rel)

    # 2. Global stats
    stats_path = os.path.join(output_dir, "statistics.toml")
    if os.path.exists(stats_path):
        with open(stats_path, "rb") as f:
            data = tomllib.load(f)
            results["global"]["chi2"] = data.get("chi-square") or data.get("chi2")
            results["global"]["chi2_red"] = data.get("reduced-chi-square") or data.get("chi2_red")

    # 3. Harvest Params from ALL files
    param_files = ["fixed.toml", "constrained.toml", "fitted.toml"]
    for pf in param_files:
        p_path = os.path.join(params_dir, pf)
        if not os.path.exists(p_path): continue
        with open(p_path, "rb") as tf:
            data = tomllib.load(tf)
            for section, section_data in data.items():
                upper = section.upper()
                if isinstance(section_data, dict) and upper in ["CS_A", "DW_AB", "DW_AC", "CS_B", "CS_C", "R1_A", "R2_A", "R2_B"]:
                    for res, val in section_data.items():
                        if res not in results["residues"]:
                            results["residues"][res] = {"parameters": {}, "experiments": []}
                        results["residues"][res]["parameters"][upper.lower()] = val
                
                # Global params if in fitted [GLOBAL]
                if upper == "GLOBAL" and pf == "fitted.toml":
                    for k, v in section_data.items():
                        results["global"][k.lower()] = v

    # 4. Derived calculations
    for res, r_data in results["residues"].items():
        p = r_data["parameters"]
        if "cs_a" in p:
            if "dw_ab" in p and "cs_b" not in p:
                p["cs_b"] = p["cs_a"] + p["dw_ab"]
        # Populate sidebar stats
        if "chi2" not in p and "chi2" in results["global"]: p["chi2"] = results["global"]["chi2"]
        if "chi2_red" not in p and "chi2_red" in results["global"]: p["chi2_red"] = results["global"]["chi2_red"]

    # 5. Aggregate plot files
    def parse_aggregated_plot(filepath):
        p = {}
        curr = None
        if not os.path.exists(filepath): return p
        with open(filepath, "r") as f:
            for line in f:
                line = line.strip()
                if not line: continue
                if line.startswith("["):
                    curr = line[1:-1]
                    p[curr] = {"x": [], "y": []}
                elif curr and not line.startswith("#"):
                    parts = line.split()
                    if len(parts) >= 2:
                        try:
                            p[curr]["x"].append(float(parts[0]))
                            p[curr]["y"].append(float(parts[1]))
                        except: pass
        return p

    plot_dir = os.path.join(output_dir, "Plots")
    if os.path.isdir(plot_dir):
        for f in os.listdir(plot_dir):
            if not (f.endswith(".fit") or f.endswith(".exp")): continue
            b1 = f.replace(".fit", "").replace(".exp", "")
            filepath = os.path.join(plot_dir, f)
            parsed = parse_aggregated_plot(filepath)
            for res, p_data in parsed.items():
                if res in results["residues"]:
                    # Find or create experiment entry
                    found = False
                    for ex in results["residues"][res]["experiments"]:
                        if ex["b1_label"] == b1:
                            if f.endswith(".fit"): ex["fit_curve"] = p_data
                            else: ex["exp_points"] = p_data
                            found = True
                            break
                    if not found:
                        entry = {"b1_label": b1, "fit_curve": {"x":[],"y":[]}, "exp_points": {"x":[],"y":[],"y_err":[]}}
                        if f.endswith(".fit"): entry["fit_curve"] = p_data
                        else: entry["exp_points"] = p_data
                        results["residues"][res]["experiments"].append(entry)

    with open(os.path.join(analysis_dir, "results.json"), "w") as f:
        json.dump(results, f, indent=2)
    print(f"Reparsed successfully. Found {len(results['residues'])} residues.")

if __name__ == "__main__":
    reparse()
