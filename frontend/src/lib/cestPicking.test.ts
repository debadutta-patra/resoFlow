import { describe, it, expect } from 'vitest';
import {
  b1Hz,
  deltaVarpi,
  differenceTrace,
  fitParabola,
  formatFieldLabel,
  heatmapPanels,
  interpolate,
  profilePoints,
  snapAcrossExperiments,
  snapToMinimum,
  trimNumber,
  fittedShiftsFromResults,
  normalizeRows,
  rowBaseline,
  valueRange,
} from './cestPicking';

const XI = 0.101329118;
const B0 = 600;
const HZ_PER_PPM = B0 * XI;

/** Experiment whose I/I0 is f(ppm), with one reference plane (I0 = 2). */
function exp(b1: number, f: (ppm: number) => number, carrier = 118, n = 41, spanPpm = 4) {
  const offsets = [-100000];
  const intensities = [2];
  for (let i = 0; i < n; i++) {
    const ppm = carrier - spanPpm / 2 + (spanPpm * i) / (n - 1);
    offsets.push((ppm - carrier) * HZ_PER_PPM);
    intensities.push(2 * f(ppm));
  }
  return { b1: `600MHz_${b1}hz`, b1_actual: b1, b0: B0, carrier, offsets, intensities, uncertainties: intensities.map(() => 0.02) };
}

const lorentzDip = (cs: number, depth: number, w: number) => (ppm: number) => 1 - depth / (1 + ((ppm - cs) / w) ** 2);

describe('labels', () => {
  it('fixes the "67hzHz" label: measured B1, else parsed from the label', () => {
    expect(formatFieldLabel({ b0: 600, b1: '600MHz_67hz', b1_actual: 67 })).toBe('600 MHz, B1 = 67 Hz');
    expect(formatFieldLabel({ b0: 600, b1: '600MHz_67hz' })).toBe('600 MHz, B1 = 67 Hz');
    expect(formatFieldLabel({ b0: 800.234, b1: '25' })).toBe('800.23 MHz, B1 = 25 Hz');
    expect(formatFieldLabel({ b0: 600, b1: 'unknown' })).toBe('600 MHz');
    expect(b1Hz({ b1: '12.5Hz' })).toBe(12.5);
  });

  it('trims numbers', () => {
    expect(trimNumber(600.0)).toBe('600');
    expect(trimNumber(600.2649)).toBe('600.26');
  });

  it('signed Δϖ in ppm and Hz', () => {
    const d = deltaVarpi(120, 118.5, 600, XI);
    expect(d.ppm).toBeCloseTo(-1.5, 12);
    expect(d.hz).toBeCloseTo(-1.5 * 600 * XI, 9);
  });
});

describe('profilePoints', () => {
  it('normalises by the reference plane, converts to ppm, keeps plane indices', () => {
    const pts = profilePoints(exp(25, () => 0.5), XI);
    expect(pts).toHaveLength(41);
    expect(pts[0].plane).toBe(1); // plane 0 is the reference
    expect(pts[0].y).toBeCloseTo(0.5, 12);
    expect(pts[0].ppm).toBeCloseTo(116, 9);
    expect(pts[0].err).toBeCloseTo(0.01, 12);
  });
});

describe('snapToMinimum', () => {
  it('parabola vertex is exact for parabolic data, wherever the click lands in the basin', () => {
    const xs = [0, 1, 2, 3, 4, 5, 6];
    const ys = xs.map(x => (x - 2.7) ** 2 + 0.3);
    for (const click of [0.2, 2.1, 4.9]) {
      const r = snapToMinimum(xs, ys, click)!;
      expect(r.refined).toBe(true);
      expect(r.x).toBeCloseTo(2.7, 10);
      expect(r.y).toBeCloseTo(0.3, 10);
    }
  });

  it('finds the local (not global) minimum nearest the click', () => {
    const xs = Array.from({ length: 81 }, (_, i) => 114 + i * 0.1);
    const f = (x: number) => lorentzDip(116, 0.8, 0.3)(x) * lorentzDip(120, 0.2, 0.2)(x);
    const ys = xs.map(f);
    expect(snapToMinimum(xs, ys, 119.6)!.x).toBeCloseTo(120, 1);
    expect(snapToMinimum(xs, ys, 116.4)!.x).toBeCloseTo(116, 1);
  });

  it('refines a Lorentzian dip between samples', () => {
    const xs = Array.from({ length: 41 }, (_, i) => 116 + i * 0.1);
    const ys = xs.map(lorentzDip(117.73, 0.6, 0.25));
    const r = snapToMinimum(xs, ys, 117.5)!;
    expect(Math.abs(r.x - 117.73)).toBeLessThan(0.01);
  });

  it('falls back to the data minimum at an edge, and respects maxDistance', () => {
    const xs = [0, 1, 2, 3];
    const ys = [0, 1, 2, 3];
    expect(snapToMinimum(xs, ys, 2)).toMatchObject({ x: 0, refined: false });
    expect(snapToMinimum(xs, ys, 10, { maxDistance: 1 })).toBeNull();
    expect(snapToMinimum([], [], 1)).toBeNull();
  });

  it('fitParabola recovers coefficients', () => {
    const xs = [1, 2, 3, 4, 5];
    const p = fitParabola(xs, xs.map(x => 2 * x * x - 3 * x + 1))!;
    // y = a u² + b u + d with u = x − c, c = 3
    expect(p.c).toBe(3);
    expect(p.a).toBeCloseTo(2, 10);
    expect(p.b).toBeCloseTo(2 * 2 * 3 - 3, 10);
    expect(p.d).toBeCloseTo(2 * 9 - 9 + 1, 10);
    expect(fitParabola([1, 2], [1, 2])).toBeNull();
  });

  it('across experiments keeps the deepest minimum and skips masked planes', () => {
    const shallow = exp(50, lorentzDip(118.2, 0.2, 0.3));
    const deep = exp(25, lorentzDip(118.0, 0.7, 0.3));
    expect(snapAcrossExperiments([shallow, deep], 118.1, XI)).toBeCloseTo(118.0, 2);
    // Mask every plane of the deep experiment: only the shallow one is left.
    const masked = (e: { b1: string }) => e.b1 === deep.b1;
    expect(snapAcrossExperiments([shallow, deep], 118.1, XI, masked)).toBeCloseTo(118.2, 2);
  });
});

