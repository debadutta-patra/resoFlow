/** Phase C: scientific soft hints — severity, trigger / non-trigger, quick-fixes, project toggles. */
import { describe, it, expect } from 'vitest';
import type { MethodConfig, Step } from './methodConfig';
import { configToToml } from './methodToml';
import type { ResolveReport, ResolvedParameter, ResolvedStep } from './resolvedRoles';
import type { OverviewStep, RunOverview } from './runOverview';
import { dataParamRatio, kexWindowNote, scienceIssues } from './scienceChecks';
import { deEdgeIssues, gridEdgeIssues } from './runChecks';

const rp = (name: string, role: ResolvedParameter['role'], spin = ''): ResolvedParameter => ({
  id: `__${name}_${spin}`,
  name,
  spin,
  conditions: {},
  scope: spin ? 'residue' : 'global',
  role,
  expression: '',
  decided_by: 'rule',
  rule: null,
  protected: false,
});

const step: Step = { id: 's1', name: 'STEP1', residueMode: 'all', residues: [], parameters: [] };
const config: MethodConfig = { steps: [step] };

const resolved = (over: Partial<ResolvedStep>): ResolveReport => ({
  valid: true,
  format: 'v2',
  errors: [],
  steps: [{ name: 'STEP1', roles_from: null, profiles: 2, parameters: [], counts: { fit: 0, fix: 0, constrained: 0, derived: 0 }, error: null, ...over }],
});

const codes = (issues: ReturnType<typeof scienceIssues>) => issues.map(i => [i.code, i.severity]);

describe('C1 data / parameter ratio', () => {
  const params = [rp('PB', 'fit'), rp('KEX_AB', 'fit'), ...['DW_AB', 'CS_A', 'R2_A', 'R1_A', 'R2_B'].flatMap(n => [rp(n, 'fit', '13N'), rp(n, 'fit', '26N')])];
  const report = resolved({ parameters: params, data_points: { '13N': 124, '26N': 40 }, ndata: 164 });

  it('reports points / coords for the step summary', () => {
    expect(dataParamRatio(report.steps[0])).toMatchObject({ ndata: 164, coords: 12, globalCoords: 2 });
    expect(dataParamRatio({ ...report.steps[0], data_points: undefined })).toBeNull();
  });

  it('warns for residues below the threshold (default 10) and names them', () => {
    const issues = scienceIssues({ config, report, family: 'cest' }).filter(i => i.code === 'data-ratio');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toBe('1 residue has fewer than 10 data points per residue-local fitted coordinate.');
    expect(issues[0].detail).toMatch(/^Points \/ local coords: 26N 40\/5\./);
  });

  it('uses the project threshold, and can be switched off', () => {
    expect(scienceIssues({ config, report, family: 'cest', settings: { 'data-ratio': { enabled: true, threshold: 5 } } }).some(i => i.code === 'data-ratio')).toBe(false);
    expect(scienceIssues({ config, report, family: 'cest', settings: { 'data-ratio': { enabled: false } } }).some(i => i.code === 'data-ratio')).toBe(false);
  });
});

describe('C2 one B1 field', () => {
  const exp = (b1: number) => ({ name: 'cest_15n', file: `${b1}.toml`, b1_frq: b1, profiles: 2 });
  const report = (b1s: number[], params = [rp('PB', 'fit'), rp('KEX_AB', 'fit')]) => resolved({ parameters: params, experiments: b1s.map(exp) });

  it('is info when PB/KEX_AB are global FIT on CEST data with a single B1 field', () => {
    const [issue] = scienceIssues({ config, report: report([13, 13]), family: 'cest' }).filter(i => i.code === 'b1-fields');
    expect(issue.severity).toBe('info');
    expect(issue.message).toBe('PB and KEX_AB fitted globally from one B1 field (13 Hz).');
  });

  it('does not trigger with two fields, without global exchange FIT, or outside CEST', () => {
    expect(codes(scienceIssues({ config, report: report([13, 26]), family: 'cest' }))).not.toContainEqual(['b1-fields', 'info']);
    expect(codes(scienceIssues({ config, report: report([13], [rp('PB', 'fix'), rp('DW_AB', 'fit', '13N')]), family: 'cest' }))).toEqual([]);
    expect(codes(scienceIssues({ config, report: report([13]), family: 'cpmg' }))).toEqual([]);
  });
});

