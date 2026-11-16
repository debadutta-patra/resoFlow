"""Fast one-state (no exchange) fit of CEST profiles, used as a detection aid in Pick CEST.

Model: a single spin under continuous-wave B1 irradiation for ``time_t1``, starting along z
and relaxing toward zero (the 15N CEST convention, where the far-off-resonance baseline
decays as exp(-R1 T)). Bloch equations in the rotating frame of the B1 field::

    d/dt [Mx, My, Mz] = L [Mx, My, Mz],
    L = [[-R2, -Δ,   0 ],
         [ Δ,  -R2, -ω1],
         [ 0,   ω1, -R1]]

with Δ = 2π(ν_rf - ν_spin) and ω1 = 2π B1. The observed intensity is scale · Mz(T); one
scale per B1 experiment absorbs the I0 normalisation. Free parameters: CS_A (ppm), R2 and
the scales; R1 is fixed (see ``fit_one_state``). This ignores exchange, B1 inhomogeneity and 1H decoupling on purpose: it is
the null model whose residuals reveal a minor-state dip.

A one-state fit that cannot place a minor dip broadens the main dip instead, inflating R2;
``flag_high_r2`` marks such residues relative to the others (robust z-score).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Iterable, Optional, Sequence

import numpy as np
from scipy.linalg import expm
from scipy.optimize import least_squares

REFERENCE_OFFSET_HZ = -10000.0
TWO_PI = 2.0 * math.pi


@dataclass
class CestExperimentInput:
    """One B1 experiment of one residue."""

    label: str
    b0_mhz: float
    b1_hz: float
    carrier_ppm: float
    time_t1: float
    offsets_hz: Sequence[float]
    intensities: Sequence[float]
    uncertainties: Optional[Sequence[float]] = None
    #: Plane indices (rows of the data file) masked out of the fit.
    masked_planes: Iterable[int] = field(default_factory=tuple)


@dataclass
class _Prepared:
    label: str
    b0_mhz: float
    b1_hz: float
    carrier_ppm: float
    time_t1: float
    offsets_hz: np.ndarray  # all non-reference planes
    planes: np.ndarray
    y: np.ndarray  # I / I0
    err: np.ndarray
    used: np.ndarray  # bool mask: not masked


def one_state_mz(
    offsets_hz: np.ndarray,
    cs_ppm: float,
    r2: float,
    r1: float,
    b0_mhz: float,
    b1_hz: float,
    carrier_ppm: float,
    time_t1: float,
    xi: float,
) -> np.ndarray:
    """Mz(T) / Mz(0) of a single spin for each irradiation offset (Hz from the carrier)."""
    offsets_hz = np.asarray(offsets_hz, dtype=float)
    spin_hz = (cs_ppm - carrier_ppm) * b0_mhz * xi
    delta = TWO_PI * (offsets_hz - spin_hz)
    w1 = TWO_PI * b1_hz
    n = offsets_hz.size
    L = np.zeros((n, 3, 3))
    L[:, 0, 0] = -r2
    L[:, 0, 1] = -delta
    L[:, 1, 0] = delta
    L[:, 1, 1] = -r2
    L[:, 1, 2] = -w1
    L[:, 2, 1] = w1
    L[:, 2, 2] = -r1
    prop = expm(L * time_t1)
    return prop[:, 2, 2]


def _prepare(exp: CestExperimentInput) -> Optional[_Prepared]:
    offsets = np.asarray(exp.offsets_hz, dtype=float)
    inten = np.asarray(exp.intensities, dtype=float)
    if offsets.size == 0 or offsets.size != inten.size:
        return None
    unc = np.asarray(exp.uncertainties, dtype=float) if exp.uncertainties is not None and len(exp.uncertainties) == offsets.size else None
    planes = np.arange(offsets.size)
    is_ref = offsets < REFERENCE_OFFSET_HZ
    i0 = float(np.mean(inten[is_ref])) if is_ref.any() else float(np.max(inten))
    if not np.isfinite(i0) or i0 == 0:
        return None
    keep = ~is_ref
    y = inten[keep] / i0
    if unc is not None:
        err = np.abs(unc[keep] / i0)
    else:
        err = np.zeros_like(y)
    # Unknown or zero errors: fall back to 1 % of I0 so weights stay finite.
    err = np.where(err > 0, err, 0.01)
    masked = set(int(p) for p in exp.masked_planes)
    used = np.array([int(p) not in masked for p in planes[keep]], dtype=bool)
    return _Prepared(
        label=exp.label,
        b0_mhz=float(exp.b0_mhz),
        b1_hz=float(exp.b1_hz),
        carrier_ppm=float(exp.carrier_ppm),
        time_t1=float(exp.time_t1),
        offsets_hz=offsets[keep],
        planes=planes[keep],
        y=y,
        err=err,
        used=used,
    )


def _ppm(p: _Prepared, offsets_hz: np.ndarray, xi: float) -> np.ndarray:
    return offsets_hz / (p.b0_mhz * xi) + p.carrier_ppm


def fit_one_state(
    experiments: Sequence[CestExperimentInput],
    xi: float,
    curve_points: int = 400,
    r1: float = 1.5,
) -> Optional[dict]:
    """Fit one residue's experiments jointly. Returns None when there is nothing to fit.

    R1 is held fixed: with a free intensity scale per experiment only R2 − R1 is
    identifiable (a common shift of all rates multiplies Mz by a constant), so R2 is
    reported at the given R1.
    """
    prepared = [p for p in (_prepare(e) for e in experiments) if p is not None and p.used.sum() >= 4]
    if not prepared:
        return None

    # Starting point: deepest point of the lowest-B1 experiment.
    low = min(prepared, key=lambda p: p.b1_hz)
    k = int(np.argmin(np.where(low.used, low.y, np.inf)))
    cs0 = float(_ppm(low, low.offsets_hz[k : k + 1], xi)[0])
    all_ppm = np.concatenate([_ppm(p, p.offsets_hz, xi) for p in prepared])
    lo_cs, hi_cs = float(all_ppm.min()), float(all_ppm.max())
    cs0 = min(max(cs0, lo_cs), hi_cs)

    # CS_A is fitted as a shift from the start value: relative step sizes on a ~100 ppm
    # value are too coarse for the optimizer (it stalls on the nearest data point).
    x0 = [0.0, 10.0] + [max(float(np.max(p.y[p.used])), 1e-3) for p in prepared]
    lower = [lo_cs - cs0, r1 + 1e-3] + [1e-6] * len(prepared)
    upper = [hi_cs - cs0, 500.0] + [np.inf] * len(prepared)
    NP = 2  # physical parameters before the scales

    def model(theta, p: _Prepared, offsets: np.ndarray, scale: float) -> np.ndarray:
        dcs, r2 = theta[:NP]
        return scale * one_state_mz(offsets, cs0 + dcs, r2, r1, p.b0_mhz, p.b1_hz, p.carrier_ppm, p.time_t1, xi)

    def residuals(theta):
        out = []
        for j, p in enumerate(prepared):
            m = model(theta, p, p.offsets_hz[p.used], theta[NP + j])
            out.append((p.y[p.used] - m) / p.err[p.used])
        return np.concatenate(out)

    # Coarse scan first: at low R2 / high B1 the profile carries nutation wiggles near
    # resonance, so the cost in CS_A has local minima. Scales are linear, solved exactly.
    def scan_cost(dcs: float, r2: float) -> tuple[float, list[float]]:
        total, scales = 0.0, []
        for p in prepared:
            w = 1.0 / p.err[p.used]
            shape = one_state_mz(p.offsets_hz[p.used], cs0 + dcs, r2, r1, p.b0_mhz, p.b1_hz, p.carrier_ppm, p.time_t1, xi)
            a, b = shape * w, p.y[p.used] * w
            scale = max(float(a @ b) / max(float(a @ a), 1e-300), 1e-6)
            scales.append(scale)
            total += float(np.sum((b - scale * a) ** 2))
        return total, scales

    spacing = float(np.median(np.abs(np.diff(np.sort(_ppm(low, low.offsets_hz, xi)))))) if low.offsets_hz.size > 1 else 0.1
    best = None
    for dcs in np.linspace(-2 * spacing, 2 * spacing, 41):
        if not (lower[0] <= dcs <= upper[0]):
            continue
        for r2 in (3.0, 10.0, 30.0, 100.0):
            r2 = max(r2, r1 + 0.01)
            cost, scales = scan_cost(float(dcs), r2)
            if best is None or cost < best[0]:
                best = (cost, [float(dcs), r2] + scales)
    if best is not None:
        x0 = best[1]

    res = least_squares(residuals, x0, bounds=(lower, upper), x_scale="jac", max_nfev=400, ftol=1e-10, xtol=1e-10)
    theta = res.x
    n_data = res.fun.size
    n_par = theta.size
    dof = max(1, n_data - n_par)
    chisqr = float(np.sum(res.fun**2))
    redchi = chisqr / dof
    stderr = [None] * n_par
    try:
        cov = np.linalg.inv(res.jac.T @ res.jac) * max(redchi, 1e-12)
        stderr = [float(math.sqrt(v)) if v >= 0 else None for v in np.diag(cov)]
    except np.linalg.LinAlgError:
        pass

    out_exps = []
    for j, p in enumerate(prepared):
        scale = float(theta[NP + j])
        fit_at_data = model(theta, p, p.offsets_hz, scale)
        grid_hz = np.linspace(float(p.offsets_hz.min()), float(p.offsets_hz.max()), curve_points)
        out_exps.append({
            "label": p.label,
            "b0": p.b0_mhz,
            "b1": p.b1_hz,
            "x_ppm": _ppm(p, p.offsets_hz, xi).tolist(),
            "planes": p.planes.tolist(),
            "y": p.y.tolist(),
            "err": p.err.tolist(),
            "used": p.used.tolist(),
            "fit": fit_at_data.tolist(),
            "residuals": (p.y - fit_at_data).tolist(),
            "curve": {"x_ppm": _ppm(p, grid_hz, xi).tolist(), "y": model(theta, p, grid_hz, scale).tolist()},
            "scale": scale,
        })

    return {
        "cs_a": float(cs0 + theta[0]),
        "cs_a_err": stderr[0],
        "r2": float(theta[1]),
        "r2_err": stderr[1],
        "r1": float(r1),
        "r1_fixed": True,
        "chisqr": chisqr,
        "redchi": redchi,
        "ndata": int(n_data),
        "success": bool(res.success),
        "experiments": out_exps,
    }


def flag_high_r2(r2_by_residue: dict[str, float], z: float = 3.0, min_count: int = 5) -> dict:
    """Mark residues whose fitted R2 is a high outlier: R2 > median + z · 1.4826 · MAD.

    Needs at least ``min_count`` residues; otherwise nothing is flagged. When MAD is zero
    (identical values) the threshold falls back to 10 % above the median.
    """
    vals = {k: float(v) for k, v in r2_by_residue.items() if v is not None and math.isfinite(v)}
    if len(vals) < min_count:
        return {"median": None, "mad": None, "threshold": None, "flagged": []}
    arr = np.array(list(vals.values()))
    med = float(np.median(arr))
    mad = float(np.median(np.abs(arr - med)))
    threshold = med + z * 1.4826 * mad if mad > 0 else med * 1.1
    flagged = sorted(k for k, v in vals.items() if v > threshold)
    return {"median": med, "mad": mad, "threshold": threshold, "flagged": flagged}
