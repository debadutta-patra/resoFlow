/**
 * ChemEx v2 deterministic search for one method step:
 * none (implicit TRF), SEARCH.GRID (profiled χ² grid) or SEARCH.DE
 * (selected-coordinate differential evolution seeding one TRF).
 */

import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Dices, Grid3x3, Plus, RotateCcw, Shuffle, Trash2 } from 'lucide-react';
import type { SearchAxis, SearchFunction, SearchMode, Step, StepSearch } from '../../lib/methodConfig';
import { randomSeed } from '../../lib/methodConfig';
import { formatAxis } from '../../lib/methodToml';
import {
  PREFERRED_SEARCH_PARAMS,
  axisPointCount,
  axisPoints,
  createSearchAxis,
  defaultRange,
  type ExperimentFamily,
} from '../../lib/searchDefaults';
import type { AvailableParamMeta } from './ParameterTable';

interface StepSearchSectionProps {
  step: Step;
  onChange: (updated: Step) => void;
  family: ExperimentFamily;
  availableParams: AvailableParamMeta[];
  startingValues?: Record<string, number | string>;
  readOnly?: boolean;
}

const inputCls =
  'w-full text-xs font-mono px-2 py-1 rounded bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200 outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-60';

const MODE_INFO: Record<SearchMode, { label: string; text: string }> = {
  none: {
    label: 'None (TRF)',
    text: 'One bounded trust-region-reflective fit of all FIT coordinates, starting from the latest committed values.',
  },
  grid: {
    label: 'Grid',
    text: 'At every grid point the axes are held fixed while all other FIT coordinates are optimised (profiled χ²); one joint solution is committed. Grid axes are not released afterwards and covariance errors are withheld — follow with a refinement step.',
  },
  de: {
    label: 'Differential evolution',
    text: 'Stochastic search over a few basin-defining coordinates (other FIT coordinates stay at their start values); the best candidate seeds one full TRF. Each coordinate must resolve to exactly one fitted parameter.',
  },
};

const fmt = (x: number) => (Math.abs(x) >= 1e4 || (Math.abs(x) < 1e-3 && x !== 0) ? x.toExponential(2) : Number(x.toPrecision(3)).toString());

const parseNum = (v: string) => (v.trim() === '' ? NaN : Number(v));

/** Comma-separated values editor that only commits parsed numbers on blur (remounted via `key` on external change). */
const ValuesInput: React.FC<{ values: number[]; onCommit: (vals: number[]) => void; disabled?: boolean }> = ({ values, onCommit, disabled }) => {
  const [text, setText] = useState(values.join(', '));
  return (
    <input
      type="text"
      disabled={disabled}
      value={text}
      placeholder="0.01, 0.02, 0.05, 0.1"
      onChange={e => setText(e.target.value)}
      onBlur={() =>
        onCommit(
          text
            .split(/[,\s]+/)
            .map(s => s.trim())
            .filter(Boolean)
            .map(Number)
        )
      }
      className={inputCls}
    />
  );
};

