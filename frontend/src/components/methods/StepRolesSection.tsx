/**
 * ChemEx v2 ordered ROLES for one method step — the authoritative role editor.
 *
 * Shows every emitted ROLES action in order: first the parameter table's
 * plain-name actions (CONSTRAIN → FIX → FIT), then the ordered rules, which act
 * as specific overrides (a later matching action replaces the earlier role).
 * Rules are built with the selector builder / constraint editor and can be
 * dragged (or moved with the buttons) to change precedence.
 */

import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, GripVertical, ListOrdered, Plus, Trash2, X } from 'lucide-react';
import type { RoleAction, RoleRule, Step } from '../../lib/methodConfig';
import { newMethodId } from '../../lib/methodConfig';
import { stepRoleActions } from '../../lib/methodToml';
import { rolesFromError, rolesFromTarget, setRolesFrom, stepDisplayName } from '../../lib/methodSteps';
import type { ParameterCatalog } from '../../lib/baselineRoles';
import { actionTarget, ruleDomId, tableActionCount, type ChemexError } from '../../lib/resolvedRoles';
import SelectorBuilder from './SelectorBuilder';
import ConstraintEditor from './ConstraintEditor';

interface StepRolesSectionProps {
  step: Step;
  stepIdx: number;
  steps: Step[];
  onChange: (updated: Step) => void;
  readOnly?: boolean;
  /** Parameter names offered by the selector builder. */
  paramNames?: string[];
  /** ChemEx parameter catalog (qualifier values, protection). */
  catalog?: ParameterCatalog | null;
  /** ChemEx errors for this step (mapped onto rule entries where possible). */
  chemexErrors?: ChemexError[];
  /** Rules to highlight (e.g. from the parameter table's "Mixed" link). */
  highlightedRuleIds?: Set<string>;
}

const selectCls =
  'text-xs font-mono px-2 py-1 rounded bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200 outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-60';

const ACTION_CLS: Record<RoleAction, string> = {
  FIT: 'text-blue-600 dark:text-blue-400',
  FIX: 'text-slate-600 dark:text-slate-300',
  CONSTRAIN: 'text-purple-600 dark:text-purple-400',
};

