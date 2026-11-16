/**
 * Shared residue browser for the residue-by-residue review pages (Pick CEST, Inspect
 * Dispersion). Three pieces driven by one `useResidueBrowser` state:
 *  - ResidueNavBar   prev/next, dropdown, progress count, shortcuts "?", export, page actions
 *  - ResidueTable    text filter, status filter, sortable table (residue number by default),
 *                    greyed gap rows for residues absent from the dataset
 *  - ResidueNotePanel per-residue note and flag
 */

import React, { useMemo, useRef, useState, useEffect } from 'react';
import {
  ChevronLeft, ChevronRight, Search, Flag, HelpCircle, Download, MinusCircle, PlusCircle,
  ArrowUpDown, Undo2, Check, Ban, Circle,
} from 'lucide-react';
import type { ResidueBrowserState } from '../../hooks/useResidueBrowser';
import {
  type BrowserRow,
  type ExportMask,
  type ExportResidue,
  type ReviewStatus,
  STATUS_LABELS,
  reviewToCsv,
  reviewToToml,
} from '../../lib/residueReview';
import { downloadText } from '../chemex/TomlEditorParts';

const btnSecondary =
  'px-3 py-1.5 bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 text-xs font-semibold rounded-lg transition-all flex items-center gap-1 disabled:opacity-40';

const STATUS_BADGE: Record<ReviewStatus, string> = {
  unreviewed: 'bg-slate-100 text-slate-500 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700',
  accepted: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800',
  no_excited_state: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-800',
  excluded: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800',
};

const STATUS_ICON: Record<ReviewStatus, React.ReactNode> = {
  unreviewed: <Circle className="w-3 h-3" />,
  accepted: <Check className="w-3 h-3" />,
  no_excited_state: <Ban className="w-3 h-3" />,
  excluded: <MinusCircle className="w-3 h-3" />,
};

