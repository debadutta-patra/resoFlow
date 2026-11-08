/**
 * ChemEx v2 role inheritance (ROLES_FROM) and ordered, selector-level ROLES
 * actions for one method step. The parameter table supplies plain-name roles;
 * the rules here are appended after it, so they act as specific overrides
 * (later actions replace earlier ones for matching parameters).
 */

import React, { useState } from 'react';
import { ChevronDown, ChevronUp, ListOrdered, Plus, Trash2 } from 'lucide-react';
import type { RoleAction, RoleRule, Step } from '../../lib/methodConfig';
import { newMethodId } from '../../lib/methodConfig';
import { stepRoleActions } from '../../lib/methodToml';

interface StepRolesSectionProps {
  step: Step;
  stepIdx: number;
  steps: Step[];
  onChange: (updated: Step) => void;
  readOnly?: boolean;
}

const inputCls =
  'w-full text-xs font-mono px-2 py-1 rounded bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200 outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-60';

const PLACEHOLDER: Record<RoleAction, string> = {
  FIT: 'DW_AB, NUC->G24N-H\nR2_A, B0->800.13MHz',
  FIX: 'DW_AB\nR1_A, T->25C',
  CONSTRAIN: '[DW_AB, NUC->G31N-H] = [DW_AB, NUC->G24N-H]\n[R2_B, NUC->N] = [R2_A, NUC->N]',
};

const ACTION_CLS: Record<RoleAction, string> = {
  FIT: 'text-blue-600 dark:text-blue-400',
  FIX: 'text-slate-600 dark:text-slate-300',
  CONSTRAIN: 'text-purple-600 dark:text-purple-400',
};

export const StepRolesSection: React.FC<StepRolesSectionProps> = ({ step, stepIdx, steps, onChange, readOnly = false }) => {
  const rules = step.roleRules ?? [];
  const [isOpen, setIsOpen] = useState(rules.length > 0 || !!step.rolesFrom);
  const earlierSteps = steps.slice(0, stepIdx).map((s, i) => (s.name || `STEP${i + 1}`).trim().toUpperCase());

  const setRules = (next: RoleRule[]) => onChange({ ...step, roleRules: next });
  const updateRule = (id: string, patch: Partial<RoleRule>) => setRules(rules.map(r => (r.id === id ? { ...r, ...patch } : r)));
  const moveRule = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= rules.length) return;
    const next = [...rules];
    [next[idx], next[j]] = [next[j], next[idx]];
    setRules(next);
  };

  const effective = stepRoleActions(step);
  const tableCount = effective.length - rules.filter(r => r.entries.some(e => e.trim())).length;

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-sm">
      <div className="p-3.5 bg-slate-50/80 dark:bg-slate-800/60 flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center gap-2 text-xs font-bold text-slate-700 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400"
        >
          {isOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          <ListOrdered className="w-4 h-4 text-indigo-500" />
          <span>Role Inheritance & Ordered Rules (ROLES_FROM / ROLES)</span>
          {(rules.length > 0 || step.rolesFrom) && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300 font-mono font-bold">
              {step.rolesFrom ? `from ${step.rolesFrom}` : 'baseline'}
              {rules.length > 0 ? ` · ${rules.length} rule${rules.length > 1 ? 's' : ''}` : ''}
            </span>
          )}
        </button>
      </div>

      {isOpen && (
        <div className="p-4 space-y-4 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <label className="font-semibold text-slate-600 dark:text-slate-300">Start roles from:</label>
            <select
              disabled={readOnly || stepIdx === 0}
              value={step.rolesFrom ?? ''}
              onChange={e => onChange({ ...step, rolesFrom: e.target.value || undefined })}
              className={`${inputCls} w-56`}
            >
              <option value="">Baseline model roles</option>
              {earlierSteps.map(n => (
                <option key={n} value={n}>
                  Step {n} (ROLES_FROM)
                </option>
              ))}
              {step.rolesFrom && !earlierSteps.includes(step.rolesFrom.toUpperCase()) && (
                <option value={step.rolesFrom}>{step.rolesFrom} (invalid — not an earlier step)</option>
              )}
            </select>
            <span className="text-[11px] text-slate-400 dark:text-slate-500 max-w-xl">
              Copies only the effective role/constraint setup of that step — not values, selection, search or statistics. Numerical values always
              continue from the latest committed fit.
            </span>
          </div>

          <div className="space-y-2">
            <div className="text-[11px] text-slate-500 dark:text-slate-400">
              Applied top-to-bottom after the {tableCount > 0 ? `${tableCount} action${tableCount > 1 ? 's' : ''} from the parameter table` : 'parameter table'}; a later
              matching action replaces the earlier role. One selector (FIT/FIX) or equation (CONSTRAIN) per line. Qualifiers:{' '}
              <code className="font-mono">NUC-&gt;</code>, <code className="font-mono">T-&gt;</code>, <code className="font-mono">B0-&gt;</code>,{' '}
              <code className="font-mono">[P]-&gt;</code>, <code className="font-mono">[L]-&gt;</code>, <code className="font-mono">D2O-&gt;</code>.
            </div>

            {rules.map((rule, idx) => (
              <div key={rule.id} className="flex items-start gap-2 p-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800/30">
                <span className="pt-1 font-mono text-slate-400 w-5 text-right">{idx + 1}.</span>
                <select
                  disabled={readOnly}
                  value={rule.action}
                  onChange={e => updateRule(rule.id, { action: e.target.value as RoleAction })}
                  className={`${inputCls} w-28 font-bold ${ACTION_CLS[rule.action]}`}
                >
                  <option value="FIT">FIT</option>
                  <option value="FIX">FIX</option>
                  <option value="CONSTRAIN">CONSTRAIN</option>
                </select>
                <textarea
                  disabled={readOnly}
                  rows={Math.max(2, rule.entries.length)}
                  value={rule.entries.join('\n')}
                  placeholder={PLACEHOLDER[rule.action]}
                  onChange={e => updateRule(rule.id, { entries: e.target.value.split('\n') })}
                  className={`${inputCls} flex-grow`}
                />
                {!readOnly && (
                  <div className="flex flex-col">
                    <button type="button" onClick={() => moveRule(idx, -1)} className="p-1 text-slate-400 hover:text-blue-500" title="Move up">
                      <ChevronUp className="w-3.5 h-3.5" />
                    </button>
                    <button type="button" onClick={() => moveRule(idx, 1)} className="p-1 text-slate-400 hover:text-blue-500" title="Move down">
                      <ChevronDown className="w-3.5 h-3.5" />
                    </button>
                    <button type="button" onClick={() => setRules(rules.filter(r => r.id !== rule.id))} className="p-1 text-slate-400 hover:text-red-500" title="Remove">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
            ))}

            {!readOnly && (
              <button
                type="button"
                onClick={() => setRules([...rules, { id: newMethodId('rule'), action: 'FIT', entries: [''] }])}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-dashed border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-blue-400 hover:text-blue-600"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add role rule</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default StepRolesSection;
