/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { activeCestSeeder, candidatesAbove, registerCestSeeder } from './cestSeeder';

describe('seeder interface', () => {
  beforeEach(() => {
    // Node's own localStorage global shadows jsdom's; use an in-memory store.
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });
  afterEach(() => {
    registerCestSeeder(null);
    vi.unstubAllGlobals();
  });

  it('is inactive unless registered and flagged', () => {
    const seeder = { name: 't', candidates: () => [] };
    registerCestSeeder(seeder);
    expect(activeCestSeeder()).toBeNull();
    localStorage.setItem('resoFlow_cest_seeder', '1');
    expect(activeCestSeeder()).toBe(seeder);
  });

  it('filters candidates by threshold, best first', () => {
    const c = [{ cs_ppm: 1, confidence: 0.4 }, { cs_ppm: 2, confidence: 0.9 }, { cs_ppm: 3, confidence: 0.7 }];
    expect(candidatesAbove(c, 0.5).map(x => x.cs_ppm)).toEqual([2, 3]);
  });
});
