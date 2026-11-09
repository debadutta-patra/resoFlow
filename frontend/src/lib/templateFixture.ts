/**
 * The emitted TOML of every template, as pinned in
 * backend/tests/fixtures/method_contract/templates_emitted.json (validated by ChemEx in
 * backend/tests/test_method_templates.py). Additions are applied to the two-step template.
 */
import { configToToml } from './methodToml';
import { migrateSavedConfig, type MethodConfig } from './methodConfig';
import { METHOD_TEMPLATES } from './methodTemplates';

export interface TemplateFixtureEntry {
  id: string;
  model: string;
  toml: string;
}

export function templateFixture(): TemplateFixtureEntry[] {
  const out: TemplateFixtureEntry[] = [];
  const base = METHOD_TEMPLATES.find(t => t.id === 'two_step_global_local');
  for (const t of METHOD_TEMPLATES) {
    if (t.kind === 'method') {
      out.push({ id: t.id, model: t.model ?? '2st', toml: configToToml(migrateSavedConfig(t.config)) });
    } else if (base && base.kind === 'method') {
      const cfg: MethodConfig = migrateSavedConfig(base.config);
      out.push({ id: `two_step_global_local+${t.id}`, model: '2st', toml: configToToml(t.apply(cfg, 0).config) });
    }
  }
  return out;
}
