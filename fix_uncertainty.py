with open("backend/app/services/reporting/uncertainty.py", "r") as f:
    content = f.read()

# I want to support case-insensitive matching for res_obj.parameters
old_block = """                elif p_clean.upper() in res_obj.parameters:
                    p_val = res_obj.parameters[p_clean.upper()]
                    value = p_val.value"""

new_block = """                else:
                    # Case-insensitive search in parameters
                    for k, p_val in res_obj.parameters.items():
                        if k.upper() == p_clean.upper():
                            value = p_val.value
                            cov_stderr = p_val.stderr if p_val.has_stderr else None
                            is_fixed = p_val.is_fixed
                            is_derived = p_val.is_derived or getattr(p_val, "is_constrained", False) or bool(getattr(p_val, "expression", None))
                            expression = p_val.expression
                            break"""

content = content.replace(old_block, new_block)
with open("backend/app/services/reporting/uncertainty.py", "w") as f:
    f.write(content)
