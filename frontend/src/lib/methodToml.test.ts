import { describe, it, expect } from 'vitest';
import { configToToml, parseTomlDocument, tomlToConfig } from './methodToml';
import type { MethodConfig, Step } from './methodConfig';
import { materializeLegacySearchFits, normalizeMethodConfig } from './methodConfig';
import { validateMethodConfig } from './methodValidation';
import { METHOD_TEMPLATES } from './methodTemplates';
import { axisPoints, createSearchAxis, defaultRange } from './searchDefaults';

const step = (over: Partial<Step>): Step => ({
  id: 's',
  name: 'STEP1',
  parameters: [],
  residueMode: 'include',
  residues: [],
  ...over,
});

describe('ChemEx v2 method.toml emitter', () => {
  it('emits FORMAT_VERSION = 2 and ordered ROLES (CONSTRAIN → FIX → FIT)', () => {
    const toml = configToToml({
      steps: [
        step({
          parameters: [
            { name: 'PB', mode: 'fit' },
            { name: 'KEX_AB', mode: 'fit' },
            { name: 'R2_A', mode: 'fix' },
            { name: 'R2_B', mode: 'constrain', expression: '[R2_A]' },
            { name: 'R1_A', mode: 'default' },
          ],
        }),
      ],
    });
    expect(toml).toBe(
      [
        'FORMAT_VERSION = 2',
        '',
        '[STEP1]',
        'ROLES = [',
        '  { CONSTRAIN = ["[R2_B] = [R2_A]"] },',
        '  { FIX = ["R2_A"] },',
        '  { FIT = ["PB", "KEX_AB"] },',
        ']',
        '',
      ].join('\n')
    );
    expect(toml).not.toContain('R1_A');
  });

  it('never emits v1-only constructs (bounds, GRID key, THIN/WALKERS, BURN="AUTO")', () => {
    const toml = configToToml(
      normalizeMethodConfig({
        steps: [
          step({
            parameters: [
              { name: 'PB', mode: 'fit', bounds: '< 0.5' },
              { name: 'KEX_AB', mode: 'grid', grid: { min: 100, max: 1000, steps: 5, scale: 'log' } },
            ],
            statistics: { mcmc: { enabled: true, steps: 5000, burn: 'auto', thin: 10, walkers: 64, workers: 2 } },
          }),
        ],
      })
    );
    expect(toml).not.toMatch(/CONSTRAINTS|< 0\.5|^GRID =|THIN|WALKERS|WORKERS|BURN|FITMETHOD/m);
    expect(toml).toContain('[STEP1.SEARCH.GRID]');
    expect(toml).toContain('"[KEX_AB] = log(100, 1000, 5)"');
    expect(toml).toContain('{ FIT = ["PB", "KEX_AB"] }');
    expect(toml).toContain('[STEP1.STATISTICS.MCMC]\nSTEPS = 5000\n');
  });

  it('never adds search targets to FIT implicitly (GRID/DE do not change roles)', () => {
    const cfg: MethodConfig = {
      steps: [
        step({
          parameters: [{ name: 'DW_AB', mode: 'fit' }],
          search: {
            mode: 'grid',
            axes: [
              { id: 'a', param: 'PB', fn: 'values', low: 0.01, high: 0.1, count: 3, values: [0.01, 0.05, 0.1] },
              { id: 'b', param: 'KEX_AB', fn: 'log', low: 20, high: 2000, count: 12 },
              { id: 'c', param: 'R2_A', qualifier: 'NUC->G24N-H', fn: 'lin', low: 1, high: 30, count: 5 },
            ],
          },
        }),
      ],
    };
    const toml = configToToml(cfg);
    expect(toml).toContain('ROLES = [\n  { FIT = ["DW_AB"] },\n]');
    expect(toml).toContain('"[PB] = values(0.01, 0.05, 0.1)"');
    expect(toml).toContain('"[R2_A, NUC->G24N-H] = lin(1, 30, 5)"');

    // Configs saved under the old behaviour are migrated to the same roles, explicitly.
    const migrated = materializeLegacySearchFits(cfg);
    expect(configToToml(migrated)).toContain(
      'ROLES = [\n  { FIT = ["DW_AB", "PB", "KEX_AB"] },\n  { FIT = ["R2_A, NUC->G24N-H"] },\n]'
    );
    expect(materializeLegacySearchFits(migrated)).toBe(migrated); // idempotent
    // Targets already decided by the table or a FIT rule are left alone.
    const decided = materializeLegacySearchFits({
      steps: [step({ parameters: [{ name: 'PB', mode: 'fix' }], roleRules: [{ id: 'r', action: 'FIT', entries: ['R2_A, NUC->G24N-H'] }], search: cfg.steps[0].search })],
    });
    expect(configToToml(decided)).toContain('ROLES = [\n  { FIX = ["PB"] },\n  { FIT = ["KEX_AB"] },\n  { FIT = ["R2_A, NUC->G24N-H"] },\n]');
  });

  it('emits SEARCH.DE with SEED and two-argument coordinates', () => {
    const toml = configToToml({
      steps: [
        step({
          parameters: [{ name: 'PB', mode: 'fit' }, { name: 'KEX_AB', mode: 'fit' }],
          search: {
            mode: 'de',
            seed: '597',
            axes: [
              { id: 'a', param: 'PB', fn: 'log', low: 0.001, high: 0.2, count: 0 },
              { id: 'b', param: 'KEX_AB', fn: 'log', low: 100, high: 5000, count: 0 },
            ],
          },
        }),
      ],
    });
    expect(toml).toContain('[STEP1.SEARCH.DE]\nSEED = 597\nCOORDINATES = [\n  "[PB] = log(0.001, 0.2)",\n  "[KEX_AB] = log(100, 5000)",\n]');
  });

  it('emits ROLES_FROM, role rules after the table, selection and expanded statistics', () => {
    const toml = configToToml({
      steps: [
        step({ name: 'GLOBAL_FIT', residues: ['15', '31', 'G24N-H'], parameters: [{ name: 'PB', mode: 'fit' }] }),
        step({
          name: 'LOCAL_FITS',
          residues: ['ALL'],
          rolesFrom: 'GLOBAL_FIT',
          parameters: [{ name: 'DW_AB', mode: 'fix' }],
          roleRules: [
            { id: 'r1', action: 'FIT', entries: ['DW_AB, NUC->G24N-H', ''] },
            { id: 'r2', action: 'CONSTRAIN', entries: ['[DW_AB, NUC->G31N-H] = [DW_AB, NUC->G24N-H]'] },
          ],
          statistics: {
            mc: { enabled: true, replicates: 100, seed: '680' },
            bs: { enabled: false, replicates: 100 },
            mcmc: { enabled: true, steps: 20000, burn: 4000 },
          },
        }),
      ],
    });
    expect(toml).toContain('[GLOBAL_FIT]\nINCLUDE = [15, 31, "G24N-H"]');
    expect(toml).toContain(
      '[LOCAL_FITS]\nINCLUDE = "ALL"\nROLES_FROM = "GLOBAL_FIT"\nROLES = [\n  { FIX = ["DW_AB"] },\n  { FIT = ["DW_AB, NUC->G24N-H"] },\n  { CONSTRAIN = ["[DW_AB, NUC->G31N-H] = [DW_AB, NUC->G24N-H]"] },\n]'
    );
    expect(toml).toContain('[LOCAL_FITS.STATISTICS.MC]\nREPLICATES = 100\nSEED = 680');
    expect(toml).not.toContain('STATISTICS.BS]');
    expect(toml).toContain('[LOCAL_FITS.STATISTICS.MCMC]\nSTEPS = 20000\nBURN = 4000');
  });

  it('respects rawOverride when present in config', () => {
    const customRaw = '# Custom ChemEx script\n[RAW_STEP]\nCUSTOM_KEY = true';
    expect(configToToml({ steps: [], rawOverride: customRaw })).toBe(customRaw);
  });
});

