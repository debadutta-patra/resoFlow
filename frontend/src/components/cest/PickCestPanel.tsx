/**
 * Pick CEST: per-residue CEST profile with CS_A / CS_B picking, used by the CEST and the
 * combined Exchange analysis pages. Residue navigation, statuses, notes, shortcuts, URL
 * state and export come from the shared residue browser.
 *
 * Plot conventions: raw data are markers only (masked offsets hollow); lines are fitted
 * curves (one-state fit). Picks are draggable vertical lines.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { MinusCircle, AlertTriangle, Loader2, RefreshCw, ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import Plot, { PLOT_COLORS } from '../Plot';
import api from '../../services/api';
import { useResidueBrowser } from '../../hooks/useResidueBrowser';
import { ResidueNavBar, ResidueNotePanel, ResidueTable, type ResidueColumn, type ReviewExport } from '../review/ResidueBrowser';
import {
  type GapContext,
  type ReviewState,
  type ReviewStatus,
  buildBrowserRows,
  isFlagged,
  noteOf,
  storedStatusOf,
} from '../../lib/residueReview';
import {
  deltaVarpi,
  differenceTrace,
  formatFieldLabel,
  heatmapPanels,
  profilePoints,
  snapAcrossExperiments,
} from '../../lib/cestPicking';
import { activeCestSeeder, candidatesAbove, type SeedCandidate } from '../../lib/cestSeeder';

export interface CestExperimentData {
  b1: string;
  b1_actual?: number;
  b0: number;
  carrier: number;
  offsets: number[];
  intensities: number[];
  uncertainties?: number[];
  filepath?: string;
  error?: string;
}

export interface CestProfileData {
  residue: string;
  full_residue?: string;
  /** 15N peak position from peak fitting (HSQC), when known. */
  cs_hsqc?: number | null;
  experiments: CestExperimentData[];
}

export type PickKey = 'cs_a' | 'cs_b' | 'cs_c' | 'cs_d' | 'cs_e' | 'cs_f';
export type CestPickSet = Partial<Record<PickKey, number | null>>;
/** Offset masks: experiment label (B1 label) → masked plane indices. */
export type CestMasks = Record<string, number[]>;