export const StatusBadge: React.FC<{ status: ReviewStatus; label?: string }> = ({ status, label }) => (
  <span
    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] font-semibold whitespace-nowrap ${STATUS_BADGE[status]}`}
    data-status={status}
  >
    {STATUS_ICON[status]}
    {label ?? STATUS_LABELS[status]}
  </span>
);

// ── Shortcuts popover ────────────────────────────────────────────────────

export const ShortcutsPopover: React.FC<{ help: ResidueBrowserState['help'] }> = ({ help }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="p-1.5 rounded-lg text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
        title="Keyboard shortcuts"
        aria-label="Keyboard shortcuts"
        aria-expanded={open}
      >
        <HelpCircle className="w-4 h-4" />
      </button>
      {open && (
        <div role="dialog" aria-label="Keyboard shortcuts" className="absolute right-0 z-30 mt-1 w-64 p-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-lg text-xs">
          <div className="font-bold text-slate-700 dark:text-slate-200 mb-2">Keyboard shortcuts</div>
          <table className="w-full">
            <tbody>
              {help.map(h => (
                <tr key={h.keys}>
                  <td className="py-0.5 pr-3 font-mono font-semibold text-slate-800 dark:text-slate-100 whitespace-nowrap">{h.keys}</td>
                  <td className="py-0.5 text-slate-600 dark:text-slate-400">{h.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[10px] text-slate-400">Shortcuts are ignored while typing in a text field.</p>
        </div>
      )}
    </div>
  );
};

// ── Export ───────────────────────────────────────────────────────────────

export interface ReviewExport {
  baseName: string;
  columns: string[];
  rows: ExportResidue[];
  masks?: ExportMask[];
  meta?: Record<string, string>;
}

export const ExportMenu: React.FC<{ build: () => ReviewExport }> = ({ build }) => {
  const [open, setOpen] = useState(false);
  const run = (kind: 'csv' | 'toml') => {
    const e = build();
    if (kind === 'csv') downloadText(reviewToCsv(e.rows, e.columns, e.masks), `${e.baseName}.csv`);
    else downloadText(reviewToToml(e.rows, e.masks, e.meta), `${e.baseName}.toml`);
    setOpen(false);
  };
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen(o => !o)} className={btnSecondary} title="Export picks, statuses, masks and notes">
        <Download className="w-3.5 h-3.5" /> Export
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-32 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg text-xs overflow-hidden">
          <button type="button" className="block w-full text-left px-3 py-2 hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => run('csv')}>CSV</button>
          <button type="button" className="block w-full text-left px-3 py-2 hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => run('toml')}>TOML</button>
        </div>
      )}
    </div>
  );
};

// ── Nav bar ──────────────────────────────────────────────────────────────

export interface ResidueNavBarProps {
  browser: ResidueBrowserState;
  /** Label override per status (Pick CEST: accepted → "Picked"). */
  statusLabels?: Partial<Record<ReviewStatus, string>>;
  buildExport: () => ReviewExport;
  /** Page actions shown on the right (pick mode, Accept & Next, No excited state, ...). */
  children?: React.ReactNode;
}

export const ResidueNavBar: React.FC<ResidueNavBarProps> = ({ browser, statusLabels, buildExport, children }) => {
  const present = browser.rows.filter(r => r.present);
  const idx = browser.selectedId ? present.findIndex(r => r.id === browser.selectedId) : -1;
  const sel = browser.selectedId;
  const excluded = sel ? browser.status(sel) === 'excluded' : false;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={browser.prev} disabled={idx <= 0} className={btnSecondary} title="Previous residue (←)" aria-label="Previous residue">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <select
          value={sel ?? ''}
          onChange={e => browser.select(e.target.value)}
          aria-label="Residue"
          className="text-xs py-1.5 px-3 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg text-slate-800 dark:text-slate-200 font-medium focus:ring-2 focus:ring-blue-500 w-48"
        >
          {present.map(r => {
            const s = browser.status(r.id);
            const suffix = s === 'unreviewed' ? '' : ` · ${statusLabels?.[s] ?? STATUS_LABELS[s]}`;
            return <option key={r.id} value={r.id}>{r.label}{suffix}</option>;
          })}
        </select>
        <button type="button" onClick={browser.next} disabled={idx >= present.length - 1} className={btnSecondary} title="Next residue (→)" aria-label="Next residue">
          <ChevronRight className="w-4 h-4" />
        </button>
        {sel && (
          <button
            type="button"
            onClick={() => browser.toggleExclusion()}
            className={`px-3 py-1.5 rounded-lg border text-xs font-semibold flex items-center gap-1.5 transition-all ${
              excluded
                ? 'bg-rose-50 text-rose-700 border-rose-300 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-700 hover:bg-rose-100'
                : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-600 hover:text-rose-600 hover:border-rose-300'
            }`}
            title={excluded ? 'Include this residue in parameters (uncomment in parameters.toml) (X)' : 'Exclude this residue from parameters (comment out in parameters.toml) (X)'}
          >
            {excluded ? <PlusCircle className="w-3.5 h-3.5 text-emerald-500" /> : <MinusCircle className="w-3.5 h-3.5 text-rose-500" />}
            <span>{excluded ? 'Excluded (Click to Include)' : 'Exclude'}</span>
          </button>
        )}
        <span className="text-xs font-semibold text-slate-500 dark:text-slate-400 px-2" data-testid="review-progress">
          {browser.progress.reviewed} / {browser.progress.total} reviewed
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {children}
        <button
          type="button"
          onClick={browser.undo}
          disabled={!browser.canUndo}
          className={btnSecondary}
          title={browser.canUndo ? `Undo: ${browser.lastUndoLabel} (Ctrl+Z)` : 'Nothing to undo'}
          aria-label="Undo"
        >
          <Undo2 className="w-3.5 h-3.5" />
        </button>
        <ExportMenu build={buildExport} />
        <ShortcutsPopover help={browser.help} />
      </div>
    </div>
  );
};

// ── Table ────────────────────────────────────────────────────────────────

export interface ResidueColumn {
  key: string;
  header: React.ReactNode;
  render: (id: string) => React.ReactNode;
  /** Numeric (or string) sort key; columns without one are not sortable. */
  sortValue?: (id: string) => number | string | null | undefined;
  className?: string;
}

export interface ResidueFilter {
  key: string;
  label: string;
  test: (id: string) => boolean;
}

export interface ResidueTableProps {
  browser: ResidueBrowserState;
  columns?: ResidueColumn[];
  statusLabels?: Partial<Record<ReviewStatus, string>>;
  /** Extra filters offered beside the status filter (e.g. "Flagged duplicates"). */
  filters?: ResidueFilter[];
  /** Row highlight (e.g. a warning tint) for present rows. */
  rowClassName?: (id: string) => string;
  className?: string;
}

type SortState = { key: string; dir: 1 | -1 };

export const ResidueTable: React.FC<ResidueTableProps> = ({ browser, columns = [], statusLabels, filters = [], rowClassName, className }) => {
  const [query, setQuery] = useState('');
  const [filterKey, setFilterKey] = useState('all');
  const [sort, setSort] = useState<SortState>({ key: 'res', dir: 1 });

  const statusFilters: ResidueFilter[] = useMemo(
    () => [
      ...(['unreviewed', 'accepted', 'no_excited_state', 'excluded'] as ReviewStatus[]).map(s => ({
        key: `status:${s}`,
        label: statusLabels?.[s] ?? STATUS_LABELS[s],
        test: (id: string) => browser.status(id) === s,
      })),
      { key: 'flagged', label: 'Flagged', test: (id: string) => browser.flaggedFor(id) },
      ...filters,
    ],
    [browser, statusLabels, filters]
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filter = statusFilters.find(f => f.key === filterKey);
    const narrowing = !!q || !!filter;
    let rows: BrowserRow[] = browser.rows.filter(r => {
      if (!r.present) return !narrowing;
      if (q && !r.id.toLowerCase().includes(q) && !r.label.toLowerCase().includes(q)) return false;
      return !filter || filter.test(r.id);
    });
    if (sort.key !== 'res') {
      const col = columns.find(c => c.key === sort.key);
      if (col?.sortValue) {
        const val = (r: BrowserRow) => (r.present ? col.sortValue!(r.id) : null);
        rows = rows
          .filter(r => r.present)
          .sort((a, b) => {
            const va = val(a), vb = val(b);
            if (va == null && vb == null) return a.resNum - b.resNum;
            if (va == null) return 1;
            if (vb == null) return -1;
            return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir;
          });
      }
    } else if (sort.dir === -1) {
      rows = [...rows].reverse();
    }
    return rows;
  }, [browser.rows, query, filterKey, statusFilters, sort, columns]);

  const toggleSort = (key: string) => setSort(s => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: 1 }));
  const sortHeader = (key: string, label: React.ReactNode, sortable: boolean, cls = '') => (
    <th className={`px-3 py-2 ${cls}`}>
      {sortable ? (
        <button type="button" onClick={() => toggleSort(key)} className="inline-flex items-center gap-1 uppercase font-bold">
          {label}
          <ArrowUpDown className={`w-3 h-3 ${sort.key === key ? 'text-blue-500' : 'opacity-40'}`} />
        </button>
      ) : label}
    </th>
  );

  return (
    <div className={`bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden flex flex-col ${className ?? 'h-[480px]'}`}>
      <div className="p-2 border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 flex gap-2">
        <div className="relative flex-1">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-2 text-slate-400" />
          <input
            type="text"
            placeholder="Filter residues..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            className="w-full pl-8 pr-2 py-1 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200"
          />
        </div>
        <select
          value={filterKey}
          onChange={e => setFilterKey(e.target.value)}
          aria-label="Status filter"
          className="text-xs py-1 px-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-200"
        >
          <option value="all">All</option>
          {statusFilters.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
      </div>
      <div className="overflow-auto flex-1">
        <table className="w-full text-xs text-left">
          <thead className="sticky top-0 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 font-bold uppercase tracking-wider z-10">
            <tr>
              {sortHeader('res', 'Residue', true)}
              <th className="px-3 py-2">Status</th>
              {columns.map(c => sortHeader(c.key, c.header, !!c.sortValue, c.className))}
              <th className="px-2 py-2 text-right" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
            {visible.map(r => {
              if (!r.present) {
                return (
                  <tr key={r.id} className="text-slate-400 dark:text-slate-600 bg-slate-100/60 dark:bg-slate-900/60" data-gap="true">
                    <td className="px-3 py-1.5 font-semibold">{r.label}</td>
                    <td className="px-3 py-1.5 italic" colSpan={columns.length + 2}>{r.gapReason ?? 'no data'}</td>
                  </tr>
                );
              }
              const s = browser.status(r.id);
              const isCurrent = r.id === browser.selectedId;
              return (
                <tr
                  key={r.id}
                  onClick={() => browser.select(r.id)}
                  aria-selected={isCurrent}
                  className={`cursor-pointer hover:bg-blue-50/50 dark:hover:bg-blue-900/10 ${
                    isCurrent ? 'bg-blue-50 dark:bg-blue-900/30' : s === 'excluded' ? 'opacity-60' : ''
                  } ${rowClassName?.(r.id) ?? ''}`}
                >
                  <td className="px-3 py-1.5 font-bold text-slate-800 dark:text-slate-200">
                    <span className={s === 'excluded' ? 'line-through text-slate-400' : ''}>{r.label}</span>
                    {browser.noteFor(r.id) && <span className="ml-1 text-slate-400" title={browser.noteFor(r.id)}>✎</span>}
                  </td>
                  <td className="px-3 py-1.5"><StatusBadge status={s} label={statusLabels?.[s]} /></td>
                  {columns.map(c => (
                    <td key={c.key} className={`px-3 py-1.5 font-mono ${c.className ?? ''}`}>{c.render(r.id)}</td>
                  ))}
                  <td className="px-2 py-1.5 text-right">
                    <div className="flex items-center justify-end gap-1" onClick={e => e.stopPropagation()}>
                      <button
                        type="button"
                        onClick={() => browser.toggleFlag(r.id)}
                        className={`p-1 rounded ${browser.flaggedFor(r.id) ? 'text-amber-500' : 'text-slate-300 hover:text-amber-500'}`}
                        title={browser.flaggedFor(r.id) ? 'Unflag' : 'Flag'}
                        aria-label={`Flag ${r.label}`}
                      >
                        <Flag className="w-3.5 h-3.5" fill={browser.flaggedFor(r.id) ? 'currentColor' : 'none'} />
                      </button>
                      <button
                        type="button"
                        onClick={() => browser.toggleExclusion(r.id)}
                        className={`p-1 rounded ${s === 'excluded' ? 'text-rose-500 hover:text-emerald-600' : 'text-slate-400 hover:text-rose-600'}`}
                        title={s === 'excluded' ? 'Include this residue (uncomment in parameter file)' : 'Exclude this residue (comment out in parameter file)'}
                      >
                        {s === 'excluded' ? <PlusCircle className="w-3.5 h-3.5" /> : <MinusCircle className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ── Note + flag ──────────────────────────────────────────────────────────

export const ResidueNotePanel: React.FC<{ browser: ResidueBrowserState; label?: string }> = ({ browser, label }) => {
  if (!browser.selectedId) return null;
  return (
    <div className="flex items-start gap-2">
      <textarea
        value={browser.note}
        onChange={e => browser.setNote(e.target.value)}
        placeholder={`Note for ${label ?? browser.selectedId} (saved with the analysis, included in the report)`}
        rows={2}
        aria-label="Residue note"
        className="flex-1 text-xs px-3 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg text-slate-800 dark:text-slate-200 resize-y"
      />
      <button
        type="button"
        onClick={() => browser.toggleFlag()}
        className={`px-3 py-2 rounded-lg border text-xs font-semibold flex items-center gap-1.5 ${
          browser.flagged
            ? 'bg-amber-50 text-amber-700 border-amber-300 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-700'
            : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-600 hover:text-amber-600'
        }`}
        aria-pressed={browser.flagged}
      >
        <Flag className="w-3.5 h-3.5" fill={browser.flagged ? 'currentColor' : 'none'} />
        {browser.flagged ? 'Flagged' : 'Flag'}
      </button>
    </div>
  );
};
