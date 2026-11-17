/**
 * Pick CEST numerics: profile points in ppm, snap-to-minimum, difference trace, field labels,
 * Δϖ and the overview heatmap matrix. Pure functions (unit tested).
 *
 * Offsets are Hz from the carrier; offsets below −10 kHz are reference planes (I0).
 */

import { offsetHzToPpm } from './cestProfileSeed';
import { SpinSystemKey } from './spinSystem';

export const REFERENCE_OFFSET_HZ = -10000;

export interface CestExpLike {
  b1: string;
  b1_actual?: number | null;
  b0: number;
  carrier: number;
  offsets: number[];
  intensities: number[];
  uncertainties?: number[];
  error?: string;
}

export interface ProfilePoint {
  /** Row index in the data file (= ChemEx plane index). */
  plane: number;
  ppm: number;
  y: number;
  err: number;
}

/** I/I0 points (reference planes removed), in acquisition order. */
export function profilePoints(exp: CestExpLike, xi: number): ProfilePoint[] {
  const refs = exp.offsets.map((o, i) => (o < REFERENCE_OFFSET_HZ ? exp.intensities[i] : NaN)).filter(Number.isFinite);
  const i0 = refs.length ? refs.reduce((a, b) => a + b, 0) / refs.length : 1;
  const norm = i0 !== 0 ? i0 : 1;
  const out: ProfilePoint[] = [];
  exp.offsets.forEach((o, i) => {
    if (o < REFERENCE_OFFSET_HZ) return;
    out.push({
      plane: i,
      ppm: offsetHzToPpm(o, exp.b0 || 600, exp.carrier || 0, xi),
      y: exp.intensities[i] / norm,
      err: Math.abs((exp.uncertainties?.[i] ?? 0) / norm),
    });
  });
  return out;
}

/** Hz value of a B1 field: measured value, else parsed from a label such as "600MHz_67hz". */
export function b1Hz(exp: Pick<CestExpLike, 'b1' | 'b1_actual'>): number | null {
  if (typeof exp.b1_actual === 'number' && exp.b1_actual > 0) return exp.b1_actual;
  const m = String(exp.b1 ?? '').match(/([\d.]+)\s*hz/i) ?? String(exp.b1 ?? '').match(/^\s*([\d.]+)\s*$/);
  return m ? parseFloat(m[1]) : null;
}

/** Number with at most `digits` decimals, trailing zeros dropped (600, 600.26, 67.5). */
export function trimNumber(v: number, digits = 2): string {
  return String(Number(v.toFixed(digits)));
}

/** "600 MHz, B1 = 67 Hz" */
export function formatFieldLabel(exp: Pick<CestExpLike, 'b0' | 'b1' | 'b1_actual'>): string {
  const b1 = b1Hz(exp);
  const field = `${trimNumber(exp.b0 || 600)} MHz`;
  return b1 == null ? field : `${field}, B1 = ${trimNumber(b1, 1)} Hz`;
}

/** Signed Δϖ = CS_B − CS_A in ppm and Hz (nucleus frequency = b0 · xi). */
export function deltaVarpi(csA: number, csB: number, b0MHz: number, xi: number): { ppm: number; hz: number } {
  const ppm = csB - csA;
  return { ppm, hz: ppm * b0MHz * xi };
}

// ── Snap to minimum ──────────────────────────────────────────────────────

/** Least-squares parabola y = a(x−c)² + b(x−c) + d; null when degenerate. */
export function fitParabola(xs: number[], ys: number[]): { a: number; b: number; d: number; c: number } | null {
  const n = xs.length;
  if (n < 3) return null;
  const c = xs.reduce((s, x) => s + x, 0) / n;
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
  for (let i = 0; i < n; i++) {
    const u = xs[i] - c, y = ys[i];
    const u2 = u * u;
    s0 += 1; s1 += u; s2 += u2; s3 += u2 * u; s4 += u2 * u2;
    t0 += y; t1 += u * y; t2 += u2 * y;
  }
  // Normal equations for [a, b, d]: [[s4,s3,s2],[s3,s2,s1],[s2,s1,s0]] · [a,b,d] = [t2,t1,t0]
  const M = [[s4, s3, s2, t2], [s3, s2, s1, t1], [s2, s1, s0, t0]];
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-300) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let k = col; k < 4; k++) M[r][k] -= f * M[col][k];
    }
  }
  const a = M[0][3] / M[0][0], b = M[1][3] / M[1][1], d = M[2][3] / M[2][2];
  return [a, b, d].every(Number.isFinite) ? { a, b, d, c } : null;
}

export interface SnapResult {
  x: number;
  y: number;
  /** Index (into the sorted points) of the data minimum the snap is anchored on. */
  index: number;
  /** True when the parabola vertex was used, false when it fell back to the data point. */
  refined: boolean;
}

