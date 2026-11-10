/**
 * ChemEx v2 deterministic search for one method step:
 * none (implicit TRF), SEARCH.GRID (profiled χ² grid) or SEARCH.DE
 * (selected-coordinate differential evolution seeding one TRF).
 *
 * GRID and DE never change roles: every axis must resolve to final FIT
 * coordinates of this step. Each axis shows what ChemEx resolved it to (or why
 * it is invalid, e.g. after a role change) with a one-click "Add FIT rule".
 */

import { searchAxisDomId } from '../../lib/parameterRoleView';
import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Clock, Dices, Grid3x3, Info, Plus, RotateCcw, Shuffle, Trash2, Wrench } from 'lucide-react';
import type { SearchAxis, SearchFunction, SearchMode, Step, StepSearch } from '../../lib/methodConfig';
import { newMethodId } from '../../lib/methodConfig';
import { randomSeed, seedError, toSeed } from '../../lib/seed';
import { axisSelector, formatAxis } from '../../lib/methodToml';
import { lenientSelector } from '../../lib/methodGrammar';
import type { ParameterCatalog } from '../../lib/baselineRoles';
import type { ResolvedAxis, ResolvedSearch } from '../../lib/resolvedRoles';
import { estimateStepSeconds, formatDuration, type StepTiming } from '../../lib/searchEstimate';
import { PREFERRED_SEARCH_PARAMS, axisPointCount, axisPoints, createSearchAxis, defaultRange, type ExperimentFamily } from '../../lib/searchDefaults';
import type { AvailableParamMeta } from './ParameterTable';
import SelectorBuilder from './SelectorBuilder';
import ChemexIssueList from './ChemexIssueList';
import type { ValidationError } from '../../lib/methodValidation';

