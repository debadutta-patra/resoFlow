import { describe, it, expect } from 'vitest';
import { axisRangeText, expressionRhs, idNameMap, prettifyExpression, roleView } from './parameterRoleView';
import type { ResolvedParameter } from './resolvedRoles';
import type { SearchAxis, Step } from './methodConfig';

const rp = (over: Partial<ResolvedParameter>): ResolvedParameter => ({
  id: '__X',
  name: 'X',
  spin: '',
  conditions: {},
  scope: 'global',
  role: 'fit',
  expression: '',
  decided_by: 'baseline',
  rule: null,
  protected: false,
  value: null,
  ...over,
});
const axis = (over: Partial<SearchAxis> = {}): SearchAxis => ({ id: 'ax1', param: 'PB', fn: 'log', low: 0.001, high: 0.03, count: 10, ...over });
const noSearch: Pick<Step, 'search'> = {};

describe('roleView', () => {
  it('GRID axis: range text, no starting value unless the axis is qualified', () => {
    const v = roleView({ name: 'PB', step: { search: { mode: 'grid', axes: [axis()] } }, tableMode: 'fit', stepIndex: 0 });
    expect(v).toMatchObject({ kind: 'grid', text: 'log(0.001–0.03, 10 pts)', partial: false });
    const q = roleView({ name: 'DW_AB', step: { search: { mode: 'grid', axes: [axis({ param: 'DW_AB', qualifier: 'NUC->23N', fn: 'lin', low: -5, high: 5, count: 3 })] } }, tableMode: 'fit', stepIndex: 0 });
    expect(q).toMatchObject({ kind: 'grid', partial: true });
  });

  it('DE coordinate: DE range text without a point count', () => {
    const v = roleView({ name: 'KEX_AB', step: { search: { mode: 'de', axes: [axis({ param: 'KEX_AB', low: 20, high: 2000 })] } }, tableMode: 'fit', stepIndex: 0 });
    expect(v).toMatchObject({ kind: 'de', text: 'log(20–2000)' });
  });

  it('Fit (not a search target)', () => {
    expect(roleView({ name: 'PB', step: noSearch, tableMode: 'default', resolved: [rp({ role: 'fit' })], stepIndex: 0 }).kind).toBe('fit');
  });

  it('Fixed on the first step: value range, unit, residue count and source', () => {
    const resolved = [
      rp({ name: 'CS_A', role: 'fix', spin: '14N', scope: 'residue', value: 117.2 }),
      rp({ name: 'CS_A', role: 'fix', spin: '23N', scope: 'residue', value: 121.8 }),
    ];
    const v = roleView({ name: 'CS_A', step: noSearch, tableMode: 'fix', resolved, stepIndex: 0, sourceLabel: 'Pick CEST' });
    expect(v).toEqual({ kind: 'fix', text: '117.2–121.8 ppm across 2 residues · Pick CEST', count: 2 });
    const g = roleView({ name: 'KEX_AB', step: noSearch, tableMode: 'default', resolved: [rp({ role: 'fix', value: 0.005 })], stepIndex: 0 });
    expect(g).toMatchObject({ kind: 'fix', text: '0.005 s⁻¹ · parameters file' });
  });

  it('Fixed on a later step: committed by the previous step', () => {
    const v = roleView({ name: 'PB', step: noSearch, tableMode: 'fix', resolved: [rp({ role: 'fix', value: 0.1 })], stepIndex: 1, previousStepName: 'STEP1', committedPrevious: 0.012 });
    expect(v).toMatchObject({ kind: 'fix', text: 'value committed by STEP1 (last run: 0.012)' });
  });

  it('Derived: model-owned vs default constraint vs rule, with ids printed by name', () => {
    const owned = roleView({ name: 'PA', step: noSearch, tableMode: 'default', resolved: [rp({ name: 'PA', role: 'derived', protected: true, decided_by: 'model', expression: '1.0 - __PB' })], stepIndex: 0, idNames: { __PB: 'PB' } });
    expect(owned).toMatchObject({ kind: 'derived', expression: '1.0 - [PB]', modelOwned: true, defaultConstraint: false });
    const dflt = roleView({
      name: 'R1_B',
      step: noSearch,
      tableMode: 'default',
      resolved: [
        rp({ name: 'R1_B', role: 'derived', expression: '__R1_A_13N_499_2MHZ', spin: '13N' }),
        rp({ name: 'R1_B', role: 'derived', expression: '__R1_A_26N_499_2MHZ', spin: '26N' }),
      ],
      stepIndex: 0,
      idNames: { __R1_A_13N_499_2MHZ: 'R1_A', __R1_A_26N_499_2MHZ: 'R1_A' },
    });
    expect(dflt).toMatchObject({ kind: 'derived', expression: '[R1_A]', modelOwned: false, defaultConstraint: true });
    expect(expressionRhs('[R1_A]')).toBe('= [R1_A]');
    const rule = roleView({ name: 'R2_B', step: noSearch, tableMode: 'constrain', resolved: [rp({ name: 'R2_B', role: 'constrained', decided_by: 'rule', expression: '[R2_A]' })], stepIndex: 0 });
    expect(rule).toMatchObject({ kind: 'derived', modelOwned: false, defaultConstraint: false });
  });

  it('Mixed roles across copies', () => {
    const v = roleView({ name: 'DW_AB', step: noSearch, tableMode: 'default', resolved: [rp({ role: 'fit' }), rp({ role: 'fix' }), rp({ role: 'fix' })], stepIndex: 0 });
    expect(v).toEqual({ kind: 'mixed', counts: { fit: 1, fix: 2 } });
  });

  it('falls back to the table mode until ChemEx has resolved the step', () => {
    expect(roleView({ name: 'PB', step: noSearch, tableMode: 'fit', stepIndex: 0 }).kind).toBe('fit');
    expect(roleView({ name: 'PB', step: noSearch, tableMode: 'default', stepIndex: 0 }).kind).toBe('unresolved');
  });
});

describe('helpers', () => {
  it('formats values() axes and maps unknown ids by their name prefix', () => {
    expect(axisRangeText(axis({ fn: 'values', values: [0.01, 0.02] }), 'grid')).toBe('values(0.01, 0.02)');
    expect(prettifyExpression('__CS_A_13N + __DW_AB_13N')).toBe('[CS_A] + [DW_AB]');
    expect(idNameMap([rp({ id: '__PB', name: 'pb' })])).toEqual({ __PB: 'PB' });
  });
});