export const StepRolesSection: React.FC<StepRolesSectionProps> = ({
  step,
  stepIdx,
  steps,
  onChange,
  readOnly = false,
  paramNames = [],
  catalog,
  chemexErrors = [],
  highlightedRuleIds,
}) => {
  const rules = useMemo(() => step.roleRules ?? [], [step.roleRules]);
  const [isOpen, setIsOpen] = useState(true);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);
  /** Dragging starts only from the grip, so text selection inside entries never drags the rule. */
  const [armedId, setArmedId] = useState<string | null>(null);
  const rolesFrom = rolesFromTarget(steps, stepIdx);
  const rolesFromMsg = rolesFromError(steps, stepIdx);
  const currentRef = step.rolesFromStepId ?? (step.rolesFrom ? `name:${step.rolesFrom}` : '');
  const BROKEN_LABEL: Record<string, string> = { missing: 'deleted step', forward: 'later step', self: 'this step' };

  // A highlight request (e.g. from the table's "Mixed" link) always shows the rules.
  const open = isOpen || (highlightedRuleIds?.size ?? 0) > 0;

  const setRules = (next: RoleRule[]) => onChange({ ...step, roleRules: next });
  const updateRule = (id: string, patch: Partial<RoleRule>) => setRules(rules.map(r => (r.id === id ? { ...r, ...patch } : r)));
  const moveRule = (from: number, to: number) => {
    if (to < 0 || to >= rules.length || from === to) return;
    const next = [...rules];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setRules(next);
  };

  const tableActions = stepRoleActions(step).slice(0, tableActionCount(step));
  const tableCount = tableActions.length;

  // ChemEx errors → table actions / rule entries / unplaced.
  const { tableErrors, entryErrors, ruleErrors } = useMemo(() => {
    const tableErrs: string[] = [];
    const entry = new Map<string, string>(); // `${ruleId}:${entryIndex}` → message
    const rule = new Map<string, string>();
    for (const err of chemexErrors) {
      const ai = err.source?.action_index;
      if (ai === undefined) continue;
      const target = actionTarget(step, ai, err.source?.entry_index ?? 0);
      if (!target) continue;
      if (target.kind === 'table') tableErrs.push(`#${ai + 1} ${target.action}${target.entry ? ` "${target.entry}"` : ''}: ${err.message}`);
      else if (err.source?.entry_index !== undefined) entry.set(`${target.ruleId}:${target.entryIndex}`, err.message);
      else rule.set(target.ruleId, err.message);
    }
    return { tableErrors: tableErrs, entryErrors: entry, ruleErrors: rule };
  }, [chemexErrors, step]);

  const addRule = (action: RoleAction) => setRules([...rules, { id: newMethodId('rule'), action, entries: [''] }]);

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-sm" id={`roles-${step.id}`}>
      <div className="p-3.5 bg-slate-50/80 dark:bg-slate-800/60 flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setIsOpen(!open)}
          aria-expanded={open}
          className="flex items-center gap-2 text-xs font-bold text-slate-700 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400"
        >
          {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          <ListOrdered className="w-4 h-4 text-indigo-500" />
          <span>Ordered Roles (ROLES) — applied top to bottom, later entries win</span>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300 font-mono font-bold">
            {rolesFrom.status === 'none' ? 'baseline' : `from ${rolesFrom.name}${rolesFrom.status === 'ok' ? '' : ' ⚠'}`} · {tableCount + rules.filter(r => r.entries.some(e => e.trim())).length} actions
          </span>
        </button>
      </div>

      {open && (
        <div className="p-4 space-y-4 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <label className="font-semibold text-slate-600 dark:text-slate-300" htmlFor={`roles-from-${step.id}`}>
              Start roles from:
            </label>
            <select
              id={`roles-from-${step.id}`}
              disabled={readOnly || stepIdx === 0}
              value={currentRef}
              onChange={e => {
                const k = steps.findIndex(s => s.id === e.target.value);
                onChange(setRolesFrom(step, k === -1 ? undefined : steps[k], k));
              }}
              className={`${selectCls} w-56 ${rolesFromMsg ? 'border-red-400 dark:border-red-500' : ''}`}
            >
              <option value="">Baseline model roles</option>
              {steps.slice(0, stepIdx).map((s, i) => (
                <option key={s.id} value={s.id}>
                  {i + 1}. {stepDisplayName(s, i)}
                </option>
              ))}
              {rolesFrom.status !== 'none' && rolesFrom.status !== 'ok' && (
                <option value={currentRef}>
                  ⚠ {rolesFrom.name ?? 'unknown'} ({BROKEN_LABEL[rolesFrom.status]})
                </option>
              )}
            </select>
            {rolesFromMsg && <p className="w-full text-[11px] text-red-600 dark:text-red-400">{rolesFromMsg}</p>}
            <span className="text-[11px] text-slate-400 dark:text-slate-500 max-w-xl">
              Copies only roles and constraints — not values, residue selection, search, statistics or seeds. Values always continue from the
              latest committed fit.
            </span>
          </div>

          <ol className="space-y-2" aria-label="Ordered ROLES actions">
            {tableCount > 0 && (
              <li className="p-2 rounded-lg border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/30">
                <div className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 mb-1">From the parameter table (applied first)</div>
                <ul className="space-y-0.5">
                  {tableActions.map((a, i) => (
                    <li key={a.action} className="flex items-start gap-2 font-mono">
                      <span className="text-slate-400 w-6 text-right">{i + 1}.</span>
                      <span className={`font-bold w-20 ${ACTION_CLS[a.action]}`}>{a.action}</span>
                      <span className="text-slate-700 dark:text-slate-300 break-all">{a.entries.join(', ')}</span>
                    </li>
                  ))}
                </ul>
                {tableErrors.map(m => (
                  <p key={m} className="mt-1 text-[11px] text-red-600 dark:text-red-400">
                    {m}
                  </p>
                ))}
              </li>
            )}

            {rules.map((rule, idx) => {
              const n = tableCount + idx + 1;
              const highlighted = highlightedRuleIds?.has(rule.id);
              const ruleErr = ruleErrors.get(rule.id);
              return (
                <li
                  key={rule.id}
                  id={ruleDomId(rule.id)}
                  draggable={!readOnly && armedId === rule.id}
                  onDragStart={e => {
                    setDragIdx(idx);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', rule.id);
                  }}
                  onDragOver={e => {
                    if (dragIdx === null) return;
                    e.preventDefault();
                    setDropIdx(idx);
                  }}
                  onDragLeave={() => setDropIdx(null)}
                  onDrop={e => {
                    e.preventDefault();
                    if (dragIdx !== null) moveRule(dragIdx, idx);
                    setDragIdx(null);
                    setDropIdx(null);
                  }}
                  onDragEnd={() => {
                    setDragIdx(null);
                    setDropIdx(null);
                    setArmedId(null);
                  }}
                  className={`flex items-start gap-2 p-2 rounded-lg border transition-all ${
                    highlighted
                      ? 'border-amber-400 ring-2 ring-amber-300/60 bg-amber-50/60 dark:bg-amber-900/20 dark:border-amber-600'
                      : dropIdx === idx && dragIdx !== idx
                        ? 'border-blue-400 bg-blue-50/50 dark:bg-blue-900/20'
                        : 'border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800/30'
                  } ${dragIdx === idx ? 'opacity-50' : ''}`}
                >
                  {!readOnly && (
                    <span
                      className="pt-1 cursor-grab active:cursor-grabbing text-slate-400"
                      title="Drag to change precedence"
                      onMouseDown={() => setArmedId(rule.id)}
                      onMouseUp={() => setArmedId(null)}
                    >
                      <GripVertical className="w-3.5 h-3.5" />
                    </span>
                  )}
                  <span className="pt-1 font-mono text-slate-400 w-6 text-right" aria-label={`ROLES entry ${n}`}>
                    {n}.
                  </span>
                  <select
                    aria-label={`Action of rule ${n}`}
                    disabled={readOnly}
                    value={rule.action}
                    onChange={e => updateRule(rule.id, { action: e.target.value as RoleAction })}
                    className={`${selectCls} w-28 font-bold ${ACTION_CLS[rule.action]}`}
                  >
                    <option value="FIT">FIT</option>
                    <option value="FIX">FIX</option>
                    <option value="CONSTRAIN">CONSTRAIN</option>
                  </select>

                  <div className="flex-grow min-w-0 space-y-1.5">
                    {rule.entries.map((entry, ei) => {
                      const ext = entryErrors.get(`${rule.id}:${ei}`) ?? null;
                      const setEntry = (v: string) => updateRule(rule.id, { entries: rule.entries.map((x, k) => (k === ei ? v : x)) });
                      return (
                        <div key={ei} className="flex items-start gap-1">
                          {rule.action === 'CONSTRAIN' ? (
                            <ConstraintEditor value={entry} onChange={setEntry} paramNames={paramNames} catalog={catalog} readOnly={readOnly} externalError={ext} />
                          ) : (
                            <SelectorBuilder
                              value={entry}
                              onChange={setEntry}
                              paramNames={paramNames}
                              catalog={catalog}
                              purpose={rule.action}
                              readOnly={readOnly}
                              externalError={ext}
                              ariaLabel={`Rule ${n} selector ${ei + 1}`}
                            />
                          )}
                          {!readOnly && rule.entries.length > 1 && (
                            <button
                              type="button"
                              aria-label={`Remove entry ${ei + 1} of rule ${n}`}
                              onClick={() => updateRule(rule.id, { entries: rule.entries.filter((_, k) => k !== ei) })}
                              className="p-1 text-slate-400 hover:text-red-500"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      );
                    })}
                    {!readOnly && (
                      <button
                        type="button"
                        onClick={() => updateRule(rule.id, { entries: [...rule.entries, ''] })}
                        className="flex items-center gap-1 text-[11px] text-slate-500 hover:text-blue-600"
                      >
                        <Plus className="w-3 h-3" /> {rule.action === 'CONSTRAIN' ? 'equation' : 'selector'}
                      </button>
                    )}
                    {ruleErr && <p className="text-[11px] text-red-600 dark:text-red-400">{ruleErr}</p>}
                  </div>

                  {!readOnly && (
                    <div className="flex flex-col">
                      <button type="button" onClick={() => moveRule(idx, idx - 1)} disabled={idx === 0} className="p-1 text-slate-400 hover:text-blue-500 disabled:opacity-30" aria-label={`Move rule ${n} up`}>
                        <ChevronUp className="w-3.5 h-3.5" />
                      </button>
                      <button type="button" onClick={() => moveRule(idx, idx + 1)} disabled={idx === rules.length - 1} className="p-1 text-slate-400 hover:text-blue-500 disabled:opacity-30" aria-label={`Move rule ${n} down`}>
                        <ChevronDown className="w-3.5 h-3.5" />
                      </button>
                      <button type="button" onClick={() => setRules(rules.filter(r => r.id !== rule.id))} className="p-1 text-slate-400 hover:text-red-500" aria-label={`Delete rule ${n}`}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>

          {!readOnly && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-slate-500 dark:text-slate-400">Add rule:</span>
              {(['FIT', 'FIX', 'CONSTRAIN'] as RoleAction[]).map(a => (
                <button
                  key={a}
                  type="button"
                  onClick={() => addRule(a)}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded-lg border border-dashed border-slate-300 dark:border-slate-700 hover:border-blue-400 font-mono font-bold ${ACTION_CLS[a]}`}
                >
                  <Plus className="w-3 h-3" />
                  {a}
                </button>
              ))}
              <span className="text-[11px] text-slate-400 dark:text-slate-500">
                e.g. FIX all DW_AB in the table, then FIT <code className="font-mono">DW_AB, NUC-&gt;G24N-H</code> here.
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default StepRolesSection;
