import { describe, expect, it } from 'vitest';
import { estimateTaucNs, toCelsius, waterViscosity } from './taucEstimate';

describe('estimateTaucNs', () => {
  it('is ~1 ns per 2.6 kDa in water at 300 K', () => {
    expect(estimateTaucNs({ mwKDa: 26, temperatureC: 26.85 })).toBeCloseTo(10, 6);
  });

  it('scales with viscosity and inversely with temperature (through η_w(T)/T)', () => {
    const at25 = estimateTaucNs({ mwKDa: 15, temperatureC: 25 })!;
    const at10 = estimateTaucNs({ mwKDa: 15, temperatureC: 10 })!;
    expect(at10 / at25).toBeGreaterThan(1.4); // colder water is ~45% more viscous
    expect(estimateTaucNs({ mwKDa: 15, temperatureC: 25, viscosityRel: 2 })).toBeCloseTo(2 * at25, 6);
  });

  it('water viscosity matches reference values (mPa·s)', () => {
    expect(waterViscosity(298.15)).toBeCloseTo(0.89, 2);
    expect(waterViscosity(283.15)).toBeCloseTo(1.31, 1);
  });

  it('rejects non-physical inputs and converts K/°C', () => {
    expect(estimateTaucNs({ mwKDa: 0, temperatureC: 25 })).toBeNull();
    expect(estimateTaucNs({ mwKDa: 10, temperatureC: 25, viscosityRel: -1 })).toBeNull();
    expect(toCelsius(298.15)).toBeCloseTo(25);
    expect(toCelsius(30)).toBe(30);
    expect(toCelsius(undefined)).toBe(25);
  });
});
