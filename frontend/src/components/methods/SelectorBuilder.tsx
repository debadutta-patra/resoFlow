/**
 * Builder for one ChemEx v2 parameter selector ("NAME, NUC->…, B0->…").
 *
 * Structured mode: a parameter dropdown plus qualifier chips whose values are
 * suggested from the loaded data (spins, fields, temperatures… from ChemEx's own
 * parameter inspection); any value may still be typed. Raw mode: free text.
 * Both are checked with the ChemEx grammar mirror (lib/methodGrammar).
 */

import React, { useId, useMemo, useState } from 'react';
import { Code, Plus, X } from 'lucide-react';
import { catalogSuggestions as qualifierSuggestions, type ParameterCatalog } from '../../lib/baselineRoles';
import {
  QUALIFIER_HELP,
  QUALIFIER_KEYS,
  formatSelector,
  lenientSelector,
  parseSelector,
  type ParsedSelector,
  type QualifierKey,
} from '../../lib/methodGrammar';

const selectorInputCls =
  'text-xs font-mono px-2 py-1 rounded bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200 outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-60';

export interface SelectorBuilderProps {
  value: string;
  onChange: (value: string) => void;
  /** Parameter names to offer (union of the model catalog and ChemEx-instantiated names). */
  paramNames: string[];
  catalog?: ParameterCatalog | null;
  /** Which action this selector serves: protected / non-estimable names are disabled accordingly. */
  purpose: 'FIT' | 'FIX' | 'CONSTRAIN' | 'REFERENCE';
  readOnly?: boolean;
  /** Error reported by ChemEx for this entry. */
  externalError?: string | null;
  ariaLabel?: string;
}

