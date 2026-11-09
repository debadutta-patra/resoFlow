/**
 * Pure helpers for the Methods-tab residue chips: natural ordering, labels that
 * carry the residue type when known, and search matching. All residue identity
 * goes through `SpinSystemKey` (never raw string comparison).
 */

import { AA_1TO3, SpinSystemKey } from './spinSystem';

export interface ResidueItem {
  id: string; // e.g. "13N", "S13N", "G2N-HN", "L3CD1-HD1"
  number: number; // e.g. 13
  label: string; // e.g. "SER13N", "S13N", "G2N-HN", "L3CD1-HD1"
  hasData: boolean;
  /**
   * A minor-state (B) shift was picked for this residue in the pick step (CEST dips).
   * Undefined when the experiment has no such picks (filter hidden).
   */
  hasMinorPick?: boolean;
}

/** The most informative parse of an item: the label usually carries the residue type, the id may not. */
function keyOf(item: ResidueItem): SpinSystemKey {
  const fromLabel = SpinSystemKey.parse(item.label || item.id);
  const fromId = SpinSystemKey.parse(item.id);
  if (fromLabel.resNum === fromId.resNum && (fromLabel.symbol || !fromId.symbol)) return fromLabel;
  return fromId;
}

/** Natural order: residue number, then residue type, then spin names ("3N" before "39N"). */
export function compareResidueItems(a: ResidueItem, b: ResidueItem): number {
  const ka = keyOf(a);
  const kb = keyOf(b);
  if (ka.resNum !== kb.resNum) return ka.resNum - kb.resNum;
  if (ka.symbol !== kb.symbol) return ka.symbol.localeCompare(kb.symbol);
  return ka.canonical.localeCompare(kb.canonical, undefined, { numeric: true });
}

export function sortResidueItems(items: ResidueItem[]): ResidueItem[] {
  return [...items].sort(compareResidueItems);
}

/** Chip text: canonical one-letter form with residue type when known (e.g. "G14N", "L3CD1-HD1"). */
export function residueChipLabel(item: ResidueItem): string {
  const key = keyOf(item);
  return key.resNum > 0 ? key.canonical : item.label || item.id;
}

/**
 * Case-insensitive search over id, label, canonical label, residue number and
 * residue type (one- or three-letter code), e.g. "14", "g14", "gly", "SER".
 */
export function residueMatches(item: ResidueItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const key = keyOf(item);
  const haystack = [item.id, item.label, key.canonical, String(key.resNum)];
  if (key.symbol) {
    haystack.push(`${key.symbol}${key.resNum}`);
    const three = AA_1TO3[key.symbol];
    if (three) haystack.push(three, `${three}${key.resNum}`);
  }
  return haystack.some(h => h.toLowerCase().includes(q));
}

type MinorPick = { cs_b?: number | null; cs_c?: number | null; cs_d?: number | null; cs_e?: number | null; cs_f?: number | null } | null | undefined;

/**
 * Whether a minor-state (B–F) shift was picked for `residue` in Pick CEST; undefined when
 * no residue has picks at all (the "picked dip" filter is then hidden).
 */
export function minorPickFlag(picks: Record<string, MinorPick> | null | undefined, residue: string): boolean | undefined {
  if (!picks || Object.keys(picks).length === 0) return undefined;
  const p = picks[residue];
  return !!p && [p.cs_b, p.cs_c, p.cs_d, p.cs_e, p.cs_f].some(v => typeof v === 'number' && Number.isFinite(v));
}
