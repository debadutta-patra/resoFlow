import re

with open("backend/app/routers/cpmg.py", "r") as f:
    content = f.read()

bad_return = """    return {"profiles": profiles_list}"""

good_return = """
    params = json.loads(analysis.parameters) if analysis.parameters else {}
    params["cpmg_config_path"] = config_path
    analysis.parameters = json.dumps(params)
    db.commit()

    return {
        "status": "success",
        "total_data_files": sum([e.get("profiles_count", 0) for e in experiment_tomls]),
        "experiments": experiment_tomls,
        "profiles": profiles_list,
        "residue_mapping": {p["residue"]: p.get("full_residue", p["residue"]) for p in profiles_list},
        "warnings": [],
    }
"""
content = content.replace(bad_return, good_return)

with open("backend/app/routers/cpmg.py", "w") as f:
    f.write(content)
