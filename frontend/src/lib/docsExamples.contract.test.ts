/**
 * Golden round trips for every TOML example on the ChemEx v2 method-files page
 * (backend/tests/fixtures/method_contract/docs_examples), shared with
 * backend/tests/test_method_docs_examples.py, which pins the same emitted bytes and
 * checks each example with ChemEx itself.
 */
import { describe, expect, it } from 'vitest';
import { configToToml, tomlToConfig } from './methodToml';
import type { MethodConfig } from './methodConfig';

const sources = import.meta.glob('../../../backend/tests/fixtures/method_contract/docs_examples/*.toml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const emitted = import.meta.glob('../../../backend/tests/fixtures/method_contract/docs_examples/emitted/*.toml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const base = (p: string) => p.split('/').pop()!;
const examples = Object.entries(sources).map(([path, text]) => ({ name: base(path), text, emitted: emitted[path.replace(/\/([^/]+)$/, '/emitted/$1')] }));

/** Model without generated ids (ids are per parse). */
const shape = (c: MethodConfig) =>
  JSON.parse(
    JSON.stringify(c, (k, v) => (k === 'id' || k === 'rolesFromStepId' ? undefined : v))
  );

describe('ChemEx docs examples: parse → model → emit → parse', () => {
  it('covers every example on the docs page', () => {
    expect(examples.map(e => e.name).sort()).toEqual([
      '01_minimal_default.toml', '02_ordered_roles.toml', '03_broad_rule_exceptions.toml', '04_selectors_constraints.toml',
      '05_multi_step.toml', '06_selection.toml', '07_grid.toml', '08_de.toml', '09_statistics_compact.toml',
      '10_statistics_expanded.toml', '11_v1_step.toml', '11_v2_equivalent.toml', '12_chemex_method_de.toml',
    ]);
    expect(examples.every(e => typeof e.emitted === 'string')).toBe(true);
  });

  it.each(examples)('$name', ({ text, emitted: golden }) => {
    const first = tomlToConfig(text);
    // Only the fixture's own explanatory comment may be left out of the model.
    expect(first.unparsed.filter(l => !l.trimStart().startsWith('#'))).toEqual([]);
    const out = configToToml(first.config);
    expect(out).toBe(golden);
    const second = tomlToConfig(out);
    expect(second.unparsed).toEqual([]);
    expect(shape(second.config)).toEqual(shape(first.config));
    expect(configToToml(second.config)).toBe(out);
  });

  it('the docs v1 step and its stated v2 equivalent emit identical methods', () => {
    const v1 = examples.find(e => e.name === '11_v1_step.toml')!;
    const v2 = examples.find(e => e.name === '11_v2_equivalent.toml')!;
    expect(tomlToConfig(v1.text).format).toBe('v1');
    expect(configToToml(tomlToConfig(v1.text).config)).toBe(configToToml(tomlToConfig(v2.text).config));
  });
});