/**
 * Snap a click at `x` to the nearest local minimum: walk downhill from the closest point,
 * then fit a parabola through the `n` (3–5) points nearest that minimum and return its
 * vertex. Falls back to the data minimum when the parabola does not open upward or its
 * vertex leaves the fitted span. Null when the click is farther than `maxDistance` from
 * every point.
 */
export function snapToMinimum(
  xs: number[],
  ys: number[],
  x: number,
  opts: { n?: number; maxDistance?: number } = {},
): SnapResult | null {
  const n = Math.min(5, Math.max(3, opts.n ?? 5));
  const pts = xs.map((px, i) => ({ x: px, y: ys[i] })).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y)).sort((a, b) => a.x - b.x);
  if (pts.length === 0) return null;
  let k = 0;
  for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i].x - x) < Math.abs(pts[k].x - x)) k = i;
  if (opts.maxDistance !== undefined && Math.abs(pts[k].x - x) > opts.maxDistance) return null;
  for (;;) {
    const left = k > 0 ? pts[k - 1].y : Infinity;
    const right = k < pts.length - 1 ? pts[k + 1].y : Infinity;
    if (left < pts[k].y && left <= right) k--;
    else if (right < pts[k].y) k++;
    else break;
  }
  const near = pts
    .map((p, i) => ({ ...p, i, dist: Math.abs(p.x - pts[k].x) }))
    .sort((a, b) => a.dist - b.dist || a.i - b.i)
    .slice(0, Math.min(n, pts.length));
  const fallback: SnapResult = { x: pts[k].x, y: pts[k].y, index: k, refined: false };
  const par = fitParabola(near.map(p => p.x), near.map(p => p.y));
  if (!par || par.a <= 0) return fallback;
  const vx = par.c - par.b / (2 * par.a);
  const lo = Math.min(...near.map(p => p.x)), hi = Math.max(...near.map(p => p.x));
  if (vx < lo || vx > hi) return fallback;
  const u = vx - par.c;
  return { x: vx, y: par.a * u * u + par.b * u + par.d, index: k, refined: true };
}

/**
 * Snap across several B1 experiments: snap in each, keep the deepest minimum (lowest y).
 * Masked planes are ignored.
 */
export function snapAcrossExperiments(
  exps: CestExpLike[],
  x: number,
  xi: number,
  masked: (exp: CestExpLike, plane: number) => boolean = () => false,
  maxDistance?: number,
): number | null {
  let best: SnapResult | null = null;
  for (const exp of exps) {
    if (exp.error) continue;
    const pts = profilePoints(exp, xi).filter(p => !masked(exp, p.plane));
    const r = snapToMinimum(pts.map(p => p.ppm), pts.map(p => p.y), x, { maxDistance });
    if (r && (!best || r.y < best.y)) best = r;
  }
  return best ? best.x : null;
}

// ── Difference trace ─────────────────────────────────────────────────────

/** Linear interpolation of (xs, ys) at `x`; xs need not be sorted. NaN outside the range. */
export function interpolate(xs: number[], ys: number[], x: number): number {
  const pts = xs.map((px, i) => [px, ys[i]] as const).sort((a, b) => a[0] - b[0]);
  if (pts.length === 0 || x < pts[0][0] || x > pts[pts.length - 1][0]) return NaN;
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return pts[pts.length - 1][1];
}

/**
 * Lowest-B1 minus highest-B1 I/I0, both interpolated onto a common uniform ppm grid over
 * their overlapping range (as many points as the denser profile). Null with fewer than two
 * distinct B1 fields.
 */
export function differenceTrace(exps: CestExpLike[], xi: number): { x: number[]; y: number[]; low: CestExpLike; high: CestExpLike } | null {
  const usable = exps.filter(e => !e.error && b1Hz(e) != null);
  if (usable.length < 2) return null;
  const sorted = [...usable].sort((a, b) => (b1Hz(a) as number) - (b1Hz(b) as number));
  const low = sorted[0], high = sorted[sorted.length - 1];
  if (b1Hz(low) === b1Hz(high)) return null;
  const pl = profilePoints(low, xi), ph = profilePoints(high, xi);
  if (pl.length < 2 || ph.length < 2) return null;
  const lo = Math.max(Math.min(...pl.map(p => p.ppm)), Math.min(...ph.map(p => p.ppm)));
  const hi = Math.min(Math.max(...pl.map(p => p.ppm)), Math.max(...ph.map(p => p.ppm)));
  if (!(hi > lo)) return null;
  const n = Math.max(pl.length, ph.length);
  const x: number[] = [], y: number[] = [];
  for (let i = 0; i < n; i++) {
    const g = lo + ((hi - lo) * i) / (n - 1);
    x.push(g);
    y.push(interpolate(pl.map(p => p.ppm), pl.map(p => p.y), g) - interpolate(ph.map(p => p.ppm), ph.map(p => p.y), g));
  }
  return { x, y, low, high };
}

