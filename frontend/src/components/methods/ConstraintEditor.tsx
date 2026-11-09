/**
 * Editor for one ChemEx v2 constraint "[TARGET] = expression".
 *
 * The target uses the selector builder; the right-hand side is free text with
 * autocomplete for "[PARAM, QUAL->…]" references and inline validation against
 * the v2 grammar (finite numbers, bracketed references, parentheses, + - * /).
 */

import React, { useMemo, useRef, useState } from 'react';
import { Code } from 'lucide-react';
import type { ParameterCatalog } from '../../lib/baselineRoles';
import { checkConstraintRhs, parseConstraint, selectorName } from '../../lib/methodGrammar';
import { rhsSuggestions, type Suggestion } from '../../lib/referenceAutocomplete';
import SelectorBuilder from './SelectorBuilder';

const inputCls =
  'w-full text-xs font-mono px-2 py-1 rounded bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200 outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-60';

/** Split "[target] = rhs" structurally (null when the text is not in that shape). */
function splitConstraint(text: string): { target: string; rhs: string } | null {
  const eq = text.indexOf('=');
  if (eq === -1) return text.trim() === '' ? { target: '', rhs: '' } : null;
  const m = /^\s*\[(.*)\]\s*$/.exec(text.slice(0, eq));
  if (!m) return null;
  return { target: m[1], rhs: text.slice(eq + 1).trim() };
}

export interface ConstraintEditorProps {
  value: string;
  onChange: (value: string) => void;
  paramNames: string[];
  catalog?: ParameterCatalog | null;
  readOnly?: boolean;
  externalError?: string | null;
}

