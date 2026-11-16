import { describe, it, expect } from 'vitest';
import {
  cestDw,
  cestRexConsistency,
  curveForField,
  duplicateMask,
  dwFromRex,
  dwSeedRange,
  fitCurvesFromResults,
  formatFieldMHz,
  matchCestPick,
  meanByNu,
  residualsAgainst,
} from './cpmgInspection';
import { estimateDeltaOmegaFastExchange } from './cpmgReduction';

const XI = 0.101329118;

describe('labels and duplicates', () => {
  it('rounds the field to two decimals', () => {
    expect(formatFieldMHz(600.2649)).toBe('600.26 MHz');
    expect(formatFieldMHz(800)).toBe('800 MHz');
    expect(formatFieldMHz(undefined)).toBe('600 MHz');
  });

  it('marks repeated ν_CPMG points', () => {
    expect(duplicateMask([50, 100, 50, 1000, 100.0005])).toEqual([true, true, true, false, true]);
  });

  it('guide line averages duplicates in ν order (not acquisition order)', () => {
    const g = meanByNu([1000, 50, 500, 50], [10, 20, 14, 22]);
    expect(g).toEqual({ x: [50, 500, 1000], y: [21, 14, 10] });
  });
});

describe('Rex → |Δω| seeds', () => {
  it('inverts Rex = pA pB Δω² / kex', () => {
    const pb = 0.05, kex = 1000, b0 = 600;
    const dwPpm = 2.0;
    const dwRad = dwPpm * 2 * Math.PI * b0 * XI;
    const rex = (1 - pb) * pb * dwRad ** 2 / kex;
    expect(dwFromRex(rex, pb, kex, b0, XI)).toBeCloseTo(2.0, 10);
    // Same as the existing (rounded) estimator.
    expect(estimateDeltaOmegaFastExchange(rex, kex, pb, b0, XI)).toBeCloseTo(2.0, 3);
  });

  it('rejects unphysical inputs', () => {
    expect(dwFromRex(0, 0.05, 1000, 600, XI)).toBeNull();
    expect(dwFromRex(-3, 0.05, 1000, 600, XI)).toBeNull();
    expect(dwFromRex(5, 1, 1000, 600, XI)).toBeNull();
    expect(dwFromRex(5, 0.05, 0, 600, XI)).toBeNull();
  });

  it('range spans the pB × kex corners', () => {
    const a = { pb: 0.05, kex: 1000, pbRange: [0.02, 0.1] as [number, number], kexRange: [500, 2000] as [number, number] };
    const r = dwSeedRange(10, a, 600, XI)!;
    expect(r.value).toBeCloseTo(dwFromRex(10, 0.05, 1000, 600, XI)!, 12);
    // Largest at high kex & low pB; smallest at low kex & high pB.
    expect(r.max).toBeCloseTo(dwFromRex(10, 0.02, 2000, 600, XI)!, 12);
    expect(r.min).toBeCloseTo(dwFromRex(10, 0.1, 500, 600, XI)!, 12);
    expect(r.min).toBeLessThan(r.value);
    expect(r.value).toBeLessThan(r.max);
    expect(dwSeedRange(0, a, 600, XI)).toBeNull();
  });
});

describe('CEST consistency', () => {
  const range = { value: 2, min: 1, max: 3 };

  it('compares |Δω_CEST| with the widened range', () => {
    expect(cestRexConsistency(-2.5, range)).toBe('consistent'); // sign ignored
    expect(cestRexConsistency(3.8, range, 0.3)).toBe('consistent'); // ≤ 3.9
    expect(cestRexConsistency(4.0, range, 0.3)).toBe('disagree');
    expect(cestRexConsistency(0.7, range, 0.3)).toBe('disagree'); // < 1/1.3
    expect(cestRexConsistency(null, range)).toBe('n/a');
    expect(cestRexConsistency(2, null)).toBe('n/a');
  });

  it('matches CEST picks through SpinSystemKey and keeps the sign', () => {
    const picks = { '10N': { cs_a: 118, cs_b: 116.5 }, 'G12N': { cs_a: 120, cs_b: null } };
    expect(cestDw(matchCestPick(picks, 'G10N-HN'))).toBeCloseTo(-1.5, 12);
    expect(cestDw(matchCestPick(picks, '12N'))).toBeNull();
    expect(matchCestPick(picks, '11N')).toBeUndefined();
  });
});

describe('fitted curves', () => {
  const results = {
    residues: {
      '5N': {
        experiments: [
          { b1_label: '600MHz', fit_curve: { x: [0, 100, 200], y: [20, 15, 10] } },
          { b0: 800.2, calc_points: { x: [0, 200], y: [30, 10] } },
          { b1_label: 'x', fit_curve: { x: [1], y: [] } },
        ],
      },
    },
  };

  it('extracts curves with their field', () => {
    const c = fitCurvesFromResults(results)['5N'];
    expect(c.map(x => x.b0)).toEqual([600, 800.2]);
    expect(curveForField(c, 800.26, 0)?.b0).toBe(800.2);
    expect(curveForField(c, 950, 0)).toBeUndefined();
  });

  it('residuals interpolate the curve', () => {
    const c = fitCurvesFromResults(results)['5N'][0];
    const r = residualsAgainst(c, [50, 200, 300], [18, 11, 5]);
    expect(r[0]).toBeCloseTo(18 - 17.5, 12);
    expect(r[1]).toBeCloseTo(1, 12);
    expect(Number.isNaN(r[2])).toBe(true);
  });
});
