/**
 * Types and pure helpers for ChemEx method validation + per-step resolved roles,
 * returned by POST …/methods/validate (backend: resoflow/chemex_api/roles.validate_method).
 */

import type { Step } from './methodConfig';
import { stepRoleActions } from './methodToml';
import { constraintTargetName, selectorName } from './methodGrammar';

export interface ChemexSource {
  step?: string;
  /** e.g. "ROLES[1].FIT[0]", "SEARCH.GRID.AXES", "SEARCH.DE.SEED", "STATISTICS.MC", "ROLES_FROM". */
  field?: string;
  index?: number | null;
  start?: number | null;
  end?: number | null;
  action_index?: number;
  action?: string;
  entry_index?: number;
}

export interface ChemexError {
  message: string;
  type: string;
  source: ChemexSource;
}

export interface RuleRef {
  step: string;
  action_index: number;
  entry_index: number;
  action: 'FIT' | 'FIX' | 'CONSTRAIN';
  inherited: boolean;
}

export type ResolvedRole = 'fit' | 'fix' | 'constrained' | 'derived';

export interface ResolvedParameter {
  id: string;
  name: string;
  spin: string;
  conditions: Record<string, number>;
  scope: 'global' | 'residue';
  role: ResolvedRole;
  expression: string;
  decided_by: 'rule' | 'baseline' | 'model';
  rule: RuleRef | null;
  protected: boolean;
  /** Parameters-file (or ChemEx default) value at the start of the method; null when unset. */
  value?: number | null;
}

/** One GRID axis / DE coordinate resolved against the step's final roles. */
export interface ResolvedAxis {
  index: number;
  selector: string;
  /** Concrete parameter ids the declaration matches in this step. */
  coordinates: string[];
  /** GRID: values on this axis. */
  points?: number;
  /** GRID: coordinates this axis finally owns (later specific axes replace earlier broad ones). */
  owned?: number;
  error: ChemexError | null;
}

export interface ResolvedSearch {
  kind: 'grid' | 'de';
  axes: ResolvedAxis[];
  /** GRID: product of global-axis points. */
  global_points?: number | null;
  /** GRID: per residue, product of its local-axis points. */
  local_points?: Record<string, number>;
  /** GRID: profiled evaluations after exact factorisation (global × Σ local). */
  evaluations?: number | null;
  error?: ChemexError | null;
}

export interface ResolvedStep {
  name: string;
  roles_from: string | null;
  profiles: number | null;
  parameters: ResolvedParameter[];
  counts: Record<ResolvedRole, number>;
  search?: ResolvedSearch | null;
  error: ChemexError | null;
  /** Active (unmasked) data points per spin system in this step's selection. */
  data_points?: Record<string, number>;
  /** Total active data points in this step. */
  ndata?: number;
  /** Experiments contributing profiles to this step (B1 field for CEST). */
  experiments?: Array<{ name: string; file: string; b1_frq: number | null; profiles: number }>;
}

export interface ResolveReport {
  valid: boolean;
  format: 'v1' | 'v2' | null;
  errors: ChemexError[];
  /** Parameter-sharing warnings (only when requested). */
  warnings?: Array<{ code?: string; message: string }>;
  steps: ResolvedStep[];
  method_toml?: string;
  chemex_version?: string;
}

export interface StepSummary {
  globalFit: number;
  residueFit: number;
  constrained: number;
  fixed: number;
  derived: number;
}

export function summarizeResolvedStep(step: ResolvedStep): StepSummary {
  const s: StepSummary = { globalFit: 0, residueFit: 0, constrained: 0, fixed: 0, derived: 0 };
  for (const p of step.parameters) {
    if (p.role === 'fit') {
      if (p.scope === 'global') s.globalFit++;
      else s.residueFit++;
    } else if (p.role === 'fix') s.fixed++;
    else if (p.role === 'constrained') s.constrained++;
    else s.derived++;
  }
  return s;
}

/** "2 global FIT · 2 residue FIT · 1 constrained · 260 fixed · 30 model-derived" (zero terms omitted). */
export function stepSummaryText(s: StepSummary): string {
  const parts: string[] = [];
  if (s.globalFit) parts.push(`${s.globalFit} global FIT`);
  if (s.residueFit) parts.push(`${s.residueFit} residue FIT`);
  if (s.constrained) parts.push(`${s.constrained} constrained`);
  parts.push(`${s.fixed} fixed`);
  if (s.derived) parts.push(`${s.derived} derived`);
  return parts.join(' · ');
}

