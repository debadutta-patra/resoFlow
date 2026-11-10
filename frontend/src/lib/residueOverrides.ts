/**
 * Per-residue overrides edited from the parameter table (Phase E4).
 *
 * The ordered ROLES rules stay the single source of truth: a residue's override is read
 * back from the rules ("DW_AB, NUC->23N" in a FIT/FIX rule, or a CONSTRAIN equation whose
 * target is "[DW_AB, NUC->23N]"), and setting one rewrites the rules: any existing
 * single-residue entry for that parameter/residue is removed (rules left empty are dropped)
 * and one new rule is appended (later rules win). Removing that rule in the rules list
 * therefore resets the toggle.
 */

import type { RoleAction, RoleRule, Step } from './methodConfig';
import { newMethodId } from './methodConfig';
import { parseConstraint, parseSelector } from './methodGrammar';

export type ResidueOverride =
  | { kind: 'none' }
  | { kind: 'fit' | 'fix'; ruleId: string }
  | { kind: 'constrain'; ruleId: string; to: string };

const norm = (s: string) => s.trim().toUpperCase();

/** "NAME, NUC->RES" for exactly this parameter and residue (no other qualifiers). */
export function residueSelector(name: string, residue: string): string {
  return `${name.toUpperCase()}, NUC->${residue}`;
}

function isResidueSelector(entry: string, name: string, residue: string): boolean {
  const { selector } = parseSelector(entry);
  if (!selector) return norm(entry) === norm(residueSelector(name, residue));
  const quals = selector.qualifiers ?? [];
  return norm(selector.name) === name.toUpperCase() && quals.length === 1 && quals[0].key === 'NUC' && norm(quals[0].value) === norm(residue);
}

/** Target selector and referenced residue of a CONSTRAIN entry, when it is a single-residue equation. */
function constrainParts(entry: string): { target: string; ref: string } | null {
  const m = /^\s*\[([^\]]+)\]\s*=\s*\[([^\]]+)\]\s*$/.exec(entry);
  if (!m || parseConstraint(entry).error) return null;
  return { target: m[1], ref: m[2] };
}

function refResidue(ref: string, name: string): string | null {
  const m = /^\s*([A-Z0-9_]+)\s*,\s*NUC\s*->\s*([^,\s]+)\s*$/i.exec(ref);
  return m && norm(m[1]) === name.toUpperCase() ? m[2] : null;
}

/** Current override of `name` for `residue`, read from the step's rules (last match wins). */
export function residueOverride(step: Pick<Step, 'roleRules'>, name: string, residue: string): ResidueOverride {
  let found: ResidueOverride = { kind: 'none' };
  for (const rule of step.roleRules ?? []) {
    for (const entry of rule.entries) {
      if (rule.action === 'CONSTRAIN') {
        const parts = constrainParts(entry);
        if (parts && isResidueSelector(parts.target, name, residue)) {
          const to = refResidue(parts.ref, name);
          if (to) found = { kind: 'constrain', ruleId: rule.id, to };
        }
      } else if (isResidueSelector(entry, name, residue)) {
        found = { kind: rule.action === 'FIT' ? 'fit' : 'fix', ruleId: rule.id };
      }
    }
  }
  return found;
}

function withoutResidue(rules: RoleRule[], name: string, residue: string): RoleRule[] {
  return rules
    .map(rule => {
      const entries = rule.entries.filter(entry => {
        if (rule.action === 'CONSTRAIN') {
          const parts = constrainParts(entry);
          return !(parts && isResidueSelector(parts.target, name, residue) && refResidue(parts.ref, name));
        }
        return !isResidueSelector(entry, name, residue);
      });
      return entries.length === rule.entries.length ? rule : { ...rule, entries };
    })
    .filter(rule => rule.entries.some(e => e.trim()));
}

/** Set (or clear, with kind 'none') the override of `name` for `residue`. */
export function setResidueOverride<S extends Pick<Step, 'roleRules'>>(
  step: S,
  name: string,
  residue: string,
  next: { kind: 'none' } | { kind: 'fit' | 'fix' } | { kind: 'constrain'; to: string }
): S {
  const rules = withoutResidue(step.roleRules ?? [], name, residue);
  if (next.kind === 'none') return { ...step, roleRules: rules };
  let action: RoleAction;
  let entry: string;
  if (next.kind === 'constrain') {
    if (norm(next.to) === norm(residue)) return { ...step, roleRules: rules };
    action = 'CONSTRAIN';
    entry = `[${residueSelector(name, residue)}] = [${residueSelector(name, next.to)}]`;
  } else {
    action = next.kind === 'fit' ? 'FIT' : 'FIX';
    entry = residueSelector(name, residue);
  }
  return { ...step, roleRules: [...rules, { id: newMethodId('rule'), action, entries: [entry] }] };
}
