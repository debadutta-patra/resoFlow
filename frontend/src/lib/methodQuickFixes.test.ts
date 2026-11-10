/** Phase A: severity levels, the no-FIT note, quick-fixes and per-step dismissal. */
import { describe, it, expect } from 'vitest';
import type { MethodConfig, Step } from './methodConfig';
import { normalizeMethodConfig } from './methodConfig';
import { configToToml, tomlToConfig } from './methodToml';
import { highestSeverity, severityCounts, validateMethodConfig, type ValidationError } from './methodValidation';
import { dismissIssue, issueKey, partitionDismissed, restoreIssue } from './methodQuickFixes';

const step = (id: string, name: string, extra: Partial<Step> = {}): Step => ({ id, name, residueMode: 'all', residues: [], parameters: [], ...extra });
const fitStep = (id: string, name: string, extra: Partial<Step> = {}) => step(id, name, { parameters: [{ name: 'PB', mode: 'fit' }], ...extra });
const gridStep = (id: string, name: string) =>
  fitStep(id, name, { search: { mode: 'grid', axes: [{ id: 'ax', param: 'PB', fn: 'lin', low: 0.01, high: 0.1, count: 3 }] } });
const cfg = (...steps: Step[]): MethodConfig => ({ steps });
const noFit = (issues: ValidationError[]) => issues.filter(i => i.code === 'no-fit-action');

describe('severity helpers', () => {
  it('ranks error > warning > info and counts each level', () => {
    const issues = [{ severity: 'info' }, { severity: 'warning' }, { severity: 'info' }] as ValidationError[];
    expect(highestSeverity(issues)).toBe('warning');
    expect(highestSeverity([])).toBeNull();
    expect(severityCounts(issues)).toEqual({ error: 0, warning: 1, info: 2 });
  });
});

describe('"has no FIT action" note', () => {
  it('is info, names the baseline FIT parameters and offers the two quick-fixes', () => {
    const issues = noFit(validateMethodConfig(cfg(fitStep('a', 'STEP1'), step('b', 'STEP2')), undefined, 0, null, { baselineFitNames: ['PB', 'KEX_AB'] }));
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('info');
    expect(issues[0].stepId).toBe('b');
    expect(issues[0].detail).toBe('Baseline FIT: PB, KEX_AB.');
    expect(issues[0].actions?.map(a => a.label)).toEqual(['Inherit roles from STEP1', 'Mark as intentional']);
  });

  it('does not trigger when the step fits, inherits roles, or samples right after a GRID step', () => {
    expect(noFit(validateMethodConfig(cfg(fitStep('a', 'STEP1'))))).toEqual([]);
    expect(noFit(validateMethodConfig(cfg(fitStep('a', 'STEP1'), step('b', 'STEP2', { rolesFromStepId: 'a', rolesFrom: 'STEP1' }))))).toEqual([]);
    const sample = step('b', 'SAMPLE', { statistics: { mcmc: { enabled: true, steps: 1000, burn: 'auto' } } });
    expect(noFit(validateMethodConfig(cfg(gridStep('a', 'GRID'), sample)))).toEqual([]);
  });

  it('still triggers after a GRID step without statistics, and after a non-GRID step with statistics', () => {
    expect(noFit(validateMethodConfig(cfg(gridStep('a', 'GRID'), step('b', 'NEXT'))))).toHaveLength(1);
    const sample = step('b', 'SAMPLE', { statistics: { mc: { enabled: true, replicates: 10 } } });
    expect(noFit(validateMethodConfig(cfg(fitStep('a', 'STEP1'), sample)))).toHaveLength(1);
  });

  it('first step: no inherit fix (nothing earlier), only "Mark as intentional"', () => {
    const [issue] = noFit(validateMethodConfig(cfg(step('a', 'STEP1'))));
    expect(issue.actions?.map(a => a.label)).toEqual(['Mark as intentional']);
  });

  it('"Inherit roles from" sets ROLES_FROM by id and the TOML gains ROLES_FROM', () => {
    const config = cfg(fitStep('a', 'STEP1'), step('b', 'STEP2'));
    const [issue] = noFit(validateMethodConfig(config));
    const next = normalizeMethodConfig(issue.actions![0].apply(config));
    expect(next.steps[1].rolesFromStepId).toBe('a');
    const toml = configToToml(next);
    expect(toml).toMatch(/\[STEP2\]\nROLES_FROM = "STEP1"/);
    expect(noFit(validateMethodConfig(next))).toEqual([]);
    // The TOML round-trips to the same ROLES_FROM.
    expect(normalizeMethodConfig(tomlToConfig(toml).config).steps[1].rolesFrom).toBe('STEP1');
  });

  it('"Mark as intentional" dismisses for that step only, is saved in the config and leaves the TOML unchanged', () => {
    const config = cfg(fitStep('a', 'STEP1'), step('b', 'STEP2'), step('c', 'STEP3'));
    const issues = validateMethodConfig(config);
    const forB = noFit(issues).find(i => i.stepId === 'b')!;
    const next = forB.actions!.find(a => a.label === 'Mark as intentional')!.apply(config);
    expect(next.steps[1].dismissedIssues).toEqual(['no-fit-action']);
    expect(configToToml(next)).toBe(configToToml(config));
    const { active, dismissed } = partitionDismissed(validateMethodConfig(next), next);
    expect(noFit(active).map(i => i.stepId)).toEqual(['c']);
    expect(dismissed.map(d => [d.stepId, d.dismissKey])).toEqual([['b', 'no-fit-action']]);
    // Survives a save/restore (JSON) and can be restored.
    const restored = JSON.parse(JSON.stringify(next)) as MethodConfig;
    expect(partitionDismissed(validateMethodConfig(restored), restored).dismissed).toHaveLength(1);
    const back = restoreIssue(restored, 'b', 'no-fit-action');
    expect(back.steps[1].dismissedIssues).toBeUndefined();
  });
});

describe('dismissal', () => {
  it('never hides errors', () => {
    const config = cfg(step('a', 'STEP1', { residueMode: 'include', residues: [] }));
    const errors = validateMethodConfig(config).filter(e => e.severity === 'error');
    expect(errors.length).toBeGreaterThan(0);
    const fake = { ...errors[0], code: 'x' };
    const dismissedCfg = dismissIssue(config, 'a', 'x');
    expect(partitionDismissed([fake], dismissedCfg).active).toHaveLength(1);
  });

  it('keys parameter-specific issues by parameter', () => {
    expect(issueKey({ code: 'unknown-param', paramName: 'foo' })).toBe('unknown-param:FOO');
    expect(issueKey({})).toBeNull();
  });

  it('warnings carry a dismiss action; errors do not', () => {
    const issues = validateMethodConfig(cfg(gridStep('a', 'GRID')));
    const last = issues.find(i => i.code === 'grid-last-step')!;
    expect(last.severity).toBe('warning');
    expect(last.actions?.some(a => a.id === 'dismiss:grid-last-step')).toBe(true);
    for (const e of issues.filter(i => i.severity === 'error')) expect(e.actions ?? []).toEqual([]);
  });

  it('dismissedIssues is never parsed from TOML (resoFlow-only metadata)', () => {
    const toml = configToToml(dismissIssue(cfg(step('a', 'STEP1')), 'a', 'no-fit-action'));
    expect(toml).not.toMatch(/dismiss/i);
    expect(tomlToConfig(toml).config.steps[0].dismissedIssues).toBeUndefined();
  });
});
