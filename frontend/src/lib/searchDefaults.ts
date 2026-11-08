/**
 * Physically motivated default ranges for ChemEx v2 SEARCH.GRID axes and
 * SEARCH.DE coordinates.
 *
 * Ranges reflect the experimentally accessible window of each technique
 * (values in ChemEx units: populations as fractions, rates in s⁻¹,
 * shift differences in ppm, TAUC in ns):
 *
 * - Minor-state populations (PB, PC, …): CEST/CPMG detect ≈0.5–20 %;
 *   sampled logarithmically because sensitivity scales with log(p).
 * - KEX: CEST is sensitive to slow exchange (~20–2000 s⁻¹); CPMG to the
 *   intermediate regime (~100–10 000 s⁻¹); combined fits span both.
 * - DW: CEST resolves the sign of Δϖ, so the grid is symmetric about 0;
 *   CPMG only constrains |Δϖ|, so the grid starts at 0. Ranges cover typical
 *   ¹⁵N backbone shift differences (≤ ~10 ppm).
 * - R2 (2–100 s⁻¹, log) and R1 (0.2–3 s⁻¹) cover typical ¹⁵N relaxation of
 *   folded proteins at 600–950 MHz.
 *
 * DE ranges are a little wider than grids because DE is meant for broad
 * stochastic coverage of a few basin-defining coordinates. All ranges stay
 * inside ChemEx's physical parameter bounds (populations ∈ [0, 1], rates ≥ 0)
 * and are strictly positive wherever the scale is logarithmic.
 */

import type { SearchAxis, SearchFunction, SearchMode } from './methodConfig';
import { newMethodId } from './methodConfig';

export type ExperimentFamily = 'cest' | 'cpmg' | 'exchange' | string;

export interface RangeDefault {
  fn: Exclude<SearchFunction, 'values'>;
  low: number;
  high: number;
  count: number;
  /** True when no physically motivated range is known for this parameter. */
  generic?: boolean;
  /** Short human-readable rationale shown in the UI. */
  hint: string;
}

const isCpmg = (f: ExperimentFamily) => f === 'cpmg';
const isCest = (f: ExperimentFamily) => f === 'cest';

function gridDefault(param: string, family: ExperimentFamily, start?: number): RangeDefault {
  const p = param.toUpperCase();

  // Minor-state populations: PB, PC, PD, … (PA is always derived)
  if (/^P[B-F]$/.test(p)) {
    return { fn: 'log', low: 0.005, high: 0.2, count: 10, hint: 'Minor-state population 0.5–20 % (log)' };
  }
  if (/^KEX_[A-F]{2}$/.test(p)) {
    if (isCpmg(family)) return { fn: 'log', low: 100, high: 10000, count: 12, hint: 'CPMG window 10²–10⁴ s⁻¹ (log)' };
    if (isCest(family)) return { fn: 'log', low: 20, high: 2000, count: 12, hint: 'CEST slow-exchange window 20–2000 s⁻¹ (log)' };
    return { fn: 'log', low: 20, high: 10000, count: 14, hint: 'Combined CEST+CPMG window 20–10⁴ s⁻¹ (log)' };
  }
  if (/^DW_[A-F]{2}$/.test(p)) {
    if (isCpmg(family)) return { fn: 'lin', low: 0, high: 8, count: 17, hint: '|Δϖ| 0–8 ppm (CPMG is sign-insensitive)' };
    return { fn: 'lin', low: -10, high: 10, count: 21, hint: 'Signed Δϖ −10…+10 ppm (CEST resolves the sign)' };
  }
  if (/^R2_[A-F]$/.test(p)) {
    return { fn: 'log', low: 2, high: 100, count: 10, hint: 'R₂ 2–100 s⁻¹ (log)' };
  }
  if (/^R1_[A-F]$/.test(p)) {
    return { fn: 'lin', low: 0.2, high: 3, count: 8, hint: 'R₁ 0.2–3 s⁻¹' };
  }
  if (p === 'TAUC_A' || /^TAUC/.test(p)) {
    return { fn: 'log', low: 1, high: 50, count: 10, hint: 'Rotational correlation time 1–50 ns (log)' };
  }

  // Unknown parameter: centre on the starting value when one is known.
  if (start !== undefined && Number.isFinite(start) && start !== 0) {
    const a = Math.abs(start);
    if (start > 0) {
      return { fn: 'log', low: round(a / 10), high: round(a * 10), count: 9, generic: true, hint: 'Starting value ÷10 … ×10 — review' };
    }
    return { fn: 'lin', low: round(start - a), high: round(start + a), count: 9, generic: true, hint: 'Starting value ±100 % — review' };
  }
  return { fn: 'lin', low: 0, high: 1, count: 5, generic: true, hint: 'No physical default known — set the range' };
}

