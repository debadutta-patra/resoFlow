import { describe, it, expect } from 'vitest';
import {
  B0_TOLERANCE_MHZ,
  checkFieldConsistency,
  constantsPayload,
  defaultConstantsForm,
  eligibleSources,
  errorEllipse,
  R2_PROVENANCE_OPTIONS,
  r2SourceType,
  filterResidues,
  includedResidues,
  rigidRotorLine,
  rigidRotorSweep,
  tauCFromResidues,
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

describe('R2 provenance', () => {
  it('defaults to the direct R2 experiment', () => {
    // The echo-decay measurement is the default choice; R2,0 from a CPMG fit
    // is opt-in, since it inherits that fit's exchange model.
    expect(R2_PROVENANCE_OPTIONS[0].value).toBe('echo_decay');
    expect(R2_PROVENANCE_OPTIONS[0].sourceType).toBe('R2');
  });

  it('maps each provenance to the analysis type that feeds it', () => {
    expect(r2SourceType('echo_decay')).toBe('R2');
    expect(r2SourceType('cpmg_r2_0')).toBe('CPMG');
  });

  it('offers exactly the two supported provenances', () => {
    expect(R2_PROVENANCE_OPTIONS.map((o) => o.value)).toEqual([
      'echo_decay', 'cpmg_r2_0',
    ]);
  });

  it('explains what each choice costs', () => {
    const [direct, cpmg] = R2_PROVENANCE_OPTIONS;
    expect(direct.hint).toMatch(/exchange/i);
    expect(cpmg.hint).toMatch(/exchange-free/i);
    // The CPMG option must not be sold as unconditionally better.
    expect(cpmg.hint).toMatch(/conditional on/i);
  });

  it('selects CPMG analyses for the R2 slot under cpmg_r2_0', () => {
    const analyses = [
      source({ analysis_uuid: 'r2', analysis_type: 'R2', status: 'COMPLETED' }),
      source({ analysis_uuid: 'cp', analysis_type: 'CPMG', status: 'COMPLETED' }),
      source({ analysis_uuid: 'cp2', analysis_type: 'CPMG', status: 'RUNNING' }),
    ];
    expect(
      eligibleSources(analyses, r2SourceType('cpmg_r2_0')).map((a) => a.analysis_uuid),
    ).toEqual(['cp']);
    expect(
      eligibleSources(analyses, r2SourceType('echo_decay')).map((a) => a.analysis_uuid),
    ).toEqual(['r2']);
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

describe('rigidRotorSweep', () => {
  const omegaN = -3.8226e8; // 600 MHz 1H

  it('rises to a maximum at omega_N tau = 1 and decays after it', () => {
    const { j0, jwn } = rigidRotorSweep(omegaN, 12);
    const peak = jwn.indexOf(Math.max(...jwn));
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThan(jwn.length - 1);
    // J(0) = (2/5)tau, so the peak sits at J(0) = (2/5)/omega_N.
    const expectedJ0 = (0.4 / Math.abs(omegaN)) * 1e9;
    expect(j0[peak]).toBeCloseTo(expectedJ0, 1);
  });

  it('is monotone in J(0), which is the abscissa', () => {
    const { j0 } = rigidRotorSweep(omegaN, 8);
    for (let i = 1; i < j0.length; i += 1) {
      expect(j0[i]).toBeGreaterThan(j0[i - 1]);
    }
  });

  it('satisfies J(wN) = J(0)/(1+(wN tau)^2) with tau = 2.5 J(0)', () => {
    const { j0, jwn } = rigidRotorSweep(omegaN, 6, 40);
    for (let i = 0; i < j0.length; i += 1) {
      const tau = 2.5 * j0[i] * 1e-9;
      expect(jwn[i]).toBeCloseTo(j0[i] / (1 + (Math.abs(omegaN) * tau) ** 2), 9);
    }
  });

  it('stays within the requested J(0) range', () => {
    const { j0 } = rigidRotorSweep(omegaN, 5);
    expect(Math.max(...j0)).toBeLessThanOrEqual(5);
  });

  it('returns nothing for a degenerate request', () => {
    expect(rigidRotorSweep(0, 5).j0).toEqual([]);
    expect(rigidRotorSweep(omegaN, 0).j0).toEqual([]);
  });
});

describe('rigidRotorLine', () => {
  const omegaN = -3.8226e8;

  it('passes through the origin', () => {
    const { j0, jwn } = rigidRotorLine(omegaN, 9e-9, 4);
    expect(j0[0]).toBe(0);
    expect(jwn[0]).toBe(0);
  });

  it('has slope 1/(1 + (wN tau_c)^2) with J(0) on the abscissa', () => {
    const tauC = 9e-9;
    const { j0, jwn } = rigidRotorLine(omegaN, tauC, 4);
    const slope = 1 / (1 + (Math.abs(omegaN) * tauC) ** 2);
    for (let i = 1; i < j0.length; i += 1) {
      expect(jwn[i] / j0[i]).toBeCloseTo(slope, 9);
    }
  });

  it('is shallower for a longer correlation time', () => {
    // A slower tumbler puts less spectral density at omega_N.
    const short = rigidRotorLine(omegaN, 5e-9, 4);
    const long = rigidRotorLine(omegaN, 12e-9, 4);
    expect(long.jwn[1] / long.j0[1]).toBeLessThan(short.jwn[1] / short.j0[1]);
  });

  it('ignores the sign of omega_N', () => {
    expect(rigidRotorLine(-3.8226e8, 9e-9, 4).jwn)
      .toEqual(rigidRotorLine(3.8226e8, 9e-9, 4).jwn);
  });
});

describe('tauCFromResidues', () => {
  const omegaN = -3.8226e8;

  const withRatio = (assignment: string, j0v: number, jwnv: number) =>
    residue({ assignment, j0: j0v, j_wn: jwnv });

  it('inverts J(0)/J(wN) = 1 + (wN tau_c)^2', () => {
    const tauC = 9e-9;
    const slope = 1 + (Math.abs(omegaN) * tauC) ** 2;
    const rows = [1, 2, 3, 4, 5].map((i) => withRatio(`R${i}N`, 3.3, 3.3 / slope));
    expect(tauCFromResidues(rows, omegaN)).toBeCloseTo(tauC, 12);
  });

  it('is robust to the outliers the plot exists to reveal', () => {
    const tauC = 9e-9;
    const slope = 1 + (Math.abs(omegaN) * tauC) ** 2;
    const clean = Array.from({ length: 20 }, (_, i) =>
      withRatio(`R${i}N`, 3.3, 3.3 / slope));
    // Two residues with wildly inflated J(0), as a bad R2 fit produces.
    const withOutliers = [
      ...clean,
      withRatio('X1N', 266, 0.28),
      withRatio('X2N', 229, 0.28),
    ];
    const trimmed = tauCFromResidues(withOutliers, omegaN)!;
    expect(trimmed).toBeCloseTo(tauC, 10);
  });

  it('returns null when the ratio is below 1', () => {
    // No rigid rotor can give J(wN) > J(0).
    const rows = [withRatio('R1N', 0.2, 0.5), withRatio('R2N', 0.2, 0.5)];
    expect(tauCFromResidues(rows, omegaN)).toBeNull();
  });

  it('returns null for an empty set', () => {
    expect(tauCFromResidues([], omegaN)).toBeNull();
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

describe('includedResidues', () => {
  const rows = [
    residue({ assignment: 'G10N', excluded: false }),
    residue({ assignment: 'A11N', excluded: true, exclusion_reason: 'excluded by user' }),
    residue({ assignment: 'L12N' }),
  ];

  it('drops excluded residues so plots match the summary', () => {
    expect(includedResidues(rows).map((r) => r.assignment)).toEqual(['G10N', 'L12N']);
  });

  it('treats a missing excluded field as included', () => {
    // Older payloads, and any row the server did not mark, must still plot.
    expect(includedResidues([residue({ assignment: 'X1N' })])).toHaveLength(1);
  });

  it('returns an empty list when everything is excluded', () => {
    const all = rows.map((r) => ({ ...r, excluded: true }));
    expect(includedResidues(all)).toEqual([]);
  });

  it('is independent of the table filters', () => {
    // The search box and flagged-only toggle are browsing aids; they must not
    // silently change which residues the plots draw.
    const flagged = [
      residue({ assignment: 'G10N', flags: [] }),
      residue({ assignment: 'A11N', flags: ['elevated_j0'] }),
    ];
    expect(includedResidues(flagged)).toHaveLength(2);
    expect(filterResidues(flagged, '', true)).toHaveLength(1);
  });

  it('does not mutate the input', () => {
    const before = rows.map((r) => r.assignment);
    includedResidues(rows);
    expect(rows.map((r) => r.assignment)).toEqual(before);
  });
});
