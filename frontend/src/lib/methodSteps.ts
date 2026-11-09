/**
 * Method step identity: names (TOML keys and ChemEx output directories) and
 * ROLES_FROM references, which are stored by step id and serialised by name.
 */

import type { MethodConfig, Step } from './methodConfig';

/** TOML bare-key characters; also safe as a single directory name. */
const BARE_KEY = /^[A-Za-z0-9_-]+$/;
export const MAX_STEP_NAME = 64;

/**
 * Directory names ChemEx (and the results reader) use inside a run's Output/ —
 * multi-step results are written to Output/<STEP>/, so a step may not shadow them.
 */
export const RESERVED_STEP_NAMES = ['run_info', 'Parameters', 'Data', 'Plots', 'Grid', 'Statistics', 'All', 'Groups', 'Output'];

/** Name as emitted: trimmed, case preserved, STEPn when blank. */
export const stepDisplayName = (step: Pick<Step, 'name'>, idx: number): string => (step.name || '').trim() || `STEP${idx + 1}`;

/** Why `name` cannot be used for the step at `idx` (unique case-insensitively), or null. */
export function stepNameError(name: string, steps: Array<Pick<Step, 'name' | 'id'>>, idx: number): string | null {
  const n = name.trim();
  if (!n) return 'Step name cannot be empty.';
  if (n.length > MAX_STEP_NAME) return `Step name must be at most ${MAX_STEP_NAME} characters.`;
  if (!BARE_KEY.test(n)) return 'Use only letters, digits, "_" and "-" (TOML bare key, safe as a folder name).';
  if (RESERVED_STEP_NAMES.some(r => r.toLowerCase() === n.toLowerCase())) {
    return `"${n}" is reserved: ChemEx writes a "${n}" folder next to step results.`;
  }
  const clash = steps.findIndex((s, i) => i !== idx && stepDisplayName(s, i).toLowerCase() === n.toLowerCase());
  if (clash !== -1) return `Another step is already named "${stepDisplayName(steps[clash], clash)}" (names are compared ignoring case).`;
  return null;
}

/** `base` if free, else base_2, base_3, … (case-insensitive). */
export function uniqueStepName(base: string, steps: Array<Pick<Step, 'name'>>): string {
  const taken = new Set(steps.map((s, i) => stepDisplayName(s, i).toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let k = 2; ; k++) {
    const candidate = `${base}_${k}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export type RolesFromStatus = 'none' | 'ok' | 'missing' | 'forward' | 'self';

export interface RolesFromTarget {
  status: RolesFromStatus;
  /** Name to serialise: the target's current name, or the last known name if it is gone. */
  name?: string;
  index?: number;
}

/** Resolve the ROLES_FROM reference of steps[idx] (by id; legacy name-only references by name). */
export function rolesFromTarget(steps: Step[], idx: number): RolesFromTarget {
  const step = steps[idx];
  if (!step) return { status: 'none' };
  const id = step.rolesFromStepId;
  const lastName = step.rolesFrom?.trim() || undefined;
  if (!id && !lastName) return { status: 'none' };
  let index = id ? steps.findIndex(s => s.id === id) : -1;
  if (index === -1 && !id && lastName) index = steps.findIndex((s, i) => stepDisplayName(s, i) === lastName);
  if (index === -1) return { status: 'missing', name: lastName };
  const name = stepDisplayName(steps[index], index);
  if (index === idx) return { status: 'self', name, index };
  if (index > idx) return { status: 'forward', name, index };
  return { status: 'ok', name, index };
}

/** Human message for a broken ROLES_FROM reference, or null when fine. */
export function rolesFromError(steps: Step[], idx: number): string | null {
  const t = rolesFromTarget(steps, idx);
  switch (t.status) {
    case 'missing':
      return `ROLES_FROM points to a step that no longer exists${t.name ? ` ("${t.name}")` : ''}. Choose an earlier step or Baseline.`;
    case 'forward':
      return `ROLES_FROM "${t.name}" is step ${(t.index ?? 0) + 1}, after this one; it must name an earlier step.`;
    case 'self':
      return 'ROLES_FROM cannot name the step itself.';
    default:
      return null;
  }
}

/**
 * Attach step ids to name-only ROLES_FROM references (imported TOML, configs saved
 * before references were id-based). Exact-name match against earlier steps first,
 * then any step; unmatched references keep their name and surface as errors.
 */
export function linkRolesFrom(config: MethodConfig): MethodConfig {
  let changed = false;
  const steps = config.steps.map((step, idx) => {
    if (step.rolesFromStepId || !step.rolesFrom?.trim()) return step;
    const name = step.rolesFrom.trim();
    const earlier = config.steps.findIndex((s, i) => i < idx && stepDisplayName(s, i) === name);
    const match = earlier !== -1 ? earlier : config.steps.findIndex((s, i) => stepDisplayName(s, i) === name);
    if (match === -1) return step;
    changed = true;
    return { ...step, rolesFromStepId: config.steps[match].id };
  });
  return changed ? { ...config, steps } : config;
}

/** Point a step's ROLES_FROM at another step (or clear it), keeping the name snapshot in sync. */
export function setRolesFrom(step: Step, target: Step | undefined, targetIdx = 0): Step {
  if (!target) return { ...step, rolesFromStepId: undefined, rolesFrom: undefined };
  return { ...step, rolesFromStepId: target.id, rolesFrom: stepDisplayName(target, targetIdx) };
}