/** Resolved role counts per parameter name (for the table's quick view). */
export function resolvedCountsByName(step: ResolvedStep | undefined): Record<string, Record<ResolvedRole, number>> {
  const out: Record<string, Record<ResolvedRole, number>> = {};
  for (const p of step?.parameters ?? []) {
    const name = p.name.toUpperCase();
    const c = (out[name] ??= { fit: 0, fix: 0, constrained: 0, derived: 0 });
    c[p.role] += 1;
  }
  return out;
}

const ROLE_LABEL: Record<ResolvedRole, string> = { fit: 'Fit', fix: 'Fixed', constrained: 'Constrained', derived: 'Derived' };

export function resolvedCountsLabel(c: Record<ResolvedRole, number> | undefined): string | null {
  if (!c) return null;
  const parts = (Object.keys(ROLE_LABEL) as ResolvedRole[]).filter(k => c[k] > 0);
  if (!parts.length) return null;
  if (parts.length === 1) return ROLE_LABEL[parts[0]];
  return parts.map(k => `${ROLE_LABEL[k]} ${c[k]}`).join(' · ');
}

/**
 * Where ROLES action `actionIndex` of a step comes from in the editor: one of the
 * parameter-table actions (emitted first: CONSTRAIN → FIX → FIT), or an ordered rule.
 * `entryIndex` is translated back to the rule's own entry list (blank lines skipped on emit).
 */
export type ActionTarget =
  | { kind: 'table'; action: 'FIT' | 'FIX' | 'CONSTRAIN'; entry: string | undefined }
  | { kind: 'rule'; ruleId: string; ruleIndex: number; entryIndex: number };

export function actionTarget(step: Step, actionIndex: number, entryIndex = 0): ActionTarget | null {
  const actions = stepRoleActions(step);
  const ruleActions = (step.roleRules ?? []).map((r, i) => ({ r, i })).filter(({ r }) => r.entries.some(e => e.trim()));
  const tableCount = actions.length - ruleActions.length;
  if (actionIndex < 0 || actionIndex >= actions.length) return null;
  if (actionIndex < tableCount) {
    const a = actions[actionIndex];
    return { kind: 'table', action: a.action, entry: a.entries[entryIndex] };
  }
  const { r, i } = ruleActions[actionIndex - tableCount];
  let seen = -1;
  for (let k = 0; k < r.entries.length; k++) {
    if (r.entries[k].trim()) seen++;
    if (seen === entryIndex) return { kind: 'rule', ruleId: r.id, ruleIndex: i, entryIndex: k };
  }
  return { kind: 'rule', ruleId: r.id, ruleIndex: i, entryIndex: 0 };
}

/** Number of ROLES actions the parameter table contributes (they precede the rules). */
export function tableActionCount(step: Step): number {
  const rules = (step.roleRules ?? []).filter(r => r.entries.some(e => e.trim())).length;
  return stepRoleActions(step).length - rules;
}

/** ChemEx errors (top-level and per-step) that belong to the named step. */
export function errorsForStep(report: ResolveReport | null | undefined, stepName: string): ChemexError[] {
  if (!report) return [];
  const upper = stepName.toUpperCase();
  const own = report.errors.filter(e => (e.source?.step ?? '').toUpperCase() === upper);
  const stepErr = report.steps.find(s => s.name.toUpperCase() === upper)?.error;
  return stepErr && !own.some(e => e.message === stepErr.message) ? [...own, stepErr] : own;
}

/** DOM id of a rule card in the ROLES editor (scroll / highlight target). */
export const ruleDomId = (ruleId: string) => `role-rule-${ruleId}`;

/** Ids of the step's rules that target each parameter name (FIT/FIX selectors and CONSTRAIN targets). */
export function rulesByTargetName(step: Step): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const rule of step.roleRules ?? []) {
    const names = new Set<string>();
    for (const e of rule.entries) {
      if (!e.trim()) continue;
      const name = rule.action === 'CONSTRAIN' ? constraintTargetName(e) : selectorName(e);
      if (name) names.add(name);
    }
    for (const n of names) (out[n] ??= []).push(rule.id);
  }
  return out;
}

