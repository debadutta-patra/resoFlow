import { describe, expect, it } from 'vitest';
import type { Step } from './methodConfig';
import { actionTarget, rulesByTargetName, stepBadge, stepBadgeText, tableActionCount, type ResolvedStep } from './resolvedRoles';

const step: Step = {
  id: 's',
  name: 'S',
  residueMode: 'all',
  residues: [],
  parameters: [
    { name: 'R2_B', mode: 'constrain', expression: '[R2_A]' },
    { name: 'DW_AB', mode: 'fix' },
  ],
  roleRules: [
    { id: 'empty', action: 'FIT', entries: ['  '] },
    { id: 'r1', action: 'FIT', entries: ['', 'DW_AB, NUC->26N', 'PB'] },
    { id: 'r2', action: 'CONSTRAIN', entries: ['[DW_AB, NUC->28N] = [DW_AB, NUC->26N]'] },
  ],
  search: { mode: 'grid', axes: [{ id: 'a', param: 'PB', fn: 'lin', low: 0, high: 1, count: 3 }] },
  statistics: { mc: { enabled: true, replicates: 10 }, mcmc: { enabled: false, steps: 10, burn: 'auto' } },
};

describe('ROLES action mapping', () => {
  it('maps emitted action/entry indices back to table actions and rule entries', () => {
    // Emitted: CONSTRAIN(table), FIX(table), FIT r1, CONSTRAIN r2 — the blank rule is skipped, and the
    // search target PB is not auto-added to the table FIT because rule r1 already FITs it.
    expect(tableActionCount(step)).toBe(2);
    expect(actionTarget(step, 0)).toEqual({ kind: 'table', action: 'CONSTRAIN', entry: '[R2_B] = [R2_A]' });
    // r1's blank first entry is not emitted, so ChemEx entry 1 is the rule's entry index 2.
    expect(actionTarget(step, 2, 1)).toEqual({ kind: 'rule', ruleId: 'r1', ruleIndex: 1, entryIndex: 2 });
    expect(actionTarget(step, 3, 0)).toEqual({ kind: 'rule', ruleId: 'r2', ruleIndex: 2, entryIndex: 0 });
    expect(actionTarget(step, 9)).toBeNull();
  });

  it('lists the rules that target each parameter name', () => {
    expect(rulesByTargetName(step)).toEqual({ DW_AB: ['r1', 'r2'], PB: ['r1'] });
  });
});

describe('step badges', () => {
  const resolved = {
    name: 'S',
    roles_from: null,
    profiles: 2,
    error: null,
    counts: { fit: 3, fix: 1, constrained: 0, derived: 0 },
    parameters: [
      { id: '__PB', name: 'PB', spin: '', role: 'fit' },
      { id: '__DW_AB_26N', name: 'DW_AB', spin: '26N', role: 'fit' },
      { id: '__R2_A_26N', name: 'R2_A', spin: '26N', role: 'fit' },
      { id: '__DW_AB_28N', name: 'DW_AB', spin: '28N', role: 'fix' },
    ],
  } as unknown as ResolvedStep;

  it('reports resolved coordinates, residues, search and statistics', () => {
    const b = stepBadge(step, resolved);
    expect(b).toEqual({ coords: 3, residues: 2, search: 'grid', statistics: ['MC'] });
    expect(stepBadgeText(b)).toBe('3 coords · 2 res');
  });

  it('has no counts until ChemEx resolved the step', () => {
    expect(stepBadgeText(stepBadge(step, undefined))).toBeNull();
  });
});
