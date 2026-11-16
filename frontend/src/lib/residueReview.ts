/**
 * Per-residue review state shared by the residue-browsing pages (Pick CEST, Inspect Dispersion).
 *
 * A residue's status is one of: unreviewed, accepted (picked), no excited state, excluded.
 * "Excluded" is not stored here: it is the parameter-config exclusion (commented out in the
 * ChemEx files), so the two can never disagree. Notes and flags are free annotations that are
 * persisted with the analysis config and copied into the report.
 *
 * Residue identity always goes through SpinSystemKey (never string comparison), so "G14N",
 * "14N" and "GLY14N" address the same row.
 */

import { SpinSystemKey } from './spinSystem';
import { residueTypeAt } from './sequence';

export type ReviewStatus = 'unreviewed' | 'accepted' | 'no_excited_state' | 'excluded';
export type StoredStatus = 'accepted' | 'no_excited_state';

export interface ReviewState {
  statuses: Record<string, StoredStatus>;
  notes: Record<string, string>;
  flags: Record<string, boolean>;
}

export const EMPTY_REVIEW: ReviewState = { statuses: {}, notes: {}, flags: {} };

/** Page keys under which each page keeps its own review in the analysis config. */
export type ReviewPage = 'pick_cest' | 'dispersion';
export type ReviewBook = Partial<Record<ReviewPage, ReviewState>>;

export function normalizeReviewBook(raw: unknown): ReviewBook {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: ReviewBook = {};
  for (const page of ['pick_cest', 'dispersion'] as ReviewPage[]) {
    if (r[page]) out[page] = normalizeReview(r[page]);
  }
  return out;
}

export const STATUS_LABELS: Record<ReviewStatus, string> = {
  unreviewed: 'Unreviewed',
  accepted: 'Accepted',
  no_excited_state: 'No excited state',
  excluded: 'Excluded',
};

/** Normalize anything loaded from a saved config into a well-formed ReviewState. */
export function normalizeReview(raw: unknown): ReviewState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<ReviewState>;
  const statuses: Record<string, StoredStatus> = {};
  for (const [k, v] of Object.entries(r.statuses || {})) {
    if (v === 'accepted' || v === 'no_excited_state') statuses[k] = v;
  }
  const notes: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.notes || {})) {
    if (typeof v === 'string' && v.trim()) notes[k] = v;
  }
  const flags: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(r.flags || {})) {
    if (v === true) flags[k] = true;
  }
  return { statuses, notes, flags };
}

/** Find the key in `record` addressing the same residue as `id` (SpinSystemKey match). */
export function findKey<T>(record: Record<string, T>, id: string): string | undefined {
  if (id in record) return id;
  const target = SpinSystemKey.parse(id);
  return Object.keys(record).find(k => sameResidue(SpinSystemKey.parse(k), target));
}

function sameResidue(a: SpinSystemKey, b: SpinSystemKey): boolean {
  if (!a.matches(b)) return false;
  if (a.spins.length && b.spins.length) return a.spins[0] === b.spins[0];
  return true;
}

function lookup<T>(record: Record<string, T>, id: string): T | undefined {
  const k = findKey(record, id);
  return k === undefined ? undefined : record[k];
}

/** Effective status: exclusion wins over a stored status. */
export function statusOf(review: ReviewState, id: string, excluded: boolean): ReviewStatus {
  if (excluded) return 'excluded';
  return lookup(review.statuses, id) ?? 'unreviewed';
}

function withEntry<T>(record: Record<string, T>, id: string, value: T | undefined): Record<string, T> {
  const next = { ...record };
  const k = findKey(next, id);
  if (k !== undefined) delete next[k];
  if (value !== undefined) next[id] = value;
  return next;
}

export function setStatus(review: ReviewState, id: string, status: StoredStatus | undefined): ReviewState {
  return { ...review, statuses: withEntry(review.statuses, id, status) };
}

export function setNote(review: ReviewState, id: string, note: string): ReviewState {
  return { ...review, notes: withEntry(review.notes, id, note.trim() ? note : undefined) };
}

export function toggleFlag(review: ReviewState, id: string): ReviewState {
  const on = !!lookup(review.flags, id);
  return { ...review, flags: withEntry(review.flags, id, on ? undefined : true) };
}

