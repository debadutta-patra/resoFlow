/**
 * Every template's emitted TOML is pinned in the shared fixture that
 * backend/tests/test_method_templates.py validates with ChemEx. If a template changes,
 * regenerate the fixture (templateFixture()) and let ChemEx re-check it.
 */
import { describe, expect, it } from 'vitest';
import fixtureJson from '../../../backend/tests/fixtures/method_contract/templates_emitted.json?raw';
import { templateFixture } from './templateFixture';
import { METHOD_TEMPLATES } from './methodTemplates';

describe('templates contract', () => {
  it('matches the ChemEx-validated fixture', () => {
    expect(templateFixture()).toEqual(JSON.parse(fixtureJson));
  });

  it('includes every template the Methods page must offer, each with a one-line description', () => {
    const ids = METHOD_TEMPLATES.map(t => t.id);
    for (const id of ['two_step_global_local', 'grid_and_refine_cest', 'de_seeding', 'tie_b_relaxation', 'final_statistics']) expect(ids).toContain(id);
    for (const t of METHOD_TEMPLATES) expect(t.description.includes('\n'), t.id).toBe(false);
  });
});
