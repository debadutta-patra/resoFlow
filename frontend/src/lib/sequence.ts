/**
 * Protein sequence helpers for residue labels: parse a FASTA record or a one-letter
 * string, and look up the residue type at an assignment number given the project's
 * numbering offset (residue number of letter i, 0-based, is i + 1 + offset).
 */

import { SpinSystemKey } from './spinSystem';
import type { ResidueItem } from './residueSelection';

const AA = /^[ACDEFGHIKLMNPQRSTVWYXBZUO]+$/;

export interface ParsedSequence {
  sequence: string;
  error: string | null;
}

/** Accepts FASTA (header lines starting with ">" or ";" are ignored) or a plain one-letter string. */
export function parseSequenceInput(text: string): ParsedSequence {
  const body = (text || '')
    .split(/\r?\n/)
    .filter(line => !/^\s*[>;]/.test(line))
    .join('')
    .replace(/[\s\d*]/g, '')
    .toUpperCase();
  if (!body) return { sequence: '', error: 'No sequence found.' };
  if (!AA.test(body)) {
    const bad = Array.from(new Set(body.replace(/[ACDEFGHIKLMNPQRSTVWYXBZUO]/g, ''))).join(' ');
    return { sequence: '', error: `Not a one-letter amino-acid sequence (unexpected: ${bad}).` };
  }
  return { sequence: body, error: null };
}

/** One-letter type at residue number `resNum`, or null when outside the sequence. */
export function residueTypeAt(sequence: string, offset: number, resNum: number): string | null {
  const i = resNum - 1 - offset;
  if (!sequence || !Number.isInteger(i) || i < 0 || i >= sequence.length) return null;
  const aa = sequence[i];
  return aa === 'X' ? null : aa;
}

/** Residue number range the sequence covers with this offset. */
export function sequenceRange(sequence: string, offset: number): [number, number] | null {
  return sequence ? [1 + offset, sequence.length + offset] : null;
}

/** True when the item's id or label already names its residue type (e.g. "G14N", "SER13N"). */
export function itemHasType(item: ResidueItem): boolean {
  return !!(SpinSystemKey.parse(item.label || item.id).symbol || SpinSystemKey.parse(item.id).symbol);
}

/**
 * Give items without a residue type a label carrying it from the sequence ("14N" → "G14N").
 * Items whose assignment already names a type are left alone (the assignment wins).
 */
export function labelWithSequence(items: ResidueItem[], sequence: string | null | undefined, offset = 0): ResidueItem[] {
  if (!sequence) return items;
  return items.map(item => {
    if (itemHasType(item)) return item;
    const key = SpinSystemKey.parse(item.id);
    const aa = residueTypeAt(sequence, offset, key.resNum || item.number);
    if (!aa) return item;
    return { ...item, label: `${aa}${item.id}` };
  });
}