export const SelectorBuilder: React.FC<SelectorBuilderProps> = ({
  value,
  onChange,
  paramNames,
  catalog,
  purpose,
  readOnly = false,
  externalError,
  ariaLabel = 'Parameter selector',
}) => {
  const uid = useId();
  const parsed = useMemo(() => parseSelector(value), [value]);
  const structure = useMemo(() => lenientSelector(value), [value]);
  // Raw mode for text the structured form cannot represent (or on request).
  const [rawRequested, setRaw] = useState(false);
  const raw = rawRequested || structure === null;
  const [addKey, setAddKey] = useState('');

  const sel: ParsedSelector = structure ?? { name: '', qualifiers: [] };
  const names = useMemo(() => {
    const set = new Set(paramNames.map(n => n.toUpperCase()));
    Object.keys(catalog ?? {}).forEach(n => set.add(n));
    if (sel.name) set.add(sel.name);
    return [...set].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }, [paramNames, catalog, sel.name]);

  const emit = (next: ParsedSelector) => onChange(formatSelector(next));
  const disabledReason = (name: string): string | null => {
    const entry = catalog?.[name];
    if (!entry || purpose === 'REFERENCE') return null;
    if (entry.protected) return 'model-derived';
    if (purpose === 'FIT' && !entry.estimable) return 'not estimable';
    return null;
  };

  const localError = value.trim() ? parsed.error?.message : null;
  const message = localError || externalError || null;
  const usedKeys = new Set(sel.qualifiers.map(q => q.key));

  if (raw) {
    return (
      <div className="flex-grow min-w-0">
        <div className="flex items-center gap-1">
          <input
            type="text"
            aria-label={ariaLabel}
            disabled={readOnly}
            value={value}
            placeholder="DW_AB, NUC->G24N-H"
            onChange={e => onChange(e.target.value)}
            className={`${selectorInputCls} flex-grow ${message ? 'border-red-400 dark:border-red-500' : ''}`}
          />
          <button
            type="button"
            disabled={readOnly || structure === null}
            onClick={() => setRaw(false)}
            className="p-1 rounded text-slate-400 hover:text-blue-500 disabled:opacity-40"
            title={structure === null ? 'Fix the selector to switch back to the builder' : 'Switch to the selector builder'}
          >
            <Code className="w-3.5 h-3.5" />
          </button>
        </div>
        {message && <p className="mt-0.5 text-[11px] text-red-600 dark:text-red-400">{message}</p>}
      </div>
    );
  }

  return (
    <div className="flex-grow min-w-0">
      <div className="flex flex-wrap items-center gap-1">
        <select
          aria-label={ariaLabel}
          disabled={readOnly}
          value={sel.name}
          onChange={e => emit({ ...sel, name: e.target.value })}
          className={`${selectorInputCls} font-bold`}
        >
          {!sel.name && <option value="">Parameter…</option>}
          {names.map(n => {
            const why = disabledReason(n);
            return (
              <option key={n} value={n} disabled={!!why && n !== sel.name}>
                {n}
                {why ? ` (${why})` : ''}
              </option>
            );
          })}
        </select>

        {sel.qualifiers.map((q, qi) => {
          const listId = `${uid}-${q.key}`;
          const suggestions = qualifierSuggestions(catalog, sel.name, q.key);
          return (
            <span
              key={q.key}
              className="inline-flex items-center gap-1 pl-1.5 pr-0.5 py-0.5 rounded-md bg-indigo-50 dark:bg-indigo-900/30 border border-indigo-200 dark:border-indigo-800 text-[11px]"
              title={QUALIFIER_HELP[q.key]}
            >
              <span className="font-mono font-bold text-indigo-700 dark:text-indigo-300">{q.key}→</span>
              <input
                type="text"
                list={listId}
                aria-label={`${q.key} qualifier`}
                disabled={readOnly}
                value={q.value}
                size={Math.max(4, q.value.length + 1)}
                onChange={e =>
                  emit({ ...sel, qualifiers: sel.qualifiers.map((x, i) => (i === qi ? { ...x, value: e.target.value.replace(/,/g, '') } : x)) })
                }
                className="bg-transparent font-mono text-slate-800 dark:text-slate-100 outline-none min-w-0"
              />
              <datalist id={listId}>
                {suggestions.map(s => (
                  <option key={s} value={s} />
                ))}
              </datalist>
              {!readOnly && (
                <button
                  type="button"
                  aria-label={`Remove ${q.key}`}
                  onClick={() => emit({ ...sel, qualifiers: sel.qualifiers.filter((_, i) => i !== qi) })}
                  className="p-0.5 rounded text-indigo-400 hover:text-red-500"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </span>
          );
        })}

        {!readOnly && usedKeys.size < QUALIFIER_KEYS.length && (
          <span className="inline-flex items-center gap-0.5 text-slate-400">
            <Plus className="w-3 h-3" />
            <select
              aria-label="Add qualifier"
              value={addKey}
              onChange={e => {
                const key = e.target.value as QualifierKey;
                setAddKey('');
                if (!key) return;
                const first = qualifierSuggestions(catalog, sel.name, key)[0] ?? '';
                emit({ ...sel, qualifiers: [...sel.qualifiers, { key, value: first }] });
              }}
              className="text-[11px] bg-transparent border-none outline-none text-slate-500 dark:text-slate-400 cursor-pointer"
            >
              <option value="">qualifier</option>
              {QUALIFIER_KEYS.filter(k => !usedKeys.has(k)).map(k => {
                const n = qualifierSuggestions(catalog, sel.name, k).length;
                return (
                  <option key={k} value={k}>
                    {k}
                    {n ? ` (${n} known)` : ''}
                  </option>
                );
              })}
            </select>
          </span>
        )}

        <button
          type="button"
          disabled={readOnly}
          onClick={() => setRaw(true)}
          className="p-1 rounded text-slate-400 hover:text-blue-500 disabled:opacity-40"
          title="Edit as raw text"
          aria-label="Edit selector as raw text"
        >
          <Code className="w-3.5 h-3.5" />
        </button>
      </div>
      {message && <p className="mt-0.5 text-[11px] text-red-600 dark:text-red-400">{message}</p>}
    </div>
  );
};

export default SelectorBuilder;
