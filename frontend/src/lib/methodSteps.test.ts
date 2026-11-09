import { describe, expect, it } from 'vitest';
import type { MethodConfig, Step } from './methodConfig';
import { normalizeMethodConfig } from './methodConfig';
import { configToToml, tomlToConfig } from './methodToml';
import { validateMethodConfig } from './methodValidation';
import { rolesFromTarget, setRolesFrom, stepNameError, uniqueStepName } from './methodSteps';

const step = (id: string, name: string, extra: Partial<Step> = {}): Step => ({
  id,
  name,
  parameters: [{ name: 'PB', mode: 'fit' }],
  residueMode: 'all',
  residues: [],
  ...extra,
});

describe('step names', () => {
  const steps = [step('a', 'GLOBAL_FIT'), step('b', 'local')];
  it.each([
    ['LOCAL_FITS-2', null],
    ['', 'cannot be empty'],
    ['my step', 'Use only letters'],
    ['a.b', 'Use only letters'],
    ['../x', 'Use only letters'],
    ['Grid', 'reserved'],
    ['RUN_INFO', 'reserved'],
    ['global_fit', 'Another step is already named "GLOBAL_FIT"'],
    ['x'.repeat(65), 'at most 64'],
  ])('"%s" → %s', (name, expected) => {
    const err = stepNameError(name, steps, 1);
    if (expected === null) expect(err).toBeNull();
    else expect(err).toContain(expected);
  });

  it('allows keeping its own name and generates unique names', () => {
    expect(stepNameError('local', steps, 1)).toBeNull();
    expect(uniqueStepName('GLOBAL_FIT', steps)).toBe('GLOBAL_FIT_2');
    expect(uniqueStepName('STEP3', steps)).toBe('STEP3');
  });
});

describe('ROLES_FROM by step id', () => {
  const base: MethodConfig = {
    steps: [step('g', 'GLOBAL_FIT'), setRolesFrom(step('l', 'LOCAL_FITS'), step('g', 'GLOBAL_FIT'), 0)],
  };

  it('serialises the current name of the target, so renames follow automatically', () => {
    const renamed: MethodConfig = { steps: [{ ...base.steps[0], name: 'Coarse' }, base.steps[1]] };
    expect(configToToml(renamed)).toContain('[LOCAL_FITS]\nROLES_FROM = "Coarse"');
    expect(validateMethodConfig(renamed).filter(e => e.severity === 'error')).toEqual([]);
  });

  it('reports a forward reference after reordering instead of fixing it', () => {
    const reordered: MethodConfig = { steps: [base.steps[1], base.steps[0]] };
    expect(rolesFromTarget(reordered.steps, 0)).toMatchObject({ status: 'forward', index: 1 });
    const errs = validateMethodConfig(reordered).filter(e => e.severity === 'error' && e.stepId === 'l');
    expect(errs.map(e => e.message)).toEqual(['ROLES_FROM "GLOBAL_FIT" is step 2, after this one; it must name an earlier step.']);
    expect(configToToml(reordered)).toContain('ROLES_FROM = "GLOBAL_FIT"'); // still visible in the TOML
  });

  it('reports a dangling reference after deleting the target, keeping its last name', () => {
    const deleted: MethodConfig = { steps: [base.steps[1]] };
    expect(rolesFromTarget(deleted.steps, 0)).toMatchObject({ status: 'missing', name: 'GLOBAL_FIT' });
    expect(validateMethodConfig(deleted).some(e => e.message.includes('no longer exists ("GLOBAL_FIT")'))).toBe(true);
    expect(configToToml(deleted)).toContain('ROLES_FROM = "GLOBAL_FIT"');
  });

  it('links name-only references from imports and older saved configs', () => {
    const legacy = normalizeMethodConfig({ steps: [step('g', 'GLOBAL_FIT'), step('l', 'LOCAL', { rolesFrom: 'GLOBAL_FIT' })] });
    expect(legacy.steps[1].rolesFromStepId).toBe('g');
    const imported = tomlToConfig('FORMAT_VERSION = 2\n\n[global_fit]\n\n[Local]\nROLES_FROM = "global_fit"\n').config;
    expect(imported.steps.map(s => s.name)).toEqual(['global_fit', 'Local']); // case preserved
    expect(imported.steps[1].rolesFromStepId).toBe(imported.steps[0].id);
    expect(configToToml(imported)).toBe('FORMAT_VERSION = 2\n\n[global_fit]\n\n[Local]\nROLES_FROM = "global_fit"\n');
  });

  it('keeps an unmatched imported ROLES_FROM visible as an error', () => {
    const { config } = tomlToConfig('FORMAT_VERSION = 2\n\n[A]\nROLES_FROM = "NOPE"\n');
    expect(config.steps[0].rolesFromStepId).toBeUndefined();
    expect(validateMethodConfig(config).some(e => e.message.includes('no longer exists ("NOPE")'))).toBe(true);
  });

  it('quotes non-bare step names so the preview stays valid TOML', () => {
    const { config } = tomlToConfig('FORMAT_VERSION = 2\n\n["my step"]\nROLES = [{ FIT = ["PB"] }]\n');
    expect(config.steps[0].name).toBe('my step');
    const out = configToToml(config);
    expect(out).toContain('["my step"]\nROLES');
    expect(tomlToConfig(out).config.steps[0].name).toBe('my step');
    expect(validateMethodConfig(config).some(e => e.message.includes('Use only letters'))).toBe(true);
  });
});