export const noteOf = (review: ReviewState, id: string): string => lookup(review.notes, id) ?? '';
export const isFlagged = (review: ReviewState, id: string): boolean => !!lookup(review.flags, id);

/** "14 / 82 reviewed": every status but unreviewed counts as reviewed. */
export function reviewProgress(ids: string[], status: (id: string) => ReviewStatus): { reviewed: number; total: number } {
  let reviewed = 0;
  for (const id of ids) if (status(id) !== 'unreviewed') reviewed++;
  return { reviewed, total: ids.length };
}

// ── Rows, with numbering gaps ────────────────────────────────────────────

export interface BrowserResidue {
  id: string;
  label?: string;
}

export interface BrowserRow {
  id: string;
  label: string;
  resNum: number;
  /** False for a gap row: a residue number with no profile in this dataset. */
  present: boolean;
  /** Why a gap row has no data ("proline", "unassigned", "no data"). */
  gapReason?: string;
}

export interface GapContext {
  /** One-letter protein sequence and its numbering offset (see lib/sequence). */
  sequence?: string;
  offset?: number;
  /** Known reasons per residue number, e.g. { 22: 'unassigned' }; they win over the sequence. */
  reasons?: Record<number, string>;
}

/** Reason a residue number has no data: known reason, proline from the sequence, else "no data". */
export function gapReason(resNum: number, ctx: GapContext = {}): string {
  const known = ctx.reasons?.[resNum];
  if (known) return known;
  if (ctx.sequence && residueTypeAt(ctx.sequence, ctx.offset ?? 0, resNum) === 'P') return 'proline';
  return 'no data';
}

/**
 * Rows sorted by residue number, with a greyed gap row for each missing number between the
 * first and last residue present.
 */
export function buildBrowserRows(residues: BrowserResidue[], ctx: GapContext = {}): BrowserRow[] {
  const present = residues
    .map(r => ({ id: r.id, label: r.label || r.id, resNum: SpinSystemKey.parse(r.id).resNum, present: true }))
    .sort((a, b) => a.resNum - b.resNum || a.id.localeCompare(b.id));
  const numbered = present.filter(r => r.resNum > 0);
  if (numbered.length < 2) return present;
  const have = new Set(numbered.map(r => r.resNum));
  const out: BrowserRow[] = [];
  const unnumbered = present.filter(r => r.resNum <= 0);
  let prev: number | null = null;
  for (const row of numbered) {
    if (prev !== null) {
      for (let n = prev + 1; n < row.resNum; n++) {
        if (!have.has(n)) {
          const aa = ctx.sequence ? residueTypeAt(ctx.sequence, ctx.offset ?? 0, n) : null;
          out.push({ id: `gap:${n}`, label: `${aa ?? ''}${n}`, resNum: n, present: false, gapReason: gapReason(n, ctx) });
        }
      }
    }
    out.push(row);
    prev = row.resNum;
  }
  return [...out, ...unnumbered];
}

/** Row id addressed by a `?res=` query value, or undefined. */
export function rowForParam(rows: BrowserRow[], param: string | null | undefined): string | undefined {
  if (!param) return undefined;
  const present = rows.filter(r => r.present);
  const exact = present.find(r => r.id === param);
  if (exact) return exact.id;
  const target = SpinSystemKey.parse(param);
  if (!target.resNum) return undefined;
  return present.find(r => sameResidue(SpinSystemKey.parse(r.id), target))?.id;
}

/** Previous/next present row from `id` (gap rows are skipped); stays put at the ends. */
export function stepRow(rows: BrowserRow[], id: string | null, delta: 1 | -1): string | null {
  const ids = rows.filter(r => r.present).map(r => r.id);
  if (ids.length === 0) return null;
  const i = id ? ids.indexOf(id) : -1;
  if (i === -1) return ids[0];
  return ids[Math.min(ids.length - 1, Math.max(0, i + delta))];
}

// ── Keyboard shortcuts ───────────────────────────────────────────────────

export type ShortcutAction = 'prev' | 'next' | 'accept' | 'exclude' | 'no_excited' | 'arm_a' | 'arm_b' | 'undo';

export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  target?: EventTarget | null;
}

