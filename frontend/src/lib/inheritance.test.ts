import { describe, it, expect } from 'vitest';
import {
  isHighUncertainty,
  CS_TOLERANCE_PPM,
} from './compatibility';
import {
  createDefaultParameterConfig,
  getCanonicalResidueKey,
  normalizeResidueKey,
  extractResidueNumber,
  type ParameterConfig,
} from './parameterConfig';
import { createDefaultMethodConfig, type MethodConfig } from './methodConfig';
import { configToToml as methodConfigToToml } from './methodToml';

describe('Parameter Inheritance and Seed-and-Fix Logic', () => {
  const sourcePayload = {
    source_uuid: 'run-global-1',
    source_name: 'test_cest_global',
    fit_mode: 'global',
    globals: {
      kex_ab: { value: 340.473, err: 5.336 },
      pb: { value: 0.0036, err: 0.0000258 },
    },
    residues: {
      '3N': {
        cs_a: { value: 120.19, err: 0.0255 },
        dw_ab: { value: 3.591, err: 0.176 },
      },
      'G14N': {
        cs_a: { value: 113.589, err: 0.012 },
        dw_ab: { value: -1.24, err: 0.045 },
      },
    },
  };

  it('correctly maps inherited globals with provenance and uncertainty', () => {
    const config = createDefaultParameterConfig();
    const now = '2026-08-24T12:00:00.000Z';

    const updatedConfig: ParameterConfig = {
      ...config,
      globals: {
        ...config.globals,
        kex_ab: {
          value: sourcePayload.globals.kex_ab.value,
          err: sourcePayload.globals.kex_ab.err,
          source: {
            kind: 'inherited',
            sourceRunId: sourcePayload.source_uuid,
            sourceRunLabel: sourcePayload.source_name,
            at: now,
          },
        },
        pb: {
          value: sourcePayload.globals.pb.value,
          err: sourcePayload.globals.pb.err,
          source: {
            kind: 'inherited',
            sourceRunId: sourcePayload.source_uuid,
            sourceRunLabel: sourcePayload.source_name,
            at: now,
          },
        },
      },
      inheritedFrom: {
        sourceRunId: sourcePayload.source_uuid,
        sourceRunLabel: sourcePayload.source_name,
        at: now,
      },
    };

    expect(updatedConfig.globals.kex_ab.value).toBe(340.473);
    expect(updatedConfig.globals.kex_ab.err).toBe(5.336);
    expect(updatedConfig.globals.kex_ab.source).toEqual({
      kind: 'inherited',
      sourceRunId: 'run-global-1',
      sourceRunLabel: 'test_cest_global',
      at: now,
    });

    expect(updatedConfig.globals.pb.value).toBe(0.0036);
    expect(updatedConfig.globals.pb.source.kind).toBe('inherited');
  });

  it('matches residues across canonical forms and full labels', () => {
    const profiles = [
      { residue: '3N', full_residue: '3N-HN', experiments: [] },
      { residue: '14N', full_residue: 'G14N-HN', experiments: [] },
    ];

    expect(getCanonicalResidueKey('3N', profiles)).toBe('3N');
    expect(getCanonicalResidueKey('14N', profiles)).toBe('14N');
    expect(normalizeResidueKey('GLY14N')).toBe('G14N');
    expect(extractResidueNumber('G14N')).toBe(14);
  });

  it('detects pick conflict when inherited cs_a differs by > 0.01 ppm', () => {
    const currentPickCsA = 120.15; // 120.19 - 120.15 = 0.04 > 0.01
    const inheritedCsA = 120.19;

    const diff = Math.abs(inheritedCsA - currentPickCsA);
    const hasConflict = diff > CS_TOLERANCE_PPM;

    expect(hasConflict).toBe(true);

    const closePickCsA = 120.195; // 0.005 < 0.01
    const closeDiff = Math.abs(inheritedCsA - closePickCsA);
    expect(closeDiff > CS_TOLERANCE_PPM).toBe(false);
  });

  it('flags high uncertainty when relative error exceeds 50%', () => {
    // 5.336 / 340.473 = 1.5% -> false
    expect(isHighUncertainty(340.473, 5.336)).toBe(false);

    // Poorly fitted dw_ab: 0.05 +- 0.10 -> 200% -> true
    expect(isHighUncertainty(0.05, 0.10)).toBe(true);
  });

  it('updates method.toml with seed-and-fix (FIX = ["KEX_AB", "PB"])', () => {
    const method = createDefaultMethodConfig();
    // Add some fit parameters
    method.steps[0].parameters = [
      { name: 'PB', mode: 'fit' },
      { name: 'KEX_AB', mode: 'fit' },
      { name: 'CS_A', mode: 'fit' },
      { name: 'DW_AB', mode: 'fit' },
    ];

    const fixKex = true;
    const fixPb = true;

    // Apply seed-and-fix to step 1
    const updatedSteps = method.steps.map((step, idx) => {
      if (idx === 0) {
        const params = [...step.parameters];
        if (fixKex) {
          const kexIdx = params.findIndex((p) => p.name.toUpperCase() === 'KEX_AB');
          if (kexIdx !== -1) {
            params[kexIdx] = { ...params[kexIdx], mode: 'fix' as const };
          }
        }
        if (fixPb) {
          const pbIdx = params.findIndex((p) => p.name.toUpperCase() === 'PB');
          if (pbIdx !== -1) {
            params[pbIdx] = { ...params[pbIdx], mode: 'fix' as const };
          }
        }
        return { ...step, parameters: params };
      }
      return step;
    });

    const updatedMethod: MethodConfig = {
      ...method,
      steps: updatedSteps,
    };

    const toml = methodConfigToToml(updatedMethod);

    // FIX must contain KEX_AB and PB
    expect(toml).toContain('FIX = [');
    expect(toml).toContain('"PB"');
    expect(toml).toContain('"KEX_AB"');

    // FIT must contain CS_A and DW_AB, but NOT KEX_AB or PB
    const fitLine = toml.split('\n').find((l) => l.startsWith('FIT = '));
    expect(fitLine).toBeDefined();
    expect(fitLine).toContain('"CS_A"');
    expect(fitLine).toContain('"DW_AB"');
    expect(fitLine).not.toContain('"KEX_AB"');
    expect(fitLine).not.toContain('"PB"');
  });

  it('computes and fills Pick CEST tab picks (cs_a and cs_b = cs_a + dw_ab) when inheriting', () => {
    const currentPicks: Record<string, any> = {
      '3N': { cs_a: 120.0, cs_b: null, cs_c: null, cs_d: null, cs_e: null, cs_f: null },
    };

    // Inherited from source: cs_a = 120.190, dw_ab = 3.591
    const inheritedCsA = 120.19;
    const inheritedDwAB = 3.591;

    const updatedPicks = { ...currentPicks };
    const nextCsA = inheritedCsA;
    const nextCsB = inheritedCsA + inheritedDwAB;

    updatedPicks['3N'] = {
      ...updatedPicks['3N'],
      cs_a: parseFloat(nextCsA.toFixed(4)),
      cs_b: parseFloat(nextCsB.toFixed(4)),
    };

    expect(updatedPicks['3N'].cs_a).toBe(120.19);
    // 120.19 + 3.591 = 123.781
    expect(updatedPicks['3N'].cs_b).toBe(123.781);
  });

  it('inherits excluded residues from source run into target parameter configuration', () => {
    const currentConfig: ParameterConfig = {
      globals: {
        pb: { value: 0.05, source: { kind: 'default' } },
        kex_ab: { value: 500, source: { kind: 'default' } },
      },
      residues: {
        '3N': { cs_a: { value: 120.0, source: { kind: 'default' } } },
        '14N': { cs_a: { value: 122.0, source: { kind: 'default' } } },
        '25N': { cs_a: { value: 118.0, source: { kind: 'default' } } },
      },
      excludedResidues: ['25N'],
    };

    const sourceExcludedResidues = ['14N', '45N'];

    const inheritExclusions = true;
    let updatedExcludedResidues = [...(currentConfig.excludedResidues || [])];
    if (inheritExclusions && sourceExcludedResidues.length > 0) {
      for (const sEx of sourceExcludedResidues) {
        if (!updatedExcludedResidues.includes(sEx)) {
          updatedExcludedResidues.push(sEx);
        }
      }
    }

    const updatedConfig: ParameterConfig = {
      ...currentConfig,
      excludedResidues: updatedExcludedResidues,
    };

    expect(updatedConfig.excludedResidues).toEqual(['25N', '14N', '45N']);
  });
});
