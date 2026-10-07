import re

with open("backend/app/services/export/zip_export.py", "r") as f:
    content = f.read()

old_loop = """    # Residues
    if resolver.primary_step:
        for res_name in sorted(resolver.primary_step.residues.keys()):
            for p_name in ["cs_a", "cs_b", "dw_ab", "r1_a", "r2_a", "r2_b"]:
                res = resolver.resolve(p_name, res_name)
                if res.status != ParameterStatus.NOT_IN_MODEL:
                    writer.writerow([
                        res.name, res_name, res.value, res.err_low, res.err_high,
                        res.err_low_95, res.err_high_95, res.unit or "", res.status.value,
                        res.source.value, res.flag_reason or "",
                    ])"""

new_loop = """    # Residues
    if resolver.primary_step:
        for res_name in sorted(resolver.primary_step.residues.keys()):
            res_obj = resolver.primary_step.residues[res_name]
            p_names = ["cs_a", "cs_b", "dw_ab", "r1_a", "r2_a", "r2_b"]
            if getattr(res_obj, "parameters", None):
                p_names = sorted(list(res_obj.parameters.keys()))
                
            for p_name in p_names:
                res = resolver.resolve(p_name, res_name)
                if res.status != ParameterStatus.NOT_IN_MODEL:
                    writer.writerow([
                        res.name, res_name, res.value, res.err_low, res.err_high,
                        res.err_low_95, res.err_high_95, res.unit or "", res.status.value,
                        res.source.value, res.flag_reason or "",
                    ])"""

content = content.replace(old_loop, new_loop)
with open("backend/app/services/export/zip_export.py", "w") as f:
    f.write(content)
