/**
 * Method workflow dialogs (Phase E7/E8):
 *  - SaveTemplateModal: save the current method as a project or personal template
 *  - LoadFromRunModal:  list completed runs (and backups) of this family in the project and load
 *                       one's method snapshot after an old → new diff
 *  - TestRunModal:      run the method on one residue (no statistics, ≤ 3 grid points per axis) in
 *                       an isolated workspace; never "Last committed"; refines runtime estimates
 */

import React, { useEffect, useMemo, useState } from 'react';
import { BookmarkPlus, FlaskRound, History } from 'lucide-react';
import api from '../../services/api';
import { ChemexModalShell, chemexBtnPrimary, chemexBtnSecondary, chemexInputCls } from '../chemex/TomlEditorParts';
import { lineDiff, diffStats } from '../../lib/textDiff';
import { formatDuration } from '../../lib/searchEstimate';

const DIFF_CLS = {
  ' ': 'text-slate-300',
  '+': 'bg-emerald-900/40 text-emerald-300',
  '-': 'bg-red-900/40 text-red-300 line-through',
} as const;

export const TomlDiff: React.FC<{ before: string; after: string }> = ({ before, after }) => {
  const lines = useMemo(() => lineDiff(before, after), [before, after]);
  const stats = diffStats(lines);
  return (
    <div className="space-y-1">
      <p className="text-xs text-slate-900 dark:text-slate-200" data-testid="diff-stats">
        <span className="text-emerald-800 dark:text-emerald-700">+{stats.added}</span> / <span className="text-red-700 dark:text-red-600">−{stats.removed}</span> lines vs the current method
      </p>
      <pre className="max-h-72 overflow-auto rounded-lg bg-slate-900 p-2 text-xs font-mono" data-testid="load-diff">
        {lines.map((l, i) => (
          <div key={i} className={DIFF_CLS[l.op]}>
            <span className="select-none opacity-60 mr-2">{l.op}</span>
            {l.text || ' '}
          </div>
        ))}
      </pre>
    </div>
  );
};

// ── Save as template ─────────────────────────────────────────────────────

export const SaveTemplateModal: React.FC<{
  onClose: () => void;
  onSave: (t: { name: string; description: string; scope: 'project' | 'user' }) => Promise<boolean> | boolean;
}> = ({ onClose, onSave }) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [scope, setScope] = useState<'project' | 'user'>('project');
  const [saving, setSaving] = useState(false);
  return (
    <ChemexModalShell
      icon={<BookmarkPlus size={20} />}
      title="Save method as template"
      subtitle="Shown beside the built-in templates."
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className={chemexBtnSecondary}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!name.trim() || saving}
            className={chemexBtnPrimary}
            onClick={async () => {
              setSaving(true);
              const ok = await onSave({ name: name.trim(), description: description.trim(), scope });
              setSaving(false);
              if (ok) onClose();
            }}
          >
            Save template
          </button>
        </>
      }
    >
      <div className="space-y-3 text-xs">
        <label className="block">
          <span className="font-bold text-slate-900 dark:text-slate-200">Name</span>
          <input value={name} onChange={e => setName(e.target.value)} className={`${chemexInputCls} mt-1`} aria-label="Template name" />
        </label>
        <label className="block">
          <span className="font-bold text-slate-900 dark:text-slate-200">Description</span>
          <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} className={`${chemexInputCls} mt-1`} aria-label="Template description" />
        </label>
        <fieldset className="flex gap-4 text-slate-900 dark:text-slate-200">
          <label className="flex items-center gap-1">
            <input type="radio" name="tmpl-scope" checked={scope === 'project'} onChange={() => setScope('project')} /> This project (everyone with access)
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" name="tmpl-scope" checked={scope === 'user'} onChange={() => setScope('user')} /> My templates (all my projects)
          </label>
        </fieldset>
      </div>
    </ChemexModalShell>
  );
};

// ── Load method from run ─────────────────────────────────────────────────

export interface HistoryRun {
  analysis_uuid: string;
  analysis_name: string;
  source: 'current' | 'backup';
  completed_at: string | null;
  redchi: number | null;
  steps: string[];
  method_toml: string;
}