describe('ChemEx method.toml parser', () => {
  it('round-trips a full v2 file through the structured model', () => {
    const input = `FORMAT_VERSION = 2

[GLOBAL_FIT]
INCLUDE = [15, 31, 33]
ROLES = [
  { CONSTRAIN = ["[R2_B] = [R2_A]"] },
  { FIX = ["R1_A"] },
  { FIT = ["PB", "KEX_AB", "DW_AB"] },
]

[GLOBAL_FIT.SEARCH.GRID]
AXES = [
  "[PB] = values(0.01, 0.02, 0.05)",
  "[KEX_AB] = log(100.0, 5000.0, 12)",
]

[LOCAL_FITS]
EXCLUDE = [12, 18]
ROLES_FROM = "GLOBAL_FIT"
ROLES = [
  { FIX = ["PB", "KEX_AB"] },
  { FIT = ["DW_AB, NUC->G24N-H"] },
]
STATISTICS = { MC = 100, MCMC = 5000 }
`;
    const { config, unparsed } = tomlToConfig(input);
    expect(unparsed).toEqual([]);
    const [g, l] = config.steps;
    expect(g.residues).toEqual(['15', '31', '33']);
    expect(g.parameters.find(p => p.name === 'R2_B')).toMatchObject({ mode: 'constrain', expression: '[R2_A]' });
    expect(g.search?.mode).toBe('grid');
    expect(g.search?.axes.map(a => [a.param, a.fn, a.count])).toEqual([
      ['PB', 'values', 3],
      ['KEX_AB', 'log', 12],
    ]);
    expect(l.rolesFrom).toBe('GLOBAL_FIT');
    expect(l.residueMode).toBe('exclude');
    expect(l.parameters.map(p => [p.name, p.mode])).toEqual([
      ['PB', 'fix'],
      ['KEX_AB', 'fix'],
    ]);
    expect(l.roleRules?.map(r => [r.action, r.entries])).toEqual([['FIT', ['DW_AB, NUC->G24N-H']]]);
    expect(l.statistics?.mc?.replicates).toBe(100);
    expect(l.statistics?.mcmc).toMatchObject({ steps: 5000, burn: 'auto' });

    // Emit → parse → emit is a fixed point.
    const emitted = configToToml(config);
    expect(configToToml(tomlToConfig(emitted).config)).toBe(emitted);
  });

  it('is a parse → emit fixed point with qualified search axes, rules and DE', () => {
    const cfg: MethodConfig = {
      steps: [
        step({
          name: 'G',
          parameters: [{ name: 'PB', mode: 'fit' }],
          search: {
            mode: 'grid',
            axes: [
              { id: '1', param: 'KEX_AB', fn: 'log', low: 20, high: 2000, count: 12 },
              { id: '2', param: 'DW_AB', qualifier: 'NUC->G24N-H, B0->800.13MHz', fn: 'lin', low: -10, high: 10, count: 21 },
            ],
          },
        }),
        step({
          name: 'L',
          rolesFrom: 'G',
          parameters: [{ name: 'PB', mode: 'fix' }],
          roleRules: [{ id: 'r', action: 'FIX', entries: ['R1_A, [P]->0.001M'] }],
          search: { mode: 'de', seed: '1', axes: [{ id: '3', param: 'KEX_AB', fn: 'log', low: 10, high: 5000, count: 0 }] },
        }),
      ],
    };
    const once = configToToml(cfg);
    expect(configToToml(tomlToConfig(once).config)).toBe(once);
  });

  it('moves overriding actions (same name twice) into ordered role rules', () => {
    const { config } = tomlToConfig(`FORMAT_VERSION = 2
[STEP]
ROLES = [
  { FIX = ["DW_AB"] },
  { FIT = ["DW_AB"] },
  { FIX = ["PB"] },
]
`);
    const s = config.steps[0];
    expect(s.parameters).toEqual([{ name: 'DW_AB', mode: 'fix' }]);
    expect(s.roleRules?.map(r => [r.action, r.entries])).toEqual([
      ['FIT', ['DW_AB']],
      ['FIX', ['PB']],
    ]);
    expect(configToToml(config)).toContain('ROLES = [\n  { FIX = ["DW_AB"] },\n  { FIT = ["DW_AB"] },\n  { FIX = ["PB"] },\n]');
  });

  it('parses SEARCH.DE and expanded statistics', () => {
    const { config, unparsed } = tomlToConfig(`FORMAT_VERSION = 2
[STEP]
ROLES = [{ FIT = ["PB", "KEX_AB", "DW_AB"] }]

[STEP.SEARCH.DE]
SEED = 597
COORDINATES = ["[PB] = log(0.001, 0.20)", "[KEX_AB] = log(100.0, 5000.0)"]

[STEP.STATISTICS.BSN]
REPLICATES = 100
SEED = 682

[STEP.STATISTICS.MCMC]
STEPS = 20000
BURN = 4000
SEED = 680
`);
    expect(unparsed).toEqual([]);
    const s = config.steps[0];
    expect(s.search).toMatchObject({ mode: 'de', seed: '597' });
    expect(s.search?.axes.map(a => [a.param, a.fn, a.low, a.high])).toEqual([
      ['PB', 'log', 0.001, 0.2],
      ['KEX_AB', 'log', 100, 5000],
    ]);
    expect(s.statistics?.bsn).toEqual({ enabled: true, replicates: 100, seed: '682' });
    expect(s.statistics?.mcmc).toMatchObject({ steps: 20000, burn: 4000, seed: '680' });
  });

  it('migrates v1 files: buckets, GRID, bare tuples, implicit carry-over', () => {
    const { config, unparsed } = tomlToConfig(`[STEP1]
FIT = ["PB", "KEX_AB"]
FIX = ["DW_AB"]
CONSTRAINTS = ["[R2_B] = 0.5 * [R2_A]", "[PB] < 0.5"]
INCLUDE = ["13N", "14N"]
GRID = ["[KEX_AB] = log(100.0, 600.0, 10)", "[PB] = (0.01, 0.05, 0.10)"]
FITMETHOD = "least_squares"

[STEP2]
FIT = ["DW_AB"]
STATISTICS = { "MCMC" = { STEPS = 5000, BURN = "AUTO", THIN = 10 } }
`);
    const [s1, s2] = config.steps;
    expect(s1.parameters.find(p => p.name === 'R2_B')).toMatchObject({ mode: 'constrain', expression: '0.5 * [R2_A]' });
    expect(s1.parameters.find(p => p.name === 'PB')).toMatchObject({ mode: 'fit', bounds: '< 0.5' });
    expect(s1.search?.axes.map(a => [a.param, a.fn])).toEqual([
      ['KEX_AB', 'log'],
      ['PB', 'values'],
    ]);
    expect(s2.rolesFrom).toBe('STEP1');
    expect(s2.residues).toEqual(['13N', '14N']);
    expect(s2.statistics?.mcmc).toMatchObject({ steps: 5000, burn: 'auto', thin: 10 });
    expect(unparsed.some(l => l.includes('[PB] < 0.5'))).toBe(true);
    expect(unparsed.some(l => l.includes('FITMETHOD'))).toBe(true);
    expect(unparsed.some(l => l.includes('THIN'))).toBe(true);

    const v2 = configToToml(config);
    expect(v2).toContain('"[PB] = values(0.01, 0.05, 0.1)"');
    expect(v2).toContain('ROLES_FROM = "STEP1"');
    expect(v2).not.toMatch(/FITMETHOD|THIN|< 0\.5/);
  });

  it('parses legacy inline-table GRID syntax', () => {
    const { config } = tomlToConfig(`[GRID_STEP]
FIT = ["DW_AB"]
GRID = { PB = [0.01, 0.2, 20], KEX_AB = [100, 2000, 20] }
`);
    expect(config.steps[0].search?.axes.map(a => [a.param, a.fn, a.low, a.high, a.count])).toEqual([
      ['PB', 'lin', 0.01, 0.2, 20],
      ['KEX_AB', 'lin', 100, 2000, 20],
    ]);
  });

  it('keeps full-line comments as unparsed and handles empty input', () => {
    const { config, unparsed } = tomlToConfig(`FORMAT_VERSION = 2
[STEP1]
ROLES = [{ FIT = ["PB"] }]  # trailing comment
#ROLES = [{ FIX = ["KEX_AB"] }]
`);
    expect(config.steps[0].parameters).toEqual([{ name: 'PB', mode: 'fit' }]);
    expect(unparsed).toEqual(['#ROLES = [{ FIX = ["KEX_AB"] }]']);
    expect(tomlToConfig('').config.steps[0].name).toBe('STEP1');
  });

  it('throws on malformed TOML', () => {
    expect(() => tomlToConfig('[STEP1\nROLES = [')).toThrow();
    expect(() => parseTomlDocument('A = 1\nA = 2')).toThrow(/Duplicate/);
  });
});

