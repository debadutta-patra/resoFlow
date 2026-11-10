/**
 * Method step tabs: select, rename, reorder (drag or ←/→ buttons), duplicate, delete.
 *
 * Step names are TOML keys and ChemEx output folder names, so renames are
 * validated before they commit. Badges show ChemEx-resolved counts
 * ("4 coords · 2 res"), the deterministic search, enabled statistics and errors.
 */

import type { StepResultBadge } from '../../lib/runOverview';
import React, { useState } from 'react';
import { Activity, AlertCircle, Check, ChevronLeft, ChevronRight, Copy, Edit2, GripVertical, Grid3x3, Plus, Shuffle, Trash2 } from 'lucide-react';
import type { Step } from '../../lib/methodConfig';
import { rolesFromTarget, stepDisplayName, stepNameError } from '../../lib/methodSteps';
import { stepBadgeText, type StepBadge } from '../../lib/resolvedRoles';

interface StepTabsProps {
  steps: Step[];
  activeStepIdx: number;
  onSelectStep: (idx: number) => void;
  onAddStep: () => void;
  onDuplicateStep: (idx: number) => void;
  onDeleteStep: (idx: number) => void;
  onRenameStep: (idx: number, newName: string) => void;
  onReorderSteps: (startIndex: number, endIndex: number) => void;
  readOnly?: boolean;
  /** Per step id: resolved counts, search and statistics. */
  badges?: Record<string, StepBadge>;
  /** True while the badges belong to an older version of the method. */
  badgesStale?: boolean;
  /** Per step id: number of blocking errors (validation + ChemEx). */
  errorCounts?: Record<string, number>;
  /** Step names (any case) that have results from the last completed run. */
  stepsWithResults?: Set<string>;
  /** Per step id: last completed run's outcome (status dot, red-χ², MCMC flags). */
  results?: Record<string, StepResultBadge>;
  /** Open the MCMC diagnostics of step `idx` (from its badge). */
  onOpenMcmc?: (idx: number) => void;
}

const DOT: Record<StepResultBadge['state'], { cls: string; label: string }> = {
  ok: { cls: 'bg-emerald-500', label: 'Completed in the last run' },
  failed: { cls: 'bg-red-500', label: 'Failed or did not commit in the last run' },
  'not-run': { cls: 'bg-slate-400 dark:bg-slate-500', label: 'Not in the last run' },
};

const fmtChi = (v: number) => (Math.abs(v) >= 1e4 ? v.toExponential(2) : v.toFixed(2));

/** Status dot, red-χ² and MCMC badges for one step tab. */
export const StepResultRow: React.FC<{ result: StepResultBadge; onOpenMcmc?: () => void; stale?: boolean }> = ({ result, onOpenMcmc, stale }) => {
  const m = result.mcmc;
  const mcmcFlag = m ? (m.withheld ? 'no posterior summary' : m.tentative ? 'tentative burn' : null) : null;
  const mcmcText = m
    ? [m.tauMax !== null ? `τmax ${m.tauMax.toFixed(1)}` : null, m.essWithheld ? 'ESS withheld' : m.essMin !== null ? `ESS ${Math.round(m.essMin)}` : null]
        .filter(Boolean)
        .join(' · ')
    : '';
  return (
    <div className={`flex flex-wrap items-center gap-1.5 text-xs font-normal ${stale ? 'opacity-60' : ''}`} data-testid="step-result">
      <span className={`inline-block w-2 h-2 rounded-full ${DOT[result.state].cls}`} title={DOT[result.state].label} aria-label={DOT[result.state].label} />
      {result.redchi !== null && <span className="font-mono text-slate-900 dark:text-slate-200" title="Reduced χ² of the last run">χ²ᵣ {fmtChi(result.redchi)}</span>}
      {m && (
        <button
          type="button"
          onClick={e => {
            e.stopPropagation();
            onOpenMcmc?.();
          }}
          disabled={!onOpenMcmc}
          title={`MCMC diagnostics${mcmcFlag ? ` — ${mcmcFlag}` : ''}`}
          className={`px-1.5 py-0.5 rounded font-mono border ${
            mcmcFlag
              ? 'bg-amber-50 text-amber-900 border-amber-200 dark:text-amber-700 dark:border-amber-300'
              : 'bg-purple-50 text-purple-800 border-purple-200 dark:bg-purple-900/30 dark:text-purple-200 dark:border-purple-700'
          } hover:underline disabled:no-underline`}
        >
          {mcmcText || 'MCMC'}
          {mcmcFlag && <span className="font-sans font-semibold"> · {mcmcFlag}</span>}
        </button>
      )}
    </div>
  );
};

const iconBtn = 'p-1 hover:bg-slate-200 dark:hover:bg-slate-700 rounded text-slate-900 disabled:opacity-30 disabled:cursor-not-allowed';

