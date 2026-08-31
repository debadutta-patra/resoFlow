import { describe, it, expect } from 'vitest';
import { formatUncertainty, formatAsymmetricInterval } from './uncertaintyFormatter';

describe('formatUncertainty', () => {
  it('formats prompt Example 1: 113.6240 / 0.0091 -> 113.624 ± 0.009', () => {
    const res = formatUncertainty(113.6240, 0.0091);
    expect(res.formatted).toBe('113.624 ± 0.009');
    expect(res.valueStr).toBe('113.624');
    expect(res.errorStr).toBe('0.009');
  });

  it('formats prompt Example 2: 448.6400 / 16.5438 -> 448.6 ± 16.5', () => {
    const res = formatUncertainty(448.6400, 16.5438);
    expect(res.formatted).toBe('448.6 ± 16.5');
    expect(res.valueStr).toBe('448.6');
    expect(res.errorStr).toBe('16.5');
  });

  it('formats prompt Example 3 with grouped scientific notation: 0.0036 / 6.3330e-5 -> (3.60 ± 0.06) × 10⁻³', () => {
    const res = formatUncertainty(0.0036, 6.3330e-5);
    expect(res.formatted).toBe('(3.60 ± 0.06) × 10⁻³');
  });

  it('formats chemical shifts with decimal uncertainties (e.g. cs_a / dw_ab)', () => {
    const res1 = formatUncertainty(3.75695, 0.041419, { unit: 'ppm', forceSign: true });
    expect(res1.formatted).toBe('+3.76 ± 0.04 ppm');

    const res2 = formatUncertainty(-3.80635, 0.045513, { unit: 'ppm', forceSign: true });
    expect(res2.formatted).toBe('-3.81 ± 0.05 ppm');
  });

  it('formats percentage values with propagated errors (e.g. p_b)', () => {
    const res = formatUncertainty(0.0045429, 0.00009711, { isPercent: true });
    expect(res.formatted).toBe('0.454 ± 0.010 %');
  });

  it('formats excited-state lifetime tau_b in milliseconds', () => {
    const res = formatUncertainty(2.16317, 0.09989, { unit: 'ms', isDerived: true });
    expect(res.formatted).toBe('2.16 ± 0.10 ms');
    expect(res.isDerived).toBe(true);
  });

  it('formats asymmetric intervals correctly', () => {
    const res = formatAsymmetricInterval(448.64, 15.4, 18.2, { unit: 's⁻¹' });
    expect(res.formatted).toBe('448.6 +18.2 / -15.4 s⁻¹');
    expect(res.isAsymmetric).toBe(true);
  });

  it('handles absent or withheld error gracefully', () => {
    const res = formatUncertainty(464.396, null, { unit: 's⁻¹' });
    expect(res.formatted).toBe('464.4 s⁻¹');
    expect(res.errorStr).toBeUndefined();
  });

  it('handles null/undefined value with em-dash', () => {
    const res = formatUncertainty(null, null);
    expect(res.formatted).toBe('—');
  });
});
