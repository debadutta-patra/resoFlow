/**
 * Inspect Dispersion numerics: duplicate ν_CPMG detection, mean guide line, field labels,
 * Rex → |Δω| seed ranges, CEST/Rex consistency and fitted-curve extraction. Pure functions.
 *
 * Rex (definition shown in the UI, computed by the backend screening endpoint):
 *   Rex = mean R2,eff at the lowest ν_CPMG − mean R2,eff at the highest ν_CPMG,
 *   σ_Rex² = Σσ_low²/n_low² + Σσ_high²/n_high².
 */

import { SpinSystemKey } from './spinSystem';
import { trimNumber } from './cestPicking';

export const REX_DEFINITION =
  'Rex = mean R2,eff at the lowest ν_CPMG − mean R2,eff at the highest ν_CPMG (per field). ' +
  'Error: σ² = Σσ_low²/n_low² + Σσ_high²/n_high² from the reported point errors.';

export const NU_TOLERANCE_HZ = 1e-3;

/** "600.26 MHz" (two decimals at most). */
export function formatFieldMHz(b0: number | null | undefined): string {
  return `${trimNumber(typeof b0 === 'number' && Number.isFinite(b0) ? b0 : 600, 2)} MHz`;
}

/** True for each point whose ν_CPMG is repeated in the same experiment. */
export function duplicateMask(nu: number[], tol = NU_TOLERANCE_HZ): boolean[] {
  return nu.map((v, i) => nu.some((w, j) => j !== i && Math.abs(w - v) <= tol));
}

/** Mean R2,eff at each distinct ν_CPMG, ascending (for the optional guide line). */
export function meanByNu(nu: number[], r2: number[], tol = NU_TOLERANCE_HZ): { x: number[]; y: number[] } {
  const order = nu.map((_, i) => i).sort((a, b) => nu[a] - nu[b]);
  const x: number[] = [], y: number[] = [];
  let group: number[] = [];
  const flush = () => {
    if (!group.length) return;
    x.push(nu[group[0]]);
    y.push(group.reduce((s, i) => s + r2[i], 0) / group.length);
    group = [];
  };
  for (const i of order) {
    if (group.length && Math.abs(nu[i] - nu[group[0]]) > tol) flush();
    group.push(i);
  }
  flush();
  return { x, y };
}

// ── Rex → |Δω| seeds (fast exchange) ─────────────────────────────────────

/**
 * Fast-exchange |Δω| (ppm) from Rex: Rex ≈ pA·pB·Δω²/kex, Δω in rad/s converted with the
 * nucleus frequency b0·xi. Null for non-positive Rex or out-of-range inputs.
 */
export function dwFromRex(rex: number, pb: number, kex: number, b0MHz: number, xi: number): number | null {
  if (!(rex > 0) || !(kex > 0) || !(pb > 0 && pb < 1) || !(b0MHz > 0)) return null;
  const dwRad = Math.sqrt((rex * kex) / ((1 - pb) * pb));
  return dwRad / (2 * Math.PI * b0MHz * xi);
}

export interface SeedAssumptions {
  pb: number;
  kex: number;
  pbRange: [number, number];
  kexRange: [number, number];
}

export interface SeedRange {
  /** Seed at the central (pb, kex). */
  value: number;
  min: number;
  max: number;
}

/**
 * |Δω| over the pB × kex span. Δω grows with kex and, for pB < 0.5, falls with pB, so the
 * extremes sit at the corners; corners are evaluated rather than assuming monotonicity.
 */
export function dwSeedRange(rex: number, a: SeedAssumptions, b0MHz: number, xi: number): SeedRange | null {
  const value = dwFromRex(rex, a.pb, a.kex, b0MHz, xi);
  if (value === null) return null;
  const vals = [a.pbRange[0], a.pbRange[1], a.pb]
    .flatMap(pb => [a.kexRange[0], a.kexRange[1], a.kex].map(k => dwFromRex(rex, pb, k, b0MHz, xi)))
    .filter((v): v is number => v !== null);
  return { value, min: Math.min(...vals), max: Math.max(...vals) };
}

export type Consistency = 'consistent' | 'disagree' | 'n/a';

