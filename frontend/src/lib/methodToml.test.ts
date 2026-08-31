import { describe, it, expect } from 'vitest';
import { configToToml, tomlToConfig } from './methodToml';
import type { MethodConfig } from './methodConfig';

describe('ChemEx method.toml Serializer and Parser', () => {
  it('handles the user prompt test config with commented constraints', () => {
    const rawToml = `[STEP1]
FIT = ["PB", "KEX_AB", "DW_AB", "CS_A"]
#CONSTRAINTS = [
#"[R2_B] = 0.5 * [R2_A]",
#"[PB] = 0.5"
#]`;

    const { config, unparsed } = tomlToConfig(rawToml);

    // Assert that STEP1 and its FIT parameters were parsed correctly
    expect(config.steps).toHaveLength(1);
    expect(config.steps[0].name).toBe('STEP1');
    expect(config.steps[0].parameters.map(p => p.name)).toEqual(['PB', 'KEX_AB', 'DW_AB', 'CS_A']);
    expect(config.steps[0].parameters.every(p => p.mode === 'fit')).toBe(true);

    // Assert that commented lines are preserved in unparsed
    expect(unparsed.length).toBeGreaterThanOrEqual(4);
    expect(unparsed.some(l => l.includes('#CONSTRAINTS'))).toBe(true);
    expect(unparsed.some(l => l.includes('#"[R2_B] = 0.5 * [R2_A]"'))).toBe(true);

    // Assert that serializing active config produces valid clean TOML
    const generated = configToToml(config);
    expect(generated.trim()).toBe(`[STEP1]\nFIT = ["PB", "KEX_AB", "DW_AB", "CS_A"]`);
  });

  it('losslessly round-trips default single-step config with bound constraint', () => {
    const inputToml = `[STEP1]
FIT = ["PB", "KEX_AB", "DW_AB", "CS_A"]
CONSTRAINTS = ["[PB] < 0.5"]
`;

    const { config, unparsed } = tomlToConfig(inputToml);
    expect(unparsed).toEqual([]);
    expect(config.steps).toHaveLength(1);

    const pb = config.steps[0].parameters.find(p => p.name === 'PB');
    expect(pb?.mode).toBe('fit');
    expect(pb?.bounds).toBe('< 0.5');

    const generated = configToToml(config);
    expect(generated.trim()).toBe(inputToml.trim());
  });

  it('losslessly round-trips multi-step config with FIX, CONSTRAINTS, and INCLUDE/EXCLUDE', () => {
    const inputToml = `[STEP1]
FIT = ["PB", "KEX_AB"]
FIX = ["DW_AB", "CS_A"]
CONSTRAINTS = ["[PB] < 0.5"]
INCLUDE = ["13N", "14N", "15N"]

[STEP2]
FIT = ["DW_AB", "CS_A", "R2_A", "R2_B"]
CONSTRAINTS = [
  "[R2_B] = 0.5 * [R2_A]",
  "[PB] < 0.5"
]
EXCLUDE = ["25N"]
`;

    const { config, unparsed } = tomlToConfig(inputToml);
    expect(unparsed).toEqual([]);
    expect(config.steps).toHaveLength(2);

    expect(config.steps[0].name).toBe('STEP1');
    expect(config.steps[0].residueMode).toBe('include');
    expect(config.steps[0].residues).toEqual(['13N', '14N', '15N']);

    expect(config.steps[1].name).toBe('STEP2');
    expect(config.steps[1].residueMode).toBe('exclude');
    expect(config.steps[1].residues).toEqual(['25N']);

    const r2b = config.steps[1].parameters.find(p => p.name === 'R2_B');
    expect(r2b?.mode).toBe('constrain');
    expect(r2b?.expression).toBe('0.5 * [R2_A]');

    const generated = configToToml(config);
    const roundTripped = tomlToConfig(generated);
    expect(roundTripped.unparsed).toEqual([]);
    expect(roundTripped.config.steps.length).toBe(2);
    expect(roundTripped.config.steps[0].name).toBe('STEP1');
    expect(roundTripped.config.steps[1].name).toBe('STEP2');
  });

  it('parses and serializes ChemEx standard GRID search syntax', () => {
    const inputToml = `[GRID_STEP]
FIT = ["CS_A"]
GRID = [
  "[KEX_AB] = log(100.0, 600.0, 10)",
  "[PB] = log(0.03, 0.15, 10)",
  "[DW_AB] = lin(0.0, 10.0, 5)"
]
`;

    const { config, unparsed } = tomlToConfig(inputToml);
    expect(unparsed).toEqual([]);
    expect(config.steps).toHaveLength(1);
    expect(config.steps[0].name).toBe('GRID_STEP');

    const kex = config.steps[0].parameters.find(p => p.name === 'KEX_AB');
    expect(kex?.mode).toBe('grid');
    expect(kex?.grid).toEqual({ min: 100, max: 600, steps: 10, scale: 'log' });

    const pb = config.steps[0].parameters.find(p => p.name === 'PB');
    expect(pb?.mode).toBe('grid');
    expect(pb?.grid).toEqual({ min: 0.03, max: 0.15, steps: 10, scale: 'log' });

    const dw = config.steps[0].parameters.find(p => p.name === 'DW_AB');
    expect(dw?.mode).toBe('grid');
    expect(dw?.grid).toEqual({ min: 0, max: 10, steps: 5, scale: 'lin' });

    const generated = configToToml(config);
    expect(generated).toContain('GRID = [\n  "[KEX_AB] = log(100, 600, 10)",\n  "[PB] = log(0.03, 0.15, 10)",\n  "[DW_AB] = lin(0, 10, 5)"\n]');
  });

  it('parses legacy inline table GRID syntax for backwards compatibility', () => {
    const inputToml = `[GRID_STEP]
FIT = ["DW_AB"]
GRID = { PB = [0.01, 0.2, 20], KEX_AB = [100, 2000, 20] }
`;

    const { config, unparsed } = tomlToConfig(inputToml);
    expect(unparsed).toEqual([]);
    expect(config.steps).toHaveLength(1);

    const pb = config.steps[0].parameters.find(p => p.name === 'PB');
    expect(pb?.mode).toBe('grid');
    expect(pb?.grid).toEqual({ min: 0.01, max: 0.2, steps: 20, scale: 'lin' });

    const kex = config.steps[0].parameters.find(p => p.name === 'KEX_AB');
    expect(kex?.mode).toBe('grid');
    expect(kex?.grid).toEqual({ min: 100, max: 2000, steps: 20, scale: 'lin' });
  });

  it('handles empty or whitespace-only inputs gracefully', () => {
    const { config, unparsed } = tomlToConfig('');
    expect(config.steps).toHaveLength(1);
    expect(config.steps[0].name).toBe('STEP1');
    expect(unparsed).toEqual([]);
  });

  it('omits parameters with mode default from the generated method.toml', () => {
    const config: MethodConfig = {
      steps: [
        {
          id: 'step1',
          name: 'STEP1',
          parameters: [
            { name: 'PB', mode: 'fit', bounds: '< 0.5' },
            { name: 'KEX_AB', mode: 'fit' },
            { name: 'R2_A', mode: 'default' },
            { name: 'R1_A', mode: 'default' },
            { name: 'TAUC_A', mode: 'default' },
          ],
          residueMode: 'include',
          residues: [],
        },
      ],
    };

    const toml = configToToml(config);
    expect(toml).toContain('FIT = ["PB", "KEX_AB"]');
    expect(toml).toContain('CONSTRAINTS = ["[PB] < 0.5"]');
    expect(toml).not.toContain('R2_A');
    expect(toml).not.toContain('R1_A');
    expect(toml).not.toContain('TAUC_A');
    expect(toml).not.toContain('FIX');
  });

  it('respects rawOverride when present in config', () => {
    const customRaw = '# Custom ChemEx script\n[RAW_STEP]\nCUSTOM_KEY = true';
    const config: MethodConfig = {
      steps: [],
      rawOverride: customRaw,
    };

    expect(configToToml(config)).toBe(customRaw);
  });
});

