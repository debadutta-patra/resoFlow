import { describe, expect, it } from 'vitest';
import { mainDipPpm, offsetHzToPpm } from './cestProfileSeed';
import {
  createDefaultParameterConfig,
  dropLegacyDefaultGlobals,
  seedCsAFromProfiles,
  startingValuesFromGlobals,
  unsetStartingParams,
  type ParameterConfig,
} from './parameterConfig';
import { createDefaultCpmgParameterConfig } from './cpmgConfig';
import { validateParameterConfig } from './parameterValidation';

const XI_15N = 0.101329118;

/** Synthetic CEST profile: Lorentzian dips at `dipsHz` (depths), reference point at -20 kHz. */
function profile(residue: string, dipsHz: Array<[number, number]>, b0 = 600, carrier = 118) {
  const offsets = [-20000];
  const intensities = [1000];
  for (let o = -1500; o <= 1500; o += 25) {
    let y = 1;
    for (const [c, depth] of dipsHz) y -= depth / (1 + ((o - c) / 40) ** 2);
    offsets.push(o);
    intensities.push(1000 * y);
  }
  return { residue, experiments: [{ b0, carrier, offsets, intensities }] };
}

describe('mainDipPpm', () => {
  it('finds the deepest dip (major state), not the minor one', () => {
    const p = profile('13N', [[300, 0.8], [-500, 0.2]]);
    expect(mainDipPpm(p, XI_15N)).toBeCloseTo(offsetHzToPpm(300, 600, 118, XI_15N), 2);
  });

  it('returns null without a clear dip or without data', () => {
    expect(mainDipPpm(profile('1N', []), XI_15N)).toBeNull();
    expect(mainDipPpm({ experiments: [] }, XI_15N)).toBeNull();
    expect(mainDipPpm(undefined, XI_15N)).toBeNull();
  });

  it('takes the median across B1 experiments', () => {
    const a = profile('2N', [[100, 0.8]]).experiments[0];
    const b = profile('2N', [[150, 0.8]]).experiments[0];
    const c = profile('2N', [[1000, 0.8]]).experiments[0];
    expect(mainDipPpm({ experiments: [a, b, c] }, XI_15N)).toBeCloseTo(offsetHzToPpm(150, 600, 118, XI_15N), 2);
  });
});

describe('seedCsAFromProfiles', () => {
  const profiles = [profile('1N', [[0, 0.8]]), profile('2N', [[0, 0.8]]), profile('3N', [[0, 0.8]]), profile('4N', [[0, 0.8]]), profile('5N', [[0, 0.8]])];
  const config: ParameterConfig = {
    globals: {},
    residues: {
      '2N': { cs_a: { value: 120, source: { kind: 'manual' } } },
      '3N': { cs_a: { value: 121, source: { kind: 'imported' } } },
      '4N': { cs_a: { value: 99, lower: 90, upper: 130, source: { kind: 'estimated_from_profile' } } },
    },
  };
  const picks = { '5N': { cs_a: 117.5, cs_b: null } };

  it('seeds only residues without a pick and without a user/imported value, keeping bounds', () => {
    const { config: next, seeded } = seedCsAFromProfiles(config, profiles, picks, () => 118.25, 'now');
    expect(seeded.sort()).toEqual(['1N', '4N']);
    expect(next.residues['1N'].cs_a).toEqual({ value: 118.25, source: { kind: 'estimated_from_profile', at: 'now' } });
    expect(next.residues['4N'].cs_a).toMatchObject({ value: 118.25, lower: 90, upper: 130 });
    expect(next.residues['2N'].cs_a?.value).toBe(120); // manual untouched
    expect(next.residues['3N'].cs_a?.value).toBe(121); // imported untouched
    expect(next.residues['5N']).toBeUndefined(); // has a pick
  });

  it('skips excluded residues and residues without an estimate', () => {
    const { seeded } = seedCsAFromProfiles({ ...config, excludedResidues: ['1N'] }, profiles, picks, p =>
      p.residue === '4N' ? null : 118
    );
    expect(seeded).toEqual([]);
  });
});

describe('ChemEx defaults as starting values', () => {
  it('new configs pre-fill nothing', () => {
    expect(createDefaultParameterConfig().globals).toEqual({});
    expect(createDefaultCpmgParameterConfig().globals).toEqual({});
  });

  it('Methods starting values fall back to ChemEx defaults', () => {
    expect(startingValuesFromGlobals({ globals: {}, residues: {} })).toMatchObject({ PB: 0.05, KEX_AB: 200, TAUC_A: 4 });
  });

  it('drops untouched legacy resoFlow defaults but keeps edited or bounded ones', () => {
    const { config, dropped } = dropLegacyDefaultGlobals({
      globals: {
        pb: { value: 0.05, source: { kind: 'default' } },
        kex_ab: { value: 500, source: { kind: 'default' } },
        dw_ab: { value: 2, source: { kind: 'default' }, lower: 0 },
        tauc_a: { value: 6, source: { kind: 'manual' } },
      },
      residues: {},
    });
    expect(dropped.sort()).toEqual(['KEX_AB', 'PB']);
    expect(Object.keys(config.globals).sort()).toEqual(['dw_ab', 'tauc_a']);
  });

  it('counts a [GLOBAL] value as set for every residue', () => {
    const cfg: ParameterConfig = { globals: { dw_ab: { value: 2, source: { kind: 'manual' } } }, residues: { '1N': {} } };
    expect(unsetStartingParams(cfg, '1N', ['cs_a', 'dw_ab'])).toEqual(['cs_a']);
  });
});

describe('zero-DW quick-fix (dispersion)', () => {
  const cfg: ParameterConfig = { globals: {}, residues: { '1N': { cs_a: { value: 120, source: { kind: 'manual' } } } } };

  it('warns when residues would start DW_AB at 0 and offers [GLOBAL] DW_AB', () => {
    const issues = validateParameterConfig(cfg, { availableResidues: ['1N', '2N'], zeroDwQuickFix: { value: 2 } });
    const issue = issues.find(i => i.id === 'dw-zero-start');
    expect(issue?.message).toContain('2 residues');
    expect(issue?.quickFix).toEqual({ label: 'Set [GLOBAL] DW_AB = 2', kind: 'set_global', key: 'dw_ab', value: 2 });
  });

  it('is silent when a global DW_AB is set or the capability is absent', () => {
    expect(validateParameterConfig(cfg, { availableResidues: ['1N'] }).some(i => i.id === 'dw-zero-start')).toBe(false);
    const withGlobal = { ...cfg, globals: { dw_ab: { value: 2, source: { kind: 'manual' as const } } } };
    expect(
      validateParameterConfig(withGlobal, { availableResidues: ['1N'], zeroDwQuickFix: { value: 2 } }).some(i => i.id === 'dw-zero-start')
    ).toBe(false);
  });
});
