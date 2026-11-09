import { describe, expect, it } from 'vitest';
import { estimateStatistics, estimateStepSeconds, formatDuration } from './searchEstimate';

const timings = [
  { name: 'GRID', seconds: 48, evaluations: 24 },
  { name: 'REFINE', seconds: 3, evaluations: 1 },
  { name: 'DE', seconds: 100, evaluations: null },
  { name: 'BROKEN', seconds: 999, evaluations: 1, incomplete: true },
];

describe('runtime estimates', () => {
  it('scales the same step’s time per fit', () => {
    expect(estimateStepSeconds(120, 'grid', timings)).toEqual({ seconds: 240, basedOn: 'GRID', secondsPerFit: 2, proxy: false });
  });
  it('falls back to the slowest completed step as a proxy; ignores DE and incomplete steps', () => {
    expect(estimateStepSeconds(10, 'NEW', timings)).toMatchObject({ seconds: 30, basedOn: 'REFINE', proxy: true });
  });
  it('returns null without usable timings', () => {
    expect(estimateStepSeconds(10, 'X', [])).toBeNull();
    expect(estimateStepSeconds(10, 'X', [{ name: 'DE', seconds: 5, evaluations: null }])).toBeNull();
  });
  it('formats durations', () => {
    expect(formatDuration(42)).toBe('42 s');
    expect(formatDuration(240)).toBe('4 min');
    expect(formatDuration(7200)).toBe('2.0 h');
  });
});

describe('statistics cost estimate', () => {
  const t = [
    { name: 'LOCAL', seconds: 120, fit_seconds: 6, evaluations: 1, mcmc_seconds: 100, mcmc_steps: 1000 },
    { name: 'OTHER', seconds: 4, evaluations: 1 },
  ];
  it('uses replicates × fit-only time ÷ workers, and scales MCMC from the last chain', () => {
    const e = estimateStatistics(
      { mc: { enabled: true, replicates: 100 }, bs: { enabled: true, replicates: 50 }, bsn: { enabled: false, replicates: 99 }, mcmc: { enabled: true, steps: 5000 } },
      'local',
      t,
      4
    );
    expect(e).toMatchObject({ refits: 150, resamplingSeconds: (150 * 6) / 4, mcmcSeconds: 500, workers: 4, basedOn: 'LOCAL', proxy: false });
  });
  it('reports counts only without timing; unknown workers count as 1', () => {
    expect(estimateStatistics({ mc: { enabled: true, replicates: 10 } }, 'X', [], null)).toMatchObject({ refits: 10, resamplingSeconds: null, mcmcSeconds: null });
    expect(estimateStatistics({ mc: { enabled: true, replicates: 10 } }, 'OTHER', t, null).resamplingSeconds).toBe(40);
  });
});
