/** Phase B: run overview views, starting-value actions (parameter-file diff) and grid-edge checks. */
import { describe, it, expect } from 'vitest';
import type { MethodConfig, SearchAxis, Step } from './methodConfig';
import { configToToml } from './methodToml';
import { configToToml as paramsToToml } from './parameterToml';
import type { ParameterConfig } from './parameterConfig';
import {
  committedSummary,
  isPreviousMethod,
  parameterNameOfId,
  stepResultBadge,
  strongCorrelationsByName,
  type OverviewStep,
  type RunOverview,
} from './runOverview';
import { previewStartingValues, startingValueActions, startingValueEntries } from './startingValues';
import { extendAxis, gridEdgeIssues } from './runChecks';

const step = (over: Partial<OverviewStep>): OverviewStep => ({
  name: 'STEP1',
  status: 'complete',
  redchi: 1.2,
  chisqr: 100,
  ndata: 200,
  nvarys: 8,
  values: {},
  residue_redchi: {},
  grid: null,
  mcmc: null,
  correlations: [],
  ...over,
});

const gridStep = step({
  name: 'STEP1',
  values: {
    PB: { scope: 'global', roles: ['fit'], copies: [{ residue: '', qualifier: '', role: 'fit', value: 0.01, stderr: null }] },
    KEX_AB: { scope: 'global', roles: ['fit'], copies: [{ residue: '', qualifier: '', role: 'fit', value: 200, stderr: null }] },
  },
  grid: {
    chisqr: 639.3,
    axes: [
      { param: 'PB', fn: 'log', qualifier: '', values: [0.01, 0.0316, 0.1], low: 0.01, high: 0.1, count: 3, best: 0.01, edge: 'low' },
      { param: 'KEX_AB', fn: 'log', qualifier: '', values: [20, 63.2, 200], low: 20, high: 200, count: 3, best: 200, edge: 'high' },
    ],
    best: { PB: 0.01, KEX_AB: 200 },
    pairs: [['PB', 'KEX_AB']],
    profiles_1d: {},
  },
});

const refineStep = step({
  name: 'STEP2',
  redchi: 0.9077,
  values: {
    PB: { scope: 'global', roles: ['fit'], copies: [{ residue: '', qualifier: '', role: 'fit', value: 0.0161252, stderr: 0.000568 }] },
    DW_AB: {
      scope: 'residue',
      roles: ['fit'],
      copies: [
        { residue: '26N', qualifier: '', role: 'fit', value: 2.5, stderr: 0.1 },
        { residue: '13N', qualifier: '', role: 'fit', value: -1.25, stderr: 0.2 },
        { residue: '28N', qualifier: '', role: 'fit', value: 4.0, stderr: null },
      ],
    },
    CS_A: { scope: 'residue', roles: ['fix'], copies: [{ residue: '13N', qualifier: '', role: 'fix', value: 108.2, stderr: null }] },
    R2_A: {
      scope: 'residue',
      roles: ['fit'],
      copies: [
        { residue: '13N', qualifier: 'B0->499.2MHZ', role: 'fit', value: 10.5, stderr: 0.3 },
        { residue: '13N', qualifier: 'B0->799.8MHZ', role: 'fit', value: 14.0, stderr: 0.3 },
      ],
    },
  },
  mcmc: {
    tau_max: 5.2, tau_tentative: true, tentative_burn: true, ess_min: null, ess_withheld: true, posterior_withheld: false, warnings: [], seconds: 4,
  },
  correlations: [
    { a: '__KEX_AB', b: '__PB', rho: -0.95, method: 'Covariance' },
    { a: '__DW_AB_13N', b: '__R2_A_13N_499_2MHZ', rho: 0.6, method: 'Covariance' },
  ],
});

const overview: RunOverview = {
  schema: 1,
  state: 'complete',
  method_toml: 'FORMAT_VERSION = 2\n\n[STEP1]\nINCLUDE = ["13N"]\n',
  step_order: ['STEP1', 'STEP2'],
  steps: [gridStep, refineStep],
};

