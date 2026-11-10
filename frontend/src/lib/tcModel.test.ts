import { describe, expect, it } from 'vitest';
import {
  convertLegacyTc,
  convertPlainShiftsToTc,
  isTcModel,
  obsoleteTcKeys,
  plainShiftResidues,
  scanLegacyTc,
  tcDerived,
} from './tcModel';
import { tomlToConfig } from './parameterToml';
import { validateParameterConfig } from './parameterValidation';
import type { ParameterConfig } from './parameterConfig';
import type { Step } from './methodConfig';

describe('.tc model helpers', () => {
  it('detects .tc models', () => {
    expect(isTcModel('2st.tc')).toBe(true);
    expect(isTcModel('2st_eyring.tc')).toBe(true);
    expect(isTcModel('2st.mf.tc')).toBe(true);
    expect(isTcModel('2st')).toBe(false);
    expect(isTcModel('3st_tc')).toBe(false);
  });

  it('derives CS_A and DW_AB at a temperature', () => {
    const p = {
      cs0_a: { value: 118, source: { kind: 'manual' as const } },
      cs1_a: { value: -0.01, source: { kind: 'manual' as const } },
      dw0_ab: { value: 2, source: { kind: 'manual' as const } },
    };
    expect(tcDerived(p, 25, 35)).toEqual({ cs_a: 117.9, dw_ab: 2 });
    expect(tcDerived({}, 25, 35)).toEqual({ cs_a: null, dw_ab: null });
  });

  it('moves plain CS_A/DW_AB to the order-0 coefficients, keeping bounds, never overwriting', () => {
    const cfg: ParameterConfig = {
      globals: {},
      residues: {
        '3N': { cs_a: { value: 116, lower: 100, upper: 130, source: { kind: 'pick', pickSetHash: 'h', at: 't' } }, dw_ab: { value: 2, source: { kind: 'manual' } } },
        '4N': { cs_a: { value: 1, source: { kind: 'manual' } }, cs0_a: { value: 120, source: { kind: 'manual' } } },
      },
    };
    expect(plainShiftResidues(cfg)).toEqual(['3N', '4N']);
    const next = convertPlainShiftsToTc(cfg);
    expect(next.residues['3N']).toEqual({
      cs0_a: { value: 116, lower: 100, upper: 130, source: { kind: 'pick', pickSetHash: 'h', at: 't' } },
      dw0_ab: { value: 2, source: { kind: 'manual' } },
    });
    expect(next.residues['4N']).toEqual({ cs0_a: { value: 120, source: { kind: 'manual' } } });
    expect(plainShiftResidues(next)).toEqual([]);
  });
});

describe('DWP/DWM → DW0/DW1 (never silent)', () => {
  const legacy = `[GLOBAL]\nTREF = 20.0\nPB = 0.05\n\n[DWP_AB]\n3N = 2.0\n4N = [1.0, -5.0, 5.0]\n\n[DWM_AB]\n3N = 0.01\n\n[CS0_A]\n3N = 118.0\n`;

  it('previews the conversion with TREF from the file', () => {
    const scan = scanLegacyTc(legacy);
    expect(scan).toMatchObject({ tref: 20, trefFromFile: true });
    const r3 = scan.rows.find(r => r.residue === '3N')!;
    expect(r3.dw0).toBeCloseTo(2.2); // 2.0 + 20·0.01
    expect(r3.dw1).toBeCloseTo(0.01);
    expect(scan.rows.find(r => r.residue === '4N')).toMatchObject({ dw0: 1, dw1: 0, boundsDropped: true });
    expect(scanLegacyTc('[GLOBAL]\nPB = 0.1\n').rows).toEqual([]);
    expect(scanLegacyTc('[DWP_AC]\n5N = 1\n')).toMatchObject({ tref: 25, trefFromFile: false });
  });

  it('rewrites the file with DW0_AX/DW1_AX sections and keeps everything else', () => {
    const out = convertLegacyTc(legacy);
    expect(out).not.toMatch(/DW[PM]_AB/);
    const { config, unparsed } = tomlToConfig(out);
    expect(unparsed).toEqual([]);
    expect(config.residues['3N'].dw0_ab?.value).toBeCloseTo(2.2);
    expect(config.residues['3N'].dw1_ab?.value).toBeCloseTo(0.01);
    expect(config.residues['3N'].cs0_a?.value).toBe(118);
    expect(config.globals.tref?.value).toBe(20);
    expect(convertLegacyTc('[GLOBAL]\nPB = 0.1\n')).toBe('[GLOBAL]\nPB = 0.1\n');
  });

  it('flags leftover DWP/DWM in a config', () => {
    expect(obsoleteTcKeys(tomlToConfig(legacy).config)).toEqual(['DWM_AB', 'DWP_AB']);
  });
});

describe('.tc validation', () => {
  const step = (over: Partial<Step> = {}): Step => ({ id: 's1', name: 'STEP1', parameters: [], residueMode: 'all', residues: [], ...over }) as Step;
  const cfg: ParameterConfig = { globals: {}, residues: { '3N': { dw_ab: { value: 2, source: { kind: 'manual' } } } } };

  it('warns that plain CS_A/DW_AB freeze the shifts under .tc and offers the conversion', () => {
    const issue = validateParameterConfig(cfg, { model: '2st.tc' }).find(i => i.id === 'tc-plain-shifts');
    expect(issue?.quickFix).toEqual({ label: 'Move to CS0_A / DW0_AB', kind: 'convert_tc' });
    expect(validateParameterConfig(cfg, { model: '2st' }).some(i => i.id === 'tc-plain-shifts')).toBe(false);
  });

  it('warns when an order-0/order-1 pair is free at a single temperature (ChemEx fits DW0/DW1 by default)', () => {
    const issues = validateParameterConfig({ globals: {}, residues: {} }, { model: '2st.tc', methodConfig: { steps: [step()] } });
    const deg = issues.find(i => i.id === 'tc-degenerate-s1');
    expect(deg?.message).toContain('DW0_AB and DW1_AB');
    const fixed = validateParameterConfig(
      { globals: {}, residues: {} },
      { model: '2st.tc', methodConfig: { steps: [step({ parameters: [{ name: 'DW1_AB', mode: 'fix' }] })] } }
    );
    expect(fixed.some(i => i.id === 'tc-degenerate-s1')).toBe(false);
    const multiT = validateParameterConfig({ globals: {}, residues: {} }, { model: '2st.tc', temperatureCount: 3, methodConfig: { steps: [step()] } });
    expect(multiT.some(i => i.id.startsWith('tc-degenerate'))).toBe(false);
  });
});
