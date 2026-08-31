from __future__ import annotations

import math
from typing import Any, Dict, List, Optional


def evaluate_cpmg_identifiability(
    global_params: Dict[str, Any],
    residue_params: Dict[str, Dict[str, Any]],
    num_fields: int = 1,
    correlations: Optional[Dict[str, Dict[str, float]]] = None,
) -> Dict[str, Any]:
    """
    Evaluate parameter identifiability and exchange regime diagnostics for CPMG fitting results.
    """
    warnings: List[Dict[str, str]] = []
    regimes: Dict[str, str] = {}
    correlations_summary: List[Dict[str, Any]] = []

    # 1. Static Field Warning
    if num_fields < 2:
        warnings.append({
            "code": "SINGLE_FIELD",
            "severity": "warning",
            "title": "Single Static Magnetic Field",
            "message": "Only one static field present. Reliably separating pb from |dw| in CPMG generally requires two or more magnetic fields.",
        })

    # 2. Global kex sensitivity window
    kex_val = global_params.get("kex_ab", {}).get("value")
    kex_err = global_params.get("kex_ab", {}).get("error")
    pb_val = global_params.get("pb", {}).get("value")
    pb_err = global_params.get("pb", {}).get("error")

    if kex_val is not None:
        if kex_val < 150.0:
            warnings.append({
                "code": "KEX_TOO_SLOW",
                "severity": "warning",
                "title": "Slow Exchange Limit for CPMG",
                "message": f"kex ({kex_val:.1f} s⁻¹) is near/below the lower detection limit for CPMG (~150 s⁻¹). Consider CEST experiments for slow exchange.",
            })
        elif kex_val > 10000.0:
            warnings.append({
                "code": "KEX_TOO_FAST",
                "severity": "warning",
                "title": "Fast Exchange Limit for CPMG",
                "message": f"kex ({kex_val:.0f} s⁻¹) is near/above the CPMG pulse train resolution limit (~10,000 s⁻¹).",
            })

    # 3. Assess fast exchange product constraint pa*pb*dw^2
    fast_exchange_residues: List[str] = []
    for res_name, r_dict in residue_params.items():
        dw_val = r_dict.get("dw_ab", {}).get("value")
        dw_err = r_dict.get("dw_ab", {}).get("error")

        if pb_val is not None and dw_val is not None and kex_val is not None:
            pa = 1.0 - pb_val
            product_val = pa * pb_val * (dw_val ** 2)

            # Check if correlation between pb and dw is large if available
            r_corr = None
            if correlations:
                dw_key = f"dw_ab_{res_name}"
                r_corr = correlations.get("pb", {}).get(dw_key) or correlations.get(dw_key, {}).get("pb")

            is_fast_regime = False
            if r_corr is not None and abs(r_corr) > 0.90:
                is_fast_regime = True
            elif pb_err and dw_err and (pb_err / pb_val > 0.25) and (dw_err / abs(dw_val) > 0.25):
                is_fast_regime = True

            if is_fast_regime:
                fast_exchange_residues.append(res_name)
                regimes[res_name] = "fast_exchange_product_only"
            else:
                regimes[res_name] = "intermediate_exchange_resolved"

    if fast_exchange_residues:
        warnings.append({
            "code": "PRODUCT_ONLY_CONSTRAINED",
            "severity": "info",
            "title": "Fast Exchange Product Constraint",
            "message": f"{len(fast_exchange_residues)} residue(s) exhibit high pb-dw correlation (|r| > 0.90). In this regime, the product pa·pb·dw² is tightly determined, but individual pb and |dw| values have broad confidence intervals.",
        })

    return {
        "warnings": warnings,
        "regimes": regimes,
        "fast_exchange_count": len(fast_exchange_residues),
        "total_residues": len(residue_params),
    }
