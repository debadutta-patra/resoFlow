/** Phase E pure logic: per-residue overrides (rules stay the source of truth), step summary and runtime. */
import { describe, it, expect } from 'vitest';
import type { Step } from './methodConfig';
import { normalizeMethodConfig } from './methodConfig';
import { configToToml, tomlToConfig } from './methodToml';
import { residueOverride, setResidueOverride } from './residueOverrides';
import { methodRuntime, runtimeText, stepRuntime, stepSummaryText } from './stepSummary';
import { issueSection, sectionCounts } from './issueSections';
import type { ResolvedParameter, ResolvedStep } from './resolvedRoles';

const base: Step = { id: 's', name: 'STEP1', residueMode: 'include', residues: ['14N', '23N'], parameters: [{ name: 'DW_AB', mode: 'fit' }], roleRules: [] };

describe('per-residue overrides', () => {
  it('creates, updates and removes a single-residue rule; the toggle reads back from the rules', () => {
    const fixed = setResidueOverride(base, 'DW_AB', '23N', { kind: 'fix' });
    expect(fixed.roleRules!.map(r => [r.action, r.entries])).toEqual([['FIX', ['DW_AB, NUC->23N']]]);
    expect(residueOverride(fixed, 'DW_AB', '23N').kind).toBe('fix');
    expect(residueOverride(fixed, 'DW_AB', '14N').kind).toBe('none');

    // Update: replaces the rule rather than stacking another.
    const constrained = setResidueOverride(fixed, 'DW_AB', '23N', { kind: 'constrain', to: '14N' });
    expect(constrained.roleRules!.map(r => [r.action, r.entries])).toEqual([['CONSTRAIN', ['[DW_AB, NUC->23N] = [DW_AB, NUC->14N]']]]);
    expect(residueOverride(constrained, 'DW_AB', '23N')).toMatchObject({ kind: 'constrain', to: '14N' });

    // Removing the rule in the rules list resets the toggle.
    expect(residueOverride({ ...constrained, roleRules: [] }, 'DW_AB', '23N').kind).toBe('none');
    // Clearing via the toggle removes the rule.
    expect(setResidueOverride(constrained, 'DW_AB', '23N', { kind: 'none' }).roleRules).toEqual([]);
  });

  it('leaves other rules alone and keeps multi-entry rules minus the residue', () => {
    const step: Step = {
      ...base,
      roleRules: [
        { id: 'a', action: 'FIX', entries: ['DW_AB, NUC->23N', 'DW_AB, NUC->14N'] },
        { id: 'b', action: 'FIT', entries: ['DW_AB, NUC->23N, B0->800MHZ'] },
      ],
    };
    const next = setResidueOverride(step, 'DW_AB', '23N', { kind: 'fit' });
    expect(next.roleRules!.map(r => [r.id === 'a' || r.id === 'b' ? r.id : 'new', r.action, r.entries])).toEqual([
      ['a', 'FIX', ['DW_AB, NUC->14N']],
      ['b', 'FIT', ['DW_AB, NUC->23N, B0->800MHZ']],
      ['new', 'FIT', ['DW_AB, NUC->23N']],
    ]);
    // Last matching single-residue rule wins.
    expect(residueOverride(step, 'DW_AB', '23N').kind).toBe('fix');
  });

  it('round-trips through method.toml', () => {
    let step = setResidueOverride(base, 'DW_AB', '23N', { kind: 'fix' });
    step = setResidueOverride(step, 'CS_A', '14N', { kind: 'constrain', to: '23N' });
    const toml = configToToml({ steps: [step] });
    expect(toml).toContain('{ FIX = ["DW_AB, NUC->23N"] }');
    expect(toml).toContain('{ CONSTRAIN = ["[CS_A, NUC->14N] = [CS_A, NUC->23N]"] }');
    const back = normalizeMethodConfig(tomlToConfig(toml).config).steps[0];
    expect(residueOverride(back, 'DW_AB', '23N').kind).toBe('fix');
    expect(residueOverride(back, 'CS_A', '14N')).toMatchObject({ kind: 'constrain', to: '23N' });
    expect(configToToml({ steps: [back] })).toBe(toml);
  });

  it('refuses to constrain a residue to itself', () => {
    expect(setResidueOverride(base, 'DW_AB', '23N', { kind: 'constrain', to: '23N' }).roleRules).toEqual([]);
  });
});

