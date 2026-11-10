import { describe, it, expect } from 'vitest';
import { itemHasType, labelWithSequence, parseSequenceInput, residueTypeAt, sequenceRange } from './sequence';
import { residueChipLabel, residueMatches, type ResidueItem } from './residueSelection';

const item = (id: string, label = id): ResidueItem => ({ id, number: parseInt(id.replace(/\D/g, ''), 10), label, hasData: true });

describe('parseSequenceInput', () => {
  it('reads FASTA and plain strings, ignoring whitespace and numbering', () => {
    expect(parseSequenceInput('>sp|P1|TEST\nMKV LLA\n10 GHE').sequence).toBe('MKVLLAGHE');
    expect(parseSequenceInput('mkvl').sequence).toBe('MKVL');
  });
  it('rejects non amino-acid text', () => {
    expect(parseSequenceInput('MKV-LJ').error).toMatch(/unexpected: - J/);
    expect(parseSequenceInput('  ').error).toMatch(/No sequence/);
  });
});

describe('residue types from the sequence', () => {
  it('applies the numbering offset', () => {
    expect(residueTypeAt('MGSK', 0, 2)).toBe('G');
    expect(residueTypeAt('MGSK', 10, 12)).toBe('G');
    expect(residueTypeAt('MGSK', 0, 9)).toBeNull();
    expect(sequenceRange('MGSK', 10)).toEqual([11, 14]);
  });

  it('labels chips G14 once a sequence is present, and leaves typed assignments alone', () => {
    const seq = 'A'.repeat(13) + 'G';
    const out = labelWithSequence([item('14N'), item('S13N', 'SER13N')], seq, 0);
    expect(residueChipLabel(out[0])).toBe('G14N');
    expect(residueMatches(out[0], 'gly')).toBe(true);
    expect(out[1].label).toBe('SER13N');
    expect(itemHasType(item('14N'))).toBe(false);
    expect(itemHasType(out[0])).toBe(true);
  });

  it('is a no-op without a sequence', () => {
    const items = [item('14N')];
    expect(labelWithSequence(items, '', 0)).toBe(items);
  });
});
