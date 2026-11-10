/**
 * Quick-fixes for method validation issues: pure `MethodConfig → MethodConfig` edits
 * attached to an issue, plus per-step issue dismissal.
 *
 * Dismissals live in the method config (`Step.dismissedIssues`), so they are saved with
 * the analysis and seen by every viewer. They are resoFlow-only metadata: neither TOML
 * codec reads or writes them, so the emitted method.toml is unchanged.
 */

import type { MethodConfig, Step } from './methodConfig';
import { setRolesFrom, stepDisplayName } from './methodSteps';

export interface QuickFix {
  /** Stable id (for tests and React keys). */
  id: string;
  label: string;
  /** Short explanation shown as the button tooltip. */
  title?: string;
  apply: (config: MethodConfig) => MethodConfig;
}

/** Replace the step with `stepId` by `fn(step)`; the config is returned unchanged if the step is gone. */
export function mapStep(config: MethodConfig, stepId: string, fn: (step: Step, idx: number) => Step): MethodConfig {
  const idx = config.steps.findIndex(s => s.id === stepId);
  if (idx === -1) return config;
  const steps = [...config.steps];
  steps[idx] = fn(steps[idx], idx);
  return { ...config, steps };
}

/** Key an issue is dismissed under: its code, qualified by parameter when it has one. */
export function issueKey(issue: { code?: string; paramName?: string }): string | null {
  if (!issue.code) return null;
  return issue.paramName ? `${issue.code}:${issue.paramName.toUpperCase()}` : issue.code;
}

export function dismissIssue(config: MethodConfig, stepId: string, key: string): MethodConfig {
  return mapStep(config, stepId, step =>
    (step.dismissedIssues ?? []).includes(key) ? step : { ...step, dismissedIssues: [...(step.dismissedIssues ?? []), key] }
  );
}

export function restoreIssue(config: MethodConfig, stepId: string, key: string): MethodConfig {
  return mapStep(config, stepId, step => {
    const kept = (step.dismissedIssues ?? []).filter(k => k !== key);
    const next: Step = { ...step, dismissedIssues: kept };
    if (kept.length === 0) delete next.dismissedIssues;
    return next;
  });
}

export function dismissFix(stepId: string, key: string, label = 'Dismiss for this step'): QuickFix {
  return {
    id: `dismiss:${key}`,
    label,
    title: 'Hide this note for this step. Saved with the method; restore it from the dismissed list.',
    apply: config => dismissIssue(config, stepId, key),
  };
}

/** Set the step's ROLES_FROM to `target` (by id, so it survives renames). */
export function inheritRolesFix(stepId: string, target: Step, targetIdx: number): QuickFix {
  const name = stepDisplayName(target, targetIdx);
  return {
    id: `roles-from:${target.id}`,
    label: `Inherit roles from ${name}`,
    title: `Sets ROLES_FROM = "${name}": this step starts from ${name}'s effective roles and constraints.`,
    apply: config => mapStep(config, stepId, step => setRolesFrom(step, target, targetIdx)),
  };
}

export interface DismissalSplit<T> {
  active: T[];
  dismissed: Array<T & { dismissKey: string }>;
}

/** Separate dismissed issues (never errors) from the ones still shown. */
export function partitionDismissed<T extends { stepId: string; code?: string; paramName?: string; severity: string }>(
  issues: T[],
  config: MethodConfig
): DismissalSplit<T> {
  const byStep = new Map(config.steps.map(s => [s.id, new Set(s.dismissedIssues ?? [])]));
  const active: T[] = [];
  const dismissed: Array<T & { dismissKey: string }> = [];
  for (const issue of issues) {
    const key = issueKey(issue);
    if (key && issue.severity !== 'error' && byStep.get(issue.stepId)?.has(key)) dismissed.push({ ...issue, dismissKey: key });
    else active.push(issue);
  }
  return { active, dismissed };
}
