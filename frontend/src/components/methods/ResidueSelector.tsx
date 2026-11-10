import React, { useEffect, useRef, useState, useMemo } from 'react';
import { Bookmark, Trash2 } from 'lucide-react';
import { CHIP_METRIC_LABEL, shadeOf, type ChipMetric } from '../../lib/residueMetrics';
import { SpinSystemKey } from '../../lib/spinSystem';
import {
  Check,
  Search,
  CheckSquare,
  Square,
  RotateCcw,
  AlertTriangle,
  Layers,
  Copy,
  Globe,
} from 'lucide-react';

import { resolveNumericRange } from '../../lib/spinSystem';
import { residueChipLabel, residueMatches, sortResidueItems, type ResidueItem } from '../../lib/residueSelection';

export type { ResidueItem } from '../../lib/residueSelection';

export type SelectionMode = 'all' | 'include' | 'exclude';

interface ResidueSelectorProps {
  residues: ResidueItem[];
  mode: SelectionMode;
  selectedIds: string[];
  onModeChange: (mode: SelectionMode) => void;
  onSelectionChange: (selectedIds: string[]) => void;
  readOnly?: boolean;
  /** Copy the previous step's selection (mode + residues); absent on the first step. */
  onCopyFromPrevious?: () => void;
  previousStepName?: string;
  /** Residue types are known (from assignment names or the project sequence): enables type search. */
  residueTypesKnown?: boolean;
  /** Offer "Import sequence" when residue types are unknown. */
  onImportSequence?: () => void;
  /** Chip shading: available metrics, the active one and its value per chip id. */
  metric?: { options: ChipMetric[]; active: ChipMetric | null; values: Record<string, number>; onChange: (m: ChipMetric | null) => void };
  /** Residue preview shown after hovering a chip (lazy: rendered only for the hovered residue). */
  renderPreview?: (item: ResidueItem) => React.ReactNode;
  /** Residue numbers absent from the data (prolines, unassigned) shown as faint placeholders. */
  gaps?: number[];
  /** Project-level named selections (resoFlow-only; the TOML still lists residues). */
  namedSelections?: Array<{ id: string; name: string; residues: string[] }>;
  onSaveSelection?: (name: string, residues: string[]) => void;
  onDeleteSelection?: (id: string) => void;
}

const HOVER_DELAY_MS = 300;

