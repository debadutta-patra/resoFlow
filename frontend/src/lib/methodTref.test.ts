import { describe, expect, it } from 'vitest';
import { protectedTargetError, validateMethodConfig } from './methodValidation';
import type { MethodConfig, Step } from './methodConfig';

const step = (over: Partial<Step>): Step => ({ id: 's1', name: 'STEP1', parameters: [], residueMode: 'all', residues: [], ...over }) as Step;
const trefErrors = (s: Step) =>
  validateMethodConfig({ steps: [s] } as MethodConfig, ['TREF', 'DW0_AB']).filter(e => e.message.includes('TREF is a protected model constant'));

describe('TREF is never a method target', () => {
  it('is refused without a resolved catalogue', () => {
    expect(protectedTargetError('tref', 'FIT')).toContain('protected model constant');
    expect(protectedTargetError('DW0_AB', 'FIT')).toBeNull();
  });

  it('is refused in the table, role rules and GRID/DE axes', () => {
    expect(trefErrors(step({ parameters: [{ name: 'TREF', mode: 'fix' }] }))).toHaveLength(1);
    expect(trefErrors(step({ roleRules: [{ id: 'r', action: 'FIT', entries: ['TREF'] }] }))).toHaveLength(1);
    expect(
      trefErrors(step({ search: { mode: 'grid', axes: [{ id: 'a', param: 'TREF', fn: 'lin', low: 10, high: 30, count: 3 }] } }))
    ).toHaveLength(1);
    expect(trefErrors(step({ parameters: [{ name: 'DW0_AB', mode: 'fit' }] }))).toHaveLength(0);
  });
});
