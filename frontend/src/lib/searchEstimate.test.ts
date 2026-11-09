import { describe, expect, it } from 'vitest';
import { estimateStepSeconds, formatDuration } from './searchEstimate';

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