describe('C3 R2_B per residue', () => {
  const report = resolved({ parameters: [rp('R2_B', 'fit', '13N'), rp('R2_B', 'fit', '26N')] });

  it('is info with two quick-fixes; both produce valid rules and TOML', () => {
    const [issue] = scienceIssues({ config, report, family: 'cest' }).filter(i => i.code === 'r2b-per-residue');
    expect(issue.severity).toBe('info');
    expect(issue.actions!.map(a => a.label)).toEqual(['Constrain [R2_B] = [R2_A]', 'One global R2_B', 'Dismiss for this step']);
    const tied = issue.actions![0].apply(config);
    expect(tied.steps[0].roleRules!.map(r => [r.action, r.entries])).toEqual([['CONSTRAIN', ['[R2_B] = [R2_A]']]]);
    expect(configToToml(tied)).toContain('{ CONSTRAIN = ["[R2_B] = [R2_A]"] }');
    const global = issue.actions![1].apply(config);
    expect(global.steps[0].roleRules!.map(r => [r.action, r.entries])).toEqual([
      ['FIT', ['R2_B, NUC->13N']],
      ['CONSTRAIN', ['[R2_B, NUC->26N] = [R2_B, NUC->13N]']],
    ]);
    expect(configToToml(global)).toMatch(/\{ FIT = \["R2_B, NUC->13N"\] \},\n\s+\{ CONSTRAIN = \["\[R2_B, NUC->26N\] = \[R2_B, NUC->13N\]"\] \}/);
  });

  it('offers only the R2_A tie when residues have several R2_B copies (several fields)', () => {
    const multi = resolved({ parameters: [rp('R2_B', 'fit', '13N'), rp('R2_B', 'fit', '13N'), rp('R2_B', 'fit', '26N'), rp('R2_B', 'fit', '26N')] });
    const [issue] = scienceIssues({ config, report: multi, family: 'cest' }).filter(i => i.code === 'r2b-per-residue');
    expect(issue.actions!.map(a => a.label)).toEqual(['Constrain [R2_B] = [R2_A]', 'Dismiss for this step']);
  });

  it('does not trigger for one residue, constrained R2_B, or CPMG', () => {
    expect(scienceIssues({ config, report: resolved({ parameters: [rp('R2_B', 'fit', '13N')] }), family: 'cest' })).toEqual([]);
    expect(scienceIssues({ config, report: resolved({ parameters: [rp('R2_B', 'constrained', '13N'), rp('R2_B', 'constrained', '26N')] }), family: 'cest' })).toEqual([]);
    expect(scienceIssues({ config, report, family: 'cpmg' })).toEqual([]);
  });
});

const ov = (s: Partial<OverviewStep>): RunOverview => ({
  schema: 1,
  state: 'complete',
  method_toml: null,
  step_order: ['STEP1'],
  steps: [{ name: 'STEP1', status: 'complete', redchi: 1, chisqr: 1, ndata: 1, nvarys: 1, values: {}, residue_redchi: {}, grid: null, mcmc: null, correlations: [], ...s }],
});

