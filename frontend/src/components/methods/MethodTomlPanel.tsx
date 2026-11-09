/**
 * Sticky side panel with the generated method.toml: plain view or a diff against
 * the method of the last completed run; ChemEx version and validation state in the
 * footer. Collapsible on narrow screens.
 */

import React, { useMemo, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronUp, Copy, Download, FileCode, GitCompare, Loader2, XCircle } from 'lucide-react';
import { downloadText } from '../chemex/TomlEditorParts';
import { diffStats, lineDiff } from '../../lib/textDiff';

export interface MethodTomlPanelProps {
  toml: string;
  downloadName: string;
  stepCount: number;
  /** method.toml of the last completed run, if any. */
  lastRunToml?: string | null;
  lastRunAt?: string | null;
  chemexVersion?: string | null;
  /** Live ChemEx validation state of the current text. */
  validation: { checking: boolean; errors: number; known: boolean };
  onCopied?: (message: string) => void;
}

const LINE_CLS = {
  ' ': 'text-slate-300',
  '+': 'bg-emerald-900/40 text-emerald-300',
  '-': 'bg-red-900/40 text-red-300 line-through decoration-red-400/50',
} as const;

export const MethodTomlPanel: React.FC<MethodTomlPanelProps> = ({
  toml,
  downloadName,
  stepCount,
  lastRunToml,
  lastRunAt,
  chemexVersion,
  validation,
  onCopied,
}) => {
  const [showDiff, setShowDiff] = useState(false);
  const [collapsed, setCollapsed] = useState(true); // narrow screens only; always open on lg+
  const canDiff = !!lastRunToml;
  const diff = useMemo(() => (showDiff && lastRunToml ? lineDiff(lastRunToml, toml) : null), [showDiff, lastRunToml, toml]);
  const stats = diff ? diffStats(diff) : null;
  const btn =
    'p-1.5 rounded-lg bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 text-xs font-semibold flex items-center gap-1 border border-slate-200 dark:border-slate-700 disabled:opacity-40 disabled:cursor-not-allowed';

  return (
    <section aria-label="Generated method.toml" className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm overflow-hidden flex flex-col lg:max-h-[calc(100vh-2rem)]">
      <div className="p-3 bg-slate-50/80 dark:bg-slate-800/60 flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 dark:border-slate-800">
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          aria-expanded={!collapsed}
          className="flex items-center gap-2 text-xs font-bold text-slate-700 dark:text-slate-300 lg:pointer-events-none"
        >
          <span className="lg:hidden">{collapsed ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}</span>
          <FileCode className="w-4 h-4 text-blue-500" />
          <span>method.toml</span>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 font-mono">
            {stepCount} step{stepCount === 1 ? '' : 's'}
          </span>
        </button>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={!canDiff}
            onClick={() => setShowDiff(!showDiff)}
            aria-pressed={showDiff}
            className={`${btn} ${showDiff ? 'ring-1 ring-blue-400 text-blue-600 dark:text-blue-400' : ''}`}
            title={canDiff ? 'Compare with the method of the last completed run' : 'No completed run to compare with yet'}
          >
            <GitCompare className="w-3.5 h-3.5" />
            <span>Diff vs last run</span>
          </button>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard?.writeText(toml);
              onCopied?.('Copied method.toml to clipboard');
            }}
            className={btn}
            title="Copy TOML"
            aria-label="Copy method.toml"
          >
            <Copy className="w-3.5 h-3.5" />
          </button>
          <button type="button" onClick={() => downloadText(toml, downloadName)} className={btn} title="Download method.toml" aria-label="Download method.toml">
            <Download className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className={`${collapsed ? 'hidden lg:flex' : 'flex'} flex-col min-h-0 flex-1`}>
        {diff && stats && (
          <div className="px-3 py-1.5 text-[11px] bg-slate-800 text-slate-300 border-b border-slate-700 flex items-center gap-2">
            <span className="text-emerald-400">+{stats.added}</span>
            <span className="text-red-400">−{stats.removed}</span>
            <span>vs last run{lastRunAt ? ` (${new Date(lastRunAt).toLocaleString()})` : ''}</span>
            {stats.added + stats.removed === 0 && <span className="text-slate-400">— identical</span>}
          </div>
        )}
        <div className="p-3 bg-slate-900 overflow-auto flex-1 min-h-[8rem]">
          {diff ? (
            <pre className="text-xs font-mono" data-testid="toml-diff">
              {diff.map((l, i) => (
                <div key={i} className={LINE_CLS[l.op]}>
                  <span className="select-none opacity-60 mr-2">{l.op}</span>
                  {l.text || ' '}
                </div>
              ))}
            </pre>
          ) : (
            <pre className="text-xs font-mono text-emerald-400 whitespace-pre" data-testid="toml-text">
              {toml}
            </pre>
          )}
        </div>
      </div>

      <footer className="px-3 py-2 text-[11px] border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2 text-slate-500 dark:text-slate-400">
        <span className="font-mono">ChemEx {chemexVersion ?? '—'} · FORMAT_VERSION = 2</span>
        <span className="flex items-center gap-1" aria-live="polite">
          {validation.checking ? (
            <>
              <Loader2 className="w-3 h-3 animate-spin" /> checking with ChemEx…
            </>
          ) : !validation.known ? (
            <span>not checked yet</span>
          ) : validation.errors > 0 ? (
            <span className="flex items-center gap-1 text-red-600 dark:text-red-400 font-semibold">
              <XCircle className="w-3 h-3" /> {validation.errors} error{validation.errors === 1 ? '' : 's'} — Run is blocked
            </span>
          ) : (
            <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-semibold">
              <CheckCircle2 className="w-3 h-3" /> ChemEx accepts this method
            </span>
          )}
        </span>
      </footer>
    </section>
  );
};

export default MethodTomlPanel;
