import { describe, it, expect } from 'vitest';
import { availableChipMetrics, chipMetricValues, dipDepth, gapNumbers, shadeOf, type ProfileLike } from './residueMetrics';
import type { ResidueItem } from './residueSelection';
import type { OverviewStep } from './runOverview';

// 1 ppm = 50.68 Hz at b0 = 500 MHz (15N); carrier at 118 ppm.
const ppmHz = (ppm: number) => (ppm - 118) * 500 * 0.10136;
const profile = (minorDip: number, sign = 1): ProfileLike => {
  const offsets = [-100000];
  const intensities = [sign * 1000];
  for (let ppm = 110; ppm <= 126; ppm += 0.5) {
    offsets.push(ppmHz(ppm));
    // Symmetric major dip at 118 ppm + minor dip at 121 ppm.
    const major = 600 * Math.exp(-((ppm - 118) ** 2) / 2);
    const minor = ppm === 121 ? minorDip : 0;
    intensities.push(sign * (1000 - major - minor));
  }
  return { residue: '14N', experiments: [{ b1: '13Hz', b0: 500, carrier: 118, offsets, intensities }] };
};
const item = (id: string, n: number): ResidueItem => ({ id, number: n, label: id, hasData: true });

describe('dip depth', () => {
  it('measures the minor dip against its mirror about cs_a, as a fraction of I0 (any sign convention)', () => {
    expect(dipDepth(profile(150), { cs_a: 118, cs_b: 121 })).toBeCloseTo(0.15, 3);
    expect(dipDepth(profile(150, -1), { cs_a: 118, cs_b: 121 })).toBeCloseTo(0.15, 3);
    expect(dipDepth(profile(0), { cs_a: 118, cs_b: 121 })).toBeCloseTo(0, 6);
  });
  it('is null without a minor pick or usable data', () => {
    expect(dipDepth(profile(150), { cs_a: 118, cs_b: null })).toBeNull();
    expect(dipDepth(undefined, { cs_a: 118, cs_b: 121 })).toBeNull();
  });
});

describe('chip metrics', () => {
  const items = [item('14N', 14), item('15N', 15)];
  const runStep = {
    name: 'STEP2',
    residue_redchi: { '14N': 1.2, '15N': 3.4 },
    values: { DW_AB: { scope: 'residue', roles: ['fit'], copies: [{ residue: '14N', qualifier: '', role: 'fit', value: -2.5, stderr: null }] } },
  } as unknown as OverviewStep;

  it('collects dip depth, last-run red-χ² and |DW_AB| per chip', () => {
    const sources = { profiles: [profile(150)], picks: { '14N': { cs_a: 118, cs_b: 121 } }, runStep };
    expect(Object.keys(chipMetricValues('dip', items, sources))).toEqual(['14N']);
    expect(chipMetricValues('redchi', items, sources)).toEqual({ '14N': 1.2, '15N': 3.4 });
    expect(chipMetricValues('dw', items, sources)).toEqual({ '14N': 2.5 });
    expect(availableChipMetrics(items, sources)).toEqual(['dip', 'redchi', 'dw']);
    // Dip depth is the default (first) only when Pick CEST data exist.
    expect(availableChipMetrics(items, { runStep })).toEqual(['redchi', 'dw']);
  });

  it('shades within the observed range', () => {
    expect(shadeOf(2, 1, 3)).toBe(0.5);
    expect(shadeOf(5, 1, 3)).toBe(1);
    expect(shadeOf(1, 1, 1)).toBe(0.5);
  });
});

describe('gaps', () => {
  it('lists residue numbers absent from the data, within the sequence range or between data extremes', () => {
    const items = [item('3N', 3), item('5N', 5), item('S8N', 8)];
    expect(gapNumbers(items)).toEqual([4, 6, 7]);
    expect(gapNumbers(items, [1, 9])).toEqual([1, 2, 4, 6, 7, 9]);
    expect(gapNumbers([])).toEqual([]);
  });
});
