/**
 * Building blocks shared by the Parameters and Methods tabs of every ChemEx analysis
 * page: tab header, validation banner, unparsed-lines notice, raw TOML editor and the
 * collapsible generated-TOML preview strip.
 */

import React, { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, Code, Copy, Download, FileCode, Info } from 'lucide-react';

export const chemexInputCls =
  'w-full text-sm px-3 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-slate-900 dark:text-slate-200';
export const chemexBtnPrimary =
  'px-4 py-2 bg-blue-600 hover:bg-blue-700 dark:bg-indigo-600 dark:hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-all shadow-sm disabled:opacity-50';
export const chemexBtnSecondary =
  'px-4 py-2 bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-900 dark:text-slate-200 text-sm font-medium rounded-lg transition-all';

const actionBtnBase = 'px-3 py-1.5 text-xs font-bold rounded-lg border transition-all flex items-center gap-1.5 shadow-xs';
export const actionBtnNeutral = `${actionBtnBase} bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-900 dark:text-slate-200 border-slate-200 dark:border-slate-700`;
export const actionBtnAccent = `${actionBtnBase} bg-gradient-to-r from-blue-500/10 to-indigo-500/10 hover:from-blue-500/20 hover:to-indigo-500/20 text-blue-700 dark:text-blue-500 border-blue-200/60 dark:border-blue-800/60`;
export const actionBtnInherit = `${actionBtnBase} bg-gradient-to-r from-indigo-500/10 to-purple-500/10 hover:from-indigo-500/20 hover:to-purple-500/20 text-indigo-800 dark:text-indigo-500 border-indigo-200/70 dark:border-indigo-800/70`;
export const actionBtnWarn = `${actionBtnBase} bg-amber-500 hover:bg-amber-600 text-white border-amber-600`;

// ── Tab header ──────────────────────────────────────────────────────────

export const ChemexTabHeader: React.FC<{
  icon: React.ReactNode;
  title: string;
  description: React.ReactNode;
  actions: React.ReactNode;
}> = ({ icon, title, description, actions }) => (
  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-2 border-b border-slate-100 dark:border-slate-800">
    <div>
      <h3 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
        {icon}
        <span>{title}</span>
      </h3>
      <p className="text-xs text-slate-900 dark:text-slate-200 mt-0.5">{description}</p>
    </div>
    <div className="flex flex-wrap items-center gap-2">{actions}</div>
  </div>
);

export const RawModeToggleButton: React.FC<{ active: boolean; onClick: () => void; disabled?: boolean }> = ({ active, onClick, disabled }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={`${active ? `${actionBtnBase} bg-amber-500 text-white border-amber-600` : actionBtnNeutral} disabled:opacity-50 disabled:cursor-not-allowed`}
  >
    <Code className="w-3.5 h-3.5" />
    <span>{active ? 'Return to Form' : 'Edit Raw TOML'}</span>
  </button>
);

// ── Banners ─────────────────────────────────────────────────────────────

export const ValidationBanner: React.FC<{ title: string; items: React.ReactNode[] }> = ({ title, items }) =>
  items.length === 0 ? null : (
    <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/80 space-y-2">
      <div className="flex items-center gap-2 text-xs font-bold text-amber-800 dark:text-amber-400 uppercase tracking-wider">
        <AlertTriangle className="w-4 h-4 text-amber-800 dark:text-amber-400" />
        <span>
          {title} ({items.length})
        </span>
      </div>
      <ul className="space-y-1 text-xs text-amber-800 dark:text-amber-400 pl-6 list-disc">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );

