import { describe, expect, it } from 'vitest';
import { derivedKinetics, topologyFor } from './kineticDerived';
import { globalRoleChip, residueTreatment, resolvedStepFor } from './parameterRoleChip';
import type { Step } from './methodConfig';
import type { ResolvedParameter, ResolvedStep } from './resolvedRoles';

const values = (v: Record<string, number>) => (n: string) => v[n];

describe('derivedKinetics (ChemEx pair_rates)', () => {
  it('2st: PA = 1 − PB, KAB = KEX·PB, KBA = KEX·PA, τ = 1/k', () => {
    const d = derivedKinetics('2st', values({ PB: 0.05, KEX_AB: 200 }))!;
    const by = Object.fromEntries(d.map(q => [q.key, q.value]));
    expect(by.PA).toBeCloseTo(0.95);
    expect(by.KAB).toBeCloseTo(10);
    expect(by.KBA).toBeCloseTo(190);
    expect(by.TAU_A).toBeCloseTo(0.1);
    expect(by.TAU_B).toBeCloseTo(1 / 190);
  });

  it('3st (complete graph): k_ij = kex_ij·p_j/(p_i+p_j); τ_A sums both exits', () => {
    const d = derivedKinetics('3st.tc', values({ PB: 0.1, PC: 0.1, KEX_AB: 100, KEX_AC: 300, KEX_BC: 50 }))!;
    const by = Object.fromEntries(d.map(q => [q.key, q.value]));
    expect(by.PA).toBeCloseTo(0.8);
    expect(by.KAB).toBeCloseTo((100 * 0.1) / 0.9);
    expect(by.KCA).toBeCloseTo((300 * 0.8) / 0.9);
    expect(by.KBC).toBeCloseTo(25);
    expect(by.TAU_A).toBeCloseTo(1 / ((100 * 0.1) / 0.9 + (300 * 0.1) / 0.9));
  });

  it('uses ChemEx topologies and skips other parameterisations', () => {
    expect(topologyFor('3st_linear')!.edges).toEqual([['a', 'b'], ['b', 'c']]);
    expect(topologyFor('4st_fork')!.edges).toEqual([['a', 'b'], ['a', 'c'], ['a', 'd']]);
    expect(topologyFor('3st_triangle')!.edges).toHaveLength(3);
    for (const m of ['2st_binding', '2st_eyring', '2st_hd', '1st', '2st_rs']) expect(derivedKinetics(m, () => 1)).toBeNull();
    expect(derivedKinetics('3st', values({ PB: 0.1 }))).toBeNull(); // incomplete inputs
  });
});

const step = (over: Partial<Step> = {}): Step =>
  ({ id: 's1', name: 'STEP1', parameters: [], residueMode: 'all', residues: [], ...over }) as Step;
const rp = (name: string, spin: string, role: ResolvedParameter['role'], extra: Partial<ResolvedParameter> = {}): ResolvedParameter => ({
  id: `__${name}_${spin}`,
  name,
  spin,
  conditions: {},
  scope: spin ? 'residue' : 'global',
  role,
  expression: '',
  decided_by: 'baseline',
  rule: null,
  protected: false,
  ...extra,
});
const resolved = (params: ResolvedParameter[], name = 'STEP1'): ResolvedStep =>
  ({ name, roles_from: null, profiles: 2, parameters: params, counts: {} as never, error: null }) as ResolvedStep;

describe('globalRoleChip', () => {
  it('uses ChemEx-resolved roles when available', () => {
    const s = step({ parameters: [{ name: 'PB', mode: 'fit' }] });
    expect(globalRoleChip('pb', s, resolved([rp('PB', '', 'fix')]), 0)?.label).toBe('FIX');
    expect(globalRoleChip('kex_ab', s, resolved([rp('KEX_AB', '', 'derived', { expression: '[KEX_AC]' })]), 0)).toMatchObject({
      label: 'CONSTRAIN',
      tone: 'constrain',
    });
  });

  it('falls back to table, role rules and ChemEx default roles until resolved', () => {
    expect(globalRoleChip('pb', step(), undefined, 0)?.label).toBe('FIT'); // ChemEx fits PB by default
    expect(globalRoleChip('tauc_a', step(), undefined, 0)?.label).toBe('FIX');
    expect(globalRoleChip('pb', step({ roleRules: [{ id: 'r', action: 'FIX', entries: ['PB'] }] }), undefined, 0)?.label).toBe('FIX');
    expect(
      globalRoleChip('kex_ab', step({ search: { mode: 'grid', axes: [{ id: 'a', param: 'KEX_AB', fn: 'log', low: 10, high: 1000, count: 5 }] } }), undefined, 0)
        ?.label
    ).toBe('GRID');
  });

  it('shows no chip for the protected TREF', () => {
    expect(globalRoleChip('tref', step(), undefined, 0)).toBeNull();
    expect(globalRoleChip('pb', undefined, undefined, 0)).toBeNull();
  });

  it('matches resolved steps by name, else by position', () => {
    const steps = [resolved([], 'A'), resolved([], 'B')];
    expect(resolvedStepFor(steps, step({ name: 'B' }), 0)?.name).toBe('B');
    expect(resolvedStepFor(steps, step({ name: 'Z' }), 1)?.name).toBe('B');
  });
});

describe('residueTreatment', () => {
  it('reads per-residue resolved roles (SpinSystemKey match), not the legacy table', () => {
    const r = resolved([rp('CS_A', 'K3N-H', 'fix'), rp('DW_AB', 'K3N-H', 'fit'), rp('CS_A', '4N', 'fix'), rp('DW_AB', '4N', 'fix')]);
    expect(residueTreatment(step(), r, '3N')).toBe('Fit');
    expect(residueTreatment(step(), r, '4N')).toBe('Fixed');
  });

  it('honours INCLUDE/EXCLUDE and falls back to default roles', () => {
    expect(residueTreatment(step({ residueMode: 'exclude', residues: ['K3N'] }), undefined, '3N')).toBe('Excluded');
    expect(residueTreatment(step({ residueMode: 'include', residues: ['4N'] }), undefined, '3N')).toBe('Excluded');
    expect(residueTreatment(step(), undefined, '3N')).toBe('Fit'); // DW_AB is fitted by default
    expect(
      residueTreatment(step({ parameters: [{ name: 'CS_A', mode: 'fix' }, { name: 'DW_AB', mode: 'fix' }] }), undefined, '3N')
    ).toBe('Fixed');
  });
});
