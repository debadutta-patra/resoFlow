"""Fast one-state (no exchange) fit of CEST profiles, used as a detection aid in Pick CEST.

Model: a single spin under continuous-wave B1 irradiation for ``time_t1``, starting along z
and relaxing toward zero (the 15N CEST convention, where the far-off-resonance baseline
decays as exp(-R1 T)). Bloch equations in the rotating frame of the B1 field::

    d/dt [Mx, My, Mz] = L [Mx, My, Mz],
    L = [[-R2, -Δ,   0 ],
         [ Δ,  -R2, -ω1],
         [ 0,   ω1, -R1]]

with Δ = 2π(ν_rf - ν_spin) and ω1 = 2π B1.

B1 inhomogeneity is treated as *dephasing* (ChemEx ``b1_distribution = "dephasing"``):
magnetization precessing about the effective field averages out over the B1 distribution,
so only the non-oscillating eigencomponents of the propagator are kept. This also removes
the nutation wiggles a homogeneous-B1 model shows near resonance.

Intensities: the reference plane (offset < −10 kHz) is recorded without the saturation
delay, so it is scale · Mz(0) = scale, and the saturated planes are scale · Mz(T). Fitting
the reference points with the profile (one scale per B1 experiment) makes R1 identifiable
from the baseline decay. Free parameters: CS_A (ppm), R2, R1 and the scales. Without a
reference plane only R2 − R1 is determined, so R1 is then held fixed (reported).

The model ignores exchange and 1H decoupling on purpose: it is the null model whose
residuals reveal a minor-state dip. A one-state fit that cannot place a minor dip broadens
the main dip instead, inflating R2; ``flag_high_r2`` marks such residues relative to the
others (robust z-score).
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
    ref_y: np.ndarray  # reference planes (I / I0), modelled as scale · Mz(0) = scale
    ref_err: np.ndarray


def _bloch(offsets_hz: np.ndarray, cs_ppm: float, r2: float, r1: float, b0_mhz: float, b1_hz: float, carrier_ppm: float, xi: float) -> np.ndarray:
    spin_hz = (cs_ppm - carrier_ppm) * b0_mhz * xi
    delta = TWO_PI * (offsets_hz - spin_hz)
    w1 = TWO_PI * b1_hz
    L = np.zeros((offsets_hz.size, 3, 3))
    L[:, 0, 0] = -r2
    L[:, 0, 1] = -delta
    L[:, 1, 0] = delta
    L[:, 1, 1] = -r2
    L[:, 1, 2] = -w1
    L[:, 2, 1] = w1
    L[:, 2, 2] = -r1
    return L


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
    dephasing: bool = True,
) -> np.ndarray:
    """Mz(T) / Mz(0) of a single spin for each irradiation offset (Hz from the carrier).

    With ``dephasing`` (default) the oscillating eigencomponents of the propagator, i.e.
    precession about the effective field, are dropped (B1 inhomogeneity averages them out).
    """
    offsets_hz = np.atleast_1d(np.asarray(offsets_hz, dtype=float))
    L = _bloch(offsets_hz, cs_ppm, r2, r1, b0_mhz, b1_hz, carrier_ppm, xi)
    if not dephasing:
        return expm(L * time_t1)[:, 2, 2]
    lam, V = np.linalg.eig(L)
    with np.errstate(all="ignore"):
        Vinv = np.linalg.inv(V)
        scale = np.maximum(1.0, np.abs(lam).max(axis=-1, keepdims=True))
        keep = np.abs(lam.imag) <= 1e-7 * scale
        # Mz(T) = Σ_k V[z,k] · exp(λ_k T) · (V⁻¹ e_z)_k over non-oscillating components.
        mz = np.sum(V[:, 2, :] * np.exp(lam * time_t1) * Vinv[:, :, 2] * keep, axis=-1).real
        ok = np.isfinite(mz) & (np.linalg.cond(V) < 1e10)
    if not ok.all():
        # Defective (exceptional-point) matrices: no oscillation to dephase, use expm.
        mz[~ok] = expm(L[~ok] * time_t1)[:, 2, 2]
    return mz


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
    ref_keep = is_ref & np.array([int(p) not in masked for p in planes], dtype=bool)
    ref_y = inten[ref_keep] / i0
    ref_err = np.abs(unc[ref_keep] / i0) if unc is not None else np.zeros_like(ref_y)
    ref_err = np.where(ref_err > 0, ref_err, 0.01)
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
        ref_y=ref_y,
        ref_err=ref_err,
    )


def _ppm(p: _Prepared, offsets_hz: np.ndarray, xi: float) -> np.ndarray:
    return offsets_hz / (p.b0_mhz * xi) + p.carrier_ppm


DEFAULT_R1 = 1.5


def fit_one_state(
    experiments: Sequence[CestExperimentInput],
    xi: float,
    curve_points: int = 400,
    r1: Optional[float] = None,
    dephasing: bool = True,
) -> Optional[dict]:
    """Fit one residue's experiments jointly. Returns None when there is nothing to fit.

    R1 is fitted when every experiment has a reference plane (and ``r1`` is None). Pass
    ``r1`` to hold it fixed; without reference planes it is held at ``DEFAULT_R1`` because
    only R2 − R1 is then identifiable.
    """
    prepared = [p for p in (_prepare(e) for e in experiments) if p is not None and p.used.sum() >= 4]
    if not prepared:
        return None
    has_refs = all(p.ref_y.size > 0 for p in prepared)
    fit_r1 = r1 is None and has_refs
    r1_fixed_value = float(r1) if r1 is not None else DEFAULT_R1

    # Starting point: deepest point of the lowest-B1 experiment.
    low = min(prepared, key=lambda p: p.b1_hz)
    k = int(np.argmin(np.where(low.used, low.y, np.inf)))
    cs0 = float(_ppm(low, low.offsets_hz[k : k + 1], xi)[0])
    all_ppm = np.concatenate([_ppm(p, p.offsets_hz, xi) for p in prepared])
    lo_cs, hi_cs = float(all_ppm.min()), float(all_ppm.max())
    cs0 = min(max(cs0, lo_cs), hi_cs)

    # Parameters: [dCS_A, R2, (R1), scale_1 … scale_n]. CS_A is fitted as a shift from the
    # start value: relative step sizes on a ~100 ppm value are too coarse for the optimizer.
    NP = 3 if fit_r1 else 2

    def unpack(theta):
        dcs, r2 = theta[0], theta[1]
        return dcs, r2, (theta[2] if fit_r1 else r1_fixed_value)

    def shape(theta, p: _Prepared, offsets: np.ndarray) -> np.ndarray:
        dcs, r2, r1_ = unpack(theta)
        return one_state_mz(offsets, cs0 + dcs, r2, r1_, p.b0_mhz, p.b1_hz, p.carrier_ppm, p.time_t1, xi, dephasing)

    def residuals(theta):
        out = []
        for j, p in enumerate(prepared):
            scale = theta[NP + j]
            out.append((p.y[p.used] - scale * shape(theta, p, p.offsets_hz[p.used])) / p.err[p.used])
            out.append((p.ref_y - scale) / p.ref_err)
        return np.concatenate(out)

    # Coarse scan over CS_A, R2 (and R1) with the scales solved exactly (they are linear).
    def scan_cost(theta_phys: list[float]) -> tuple[float, list[float]]:
        total, scales = 0.0, []
        for p in prepared:
            w = 1.0 / np.concatenate([p.err[p.used], p.ref_err])
            a = np.concatenate([shape(theta_phys, p, p.offsets_hz[p.used]), np.ones(p.ref_y.size)]) * w
            b = np.concatenate([p.y[p.used], p.ref_y]) * w
            sc = max(float(a @ b) / max(float(a @ a), 1e-300), 1e-6)
            scales.append(sc)
            total += float(np.sum((b - sc * a) ** 2))
        return total, scales

    lower = [lo_cs - cs0, 0.1] + ([0.01] if fit_r1 else []) + [1e-6] * len(prepared)
    upper = [hi_cs - cs0, 500.0] + ([20.0] if fit_r1 else []) + [np.inf] * len(prepared)
    spacing = float(np.median(np.abs(np.diff(np.sort(_ppm(low, low.offsets_hz, xi)))))) if low.offsets_hz.size > 1 else 0.1
    best = None
    # Dephasing removes the nutation wiggles, so a coarse CS_A × R2 grid suffices; R1 is
    # well determined by the baseline and starts at its typical value.
    n_cs = 21 if dephasing else 41
    for dcs in np.linspace(-2 * spacing, 2 * spacing, n_cs):
        if not (lower[0] <= dcs <= upper[0]):
            continue
        for r2 in (3.0, 10.0, 30.0, 100.0):
            for r1_start in ((DEFAULT_R1,) if fit_r1 else (None,)):
                phys = [float(dcs), r2] + ([r1_start] if fit_r1 else [])
                cost, scales = scan_cost(phys)
                if best is None or cost < best[0]:
                    best = (cost, phys + scales)
    x0 = best[1]

    res = least_squares(residuals, x0, bounds=(lower, upper), x_scale="jac", max_nfev=600, ftol=1e-10, xtol=1e-10)
    theta = res.x
    n_data = res.fun.size
    n_par = theta.size
    dof = max(1, n_data - n_par)
    chisqr = float(np.sum(res.fun**2))
    redchi = chisqr / dof
    stderr: list[Optional[float]] = [None] * n_par
    try:
        cov = np.linalg.inv(res.jac.T @ res.jac) * max(redchi, 1e-12)
        stderr = [float(math.sqrt(v)) if v >= 0 else None for v in np.diag(cov)]
    except np.linalg.LinAlgError:
        pass

    out_exps = []
    for j, p in enumerate(prepared):
        scale = float(theta[NP + j])
        fit_at_data = scale * shape(theta, p, p.offsets_hz)
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
            "curve": {"x_ppm": _ppm(p, grid_hz, xi).tolist(), "y": (scale * shape(theta, p, grid_hz)).tolist()},
            "scale": scale,
        })

    _, r2_fit, r1_fit = unpack(theta)
    return {
        "cs_a": float(cs0 + theta[0]),
        "cs_a_err": stderr[0],
        "r2": float(r2_fit),
        "r2_err": stderr[1],
        "r1": float(r1_fit),
        "r1_err": stderr[2] if fit_r1 else None,
        "r1_fixed": not fit_r1,
        "r1_fixed_reason": None if fit_r1 else ("given" if r1 is not None else "no reference plane"),
        "b1_inhomogeneity": "dephasing" if dephasing else "none",
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