export const PICK_KEYS: PickKey[] = ['cs_a', 'cs_b', 'cs_c', 'cs_d', 'cs_e', 'cs_f'];
export const PICK_COLORS = [PLOT_COLORS.primary, '#ef4444', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6'];
const FIELD_COLORS = ['#2563eb', '#9333ea', '#0891b2', '#e11d48', '#059669', '#d97706'];

export const numStatesOf = (model: string): number => {
  const m = (model || '').match(/^(\d)st/);
  return m ? parseInt(m[1], 10) : 2;
};

interface OneStateExp {
  label: string;
  x_ppm: number[];
  planes: number[];
  residuals: number[];
  used: boolean[];
  curve: { x_ppm: number[]; y: number[] };
}
interface OneStateFit {
  cs_a: number;
  r2: number;
  r2_err: number | null;
  r1: number;
  redchi: number;
  experiments: OneStateExp[];
  error?: string;
}
interface OneStateResponse {
  fits: Record<string, OneStateFit>;
  r2_stats: { median: number | null; threshold: number | null; flagged: string[] };
}

export interface PickCestPanelProps {
  profiles: CestProfileData[];
  picks: Record<string, CestPickSet>;
  /** Apply one pick (null clears it); returns the function that undoes it. */
  onPick: (residue: string, key: PickKey, value: number | null) => () => void;
  pickMode: PickKey;
  setPickMode: (mode: PickKey) => void;
  model: string;
  xiRatio: number;
  unitLabel: string;
  /** Planes filtered for every experiment (Experiments tab). */
  filterPlanes?: number[];
  masks: CestMasks;
  setMasks: (update: (prev: CestMasks) => CestMasks) => void;
  isExcluded: (id: string) => boolean;
  toggleExclude: (id: string) => void;
  review: ReviewState;
  setReview: (update: (prev: ReviewState) => ReviewState) => void;
  gapContext?: GapContext;
  onSelectResidue?: (id: string) => void;
  exportName?: string;
  /** Fitted shifts from the last committed run, per residue. */
  fittedShifts?: Record<string, { cs_a?: number | null; cs_b?: number | null }>;
  /** Switch the kinetic model (offered when picks need more states than the model has). */
  onChangeModel?: (model: string) => void;
  /** For the one-state fit endpoint. */
  projectUuid?: string;
  analysisUuid?: string;
}

const STATUS_LABELS: Partial<Record<ReviewStatus, string>> = { accepted: 'Picked' };
const fmt = (v: number | null | undefined, d = 3) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : null);
const signed = (v: number, d: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}`;

export const PickCestPanel: React.FC<PickCestPanelProps> = props => {
  const {
    profiles, picks, onPick, pickMode, setPickMode, model, xiRatio, unitLabel, filterPlanes = [], masks, setMasks,
    isExcluded, toggleExclude, review, setReview, gapContext, onSelectResidue, exportName = 'pick_cest',
    fittedShifts = {}, projectUuid, analysisUuid, onChangeModel,
  } = props;
  const nStates = numStatesOf(model);
  /** Number of states a residue's picks define (A plus the highest picked minor state). */
  const pickedStates = (p: CestPickSet | undefined) => {
    let n = 0;
    PICK_KEYS.forEach((k, i) => {
      if (p?.[k] != null) n = i + 1;
    });
    return n;
  };
  const maxPicked = Math.max(0, ...Object.values(picks).map(pickedStates));
  /** Pick columns: the model's states plus any extra states picked anywhere. */
  const keys = PICK_KEYS.slice(0, Math.max(2, nStates, maxPicked));

  const [showDiff, setShowDiff] = useState(false);
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [oneState, setOneState] = useState<OneStateResponse | null>(null);
  const [oneStateBusy, setOneStateBusy] = useState(false);
  const [oneStateError, setOneStateError] = useState('');
  const [seedThreshold, setSeedThreshold] = useState(0.7);
  const [seedCands, setSeedCands] = useState<Record<string, SeedCandidate[]>>({});
  const seeder = activeCestSeeder();

  const rows = useMemo(
    () => buildBrowserRows(profiles.map(p => ({ id: p.residue, label: p.full_residue || p.residue })), gapContext),
    [profiles, gapContext]
  );

  /** Suggested CS_A: previous run's fit, else the HSQC peak position. */
  const suggestionOf = useCallback(
    (id: string): { value: number; source: string } | null => {
      const fit = fittedShifts[id]?.cs_a;
      if (typeof fit === 'number' && Number.isFinite(fit)) return { value: fit, source: 'previous run' };
      const hsqc = profiles.find(p => p.residue === id)?.cs_hsqc;
      if (typeof hsqc === 'number' && Number.isFinite(hsqc)) return { value: hsqc, source: 'HSQC peak' };
      return null;
    },
    [fittedShifts, profiles]
  );

  // A picked residue counts as accepted unless a status was set explicitly (incl. a reset).
  const statusOverride = useCallback(
    (id: string, s: ReviewStatus, stored: string | undefined): ReviewStatus =>
      s === 'unreviewed' && stored === undefined && picks[id]?.cs_a != null ? 'accepted' : s,
    [picks]
  );
  const statusWarning = useCallback(
    (id: string): string | null => {
      const minor = PICK_KEYS.slice(1).filter(k => picks[id]?.[k] != null);
      return storedStatusOf(review, id) === 'no_excited_state' && minor.length
        ? `Marked "no excited state" but has ${minor.map(k => k.toUpperCase()).join(', ')} pick(s): remove them or change the status`
        : null;
    },
    [picks, review]
  );

  const browser = useResidueBrowser({
    rows,
    review,
    setReview,
    isExcluded,
    toggleExclude,
    active: true,
    onArm: mode => setPickMode(mode),
    onAccept: id => {
      const prevMode = pickMode;
      setPickMode('cs_a');
      // Accepting commits the suggested CS_A when nothing was picked.
      const sug = picks[id]?.cs_a == null ? suggestionOf(id) : null;
      const undoPick = sug ? onPick(id, 'cs_a', sug.value) : null;
      return () => {
        undoPick?.();
        setPickMode(prevMode);
      };
    },
    statusOverride,
  });

  const selectedId = browser.selectedId;
  useEffect(() => {
    if (selectedId) onSelectResidue?.(selectedId);
  }, [selectedId, onSelectResidue]);

  const profile = profiles.find(p => p.residue === selectedId);
  const pick = selectedId ? picks[selectedId] : undefined;
  const experiments = useMemo(() => (profile?.experiments ?? []).filter(e => !e.error), [profile]);
  const isMasked = useCallback(
    (label: string, plane: number) => filterPlanes.includes(plane) || (masks[label] ?? []).includes(plane),
    [filterPlanes, masks]
  );

  // ── One-state fits (all residues, so R2 can be compared across them) ──
  const runOneState = useCallback(async () => {
    if (!projectUuid || !analysisUuid) return;
    setOneStateBusy(true);
    setOneStateError('');
    try {
      const res = await api.post(`/api/projects/${projectUuid}/analysis/${analysisUuid}/inspection/cest/one-state`, {
        masks,
        xi: xiRatio,
      });
      if (res?.data?.fits) setOneState(res.data as OneStateResponse);
    } catch (e: any) {
      setOneStateError(e?.response?.data?.detail || e?.message || 'One-state fit failed');
    } finally {
      setOneStateBusy(false);
    }
    // Masks are sent at call time; refits are explicit (button) to keep the page responsive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectUuid, analysisUuid, xiRatio]);
  useEffect(() => {
    void runOneState();
  }, [runOneState, profiles.length]);

  const fit = selectedId ? oneState?.fits?.[selectedId] : undefined;
  const r2High = !!(selectedId && oneState?.r2_stats?.flagged?.includes(selectedId));

  // ── Seeder candidates (behind a feature flag) ──
  useEffect(() => {
    if (!seeder || !profile || seedCands[profile.residue]) return;
    let live = true;
    Promise.resolve(seeder.candidates(profile, { xi: xiRatio, csA: pick?.cs_a ?? null })).then(c => {
      if (live) setSeedCands(prev => ({ ...prev, [profile.residue]: c }));
    });
    return () => {
      live = false;
    };
  }, [seeder, profile, xiRatio, pick?.cs_a, seedCands]);

  // States in play for this residue: the model's, extra picked ones, and the armed one.
  const resStates = Math.max(1, nStates, pickedStates(pick), PICK_KEYS.indexOf(pickMode) + 1);
  const resKeys = PICK_KEYS.slice(0, Math.max(2, resStates));
  const nextMode = (mode: PickKey): PickKey => PICK_KEYS[(PICK_KEYS.indexOf(mode) + 1) % resStates] ?? 'cs_a';
  const nextNewState = PICK_KEYS[Math.max(nStates, pickedStates(pick), 2)] as PickKey | undefined;

  const commitPick = (residue: string, key: PickKey, value: number | null, label?: string) => {
    const undoPick = onPick(residue, key, value);
    browser.recordUndo(label ?? `Pick ${key.toUpperCase()} ${residue}`, undoPick);
  };

  const toggleMask = (label: string, plane: number) => {
    const before = masks;
    setMasks(prev => {
      const cur = new Set(prev[label] ?? []);
      if (cur.has(plane)) cur.delete(plane);
      else cur.add(plane);
      const next = { ...prev };
      if (cur.size) next[label] = Array.from(cur).sort((a, b) => a - b);
      else delete next[label];
      return next;
    });
    browser.recordUndo(`Mask plane ${plane} (${label})`, () => setMasks(() => before));
  };

  const handlePlotClick = (event: any) => {
    if (!profile) return;
    const pt = event.points?.[0];
    const ev: MouseEvent | undefined = event.event;
    // Shift-click a data point: mask / unmask that offset.
    if (ev?.shiftKey) {
      const meta = pt?.data?.meta;
      if (meta?.kind === 'data' && typeof pt.customdata === 'number') toggleMask(meta.label, pt.customdata);
      return;
    }
    let x: number | undefined = pt?.x;
    if (ev && pt?.xaxis) {
      const preciseX = pt.xaxis.p2c((ev as any).layerX - (pt.xaxis._offset || 0));
      if (preciseX !== undefined && !isNaN(preciseX)) x = preciseX;
    }
    if (x === undefined || !Number.isFinite(x)) return;
    // Snap to the local minimum unless Alt is held.
    if (!ev?.altKey) {
      const snapped = snapAcrossExperiments(experiments, x, xiRatio, (e, plane) => isMasked(e.b1, plane), 0.5);
      if (snapped !== null) x = snapped;
    }
    const key = pickMode;
    const undoPick = onPick(profile.residue, key, x);
    browser.recordUndo(`Pick ${key.toUpperCase()} ${profile.residue}`, () => {
      undoPick();
      setPickMode(key);
    });
    setPickMode(nextMode(key));
  };

  // ── Plot ──
  const suggestion = selectedId && pick?.cs_a == null ? suggestionOf(selectedId) : null;
  const shapeKeys: Array<PickKey | 'suggestion'> = [];
  const shapes: any[] = [];
  resKeys.forEach((k, i) => {
    const v = pick?.[k];
    if (v == null) return;
    shapeKeys.push(k);
    shapes.push({ type: 'line', x0: v, x1: v, y0: 0, y1: 1, yref: 'paper', line: { color: PICK_COLORS[i], width: 2, dash: 'dash' } });
  });
  if (suggestion) {
    shapeKeys.push('suggestion');
    shapes.push({ type: 'line', x0: suggestion.value, x1: suggestion.value, y0: 0, y1: 1, yref: 'paper', line: { color: PICK_COLORS[0], width: 1.5, dash: 'dot' }, opacity: 0.5 });
  }

  const handleRelayout = (ev: any) => {
    if (!profile || !ev) return;
    for (const [k, v] of Object.entries(ev)) {
      const m = k.match(/^shapes\[(\d+)\]\.x0$/);
      if (!m || typeof v !== 'number') continue;
      const which = shapeKeys[Number(m[1])];
      if (!which) continue;
      const key: PickKey = which === 'suggestion' ? 'cs_a' : which;
      commitPick(profile.residue, key, v, `Drag ${key.toUpperCase()} ${profile.residue}`);
    }
  };

  const hasResidualPanel = !!fit && !fit.error;
  const traces: any[] = [];
  experiments.forEach((exp, idx) => {
    const color = FIELD_COLORS[idx % FIELD_COLORS.length];
    const pts = profilePoints(exp, xiRatio);
    const name = formatFieldLabel(exp);
    const hasErr = pts.some(p => p.err > 0);
    const masked = pts.map(p => isMasked(exp.b1, p.plane));
    traces.push({
      x: pts.map(p => p.ppm),
      y: pts.map(p => p.y),
      customdata: pts.map(p => p.plane),
      meta: { kind: 'data', label: exp.b1 },
      error_y: hasErr ? { type: 'data', array: pts.map(p => p.err), visible: true, color, thickness: 1, width: 2 } : undefined,
      type: 'scatter',
      mode: 'markers',
      name,
      legendgroup: exp.b1,
      marker: {
        color: masked.map(m => (m ? 'rgba(0,0,0,0)' : color)),
        size: 7,
        symbol: masked.map(m => (m ? 'circle-open' : 'circle')),
        line: { width: masked.map(m => (m ? 1.5 : 0.8)), color: masked.map(m => (m ? color : '#ffffff')) },
      },
      hovertemplate: `%{x:.3f} ${unitLabel}<br>I/I0 %{y:.3f}<br>plane %{customdata}<extra>${name}</extra>`,
    });
    const fe = fit?.experiments?.find(f => f.label === exp.b1);
    if (fe) {
      traces.push({
        x: fe.curve.x_ppm,
        y: fe.curve.y,
        type: 'scatter',
        mode: 'lines',
        name: `${name} one-state fit`,
        legendgroup: exp.b1,
        showlegend: idx === 0,
        line: { color, width: 1.5 },
        hoverinfo: 'skip',
      });
      traces.push({
        x: fe.x_ppm,
        y: fe.residuals,
        xaxis: 'x',
        yaxis: 'y2',
        type: 'scatter',
        mode: 'markers',
        name: `${name} residual`,
        legendgroup: exp.b1,
        showlegend: false,
        marker: { color: fe.used.map(u => (u ? color : 'rgba(0,0,0,0)')), size: 5, symbol: fe.used.map(u => (u ? 'circle' : 'circle-open')), line: { color, width: 1 } },
        hovertemplate: `%{x:.3f} ${unitLabel}<br>residual %{y:.4f}<extra>${name}</extra>`,
      });
    }
  });
  const diff = showDiff ? differenceTrace(experiments, xiRatio) : null;
  if (diff) {
    traces.push({
      x: diff.x,
      y: diff.y,
      yaxis: 'y3',
      type: 'scatter',
      mode: 'markers',
      name: `Difference: ${formatFieldLabel(diff.low)} − ${formatFieldLabel(diff.high)}`,
      marker: { color: '#64748b', size: 4, symbol: 'diamond' },
    });
  }
  const seeds = selectedId ? seedCands[selectedId] ?? [] : [];
  if (seeds.length) {
    traces.push({
      x: seeds.map(s => s.cs_ppm),
      y: seeds.map(() => 0.02),
      yaxis: 'y',
      type: 'scatter',
      mode: 'markers+text',
      name: 'Seeder candidates',
      text: seeds.map(s => s.confidence.toFixed(2)),
      textposition: 'top center',
      marker: { symbol: 'triangle-up', size: 9, color: 'rgba(239,68,68,0.35)' },
    });
  }

  const layout: any = {
    xaxis: { title: `15N offset (${unitLabel})`, autorange: 'reversed', anchor: hasResidualPanel ? 'y2' : 'y' },
    yaxis: { title: 'I/I0', domain: hasResidualPanel ? [0.3, 1] : [0, 1], autorange: true },
    margin: { l: 60, r: diff ? 60 : 30, t: 30, b: 60 },
    legend: { orientation: 'h', y: -0.18 },
    shapes,
  };
  if (hasResidualPanel) layout.yaxis2 = { title: 'Resid.', domain: [0, 0.22], zeroline: true };
  if (diff) layout.yaxis3 = { title: 'ΔI/I0 (low − high B1)', overlaying: 'y', side: 'right', showgrid: false, zeroline: true };

  // ── Table and export ──
  const fittedOf = (id: string, k: PickKey): number | null => {
    const f = fittedShifts[id]?.[k as 'cs_a' | 'cs_b'];
    if (typeof f === 'number') return f;
    if (k === 'cs_a') return oneState?.fits?.[id]?.cs_a ?? null;
    return null;
  };
  const extraPickColumns: ResidueColumn[] = keys.slice(2).map((k, i) => ({
    key: k,
    header: `${k.toUpperCase()} pick`,
    render: (id: string) => fmt(picks[id]?.[k]) ?? <span className="text-slate-300 dark:text-slate-600">·</span>,
    sortValue: (id: string) => picks[id]?.[k] ?? null,
    className: i % 2 ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300',
  }));
  const columns: ResidueColumn[] = keys.slice(0, 2).flatMap((k, i) => [
    {
      key: k,
      header: `${k.toUpperCase()} pick`,
      render: (id: string) => fmt(picks[id]?.[k]) ?? <span className="text-slate-300 dark:text-slate-600">·</span>,
      sortValue: (id: string) => picks[id]?.[k] ?? null,
      className: i === 0 ? 'text-blue-700 dark:text-blue-300' : 'text-rose-700 dark:text-rose-300',
    },
    {
      key: `${k}_fit`,
      header: `${k.toUpperCase()} fit`,
      render: (id: string) => {
        const v = fmt(fittedOf(id, k));
        const fromOneState = k === 'cs_a' && fittedShifts[id]?.cs_a == null && v !== null;
        return v ? <span className="text-slate-500" title={fromOneState ? 'One-state fit' : 'Last committed run'}>{v}{fromOneState ? '¹' : ''}</span> : <span className="text-slate-300 dark:text-slate-600">·</span>;
      },
      sortValue: (id: string) => fittedOf(id, k),
    },
  ]);
  columns.push(...extraPickColumns);
  columns.push({
    key: 'r2_one',
    header: 'R2 (1-st)',
    render: id => {
      const r2 = oneState?.fits?.[id]?.r2;
      if (typeof r2 !== 'number') return <span className="text-slate-300 dark:text-slate-600">·</span>;
      const high = oneState?.r2_stats?.flagged?.includes(id);
      return <span className={high ? 'text-amber-600 dark:text-amber-400 font-bold' : ''} title={high ? 'High R2 vs other residues: one-state misfit' : undefined}>{r2.toFixed(1)}{high ? ' ▲' : ''}</span>;
    },
    sortValue: id => oneState?.fits?.[id]?.r2 ?? null,
  });

  const maskRows = () =>
    Object.entries(masks).flatMap(([label, planes]) => {
      const exp = profiles.flatMap(p => p.experiments).find(e => e.b1 === label);
      const pts = exp ? profilePoints(exp, xiRatio) : [];
      return planes.map(plane => ({ experiment: label, plane, offset_ppm: pts.find(p => p.plane === plane)?.ppm ?? null }));
    });

  const buildExport = (): ReviewExport => ({
    baseName: exportName,
    columns: [...keys, 'cs_a_fit', 'r2_one_state'],
    rows: rows.filter(r => r.present).map(r => ({
      residue: r.id,
      status: browser.status(r.id),
      flagged: isFlagged(review, r.id),
      note: noteOf(review, r.id),
      values: {
        ...Object.fromEntries(keys.map(k => [k, picks[r.id]?.[k] ?? null])),
        cs_a_fit: fittedOf(r.id, 'cs_a'),
        r2_one_state: oneState?.fits?.[r.id]?.r2 ?? null,
      },
    })),
    masks: maskRows(),
    meta: { page: 'Pick CEST', model },
  });

  const heatmaps = useMemo(() => (showHeatmap ? heatmapPanels(profiles, xiRatio) : []), [showHeatmap, profiles, xiRatio]);

  if (profiles.length === 0) return null;

  const excluded = selectedId ? isExcluded(selectedId) : false;
  const b0 = experiments[0]?.b0 ?? 600;
  const modeCls =
    pickMode === 'cs_a'
      ? 'bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800'
      : pickMode === 'cs_b'
      ? 'bg-purple-100 text-purple-700 border-purple-300 dark:bg-purple-900/30 dark:text-purple-400 dark:border-purple-800'
      : 'bg-emerald-100 text-emerald-700 border-emerald-300 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800';
  const chip = 'px-2 py-0.5 rounded-md border text-[11px] font-mono';
  const toggleCls = (on: boolean) =>
    `px-2.5 py-1 rounded-lg border text-xs font-semibold ${on ? 'bg-slate-700 text-white border-slate-700 dark:bg-slate-200 dark:text-slate-900' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-600'}`;
  const nMasked = Object.values(masks).reduce((n, p) => n + p.length, 0);

  const acceptCandidate = (residue: string, c: SeedCandidate) => {
    const slot = keys.slice(1).find(k => picks[residue]?.[k] == null) ?? 'cs_b';
    commitPick(residue, slot, c.cs_ppm, `Accept candidate ${residue}`);
  };
  const acceptAllAbove = () => {
    const undos: Array<() => void> = [];
    for (const [residue, cands] of Object.entries(seedCands)) {
      const best = candidatesAbove(cands, seedThreshold)[0];
      if (best && picks[residue]?.cs_b == null) undos.push(onPick(residue, 'cs_b', best.cs_ppm));
    }
    if (undos.length) browser.recordUndo(`Accept ${undos.length} candidates`, () => undos.reverse().forEach(u => u()));
  };

  return (
    <div className="space-y-4 animate-in fade-in">
      <ResidueNavBar browser={browser} statusLabels={STATUS_LABELS} buildExport={buildExport} statusWarning={statusWarning}>
        <button
          type="button"
          onClick={() => setPickMode(nextMode(pickMode))}
          className={`text-xs font-bold px-3 py-1 rounded-full border transition-all ${modeCls}`}
          title="Click to cycle pick mode (keys A … F arm a state directly)"
        >
          Click to set: {pickMode.toUpperCase()}
        </button>
        <button
          type="button"
          onClick={() => browser.markNoExcited()}
          className="px-3 py-2 bg-sky-50 hover:bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300 border border-sky-200 dark:border-sky-800 text-sm font-medium rounded-lg"
          title="No excited state visible for this residue (N)"
        >
          No excited state
        </button>
        <button
          type="button"
          onClick={browser.acceptAndNext}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 dark:bg-indigo-600 dark:hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-all shadow-sm"
          title={suggestion ? `Accept (commits suggested CS_A ${suggestion.value.toFixed(3)} from ${suggestion.source}) and go to the next residue (Enter)` : 'Accept and go to the next residue (Enter)'}
        >
          Accept & Next
        </button>
      </ResidueNavBar>

      {profile && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-2">
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl p-2">
              {excluded && (
                <div className="mb-2 px-3 py-1.5 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 rounded-lg text-xs text-rose-700 dark:text-rose-300 font-semibold flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <MinusCircle className="w-3.5 h-3.5 text-rose-500 shrink-0" />
                    <span>This residue is excluded and commented out in the ChemEx parameter file.</span>
                  </div>
                  <button type="button" onClick={() => browser.toggleExclusion()} className="underline ml-2">Include Residue</button>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2 px-2 pb-2 text-xs">
                {resKeys.map((k, i) => {
                  const v = pick?.[k];
                  if (v == null) return null;
                  const d = i > 0 && pick?.cs_a != null ? deltaVarpi(pick.cs_a, v, b0, xiRatio) : null;
                  const state = k.slice(3).toUpperCase();
                  return (
                    <span key={k} className={`${chip} inline-flex items-center gap-1`} style={{ borderColor: PICK_COLORS[i] + '66', color: PICK_COLORS[i] }} data-testid={`pick-chip-${k}`}>
                      CS_{state} {v.toFixed(3)}
                      {d && (
                        <span className="text-slate-600 dark:text-slate-300" title={`Δϖ = CS_${state} − CS_A`} data-testid={i === 1 ? 'delta-varpi' : `delta-varpi-${k}`}>
                          · Δϖ{i > 1 ? `_A${state}` : ''} {signed(d.ppm, 3)} ppm ({signed(d.hz, 1)} Hz)
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => commitPick(profile.residue, k, null, `Remove CS_${state} ${profile.residue}`)}
                        className="ml-0.5 text-slate-400 hover:text-rose-600"
                        title={`Remove the CS_${state} pick`}
                        aria-label={`Remove CS_${state}`}
                      >
                        ×
                      </button>
                    </span>
                  );
                })}
                {nextNewState && (
                  <button
                    type="button"
                    onClick={() => setPickMode(nextNewState)}
                    className={`${chip} border-dashed border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:border-slate-500`}
                    title={`Arm CS_${nextNewState.slice(3).toUpperCase()}: the next click on the plot picks an additional excited state (key ${nextNewState.slice(3).toUpperCase()})`}
                  >
                    + Add state {nextNewState.slice(3).toUpperCase()}
                  </button>
                )}
                {pickedStates(pick) > nStates && (
                  <span className={`${chip} border-amber-400 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300`} data-testid="model-states-warning">
                    <AlertTriangle className="inline w-3 h-3 mr-1" />
                    Picks define {pickedStates(pick)} states; model {model} fits {nStates}
                    {onChangeModel && (
                      <button type="button" className="ml-1 underline font-semibold" onClick={() => onChangeModel(`${pickedStates(pick)}st`)}>
                        use {pickedStates(pick)}st
                      </button>
                    )}
                  </span>
                )}
                {suggestion && (
                  <span className={`${chip} border-dashed border-blue-300 text-blue-600 dark:text-blue-300`} title="Dotted line; drag it or press Accept to commit">
                    suggested CS_A {suggestion.value.toFixed(3)} ({suggestion.source})
                  </span>
                )}
                {fit && !fit.error && (
                  <span
                    className={`${chip} ${r2High ? 'border-amber-400 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 font-bold' : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'}`}
                    title={`One-state fit at R1 = ${fit.r1} s⁻¹ (only R2 − R1 is determined). ${r2High ? 'R2 is high relative to other residues: a one-state misfit inflates R2 and is a known source of false positives.' : ''}`}
                    data-testid="one-state-r2"
                  >
                    {r2High && <AlertTriangle className="inline w-3 h-3 mr-1" />}
                    R2 (one-state) {fit.r2.toFixed(1)}{fit.r2_err ? ` ± ${fit.r2_err.toFixed(1)}` : ''} s⁻¹ · χ²ᵣ {fit.redchi.toFixed(2)}
                    {r2High && oneState?.r2_stats.median != null ? ` (median ${oneState.r2_stats.median.toFixed(1)})` : ''}
                  </span>
                )}
                <div className="ml-auto flex items-center gap-1.5">
                  <button type="button" className={toggleCls(showDiff)} onClick={() => setShowDiff(v => !v)} aria-pressed={showDiff} title="Lowest B1 minus highest B1, interpolated onto a common offset grid">
                    Difference trace
                  </button>
                  <button type="button" className={toggleCls(false)} onClick={() => void runOneState()} disabled={oneStateBusy} title="Re-run the one-state fit for all residues (uses current masks)">
                    {oneStateBusy ? <Loader2 className="inline w-3 h-3 animate-spin" /> : <RefreshCw className="inline w-3 h-3" />} One-state fit
                  </button>
                </div>
              </div>
              {oneStateError && <div className="px-2 pb-1 text-[11px] text-rose-600">{oneStateError}</div>}
              <Plot
                data={traces}
                layout={layout}
                config={{ responsive: true, displaylogo: false, edits: { shapePosition: true } }}
                style={{ width: '100%', height: hasResidualPanel ? '480px' : '400px' }}
                onClick={handlePlotClick}
                onRelayout={handleRelayout}
              />
              <p className="px-2 pt-1 text-[10px] text-slate-400">
                Click near a dip to pick (snaps to the local minimum; hold Alt for no snap). Drag a pick line to move it.
                Shift-click a point to mask/unmask that offset{nMasked ? ` (${nMasked} masked)` : ''}. ChemEx filters per experiment, so a mask drops that offset for every residue of that B1 field via filter_planes in the experiment TOML.
              </p>
            </div>

            {seeder && (
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl p-3 text-xs space-y-2" data-testid="seeder-panel">
                <div className="flex items-center gap-2 font-semibold"><Sparkles className="w-3.5 h-3.5 text-rose-500" /> Candidate minor dips ({seeder.name})</div>
                {seeds.length === 0 ? <div className="text-slate-400">No candidates for this residue.</div> : (
                  <ul className="space-y-1">
                    {seeds.map((c, i) => (
                      <li key={i} className="flex items-center gap-2">
                        <span className="font-mono">{c.cs_ppm.toFixed(3)} {unitLabel}</span>
                        <span className="text-slate-500">confidence {c.confidence.toFixed(2)}</span>
                        <button type="button" className="ml-auto underline text-blue-600" onClick={() => acceptCandidate(profile.residue, c)}>accept</button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex items-center gap-2">
                  <label className="text-slate-500">Threshold</label>
                  <input type="range" min={0} max={1} step={0.05} value={seedThreshold} onChange={e => setSeedThreshold(parseFloat(e.target.value))} />
                  <span className="font-mono">{seedThreshold.toFixed(2)}</span>
                  <button type="button" className="ml-auto px-2 py-1 rounded border border-slate-300 dark:border-slate-600" onClick={acceptAllAbove}>
                    Accept all above threshold
                  </button>
                </div>
              </div>
            )}

            <ResidueNotePanel browser={browser} label={profile.full_residue || profile.residue} />
          </div>
          <ResidueTable browser={browser} columns={columns} statusLabels={STATUS_LABELS} statusWarning={statusWarning} className="lg:col-span-1 h-[560px]" />
        </div>
      )}

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl">
        <button type="button" onClick={() => setShowHeatmap(v => !v)} className="w-full flex items-center gap-2 px-4 py-2 text-xs font-bold text-slate-700 dark:text-slate-200" aria-expanded={showHeatmap}>
          {showHeatmap ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          Overview heatmap (residues × offset, I/I0)
        </button>
        {showHeatmap && (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 p-3 pt-0">
            {heatmaps.map(h => (
              <Plot
                key={h.label}
                data={[{
                  type: 'heatmap',
                  x: h.x,
                  y: h.residues.map(r => profiles.find(p => p.residue === r)?.full_residue || r),
                  z: h.z,
                  customdata: h.residues.map(r => h.x.map(() => r)),
                  colorscale: 'Viridis',
                  zmin: 0,
                  zmax: 1.05,
                  colorbar: { title: 'I/I0', thickness: 10 },
                  hovertemplate: '%{y}<br>%{x:.2f} ppm<br>I/I0 %{z:.3f}<extra></extra>',
                }]}
                layout={{
                  title: { text: h.title, font: { size: 12 } },
                  xaxis: { title: `15N offset (${unitLabel})`, autorange: 'reversed' },
                  yaxis: { automargin: true, type: 'category' },
                  margin: { l: 70, r: 20, t: 30, b: 45 },
                }}
                style={{ width: '100%', height: `${Math.max(240, 14 * h.residues.length + 90)}px` }}
                onClick={(ev: any) => {
                  const r = ev?.points?.[0]?.customdata;
                  if (typeof r === 'string') browser.select(r);
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