export const ResidueSelector: React.FC<ResidueSelectorProps> = ({
  residues,
  mode,
  selectedIds,
  onModeChange,
  onSelectionChange,
  readOnly = false,
  onCopyFromPrevious,
  previousStepName,
  residueTypesKnown = false,
  onImportSequence,
  metric,
  renderPreview,
  gaps = [],
  namedSelections = [],
  onSaveSelection,
  onDeleteSelection,
}) => {
  const [showGaps, setShowGaps] = useState(true);
  const [hovered, setHovered] = useState<ResidueItem | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const [selectionName, setSelectionName] = useState('');
  const [showSelections, setShowSelections] = useState(false);
  useEffect(() => () => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
  }, []);
  const onChipEnter = (res: ResidueItem) => {
    if (!renderPreview) return;
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => setHovered(res), HOVER_DELAY_MS);
  };
  const onChipLeave = () => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
  };
  const metricRange = useMemo(() => {
    const vals = Object.values(metric?.values ?? {});
    return vals.length ? { min: Math.min(...vals), max: Math.max(...vals) } : null;
  }, [metric?.values]);
  const fmtMetric = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3));
  const [filterText, setFilterText] = useState('');
  const [onlyMinor, setOnlyMinor] = useState(false);
  /** Pick data (a picked minor-state shift) exists for at least one residue. */
  const hasMinorData = residues.some(r => r.hasMinorPick !== undefined);
  const [rangeInput, setRangeInput] = useState('');
  const [rangeError, setRangeError] = useState('');
  const [lastClickedIndex, setLastClickedIndex] = useState<number | null>(null);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  // Natural residue order ("3N" before "39N"), then the search filter.
  const sortedResidues = useMemo(() => sortResidueItems(residues), [residues]);
  const visibleResidues = useMemo(
    () =>
      sortedResidues.filter(r => (!filterText.trim() || residueMatches(r, filterText)) && (!onlyMinor || r.hasMinorPick)),
    [sortedResidues, filterText, onlyMinor]
  );
  const filtering = !!filterText.trim() || onlyMinor;

  // Valid selectable residues (having data)
  const availableResidues = useMemo(() => sortedResidues.filter(r => r.hasData), [sortedResidues]);

  // Emit selections in natural residue order so INCLUDE/EXCLUDE read like the chips.
  const orderOf = useMemo(() => new Map(sortedResidues.map((r, i) => [r.id, i])), [sortedResidues]);
  const emitSelection = (ids: Iterable<string>) =>
    onSelectionChange(
      Array.from(ids).sort((a, b) => (orderOf.get(a) ?? Number.MAX_SAFE_INTEGER) - (orderOf.get(b) ?? Number.MAX_SAFE_INTEGER))
    );

  // Toggle single residue
  const toggleResidue = (res: ResidueItem, index: number, isShiftKey: boolean) => {
    if (readOnly || !res.hasData) return;

    if (isShiftKey && lastClickedIndex !== null) {
      // Contiguous span selection
      const start = Math.min(lastClickedIndex, index);
      const end = Math.max(lastClickedIndex, index);
      const spanResidues = visibleResidues.slice(start, end + 1).filter(r => r.hasData);

      const nextSet = new Set(selectedSet);
      // If the clicked item is already selected, unselect span; else select span
      const shouldSelect = !selectedSet.has(res.id);
      for (const item of spanResidues) {
        if (shouldSelect) {
          nextSet.add(item.id);
        } else {
          nextSet.delete(item.id);
        }
      }
      emitSelection(nextSet);
    } else {
      const nextSet = new Set(selectedSet);
      if (nextSet.has(res.id)) {
        nextSet.delete(res.id);
      } else {
        nextSet.add(res.id);
      }
      emitSelection(nextSet);
    }

    setLastClickedIndex(index);
  };

  // Bulk Actions
  const handleSelectAll = () => {
    if (readOnly) return;
    // With a filter active, "All" adds what is shown (e.g. only residues with a picked dip).
    const targets = filtering ? visibleResidues.filter(r => r.hasData) : availableResidues;
    emitSelection(new Set([...selectedSet, ...targets.map(r => r.id)]));
  };

  const handleSelectNone = () => {
    if (readOnly) return;
    onSelectionChange([]);
  };

  const handleInvert = () => {
    if (readOnly) return;
    const nextIds = availableResidues
      .filter(r => !selectedSet.has(r.id))
      .map(r => r.id);
    emitSelection(nextIds);
  };

  // Range parser: e.g. "13-15, 25, 40-44" using typed spinSystem
  const handleApplyRange = (e: React.FormEvent) => {
    e.preventDefault();
    if (readOnly || !rangeInput.trim()) return;

    setRangeError('');
    const { matched, unmatched } = resolveNumericRange(
      rangeInput,
      availableResidues.map(r => r.id)
    );

    if (unmatched.length > 0) {
      setRangeError(`Unrecognized range tokens: ${unmatched.join(', ')}`);
    }

    const nextSet = new Set(selectedSet);
    for (const id of matched) {
      nextSet.add(id);
    }
    emitSelection(nextSet);
    setRangeInput('');
  };

  return (
    <section aria-label="Residue selection" className="space-y-4 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 shadow-sm">
      {/* Top Header & Mode Toggle */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-100 dark:border-slate-800 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-bold text-slate-900 dark:text-white">
              Residue Selection for this Step
            </h4>
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-200">
              {mode === 'all' ? `All ${availableResidues.length} profiles` : `${selectedIds.length} of ${availableResidues.length} ${mode === 'include' ? 'included' : 'excluded'}`}
            </span>
          </div>
          <p className="text-xs text-slate-900 dark:text-slate-200 mt-0.5">
            {mode === 'all'
              ? 'No INCLUDE/EXCLUDE: every profile is fitted in this step. Selection is never inherited from other steps.'
              : mode === 'include'
                ? 'Only the selected residues are fitted in this step (INCLUDE).'
                : 'The selected residues are left out of this step (EXCLUDE).'}
          </p>
          {mode === 'include' && selectedIds.length === 0 && (
            <p className="text-xs text-red-600 dark:text-red-500 mt-0.5">INCLUDE is empty: no profiles would be fitted. Select residues or choose "All profiles".</p>
          )}
        </div>

        <div className="flex flex-col items-end gap-1.5">
          {/* Segmented Mode Control */}
          <div className="inline-flex rounded-lg bg-slate-100 dark:bg-slate-800 p-1 border border-slate-200 dark:border-slate-700" role="radiogroup" aria-label="Profile selection">
            {([
              { m: 'all', label: 'All profiles', icon: Globe, on: 'bg-blue-500 text-white shadow-sm' },
              { m: 'include', label: 'Include only these', icon: Layers, on: 'bg-emerald-500 text-white shadow-sm' },
              { m: 'exclude', label: 'Exclude these', icon: AlertTriangle, on: 'bg-red-500 text-white shadow-sm' },
            ] as const).map(({ m, label, icon: Icon, on }) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                disabled={readOnly}
                onClick={() => onModeChange(m)}
                className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all flex items-center gap-1.5 ${
                  mode === m ? on : 'text-slate-900 dark:text-slate-200 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{label}</span>
              </button>
            ))}
          </div>
          {onCopyFromPrevious && !readOnly && (
            <button
              type="button"
              onClick={onCopyFromPrevious}
              className="flex items-center gap-1 text-xs text-slate-900 dark:text-slate-200 hover:text-blue-600"
              title="Selection is step-local in ChemEx v2; this copies the previous step's INCLUDE/EXCLUDE once"
            >
              <Copy className="w-3 h-3" /> Copy from previous step{previousStepName ? ` (${previousStepName})` : ''}
            </button>
          )}
        </div>
      </div>

      {mode !== 'all' && (<>
      {/* Toolbar: Search, Range Quick-Select, Bulk Buttons */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-center">
        {/* Search Input */}
        <div className="md:col-span-4 relative">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-900" />
          <input
            type="text"
            value={filterText}
            onChange={e => setFilterText(e.target.value)}
            placeholder={residueTypesKnown ? 'Search residues (e.g. 14, G14, Gly)...' : 'Search residues by number (e.g. 14)...'}
            className="w-full text-xs pl-8 pr-3 py-1.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-200 outline-none focus:ring-1 focus:ring-blue-500"
          />
          {!residueTypesKnown && onImportSequence && !readOnly && (
            <button
              type="button"
              onClick={onImportSequence}
              className="mt-1 block text-xs text-blue-700 dark:text-blue-700 hover:underline"
              title="Residue names in the data carry no residue type. Import the protein sequence to label chips G14 and search by type."
            >
              Import sequence…
            </button>
          )}
          {hasMinorData && (
            <label className="mt-1 flex items-center gap-1.5 text-xs text-slate-900 dark:text-slate-200 cursor-pointer" title="Residues where a minor-state (B) shift was picked in Pick CEST">
              <input type="checkbox" checked={onlyMinor} onChange={e => setOnlyMinor(e.target.checked)} />
              Only residues with a picked minor-state dip
            </label>
          )}
        </div>

        {/* Range Input Form */}
        <form onSubmit={handleApplyRange} className="md:col-span-5 flex items-center gap-2">
          <input
            type="text"
            disabled={readOnly}
            value={rangeInput}
            onChange={e => setRangeInput(e.target.value)}
            placeholder="Range: 13-15, 25, 40-44"
            className="flex-grow text-xs font-mono px-3 py-1.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-200 outline-none focus:ring-1 focus:ring-blue-500"
          />
          <button
            type="submit"
            disabled={readOnly || !rangeInput.trim()}
            className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-900 dark:text-slate-200 text-xs font-bold rounded-lg border border-slate-200 dark:border-slate-700 whitespace-nowrap disabled:opacity-50 transition-colors"
          >
            Add Range
          </button>
        </form>

        {/* Bulk Action Buttons */}
        <div className="md:col-span-3 flex items-center justify-end gap-1.5">
          <button
            type="button"
            disabled={readOnly}
            onClick={handleSelectAll}
            className="p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-900 dark:text-slate-200 text-xs font-semibold flex items-center gap-1 border border-slate-200 dark:border-slate-700"
            title={filtering ? "Add the residues shown by the filter" : "Select all residues with data"}
          >
            <CheckSquare className="w-3.5 h-3.5" />
            <span>All</span>
          </button>
          <button
            type="button"
            disabled={readOnly}
            onClick={handleSelectNone}
            className="p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-900 dark:text-slate-200 text-xs font-semibold flex items-center gap-1 border border-slate-200 dark:border-slate-700"
            title="Clear Selection"
          >
            <Square className="w-3.5 h-3.5" />
            <span>None</span>
          </button>
          <button
            type="button"
            disabled={readOnly}
            onClick={handleInvert}
            className="p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-900 dark:text-slate-200 text-xs font-semibold flex items-center gap-1 border border-slate-200 dark:border-slate-700"
            title="Invert Selection"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Invert</span>
          </button>
        </div>
      </div>

      {rangeError && (
        <div className="text-xs text-amber-800 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 p-2 rounded-lg">
          {rangeError}
        </div>
      )}

      {/* Named selections, shading legend, gap toggle, hover preview */}
      <div className="flex flex-wrap items-start gap-3 text-xs text-slate-900 dark:text-slate-200">
        {(onSaveSelection || namedSelections.length > 0) && (
          <div className="relative">
            <button
              type="button"
              aria-expanded={showSelections}
              onClick={() => setShowSelections(v => !v)}
              className="flex items-center gap-1 px-2 py-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 font-semibold hover:bg-slate-100 dark:hover:bg-slate-700"
            >
              <Bookmark className="w-3.5 h-3.5" /> Selections ({namedSelections.length})
            </button>
            {showSelections && (
              <div role="menu" aria-label="Named selections" className="absolute z-30 mt-1 w-72 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-lg p-2 space-y-1">
                {namedSelections.length === 0 && <p className="text-slate-900 dark:text-slate-200">No saved selections in this project yet.</p>}
                {namedSelections.map(sel => {
                  const usable = sel.residues.filter(r => availableResidues.some(a => a.id === r));
                  return (
                    <div key={sel.id} className="flex items-center gap-1">
                      <button
                        type="button"
                        role="menuitem"
                        disabled={readOnly || usable.length === 0}
                        onClick={() => {
                          emitSelection(usable);
                          setShowSelections(false);
                        }}
                        className="flex-1 text-left px-2 py-1 rounded hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-50"
                        title={sel.residues.join(', ')}
                      >
                        <span className="font-semibold">{sel.name}</span>{' '}
                        <span className="text-slate-900 dark:text-slate-200">
                          {usable.length}/{sel.residues.length} res
                        </span>
                      </button>
                      {onDeleteSelection && !readOnly && (
                        <button type="button" aria-label={`Delete selection ${sel.name}`} onClick={() => onDeleteSelection(sel.id)} className="p-1 text-slate-900 hover:text-red-600">
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  );
                })}
                {onSaveSelection && !readOnly && (
                  <form
                    className="flex items-center gap-1 pt-1 border-t border-slate-100 dark:border-slate-700"
                    onSubmit={e => {
                      e.preventDefault();
                      const name = selectionName.trim();
                      if (!name || selectedIds.length === 0) return;
                      onSaveSelection(name, selectedIds);
                      setSelectionName('');
                    }}
                  >
                    <input
                      aria-label="Selection name"
                      value={selectionName}
                      onChange={e => setSelectionName(e.target.value)}
                      placeholder={selectedIds.length ? 'Name, e.g. dip residues' : 'Select residues first'}
                      disabled={selectedIds.length === 0}
                      className="flex-1 min-w-0 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900"
                    />
                    <button type="submit" disabled={!selectionName.trim() || selectedIds.length === 0} className="px-2 py-1 rounded bg-blue-600 text-white font-semibold disabled:opacity-50">
                      Save
                    </button>
                  </form>
                )}
              </div>
            )}
          </div>
        )}
        {metric && metric.options.length > 0 && (
          <div className="flex flex-wrap items-center gap-2" aria-label="Chip shading legend">
            <label className="flex items-center gap-1">
              Shade by
              <select
                aria-label="Shade chips by"
                value={metric.active ?? ''}
                onChange={e => metric.onChange((e.target.value || null) as ChipMetric | null)}
                className="px-1.5 py-0.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
              >
                <option value="">none</option>
                {metric.options.map(m => (
                  <option key={m} value={m}>
                    {CHIP_METRIC_LABEL[m]}
                  </option>
                ))}
              </select>
            </label>
            {metric.active && metricRange && (
              <span className="flex items-center gap-1">
                <span className="font-mono">{fmtMetric(metricRange.min)}</span>
                <span className="inline-block w-20 h-2 rounded" style={{ background: 'linear-gradient(to right, rgba(99,102,241,0.15), rgba(99,102,241,1))' }} />
                <span className="font-mono">{fmtMetric(metricRange.max)}</span>
              </span>
            )}
          </div>
        )}
        {gaps.length > 0 && (
          <label className="flex items-center gap-1 cursor-pointer">
            <input type="checkbox" checked={showGaps} onChange={e => setShowGaps(e.target.checked)} />
            Show gaps ({gaps.length})
          </label>
        )}
        {renderPreview && hovered && (
          <div className="ml-auto flex items-center gap-2" data-testid="residue-preview">
            <span className="font-mono font-semibold">{residueChipLabel(hovered)}</span>
            {renderPreview(hovered)}
          </div>
        )}
      </div>

      {/* Chip Grid with Accessible Checkmarks & Shift-click Contiguous Select */}
      <div className="flex flex-wrap gap-2 p-2 rounded-xl bg-slate-50/75 dark:bg-slate-800/40 border border-slate-200/80 dark:border-slate-700/80 max-h-72 overflow-y-auto">
        {visibleResidues.length === 0 ? (
          <div className="w-full text-center py-6 text-xs text-slate-900">
            No residues match the current filter.
          </div>
        ) : (
          interleaveGaps(visibleResidues, showGaps && !filtering ? gaps : []).map(entry => {
            if (entry.kind === 'gap') {
              return (
                <span
                  key={`gap-${entry.n}`}
                  data-testid="gap-chip"
                  aria-hidden="true"
                  title={`${entry.n}: no data (e.g. proline or unassigned)`}
                  className="px-2.5 py-1.5 rounded-lg text-xs font-mono border border-dashed border-slate-300 dark:border-slate-600 text-slate-900 dark:text-slate-200 select-none"
                >
                  {entry.n}
                </span>
              );
            }
            const { res, idx } = entry;
            const isSelected = selectedSet.has(res.id);
            const isDisabled = !res.hasData;

            let chipCls = '';
            if (isDisabled) {
              chipCls =
                'bg-slate-100 dark:bg-slate-800/50 text-slate-900 dark:text-slate-200 border-slate-200 dark:border-slate-800 cursor-not-allowed line-through';
            } else if (isSelected) {
              chipCls =
                mode === 'include'
                  ? 'bg-emerald-500 hover:bg-emerald-600 text-white border-emerald-600 shadow-sm'
                  : 'bg-red-500 hover:bg-red-600 text-white border-red-600 shadow-sm';
            } else {
              chipCls =
                'bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-900 dark:text-slate-200 border-slate-200 dark:border-slate-700';
            }

            const mv = metric?.active ? metric.values[res.id] : undefined;
            const shade = mv !== undefined && metricRange ? shadeOf(mv, metricRange.min, metricRange.max) : null;
            return (
              <button
                key={res.id}
                type="button"
                disabled={readOnly || isDisabled}
                onClick={e => toggleResidue(res, idx, e.shiftKey)}
                onMouseEnter={() => onChipEnter(res)}
                onMouseLeave={onChipLeave}
                onFocus={() => onChipEnter(res)}
                data-shade={shade === null ? undefined : shade.toFixed(2)}
                style={shade === null ? undefined : { boxShadow: `inset 0 -4px 0 rgba(99,102,241,${(0.15 + 0.85 * shade).toFixed(2)})` }}
                title={
                  (isDisabled
                    ? `${res.label}: No experimental data found`
                    : `${res.label}: Click to toggle, Shift+Click for range`) +
                  (mv !== undefined && metric?.active ? ` · ${CHIP_METRIC_LABEL[metric.active]}: ${fmtMetric(mv)}` : '')
                }
                className={`px-2.5 py-1.5 rounded-lg text-xs font-mono font-bold transition-all border flex items-center gap-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500/50 ${chipCls}`}
              >
                {isSelected && <Check className="w-3.5 h-3.5 stroke-[2.5]" />}
                <span>{residueChipLabel(res)}</span>
              </button>
            );
          })
        )}
      </div>
      </>)}
    </section>
  );
};
type ChipEntry = { kind: 'chip'; res: ResidueItem; idx: number } | { kind: 'gap'; n: number };

/** Chips (with their index among visible residues) interleaved with gap placeholders in residue order. */
function interleaveGaps(residues: ResidueItem[], gaps: number[]): ChipEntry[] {
  const chips: ChipEntry[] = residues.map((res, idx) => ({ kind: 'chip', res, idx }));
  if (gaps.length === 0) return chips;
  const num = (e: ChipEntry) => (e.kind === 'gap' ? e.n : SpinSystemKey.parse(e.res.id).resNum || e.res.number);
  const all: ChipEntry[] = [...chips, ...gaps.map(n => ({ kind: 'gap' as const, n }))];
  // Stable: gaps sort before chips with the same number only when no chip has it (by construction).
  return all
    .map((e, i) => ({ e, i }))
    .sort((a, b) => num(a.e) - num(b.e) || a.i - b.i)
    .map(x => x.e);
}

export default ResidueSelector;