export const StepSearchSection: React.FC<StepSearchSectionProps> = ({
  step,
  onChange,
  family,
  availableParams,
  startingValues = {},
  readOnly = false,
}) => {
  const search: StepSearch = step.search ?? { mode: 'none', axes: [] };
  const [isOpen, setIsOpen] = useState(search.mode !== 'none');
  const [newParam, setNewParam] = useState('');

  const startOf = (param: string): number | undefined => {
    const v = startingValues[param.toLowerCase()] ?? startingValues[param.toUpperCase()];
    const n = typeof v === 'string' ? parseFloat(v) : v;
    return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
  };

  const setSearch = (next: StepSearch) => onChange({ ...step, search: next });

  const setMode = (mode: SearchMode) => {
    if (readOnly) return;
    let axes = search.axes;
    if (mode !== 'none') {
      // DE cannot use values(); fall back to the physical default range.
      if (mode === 'de') {
        axes = axes.map(a => (a.fn === 'values' ? { ...createSearchAxis(a.param, 'de', family, startOf(a.param)), id: a.id, qualifier: a.qualifier } : a));
      }
      if (mode === 'grid') {
        axes = axes.map(a => (a.fn !== 'values' && (!a.count || a.count < 2) ? { ...a, count: defaultRange(a.param, 'grid', family).count } : a));
      }
      if (axes.length === 0) axes = ['PB', 'KEX_AB'].map(p => createSearchAxis(p, mode, family, startOf(p)));
    }
    setSearch({ mode, axes, seed: mode === 'de' ? search.seed ?? randomSeed() : search.seed });
    if (mode !== 'none') setIsOpen(true);
  };

  const updateAxis = (id: string, patch: Partial<SearchAxis>) =>
    setSearch({ ...search, axes: search.axes.map(a => (a.id === id ? { ...a, ...patch } : a)) });

  const resetAxis = (axis: SearchAxis) => {
    if (search.mode === 'none') return;
    const d = createSearchAxis(axis.param, search.mode, family, startOf(axis.param));
    updateAxis(axis.id, { fn: d.fn, low: d.low, high: d.high, count: d.count, values: undefined });
  };

  const moveAxis = (idx: number, dir: -1 | 1) => {
    const axes = [...search.axes];
    const j = idx + dir;
    if (j < 0 || j >= axes.length) return;
    [axes[idx], axes[j]] = [axes[j], axes[idx]];
    setSearch({ ...search, axes });
  };

  const paramOptions = useMemo(() => {
    const names = availableParams.map(p => p.name.toUpperCase());
    const pref = PREFERRED_SEARCH_PARAMS.filter(p => names.includes(p));
    const rest = names.filter(n => !pref.includes(n)).sort();
    return [...pref, ...rest];
  }, [availableParams]);

  const addAxis = () => {
    if (search.mode === 'none') return;
    const param = (newParam || paramOptions.find(p => !search.axes.some(a => a.param === p)) || 'PB').toUpperCase();
    setSearch({ ...search, axes: [...search.axes, createSearchAxis(param, search.mode, family, startOf(param))] });
    setNewParam('');
  };

  const totalPoints = search.axes.reduce((acc, a) => acc * Math.max(1, axisPointCount(a)), 1);
  const active = search.mode !== 'none' && search.axes.length > 0;

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-sm">
      <div className="p-3.5 bg-slate-50/80 dark:bg-slate-800/60 flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center gap-2 text-xs font-bold text-slate-700 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400"
        >
          {isOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          <Grid3x3 className="w-4 h-4 text-amber-500" />
          <span>Deterministic Search (SEARCH.GRID / SEARCH.DE)</span>
          {active && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/60 text-amber-700 dark:text-amber-300 font-mono font-bold">
              {search.mode === 'grid' ? `GRID · ${totalPoints} pts (before factorisation)` : `DE · ${search.axes.length} coord`}
            </span>
          )}
        </button>
        <div className="inline-flex rounded-lg bg-slate-100 dark:bg-slate-800 p-1 border border-slate-200 dark:border-slate-700/80">
          {(['none', 'grid', 'de'] as SearchMode[]).map(m => (
            <button
              key={m}
              type="button"
              disabled={readOnly}
              onClick={() => setMode(m)}
              className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-all ${
                search.mode === m
                  ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-400 shadow-sm border border-slate-200/80 dark:border-slate-600'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              {MODE_INFO[m].label}
            </button>
          ))}
        </div>
      </div>

      {isOpen && (
        <div className="p-4 space-y-3 text-xs">
          <p className="text-slate-500 dark:text-slate-400 leading-relaxed">{MODE_INFO[search.mode].text}</p>

          {search.mode === 'de' && (
            <div className="flex items-center gap-2">
              <label className="font-semibold text-slate-600 dark:text-slate-300">SEED (required):</label>
              <input
                type="number"
                min={0}
                step={1}
                disabled={readOnly}
                value={search.seed ?? ''}
                onChange={e => setSearch({ ...search, seed: e.target.value === '' ? undefined : parseInt(e.target.value, 10) })}
                className={`${inputCls} w-36`}
              />
              <button
                type="button"
                disabled={readOnly}
                onClick={() => setSearch({ ...search, seed: randomSeed() })}
                className="p-1 text-slate-400 hover:text-blue-500 rounded"
                title="Generate random seed"
              >
                <Dices className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {search.mode !== 'none' && (
            <>
              <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400">
                    <tr>
                      <th className="py-2 px-2 font-semibold">Parameter</th>
                      <th className="py-2 px-2 font-semibold">Qualifier (optional)</th>
                      <th className="py-2 px-2 font-semibold">Scale</th>
                      <th className="py-2 px-2 font-semibold">{search.mode === 'grid' ? 'Low · High · Points / Values' : 'Low · High'}</th>
                      <th className="py-2 px-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {search.axes.map((axis, idx) => {
                      const d = defaultRange(axis.param, search.mode as 'grid' | 'de', family, startOf(axis.param));
                      const pts = search.mode === 'grid' ? axisPoints(axis) : [];
                      return (
                        <tr key={axis.id} className="align-top">
                          <td className="py-2 px-2 w-32">
                            <select
                              disabled={readOnly}
                              value={axis.param}
                              onChange={e => {
                                const p = e.target.value;
                                const fresh = createSearchAxis(p, search.mode as 'grid' | 'de', family, startOf(p));
                                updateAxis(axis.id, { param: p, fn: fresh.fn, low: fresh.low, high: fresh.high, count: fresh.count, values: undefined });
                              }}
                              className={inputCls}
                            >
                              {!paramOptions.includes(axis.param) && <option value={axis.param}>{axis.param}</option>}
                              {paramOptions.map(p => (
                                <option key={p} value={p}>
                                  {p}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="py-2 px-2 w-44">
                            <input
                              type="text"
                              disabled={readOnly}
                              value={axis.qualifier ?? ''}
                              placeholder="e.g. NUC->G24N-H"
                              onChange={e => updateAxis(axis.id, { qualifier: e.target.value || undefined })}
                              className={inputCls}
                            />
                          </td>
                          <td className="py-2 px-2 w-24">
                            <select
                              disabled={readOnly}
                              value={axis.fn}
                              onChange={e => {
                                const fn = e.target.value as SearchFunction;
                                if (fn === 'values') {
                                  const vals = axisPoints(axis).map(v => Number(v.toPrecision(3)));
                                  updateAxis(axis.id, { fn, values: vals.length ? Array.from(new Set(vals)) : [axis.low, axis.high] });
                                } else {
                                  const patch: Partial<SearchAxis> = { fn };
                                  if (fn === 'log' && axis.low <= 0) patch.low = d.fn === 'log' ? d.low : Math.max(axis.high / 100, 1e-3);
                                  updateAxis(axis.id, patch);
                                }
                              }}
                              className={inputCls}
                            >
                              <option value="lin">lin</option>
                              <option value="log">log</option>
                              {search.mode === 'grid' && <option value="values">values</option>}
                            </select>
                          </td>
                          <td className="py-2 px-2">
                            {axis.fn === 'values' ? (
                              <ValuesInput key={(axis.values ?? []).join(',')} values={axis.values ?? []} disabled={readOnly} onCommit={values => updateAxis(axis.id, { values })} />
                            ) : (
                              <div className="flex gap-1.5">
                                <input
                                  type="number"
                                  step="any"
                                  disabled={readOnly}
                                  value={Number.isFinite(axis.low) ? axis.low : ''}
                                  onChange={e => updateAxis(axis.id, { low: parseNum(e.target.value) })}
                                  className={inputCls}
                                  title="low"
                                />
                                <input
                                  type="number"
                                  step="any"
                                  disabled={readOnly}
                                  value={Number.isFinite(axis.high) ? axis.high : ''}
                                  onChange={e => updateAxis(axis.id, { high: parseNum(e.target.value) })}
                                  className={inputCls}
                                  title="high"
                                />
                                {search.mode === 'grid' && (
                                  <input
                                    type="number"
                                    min={2}
                                    step={1}
                                    disabled={readOnly}
                                    value={Number.isFinite(axis.count) ? axis.count : ''}
                                    onChange={e => updateAxis(axis.id, { count: parseInt(e.target.value, 10) })}
                                    className={`${inputCls} w-16`}
                                    title="number of points"
                                  />
                                )}
                              </div>
                            )}
                            <div className="mt-1 text-[10px] text-slate-400 dark:text-slate-500 space-y-0.5">
                              <div className={d.generic ? 'text-amber-600 dark:text-amber-400' : ''}>
                                Default: {d.hint}
                                {!d.generic && ` → ${d.fn}(${fmt(d.low)}, ${fmt(d.high)}${search.mode === 'grid' ? `, ${d.count}` : ''})`}
                              </div>
                              {pts.length > 0 && pts.length <= 25 && (
                                <div className="font-mono truncate" title={pts.map(fmt).join(', ')}>
                                  {pts.map(fmt).join(', ')}
                                </div>
                              )}
                              <div className="font-mono text-slate-500 dark:text-slate-400">{formatAxis(axis, search.mode as 'grid' | 'de')}</div>
                            </div>
                          </td>
                          <td className="py-2 px-2 whitespace-nowrap">
                            {!readOnly && (
                              <div className="flex items-center gap-0.5">
                                <button type="button" onClick={() => moveAxis(idx, -1)} className="p-1 text-slate-400 hover:text-blue-500" title="Move up (later axes override earlier broad ones)">
                                  <ChevronUp className="w-3.5 h-3.5" />
                                </button>
                                <button type="button" onClick={() => moveAxis(idx, 1)} className="p-1 text-slate-400 hover:text-blue-500" title="Move down">
                                  <ChevronDown className="w-3.5 h-3.5" />
                                </button>
                                <button type="button" onClick={() => resetAxis(axis)} className="p-1 text-slate-400 hover:text-blue-500" title="Reset to physical default range">
                                  <RotateCcw className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setSearch({ ...search, axes: search.axes.filter(a => a.id !== axis.id) })}
                                  className="p-1 text-slate-400 hover:text-red-500"
                                  title="Remove"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {!readOnly && (
                <div className="flex items-center gap-2">
                  <select value={newParam} onChange={e => setNewParam(e.target.value)} className={`${inputCls} w-40`}>
                    <option value="">Choose parameter…</option>
                    {paramOptions.map(p => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={addAxis}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-dashed border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-blue-400 hover:text-blue-600"
                  >
                    {search.mode === 'grid' ? <Plus className="w-3.5 h-3.5" /> : <Shuffle className="w-3.5 h-3.5" />}
                    <span>{search.mode === 'grid' ? 'Add grid axis' : 'Add DE coordinate'}</span>
                  </button>
                </div>
              )}
              <p className="text-[11px] text-slate-400 dark:text-slate-500 leading-relaxed">
                Search targets must be fitted: parameters left at <em>Default</em> are added to FIT automatically. Residue-local axes (e.g. DW_AB) are
                profiled per residue by ChemEx's exact factorisation, so only global axes multiply the cost. Qualifiers narrow a selector, e.g.{' '}
                <code className="font-mono">NUC-&gt;G24N-H</code>, <code className="font-mono">B0-&gt;800MHz</code>, <code className="font-mono">T-&gt;25C</code>.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default StepSearchSection;
