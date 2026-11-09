import { describe, expect, it } from 'vitest';
import { committedGlobalsByStep, lastCommittedStep } from './committedResults';
import { startingProvenance, type ParameterConfig } from './parameterConfig';

const results = {
  step_order: ['GLOBAL_FIT', 'LOCAL_FITS', 'STATS'],
  steps: {
    GLOBAL_FIT: { status: 'complete', globals: { pb: { value: 0.052 }, kex_ab: 410.5, tag: 'x' }, statistics: { redchi: 1.31 } },
    LOCAL_FITS: { status: 'complete', globals: { PB: { value: 0.05 } }, statistics: { chi2_red: 1.12 } },
    STATS: { status: 'missing' },
  },
};

describe('committed results', () => {
  it('collects numeric committed globals per step (upper-case keys)', () => {
    const by = committedGlobalsByStep(results);
    expect(by.GLOBAL_FIT).toEqual({ PB: 0.052, KEX_AB: 410.5 });
    expect(by.LOCAL_FITS).toEqual({ PB: 0.05 });
    expect(by.STATS).toBeUndefined();
  });

  it('reports the last step that actually committed', () => {
    expect(lastCommittedStep(results)).toEqual({ name: 'LOCAL_FITS', redchi: 1.12 });
    expect(lastCommittedStep({ global: { chi2_red: 2.5 } })).toEqual({ name: '', redchi: 2.5 });
    expect(lastCommittedStep(null)).toBeNull();
  });
});

describe('starting-value provenance', () => {
  it('names the source of global and per-residue starting values', () => {
    const cfg = {
      globals: { pb: { value: 0.05, source: { kind: 'default' } }, kex_ab: { value: 300, source: { kind: 'manual' } } },
      residues: {
        '13N': { dw_ab: { value: 4, source: { kind: 'pick', pickSetHash: 'h', at: 't' } }, cs_a: { value: 118, source: { kind: 'pick', pickSetHash: 'h', at: 't' } } },
        '14N': { dw_ab: { value: 3, source: { kind: 'pick', pickSetHash: 'h', at: 't' } } },
        '15N': { dw_ab: { value: 0, source: { kind: 'default' } } },
      },
    } as unknown as ParameterConfig;
    const p = startingProvenance(cfg, 'Pick CEST');
    expect(p.PB).toEqual({ value: 0.05, source: 'default' });
    expect(p.KEX_AB).toEqual({ value: 300, source: 'manual' });
    expect(p.DW_AB).toEqual({ source: 'Per residue · Pick CEST 2 · default 1' });
    expect(p.CS_A).toEqual({ source: 'Per residue · Pick CEST' });
  });
});