describe('run overview views', () => {
  it('summarises global values as value ± error and residue values as median (range)', () => {
    expect(committedSummary(refineStep, 'PB')?.text).toBe('0.0161 ± 0.000568');
    const dw = committedSummary(refineStep, 'dw_ab')!;
    expect(dw.text).toBe('median 2.5 (-1.25–4) · 3 res');
    expect(dw.perResidue.map(c => c.residue)).toEqual(['13N', '26N', '28N']);
    expect(committedSummary(refineStep, 'KEX_AB')).toBeNull();
  });

  it('flags results from a previous method, ignoring comments and blank lines', () => {
    expect(isPreviousMethod(overview, '# note\nFORMAT_VERSION = 2\n[STEP1]\nINCLUDE = ["13N"]   \n')).toBe(false);
    expect(isPreviousMethod(overview, 'FORMAT_VERSION = 2\n[STEP1]\nINCLUDE = ["14N"]\n')).toBe(true);
    expect(isPreviousMethod(null, 'x')).toBe(false);
  });

  it('builds step-tab results: dot state, red-χ², MCMC τ / withheld ESS / tentative burn', () => {
    expect(stepResultBadge(overview, 'STEP2')).toEqual({
      state: 'ok',
      redchi: 0.9077,
      mcmc: { tauMax: 5.2, essMin: null, tentative: true, withheld: false, essWithheld: true },
    });
    expect(stepResultBadge(overview, 'STEP9').state).toBe('not-run');
    expect(stepResultBadge({ ...overview, steps: [step({ name: 'X', status: 'missing' })] }, 'x').state).toBe('failed');
  });

  it('maps ChemEx ids to names and keeps only |ρ| above the threshold', () => {
    expect(parameterNameOfId('__R1_A_13N_499_2MHZ')).toBe('R1_A');
    expect(parameterNameOfId('[DW_AB, NUC->13N]')).toBe('DW_AB');
    const strong = strongCorrelationsByName(refineStep);
    expect(Object.keys(strong).sort()).toEqual(['KEX_AB', 'PB']);
    expect(strong.PB[0]).toMatchObject({ other: 'KEX_AB', rho: -0.95 });
  });
});

describe('Starting values ▾', () => {
  const base: ParameterConfig = {
    globals: { pb: { value: 0.05, source: { kind: 'default' } } },
    residues: { G13N: { cs_a: { value: 108.2, source: { kind: 'default' } }, cs_b: { value: 110, source: { kind: 'default' } } } },
  };

  it('names every action by its effect on the next parameters file', () => {
    expect(startingValueActions(overview).map(a => a.label)).toEqual([
      'Write STEP1 grid minimum → parameters',
      'Write STEP1 fitted values → parameters',
      'Write STEP2 fitted values → parameters',
    ]);
    expect(startingValueActions(null)).toEqual([]);
  });

  it('grid minimum: writes only the grid axes, at full precision', () => {
    const action = startingValueActions(overview).find(a => a.id === 'grid:STEP1')!;
    const preview = previewStartingValues(base, startingValueEntries(overview, action), 'last run · STEP1 grid minimum', 'T');
    expect(preview.changes.map(c => [c.label, c.oldValue, c.newValue])).toEqual([
      ['PB', 0.05, 0.01],
      ['KEX_AB', null, 200],
    ]);
    expect(preview.next.globals.kex_ab).toEqual({
      value: 200,
      source: { kind: 'inherited', sourceRunId: 'last run · STEP1 grid minimum', sourceRunLabel: 'last run · STEP1 grid minimum', at: 'T' },
    });
  });

  it('fitted values: every FIT coordinate, matched to existing residue keys, fixed values untouched, per-field kept apart', () => {
    const action = startingValueActions(overview).find(a => a.id === 'fitted:STEP2')!;
    const preview = previewStartingValues(base, startingValueEntries(overview, action), 'last run · STEP2', 'T');
    const byLabel = Object.fromEntries(preview.changes.map(c => [c.label, [c.oldValue, c.newValue]]));
    expect(byLabel['PB']).toEqual([0.05, 0.0161252]);
    // 13N matched to the existing "G13N" key via SpinSystemKey; DW_AB replaces a stale CS_B.
    expect(byLabel['DW_AB · G13N']).toEqual([null, -1.25]);
    expect(preview.next.residues.G13N.cs_b).toBeUndefined();
    expect(preview.next.residues.G13N.cs_a?.value).toBe(108.2);
    // Two B0 fields → field-qualified sections.
    expect(byLabel['R2_A (B0->499.2MHZ) · G13N']).toEqual([null, 10.5]);
    expect(Object.keys(byLabel)).not.toContain('CS_A · G13N');
    // The parameters.toml diff carries the new values unrounded.
    const toml = paramsToToml(preview.next);
    expect(toml).toMatch(/PB = 0\.0161252/);
    expect(toml).toMatch(/\[R2_A, B0->499\.2MHZ\]\nG13N = 10\.5/);
    expect(toml).toMatch(/\[DW_AB\][\s\S]*G13N = -1\.25/);
  });

  it('reports values already in the file as unchanged', () => {
    const action = startingValueActions(overview).find(a => a.id === 'grid:STEP1')!;
    const once = previewStartingValues(base, startingValueEntries(overview, action), 'x');
    const twice = previewStartingValues(once.next, startingValueEntries(overview, action), 'x');
    expect(twice.changes).toEqual([]);
    expect(twice.unchanged).toBe(2);
  });
});

