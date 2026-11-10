/**
 * "Starting values ▾": every way of taking values from the last completed run into the
 * NEXT run, named by its effect on the parameters file, with an old → new preview before
 * anything is applied. Within one run ChemEx v2 already carries values between steps.
 *
 * Replaces the old "Use fitted as starting", "Use grid minimum as starting" and
 * "Continue from Run" buttons. ("Restore Last fit" swaps results, not starting values,
 * and stays a separate action.)
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, FastForward, ListRestart } from 'lucide-react';
import type { ParameterConfig } from '../../lib/parameterConfig';
import type { RunOverview } from '../../lib/runOverview';
import { fmtValue } from '../../lib/runOverview';
import {
  previewStartingValues,
  startingValueActions,
  startingValueEntries,
  type StartingValueAction,
  type StartingValuePreview,
} from '../../lib/startingValues';
import { ChemexModalShell, chemexBtnPrimary, chemexBtnSecondary } from './TomlEditorParts';

export interface StartingValuesMenuProps {
  overview: RunOverview | null;
  parameterConfig: ParameterConfig;
  onApply: (next: ParameterConfig, message: string) => void;
  /** "New analysis from this run's final state" (restart.toml); omitted when not available. */
  onContinueFromRun?: () => void;
  disabled?: boolean;
}

export const StartingValuesMenu: React.FC<StartingValuesMenuProps> = ({ overview, parameterConfig, onApply, onContinueFromRun, disabled }) => {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<{ action: StartingValueAction; preview: StartingValuePreview } | null>(null);
  const actions = useMemo(() => startingValueActions(overview), [overview]);
  const lastStep = overview?.step_order[overview.step_order.length - 1];
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  if (actions.length === 0 && !onContinueFromRun) return null;

  const choose = (action: StartingValueAction) => {
    setOpen(false);
    if (!overview) return;
    const entries = startingValueEntries(overview, action);
    const label = action.kind === 'grid' ? `last run · ${action.stepName} grid minimum` : `last run · ${action.stepName}`;
    setPending({ action, preview: previewStartingValues(parameterConfig, entries, label) });
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1 px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 disabled:opacity-50"
        title="Write values from the last completed run into the next run's parameters file"
      >
        <ListRestart className="w-3.5 h-3.5" />
        <span>Starting values</span>
        <ChevronDown className="w-3 h-3" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-40 mt-1 w-80 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-lg py-1">
          <p className="px-3 py-1.5 text-xs text-slate-600 dark:text-slate-300 border-b border-slate-100 dark:border-slate-700">
            Next run's parameters file. Within a run, every step already starts from the previous step's committed values.
          </p>
          {actions.map(a => (
            <button
              key={a.id}
              type="button"
              role="menuitem"
              onClick={() => choose(a)}
              className="w-full text-left px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-700"
              title={a.description}
            >
              <span className="block text-xs font-semibold text-slate-800 dark:text-slate-100">{a.label}</span>
            </button>
          ))}
          {onContinueFromRun && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onContinueFromRun();
              }}
              className="w-full text-left px-3 py-1.5 border-t border-slate-100 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700"
              title="Creates a new analysis whose parameters file is this run's restart.toml (the final committed state); this analysis is unchanged."
            >
              <span className="flex items-center gap-1 text-xs font-semibold text-slate-800 dark:text-slate-100">
                <FastForward className="w-3 h-3" /> New analysis with {lastStep ?? 'final'} state → parameters
              </span>
              <span className="block text-xs text-slate-600 dark:text-slate-400">Continue from Run (restart.toml)</span>
            </button>
          )}
        </div>
      )}

      {pending && (
        <ChemexModalShell
          icon={<ListRestart size={20} />}
          title={pending.action.label}
          subtitle={pending.action.description}
          onClose={() => setPending(null)}
          footer={
            <>
              <button type="button" onClick={() => setPending(null)} className={chemexBtnSecondary}>
                Cancel
              </button>
              <button
                type="button"
                disabled={pending.preview.changes.length === 0}
                className={chemexBtnPrimary}
                onClick={() => {
                  onApply(pending.preview.next, `${pending.action.label}: ${pending.preview.changes.length} value${pending.preview.changes.length === 1 ? '' : 's'} updated.`);
                  setPending(null);
                }}
              >
                Apply {pending.preview.changes.length} change{pending.preview.changes.length === 1 ? '' : 's'}
              </button>
            </>
          }
        >
          {pending.preview.changes.length === 0 ? (
            <p className="text-xs text-slate-700 dark:text-slate-300">The parameters file already holds these values.</p>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              <table className="w-full text-xs" aria-label="Starting value changes">
                <thead>
                  <tr className="text-left text-slate-600 dark:text-slate-400 border-b border-slate-200 dark:border-slate-700">
                    <th className="py-1 pr-2 font-semibold">Parameter</th>
                    <th className="py-1 pr-2 font-semibold text-right">Now</th>
                    <th className="py-1 font-semibold text-right">New</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {pending.preview.changes.map(c => (
                    <tr key={`${c.section}-${c.residue}-${c.key}`} className="border-b border-slate-100 dark:border-slate-800">
                      <td className="py-1 pr-2 text-slate-800 dark:text-slate-200">{c.label}</td>
                      <td className="py-1 pr-2 text-right text-red-700 dark:text-red-700">{c.oldValue === null ? 'unset' : fmtValue(c.oldValue)}</td>
                      <td className="py-1 text-right text-emerald-700 dark:text-emerald-700">{fmtValue(c.newValue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {pending.preview.unchanged > 0 && (
                <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">{pending.preview.unchanged} value(s) already match.</p>
              )}
            </div>
          )}
        </ChemexModalShell>
      )}
    </div>
  );
};

export default StartingValuesMenu;