describe('C4 KEX_AB search range vs CEST sensitivity', () => {
  it('only notes narrow ranges inside the CEST window, on CEST, for KEX_AB', () => {
    expect(kexWindowNote('KEX_AB', 100, 200, 'cest')).toMatch(/covers only part of the window CEST is sensitive to/);
    expect(kexWindowNote('KEX_AB', 20, 2000, 'cest')).toBeNull();
    expect(kexWindowNote('KEX_AB', 100, 200, 'cpmg')).toBeNull();
    expect(kexWindowNote('PB', 0.01, 0.02, 'cest')).toBeNull();
    expect(kexWindowNote('KEX_AB', 100, 200, 'cest', { 'kex-cest-window': { enabled: false } })).toBeNull();
  });

  it('is combined with the grid-edge warning, never raised on a narrow range alone', () => {
    const narrow: MethodConfig = { steps: [{ ...step, search: { mode: 'grid', axes: [{ id: 'k', param: 'KEX_AB', fn: 'log', low: 100, high: 200, count: 3 }] } }] };
    const edge = ov({ grid: { chisqr: 1, best: {}, pairs: [], profiles_1d: {}, axes: [{ param: 'KEX_AB', fn: 'log', qualifier: '', values: [100, 141, 200], low: 100, high: 200, count: 3, best: 200, edge: 'high' }] } });
    const [issue] = gridEdgeIssues(narrow, edge, { family: 'cest' });
    expect(issue.detail).toMatch(/CEST is sensitive to \(≈20–2000 s⁻¹\)/);
    const interior = ov({ grid: { chisqr: 1, best: {}, pairs: [], profiles_1d: {}, axes: [{ param: 'KEX_AB', fn: 'log', qualifier: '', values: [100, 141, 200], low: 100, high: 200, count: 3, best: 141, edge: null }] } });
    expect(gridEdgeIssues(narrow, interior, { family: 'cest' })).toEqual([]);
  });

  it('DE: warns when the committed value sits at a DE bound, with an extend fix', () => {
    const de: MethodConfig = { steps: [{ ...step, search: { mode: 'de', seed: '1', axes: [{ id: 'k', param: 'KEX_AB', fn: 'log', low: 100, high: 200, count: 0 }] } }] };
    const atBound = ov({ values: { KEX_AB: { scope: 'global', roles: ['fit'], copies: [{ residue: '', qualifier: '', role: 'fit', value: 199.5, stderr: 1 }] } } });
    const [issue] = deEdgeIssues(de, atBound, { family: 'cest' });
    expect([issue.code, issue.severity]).toEqual(['de-edge', 'warning']);
    expect(issue.detail).toMatch(/CEST is sensitive/);
    expect(issue.actions![0].apply(de).steps[0].search!.axes[0]).toMatchObject({ low: 100, high: 2000 });
    const inside = ov({ values: { KEX_AB: { scope: 'global', roles: ['fit'], copies: [{ residue: '', qualifier: '', role: 'fit', value: 150, stderr: 1 }] } } });
    expect(deEdgeIssues(de, inside, { family: 'cest' })).toEqual([]);
  });
});

describe('C5 strong correlations', () => {
  const run = ov({
    correlations: [
      { a: '__KEX_AB', b: '__PB', rho: -0.95, method: 'Covariance' },
      { a: '[PB]', b: '[KEX_AB]', rho: -0.93, method: 'MCMC' },
      { a: '__DW_AB_13N', b: '__PB', rho: 0.6, method: 'Covariance' },
    ],
  });
  it('is info for |ρ| > 0.9 only, once per pair and method', () => {
    const issues = scienceIssues({ config, report: null, overview: run, family: 'cest' });
    expect(issues.map(i => [i.code, i.severity, i.message])).toEqual([
      ['strong-correlation', 'info', 'KEX_AB and PB were strongly correlated in the last run (ρ = -0.95, Covariance).'],
      ['strong-correlation', 'info', 'PB and KEX_AB were strongly correlated in the last run (ρ = -0.93, MCMC).'],
    ]);
    expect(scienceIssues({ config, report: null, overview: run, family: 'cest', settings: { 'strong-correlation': { enabled: false } } })).toEqual([]);
  });
});

describe('severity contract', () => {
  it('never produces errors', () => {
    const report = resolved({
      parameters: [rp('PB', 'fit'), rp('R2_B', 'fit', '13N'), rp('R2_B', 'fit', '26N'), rp('DW_AB', 'fit', '13N')],
      data_points: { '13N': 2, '26N': 2 },
      experiments: [{ name: 'x', file: 'x', b1_frq: 10, profiles: 2 }],
    });
    const issues = scienceIssues({ config, report, overview: ov({ correlations: [{ a: 'a', b: 'b', rho: 0.99, method: 'MCMC' }] }), family: 'cest' });
    expect(issues.length).toBeGreaterThan(3);
    expect(issues.every(i => i.severity !== 'error')).toBe(true);
  });
});