describe('Method Configuration Validation', () => {
  it('detects unknown parameters and empty fit steps', async () => {
    const { validateMethodConfig } = await import('./methodValidation');
    const invalidConfig: MethodConfig = {
      steps: [
        {
          id: 'step1',
          name: 'STEP1',
          parameters: [
            { name: 'UNKNOWN_PARAM', mode: 'fit' },
          ],
          residueMode: 'include',
          residues: [],
        },
        {
          id: 'step2',
          name: 'STEP2',
          parameters: [], // empty fit and no grid
          residueMode: 'include',
          residues: [],
        },
      ],
    };

    const errors = validateMethodConfig(invalidConfig, ['PB', 'KEX_AB', 'CS_A', 'DW_AB']);
    expect(errors.some(e => e.message.includes('Unknown parameter "UNKNOWN_PARAM"'))).toBe(true);
    expect(errors.some(e => e.message.includes('has no parameters in FIT'))).toBe(true);
  });

  it('detects invalid constraint expressions and unmatched brackets', async () => {
    const { validateMethodConfig } = await import('./methodValidation');
    const invalidConfig: MethodConfig = {
      steps: [
        {
          id: 'step1',
          name: 'STEP1',
          parameters: [
            { name: 'PB', mode: 'fit' },
            { name: 'R2_B', mode: 'constrain', expression: '0.5 * [R2_A' }, // unmatched bracket
            { name: 'R1_B', mode: 'constrain', expression: '[NON_EXISTENT_PARAM]' },
          ],
          residueMode: 'include',
          residues: [],
        },
      ],
    };

    const errors = validateMethodConfig(invalidConfig, ['PB', 'KEX_AB', 'CS_A', 'DW_AB', 'R2_A', 'R2_B', 'R1_A', 'R1_B']);
    expect(errors.some(e => e.message.includes('Unmatched brackets'))).toBe(true);
    expect(errors.some(e => e.message.includes('unknown parameter "NON_EXISTENT_PARAM"'))).toBe(true);
  });

  it('validates starter templates without error', async () => {
    const { validateMethodConfig } = await import('./methodValidation');
    const { METHOD_TEMPLATES } = await import('./methodTemplates');

    for (const tmpl of METHOD_TEMPLATES) {
      const errors = validateMethodConfig(tmpl.config);
      const blocking = errors.filter(e => e.severity === 'error');
      expect(blocking).toEqual([]);
    }
  });

  it('serializes and parses STATISTICS block matching ChemEx v1 specification', () => {
    const config: MethodConfig = {
      steps: [
        {
          id: 'step1',
          name: 'STEP1',
          parameters: [
            { name: 'PB', mode: 'fit' },
            { name: 'KEX_AB', mode: 'fit' },
          ],
          residueMode: 'include',
          residues: ['15', '31', '33'],
          statistics: {
            mc: { enabled: true, replicates: 100 },
            bs: { enabled: true, replicates: 50 },
            bsn: { enabled: true, replicates: 25 },
          },
        },
      ],
    };

    const toml = configToToml(config);
    expect(toml).toContain('STATISTICS = { "MC" = 100, "BS" = 50, "BSN" = 25 }');

    const { config: parsed } = tomlToConfig(toml);
    expect(parsed.steps[0].statistics?.mc?.enabled).toBe(true);
    expect(parsed.steps[0].statistics?.mc?.replicates).toBe(100);
    expect(parsed.steps[0].statistics?.bs?.enabled).toBe(true);
    expect(parsed.steps[0].statistics?.bs?.replicates).toBe(50);
    expect(parsed.steps[0].statistics?.bsn?.enabled).toBe(true);
    expect(parsed.steps[0].statistics?.bsn?.replicates).toBe(25);
  });

  it('serializes compact MCMC and expanded MCMC with subtable', () => {
    // Compact MCMC
    const compactConfig: MethodConfig = {
      steps: [
        {
          id: 'step1',
          name: 'STEP1',
          parameters: [{ name: 'PB', mode: 'fit' }],
          residueMode: 'include',
          residues: [],
          statistics: {
            mcmc: { enabled: true, steps: 5000, burn: 'auto', thin: 1 },
          },
        },
      ],
    };
    const compactToml = configToToml(compactConfig);
    expect(compactToml).toContain('STATISTICS = { "MCMC" = 5000 }');

    // Expanded MCMC
    const expandedConfig: MethodConfig = {
      steps: [
        {
          id: 'step1',
          name: 'STEP1',
          parameters: [{ name: 'PB', mode: 'fit' }],
          residueMode: 'include',
          residues: [],
          statistics: {
            mcmc: {
              enabled: true,
              steps: 5000,
              burn: 1000,
              thin: 10,
              walkers: 64,
              seed: 1234,
              workers: 2,
              update_parameters: true,
            },
          },
        },
      ],
    };
    const expandedToml = configToToml(expandedConfig);
    expect(expandedToml).toContain('[STEP1.STATISTICS.MCMC]');
    expect(expandedToml).toContain('STEPS = 5000');
    expect(expandedToml).toContain('BURN = 1000');
    expect(expandedToml).toContain('THIN = 10');
    expect(expandedToml).toContain('WALKERS = 64');
    expect(expandedToml).toContain('SEED = 1234');
    expect(expandedToml).toContain('WORKERS = 2');
    expect(expandedToml).toContain('UPDATE_PARAMETERS = true');

    const { config: parsed } = tomlToConfig(expandedToml);
    expect(parsed.steps[0].statistics?.mcmc?.enabled).toBe(true);
    expect(parsed.steps[0].statistics?.mcmc?.steps).toBe(5000);
    expect(parsed.steps[0].statistics?.mcmc?.burn).toBe(1000);
    expect(parsed.steps[0].statistics?.mcmc?.thin).toBe(10);
    expect(parsed.steps[0].statistics?.mcmc?.walkers).toBe(64);
    expect(parsed.steps[0].statistics?.mcmc?.seed).toBe(1234);
    expect(parsed.steps[0].statistics?.mcmc?.workers).toBe(2);
    expect(parsed.steps[0].statistics?.mcmc?.update_parameters).toBe(true);
  });

  it('validates statistics bounds and conflict with grid search', async () => {
    const { validateMethodConfig } = await import('./methodValidation');

    const invalidStatsConfig: MethodConfig = {
      steps: [
        {
          id: 'step1',
          name: 'STEP1',
          parameters: [
            { name: 'PB', mode: 'grid', grid: { min: 0.01, max: 0.2, steps: 10, scale: 'lin' } },
          ],
          residueMode: 'include',
          residues: [],
          statistics: {
            mc: { enabled: true, replicates: -5 },
            mcmc: { enabled: true, steps: 100, burn: 100, thin: 1 },
          },
        },
      ],
    };

    const errors = validateMethodConfig(invalidStatsConfig);
    expect(errors.some(e => e.message.includes('GRID search and STATISTICS enabled'))).toBe(true);
    expect(errors.some(e => e.message.includes('replicate count must be a positive integer'))).toBe(true);
    expect(errors.some(e => e.message.includes('burn (100) must be smaller than total steps (100)'))).toBe(true);
  });
});