export const StepTabs: React.FC<StepTabsProps> = ({
  steps,
  activeStepIdx,
  onSelectStep,
  onAddStep,
  onDuplicateStep,
  onDeleteStep,
  onRenameStep,
  onReorderSteps,
  readOnly = false,
  badges = {},
  badgesStale = false,
  errorCounts = {},
  stepsWithResults,
  results,
  onOpenMcmc,
}) => {
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [tempName, setTempName] = useState('');
  const [draggedIdx, setDraggedIdx] = useState<number | null>(null);

  const hasResults = (name: string) => !!stepsWithResults && [...stepsWithResults].some(n => n.toLowerCase() === name.toLowerCase());
  const renameError = editingIdx === null ? null : stepNameError(tempName, steps, editingIdx);

  const startRename = (idx: number) => {
    if (readOnly) return;
    setEditingIdx(idx);
    setTempName(stepDisplayName(steps[idx], idx));
  };
  const cancelRename = () => {
    setEditingIdx(null);
    setTempName('');
  };
  const commitRename = () => {
    if (editingIdx === null) return;
    if (renameError) return; // keep editing; the message explains why
    if (tempName.trim() !== stepDisplayName(steps[editingIdx], editingIdx)) onRenameStep(editingIdx, tempName.trim());
    cancelRename();
  };

  return (
    <div className="flex items-start gap-2 overflow-x-auto pb-2 pt-1 border-b border-slate-200 dark:border-slate-800">
      <div className="flex flex-wrap items-start gap-1.5 flex-grow" role="tablist" aria-label="Method steps">
        {steps.map((step, idx) => {
          const isActive = idx === activeStepIdx;
          const name = stepDisplayName(step, idx);
          const badge = badges[step.id];
          const badgeText = badge ? stepBadgeText(badge) : null;
          const errors = errorCounts[step.id] ?? 0;
          // Steps whose ROLES_FROM targets this one (deleting it leaves them with a visible error).
          const dependents = steps.flatMap((s, i) => (i !== idx && rolesFromTarget(steps, i).index === idx ? [stepDisplayName(s, i)] : []));
          const editing = editingIdx === idx;

          return (
            <div
              key={step.id || idx}
              role="tab"
              aria-selected={isActive}
              draggable={!readOnly && !editing}
              onDragStart={e => {
                if (readOnly) return;
                setDraggedIdx(idx);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', String(idx));
              }}
              onDragOver={e => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
              }}
              onDrop={e => {
                e.preventDefault();
                if (draggedIdx !== null && draggedIdx !== idx) onReorderSteps(draggedIdx, idx);
                setDraggedIdx(null);
              }}
              onClick={() => {
                if (!editing) onSelectStep(idx);
              }}
              className={`group relative flex flex-col gap-0.5 px-3 py-2 rounded-xl text-xs font-semibold transition-all border cursor-pointer select-none ${
                isActive
                  ? 'bg-white dark:bg-slate-800 text-blue-700 dark:text-blue-500 border-blue-200 dark:border-blue-700/60 shadow-sm'
                  : 'bg-slate-100/70 hover:bg-slate-200/70 dark:bg-slate-900/60 dark:hover:bg-slate-800/60 text-slate-900 dark:text-slate-200 border-slate-200/80 dark:border-slate-800'
              } ${draggedIdx === idx ? 'opacity-50' : ''}`}
            >
              <div className="flex items-center gap-1.5">
                {!readOnly && (
                  <span title="Drag to reorder step">
                    <GripVertical className="w-3 h-3 text-slate-900 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity" />
                  </span>
                )}
                <span className="font-mono text-xs text-slate-900">{idx + 1}</span>

                {editing ? (
                  <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                    <input
                      type="text"
                      autoFocus
                      aria-label="Step name"
                      aria-invalid={!!renameError}
                      value={tempName}
                      onChange={e => setTempName(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') commitRename();
                        else if (e.key === 'Escape') cancelRename();
                      }}
                      onBlur={() => (renameError ? cancelRename() : commitRename())}
                      className={`font-mono text-xs px-1.5 py-0.5 rounded bg-white dark:bg-slate-900 border text-slate-900 dark:text-white outline-none w-32 ${
                        renameError ? 'border-red-500' : 'border-blue-500'
                      }`}
                    />
                    <button type="button" onMouseDown={e => e.preventDefault()} onClick={commitRename} disabled={!!renameError} className="text-emerald-800 hover:text-emerald-500 p-0.5 disabled:opacity-30" aria-label="Save step name">
                      <Check className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ) : (
                  <span onDoubleClick={() => startRename(idx)} className="font-mono tracking-wide font-bold" title="Double-click to rename">
                    {name}
                  </span>
                )}

                {errors > 0 && (
                  <span className="flex items-center gap-0.5 px-1.5 rounded-full bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-500 text-xs font-bold" title={`${errors} blocking error${errors > 1 ? 's' : ''} in this step`}>
                    <AlertCircle className="w-3 h-3" />
                    {errors}
                  </span>
                )}

                {!readOnly && !editing && (
                  <div className="flex items-center gap-0.5 ml-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    <button type="button" onClick={e => (e.stopPropagation(), onReorderSteps(idx, idx - 1))} disabled={idx === 0} className={iconBtn} aria-label={`Move ${name} earlier`} title="Move earlier">
                      <ChevronLeft className="w-3 h-3" />
                    </button>
                    <button type="button" onClick={e => (e.stopPropagation(), onReorderSteps(idx, idx + 1))} disabled={idx === steps.length - 1} className={iconBtn} aria-label={`Move ${name} later`} title="Move later">
                      <ChevronRight className="w-3 h-3" />
                    </button>
                    <button type="button" onClick={e => (e.stopPropagation(), startRename(idx))} className={`${iconBtn} hover:text-slate-600 dark:hover:text-slate-200`} aria-label={`Rename ${name}`} title="Rename step">
                      <Edit2 className="w-3 h-3" />
                    </button>
                    <button type="button" onClick={e => (e.stopPropagation(), onDuplicateStep(idx))} className={`${iconBtn} hover:text-blue-600 dark:hover:text-blue-400`} aria-label={`Duplicate ${name}`} title="Duplicate step">
                      <Copy className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      disabled={steps.length <= 1}
                      onClick={e => (e.stopPropagation(), onDeleteStep(idx))}
                      className={`${iconBtn} hover:bg-red-100 dark:hover:bg-red-900/40 hover:text-red-600 dark:hover:text-red-400`}
                      aria-label={`Delete ${name}`}
                      title={
                        steps.length <= 1
                          ? 'Cannot delete the only remaining step'
                          : dependents.length
                            ? `Delete step — ${dependents.join(', ')} take${dependents.length === 1 ? 's' : ''} ROLES_FROM from it and will show an error`
                            : 'Delete step'
                      }
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                )}
              </div>

              {/* Badges: resolved counts, search, statistics */}
              <div className={`flex items-center gap-1.5 text-xs font-mono font-normal ${badgesStale ? 'opacity-50' : ''}`}>
                <span className="text-slate-900 dark:text-slate-200" title="Independent FIT coordinates and residues in scope, as resolved by ChemEx">
                  {badgeText ?? '— coords'}
                </span>
                {badge?.coords === 0 && (
                  <span title="No FIT coordinates in this step">
                    <AlertCircle className="w-3 h-3 text-amber-800" />
                  </span>
                )}
                {badge?.search === 'grid' && (
                  <span title="SEARCH.GRID">
                    <Grid3x3 className="w-3 h-3 text-amber-800" />
                  </span>
                )}
                {badge?.search === 'de' && (
                  <span title="SEARCH.DE">
                    <Shuffle className="w-3 h-3 text-amber-800" />
                  </span>
                )}
                {badge && badge.statistics.length > 0 && (
                  <span className="flex items-center gap-0.5 text-purple-600 dark:text-purple-400" title={`Statistics: ${badge.statistics.join(', ')}`}>
                    <Activity className="w-3 h-3" />
                    {badge.statistics.join('+')}
                  </span>
                )}
              </div>

              {results?.[step.id] && results[step.id].state !== 'not-run' && (
                <StepResultRow result={results[step.id]} onOpenMcmc={onOpenMcmc ? () => onOpenMcmc(idx) : undefined} stale={badgesStale} />
              )}

              {editing && (renameError || hasResults(name)) && (
                <div className="absolute top-full left-0 mt-1 z-30 w-72 p-2 rounded-lg border shadow-lg text-xs font-normal bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700" onClick={e => e.stopPropagation()}>
                  {renameError && <p className="text-red-600 dark:text-red-500">{renameError}</p>}
                  {hasResults(name) && (
                    <p className="text-amber-800 dark:text-amber-400">
                      The last run's results for this step stay under <span className="font-mono">{name}</span>; the Results tab keeps showing them by
                      that name until you re-run.
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {!readOnly && (
          <button
            type="button"
            onClick={onAddStep}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-slate-50 hover:bg-slate-100 dark:bg-slate-900 dark:hover:bg-slate-800 text-blue-700 dark:text-blue-500 border border-dashed border-slate-300 dark:border-slate-700 hover:border-blue-400 transition-colors shadow-sm"
            title="Add a new fitting step"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Step</span>
          </button>
        )}
      </div>
    </div>
  );
};
export default StepTabs;
