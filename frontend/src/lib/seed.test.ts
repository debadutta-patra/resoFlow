import { describe, expect, it } from 'vitest';
import { MAX_SEED, isValidSeed, randomSeed, seedError, toSeed } from './seed';

describe('u64 seeds', () => {
  it('keeps 2^64 − 1 exactly', () => {
    expect(MAX_SEED.toString()).toBe('18446744073709551615');
    expect(isValidSeed('18446744073709551615')).toBe(true);
    expect(isValidSeed('18446744073709551616')).toBe(false);
    expect(toSeed(18446744073709551615n)).toBe('18446744073709551615');
  });

  it('migrates legacy numeric seeds and rejects non-integers', () => {
    expect(toSeed(597)).toBe('597');
    expect(toSeed('  0042 ')).toBe('42');
    expect(toSeed('')).toBeUndefined();
    expect(toSeed(undefined)).toBeUndefined();
    expect(seedError(toSeed(1.5))).toMatch(/integer/);
    expect(seedError(toSeed('-1'))).toMatch(/integer/);
    expect(seedError(undefined)).toBeNull();
    expect(seedError(undefined, true)).toMatch(/required/);
  });

  it('generates full-range valid seeds', () => {
    const seeds = Array.from({ length: 200 }, randomSeed);
    expect(seeds.every(isValidSeed)).toBe(true);
    // With 200 u64 draws, at least one exceeds 2^53 with overwhelming probability.
    expect(seeds.some(s => BigInt(s) > BigInt(Number.MAX_SAFE_INTEGER))).toBe(true);
  });
});
