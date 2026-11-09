import { describe, expect, it } from 'vitest';
import { baselineRoleLabel, buildParameterCatalog, summarizeBaselineRoles } from './baselineRoles';

describe('baseline roles from ChemEx inspection', () => {
  const rows = [
    { id: '__PB', name: 'PB', status: 'fit' },
    { id: '__CS_A_13N', name: 'CS_A', status: 'fix' },
    { id: '__CS_A_14N', name: 'CS_A', status: 'fix' },
    { id: '__R1_B_13N', name: 'R1_B', status: 'constrain', expr: '[R1_A]' },
    { id: '__R2_A_13N', name: 'R2_A', status: 'fit' },
    { id: '__R2_A_14N', name: 'r2_a', status: 'fix' },
  ];
  const summary = summarizeBaselineRoles(rows);

  it('reports a single role when all concrete copies agree', () => {
    expect(baselineRoleLabel(summary.PB)).toBe('Fit');
    expect(baselineRoleLabel(summary.CS_A)).toBe('Fixed');
    expect(baselineRoleLabel(summary.R1_B)).toBe('Derived');
  });

  it('reports counts when copies differ, and null when unknown', () => {
    expect(baselineRoleLabel(summary.R2_A)).toBe('Fit 1 · Fixed 1');
    expect(baselineRoleLabel(summary.KEX_AB)).toBeNull();
  });
});


describe('parameter catalog for the selector builder', () => {
  it('collects spins, conditions and protection per name', () => {
    const cat = buildParameterCatalog([
      { id: '1', name: 'PB', status: 'fit', spin: '', conditions: {} },
      { id: '2', name: 'DW_AB', status: 'fit', spin: '26N', conditions: {} },
      { id: '3', name: 'DW_AB', status: 'fit', spin: '3N', conditions: {} },
      { id: '4', name: 'R2_A', status: 'fit', spin: '3N', conditions: { h_larmor_frq: 800.1, temperature: 25 } },
      { id: '5', name: 'R2_A', status: 'fit', spin: '3N', conditions: { h_larmor_frq: 600.1, temperature: 25 } },
      { id: '6', name: 'KAB', status: 'constrain', spin: '', protected: true },
    ]);
    expect(cat.PB.scope).toBe('global');
    expect(cat.DW_AB.spins).toEqual(['3N', '26N']);
    expect(cat.R2_A.B0).toEqual(['600.1MHz', '800.1MHz']);
    expect(cat.R2_A.T).toEqual(['25C']);
    expect(cat.KAB.protected).toBe(true);
    expect(cat.PB.protected).toBe(false);
  });
});