/** Compact per-step facts for the step tabs. */
export interface StepBadge {
  /** Independent FIT coordinates after all roles (null until ChemEx has resolved the step). */
  coords: number | null;
  /** Residues (spin systems) in the step's active scope. */
  residues: number | null;
  search: 'grid' | 'de' | null;
  statistics: string[];
}

export function stepBadge(step: Step, resolved: ResolvedStep | undefined): StepBadge {
  const search = step.search && step.search.mode !== 'none' && step.search.axes.length > 0 ? step.search.mode : null;
  const st = step.statistics;
  const statistics = [
    st?.mc?.enabled ? 'MC' : null,
    st?.bs?.enabled ? 'BS' : null,
    st?.bsn?.enabled ? 'BSN' : null,
    st?.mcmc?.enabled ? 'MCMC' : null,
  ].filter((x): x is string => !!x);
  if (!resolved || resolved.error) return { coords: null, residues: null, search, statistics };
  const coords = resolved.parameters.filter(p => p.role === 'fit').length;
  const residues = new Set(resolved.parameters.filter(p => p.spin).map(p => p.spin)).size;
  return { coords, residues, search, statistics };
}

/** "4 coords · 2 res" */
export function stepBadgeText(b: StepBadge): string | null {
  if (b.coords === null) return null;
  return `${b.coords} coord${b.coords === 1 ? '' : 's'} · ${b.residues ?? 0} res`;
}

/** Human-readable ChemEx error location, e.g. "[STEP2] ROLES #2 FIT, entry 1". */
export function chemexLocation(e: ChemexError): string {
  const src = e.source || {};
  let where = src.field ?? '';
  if (src.action_index !== undefined) where = `ROLES #${src.action_index + 1} ${src.action}, entry ${(src.entry_index ?? 0) + 1}`;
  else if (src.index !== undefined && src.index !== null) where = `${src.field} #${src.index + 1}`;
  return [src.step ? `[${src.step}]` : '', where].filter(Boolean).join(' ');
}

/** A ChemEx problem in the editor's issue shape (see methodValidation.ValidationError). */
export interface ChemexIssue {
  stepId: string;
  stepName: string;
  message: string;
  severity: 'error' | 'warning';
  origin: 'chemex';
  source: ChemexSource;
}

/**
 * Every problem a run would hit, from a current (non-stale) ChemEx report: ChemEx's own
 * validation errors, per-step errors, and every per-axis search error (ChemEx stops at
 * the first; per-axis resolution finds all). "Inputs not generated yet" is not a method
 * problem and is left out; a step with no selected profiles is a warning (ChemEx skips it).
 */
export function chemexIssues(report: ResolveReport | null | undefined, steps: Array<Pick<Step, 'id' | 'name'>>): ChemexIssue[] {
  if (!report) return [];
  const idOf = (name: string | undefined) => {
    if (!name) return { stepId: 'global', stepName: 'Method' };
    const exact = steps.findIndex(s => (s.name || '').trim() === name);
    const k = exact !== -1 ? exact : steps.findIndex(s => (s.name || '').trim().toUpperCase() === name.toUpperCase());
    return { stepId: k === -1 ? 'global' : steps[k].id, stepName: name };
  };
  const out: ChemexIssue[] = [];
  const seen = new Set<string>();
  const add = (e: ChemexError, stepName: string | undefined, severity: 'error' | 'warning' = 'error') => {
    if (e.type === 'MissingInputs') return;
    const key = `${stepName ?? ''}|${e.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...idOf(stepName), message: e.message, severity, origin: 'chemex', source: { ...e.source, step: e.source?.step ?? stepName } });
  };
  for (const e of report.errors) add(e, e.source?.step);
  for (const st of report.steps) {
    if (st.error) add(st.error, st.name, st.error.type === 'NoData' ? 'warning' : 'error');
    const search = st.search;
    if (!search) continue;
    if (search.error) add(search.error, st.name);
    const field = search.kind === 'grid' ? 'SEARCH.GRID.AXES' : 'SEARCH.DE.COORDINATES';
    for (const ax of search.axes) {
      if (ax.error) add({ ...ax.error, source: { ...ax.error.source, step: st.name, field, index: ax.index } }, st.name);
    }
  }
  return out;
}