describe('grid-edge warning', () => {
  const axis = (over: Partial<SearchAxis>): SearchAxis => ({ id: 'a1', param: 'PB', fn: 'log', low: 0.01, high: 0.1, count: 3, ...over });
  const cfg = (axes: SearchAxis[]): MethodConfig => ({
    steps: [{ id: 's1', name: 'STEP1', residueMode: 'all', residues: [], parameters: [{ name: 'PB', mode: 'fit' }, { name: 'KEX_AB', mode: 'fit' }], search: { mode: 'grid', axes } } as Step],
  });

  it('extends a log axis by one decade keeping points per decade, a linear axis to 2× width with the same spacing', () => {
    expect(extendAxis(axis({}), 'low')).toMatchObject({ low: 0.001, high: 0.1, count: 5 });
    expect(extendAxis(axis({ param: 'KEX_AB', low: 20, high: 200, count: 10 }), 'high')).toMatchObject({ low: 20, high: 2000, count: 19 });
    expect(extendAxis(axis({ fn: 'lin', low: 0.01, high: 0.03, count: 5 }), 'high')).toMatchObject({ low: 0.01, high: 0.05, count: 9 });
    // Physical bounds: populations stay ≤ 1 and ≥ 0.
    expect(extendAxis(axis({ fn: 'lin', low: 0.5, high: 1, count: 3 }), 'high')).toBeNull();
    expect(extendAxis(axis({ fn: 'lin', low: 0.02, high: 0.06, count: 3 }), 'low')).toMatchObject({ low: 0, high: 0.06 });
    expect(extendAxis(axis({ fn: 'values', values: [1, 2] }), 'high')).toBeNull();
  });

  it('warns on each axis whose committed minimum is on an edge, with a working extend quick-fix', () => {
    const config = cfg([axis({}), axis({ id: 'a2', param: 'KEX_AB', low: 20, high: 200, count: 3 })]);
    const issues = gridEdgeIssues(config, overview);
    expect(issues.map(i => [i.severity, i.paramName, i.message])).toEqual([
      ['warning', 'PB', "PB: last run's grid minimum is at the lower edge (0.01); consider extending to 0.001."],
      ['warning', 'KEX_AB', "KEX_AB: last run's grid minimum is at the upper edge (200); consider extending to 2000."],
    ]);
    const fixed = issues[1].actions![0].apply(config);
    expect(fixed.steps[0].search!.axes[1]).toMatchObject({ low: 20, high: 2000, count: 5 });
    expect(configToToml(fixed)).toContain('"[KEX_AB] = log(20, 2000, 5)"');
    // After extending, the warning for that axis goes away.
    expect(gridEdgeIssues(fixed, overview).map(i => i.paramName)).toEqual(['PB']);
  });

  it('does not warn for interior minima, other steps, or without a run', () => {
    const interior: RunOverview = {
      ...overview,
      steps: [{ ...gridStep, grid: { ...gridStep.grid!, axes: gridStep.grid!.axes.map(a => ({ ...a, edge: null })) } }],
    };
    expect(gridEdgeIssues(cfg([axis({})]), interior)).toEqual([]);
    expect(gridEdgeIssues(cfg([axis({})]), null)).toEqual([]);
    const renamed = cfg([axis({})]);
    renamed.steps[0].name = 'OTHER';
    expect(gridEdgeIssues(renamed, overview)).toEqual([]);
  });
});
