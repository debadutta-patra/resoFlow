/**
 * Role of a parameter in the active method step, for the Parameters tab: a chip per
 * [GLOBAL] field and the "Method Step" column of the residue table. ChemEx's resolved
 * roles (after ROLES_FROM and every ROLES action) are authoritative; until they load,
 * the step's table, role rules and ChemEx's default roles are used.
 */

import type { Step } from './methodConfig';
import type { ResolvedParameter, ResolvedStep } from './resolvedRoles';
import { roleView } from './parameterRoleView';
import { fallbackDefaults, type ParamDefaultsLookup } from './chemexDefaults';
import { SpinSystemKey } from './spinSystem';

export type RoleTone = 'fit' | 'fix' | 'constrain' | 'search' | 'mixed';

export interface RoleChip {
  label: string;
  tone: RoleTone;
  title: string;
}

/** Resolved step matching `step` (by name, else by position). */
export function resolvedStepFor(steps: ResolvedStep[] | undefined, step: Step | undefined, index: number): ResolvedStep | undefined {
  if (!steps || !step) return undefined;
  return steps.find(s => s.name === step.name) ?? steps[index];
}

/** Role-rule actions (in order) that target `name`, with or without selector qualifiers. */
function ruleActions(step: Step, name: string): Array<'FIT' | 'FIX' | 'CONSTRAIN'> {
  const out: Array<'FIT' | 'FIX' | 'CONSTRAIN'> = [];
  for (const rule of step.roleRules ?? []) {
    for (const entry of rule.entries) {
      const target = entry.split(/[,=]/)[0].trim().replace(/^\[|\]$/g, '').toUpperCase();
      if (target === name) out.push(rule.action);
    }
  }
  return out;
}

/** Role chip for a [GLOBAL] parameter in `step`; null for protected constants (TREF). */
export function globalRoleChip(
  name: string,
  step: Step | undefined,
  resolved: ResolvedStep | undefined,
  stepIndex: number,
  lookup: ParamDefaultsLookup = fallbackDefaults
): RoleChip | null {
  const upper = name.toUpperCase();
  if (!step || lookup(upper)?.protected) return null;
  const params = (resolved?.parameters ?? []).filter(p => p.name.toUpperCase() === upper);
  if (params.length > 0 && params.every(p => p.protected && p.role !== 'fit')) return null;
  const tableMode = step.parameters.find(p => p.name.toUpperCase() === upper)?.mode ?? 'default';
  const view = roleView({ name: upper, step, tableMode, resolved: params, stepIndex });
  const where = `in ${step.name}`;
  switch (view.kind) {
    case 'grid':
      return { label: 'GRID', tone: 'search', title: `Grid axis ${where}: ${view.text}` };
    case 'de':
      return { label: 'DE', tone: 'search', title: `Differential-evolution coordinate ${where}: ${view.text}` };
    case 'fit':
      return { label: 'FIT', tone: 'fit', title: `Optimised ${where}` };
    case 'fix':
      return { label: 'FIX', tone: 'fix', title: `Held fixed ${where}${view.text ? `: ${view.text}` : ''}` };
    case 'derived':
      return { label: 'CONSTRAIN', tone: 'constrain', title: `Derived ${where}${view.expression ? `: ${view.expression}` : ''}` };
    case 'mixed':
      return { label: 'MIXED', tone: 'mixed', title: `Several roles across copies ${where}` };
    default: {
      // Not resolved yet: table / role rules, else ChemEx's default role.
      const rules = ruleActions(step, upper);
      const last = rules[rules.length - 1];
      const fit = last ? last === 'FIT' : tableMode === 'fit' || (tableMode === 'default' && !!lookup(upper)?.vary);
      if (last === 'CONSTRAIN' || tableMode === 'constrain') return { label: 'CONSTRAIN', tone: 'constrain', title: `Constrained ${where}` };
      return fit
        ? { label: 'FIT', tone: 'fit', title: `Optimised ${where} (not yet confirmed by ChemEx)` }
        : { label: 'FIX', tone: 'fix', title: `Held fixed ${where} (not yet confirmed by ChemEx)` };
    }
  }
}

export type ResidueTreatment = 'Fit' | 'Fixed' | 'Excluded' | 'Active';

const matchesResidue = (p: ResolvedParameter, target: SpinSystemKey) => {
  if (!p.spin) return false;
  try {
    return SpinSystemKey.parse(p.spin).matches(target);
  } catch {
    return false;
  }
};

/**
 * How `names` (default CS_A, DW_AB) of one residue are treated in `step`: excluded by the
 * step's INCLUDE/EXCLUDE, fitted if any copy is fitted, fixed if all are fixed.
 */
export function residueTreatment(
  step: Step | undefined,
  resolved: ResolvedStep | undefined,
  resKey: string,
  lookup: ParamDefaultsLookup = fallbackDefaults,
  names: string[] = ['CS_A', 'DW_AB']
): ResidueTreatment | undefined {
  if (!step) return undefined;
  const target = SpinSystemKey.parse(resKey);
  const listed = (step.residues ?? []).some(r => SpinSystemKey.parse(r).matches(target));
  if (step.residueMode === 'exclude' && listed) return 'Excluded';
  if (step.residueMode === 'include' && (step.residues ?? []).length > 0 && !listed) return 'Excluded';

  const upperNames = names.map(n => n.toUpperCase());
  const params = (resolved?.parameters ?? []).filter(p => upperNames.includes(p.name.toUpperCase()) && matchesResidue(p, target));
  if (params.length > 0) {
    if (params.some(p => p.role === 'fit')) return 'Fit';
    if (params.every(p => p.role === 'fix')) return 'Fixed';
    return 'Active';
  }
  // Fallback until ChemEx has resolved the step.
  const roles = upperNames.map(n => globalRoleChip(n, step, undefined, 0, lookup)?.tone);
  if (roles.includes('fit') || roles.includes('search')) return 'Fit';
  if (roles.every(r => r === 'fix')) return 'Fixed';
  return 'Active';
}