function deDefault(param: string, family: ExperimentFamily, start?: number): RangeDefault {
  const p = param.toUpperCase();
  if (/^P[B-F]$/.test(p)) return { fn: 'log', low: 0.001, high: 0.3, count: 0, hint: 'Population 0.1–30 % (log)' };
  if (/^KEX_[A-F]{2}$/.test(p)) {
    if (isCpmg(family)) return { fn: 'log', low: 50, high: 20000, count: 0, hint: 'CPMG 50–2·10⁴ s⁻¹ (log)' };
    if (isCest(family)) return { fn: 'log', low: 10, high: 5000, count: 0, hint: 'CEST 10–5000 s⁻¹ (log)' };
    return { fn: 'log', low: 10, high: 20000, count: 0, hint: 'Combined 10–2·10⁴ s⁻¹ (log)' };
  }
  if (/^DW_[A-F]{2}$/.test(p)) {
    if (isCpmg(family)) return { fn: 'lin', low: 0, high: 10, count: 0, hint: '|Δϖ| 0–10 ppm' };
    return { fn: 'lin', low: -12, high: 12, count: 0, hint: 'Signed Δϖ −12…+12 ppm' };
  }
  const g = gridDefault(param, family, start);
  return { ...g, count: 0 };
}

const round = (x: number) => Number(x.toPrecision(3));

/** Default range for a parameter in the given search mode and experiment family. */
export function defaultRange(
  param: string,
  mode: Exclude<SearchMode, 'none'>,
  family: ExperimentFamily,
  startingValue?: number
): RangeDefault {
  return mode === 'de' ? deDefault(param, family, startingValue) : gridDefault(param, family, startingValue);
}

/** Build a new axis/coordinate pre-filled with the physical default range. */
export function createSearchAxis(
  param: string,
  mode: Exclude<SearchMode, 'none'>,
  family: ExperimentFamily,
  startingValue?: number
): SearchAxis {
  const d = defaultRange(param, mode, family, startingValue);
  return {
    id: newMethodId('axis'),
    param: param.toUpperCase(),
    fn: d.fn,
    low: d.low,
    high: d.high,
    count: mode === 'grid' ? d.count : 0,
  };
}

/** Parameters offered first in the "add axis" picker (basin-defining coordinates). */
export const PREFERRED_SEARCH_PARAMS = ['PB', 'KEX_AB', 'DW_AB', 'PC', 'KEX_AC', 'KEX_BC', 'DW_AC'];

/** Expanded point list for an axis (for previews and cost estimates). */
export function axisPoints(axis: SearchAxis): number[] {
  if (axis.fn === 'values') return [...(axis.values ?? [])];
  const n = Math.max(0, Math.floor(axis.count));
  if (n < 2) return n === 1 ? [axis.low] : [];
  if (axis.fn === 'log') {
    if (axis.low <= 0 || axis.high <= 0) return [];
    const a = Math.log10(axis.low);
    const b = Math.log10(axis.high);
    return Array.from({ length: n }, (_, i) => 10 ** (a + ((b - a) * i) / (n - 1)));
  }
  return Array.from({ length: n }, (_, i) => axis.low + ((axis.high - axis.low) * i) / (n - 1));
}

export function axisPointCount(axis: SearchAxis): number {
  return axis.fn === 'values' ? (axis.values?.length ?? 0) : Math.max(0, Math.floor(axis.count));
}
