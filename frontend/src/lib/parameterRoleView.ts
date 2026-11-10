/**
 * What the Methods parameter table's setting column shows for one parameter name,
 * derived from ChemEx's resolved roles for the step (authoritative) and the step's
 * search configuration. Pure, so each role's text is unit-tested.
 *
 *  - GRID axis   → "Grid axis · log(0.001–0.03, 10 pts)"; no starting value (held at grid points)
 *  - DE target   → "DE range · log(20–2000)"; starting value only for copies DE does not search
 *  - Fit         → the starting value and its source
 *  - Fixed       → the value it is fixed at, e.g. "117.2–121.8 ppm across 2 residues · Pick CEST"
 *  - Derived     → the expression, model-owned (locked) or a default constraint the user may override
 *  - Mixed       → several roles across copies (the table shows "Mixed · N rules")
 */

import type { ParamMode, SearchAxis, Step } from './methodConfig';
import type { ResolvedParameter, ResolvedRole } from './resolvedRoles';

export type RoleView =
  | { kind: 'grid'; axis: SearchAxis; text: string; partial: boolean }
  | { kind: 'de'; axis: SearchAxis; text: string; partial: boolean }
  | { kind: 'fit' }
  | { kind: 'fix'; text: string | null; count: number }
  | { kind: 'derived'; expression: string; modelOwned: boolean; defaultConstraint: boolean }
  | { kind: 'mixed'; counts: Partial<Record<ResolvedRole, number>> }
  | { kind: 'unresolved' };

/** DOM id of a search axis row (the table's "Grid axis" link scrolls to it). */
export const searchAxisDomId = (axisId: string) => `search-axis-${axisId}`;

export function paramUnit(name: string): string {
  const n = name.toUpperCase();
  if (/^(CS|DW)_/.test(n)) return 'ppm';
  if (/^(KEX|R1|R2|K[A-F]{2})(_|$)/.test(n)) return 's⁻¹';
  if (/^TAUC/.test(n)) return 'ns';
  return '';
}

export function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e4 || a < 1e-3)) return v.toExponential(2);
  return String(Number(v.toPrecision(4)));
}

/** "log(0.001–0.03, 10 pts)" (GRID) / "log(20–2000)" (DE) / "values(0.01, 0.02)". */
export function axisRangeText(axis: SearchAxis, mode: 'grid' | 'de'): string {
  if (axis.fn === 'values') return `values(${(axis.values ?? []).map(fmtNum).join(', ')})`;
  const range = `${fmtNum(axis.low)}–${fmtNum(axis.high)}`;
  return mode === 'grid' ? `${axis.fn}(${range}, ${axis.count} pts)` : `${axis.fn}(${range})`;
}

export interface RoleViewInput {
  name: string;
  step: Pick<Step, 'search'>;
  /** Table treatment (used only until ChemEx has resolved the step). */
  tableMode: ParamMode;
  /** This step's resolved copies of the parameter (empty/undefined until resolved). */
  resolved?: ResolvedParameter[];
  stepIndex: number;
  previousStepName?: string;
  /** Last run's committed value from the previous step (globals only). */
  committedPrevious?: number;
  /** Source label of the parameters-file values (e.g. "Pick CEST"); default "parameters file". */
  sourceLabel?: string;
  /** Concrete ChemEx parameter id → name for the whole step (to print expressions as "[R1_A]"). */
  idNames?: Record<string, string>;
}

/** Id → name map over every resolved parameter of a step. */
export function idNameMap(params: ResolvedParameter[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of params ?? []) out[p.id] = p.name.toUpperCase();
  return out;
}

/**
 * ChemEx prints baseline expressions with concrete ids ("__R1_A_13N_499_2MHZ");
 * show them by name ("[R1_A]") so every residue's copy reads the same.
 */
export function prettifyExpression(expression: string, idNames: Record<string, string> = {}): string {
  return expression.replace(/__[A-Za-z0-9_]+/g, id => {
    const name = idNames[id];
    if (name) return `[${name}]`;
    const m = /^__([A-Z]+[0-9]*(?:_[A-Z]+)?)/.exec(id);
    return m ? `[${m[1]}]` : id;
  });
}

function roleCounts(resolved: ResolvedParameter[]): Partial<Record<ResolvedRole, number>> {
  const out: Partial<Record<ResolvedRole, number>> = {};
  for (const p of resolved) out[p.role] = (out[p.role] ?? 0) + 1;
  return out;
}

function fixedText(input: RoleViewInput, resolved: ResolvedParameter[]): string | null {
  const unit = paramUnit(input.name);
  const withUnit = (s: string) => (unit ? `${s} ${unit}` : s);
  if (input.stepIndex > 0 && input.previousStepName) {
    // Values come from the latest committed fit, not the parameters file.
    const last = input.committedPrevious !== undefined ? ` (last run: ${withUnit(fmtNum(input.committedPrevious))})` : '';
    return `value committed by ${input.previousStepName}${last}`;
  }
  const values = resolved.map(p => p.value).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (values.length === 0) return null;
  const source = input.sourceLabel || 'parameters file';
  const spins = new Set(resolved.map(p => p.spin).filter(Boolean));
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = lo === hi ? fmtNum(lo) : `${fmtNum(lo)}–${fmtNum(hi)}`;
  const across = spins.size > 1 ? ` across ${spins.size} residues` : '';
  return `${withUnit(span)}${across} · ${source}`;
}

export function roleView(input: RoleViewInput): RoleView {
  const name = input.name.toUpperCase();
  const search = input.step.search;
  if (search && search.mode !== 'none') {
    const axis = search.axes.find(a => a.param.trim().toUpperCase() === name);
    if (axis) {
      const mode = search.mode;
      return { kind: mode, axis, text: axisRangeText(axis, mode), partial: !!(axis.qualifier && axis.qualifier.trim()) };
    }
  }
  const resolved = input.resolved ?? [];
  if (resolved.length > 0) {
    const counts = roleCounts(resolved);
    const roles = Object.keys(counts) as ResolvedRole[];
    if (roles.length > 1) return { kind: 'mixed', counts };
    const role = roles[0];
    if (role === 'fit') return { kind: 'fit' };
    if (role === 'fix') return { kind: 'fix', text: fixedText(input, resolved), count: resolved.length };
    const exprs = Array.from(new Set(resolved.map(p => prettifyExpression(p.expression, input.idNames)).filter(Boolean)));
    return {
      kind: 'derived',
      expression: exprs.length === 1 ? exprs[0] : exprs.length > 1 ? `${exprs[0]} (+${exprs.length - 1} more)` : '',
      modelOwned: resolved.every(p => p.protected),
      // Derived by the baseline parameterisation (not a rule, not model-owned): the user may override it.
      defaultConstraint: role === 'derived' && resolved.every(p => !p.protected && p.decided_by !== 'rule'),
    };
  }
  if (input.tableMode === 'fit') return { kind: 'fit' };
  if (input.tableMode === 'fix') return { kind: 'fix', text: fixedText(input, []), count: 0 };
  return { kind: 'unresolved' };
}

/** "= [R1_A]" — ChemEx reports constraint expressions with the target's own name; show the right side. */
export function expressionRhs(expression: string): string {
  const m = /^\s*\[[^\]]+\]\s*=\s*(.+)$/.exec(expression);
  return `= ${(m ? m[1] : expression).trim()}`;
}
