/**
 * Per-residue metrics for shading the Methods residue chips, and gap placeholders.
 *
 *  - Pick CEST dip depth: how much deeper the profile is at the picked minor-state shift
 *    (cs_b) than at its mirror image about cs_a (2·cs_a − cs_b). The major-state dip is
 *    symmetric, so the difference isolates the minor dip; normalised by I0 (reference
 *    point, |offset| > 10 kHz) and taken as the largest over B1 fields.
 *  - Last-run reduced χ² and |DW_AB| come from the run overview.
 */

import { SpinSystemKey } from './spinSystem';
import type { ResidueItem } from './residueSelection';
import type { OverviewStep } from './runOverview';

export interface ProfileExperiment {
  b1?: string;
  b0?: number;
  carrier?: number;
  offsets?: number[];
  intensities?: number[];
  error?: string;
}

export interface ProfileLike {
  residue: string;
  experiments: ProfileExperiment[];
}

export interface PickLike {
  cs_a?: number | null;
  cs_b?: number | null;
}

export type ChipMetric = 'dip' | 'redchi' | 'dw';

export const CHIP_METRIC_LABEL: Record<ChipMetric, string> = {
  dip: 'Pick CEST dip depth',
  redchi: 'Last-run red-χ²',
  dw: '|DW_AB| (last run)',
};

/** 15N gyromagnetic ratio relative to 1H, as used by ProfileThumbnail. */
const N15_RATIO = 0.10136;

const ppmToHz = (ppm: number, e: ProfileExperiment) => (ppm - (e.carrier ?? 0)) * (e.b0 || 600) * N15_RATIO;

function nearest(offsets: number[], intensities: number[], hz: number): number | null {
  let best = -1;
  let dist = Infinity;
  for (let i = 0; i < offsets.length; i++) {
    if (Math.abs(offsets[i]) > 10000) continue;
    const d = Math.abs(offsets[i] - hz);
    if (d < dist) {
      dist = d;
      best = i;
    }
  }
  return best === -1 ? null : intensities[best];
}

/** Minor-state dip depth (fraction of I0), or null without a usable pick / profile. */
export function dipDepth(profile: ProfileLike | undefined, pick: PickLike | null | undefined): number | null {
  if (!profile || !pick || typeof pick.cs_a !== 'number' || typeof pick.cs_b !== 'number') return null;
  const mirror = 2 * pick.cs_a - pick.cs_b;
  let best: number | null = null;
  for (const e of profile.experiments) {
    if (e.error || !e.offsets?.length || !e.intensities?.length) continue;
    const ref = e.offsets.findIndex(o => Math.abs(o) > 10000);
    const i0 = ref !== -1 ? e.intensities[ref] : NaN;
    if (!Number.isFinite(i0) || i0 === 0) continue;
    const atB = nearest(e.offsets, e.intensities, ppmToHz(pick.cs_b, e));
    const atMirror = nearest(e.offsets, e.intensities, ppmToHz(mirror, e));
    if (atB === null || atMirror === null) continue;
    const depth = (atMirror - atB) / i0;
    if (best === null || depth > best) best = depth;
  }
  return best === null ? null : Math.max(0, best);
}

/** Value per chip id for the chosen metric (ids without a value are omitted). */
export function chipMetricValues(
  metric: ChipMetric,
  items: ResidueItem[],
  sources: { profiles?: ProfileLike[]; picks?: Record<string, PickLike | null | undefined>; runStep?: OverviewStep }
): Record<string, number> {
  const out: Record<string, number> = {};
  const byNum = (key: string) => SpinSystemKey.parse(key).resNum;
  for (const item of items) {
    let v: number | null | undefined = null;
    if (metric === 'dip') {
      v = dipDepth(sources.profiles?.find(p => p.residue === item.id), sources.picks?.[item.id]);
    } else if (metric === 'redchi') {
      const map = sources.runStep?.residue_redchi ?? {};
      const key = Object.keys(map).find(k => k === item.id || byNum(k) === item.number);
      v = key ? map[key] : null;
    } else {
      const copies = sources.runStep?.values.DW_AB?.copies ?? [];
      const c = copies.find(x => x.residue === item.id || byNum(x.residue) === item.number);
      v = c?.value !== null && c?.value !== undefined ? Math.abs(c.value) : null;
    }
    if (typeof v === 'number' && Number.isFinite(v)) out[item.id] = v;
  }
  return out;
}

/** Metrics that have data, in preference order (dip depth first when available). */
export function availableChipMetrics(
  items: ResidueItem[],
  sources: { profiles?: ProfileLike[]; picks?: Record<string, PickLike | null | undefined>; runStep?: OverviewStep }
): ChipMetric[] {
  return (['dip', 'redchi', 'dw'] as ChipMetric[]).filter(m => Object.keys(chipMetricValues(m, items, sources)).length > 0);
}

/** Shade 0..1 of a value within [min, max] (0 when the range collapses). */
export function shadeOf(value: number, min: number, max: number): number {
  if (!(max > min)) return 0.5;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/**
 * Residue numbers absent from the data, in sequence order: within the sequence range when a
 * sequence is known, else between the smallest and largest residue number present.
 */
export function gapNumbers(items: ResidueItem[], range?: [number, number] | null): number[] {
  const present = new Set(items.map(i => SpinSystemKey.parse(i.id).resNum || i.number).filter(n => n > 0));
  if (present.size === 0 && !range) return [];
  const lo = range ? range[0] : Math.min(...present);
  const hi = range ? range[1] : Math.max(...present);
  const out: number[] = [];
  for (let n = lo; n <= hi; n++) if (!present.has(n)) out.push(n);
  return out;
}
