import re

with open("backend/app/services/fitting/chemex_output/models.py", "r") as f:
    content = f.read()

content = content.replace("extra: dict[str, Any] = Field(default_factory=dict)", "extra: dict[str, Any] = Field(default_factory=dict)\n    experiment_stats: dict[str, 'GoodnessOfFitModel'] = Field(default_factory=dict)")

with open("backend/app/services/fitting/chemex_output/models.py", "w") as f:
    f.write(content)

with open("backend/app/services/fitting/chemex_output/statistics.py", "r") as f:
    content = f.read()

bad_stats = """        else:
            extra[raw_key] = val

    return GoodnessOfFitModel(
        ndata=ndata,
        nvarys=nvarys,
        chisqr=chisqr,
        redchi=redchi,
        pvalue=pvalue,
        ks_pvalue=ks_pvalue,
        aic=aic,
        bic=bic,
        extra=extra,
    )"""

good_stats = """        elif norm_key == "experiments" and isinstance(val, dict):
            pass # Handle below
        else:
            extra[raw_key] = val

    experiment_stats = {}
    if "experiments" in data and isinstance(data["experiments"], dict):
        for exp_name, exp_data in data["experiments"].items():
            if isinstance(exp_data, dict):
                e_ndata = _safe_int(exp_data.get("number of data points"))
                e_nvarys = _safe_int(exp_data.get("number of variables"))
                e_chisqr = _safe_float(exp_data.get("chi-square"))
                e_redchi = _safe_float(exp_data.get("reduced-chi-square"))
                e_pvalue = _safe_float(exp_data.get("chi-squared test"))
                e_ks_pvalue = _safe_float(exp_data.get("kolmogorov-smirnov test"))
                e_aic = _safe_float(exp_data.get("akaike information criterion (aic)"))
                e_bic = _safe_float(exp_data.get("bayesian information criterion (bic)"))
                
                e_extra = {}
                for rk, rv in exp_data.items():
                    nk = str(rk).lower().strip().strip('"').strip("'")
                    if KEY_MAPPING.get(nk) is None:
                        e_extra[rk] = rv
                        
                experiment_stats[exp_name] = GoodnessOfFitModel(
                    ndata=e_ndata,
                    nvarys=e_nvarys,
                    chisqr=e_chisqr,
                    redchi=e_redchi,
                    pvalue=e_pvalue,
                    ks_pvalue=e_ks_pvalue,
                    aic=e_aic,
                    bic=e_bic,
                    extra=e_extra,
                )

    return GoodnessOfFitModel(
        ndata=ndata,
        nvarys=nvarys,
        chisqr=chisqr,
        redchi=redchi,
        pvalue=pvalue,
        ks_pvalue=ks_pvalue,
        aic=aic,
        bic=bic,
        extra=extra,
        experiment_stats=experiment_stats,
    )"""

content = content.replace(bad_stats, good_stats)
with open("backend/app/services/fitting/chemex_output/statistics.py", "w") as f:
    f.write(content)
