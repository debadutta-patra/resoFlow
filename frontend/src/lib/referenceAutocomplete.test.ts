import { describe, expect, it } from 'vitest';
import { rhsSuggestions } from './referenceAutocomplete';
import { buildParameterCatalog } from './baselineRoles';

const catalog = buildParameterCatalog([
  { id: '1', name: 'R2_A', status: 'fit', spin: '26N', conditions: { h_larmor_frq: 800.1 } },
  { id: '2', name: 'R2_A', status: 'fit', spin: '3N', conditions: { h_larmor_frq: 800.1 } },
  { id: '3', name: 'R1_A', status: 'fit', spin: '3N' },
]);
const names = ['R1_A', 'R2_A', 'R2_B'];

const applyFirst = (rhs: string, caret = rhs.length) => {
  const s = rhsSuggestions(rhs, caret, names, catalog)[0];
  return rhs.slice(0, s.from) + s.insert + rhs.slice(s.to);
};

describe('constraint reference autocomplete', () => {
  it('suggests parameter names inside an open bracket and closes it', () => {
    expect(rhsSuggestions('0.5 * [R', 8, names, catalog).map(s => s.label)).toEqual(['R1_A', 'R2_A', 'R2_B']);
    expect(applyFirst('0.5 * [R2')).toBe('0.5 * [R2_A]');
  });

  it('suggests qualifiers with values from the loaded data after a comma', () => {
    const labels = rhsSuggestions('[R2_A, ', 7, names, catalog).map(s => s.label);
    expect(labels).toContain('NUC->3N');
    expect(labels).toContain('NUC->26N');
    expect(labels).toContain('B0->800.1MHz');
    expect(applyFirst('[R2_A, NUC->2')).toBe('[R2_A, NUC->26N]');
  });

  it('offers nothing outside a reference', () => {
    expect(rhsSuggestions('[R2_A] * 0.5', 12, names, catalog)).toEqual([]);
  });
});