interface StepSearchSectionProps {
  step: Step;
  onChange: (updated: Step) => void;
  family: ExperimentFamily;
  availableParams: AvailableParamMeta[];
  startingValues?: Record<string, number | string>;
  readOnly?: boolean;
  /** ChemEx parameter catalog (qualifier suggestions, protection). */
  catalog?: ParameterCatalog | null;
  /** ChemEx resolution of this step's search (per axis), when available. */
  resolvedSearch?: ResolvedSearch | null;
  /** The resolution belongs to an older version of the method (do not flag axes). */
  resolvedStale?: boolean;
  /** Last run's per-step durations, for the runtime estimate. */
  timings?: StepTiming[];
  /** Insert a TRF step after this one with ROLES_FROM = this step. */
  onAddRefineStep?: () => void;
  /** ChemEx problems for this step (SEARCH.* ones are shown here). */
  chemexIssues?: ValidationError[];
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
    text: 'At every grid point the axes are held fixed while every other FIT coordinate is optimised (profiled χ²); ChemEx commits one coherent joint solution.',
  },
  de: {
    label: 'Differential evolution',
    text: 'Stochastic search over a few basin-defining coordinates (other FIT coordinates stay at their start values); the best candidate seeds one full TRF that releases the complete FIT set.',
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
      aria-label="Grid values"
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

/** What ChemEx resolved this axis to, or why it is invalid. */
const AxisStatus: React.FC<{ axis: ResolvedAxis; mode: 'grid' | 'de'; onAddFit?: () => void; readOnly: boolean }> = ({ axis, mode, onAddFit, readOnly }) => {
  if (axis.error) {
    const fitProblem = /FIT coordinate/.test(axis.error.message);
    return (
      <div className="text-[11px] text-red-600 dark:text-red-400 flex flex-wrap items-center gap-1.5">
        <span>{axis.error.message}</span>
        {fitProblem && onAddFit && !readOnly && (
          <button type="button" onClick={onAddFit} className="inline-flex items-center gap-0.5 px-1.5 rounded border border-red-300 dark:border-red-700 hover:bg-red-50 dark:hover:bg-red-900/30">
            <Wrench className="w-3 h-3" /> Add FIT rule
          </button>
        )}
      </div>
    );
  }
  const n = axis.coordinates.length;
  if (mode === 'de') return <div className="text-[11px] text-emerald-600 dark:text-emerald-400 font-mono">→ {axis.coordinates[0]}</div>;
  const replaced = n - (axis.owned ?? n);
  return (
    <div className="text-[11px] text-emerald-600 dark:text-emerald-400" title={axis.coordinates.join(', ')}>
      → {n} FIT coordinate{n === 1 ? '' : 's'}
      {replaced > 0 && <span className="text-slate-500 dark:text-slate-400"> · {replaced} replaced by a later axis</span>}
      {replaced === n && n > 0 && <span className="text-amber-600 dark:text-amber-400"> (this axis has no effect)</span>}
    </div>
  );
};

export const StepSearchSection: React.FC<StepSearchSectionProps> = ({
  step,
  onChange,
  family,
  availableParams,
  startingValues = {},
  readOnly = false,
  catalog,
  resolvedSearch,
  resolvedStale = false,
  timings,
  onAddRefineStep,
  chemexIssues = [],
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
    // DE requires a SEED: pre-fill one (kept when switching back and forth).
    setSearch({ mode, axes, seed: mode === 'de' ? search.seed ?? randomSeed() : search.seed });
    if (mode !== 'none') setIsOpen(true);
  };

  const updateAxis = (id: string, patch: Partial<SearchAxis>) => setSearch({ ...search, axes: search.axes.map(a => (a.id === id ? { ...a, ...patch } : a)) });

  const setAxisTarget = (axis: SearchAxis, selector: string) => {
    const parsed = lenientSelector(selector);
    if (!parsed) return;
    const qualifier = parsed.qualifiers.map(q => `${q.key}->${q.value}`).join(', ') || undefined;
    if (parsed.name && parsed.name !== axis.param.toUpperCase() && search.mode !== 'none') {
      const fresh = createSearchAxis(parsed.name, search.mode, family, startOf(parsed.name));
      updateAxis(axis.id, { param: parsed.name, qualifier, fn: fresh.fn, low: fresh.low, high: fresh.high, count: fresh.count, values: undefined });
    } else {
      updateAxis(axis.id, { param: parsed.name || axis.param, qualifier });
    }
  };

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

  const addFitRule = (axis: SearchAxis) =>
    onChange({ ...step, roleRules: [...(step.roleRules ?? []), { id: newMethodId('rule'), action: 'FIT', entries: [axisSelector(axis)] }] });

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

  const active = search.mode !== 'none' && search.axes.length > 0;
  const resolved = !resolvedStale && resolvedSearch && resolvedSearch.kind === search.mode ? resolvedSearch : null;
  const naivePoints = search.axes.reduce((acc, a) => acc * Math.max(1, axisPointCount(a)), 1);
  const evaluations = resolved?.evaluations ?? null;
  const estimate = search.mode === 'grid' && evaluations ? estimateStepSeconds(evaluations, step.name, timings) : null;
  const seedMsg = search.mode === 'de' ? seedError(search.seed, true) : null;
  const searchIssues = chemexIssues.filter(e => (e.source?.field ?? '').startsWith('SEARCH'));
  const isAxisIssue = (e: ValidationError) => /\.(AXES|COORDINATES)$/.test(e.source?.field ?? '') && typeof e.source?.index === 'number';
  const axisIssues = (idx: number) => searchIssues.filter(e => isAxisIssue(e) && e.source?.index === idx);
  const generalIssues = searchIssues.filter(e => !isAxisIssue(e) || (e.source?.index ?? 0) >= search.axes.length);

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-sm">
      <div className="p-3.5 bg-slate-50/80 dark:bg-slate-800/60 flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          aria-expanded={isOpen}
          className="flex items-center gap-2 text-xs font-bold text-slate-700 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400"
        >
          {isOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          <Grid3x3 className="w-4 h-4 text-amber-500" />
          <span>Deterministic Search (SEARCH.GRID / SEARCH.DE)</span>
          {searchIssues.length > 0 && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-300 font-bold">
              {searchIssues.length} ChemEx error{searchIssues.length > 1 ? 's' : ''}
            </span>
          )}
          {active && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/60 text-amber-700 dark:text-amber-300 font-mono font-bold">
              {search.mode === 'grid'
                ? evaluations
                  ? `GRID · ${evaluations.toLocaleString()} profiled evaluations`
                  : `GRID · ${naivePoints.toLocaleString()} pts before factorisation`
                : `DE · ${search.axes.length} coord`}
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
          <ChemexIssueList issues={generalIssues} />

          {search.mode === 'grid' && (
            <div className="flex flex-wrap items-start gap-2 p-2.5 rounded-lg border border-sky-200 dark:border-sky-800 bg-sky-50/60 dark:bg-sky-950/30 text-sky-800 dark:text-sky-200">
              <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <p className="flex-1 min-w-[16rem] leading-relaxed">
                GRID does not release its own axes (no automatic final TRF) and ChemEx withholds covariance errors for a GRID step. Refine in a
                following ordinary step: it starts from the committed grid state.
              </p>
              {onAddRefineStep && !readOnly && (
                <button
                  type="button"
                  onClick={onAddRefineStep}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white dark:bg-slate-800 border border-sky-300 dark:border-sky-700 font-semibold hover:bg-sky-100 dark:hover:bg-sky-900/40"
                >
                  <Plus className="w-3 h-3" /> Add TRF refine step after
                </button>
              )}
            </div>
          )}

          {search.mode === 'de' && (
            <>
              <div className="flex items-start gap-2 p-2.5 rounded-lg border border-sky-200 dark:border-sky-800 bg-sky-50/60 dark:bg-sky-950/30 text-sky-800 dark:text-sky-200">
                <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <p className="leading-relaxed">
                  Each coordinate must resolve to exactly one final FIT coordinate (qualify residue parameters, e.g.{' '}
                  <code className="font-mono">DW_AB, NUC-&gt;K19N</code>). If DE fails, ChemEx does <strong>not</strong> fall back to a plain TRF fit; the
                  step fails.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <label className="font-semibold text-slate-600 dark:text-slate-300" htmlFor={`de-seed-${step.id}`}>
                  SEED (required):
                </label>
                <input
                  id={`de-seed-${step.id}`}
                  type="text"
                  inputMode="numeric"
                  disabled={readOnly}
                  value={search.seed ?? ''}
                  placeholder="unsigned 64-bit integer"
                  onChange={e => setSearch({ ...search, seed: toSeed(e.target.value) })}
                  className={`${inputCls} w-52 ${seedMsg ? 'border-red-400 dark:border-red-500' : ''}`}
                  title={seedMsg ?? 'ChemEx DE seed (0 – 18446744073709551615)'}
                />
                <button
                  type="button"
                  disabled={readOnly}
                  onClick={() => setSearch({ ...search, seed: randomSeed() })}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-slate-500 hover:text-blue-600 border border-slate-200 dark:border-slate-700"
                  title="Draw a new random 64-bit seed"
                >
                  <Dices className="w-3.5 h-3.5" /> Re-roll
                </button>
                {seedMsg && <span className="text-[11px] text-red-600 dark:text-red-400">{seedMsg}</span>}
              </div>
            </>
          )}

          {search.mode !== 'none' && (
            <>
              <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400">
                    <tr>
                      <th className="py-2 px-2 font-semibold w-6">#</th>
                      <th className="py-2 px-2 font-semibold">Target (FIT coordinate selector)</th>
                      <th className="py-2 px-2 font-semibold">Scale</th>
                      <th className="py-2 px-2 font-semibold">{search.mode === 'grid' ? 'Low · High · Points / Values' : 'Low · High'}</th>
                      <th className="py-2 px-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {search.axes.map((axis, idx) => {
                      const d = defaultRange(axis.param, search.mode as 'grid' | 'de', family, startOf(axis.param));
                      const pts = search.mode === 'grid' ? axisPoints(axis) : [];
                      const status = resolved?.axes[idx];
                      return (
                        <tr key={axis.id} id={searchAxisDomId(axis.id)} className="align-top">
                          <td className="py-2 px-2 font-mono text-slate-400">{idx + 1}</td>
                          <td className="py-2 px-2 min-w-[14rem]">
                            <SelectorBuilder
                              value={axisSelector(axis)}
                              onChange={sel => setAxisTarget(axis, sel)}
                              paramNames={paramOptions}
                              catalog={catalog}
                              purpose="FIT"
                              readOnly={readOnly}
                              ariaLabel={`Axis ${idx + 1} target`}
                            />
                            {status ? (
                              <div className="mt-1">
                                <AxisStatus axis={status} mode={search.mode as 'grid' | 'de'} readOnly={readOnly} onAddFit={() => addFitRule(axis)} />
                              </div>
                            ) : (
                              <ChemexIssueList issues={axisIssues(idx)} className="mt-1" />
                            )}
                          </td>
                          <td className="py-2 px-2 w-24">
                            <select
                              aria-label={`Axis ${idx + 1} scale`}
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
                                <input type="number" step="any" disabled={readOnly} value={Number.isFinite(axis.low) ? axis.low : ''} onChange={e => updateAxis(axis.id, { low: parseNum(e.target.value) })} className={inputCls} aria-label={`Axis ${idx + 1} low`} />
                                <input type="number" step="any" disabled={readOnly} value={Number.isFinite(axis.high) ? axis.high : ''} onChange={e => updateAxis(axis.id, { high: parseNum(e.target.value) })} className={inputCls} aria-label={`Axis ${idx + 1} high`} />
                                {search.mode === 'grid' && (
                                  <input
                                    type="number"
                                    min={2}
                                    step={1}
                                    disabled={readOnly}
                                    value={Number.isFinite(axis.count) ? axis.count : ''}
                                    onChange={e => updateAxis(axis.id, { count: parseInt(e.target.value, 10) })}
                                    className={`${inputCls} w-16`}
                                    aria-label={`Axis ${idx + 1} points`}
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
                                <button type="button" onClick={() => moveAxis(idx, -1)} className="p-1 text-slate-400 hover:text-blue-500" aria-label={`Move axis ${idx + 1} up`} title="Move up">
                                  <ChevronUp className="w-3.5 h-3.5" />
                                </button>
                                <button type="button" onClick={() => moveAxis(idx, 1)} className="p-1 text-slate-400 hover:text-blue-500" aria-label={`Move axis ${idx + 1} down`} title="Move down">
                                  <ChevronDown className="w-3.5 h-3.5" />
                                </button>
                                <button type="button" onClick={() => resetAxis(axis)} className="p-1 text-slate-400 hover:text-blue-500" title="Reset to physical default range" aria-label={`Reset axis ${idx + 1}`}>
                                  <RotateCcw className="w-3.5 h-3.5" />
                                </button>
                                <button type="button" onClick={() => setSearch({ ...search, axes: search.axes.filter(a => a.id !== axis.id) })} className="p-1 text-slate-400 hover:text-red-500" title="Remove" aria-label={`Remove axis ${idx + 1}`}>
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

              {search.mode === 'grid' && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-600 dark:text-slate-300">
                  {resolved && evaluations ? (
                    <span>
                      {resolved.global_points ?? 1} global point{(resolved.global_points ?? 1) === 1 ? '' : 's'}
                      {resolved.local_points && Object.keys(resolved.local_points).length > 0
                        ? ` × local grids of ${Object.keys(resolved.local_points).length} residue(s) (Σ ${Object.values(resolved.local_points).reduce((a, b) => a + b, 0)})`
                        : ''}{' '}
                      = <strong>{evaluations.toLocaleString()}</strong> profiled evaluations (ChemEx factorises residue-local axes)
                    </span>
                  ) : (
                    <span>{naivePoints.toLocaleString()} grid points before factorisation (resolving with ChemEx…)</span>
                  )}
                  <span className="flex items-center gap-1 text-slate-500 dark:text-slate-400">
                    <Clock className="w-3 h-3" />
                    {estimate
                      ? `≈ ${formatDuration(estimate.seconds)} — ${estimate.proxy ? `rough, using last run's ${estimate.basedOn}` : `last run's ${estimate.basedOn}`} took ${estimate.secondsPerFit.toFixed(2)} s per fit`
                      : 'Runtime estimate available after a run (uses its step timings).'}
                  </span>
                </div>
              )}

              {!readOnly && (
                <div className="flex items-center gap-2">
                  <select value={newParam} onChange={e => setNewParam(e.target.value)} className={`${inputCls} w-40`} aria-label="Parameter for new axis">
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
                Targets must already be FIT coordinates of this step (set them in the table or rules above) — GRID and DE never change roles.
                {search.mode === 'grid' &&
                  ' Axes apply top to bottom: a later, more specific axis (e.g. DW_AB, NUC->G24N) replaces an earlier broad one (DW_AB) for the coordinates it matches.'}
                {search.mode === 'grid' ? ' Only lin(low, high, count), log(low, high, count) and values(…) are accepted.' : ' Only lin(low, high) and log(low, high) are accepted; log ranges must be positive.'}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default StepSearchSection;
