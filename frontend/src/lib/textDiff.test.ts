import { describe, expect, it } from 'vitest';
import { diffStats, lineDiff } from './textDiff';

describe('line diff', () => {
  it('marks added and removed lines around unchanged context', () => {
    const before = 'FORMAT_VERSION = 2\n\n[S]\nROLES = [{ FIT = ["PB"] }]\n';
    const after = 'FORMAT_VERSION = 2\n\n[S]\nROLES = [{ FIT = ["PB", "KEX_AB"] }]\nSTATISTICS = { MC = 100 }\n';
    const d = lineDiff(before, after);
    expect(d).toEqual([
      { op: ' ', text: 'FORMAT_VERSION = 2' },
      { op: ' ', text: '' },
      { op: ' ', text: '[S]' },
      { op: '-', text: 'ROLES = [{ FIT = ["PB"] }]' },
      { op: '+', text: 'ROLES = [{ FIT = ["PB", "KEX_AB"] }]' },
      { op: '+', text: 'STATISTICS = { MC = 100 }' },
    ]);
    expect(diffStats(d)).toEqual({ added: 2, removed: 1 });
  });
  it('reports identical texts as unchanged', () => {
    expect(diffStats(lineDiff('a\nb\n', 'a\nb\n'))).toEqual({ added: 0, removed: 0 });
  });
});