export const UnparsedLinesNotice: React.FC<{
  count: number;
  subject: string;
  onViewRaw: () => void;
  /** When given, the lines themselves are listed (nothing imported is hidden). */
  lines?: string[];
}> = ({ count, subject, onViewRaw, lines }) =>
  count === 0 ? null : (
    <div className="p-3.5 rounded-xl bg-blue-50/70 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 flex items-start justify-between gap-3 text-xs text-blue-800 dark:text-blue-500">
      <div className="flex items-start gap-2.5 min-w-0">
        <Info className="w-4 h-4 text-blue-700 dark:text-blue-500 shrink-0 mt-0.5" />
        <div className="min-w-0">
          <span className="font-semibold">Notice:</span> This {subject} contains{' '}
          <strong>{count} line{count === 1 ? '' : 's'} the form cannot represent</strong> (comments, v1-only or unknown settings).
          Structured edits generate clean TOML without them; switch to raw mode to keep them verbatim.
          {lines && lines.length > 0 && (
            <ul className="mt-2 space-y-0.5 font-mono text-xs text-blue-900 dark:text-blue-500 max-h-40 overflow-y-auto" aria-label="Lines not represented">
              {lines.map((l, i) => (
                <li key={i} className="break-all">
                  {l}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={onViewRaw}
        className="px-2.5 py-1 bg-white dark:bg-slate-800 border border-blue-300 dark:border-blue-700 rounded-md font-bold text-xs hover:bg-blue-50 dark:hover:bg-blue-900/40 whitespace-nowrap"
      >
        View in Raw Mode
      </button>
    </div>
  );

// ── Raw TOML editor ─────────────────────────────────────────────────────

export const RawTomlEditor: React.FC<{
  fileName: string;
  value: string;
  onChange: (value: string) => void;
  onApply: () => void;
  onDiscard: () => void;
  rows?: number;
  /** View-only (e.g. while a run is using this file): no editing, no apply/discard. */
  readOnly?: boolean;
}> = ({ fileName, value, onChange, onApply, onDiscard, rows = 18, readOnly = false }) => (
  <div className="space-y-3">
    {!readOnly && (
    <div className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl flex flex-wrap items-center justify-between gap-2 text-xs text-amber-800 dark:text-amber-400">
      <span className="font-medium">
        ✏️ <strong>Raw TOML Mode Active</strong>: You are editing {fileName} directly.
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onDiscard}
          className="px-3 py-1 bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 font-bold rounded-lg text-xs"
        >
          Discard Raw Edits
        </button>
        <button
          type="button"
          onClick={onApply}
          className="px-3 py-1 bg-white dark:bg-slate-800 border border-amber-300 dark:border-amber-700 font-bold rounded-lg hover:bg-amber-50 text-xs"
        >
          Parse & Return to Structured Form
        </button>
      </div>
    </div>
    )}
    <textarea
      value={value}
      readOnly={readOnly}
      onChange={e => onChange(e.target.value)}
      rows={rows}
      className={`${chemexInputCls} font-mono text-xs`}
      placeholder={`Enter raw ChemEx ${fileName} content...`}
    />
  </div>
);

// ── Generated TOML preview strip ────────────────────────────────────────

export function downloadText(content: string, fileName: string) {
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export const TomlPreviewStrip: React.FC<{
  fileName: string;
  downloadName: string;
  toml: string;
  badge: string;
  onCopied?: (message: string) => void;
}> = ({ fileName, downloadName, toml, badge, onCopied }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden shadow-2xs">
      <div className="p-3.5 bg-slate-50/80 dark:bg-slate-800/60 flex items-center justify-between">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex items-center gap-2 text-xs font-bold text-slate-900 dark:text-slate-200 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
        >
          {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          <FileCode className="w-4 h-4 text-blue-700" />
          <span>Generated {fileName} Preview</span>
          <span className="text-xs px-2 py-0.5 rounded-full bg-slate-200 dark:bg-slate-700 text-slate-900 dark:text-slate-200 font-mono">
            {badge}
          </span>
        </button>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              navigator.clipboard.writeText(toml);
              onCopied?.(`Copied ${fileName} to clipboard`);
            }}
            className="p-1.5 rounded-lg bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-900 dark:text-slate-200 text-xs font-semibold flex items-center gap-1 border border-slate-200 dark:border-slate-700 shadow-2xs"
            title="Copy TOML to clipboard"
          >
            <Copy className="w-3.5 h-3.5" />
            <span>Copy</span>
          </button>
          <button
            type="button"
            onClick={() => downloadText(toml, downloadName)}
            className="p-1.5 rounded-lg bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-900 dark:text-slate-200 text-xs font-semibold flex items-center gap-1 border border-slate-200 dark:border-slate-700 shadow-2xs"
            title={`Download ${fileName}`}
          >
            <Download className="w-3.5 h-3.5" />
            <span>Download</span>
          </button>
        </div>
      </div>
      {open && (
        <div className="p-4 border-t border-slate-200 dark:border-slate-800 bg-slate-900 overflow-x-auto">
          <pre className="text-xs font-mono text-emerald-400 whitespace-pre-wrap">{toml}</pre>
        </div>
      )}
    </div>
  );
};

// ── Modal shell ─────────────────────────────────────────────────────────

export const ChemexModalShell: React.FC<{
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  onClose: () => void;
  footer: React.ReactNode;
  children: React.ReactNode;
}> = ({ icon, title, subtitle, onClose, footer, children }) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200">
    <div className="bg-white dark:bg-slate-900 w-full max-w-2xl rounded-2xl shadow-2xl flex flex-col border border-slate-200 dark:border-slate-700 max-h-[85vh] overflow-hidden">
      <div className="flex items-center justify-between p-5 border-b border-slate-100 dark:border-slate-800">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-50 dark:bg-blue-900/30 flex items-center justify-center text-blue-700 dark:text-blue-500">
            {icon}
          </div>
          <div>
            <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">{title}</h3>
            <p className="text-xs text-slate-900 mt-0.5">{subtitle}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg text-slate-900 hover:text-slate-600"
        >
          ✕
        </button>
      </div>
      <div className="p-6 space-y-4 overflow-y-auto">{children}</div>
      <div className="p-4 border-t border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 flex justify-end gap-2">
        {footer}
      </div>
    </div>
  </div>
);
