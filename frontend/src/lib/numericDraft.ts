/** Parse a committed numeric draft: '' → undefined (unset), non-numeric → NaN (invalid). */
export function parseNumericDraft(draft: string): number | undefined {
  const t = draft.trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

/** Display text for a committed value ('' when unset). */
export const numericDraftOf = (v: number | undefined | null): string =>
  v === undefined || v === null || Number.isNaN(v) ? '' : String(v);
