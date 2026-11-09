/** Autocomplete for "[PARAM, QUAL->value]" references in a constraint right-hand side. */

import { catalogSuggestions, type ParameterCatalog } from './baselineRoles';
import { QUALIFIER_KEYS, selectorName } from './methodGrammar';

export interface Suggestion {
  label: string;
  hint?: string;
  /** Replacement for rhs[from, to). */
  insert: string;
  from: number;
  to: number;
}

/** Suggestions for the reference under the caret: parameter names, then qualifiers with known values. */
export function rhsSuggestions(rhs: string, caret: number, names: string[], catalog?: ParameterCatalog | null): Suggestion[] {
  const before = rhs.slice(0, caret);
  const open = before.lastIndexOf('[');
  if (open === -1 || before.lastIndexOf(']') > open) return [];
  // "[P]" / "[L]" qualifier keys are nested brackets: treat the outer reference as open.
  const inner = before.slice(open + 1);
  const outerOpen = /^[PL]$/i.test(inner) ? before.lastIndexOf('[', open - 1) : open;
  const ref = before.slice(outerOpen + 1);
  const closeAfter = rhs[caret] === ']' ? '' : ']';
  const comma = ref.lastIndexOf(',');
  if (comma === -1) {
    const prefix = ref.trim().toUpperCase();
    return names
      .filter(n => n.startsWith(prefix))
      .slice(0, 12)
      .map(n => ({ label: n, hint: catalog?.[n]?.scope, insert: `${n}${closeAfter}`, from: outerOpen + 1, to: caret }));
  }
  const name = selectorName(ref) ?? '';
  const frag = ref.slice(comma + 1).trimStart().toUpperCase();
  const used = new Set(
    ref
      .slice(0, comma)
      .split(',')
      .slice(1)
      .map(f => f.split('->')[0].trim().toUpperCase())
  );
  const out: Suggestion[] = [];
  for (const key of QUALIFIER_KEYS) {
    if (used.has(key)) continue;
    const values = catalogSuggestions(catalog, name, key);
    for (const v of values.length ? values : ['']) {
      const text = `${key}->${v}`;
      if (!text.toUpperCase().startsWith(frag)) continue;
      out.push({ label: text, insert: ` ${text}${v ? closeAfter : ''}`, from: outerOpen + 1 + comma + 1, to: caret });
      if (out.length >= 12) return out;
    }
  }
  return out;
}

