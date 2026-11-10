/**
 * Resolved-roles preview for one method step: the effective role of every
 * concrete parameter after ROLES_FROM and all ROLES actions, as resolved by
 * ChemEx itself (POST …/methods/resolve). Collapsed: one summary line.
 * Expanded: a filterable table with the ROLES entry that decided each role.
 */

import React, { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, Loader2, ScanSearch } from 'lucide-react';
import type { ResolvedRolesState } from '../../hooks/useResolvedRoles';
import {
  errorsForStep,
  stepSummaryText,
  summarizeResolvedStep,
  type ChemexError,
  type ResolvedParameter,
  type ResolvedRole,
} from '../../lib/resolvedRoles';

const ROLE_STYLE: Record<ResolvedRole, string> = {
  fit: 'text-blue-700 bg-blue-50 dark:text-blue-500 dark:bg-blue-900/30',
  fix: 'text-slate-900 bg-slate-100 dark:text-slate-200 dark:bg-slate-800',
  constrained: 'text-purple-700 bg-purple-50 dark:text-purple-300 dark:bg-purple-900/30',
  derived: 'text-slate-900 bg-slate-50 dark:text-slate-200 dark:bg-slate-800/60',
};

const MAX_ROWS = 400;

function conditionsText(c: Record<string, number>): string {
  const parts: string[] = [];
  if (c.h_larmor_frq !== undefined) parts.push(`${c.h_larmor_frq} MHz`);
  if (c.temperature !== undefined) parts.push(`${c.temperature} °C`);
  if (c.p_total !== undefined) parts.push(`[P] ${c.p_total} M`);
  if (c.l_total !== undefined) parts.push(`[L] ${c.l_total} M`);
  if (c.d2o !== undefined) parts.push(`D₂O ${c.d2o}`);
  return parts.join(', ');
}

function decidedBy(p: ResolvedParameter): string {
  if (p.rule) {
    const where = `ROLES #${p.rule.action_index + 1} ${p.rule.action}`;
    return p.rule.inherited ? `${where} of ${p.rule.step} (ROLES_FROM)` : where;
  }
  return p.decided_by === 'model' ? 'kinetic model (protected)' : 'baseline';
}

function chemexErrorLocation(e: ChemexError): string {
  const s = e.source || {};
  const parts = [s.step ? `[${s.step}]` : '', s.field ?? ''];
  if (s.action_index !== undefined) parts[1] = `ROLES #${s.action_index + 1} ${s.action}, entry ${(s.entry_index ?? 0) + 1}`;
  else if (s.index !== undefined && s.index !== null) parts[1] = `${s.field} #${s.index + 1}`;
  return parts.filter(Boolean).join(' ');
}