const rp = (name: string, role: ResolvedParameter['role'], spin = ''): ResolvedParameter => ({
  id: `__${name}_${spin}`, name, spin, conditions: {}, scope: spin ? 'residue' : 'global', role, expression: '', decided_by: 'rule', rule: null, protected: false,
});
const resolved = (over: Partial<ResolvedStep> = {}): ResolvedStep => ({
  name: 'STEP1', roles_from: null, profiles: 4, error: null, counts: { fit: 0, fix: 0, constrained: 0, derived: 0 },
  parameters: [rp('PB', 'fit'), rp('KEX_AB', 'fit'), ...['14N', '23N'].flatMap(s => [rp('DW_AB', 'fit', s), rp('CS_A', 'fit', s)])],
  data_points: { '14N': 120, '23N': 124 },
  ndata: 244,
  search: { kind: 'grid', axes: [], evaluations: 100 },
  ...over,
});

describe('step summary and runtime', () => {
  const step: Step = {
    ...base,
    search: { mode: 'grid', axes: [{ id: 'a', param: 'PB', fn: 'log', low: 0.01, high: 0.1, count: 10 }, { id: 'b', param: 'KEX_AB', fn: 'log', low: 20, high: 2000, count: 10 }] },
    statistics: { mcmc: { enabled: true, steps: 2000, burn: 'auto' } },
  };
  const timings = [{ name: 'STEP1', seconds: 300, fit_seconds: 240, evaluations: 100, mcmc_seconds: 60, mcmc_steps: 1000 }];

  it('is generated from the config and the resolved roles', () => {
    const rt = stepRuntime(step, 'STEP1', resolved(), timings, 4);
    expect(rt).toEqual({ seconds: 240 + 120, partial: false, fromTest: false });
    expect(stepSummaryText(step, resolved(), rt)).toBe(
      'Fits PB, KEX_AB globally + 4 residue coords on 14N, 23N · profiles a 10×10 grid · MCMC 2000 steps · ≈ 6 min · 244 points / 6 coords'
    );
    expect(stepSummaryText(step, undefined, null)).toBe('Resolving roles with ChemEx…');
  });

  it('falls back to a one-residue test run, scaled to the step residues, and marks partial estimates', () => {
    const test = { residue: '14N', steps: [{ name: 'STEP1', seconds: 9, evaluations: 9 }] };
    const rt = stepRuntime({ ...step, statistics: undefined }, 'STEP1', resolved(), [], null, test);
    expect(rt).toEqual({ seconds: 100 * 1 * 2, partial: false, fromTest: true });
    expect(runtimeText(rt)).toBe('≈ 3 min (from test run)');
    const de: Step = { ...step, statistics: undefined, search: { mode: 'de', seed: '1', axes: [{ id: 'a', param: 'PB', fn: 'log', low: 0.01, high: 0.1, count: 0 }] } };
    expect(stepRuntime(de, 'STEP1', resolved(), timings, 4)).toEqual({ seconds: null, partial: true, fromTest: false });
    const total = methodRuntime([{ step, name: 'STEP1', resolved: resolved() }, { step: de, name: 'STEP1', resolved: resolved() }], timings, 4);
    expect(runtimeText(total)).toBe('≈ 6 min+');
  });
});

describe('mini-nav sections', () => {
  it('assigns issues to the section they concern', () => {
    expect(issueSection({ code: 'grid-edge', message: 'x' })).toBe('search');
    expect(issueSection({ code: 'stats-cost-mc', message: 'x' })).toBe('statistics');
    expect(issueSection({ code: 'data-ratio', message: 'x' })).toBe('residues');
    expect(issueSection({ message: 'INCLUDE selects no profiles' })).toBe('residues');
    expect(issueSection({ code: 'no-fit-action', message: 'x' })).toBe('parameters');
    expect(issueSection({ message: 'Step name is empty' })).toBe('summary');
    expect(sectionCounts([{ code: 'grid-edge', message: '', severity: 'warning' }, { code: 'grid-cost', message: '', severity: 'warning' }]).search).toBe(2);
  });
});
