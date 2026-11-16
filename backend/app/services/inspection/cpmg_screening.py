"""CPMG dispersion screening: Rex with propagated error and duplicate-point error checks.

Definitions (shown in the UI):

* **Rex** = mean R2,eff at the lowest ν_CPMG − mean R2,eff at the highest ν_CPMG (per field).
  Its error propagates the reported point errors of the averaged points:
  σ_Rex² = Σσ_low² / n_low² + Σσ_high² / n_high². Rex is signed (not clamped at 0).
* **Pooled duplicate error**: points repeated at the same ν_CPMG estimate the scatter of a
  single measurement. Pooled SD = sqrt( Σ_g Σ_i (R_gi − R̄_g)² / Σ_g (n_g − 1) ) over all
  duplicate groups g. Compared with the RMS reported error of those same points, the ratio
  flags residues whose reported errors are too small (default: ratio > 3).
"""

from __future__ import annotations

import math
from typing import Any, Optional, Sequence

NU_TOLERANCE_HZ = 1e-3


def group_by_nu(nu: Sequence[float], tol: float = NU_TOLERANCE_HZ) -> list[list[int]]:
    """Indices grouped by equal ν_CPMG (within ``tol``), groups in ascending ν order."""
    order = sorted(range(len(nu)), key=lambda i: nu[i])
    groups: list[list[int]] = []
    for i in order:
        if groups and abs(nu[i] - nu[groups[-1][0]]) <= tol:
            groups[-1].append(i)
        else:
            groups.append([i])
    return groups


def _err(e: Optional[float]) -> float:
    return float(e) if e is not None and math.isfinite(e) and e > 0 else float("nan")


def rex_with_error(nu: Sequence[float], r2: Sequence[float], err: Sequence[float]) -> dict[str, Any]:
    """Signed Rex (lowest − highest ν_CPMG means) with propagated error; NaN error when the
    contributing points report none."""
    if len(nu) < 2:
        return {"rex": None, "rex_err": None, "nu_low": None, "nu_high": None, "n_low": 0, "n_high": 0}
    groups = group_by_nu(nu)
    if len(groups) < 2:
        return {"rex": None, "rex_err": None, "nu_low": nu[groups[0][0]], "nu_high": nu[groups[0][0]], "n_low": len(groups[0]), "n_high": len(groups[0])}
    low, high = groups[0], groups[-1]
    mean = lambda g: sum(r2[i] for i in g) / len(g)  # noqa: E731
    var = lambda g: sum(_err(err[i]) ** 2 for i in g) / len(g) ** 2  # noqa: E731
    rex = mean(low) - mean(high)
    rex_err = math.sqrt(var(low) + var(high))
    return {
        "rex": rex,
        "rex_err": rex_err if math.isfinite(rex_err) else None,
        "nu_low": nu[low[0]],
        "nu_high": nu[high[0]],
        "n_low": len(low),
        "n_high": len(high),
    }


def pooled_duplicate_error(nu: Sequence[float], r2: Sequence[float], err: Sequence[float]) -> dict[str, Any]:
    """Pooled SD from duplicate ν_CPMG points and the RMS reported error of those points."""
    ss = 0.0
    dof = 0
    rep_sq: list[float] = []
    n_groups = 0
    for g in group_by_nu(nu):
        if len(g) < 2:
            continue
        n_groups += 1
        m = sum(r2[i] for i in g) / len(g)
        ss += sum((r2[i] - m) ** 2 for i in g)
        dof += len(g) - 1
        rep_sq.extend(_err(err[i]) ** 2 for i in g)
    if dof == 0:
        return {"pooled_sd": None, "dof": 0, "n_groups": 0, "reported_rms": None, "ratio": None}
    pooled = math.sqrt(ss / dof)
    finite = [v for v in rep_sq if math.isfinite(v)]
    reported = math.sqrt(sum(finite) / len(finite)) if finite else None
    ratio = pooled / reported if reported else None
    return {"pooled_sd": pooled, "dof": dof, "n_groups": n_groups, "reported_rms": reported, "ratio": ratio}


def screen_profile(experiments: Sequence[dict], factor: float = 3.0) -> dict[str, Any]:
    """Per-field Rex and duplicate checks for one residue, plus residue-level summary
    (Rex of the field with the largest Rex; flagged when any field's ratio > factor)."""
    fields = []
    for exp in experiments:
        nu = [float(v) for v in exp.get("nu_cpmg") or []]
        r2 = [float(v) for v in exp.get("r2eff") or []]
        err = [float(v) if v is not None else float("nan") for v in exp.get("r2eff_err") or [None] * len(nu)]
        n = min(len(nu), len(r2), len(err))
        nu, r2, err = nu[:n], r2[:n], err[:n]
        rex = rex_with_error(nu, r2, err)
        dup = pooled_duplicate_error(nu, r2, err)
        # Rex error from the duplicate scatter instead of the reported errors.
        rex_err_pooled = None
        if dup["pooled_sd"] is not None and rex["rex"] is not None:
            rex_err_pooled = dup["pooled_sd"] * math.sqrt(1 / rex["n_low"] + 1 / rex["n_high"])
        fields.append({
            "b0": exp.get("b0"),
            **rex,
            "rex_err_pooled": rex_err_pooled,
            "duplicates": dup,
            "flagged": bool(dup["ratio"] is not None and dup["ratio"] > factor),
        })
    with_rex = [f for f in fields if f["rex"] is not None]
    best = max(with_rex, key=lambda f: f["rex"]) if with_rex else None
    return {
        "fields": fields,
        "rex": best["rex"] if best else None,
        "rex_err": best["rex_err"] if best else None,
        "rex_b0": best["b0"] if best else None,
        "max_ratio": max((f["duplicates"]["ratio"] for f in fields if f["duplicates"]["ratio"] is not None), default=None),
        "flagged": any(f["flagged"] for f in fields),
    }
