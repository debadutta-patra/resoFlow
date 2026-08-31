import React, { useState, useMemo } from 'react';
import {
  Check,
  Search,
  CheckSquare,
  Square,
  RotateCcw,
  AlertTriangle,
  Layers
} from 'lucide-react';

import { resolveNumericRange } from '../../lib/spinSystem';

export interface ResidueItem {
  id: string; // e.g. "13N", "S13N", "G2N-HN", "L3CD1-HD1"
  number: number; // e.g. 13
  label: string; // e.g. "SER13N", "S13N", "G2N-HN", "L3CD1-HD1"
  hasData: boolean;
}

interface ResidueSelectorProps {
  residues: ResidueItem[];
  mode: 'include' | 'exclude';
  selectedIds: string[];
  onModeChange: (mode: 'include' | 'exclude') => void;
  onSelectionChange: (selectedIds: string[]) => void;
  readOnly?: boolean;
}

export const ResidueSelector: React.FC<ResidueSelectorProps> = ({
  residues,
  mode,
  selectedIds,
  onModeChange,
  onSelectionChange,
  readOnly = false,
}) => {
  const [filterText, setFilterText] = useState('');
  const [rangeInput, setRangeInput] = useState('');
  const [rangeError, setRangeError] = useState('');
  const [lastClickedIndex, setLastClickedIndex] = useState<number | null>(null);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  // Filtered residues
  const visibleResidues = useMemo(() => {
    if (!filterText.trim()) return residues;
    const q = filterText.toLowerCase().trim();
    return residues.filter(
      r =>
        r.id.toLowerCase().includes(q) ||
        r.label.toLowerCase().includes(q) ||
        String(r.number).includes(q)
    );
  }, [residues, filterText]);

  // Valid selectable residues (having data)
  const availableResidues = useMemo(() => residues.filter(r => r.hasData), [residues]);

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
      onSelectionChange(Array.from(nextSet));
    } else {
      const nextSet = new Set(selectedSet);
      if (nextSet.has(res.id)) {
        nextSet.delete(res.id);
      } else {
        nextSet.add(res.id);
      }
      onSelectionChange(Array.from(nextSet));
    }

    setLastClickedIndex(index);
  };

  // Bulk Actions
  const handleSelectAll = () => {
    if (readOnly) return;
    onSelectionChange(availableResidues.map(r => r.id));
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
    onSelectionChange(nextIds);
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
    onSelectionChange(Array.from(nextSet));
    setRangeInput('');
  };

  return (
    <div className="space-y-4 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 shadow-sm">
      {/* Top Header & Mode Toggle */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-100 dark:border-slate-800 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-bold text-slate-900 dark:text-white">
              Residue Selection for this Step
            </h4>
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
              {selectedIds.length} of {availableResidues.length} selected
            </span>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            {mode === 'include'
              ? 'Only selected residues will be fitted in this step (INCLUDE key).'
              : 'Selected residues will be excluded from this step (EXCLUDE key).'}
          </p>
        </div>

        {/* Segmented Mode Control */}
        <div className="inline-flex rounded-lg bg-slate-100 dark:bg-slate-800 p-1 border border-slate-200 dark:border-slate-700">
          <button
            type="button"
            disabled={readOnly}
            onClick={() => onModeChange('include')}
            className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all flex items-center gap-1.5 ${
              mode === 'include'
                ? 'bg-emerald-500 text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            <span>Include only these</span>
          </button>
          <button
            type="button"
            disabled={readOnly}
            onClick={() => onModeChange('exclude')}
            className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all flex items-center gap-1.5 ${
              mode === 'exclude'
                ? 'bg-red-500 text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            <AlertTriangle className="w-3.5 h-3.5" />
            <span>Exclude these</span>
          </button>
        </div>
      </div>

      {/* Toolbar: Search, Range Quick-Select, Bulk Buttons */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-center">
        {/* Search Input */}
        <div className="md:col-span-4 relative">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={filterText}
            onChange={e => setFilterText(e.target.value)}
            placeholder="Search residues (e.g. 14, SER)..."
            className="w-full text-xs pl-8 pr-3 py-1.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200 outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        {/* Range Input Form */}
        <form onSubmit={handleApplyRange} className="md:col-span-5 flex items-center gap-2">
          <input
            type="text"
            disabled={readOnly}
            value={rangeInput}
            onChange={e => setRangeInput(e.target.value)}
            placeholder="Range: 13-15, 25, 40-44"
            className="flex-grow text-xs font-mono px-3 py-1.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200 outline-none focus:ring-1 focus:ring-blue-500"
          />
          <button
            type="submit"
            disabled={readOnly || !rangeInput.trim()}
            className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 text-xs font-bold rounded-lg border border-slate-200 dark:border-slate-700 whitespace-nowrap disabled:opacity-50 transition-colors"
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
            className="p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 text-[11px] font-semibold flex items-center gap-1 border border-slate-200 dark:border-slate-700"
            title="Select All Available"
          >
            <CheckSquare className="w-3.5 h-3.5" />
            <span>All</span>
          </button>
          <button
            type="button"
            disabled={readOnly}
            onClick={handleSelectNone}
            className="p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 text-[11px] font-semibold flex items-center gap-1 border border-slate-200 dark:border-slate-700"
            title="Clear Selection"
          >
            <Square className="w-3.5 h-3.5" />
            <span>None</span>
          </button>
          <button
            type="button"
            disabled={readOnly}
            onClick={handleInvert}
            className="p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 text-[11px] font-semibold flex items-center gap-1 border border-slate-200 dark:border-slate-700"
            title="Invert Selection"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Invert</span>
          </button>
        </div>
      </div>

      {rangeError && (
        <div className="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 p-2 rounded-lg">
          {rangeError}
        </div>
      )}

      {/* Chip Grid with Accessible Checkmarks & Shift-click Contiguous Select */}
      <div className="flex flex-wrap gap-2 p-2 rounded-xl bg-slate-50/75 dark:bg-slate-800/40 border border-slate-200/80 dark:border-slate-700/80 max-h-72 overflow-y-auto">
        {visibleResidues.length === 0 ? (
          <div className="w-full text-center py-6 text-xs text-slate-400">
            No residues match the current filter.
          </div>
        ) : (
          visibleResidues.map((res, idx) => {
            const isSelected = selectedSet.has(res.id);
            const isDisabled = !res.hasData;

            let chipCls = '';
            if (isDisabled) {
              chipCls =
                'bg-slate-100 dark:bg-slate-800/50 text-slate-400 dark:text-slate-600 border-slate-200 dark:border-slate-800 cursor-not-allowed line-through';
            } else if (isSelected) {
              chipCls =
                mode === 'include'
                  ? 'bg-emerald-500 hover:bg-emerald-600 text-white border-emerald-600 shadow-sm'
                  : 'bg-red-500 hover:bg-red-600 text-white border-red-600 shadow-sm';
            } else {
              chipCls =
                'bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700';
            }

            return (
              <button
                key={res.id}
                type="button"
                disabled={readOnly || isDisabled}
                onClick={e => toggleResidue(res, idx, e.shiftKey)}
                title={
                  isDisabled
                    ? `${res.label}: No experimental data found`
                    : `${res.label}: Click to toggle, Shift+Click for range`
                }
                className={`px-2.5 py-1.5 rounded-lg text-xs font-mono font-bold transition-all border flex items-center gap-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500/50 ${chipCls}`}
              >
                {isSelected && <Check className="w-3.5 h-3.5 stroke-[2.5]" />}
                <span>{res.label || res.id}</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
};
export default ResidueSelector;
