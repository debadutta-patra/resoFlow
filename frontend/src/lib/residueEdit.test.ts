import { describe, expect, it } from 'vitest';
import { configToToml } from './parameterToml';
import { editResidueValue, type ParameterConfig } from './parameterConfig';

const base = (): ParameterConfig => ({
  globals: {},
  residues: {
    '13N': {
      cs_a: { value: 110, lower: 100, upper: 120, source: { kind: 'pick', pickSetHash: 'h', at: 't' } },
      dw_ab: { value: 2, source: { kind: 'pick', pickSetHash: 'h', at: 't' } },
    },
  },
});

describe('editResidueValue', () => {
  it('clearing a value unsets it (never 0) and ChemEx defaults apply', () => {
    const next = editResidueValue(base(), '13N', 'dw_ab', undefined, [], 'now');
    expect(next.residues['13N'].dw_ab).toBeUndefined();
    expect(configToToml(next)).not.toContain('[DW_AB]');
    expect(editResidueValue(base(), '13N', 'cs_a', undefined).residues['13N'].cs_a).toBeUndefined();
  });

  it('DW_AB edits never write CS_A (no silent CS_A = 0)', () => {
    const cfg: ParameterConfig = { globals: {}, residues: {} };
    const next = editResidueValue(cfg, '5N', 'dw_ab', -3.5, [], 'now');
    expect(next.residues['5N']).toEqual({ dw_ab: { value: -3.5, source: { kind: 'manual', at: 'now' } } });
  });

  it('CS_A edits keep CS_B in place by moving DW_AB, and keep bounds', () => {
    const next = editResidueValue(base(), '13N', 'cs_a', 111, [], 'now');
    expect(next.residues['13N'].cs_a).toMatchObject({ value: 111, lower: 100, upper: 120, source: { kind: 'manual' } });
    expect(next.residues['13N'].dw_ab?.value).toBe(1); // CS_B stays 112
  });

  it('CS_B edits DW_AB = CS_B − CS_A, and needs CS_A to be set', () => {
    expect(editResidueValue(base(), '13N', 'cs_b', 107.5).residues['13N'].dw_ab?.value).toBe(-2.5);
    const noCsA: ParameterConfig = { globals: {}, residues: { '7N': {} } };
    expect(editResidueValue(noCsA, '7N', 'cs_b', 120)).toBe(noCsA);
    expect(editResidueValue(base(), '13N', 'cs_b', undefined).residues['13N'].dw_ab).toBeUndefined();
  });

  it('R1_A / R2_A are set and cleared independently', () => {
    const set = editResidueValue(base(), '13N', 'r2_a', 12.5);
    expect(set.residues['13N'].r2_a?.value).toBe(12.5);
    expect('r2_a' in editResidueValue(set, '13N', 'r2_a', undefined).residues['13N']).toBe(false);
  });

  it('merges alias keys of the same residue into the canonical key', () => {
    const cfg: ParameterConfig = { globals: {}, residues: { K13N: { r1_a: { value: 1, source: { kind: 'manual' } } }, '13N': {} } };
    const next = editResidueValue(cfg, '13N', 'cs_a', 110, [{ residue: '13N', full_residue: 'K13N' }]);
    expect(Object.keys(next.residues)).toEqual(['13N']);
  });
});

describe('bulkEditResidues', () => {
  it('applies one edit to many residues, keeping per-residue bounds', async () => {
    const { bulkEditResidues } = await import('./parameterConfig');
    const next = bulkEditResidues(base(), ['13N', '14N'], 'cs_a', 115, [], 'now');
    expect(next.residues['13N'].cs_a).toMatchObject({ value: 115, lower: 100, upper: 120 });
    expect(next.residues['14N'].cs_a?.value).toBe(115);
  });
});
