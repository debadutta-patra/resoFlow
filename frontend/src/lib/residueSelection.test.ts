import { describe, expect, it } from 'vitest';
import { residueChipLabel, residueMatches, sortResidueItems, type ResidueItem } from './residueSelection';

const item = (id: string, label = id): ResidueItem => ({ id, label, number: parseInt(id.replace(/\D/g, ''), 10) || 0, hasData: true });

describe('residue chips', () => {
  it('sorts naturally by residue number, not as strings', () => {
    const ids = ['39N', '3N', '100N', '14N', '2N'];
    expect(sortResidueItems(ids.map(id => item(id))).map(r => r.id)).toEqual(['2N', '3N', '14N', '39N', '100N']);
  });

  it('orders multi-spin keys of one residue deterministically', () => {
    const out = sortResidueItems([item('L3CD2-HD2'), item('L3CD1-HD1'), item('G2N-HN')]).map(r => r.id);
    expect(out).toEqual(['G2N-HN', 'L3CD1-HD1', 'L3CD2-HD2']);
  });

  it('shows the residue type when the label knows it', () => {
    expect(residueChipLabel(item('14N', 'GLY14N'))).toBe('G14N');
    expect(residueChipLabel(item('14N', 'G14N-HN'))).toBe('G14N-HN');
    expect(residueChipLabel(item('13N'))).toBe('13N');
  });

  it('search matches number, residue type (1- and 3-letter) and full label', () => {
    const g14 = item('14N', 'GLY14N');
    expect(residueMatches(g14, '14')).toBe(true);
    expect(residueMatches(g14, 'g14')).toBe(true);
    expect(residueMatches(g14, 'gly')).toBe(true);
    expect(residueMatches(g14, 'GLY14')).toBe(true);
    expect(residueMatches(g14, 'ser')).toBe(false);
    expect(residueMatches(g14, '')).toBe(true);
  });
});
