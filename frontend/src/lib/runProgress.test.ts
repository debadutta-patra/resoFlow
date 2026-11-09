import { describe, expect, it } from 'vitest';
import { lastCommittedText, liveRunText } from './runProgress';

describe('run header text', () => {
  it('labels the live fit with its method step', () => {
    expect(liveRunText({ kind: 'fit', iteration: 12, redchi: 1.234, step: { name: 'LOCAL_FITS', index: 2, total: 3 } })).toBe(
      'Running LOCAL_FITS (2/3) · iter 12 · red-χ² 1.23'
    );
    expect(liveRunText({ kind: 'fit', iteration: 3, redchi: 2, step: { name: '', index: 1, total: 1 } })).toBe('Running DEFAULT · iter 3 · red-χ² 2.00');
    expect(liveRunText({ kind: 'grid', stage: 'Grid Search', percent: 40, step: { name: 'GRID', index: 1, total: 2 } })).toBe(
      'Running GRID (1/2) · Grid Search 40%'
    );
    expect(liveRunText({ kind: 'fit', iteration: 1, redchi: 3 })).toBe('Running · iter 1 · red-χ² 3.00');
  });

  it('labels the last committed result separately', () => {
    expect(lastCommittedText({ stepName: 'STEP2', redchi: 1.1 })).toBe('Last committed: STEP2 · red-χ² 1.10');
    expect(lastCommittedText({ redchi: 0.98 })).toBe('Last committed: red-χ² 0.98');
    expect(lastCommittedText({})).toBeNull();
  });
});