/** True when keystrokes belong to a text field (shortcuts must not fire). */
export function isTypingTarget(target: EventTarget | null | undefined): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el !== 'object') return false;
  const tag = (el.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
    return !['checkbox', 'radio', 'button', 'submit', 'range'].includes(type);
  }
  return !!el.isContentEditable;
}

export function shortcutFor(e: KeyLike, opts: { armKeys?: boolean } = {}): ShortcutAction | null {
  if (isTypingTarget(e.target)) return null;
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'z') return 'undo';
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  switch (e.key) {
    case 'ArrowLeft': return 'prev';
    case 'ArrowRight': return 'next';
    case 'Enter': return 'accept';
  }
  switch (e.key.toLowerCase()) {
    case 'x': return 'exclude';
    case 'n': return 'no_excited';
    case 'a': return opts.armKeys ? 'arm_a' : null;
    case 'b': return opts.armKeys ? 'arm_b' : null;
  }
  return null;
}

export interface ShortcutHelp {
  keys: string;
  action: string;
}

export function shortcutHelp(armKeys: boolean): ShortcutHelp[] {
  return [
    { keys: '← / →', action: 'Previous / next residue' },
    { keys: 'Enter', action: 'Accept and go to next' },
    { keys: 'X', action: 'Exclude / include residue' },
    { keys: 'N', action: 'Mark no excited state' },
    ...(armKeys ? [{ keys: 'A / B', action: 'Arm CS_A / CS_B picking' }] : []),
    { keys: 'Ctrl+Z', action: 'Undo last action' },
  ];
}

// ── Undo stack ───────────────────────────────────────────────────────────

export interface UndoEntry {
  label: string;
  undo: () => void;
}

export const UNDO_LIMIT = 50;

export function pushUndo(stack: UndoEntry[], entry: UndoEntry, limit = UNDO_LIMIT): UndoEntry[] {
  const next = [...stack, entry];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

// ── Export (CSV + TOML) ──────────────────────────────────────────────────

export interface ExportResidue {
  residue: string;
  status: ReviewStatus;
  flagged: boolean;
  note: string;
  /** Page-specific values (picks, Rex, ...), keyed by column name. */
  values: Record<string, number | string | null | undefined>;
}

export interface ExportMask {
  experiment: string;
  plane: number;
  offset_ppm?: number | null;
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * One CSV with a `kind` column: `residue` rows (status, flag, note, page values) followed by
 * `mask` rows (experiment, plane, offset). Columns not used by a row are left empty.
 */
export function reviewToCsv(rows: ExportResidue[], columns: string[], masks: ExportMask[] = []): string {
  const header = ['kind', 'residue', 'status', 'flagged', 'note', ...columns, 'experiment', 'plane', 'offset_ppm'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      'residue', r.residue, r.status, r.flagged ? 'true' : 'false', r.note,
      ...columns.map(c => r.values[c]), '', '', '',
    ].map(csvCell).join(','));
  }
  for (const m of masks) {
    lines.push(['mask', '', '', '', '', ...columns.map(() => ''), m.experiment, m.plane, m.offset_ppm ?? ''].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}

function tomlString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
}

function tomlValue(v: number | string): string {
  return typeof v === 'number' ? String(v) : tomlString(v);
}

export function reviewToToml(
  rows: ExportResidue[],
  masks: ExportMask[] = [],
  meta: Record<string, string> = {},
): string {
  const out: string[] = ['# resoFlow residue review export'];
  for (const [k, v] of Object.entries(meta)) out.push(`${k} = ${tomlString(v)}`);
  for (const r of rows) {
    out.push('', `[residues.${tomlString(r.residue)}]`, `status = ${tomlString(r.status)}`, `flagged = ${r.flagged}`);
    if (r.note) out.push(`note = ${tomlString(r.note)}`);
    for (const [k, v] of Object.entries(r.values)) {
      if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) continue;
      out.push(`${k} = ${tomlValue(v)}`);
    }
  }
  for (const m of masks) {
    out.push('', '[[masks]]', `experiment = ${tomlString(m.experiment)}`, `plane = ${m.plane}`);
    if (m.offset_ppm != null && Number.isFinite(m.offset_ppm)) out.push(`offset_ppm = ${m.offset_ppm}`);
  }
  return out.join('\n') + '\n';
}