/**
 * CEST |Δω| vs the Rex-derived range: consistent when |Δω_CEST| lies within the range
 * widened by `tolerance` (fractional, e.g. 0.3 → [min/1.3, max·1.3]).
 */
export function cestRexConsistency(dwCest: number | null | undefined, range: SeedRange | null, tolerance = 0.3): Consistency {
  if (dwCest == null || !Number.isFinite(dwCest) || !range) return 'n/a';
  const v = Math.abs(dwCest);
  return v >= range.min / (1 + tolerance) && v <= range.max * (1 + tolerance) ? 'consistent' : 'disagree';
}

/** CEST pick for a dispersion residue (keys differ, e.g. "10N" vs "G10N-HN"): SpinSystemKey match. */
export function matchCestPick<T>(picks: Record<string, T> | undefined, residue: string): T | undefined {
  if (!picks) return undefined;
  if (residue in picks) return picks[residue];
  const target = SpinSystemKey.parse(residue);
  const key = Object.keys(picks).find(k => SpinSystemKey.parse(k).matches(target) && target.resNum > 0);
  return key === undefined ? undefined : picks[key];
}

/** Signed Δω (ppm) = CS_B − CS_A from a CEST pick, or null. */
export function cestDw(pick: { cs_a?: number | null; cs_b?: number | null } | undefined): number | null {
  return pick && typeof pick.cs_a === 'number' && typeof pick.cs_b === 'number' ? pick.cs_b - pick.cs_a : null;
}

// ── Fitted curves from a committed run ───────────────────────────────────

export interface FitCurve {
  b0: number | null;
  label: string;
  x: number[];
  y: number[];
}

/** Fitted dispersion curves per residue from a results payload (primary or last step). */
export function fitCurvesFromResults(results: any): Record<string, FitCurve[]> {
  if (!results) return {};
  const step = results.primary_step ?? (Array.isArray(results.step_order) ? results.step_order[results.step_order.length - 1] : undefined);
  const residues = (step && results.steps?.[step]?.residues) || results.residues || {};
  const out: Record<string, FitCurve[]> = {};
  for (const [res, obj] of Object.entries<any>(residues)) {
    const curves: FitCurve[] = [];
    for (const exp of obj?.experiments ?? []) {
      const x = exp.fit_curve?.x || exp.fit_curve?.nu_cpmg || exp.calc_points?.x || [];
      const y = exp.fit_curve?.y || exp.fit_curve?.r2eff || exp.calc_points?.y || [];
      if (!x.length || x.length !== y.length) continue;
      const b0 = typeof exp.b0 === 'number' ? exp.b0 : parseFloat(String(exp.b1_label ?? exp.exp_name ?? '').match(/([\d.]+)\s*MHz/i)?.[1] ?? '');
      curves.push({ b0: Number.isFinite(b0) ? b0 : null, label: String(exp.b1_label ?? exp.exp_name ?? ''), x, y });
    }
    if (curves.length) out[res] = curves;
  }
  return out;
}

/** Curve for a field: closest b0 within 1 MHz, else by position. */
export function curveForField(curves: FitCurve[] | undefined, b0: number | null | undefined, index: number): FitCurve | undefined {
  if (!curves?.length) return undefined;
  if (typeof b0 === 'number') {
    const hit = curves.filter(c => c.b0 !== null && Math.abs((c.b0 as number) - b0) < 1);
    if (hit.length) return hit.sort((a, b) => Math.abs((a.b0 as number) - b0) - Math.abs((b.b0 as number) - b0))[0];
  }
  return curves.length > index && curves.every(c => c.b0 === null) ? curves[index] : undefined;
}

/** Residuals of points against a curve (linear interpolation); NaN outside the curve range. */
export function residualsAgainst(curve: FitCurve, nu: number[], r2: number[]): number[] {
  const pts = curve.x.map((x, i) => [x, curve.y[i]] as const).sort((a, b) => a[0] - b[0]);
  const at = (x: number) => {
    if (!pts.length || x < pts[0][0] - 1e-9 || x > pts[pts.length - 1][0] + 1e-9) return NaN;
    for (let i = 1; i < pts.length; i++) {
      if (x <= pts[i][0]) {
        const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
        return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
      }
    }
    return pts[pts.length - 1][1];
  };
  return nu.map((x, i) => r2[i] - at(x));
}