describe('Physically relevant search defaults', () => {
  it('uses experiment-specific exchange windows', () => {
    expect(defaultRange('KEX_AB', 'grid', 'cest')).toMatchObject({ fn: 'log', low: 20, high: 2000 });
    expect(defaultRange('KEX_AB', 'grid', 'cpmg')).toMatchObject({ fn: 'log', low: 100, high: 10000 });
    expect(defaultRange('PB', 'grid', 'cest')).toMatchObject({ fn: 'log', low: 0.005, high: 0.2 });
    // CEST resolves the sign of Δϖ; CPMG does not.
    expect(defaultRange('DW_AB', 'grid', 'cest').low).toBeLessThan(0);
    expect(defaultRange('DW_AB', 'grid', 'cpmg').low).toBe(0);
  });

  it('keeps every default inside physical bounds and valid for its scale', () => {
    for (const family of ['cest', 'cpmg', 'exchange']) {
      for (const p of ['PB', 'PC', 'KEX_AB', 'KEX_BC', 'DW_AB', 'R1_A', 'R2_A', 'TAUC_A', 'UNKNOWN']) {
        for (const mode of ['grid', 'de'] as const) {
          const d = defaultRange(p, mode, family);
          expect(d.low).toBeLessThan(d.high);
          if (d.fn === 'log') expect(d.low).toBeGreaterThan(0);
          if (/^P[B-F]$/.test(p)) expect(d.high).toBeLessThanOrEqual(1);
          if (mode === 'grid') expect(d.count).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });

  it('expands log axes geometrically', () => {
    const pts = axisPoints(createSearchAxis('KEX_AB', 'grid', 'cest'));
    expect(pts[0]).toBeCloseTo(20);
    expect(pts[pts.length - 1]).toBeCloseTo(2000);
    expect(pts[1] / pts[0]).toBeCloseTo(pts[2] / pts[1]);
  });
});

describe('Method Configuration Validation (v2)', () => {
  const known = ['PB', 'KEX_AB', 'CS_A', 'DW_AB', 'R2_A', 'R2_B', 'R1_A', 'R1_B'];

  it('validates starter templates without blocking errors', () => {
    for (const tmpl of METHOD_TEMPLATES) {
      const blocking = validateMethodConfig(normalizeMethodConfig(tmpl.config)).filter(e => e.severity === 'error');
      expect(blocking, tmpl.id).toEqual([]);
    }
  });

  it('flags unknown parameters and bad constraints', () => {
    const errors = validateMethodConfig(
      {
        steps: [
          step({
            parameters: [
              { name: 'UNKNOWN_PARAM', mode: 'fit' },
              { name: 'R2_B', mode: 'constrain', expression: '0.5 * [R2_A' },
              { name: 'R1_B', mode: 'constrain', expression: '[NON_EXISTENT_PARAM]' },
              { name: 'R1_A', mode: 'constrain', expression: 'sqrt([R2_A])' },
            ],
          }),
        ],
      },
      known
    );
    expect(errors.some(e => e.message.includes('Unknown parameter "UNKNOWN_PARAM"'))).toBe(true);
    expect(errors.some(e => e.message.includes('Unclosed parameter selector'))).toBe(true);
    expect(errors.some(e => e.message.includes('unknown parameter "NON_EXISTENT_PARAM"'))).toBe(true);
    expect(errors.some(e => e.paramName === 'R1_A' && e.severity === 'error')).toBe(true);
  });

  it('enforces ROLES_FROM ordering, search-target roles, DE seed, ranges and stats', () => {
    const cfg: MethodConfig = {
      steps: [
        step({
          name: 'A',
          rolesFrom: 'B',
          parameters: [{ name: 'PB', mode: 'fix' }],
          search: {
            mode: 'de',
            axes: [
              { id: '1', param: 'PB', fn: 'log', low: 0.001, high: 0.2, count: 0 },
              { id: '2', param: 'KEX_AB', fn: 'values', low: 0, high: 0, count: 0, values: [1, 2] },
              { id: '3', param: 'DW_AB', fn: 'log', low: -1, high: 5, count: 0 },
            ],
          },
          statistics: {
            mc: { enabled: true, replicates: -5 },
            mcmc: { enabled: true, steps: 100, burn: 100, walkers: 64 },
          },
        }),
        step({ id: 't', name: 'B', search: { mode: 'grid', axes: [{ id: '4', param: 'PB', fn: 'lin', low: 0.2, high: 1.5, count: 1 }] } }),
      ],
    };
    const msgs = validateMethodConfig(cfg, known).map(e => e.message);
    expect(msgs.some(m => m.includes('ROLES_FROM "B" is step 2, after this one; it must name an earlier step'))).toBe(true);
    expect(msgs.some(m => m.includes('search targets must be final FIT coordinates'))).toBe(true);
    expect(msgs.some(m => m.includes('DE search: SEED is required'))).toBe(true);
    expect(msgs.some(m => m.includes('must use lin(low, high) or log(low, high)'))).toBe(true);
    expect(msgs.some(m => m.includes('must be strictly positive'))).toBe(true);
    expect(msgs.some(m => m.includes('within [0, 1]'))).toBe(true);
    expect(msgs.some(m => m.includes('point count ≥ 2'))).toBe(true);
    expect(msgs.some(m => m.includes('The last step uses GRID'))).toBe(true);
    expect(msgs.some(m => m.includes('replicate count must be a positive integer'))).toBe(true);
    expect(msgs.some(m => m.includes('burn (100) must be smaller than total steps (100)'))).toBe(true);
    expect(msgs.some(m => m.includes('WALKERS=64'))).toBe(true);
  });

  it('rejects malformed selectors in role rules', () => {
    const msgs = validateMethodConfig(
      { steps: [step({ roleRules: [{ id: 'r', action: 'FIT', entries: ['DW_AB, FOO->1'] }] })] },
      known
    ).map(e => e.message);
    expect(msgs.some(m => m.includes('Unknown or malformed selector qualifier'))).toBe(true);
  });
});

describe('u64 seed precision', () => {
  const MAX = '18446744073709551615';

  it('round-trips 2^64 − 1 through parse → model → emit → parse without loss', () => {
    const input = `FORMAT_VERSION = 2

[STEP]
ROLES = [{ FIT = ["PB", "KEX_AB"] }]

[STEP.SEARCH.DE]
SEED = ${MAX}
COORDINATES = ["[PB] = log(0.001, 0.2)"]

[STEP.STATISTICS.MC]
REPLICATES = 10
SEED = ${MAX}

[STEP.STATISTICS.MCMC]
STEPS = 100
SEED = 9007199254740993
`;
    const { config, unparsed } = tomlToConfig(input);
    expect(unparsed).toEqual([]);
    const s = config.steps[0];
    expect(s.search?.seed).toBe(MAX);
    expect(s.statistics?.mc?.seed).toBe(MAX);
    expect(s.statistics?.mcmc?.seed).toBe('9007199254740993'); // 2^53 + 1: not representable as a JS number
    const out = configToToml(config);
    expect(out).toContain(`SEED = ${MAX}\nCOORDINATES`);
    expect(out).toContain(`REPLICATES = 10\nSEED = ${MAX}`);
    expect(out).toContain('STEPS = 100\nSEED = 9007199254740993');
    expect(tomlToConfig(out).config.steps[0].search?.seed).toBe(MAX);
  });

  it('migrates legacy numeric seeds from saved configs', () => {
    const legacy = {
      steps: [
        step({
          search: { mode: 'de', seed: 597 as unknown as string, axes: [{ id: 'a', param: 'PB', fn: 'log', low: 0.001, high: 0.2, count: 0 }] },
          statistics: { bs: { enabled: true, replicates: 5, seed: 681 as unknown as string } },
        }),
      ],
    } as MethodConfig;
    const s = normalizeMethodConfig(legacy).steps[0];
    expect(s.search?.seed).toBe('597');
    expect(s.statistics?.bs?.seed).toBe('681');
  });

  it('keeps a malformed SEED visible instead of dropping it', () => {
    const { config, unparsed } = tomlToConfig(`FORMAT_VERSION = 2
[STEP.STATISTICS.MC]
REPLICATES = 5
SEED = 1.5
`);
    expect(unparsed.some(l => l.includes('SEED = 1.5'))).toBe(true);
    expect(config.steps[0].statistics?.mc?.seed).toBe('1.5');
    expect(validateMethodConfig(config).some(e => e.message.includes('SEED must be an integer'))).toBe(true);
    expect(configToToml(config)).not.toContain('SEED');
  });

  it('rejects seeds above 2^64 − 1', () => {
    const errors = validateMethodConfig({
      steps: [step({ search: { mode: 'de', seed: '18446744073709551616', axes: [{ id: 'a', param: 'PB', fn: 'log', low: 0.001, high: 0.2, count: 0 }] } })],
    });
    expect(errors.some(e => e.severity === 'error' && e.message.includes('SEED must be an integer'))).toBe(true);
  });
});

describe('protected parameters (frontend instant check)', () => {
  const catalog = {
    KAB: { name: 'KAB', scope: 'global', spins: [], T: [], B0: [], '[P]': [], '[L]': [], D2O: [], protected: true, estimable: true, count: 1 },
    PB: { name: 'PB', scope: 'global', spins: [], T: [], B0: [], '[P]': [], '[L]': [], D2O: [], protected: false, estimable: true, count: 1 },
  } as const;
  it('flags table modes, rules and search axes that target model-derived parameters', () => {
    const msgs = validateMethodConfig(
      {
        steps: [
          step({
            parameters: [{ name: 'KAB', mode: 'fit' }, { name: 'PB', mode: 'fit' }],
            roleRules: [{ id: 'r', action: 'CONSTRAIN', entries: ['[KAB] = 2 * [PB]'] }],
            search: { mode: 'grid', axes: [{ id: 'a', param: 'KAB', fn: 'lin', low: 1, high: 2, count: 3 }] },
          }),
        ],
      },
      ['PB', 'KAB'],
      0,
      catalog as never
    )
      .filter(e => e.severity === 'error')
      .map(e => e.message);
    expect(msgs.filter(m => m.includes('KAB is model-derived (protected)')).length).toBe(3);
    expect(msgs.some(m => m.includes('PB is model-derived'))).toBe(false);
  });
});

describe('DE breadth (instant check; ChemEx is authoritative)', () => {
  it('requires pinning every dimension with several copies', async () => {
    const { deBreadthError } = await import('./methodValidation');
    const { buildParameterCatalog } = await import('./baselineRoles');
    const cat = buildParameterCatalog([
      { id: '1', name: 'PB', status: 'fit' },
      { id: '2', name: 'DW_AB', status: 'fit', spin: '26N' },
      { id: '3', name: 'DW_AB', status: 'fit', spin: '28N' },
      { id: '4', name: 'R2_A', status: 'fit', spin: '26N', conditions: { h_larmor_frq: 600.1 } },
      { id: '5', name: 'R2_A', status: 'fit', spin: '26N', conditions: { h_larmor_frq: 800.1 } },
    ]);
    expect(deBreadthError('PB', undefined, cat)).toBeNull();
    expect(deBreadthError('DW_AB', undefined, cat)).toContain('matches copies for 2 residues');
    expect(deBreadthError('DW_AB', 'NUC->26N', cat)).toBeNull();
    expect(deBreadthError('R2_A', 'NUC->26N', cat)).toContain('2 B0 fields');
    expect(deBreadthError('R2_A', 'NUC->26N, B0->800.1MHz', cat)).toBeNull();
    expect(deBreadthError('DW_AB', undefined, null)).toBeNull();
  });
});
