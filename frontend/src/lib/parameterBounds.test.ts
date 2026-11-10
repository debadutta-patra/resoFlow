import { describe, expect, it } from 'vitest';
import { withBound, withValue, type ParamValue } from './parameterConfig';
import { defaultsLookupFromCatalog, effectiveBounds, fallbackDefaults, fmtDefault } from './chemexDefaults';

describe('withValue / withBound', () => {
  const pv: ParamValue = { value: 0.05, lower: 0, upper: 0.2, bruteStep: 0.01, source: { kind: 'manual' } };

  it('withValue keeps explicit bounds and brute step', () => {
    expect(withValue(pv, 0.1, { kind: 'pick', pickSetHash: 'h', at: 't' })).toEqual({
      value: 0.1,
      lower: 0,
      upper: 0.2,
      bruteStep: 0.01,
      source: { kind: 'pick', pickSetHash: 'h', at: 't' },
    });
    expect(withValue(undefined, 3, { kind: 'manual' })).toEqual({ value: 3, source: { kind: 'manual' } });
  });

  it('withBound sets and clears one side', () => {
    expect(withBound(pv, 'upper', 0.5, null)).toMatchObject({ lower: 0, upper: 0.5 });
    const cleared = withBound(pv, 'lower', undefined, null);
    expect(cleared).not.toHaveProperty('lower');
    expect(cleared?.upper).toBe(0.2);
  });

  it('withBound on an unset parameter takes the displayed value as the start', () => {
    expect(withBound(undefined, 'lower', -5, 2.5, 'now')).toEqual({ value: 2.5, lower: -5, source: { kind: 'manual', at: 'now' } });
    expect(withBound(undefined, 'lower', -5, null)).toBeUndefined();
    expect(withBound(undefined, 'lower', undefined, 2.5)).toBeUndefined();
  });
});

describe('chemexDefaults', () => {
  it('mirrors ChemEx 2026.9.2 defaults in the static table', () => {
    expect(fallbackDefaults('pb')).toMatchObject({ value: 0.05, lower: 0, upper: 1, vary: true });
    expect(fallbackDefaults('PC')).toMatchObject({ value: 0.02, lower: 0, upper: 1 });
    expect(fallbackDefaults('KEX_AC')).toMatchObject({ value: 200, lower: 0, upper: 1e6 });
    expect(fallbackDefaults('CS_A')).toMatchObject({ value: 0, lower: -100, upper: 300 });
    expect(fallbackDefaults('DW_AC')).toMatchObject({ value: 0, lower: -100, upper: 100, vary: true });
    expect(fallbackDefaults('R2_A')).toMatchObject({ value: 10, lower: 0, upper: 1000 });
    expect(fallbackDefaults('R2_B')?.derived).toBe(true);
    expect(fallbackDefaults('TREF')).toMatchObject({ value: 25, lower: null, upper: null, protected: true });
    expect(fallbackDefaults('DW1_AB')).toMatchObject({ lower: -1, upper: 1 });
    expect(fallbackDefaults('NOT_A_PARAM')).toBeUndefined();
  });

  it('prefers catalogue rows and falls back per name', () => {
    const lookup = defaultsLookupFromCatalog([{ name: 'PB', default_value: 0.02, lower: 0, upper: 1, default_role: 'fit' }]);
    expect(lookup('pb')).toMatchObject({ value: 0.02, vary: true });
    expect(lookup('KEX_AB')?.value).toBe(200);
  });

  it('computes effective bounds per side', () => {
    expect(effectiveBounds('PB', { upper: 0.3 })).toEqual({ lower: 0, upper: 0.3, custom: true });
    expect(effectiveBounds('PB', undefined)).toEqual({ lower: 0, upper: 1, custom: false });
  });

  it('formats compactly', () => {
    expect(fmtDefault(1e6)).toBe('1e6');
    expect(fmtDefault(-100)).toBe('-100');
    expect(fmtDefault(null)).toBe('—');
    expect(fmtDefault(-Infinity)).toBe('−∞');
  });
});
