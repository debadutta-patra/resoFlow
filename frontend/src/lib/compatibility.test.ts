import { describe, it, expect } from 'vitest';
import {
  evaluateRunCompatibility,
  isHighUncertainty,
  formatUncertainty,
  MAX_SAFE_RELATIVE_ERROR,
  CS_TOLERANCE_PPM,
} from './compatibility';

describe('Compatibility Rules', () => {
  const target = {
    analysis_type: '15N-CEST',
    model: '2st',
    nucleus: '15N',
    temperature: 298.15,
    static_field: 600.0,
  };

  it('allows fully matching CEST runs', () => {
    const res = evaluateRunCompatibility(
      {
        analysis_type: '15N-CEST',
        model: '2st',
        nucleus: '15N',
        temperature: 298.15,
        static_field: 600.0,
      },
      target
    );
    expect(res.isCompatible).toBe(true);
    expect(res.blockReasons).toHaveLength(0);
    expect(res.warningReasons).toHaveLength(0);
  });

  it('blocks on kinetic model mismatch (2-state vs 3-state)', () => {
    const res = evaluateRunCompatibility(
      {
        analysis_type: '15N-CEST',
        model: '3st',
        nucleus: '15N',
        temperature: 298.15,
        static_field: 600.0,
      },
      target
    );
    expect(res.isCompatible).toBe(false);
    expect(res.blockReasons.some(r => r.includes('kinetic model'))).toBe(true);
  });

  it('blocks on nucleus mismatch (15N vs 13C)', () => {
    const res = evaluateRunCompatibility(
      {
        analysis_type: '13C-CEST',
        model: '2st',
        nucleus: '13C',
        temperature: 298.15,
        static_field: 600.0,
      },
      target
    );
    expect(res.isCompatible).toBe(false);
    expect(res.blockReasons.some(r => r.includes('nucleus'))).toBe(true);
  });

  it('warns prominently on temperature mismatch (> 1.0 K)', () => {
    const res = evaluateRunCompatibility(
      {
        analysis_type: '15N-CEST',
        model: '2st',
        nucleus: '15N',
        temperature: 308.15,
        static_field: 600.0,
      },
      target
    );
    expect(res.isCompatible).toBe(true);
    expect(res.blockReasons).toHaveLength(0);
    expect(res.warningReasons).toHaveLength(1);
    expect(res.warningReasons[0]).toContain('temperature');
  });

  it('allows different static fields without warnings or blocks', () => {
    const res = evaluateRunCompatibility(
      {
        analysis_type: '15N-CEST',
        model: '2st',
        nucleus: '15N',
        temperature: 298.15,
        static_field: 800.0,
      },
      target
    );
    expect(res.isCompatible).toBe(true);
    expect(res.blockReasons).toHaveLength(0);
    expect(res.warningReasons).toHaveLength(0);
  });
});

describe('Uncertainty and Tolerance helpers', () => {
  it('correctly identifies relative uncertainty > 50%', () => {
    expect(isHighUncertainty(100, 51)).toBe(true); // 51% -> high
    expect(isHighUncertainty(100, 49)).toBe(false); // 49% -> safe
    expect(isHighUncertainty(100, 0)).toBe(false);
    expect(isHighUncertainty(100, null)).toBe(false);
  });

  it('formats uncertainties with standard precision', () => {
    expect(formatUncertainty(0.02556, 3)).toBe('±0.026');
    expect(formatUncertainty(5.33617, 2)).toBe('±5.34');
    expect(formatUncertainty(null)).toBe('');
  });

  it('has expected constant values', () => {
    expect(MAX_SAFE_RELATIVE_ERROR).toBe(0.50);
    expect(CS_TOLERANCE_PPM).toBe(0.01);
  });
});
