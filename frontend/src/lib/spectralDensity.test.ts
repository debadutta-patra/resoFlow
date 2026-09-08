import { describe, it, expect } from 'vitest';
import {
  B0_TOLERANCE_MHZ,
  checkFieldConsistency,
  constantsPayload,
  defaultConstantsForm,
  eligibleSources,
  errorEllipse,
  filterResidues,
  rigidRotorCurve,
  sortResidues,
  validateConstants,
  type SdmResidue,
  type SourceAnalysisOption,
} from './spectralDensity';

const source = (
  over: Partial<SourceAnalysisOption> = {},
): SourceAnalysisOption => ({
  analysis_uuid: 'u1',
  name: 'run',
  analysis_type: 'R1',
  status: 'COMPLETED',
  b0: 600.13,
  ...over,
});

describe('validateConstants', () => {
  it('accepts the default preset form', () => {
    expect(validateConstants(defaultConstantsForm())).toEqual([]);
  });

  it('rejects an unknown preset', () => {
    const form = { ...defaultConstantsForm(), rNhPreset: '1.09' };
    const issues = validateConstants(form);
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe('rNhPreset');
  });

  it('accepts plausible custom values', () => {
    const form = {
      ...defaultConstantsForm(),
      mode: 'custom' as const,
      rNhAngstrom: '1.02',
      deltaSigmaPpm: '-165',
    };
    expect(validateConstants(form)).toEqual([]);
  });

  it('catches a metre typed where an Angstrom was meant', () => {
    const form = {
      ...defaultConstantsForm(),
      mode: 'custom' as const,
      rNhAngstrom: '1.02e-10',
      deltaSigmaPpm: '-160',
    };
    const issues = validateConstants(form);
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe('rNhAngstrom');
    expect(issues[0].message).toMatch(/check the units/);
  });

  it('catches a CSA entered with the wrong magnitude', () => {
    const form = {
      ...defaultConstantsForm(),
      mode: 'custom' as const,
      rNhAngstrom: '1.02',
      deltaSigmaPpm: '-160000',
    };
    const issues = validateConstants(form);
    expect(issues[0].field).toBe('deltaSigmaPpm');
    expect(issues[0].message).toMatch(/±400 ppm/);
  });

  it('flags a positive CSA as a likely sign error', () => {
    const form = {
      ...defaultConstantsForm(),
      mode: 'custom' as const,
      rNhAngstrom: '1.02',
      deltaSigmaPpm: '160',
    };
    const issues = validateConstants(form);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/sign error/);
  });

  it('requires both custom fields', () => {
    const form = {
      ...defaultConstantsForm(),
      mode: 'custom' as const,
      rNhAngstrom: '',
      deltaSigmaPpm: '',
    };
    const issues = validateConstants(form);
    expect(issues.map((i) => i.field).sort()).toEqual(['deltaSigmaPpm', 'rNhAngstrom']);
  });

  it('rejects a non-positive bond length', () => {
    const form = {
      ...defaultConstantsForm(),
      mode: 'custom' as const,
      rNhAngstrom: '0',
      deltaSigmaPpm: '-160',
    };
    expect(validateConstants(form)[0].message).toMatch(/positive/);
  });
});

describe('constantsPayload', () => {
  it('sends presets by name', () => {
    expect(constantsPayload(defaultConstantsForm())).toEqual({
      r_nh_preset: '1.02',
      delta_sigma_preset: '-160',
    });
  });

  it('sends custom values as numbers', () => {
    const form = {
      ...defaultConstantsForm(),
      mode: 'custom' as const,
      rNhAngstrom: '1.015',
      deltaSigmaPpm: '-172',
    };
    expect(constantsPayload(form)).toEqual({
      r_nh_angstrom: 1.015,
      delta_sigma_ppm: -172,
    });
  });
});

