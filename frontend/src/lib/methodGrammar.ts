/**
 * Instant-feedback mirror of ChemEx v2 selector and constraint grammar
 * (chemex/configuration/method_expressions.py). ChemEx remains authoritative:
 * the resolve endpoint reports its own errors; this only catches mistakes as
 * the user types.
 *
 * Selector:   NAME[, QUAL->value]...   QUAL ∈ NUC, T, B0, [P], [L], D2O (each once)
 *   NUC->spin   T->num[C]   B0->num[MHz] (≥0)   [P]/[L]->num[M] (≥0)   D2O->num (0 < x < 1)
 * Constraint: [selector] = expr   expr uses finite numbers, [selector] references,
 *   parentheses, + - * / and unary ±.
 */

export const QUALIFIER_KEYS = ['NUC', 'T', 'B0', '[P]', '[L]', 'D2O'] as const;
export type QualifierKey = (typeof QUALIFIER_KEYS)[number];

export const QUALIFIER_HELP: Record<QualifierKey, string> = {
  NUC: 'Spin system / residue, e.g. G24N-H, 26N or N',
  T: 'Temperature in °C, e.g. 25C',
  B0: '¹H Larmor frequency in MHz, e.g. 800.13MHz',
  '[P]': 'Total protein concentration in M',
  '[L]': 'Total ligand concentration in M',
  D2O: 'D₂O fraction, between 0 and 1',
};

export interface Qualifier {
  key: QualifierKey;
  value: string;
}

export interface ParsedSelector {
  name: string;
  qualifiers: Qualifier[];
}

