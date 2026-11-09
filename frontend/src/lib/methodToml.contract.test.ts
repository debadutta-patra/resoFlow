/**
 * Emitter contract: methodToml.ts must emit exactly the TOML pinned in the shared
 * fixture; backend/tests/test_method_emit_contract.py holds method_emitter.py to the
 * same bytes, so the two emitters cannot drift apart.
 */
import { describe, expect, it } from 'vitest';
import casesJson from '../../../backend/tests/fixtures/method_contract/emit_cases.json?raw';
import { configToToml, tomlToConfig } from './methodToml';
import type { MethodConfig } from './methodConfig';

const { cases } = JSON.parse(casesJson) as { cases: Array<{ name: string; config: MethodConfig; toml: string }> };

describe('shared emitter contract (TS side)', () => {
  it.each(cases)('$name', ({ config, toml }) => {
    expect(configToToml(config)).toBe(toml);
  });

  it.each(cases.filter(c => !c.config.rawOverride))('$name: parse → emit is a fixed point', ({ toml }) => {
    expect(configToToml(tomlToConfig(toml).config)).toBe(toml);
  });
});