describe('checkFieldConsistency', () => {
  it('accepts three sources at the same field', () => {
    const check = checkFieldConsistency([
      { role: 'R1', source: source({ b0: 600.13 }) },
      { role: 'R2', source: source({ b0: 600.13 }) },
      { role: 'hetNOE', source: source({ b0: 600.13 }) },
    ]);
    expect(check.ok).toBe(true);
    expect(check.b0).toBeCloseTo(600.13, 6);
    expect(check.message).toBeNull();
  });

  it('tolerates instrument-to-instrument scatter within a nominal field', () => {
    const check = checkFieldConsistency([
      { role: 'R1', source: source({ b0: 600.13 }) },
      { role: 'R2', source: source({ b0: 600.42 }) },
      { role: 'hetNOE', source: source({ b0: 600.05 }) },
    ]);
    expect(check.ok).toBe(true);
    expect(check.spread).toBeLessThan(B0_TOLERANCE_MHZ);
  });

  it('rejects a 600/800 mix and names every field', () => {
    const check = checkFieldConsistency([
      { role: 'R1', source: source({ b0: 600.13 }) },
      { role: 'R2', source: source({ b0: 800.2 }) },
      { role: 'hetNOE', source: source({ b0: 600.13 }) },
    ]);
    expect(check.ok).toBe(false);
    expect(check.message).toMatch(/different static fields/);
    expect(check.message).toMatch(/R2 800.20 MHz/);
    expect(check.message).toMatch(/single-field method/);
    expect(check.fields).toEqual({ R1: 600.13, R2: 800.2, hetNOE: 600.13 });
  });

  it('reports a missing field rather than assuming a default', () => {
    const check = checkFieldConsistency([
      { role: 'R1', source: source({ b0: null }) },
      { role: 'R2', source: source({ b0: 600.13 }) },
      { role: 'hetNOE', source: source({ b0: 600.13 }) },
    ]);
    expect(check.ok).toBe(false);
    expect(check.message).toMatch(/No static field recorded for: R1/);
    expect(check.message).toMatch(/not safe to assume a default/);
  });

  it('stays quiet while the selection is incomplete', () => {
    const check = checkFieldConsistency([
      { role: 'R1', source: source() },
      { role: 'R2', source: null },
      { role: 'hetNOE', source: null },
    ]);
    expect(check.ok).toBe(false);
    expect(check.message).toBeNull();
  });
});

describe('eligibleSources', () => {
  const analyses = [
    source({ analysis_uuid: 'a', analysis_type: 'R1', status: 'COMPLETED' }),
    source({ analysis_uuid: 'b', analysis_type: 'R1', status: 'RUNNING' }),
    source({ analysis_uuid: 'c', analysis_type: 'R2', status: 'COMPLETED' }),
    source({ analysis_uuid: 'd', analysis_type: 'hetNOE', status: 'COMPLETED' }),
    source({ analysis_uuid: 'e', analysis_type: 'CPMG', status: 'COMPLETED' }),
  ];

  it('keeps only completed analyses of the requested type', () => {
    expect(eligibleSources(analyses, 'R1').map((a) => a.analysis_uuid)).toEqual(['a']);
    expect(eligibleSources(analyses, 'R2').map((a) => a.analysis_uuid)).toEqual(['c']);
    expect(eligibleSources(analyses, 'hetNOE').map((a) => a.analysis_uuid)).toEqual(['d']);
  });
});

describe('errorEllipse', () => {
  it('is a circle for equal variances and no covariance', () => {
    const { x, y } = errorEllipse(0, 0, 4, 4, 0, 1, 60);
    for (let i = 0; i < x.length; i += 1) {
      expect(Math.hypot(x[i], y[i])).toBeCloseTo(2, 6);
    }
  });

  it('is axis-aligned with the right semi-axes when uncorrelated', () => {
    const { x, y } = errorEllipse(0, 0, 9, 1, 0, 1, 4);
    expect(Math.max(...x.map(Math.abs))).toBeCloseTo(3, 6);
    expect(Math.max(...y.map(Math.abs))).toBeCloseTo(1, 6);
  });

  it('tilts when the two quantities are correlated', () => {
    const upright = errorEllipse(0, 0, 4, 1, 0, 1, 200);
    const tilted = errorEllipse(0, 0, 4, 1, 1.5, 1, 200);
    // A positive covariance stretches the ellipse along the y = x diagonal,
    // which an uncorrelated ellipse of the same variances does not reach.
    const reach = (e: { x: number[]; y: number[] }) =>
      Math.max(...e.x.map((v, i) => (v + e.y[i]) / Math.SQRT2));
    expect(reach(tilted)).toBeGreaterThan(reach(upright));
  });

  it('is centred on the point', () => {
    const { x, y } = errorEllipse(3.5, 0.31, 0.01, 0.0001, 0.0005, 1, 40);
    // The bounding-box centre is exactly the ellipse centre, even for a
    // tilted ellipse. The arithmetic mean of the samples is not, because the
    // closed loop repeats its start point.
    expect((Math.min(...x) + Math.max(...x)) / 2).toBeCloseTo(3.5, 6);
    expect((Math.min(...y) + Math.max(...y)) / 2).toBeCloseTo(0.31, 6);
  });

  it('degenerates to a point for a zero covariance matrix', () => {
    const { x, y } = errorEllipse(1, 2, 0, 0, 0, 1, 8);
    expect(x.every((v) => Math.abs(v - 1) < 1e-12)).toBe(true);
    expect(y.every((v) => Math.abs(v - 2) < 1e-12)).toBe(true);
  });
});