export const ConstraintEditor: React.FC<ConstraintEditorProps> = ({ value, onChange, paramNames, catalog, readOnly = false, externalError }) => {
  const parts = useMemo(() => splitConstraint(value), [value]);
  const [rawRequested, setRaw] = useState(false);
  const raw = rawRequested || parts === null;
  const rhsRef = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState<number | null>(null);
  const [active, setActive] = useState(0);

  const names = useMemo(() => {
    const set = new Set(paramNames.map(n => n.toUpperCase()));
    Object.keys(catalog ?? {}).forEach(n => set.add(n));
    return [...set].sort();
  }, [paramNames, catalog]);

  const fullError = value.trim() ? parseConstraint(value).error?.message : null;

  if (raw || !parts) {
    return (
      <div className="flex-grow min-w-0">
        <div className="flex items-center gap-1">
          <input
            type="text"
            aria-label="Constraint equation"
            disabled={readOnly}
            value={value}
            placeholder="[DW_AB, NUC->G31N-H] = [DW_AB, NUC->G24N-H]"
            onChange={e => onChange(e.target.value)}
            className={`${inputCls} ${fullError || externalError ? 'border-red-400 dark:border-red-500' : ''}`}
          />
          <button
            type="button"
            disabled={readOnly || parts === null}
            onClick={() => setRaw(false)}
            className="p-1 rounded text-slate-400 hover:text-blue-500 disabled:opacity-40"
            title={parts === null ? 'Write it as "[TARGET] = expression" to use the builder' : 'Switch to the constraint builder'}
          >
            <Code className="w-3.5 h-3.5" />
          </button>
        </div>
        {(fullError || externalError) && <p className="mt-0.5 text-[11px] text-red-600 dark:text-red-400">{fullError || externalError}</p>}
      </div>
    );
  }

  const set = (target: string, rhs: string) => onChange(`[${target}] = ${rhs}`);
  const rhsCheck = parts.rhs ? checkConstraintRhs(parts.rhs) : null;
  const rhsError = parts.rhs ? rhsCheck?.error : { message: 'Constraint right side cannot be empty', start: 0, end: 0 };
  const unknownRefs = (rhsCheck?.references ?? [])
    .map(r => selectorName(r.text))
    .filter((n): n is string => !!n && names.length > 0 && !names.includes(n));
  const suggestions = caret === null ? [] : rhsSuggestions(parts.rhs, caret, names, catalog);

  const apply = (s: Suggestion) => {
    const next = parts.rhs.slice(0, s.from) + s.insert + parts.rhs.slice(s.to);
    set(parts.target, next);
    const pos = s.from + s.insert.length;
    requestAnimationFrame(() => {
      rhsRef.current?.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };

  return (
    <div className="flex-grow min-w-0">
      <div className="flex flex-wrap items-start gap-1">
        <span className="font-mono text-slate-400 pt-1">[</span>
        <SelectorBuilder
          value={parts.target}
          onChange={t => set(t, parts.rhs)}
          paramNames={paramNames}
          catalog={catalog}
          purpose="CONSTRAIN"
          readOnly={readOnly}
          ariaLabel="Constraint target"
        />
        <span className="font-mono text-slate-400 pt-1">] =</span>
        <div className="relative flex-grow min-w-[12rem]">
          <input
            ref={rhsRef}
            type="text"
            aria-label="Constraint expression"
            disabled={readOnly}
            value={parts.rhs}
            placeholder="0.5 * [R2_A]   (type [ for parameters)"
            onChange={e => {
              set(parts.target, e.target.value);
              setCaret(e.target.selectionStart);
              setActive(0);
            }}
            onSelect={e => setCaret((e.target as HTMLInputElement).selectionStart)}
            onBlur={() => window.setTimeout(() => setCaret(null), 150)}
            onKeyDown={e => {
              if (!suggestions.length) return;
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive(a => (a + 1) % suggestions.length);
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive(a => (a - 1 + suggestions.length) % suggestions.length);
              } else if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                apply(suggestions[Math.min(active, suggestions.length - 1)]);
              } else if (e.key === 'Escape') {
                setCaret(null);
              }
            }}
            className={`${inputCls} ${rhsError ? 'border-red-400 dark:border-red-500' : ''}`}
          />
          {suggestions.length > 0 && (
            <ul
              role="listbox"
              aria-label="Parameter reference suggestions"
              className="absolute top-full left-0 mt-1 w-full max-h-48 overflow-y-auto bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg z-30 py-1"
            >
              {suggestions.map((s, i) => (
                <li key={`${s.label}-${i}`} role="option" aria-selected={i === active}>
                  <button
                    type="button"
                    onMouseDown={e => {
                      e.preventDefault();
                      apply(s);
                    }}
                    className={`w-full text-left px-3 py-1 text-xs font-mono flex justify-between ${
                      i === active ? 'bg-blue-50 dark:bg-blue-900/40' : 'hover:bg-slate-50 dark:hover:bg-slate-700/60'
                    } text-slate-700 dark:text-slate-200`}
                  >
                    <span>{s.label}</span>
                    {s.hint && <span className="text-[10px] font-sans text-slate-400">{s.hint}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button
          type="button"
          disabled={readOnly}
          onClick={() => setRaw(true)}
          className="p-1 rounded text-slate-400 hover:text-blue-500 disabled:opacity-40"
          title="Edit the whole equation as raw text"
          aria-label="Edit constraint as raw text"
        >
          <Code className="w-3.5 h-3.5" />
        </button>
      </div>
      {rhsError && parts.rhs && (
        <p className="mt-0.5 text-[11px] text-red-600 dark:text-red-400 flex flex-wrap items-center gap-1.5">
          <span>
            {rhsError.message}
            {!rhsError.suggestion && rhsError.end > rhsError.start && (
              <span className="font-mono text-red-500/80"> — at “{parts.rhs.slice(rhsError.start, rhsError.end)}”</span>
            )}
          </span>
          {rhsError.suggestion && !readOnly && (
            <button
              type="button"
              onClick={() => set(parts.target, parts.rhs.slice(0, rhsError.start) + rhsError.suggestion + parts.rhs.slice(rhsError.end))}
              className="px-1.5 rounded border border-red-300 dark:border-red-700 font-mono hover:bg-red-50 dark:hover:bg-red-900/30"
            >
              Use {rhsError.suggestion}
            </button>
          )}
        </p>
      )}
      {!rhsError && unknownRefs.length > 0 && (
        <p className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-400">No parameter named {unknownRefs.join(', ')} for this model.</p>
      )}
      {!rhsError && externalError && <p className="mt-0.5 text-[11px] text-red-600 dark:text-red-400">{externalError}</p>}
    </div>
  );
};

export default ConstraintEditor;