export const ResolvedRolesSummary: React.FC<{ state: ResolvedRolesState; stepName: string; disabledReason?: string }> = ({
  state,
  stepName,
  disabledReason,
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [roles, setRoles] = useState<Set<ResolvedRole>>(() => new Set(['fit', 'fix', 'constrained', 'derived']));
  const { report, loading, stale, error } = state;
  const upper = stepName.trim().toUpperCase();
  const step = report?.steps.find(s => s.name.toUpperCase() === upper);
  const stepErrors = errorsForStep(report, stepName);
  const globalErrors = (report?.errors ?? []).filter(e => !e.source?.step);
  const summary = step ? summarizeResolvedStep(step) : null;

  const q = query.trim().toLowerCase();
  const rows = (step?.parameters ?? []).filter(
    p =>
      roles.has(p.role) &&
      (!q || p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q) || p.spin.toLowerCase().includes(q) || p.expression.toLowerCase().includes(q))
  );

  const toggleRole = (r: ResolvedRole) =>
    setRoles(prev => {
      const next = new Set(prev);
      if (next.has(r)) next.delete(r);
      else next.add(r);
      return next;
    });

  let headline: React.ReactNode;
  if (disabledReason) headline = <span className="text-slate-900">{disabledReason}</span>;
  else if (!report && loading) headline = <span className="text-slate-900">Resolving with ChemEx…</span>;
  else if (!report && error) headline = <span className="text-amber-800 dark:text-amber-400">Could not resolve roles: {error}</span>;
  else if (summary) headline = <span className="font-mono text-slate-900 dark:text-slate-200">{upper}: {stepSummaryText(summary)}</span>;
  else if (step?.error) headline = <span className="text-amber-800 dark:text-amber-400">{step.error.message}</span>;
  else if (report) headline = <span className="text-slate-900">Not resolved (see errors below)</span>;
  else headline = <span className="text-slate-900">—</span>;

  const errors = [...globalErrors, ...stepErrors];

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-sm">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        disabled={!step}
        className="w-full p-3.5 bg-slate-50/80 dark:bg-slate-800/60 flex flex-wrap items-center gap-2 text-left text-xs disabled:cursor-default"
      >
        {open ? <ChevronUp className="w-4 h-4 text-slate-900" /> : <ChevronDown className="w-4 h-4 text-slate-900" />}
        <ScanSearch className="w-4 h-4 text-emerald-800" />
        <span className="font-bold text-slate-900 dark:text-slate-200">Resolved roles (ChemEx)</span>
        {headline}
        {(loading || stale) && report && (
          <span className="flex items-center gap-1 text-xs text-slate-900">
            <Loader2 className="w-3 h-3 animate-spin" /> updating
          </span>
        )}
        {errors.length > 0 && (
          <span className="ml-auto flex items-center gap-1 text-xs font-semibold text-red-600 dark:text-red-500">
            <AlertTriangle className="w-3.5 h-3.5" /> {errors.length} ChemEx error{errors.length > 1 ? 's' : ''}
          </span>
        )}
      </button>

      {errors.length > 0 && (
        <ul className="px-4 py-2 space-y-0.5 border-t border-red-100 dark:border-red-900/40 bg-red-50/50 dark:bg-red-950/20 text-xs text-red-700 dark:text-red-500">
          {errors.map((e, i) => (
            <li key={i}>
              <span className="font-mono text-red-500/80">{chemexErrorLocation(e)}</span> {e.message}
            </li>
          ))}
        </ul>
      )}

      {open && step && (
        <div className="p-3 space-y-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Filter (name, spin, id, expression)…"
              aria-label="Filter resolved parameters"
              className="w-56 text-xs px-2 py-1 rounded bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-200 outline-none focus:ring-1 focus:ring-blue-500"
            />
            {(['fit', 'fix', 'constrained', 'derived'] as ResolvedRole[]).map(r => (
              <label key={r} className="flex items-center gap-1 cursor-pointer">
                <input type="checkbox" checked={roles.has(r)} onChange={() => toggleRole(r)} />
                <span className={`px-1.5 rounded ${ROLE_STYLE[r]}`}>{r}</span>
              </label>
            ))}
            <span className="ml-auto text-slate-900">
              {rows.length} of {step.parameters.length} · {step.profiles ?? 0} profiles
            </span>
          </div>
          <div className="overflow-x-auto max-h-96 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-slate-200">
                <tr>
                  <th className="py-1.5 px-2 font-semibold">Parameter</th>
                  <th className="py-1.5 px-2 font-semibold">Spin</th>
                  <th className="py-1.5 px-2 font-semibold">Conditions</th>
                  <th className="py-1.5 px-2 font-semibold">Role</th>
                  <th className="py-1.5 px-2 font-semibold">Decided by</th>
                  <th className="py-1.5 px-2 font-semibold">Expression</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono">
                {rows.slice(0, MAX_ROWS).map(p => (
                  <tr key={p.id}>
                    <td className="py-1 px-2 font-bold text-slate-900 dark:text-slate-200">{p.name}</td>
                    <td className="py-1 px-2 text-slate-900 dark:text-slate-200">{p.spin || <span className="text-slate-900">global</span>}</td>
                    <td className="py-1 px-2 text-slate-900">{conditionsText(p.conditions)}</td>
                    <td className="py-1 px-2">
                      <span className={`px-1.5 rounded ${ROLE_STYLE[p.role]}`}>{p.role}</span>
                    </td>
                    <td className="py-1 px-2 font-sans text-slate-900 dark:text-slate-200">{decidedBy(p)}</td>
                    <td className="py-1 px-2 text-slate-900 dark:text-slate-200 break-all">{p.expression}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > MAX_ROWS && <p className="p-2 text-xs text-slate-900">Showing the first {MAX_ROWS}; refine the filter to see more.</p>}
          </div>
        </div>
      )}
    </div>
  );
};

export default ResolvedRolesSummary;