// ── Heatmap ──────────────────────────────────────────────────────────────

export interface HeatmapPanel {
  label: string;
  title: string;
  x: number[];
  residues: string[];
  /** z[row][col] = I/I0 of residue `row` at offset `col`; null where missing. */
  z: (number | null)[][];
}

/** One residues × offsets I/I0 matrix per B1 experiment (keyed by experiment label),
 * rows in residue-number order (SpinSystemKey, as in the residue table). */
export function heatmapPanels(
  profiles: { residue: string; experiments: CestExpLike[] }[],
  xi: number,
): HeatmapPanel[] {
  const resNum = (r: string) => SpinSystemKey.parse(r).resNum || Number.MAX_SAFE_INTEGER;
  profiles = [...profiles].sort((a, b) => resNum(a.residue) - resNum(b.residue) || a.residue.localeCompare(b.residue));
  const byLabel = new Map<string, { title: string; rows: { residue: string; pts: ProfilePoint[] }[] }>();
  for (const p of profiles) {
    for (const e of p.experiments) {
      if (e.error) continue;
      const entry = byLabel.get(e.b1) ?? { title: formatFieldLabel(e), rows: [] };
      entry.rows.push({ residue: p.residue, pts: profilePoints(e, xi) });
      byLabel.set(e.b1, entry);
    }
  }
  const panels: HeatmapPanel[] = [];
  for (const [label, { title, rows }] of byLabel) {
    const ref = rows.reduce((a, b) => (b.pts.length > a.pts.length ? b : a), rows[0]);
    const x = [...ref.pts].sort((a, b) => a.ppm - b.ppm).map(p => p.ppm);
    const z = rows.map(r => {
      const sorted = [...r.pts].sort((a, b) => a.ppm - b.ppm);
      if (sorted.length === x.length) return sorted.map(p => p.y);
      return x.map(g => {
        const v = interpolate(sorted.map(p => p.ppm), sorted.map(p => p.y), g);
        return Number.isFinite(v) ? v : null;
      });
    });
    panels.push({ label, title, x, residues: rows.map(r => r.residue), z });
  }
  return panels.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
}

/**
 * Row baseline: median of the top quartile of the row's values (the off-resonance plateau,
 * ≈ exp(−R1·T) in I/I0). Null for an empty row.
 */
export function rowBaseline(row: (number | null)[]): number | null {
  const v = row.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => b - a);
  if (!v.length) return null;
  const top = v.slice(0, Math.max(1, Math.ceil(v.length / 4)));
  const m = top.length >> 1;
  return top.length % 2 ? top[m] : (top[m - 1] + top[m]) / 2;
}

/** Each row divided by its baseline, so 1 = plateau and dips read the same in every row. */
export function normalizeRows(z: (number | null)[][]): (number | null)[][] {
  return z.map(row => {
    const b = rowBaseline(row);
    return row.map(v => (v === null || !b ? null : v / b));
  });
}

/** [min, max] of the finite values (colour range); [0, 1] when empty. */
export function valueRange(z: (number | null)[][]): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const row of z) for (const v of row) if (typeof v === 'number' && Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  return Number.isFinite(lo) ? [lo, hi] : [0, 1];
}

// ── Fitted shifts from a committed run ───────────────────────────────────

function paramValue(resObj: any, name: string): number | null {
  const lower = name.toLowerCase(), upper = name.toUpperCase();
  const p = resObj?.parameters ?? {};
  for (const c of [resObj?.[lower], p[lower], p[upper]]) {
    const v = typeof c === 'object' && c !== null ? c.value : c;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

/**
 * CS_A / CS_B per residue from a results payload (primary or last step). CS_B is taken
 * directly when reported, else CS_A + DW_AB.
 */
export function fittedShiftsFromResults(results: any): Record<string, { cs_a: number | null; cs_b: number | null }> {
  if (!results) return {};
  const step = results.primary_step ?? (Array.isArray(results.step_order) ? results.step_order[results.step_order.length - 1] : undefined);
  const residues = (step && results.steps?.[step]?.residues) || results.residues || {};
  const out: Record<string, { cs_a: number | null; cs_b: number | null }> = {};
  for (const [res, obj] of Object.entries(residues)) {
    const csA = paramValue(obj, 'cs_a');
    const dw = paramValue(obj, 'dw_ab');
    const csB = paramValue(obj, 'cs_b') ?? (csA !== null && dw !== null ? csA + dw : null);
    if (csA !== null || csB !== null) out[res] = { cs_a: csA, cs_b: csB };
  }
  return out;
}