describe('differenceTrace', () => {
  it('is lowest B1 minus highest B1 on a common grid over the overlap', () => {
    const low = exp(15, () => 0.9, 118, 41, 4);          // 116..120 ppm
    const high = exp(60, ppm => 0.5 + 0.01 * ppm, 118, 21, 2); // 117..119 ppm
    const t = differenceTrace([high, low], XI)!;
    expect(t.low.b1_actual).toBe(15);
    expect(t.high.b1_actual).toBe(60);
    expect(t.x).toHaveLength(41);
    expect(t.x[0]).toBeCloseTo(117, 9);
    expect(t.x[40]).toBeCloseTo(119, 9);
    t.x.forEach((x, i) => expect(t.y[i]).toBeCloseTo(0.9 - (0.5 + 0.01 * x), 9));
  });

  it('needs two distinct B1 fields', () => {
    expect(differenceTrace([exp(25, () => 1)], XI)).toBeNull();
    expect(differenceTrace([exp(25, () => 1), exp(25, () => 1)], XI)).toBeNull();
  });

  it('interpolate', () => {
    expect(interpolate([2, 0], [20, 0], 0.5)).toBeCloseTo(5, 12);
    expect(Number.isNaN(interpolate([0, 1], [0, 1], 2))).toBe(true);
  });
});

describe('heatmapPanels', () => {
  it('builds one residues × offsets matrix per B1, sorted by ppm', () => {
    const profiles = [
      { residue: '1N', experiments: [exp(25, () => 0.4, 118, 5), exp(50, () => 0.6, 118, 5)] },
      { residue: '2N', experiments: [exp(25, () => 0.8, 118, 5)] },
    ];
    const panels = heatmapPanels(profiles, XI);
    expect(panels.map(p => p.title)).toEqual(['600 MHz, B1 = 25 Hz', '600 MHz, B1 = 50 Hz']);
    expect(panels[0].residues).toEqual(['1N', '2N']);
    expect(panels[0].x).toHaveLength(5);
    expect(panels[0].z[1][2]).toBeCloseTo(0.8, 12);
    expect(panels[1].residues).toEqual(['1N']);
  });
});

describe('fittedShiftsFromResults', () => {
  it('reads the primary step, deriving CS_B from DW_AB when needed', () => {
    const results = {
      primary_step: 's2',
      residues: { '1N': { cs_a: { value: 1 } } },
      steps: {
        s2: {
          residues: {
            '1N': { cs_a: { value: 118.2 }, dw_ab: { value: -1.5 } },
            '2N': { parameters: { CS_A: { value: 120 }, CS_B: 122.5 } },
            '3N': { parameters: {} },
          },
        },
      },
    };
    expect(fittedShiftsFromResults(results)).toEqual({
      '1N': { cs_a: 118.2, cs_b: 116.7 },
      '2N': { cs_a: 120, cs_b: 122.5 },
    });
    expect(fittedShiftsFromResults(null)).toEqual({});
  });
});

describe('heatmap ordering and colour scaling', () => {
  it('orders rows by residue number, not text', () => {
    const p = (residue: string) => ({ residue, experiments: [exp(25, () => 0.5, 118, 5)] });
    const panels = heatmapPanels([p('9N'), p('75N'), p('G10N'), p('6N'), p('69N')], XI);
    expect(panels[0].residues).toEqual(['6N', '9N', 'G10N', '69N', '75N']);
  });

  it('row baseline is the median of the top quartile (off-resonance plateau)', () => {
    // 8 values, top quartile = [0.46, 0.45] → 0.455
    expect(rowBaseline([0.1, 0.2, 0.44, 0.45, 0.46, 0.3, 0.4, 0.41])).toBeCloseTo(0.455, 12);
    expect(rowBaseline([null, null])).toBeNull();
  });

  it('per-row normalisation puts every plateau at 1, so weak dips compare across rows', () => {
    const z = normalizeRows([
      [0.45, 0.45, 0.2, 0.45],
      [0.9, 0.9, 0.4, 0.9],
      [null, 0.5, 0.5, 0.5],
    ]);
    expect(z[0][0]).toBeCloseTo(1, 12);
    expect(z[0][2]).toBeCloseTo(0.2 / 0.45, 12);
    expect(z[1][2]).toBeCloseTo(0.4 / 0.9, 12);
    expect(z[2][0]).toBeNull();
  });

  it('valueRange spans the data', () => {
    expect(valueRange([[0.2, null], [0.47, 0.3]])).toEqual([0.2, 0.47]);
    expect(valueRange([[null]])).toEqual([0, 1]);
  });
});