export const LoadFromRunModal: React.FC<{
  projectUuid: string;
  family: string;
  currentToml: string;
  currentAnalysisUuid: string;
  onClose: () => void;
  onLoad: (toml: string, label: string) => void;
}> = ({ projectUuid, family, currentToml, currentAnalysisUuid, onClose, onLoad }) => {
  const [runs, setRuns] = useState<HistoryRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<HistoryRun | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .get(`/api/projects/${projectUuid}/chemex/method-history`, { params: { family } })
      .then(res => {
        if (!cancelled) setRuns(Array.isArray(res?.data?.runs) ? res.data.runs : []);
      })
      .catch(() => {
        if (!cancelled) setError('Could not list runs.');
      });
    return () => {
      cancelled = true;
    };
  }, [projectUuid, family]);
  const label = (r: HistoryRun) =>
    `${r.analysis_uuid === currentAnalysisUuid ? 'This analysis' : r.analysis_name}${r.source === 'backup' ? ' · previous run' : ''}`;
  return (
    <ChemexModalShell
      icon={<History size={20} />}
      title="Load method from run"
      subtitle="Completed runs in this project. Loading replaces the current method (Undo restores it)."
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={() => (picked ? setPicked(null) : onClose())} className={chemexBtnSecondary}>
            {picked ? 'Back' : 'Cancel'}
          </button>
          {picked && (
            <button type="button" className={chemexBtnPrimary} onClick={() => onLoad(picked.method_toml, label(picked))}>
              Load this method
            </button>
          )}
        </>
      }
    >
      {error && <p className="text-xs text-red-700 dark:text-red-600">{error}</p>}
      {!picked && runs === null && !error && <p className="text-xs text-slate-900 dark:text-slate-200">Loading runs…</p>}
      {!picked && runs?.length === 0 && <p className="text-xs text-slate-900 dark:text-slate-200">No completed runs with a method snapshot yet.</p>}
      {!picked && runs && runs.length > 0 && (
        <table className="w-full text-xs" aria-label="Completed runs">
          <thead>
            <tr className="text-left text-slate-900 dark:text-slate-200 border-b border-slate-200 dark:border-slate-700">
              <th className="py-1 pr-2 font-semibold">Run</th>
              <th className="py-1 pr-2 font-semibold">Date</th>
              <th className="py-1 pr-2 font-semibold">red-χ²</th>
              <th className="py-1 font-semibold">Steps</th>
            </tr>
          </thead>
          <tbody>
            {runs.map(r => (
              <tr
                key={`${r.analysis_uuid}-${r.source}`}
                className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                onClick={() => setPicked(r)}
              >
                <td className="py-1 pr-2 text-slate-900 dark:text-slate-200">
                  <button type="button" className="text-left hover:underline">{label(r)}</button>
                </td>
                <td className="py-1 pr-2 text-slate-900 dark:text-slate-200">{r.completed_at ? new Date(r.completed_at).toLocaleString() : '—'}</td>
                <td className="py-1 pr-2 font-mono">{r.redchi !== null ? r.redchi.toFixed(2) : '—'}</td>
                <td className="py-1 font-mono">{r.steps.join(' → ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {picked && <TomlDiff before={currentToml} after={picked.method_toml} />}
    </ChemexModalShell>
  );
};

// ── Test on 1 residue ────────────────────────────────────────────────────

interface TestStatus {
  test_id: string;
  state: 'queued' | 'running' | 'done' | 'failed';
  residue: string;
  error?: string | null;
  seconds?: number;
  steps: Array<{ name: string; seconds: number | null; evaluations?: number | null; incomplete?: boolean }>;
}

export const TestRunModal: React.FC<{
  projectUuid: string;
  analysisUuid: string;
  methodToml: string;
  parameterToml?: string;
  model: string;
  residues: string[];
  onClose: () => void;
  /** Called once a test finishes (refresh runtime estimates). */
  onFinished?: () => void;
  pollMs?: number;
}> = ({ projectUuid, analysisUuid, methodToml, parameterToml, model, residues, onClose, onFinished, pollMs = 2000 }) => {
  const base = `/api/projects/${projectUuid}/analysis/${analysisUuid}/chemex`;
  const [residue, setResidue] = useState(residues[0] ?? '');
  const [status, setStatus] = useState<TestStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = status && (status.state === 'queued' || status.state === 'running');
  useEffect(() => {
    if (!status || !active) return;
    const t = window.setTimeout(async () => {
      try {
        const res = await api.get(`${base}/test-run/${status.test_id}`);
        setStatus(res.data);
        if (res.data?.state === 'done' || res.data?.state === 'failed') onFinished?.();
      } catch {
        setError('Lost track of the test run.');
      }
    }, pollMs);
    return () => window.clearTimeout(t);
  }, [status, active, base, pollMs, onFinished]);
  const start = async () => {
    setError(null);
    try {
      const res = await api.post(`${base}/test-run`, { method_toml: methodToml, parameter_toml: parameterToml, model, residue });
      setStatus(res.data);
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(detail || 'Could not start the test run.');
    }
  };
  return (
    <ChemexModalShell
      icon={<FlaskRound size={20} />}
      title="Test on 1 residue"
      subtitle="Every step on one residue, statistics stripped, GRID ≤ 3 points per axis. A test — never committed or shown as results."
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className={chemexBtnSecondary}>
            Close
          </button>
          <button type="button" disabled={!residue || !!active} className={chemexBtnPrimary} onClick={start}>
            {active ? 'Testing…' : status ? 'Run again' : 'Start test'}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-xs">
        <label className="flex items-center gap-2 text-slate-900 dark:text-slate-200">
          Residue
          <select aria-label="Test residue" value={residue} onChange={e => setResidue(e.target.value)} disabled={!!active} className={`${chemexInputCls} w-32`}>
            {residues.map(r => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        {error && <p className="text-red-700 dark:text-red-600">{error}</p>}
        {status && (
          <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-2 space-y-1" data-testid="test-status">
            <p className="font-semibold text-slate-900 dark:text-slate-200">
              TEST RUN · {status.residue} · {status.state}
              {typeof status.seconds === 'number' ? ` · ${formatDuration(status.seconds)}` : ''}
            </p>
            {status.error && <p className="text-red-700 dark:text-red-600 break-words">{status.error}</p>}
            {status.steps.length > 0 && (
              <ul className="font-mono text-slate-900 dark:text-slate-200">
                {status.steps.map(s => (
                  <li key={s.name}>
                    {s.name}: {s.seconds !== null ? formatDuration(s.seconds) : '…'}
                    {s.evaluations && s.evaluations > 1 ? ` (${s.evaluations} fits)` : ''}
                    {s.incomplete ? ' (incomplete)' : ''}
                  </li>
                ))}
              </ul>
            )}
            {status.state === 'done' && <p className="text-slate-900 dark:text-slate-200">Runtime estimates now use these timings until a full run exists.</p>}
          </div>
        )}
      </div>
    </ChemexModalShell>
  );
};
