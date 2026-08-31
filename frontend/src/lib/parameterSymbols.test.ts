import { describe, it, expect } from 'vitest';
import { parseParameterLabel, ppmToHz } from './parameterSymbols';

describe('parseParameterLabel', () => {
  it('parses multi-field relaxation parameters', () => {
    const res = parseParameterLabel('R2_A, NUC->55N, B0->600.3MHZ');
    expect(res.symbol).toBe('R₂_A');
    expect(res.displaySymbol).toBe('R₂⁰(A)');
    expect(res.residue).toBe('55N');
    expect(res.field).toBe('600 MHz');
    expect(res.category).toBe('relaxation');
    expect(res.unit).toBe('s⁻¹');
  });

  it('parses chemical shift parameters', () => {
    const res = parseParameterLabel('DW_AB, NUC->14N');
    expect(res.symbol).toBe('Δω_AB');
    expect(res.residue).toBe('14N');
    expect(res.category).toBe('chemical_shift');
    expect(res.unit).toBe('ppm');
  });

  it('parses global parameters', () => {
    const res1 = parseParameterLabel('[KEX_AB]');
    expect(res1.symbol).toBe('k_ex');
    expect(res1.residue).toBe('Global');
    expect(res1.category).toBe('global');
    expect(res1.unit).toBe('s⁻¹');

    const res2 = parseParameterLabel('PB');
    expect(res2.symbol).toBe('p_B');
    expect(res2.residue).toBe('Global');
    expect(res2.category).toBe('global');
  });

  it('converts ppm to Hz at 600 MHz 15N spectrometer', () => {
    const hz = ppmToHz(4.0, 600.0, '15N');
    // 4.0 ppm * 600 MHz * 0.10137 = 243.288 Hz
    expect(hz).toBeCloseTo(243.29, 1);
  });
});
