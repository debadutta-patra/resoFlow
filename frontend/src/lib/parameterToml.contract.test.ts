/**
 * parameters.toml contract with ChemEx: the docs example (ChemEx 2026.09.2
 * examples/Experiments/CEST_15N, extended with bounds on PB and KEX_AB) must import →
 * export losslessly apart from formatting. The exported text is checked in as a golden
 * file that backend/tests/test_parameter_contract.py loads through ChemEx's own
 * `read_defaults`, so the two sides cannot drift.
 */
import { describe, expect, it } from 'vitest';
import { configToToml, tomlToConfig } from './parameterToml';

/** `npx vitest run parameterToml.contract -u` rewrites emitted/*.toml (file snapshots). */
const EMITTED_DIR = '../../../backend/tests/fixtures/parameter_contract/emitted';

const sources = import.meta.glob('../../../backend/tests/fixtures/parameter_contract/*.toml', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const baseName = (p: string) => p.split('/').pop() as string;

describe('parameters.toml contract (ChemEx docs example)', () => {
  const entries = Object.entries(sources);

  it('has fixtures', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  for (const [path, text] of entries) {
    const name = baseName(path);

    it(`${name}: import → export → import is lossless`, () => {
      const first = tomlToConfig(text);
      // Only the provenance comments at the top are not representable.
      expect(first.unparsed.every(l => l.trim().startsWith('#'))).toBe(true);
      const out = configToToml(first.config);
      const second = tomlToConfig(out);
      expect(second.unparsed).toEqual([]);
      expect(second.config.globals).toEqual(first.config.globals);
      expect(second.config.residues).toEqual(first.config.residues);
    });

    it(`${name}: keeps the bounds on PB and KEX_AB and the negative / large DW_AB`, () => {
      const { config } = tomlToConfig(text);
      expect(config.globals.pb).toMatchObject({ value: 0.015, lower: 0, upper: 0.2 });
      expect(config.globals.kex_ab).toMatchObject({ value: 70, lower: 1, upper: 1000 });
      expect(config.globals.tauc_a).toMatchObject({ value: 10 });
      expect(config.residues['55N'].dw_ab?.value).toBe(-6.5);
      expect(config.residues['43N'].dw_ab?.value).toBe(12.5);
      expect(Object.keys(config.residues)).toHaveLength(16);
    });

    it(`${name}: matches the checked-in emitted golden file`, async () => {
      await expect(configToToml(tomlToConfig(text).config)).toMatchFileSnapshot(`${EMITTED_DIR}/${name}`);
    });
  }
});
