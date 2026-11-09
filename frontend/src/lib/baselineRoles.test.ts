import { describe, expect, it } from 'vitest';
import { baselineRoleLabel, summarizeBaselineRoles } from './baselineRoles';

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