/** A grammar problem with its character span inside the parsed text. */
export interface GrammarError {
  message: string;
  start: number;
  end: number;
  /** Replacement for text[start, end) that fixes the error, when obvious (e.g. "[R2_A]"). */
  suggestion?: string;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NUMBER = '[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?';
const NUMERIC: Record<Exclude<QualifierKey, 'NUC'>, RegExp> = {
  T: new RegExp(`^(${NUMBER})(C)?$`, 'i'),
  B0: new RegExp(`^(${NUMBER})(MHz)?$`, 'i'),
  '[P]': new RegExp(`^(${NUMBER})(M)?$`, 'i'),
  '[L]': new RegExp(`^(${NUMBER})(M)?$`, 'i'),
  D2O: new RegExp(`^(${NUMBER})$`, 'i'),
};
const QUALIFIER = /^(NUC|T|B0|\[P\]|\[L\]|D2O)\s*->\s*(.+)$/i;
const SPIN = /^[A-Za-z0-9+]+(?:-[A-Za-z0-9+]+)*$/;

function qualifierValueError(key: QualifierKey, value: string): string | null {
  if (key === 'NUC') return SPIN.test(value) ? null : `Invalid NUC spin-system selector "${value}"`;
  const m = NUMERIC[key].exec(value);
  if (!m) return `Invalid value or unit for selector qualifier ${key}`;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return `Selector qualifier ${key} must be finite`;
  if ((key === 'B0' || key === '[P]' || key === '[L]') && n < 0) return `Selector qualifier ${key} must be nonnegative`;
  if (key === 'D2O' && !(n > 0 && n < 1)) return 'Selector qualifier D2O must be between 0 and 1';
  return null;
}

/** Parse a selector; rejects empty, unknown, malformed, duplicated and trailing fragments like ChemEx. */
export function parseSelector(text: string): { selector?: ParsedSelector; error?: GrammarError } {
  const stripped = text.trim();
  const lead = text.length - text.trimStart().length;
  if (!stripped) return { error: { message: 'Parameter selector cannot be empty', start: 0, end: text.length } };
  const fragments = stripped.split(',');
  const name = fragments[0].trim();
  if (!NAME.test(name)) {
    return { error: { message: `Invalid parameter-name token "${name}"`, start: lead, end: lead + fragments[0].length } };
  }
  const qualifiers: Qualifier[] = [];
  const seen = new Set<string>();
  let cursor = lead + fragments[0].length;
  for (const raw of fragments.slice(1)) {
    const start = cursor + 1 + (raw.length - raw.trimStart().length);
    const frag = raw.trim();
    const end = start + frag.length;
    cursor += raw.length + 1;
    if (!frag) return { error: { message: 'Empty selector qualifier', start: cursor - raw.length, end: cursor } };
    const m = QUALIFIER.exec(frag);
    if (!m) return { error: { message: `Unknown or malformed selector qualifier "${frag}"`, start, end } };
    const key = m[1].toUpperCase() as QualifierKey;
    if (seen.has(key)) return { error: { message: `Duplicate selector qualifier ${key}`, start, end } };
    seen.add(key);
    const value = m[2].trim();
    const err = qualifierValueError(key, value);
    if (err) return { error: { message: err, start, end } };
    qualifiers.push({ key, value });
  }
  return { selector: { name: name.toUpperCase(), qualifiers } };
}

export function formatSelector(sel: ParsedSelector): string {
  return [sel.name.toUpperCase(), ...sel.qualifiers.map(q => `${q.key}->${q.value}`)].join(', ');
}

/** Upper-case parameter name of a selector, or null when it is not even name-shaped. */
export function selectorName(text: string): string | null {
  const name = text.split(',')[0].trim();
  return NAME.test(name) ? name.toUpperCase() : null;
}

// ── Constraints ─────────────────────────────────────────────────────────

export interface ParsedReference {
  /** Selector text between the brackets. */
  text: string;
  /** Span of the whole "[…]" in the constraint string. */
  start: number;
  end: number;
}

export interface ParsedConstraint {
  target: ParsedSelector;
  targetText: string;
  rhs: string;
  references: ParsedReference[];
}

type Token = { kind: 'num' | 'ref' | 'op'; text: string; start: number; end: number };

function tokenizeRhs(rhs: string, offset: number): { tokens: Token[]; refs: ParsedReference[]; error?: GrammarError } {
  const tokens: Token[] = [];
  const refs: ParsedReference[] = [];
  let i = 0;
  while (i < rhs.length) {
    const c = rhs[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '[') {
      const close = rhs.indexOf(']', i + 1);
      if (close === -1) return { tokens, refs, error: { message: 'Unclosed parameter selector', start: offset + i, end: offset + rhs.length } };
      // ChemEx allows nested [P]/[L] qualifiers inside a reference: balance brackets.
      let depth = 1;
      let j = i + 1;
      while (j < rhs.length && depth) {
        if (rhs[j] === '[') depth++;
        else if (rhs[j] === ']') depth--;
        j++;
      }
      if (depth) return { tokens, refs, error: { message: 'Unclosed parameter selector', start: offset + i, end: offset + rhs.length } };
      const text = rhs.slice(i + 1, j - 1);
      tokens.push({ kind: 'ref', text, start: offset + i, end: offset + j });
      refs.push({ text, start: offset + i, end: offset + j });
      i = j;
      continue;
    }
    if ('+-*/()'.includes(c)) {
      if (c === '*' && rhs[i + 1] === '*') return { tokens, refs, error: { message: "Constraint contains unsupported token '**'", start: offset + i, end: offset + i + 2 } };
      tokens.push({ kind: 'op', text: c, start: offset + i, end: offset + i + 1 });
      i++;
      continue;
    }
    // Numbers (unsigned here; signs are unary operators).
    const unsigned = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/.exec(rhs.slice(i));
    if (unsigned) {
      const text = unsigned[0];
      const next = rhs[i + text.length];
      if (next !== undefined && /[A-Za-z_]/.test(next)) {
        return { tokens, refs, error: { message: `Constraint contains unsupported token '${text}${next}'`, start: offset + i, end: offset + i + text.length + 1 } };
      }
      if (!Number.isFinite(Number(text))) return { tokens, refs, error: { message: 'Constraint numbers must be finite', start: offset + i, end: offset + i + text.length } };
      tokens.push({ kind: 'num', text, start: offset + i, end: offset + i + text.length });
      i += text.length;
      continue;
    }
    const word = /^[^\s[\]+\-*/()]+/.exec(rhs.slice(i))?.[0] ?? c;
    const span = { start: offset + i, end: offset + i + word.length };
    if (NAME.test(word) && rhs[i + word.length] !== '(') {
      // A bare parameter name: ChemEx only accepts bracketed references.
      return { tokens, refs, error: { message: `Parameter references go in brackets: write [${word}] instead of ${word}`, ...span, suggestion: `[${word}]` } };
    }
    return { tokens, refs, error: { message: `Constraint contains unsupported token '${word}'`, ...span } };
  }
  return { tokens, refs };
}

/** Recursive descent over the token list: expr := term (± term)*; term := unary (*|/ unary)*; unary := ±unary | atom. */
function checkExpression(tokens: Token[], endPos: number): GrammarError | null {
  let i = 0;
  const fail = (message: string): GrammarError => {
    const t = tokens[i];
    return t ? { message, start: t.start, end: t.end } : { message, start: endPos, end: endPos };
  };
  const atom = (): GrammarError | null => {
    const t = tokens[i];
    if (!t) return fail('Constraint is not a valid scalar expression: expression ends early');
    if (t.kind === 'num' || t.kind === 'ref') {
      i++;
      return null;
    }
    if (t.text === '(') {
      i++;
      const err = expr();
      if (err) return err;
      if (tokens[i]?.text !== ')') return fail("Constraint is not a valid scalar expression: missing ')'");
      i++;
      return null;
    }
    return fail(`Constraint is not a valid scalar expression: unexpected '${t.text}'`);
  };
  const unary = (): GrammarError | null => {
    while (tokens[i]?.text === '+' || tokens[i]?.text === '-') i++;
    return atom();
  };
  const term = (): GrammarError | null => {
    let err = unary();
    while (!err && (tokens[i]?.text === '*' || tokens[i]?.text === '/')) {
      i++;
      err = unary();
    }
    return err;
  };
  const expr = (): GrammarError | null => {
    let err = term();
    while (!err && (tokens[i]?.text === '+' || tokens[i]?.text === '-')) {
      i++;
      err = term();
    }
    return err;
  };
  const err = expr();
  if (err) return err;
  if (i < tokens.length) return fail(`Constraint is not a valid scalar expression: unexpected '${tokens[i].text}'`);
  return null;
}

/** Validate only a right-hand side (positions relative to `rhs`). */
export function checkConstraintRhs(rhs: string): { references: ParsedReference[]; error?: GrammarError } {
  if (!rhs.trim()) return { references: [], error: { message: 'Constraint right side cannot be empty', start: 0, end: rhs.length } };
  const { tokens, refs, error } = tokenizeRhs(rhs, 0);
  if (error) return { references: refs, error };
  for (const ref of refs) {
    const { error: selErr } = parseSelector(ref.text);
    if (selErr) return { references: refs, error: { message: selErr.message, start: ref.start + 1 + selErr.start, end: ref.start + 1 + selErr.end } };
  }
  const exprErr = checkExpression(tokens, rhs.length);
  return exprErr ? { references: refs, error: exprErr } : { references: refs };
}

/** Parse "[target] = expr" like ChemEx: exactly one "=", one bracketed target, a valid scalar expression. */
export function parseConstraint(text: string): { constraint?: ParsedConstraint; error?: GrammarError } {
  const eqCount = (text.match(/=/g) || []).length;
  if (eqCount !== 1) return { error: { message: "Constraint must contain exactly one '='", start: 0, end: text.length } };
  const eq = text.indexOf('=');
  const left = text.slice(0, eq);
  const rhs = text.slice(eq + 1);
  const lm = /^\s*\[(.*)\]\s*$/.exec(left);
  if (!lm || lm[1].includes(']') && !/\[[PL]\]/i.test(lm[1])) {
    return { error: { message: 'Constraint left side must be one bracketed selector', start: 0, end: left.length } };
  }
  const targetText = lm[1];
  const targetStart = left.indexOf('[') + 1;
  const { selector, error: tErr } = parseSelector(targetText);
  if (tErr || !selector) return { error: { message: tErr!.message, start: targetStart + tErr!.start, end: targetStart + tErr!.end } };
  const { references, error } = checkConstraintRhs(rhs);
  const shift = eq + 1;
  if (error) return { error: { message: error.message, start: shift + error.start, end: shift + error.end } };
  return {
    constraint: {
      target: selector,
      targetText,
      rhs: rhs.trim(),
      references: references.map(r => ({ ...r, start: r.start + shift, end: r.end + shift })),
    },
  };
}

/** Upper-case target parameter name of a constraint equation, or null. */
export function constraintTargetName(text: string): string | null {
  const m = /^\s*\[\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(text);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Structure-only parse for editors: keeps qualifiers whose value is still being
 * typed (e.g. "NUC->"). Returns null when a fragment is not "KEY->…" at all, i.e.
 * the text can only be edited raw. Use `parseSelector` for validity.
 */
export function lenientSelector(text: string): ParsedSelector | null {
  const fragments = text.split(',');
  const name = fragments[0].trim();
  if (name && !NAME.test(name)) return null;
  const qualifiers: Qualifier[] = [];
  const seen = new Set<string>();
  for (const raw of fragments.slice(1)) {
    const m = /^\s*(NUC|T|B0|\[P\]|\[L\]|D2O)\s*->\s*(.*?)\s*$/i.exec(raw);
    if (!m) return null;
    const key = m[1].toUpperCase() as QualifierKey;
    if (seen.has(key)) return null;
    seen.add(key);
    qualifiers.push({ key, value: m[2] });
  }
  return { name: name.toUpperCase(), qualifiers };
}