describe('rigidRotorCurve', () => {
  const omegaN = -3.8226e8; // 600 MHz 1H

  it('falls monotonically in J(wN) as J(0) grows', () => {
    const { j0, jwn } = rigidRotorCurve(omegaN, 1, 6, 50);
    expect(j0[0]).toBeLessThan(j0[j0.length - 1]);
    for (let i = 1; i < jwn.length; i += 1) {
      expect(jwn[i]).toBeLessThanOrEqual(jwn[i - 1]);
    }
  });

  it('satisfies J(0)/J(wN) = 1 + (wN tau)^2 with tau = 2.5 J(0)', () => {
    const { j0, jwn } = rigidRotorCurve(omegaN, 2, 5, 10);
    for (let i = 0; i < j0.length; i += 1) {
      const tau = 2.5 * j0[i] * 1e-9;
      expect(j0[i] / jwn[i]).toBeCloseTo(1 + (omegaN * tau) ** 2, 6);
    }
  });
});

const residue = (over: Partial<SdmResidue> = {}): SdmResidue => ({
  assignment: 'G10N',
  res_num: 10,
  res_name: 'GLY',
  j0: 3.5,
  j_wn: 0.31,
  j_h: 0.011,
  j0_err: 0.1,
  j_wn_err: 0.01,
  j_h_err: 0.001,
  covariance: [[0.01, 0.002, 0.0005], [0.002, 0.0001, 0.00002], [0.0005, 0.00002, 1e-6]],
  r1: 1.35,
  r1_err: 0.03,
  r2: 12.1,
  r2_err: 0.3,
  noe: 0.78,
  noe_err: 0.04,
  sigma: 0.03,
  sigma_err: 0.005,
  tau_c: 9e-9,
  flags: [],
  ...over,
});

describe('sortResidues', () => {
  const rows = [
    residue({ assignment: 'A11N', res_num: 11, j0: 2.0 }),
    residue({ assignment: 'G10N', res_num: 10, j0: 5.0 }),
    residue({ assignment: 'L12N', res_num: 12, j0: 3.0 }),
  ];

  it('sorts numerically ascending and descending', () => {
    expect(sortResidues(rows, 'res_num', 'asc').map((r) => r.res_num)).toEqual([10, 11, 12]);
    expect(sortResidues(rows, 'j0', 'desc').map((r) => r.j0)).toEqual([5, 3, 2]);
  });

  it('sorts assignments as strings', () => {
    expect(sortResidues(rows, 'assignment', 'asc').map((r) => r.assignment)).toEqual([
      'A11N', 'G10N', 'L12N',
    ]);
  });

  it('puts nulls last regardless of direction', () => {
    const withNull = [...rows, residue({ assignment: 'X99N', res_num: 99, tau_c: null })];
    expect(sortResidues(withNull, 'tau_c', 'asc').at(-1)?.assignment).toBe('X99N');
    expect(sortResidues(withNull, 'tau_c', 'desc').at(-1)?.assignment).toBe('X99N');
  });

  it('does not mutate the input', () => {
    const original = rows.map((r) => r.assignment);
    sortResidues(rows, 'j0', 'desc');
    expect(rows.map((r) => r.assignment)).toEqual(original);
  });
});

describe('filterResidues', () => {
  const rows = [
    residue({ assignment: 'G10N', res_num: 10, res_name: 'GLY', flags: [] }),
    residue({ assignment: 'A11N', res_num: 11, res_name: 'ALA', flags: ['negative_noe'] }),
    residue({ assignment: 'L12N', res_num: 12, res_name: 'LEU', flags: ['elevated_j0'] }),
  ];

  it('matches assignment, residue number and residue name', () => {
    expect(filterResidues(rows, 'a11', false)).toHaveLength(1);
    expect(filterResidues(rows, '12', false)).toHaveLength(1);
    expect(filterResidues(rows, 'gly', false)).toHaveLength(1);
  });

  it('returns everything for an empty query', () => {
    expect(filterResidues(rows, '   ', false)).toHaveLength(3);
  });

  it('restricts to flagged residues when asked', () => {
    expect(filterResidues(rows, '', true).map((r) => r.assignment)).toEqual(['A11N', 'L12N']);
  });

  it('combines the query and the flagged filter', () => {
    expect(filterResidues(rows, 'a11', true)).toHaveLength(1);
    expect(filterResidues(rows, 'g10', true)).toHaveLength(0);
  });
});
