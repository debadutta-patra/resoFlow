import { describe, it, expect } from 'vitest';
import { isResidueExcluded, isParameterExcluded, filterCorrelations } from './residueExclusion';

describe('residueExclusion', () => {
  describe('isResidueExcluded', () => {
    it('returns false when excluded list is empty or undefined', () => {
      expect(isResidueExcluded('10PHE', [])).toBe(false);
      expect(isResidueExcluded('10PHE', undefined)).toBe(false);
      expect(isResidueExcluded(undefined, ['10PHE'])).toBe(false);
    });

    it('matches exact residue strings case-insensitively', () => {
      expect(isResidueExcluded('10PHE', ['10PHE'])).toBe(true);
      expect(isResidueExcluded('10phe', ['10PHE'])).toBe(true);
      expect(isResidueExcluded('10PHE', ['10phe'])).toBe(true);
      expect(isResidueExcluded('11ASN', ['10PHE'])).toBe(false);
    });

    it('matches numeric residue with assignment and vice versa', () => {
      expect(isResidueExcluded('10PHE', ['10'])).toBe(true);
      expect(isResidueExcluded(10, ['10PHE'])).toBe(true);
      expect(isResidueExcluded('10', ['10PHE'])).toBe(true);
      expect(isResidueExcluded('100PHE', ['10'])).toBe(false);
      expect(isResidueExcluded('10PHE', ['10TYR'])).toBe(false);
    });
  });

  describe('isParameterExcluded', () => {
    it('does not exclude global parameters', () => {
      expect(isParameterExcluded('[KEX_AB]', ['10PHE'])).toBe(false);
      expect(isParameterExcluded('PB', ['10PHE'])).toBe(false);
    });

    it('excludes relaxation parameters with NUC-> assignment', () => {
      expect(isParameterExcluded('[R2, NUC->10PHE]', ['10PHE'])).toBe(true);
      expect(isParameterExcluded('R2, NUC->10PHE', ['10'])).toBe(true);
      expect(isParameterExcluded('[I0, NUC->10PHE]', ['10PHE'])).toBe(true);
      expect(isParameterExcluded('[R2, NUC->11ASN]', ['10PHE'])).toBe(false);
    });

    it('excludes dispersion parameters with NUC-> assignment', () => {
      expect(isParameterExcluded('[DW_AB, NUC->15N]', ['15N'])).toBe(true);
      expect(isParameterExcluded('[R2_A, NUC->15N, B0->600MHZ]', ['15N'])).toBe(true);
      expect(isParameterExcluded('[DW_AB, NUC->16N]', ['15N'])).toBe(false);
    });
  });

  describe('filterCorrelations', () => {
    it('removes excluded rows and columns from correlation matrix', () => {
      const corr = {
        parameters: ['[KEX_AB]', '[R2, NUC->10PHE]', '[R2, NUC->11ASN]'],
        matrix: [
          [1.0, 0.2, 0.3],
          [0.2, 1.0, 0.4],
          [0.3, 0.4, 1.0],
        ],
      };

      const filtered = filterCorrelations(corr, ['10PHE']);
      expect(filtered).toBeDefined();
      expect(filtered!.parameters).toEqual(['[KEX_AB]', '[R2, NUC->11ASN]']);
      expect(filtered!.matrix).toEqual([
        [1.0, 0.3],
        [0.3, 1.0],
      ]);
    });
  });
});

describe('exclusions from legacy parameter files reach the results-side filter', () => {
  it('a commented residue in an old resoFlow parameters.toml is excluded via excludedResidues, not via the comment', async () => {
    const { parseWithLegacyExclusions, tomlToConfig } = await import('./parameterToml');
    const legacy = '# Auto-generated ChemEx parameter file\n[CS_A]\n# 13N = 118.5\n14N = 120.1\n';
    const { config } = parseWithLegacyExclusions(tomlToConfig, legacy, 'auto');
    expect(isResidueExcluded('13N', config.excludedResidues)).toBe(true);
    expect(isResidueExcluded('14N', config.excludedResidues)).toBe(false);
    // Without the migration a comment carries no exclusion.
    expect(tomlToConfig(legacy).config.excludedResidues).toBeUndefined();
  });
});
