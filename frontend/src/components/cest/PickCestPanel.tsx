/**
 * Pick CEST: per-residue CEST profile with CS_A / CS_B picking, used by the CEST and the
 * combined Exchange analysis pages. Residue navigation, statuses, notes, shortcuts, URL
 * state and export come from the shared residue browser.
 */

import React, { useCallback, useMemo } from 'react';
import Plot, { PLOT_COLORS } from '../Plot';
import { useResidueBrowser } from '../../hooks/useResidueBrowser';
import { ResidueNavBar, ResidueNotePanel, ResidueTable, type ResidueColumn, type ReviewExport } from '../review/ResidueBrowser';
import {
  type GapContext,
  type ReviewState,
  type ReviewStatus,
  buildBrowserRows,
  isFlagged,
  noteOf,
} from '../../lib/residueReview';
import { MinusCircle } from 'lucide-react';

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
  experiments: CestExperimentData[];
}

export type PickKey = 'cs_a' | 'cs_b' | 'cs_c' | 'cs_d' | 'cs_e' | 'cs_f';
export type CestPickSet = Partial<Record<PickKey, number | null>>;

export const PICK_KEYS: PickKey[] = ['cs_a', 'cs_b', 'cs_c', 'cs_d', 'cs_e', 'cs_f'];
export const PICK_COLORS = [PLOT_COLORS.primary, '#ef4444', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6'];

export const numStatesOf = (model: string): number => {
  const m = (model || '').match(/^(\d)st/);
  return m ? parseInt(m[1], 10) : 2;
};

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
  filterPlanes?: number[];
  isExcluded: (id: string) => boolean;
  toggleExclude: (id: string) => void;
  review: ReviewState;
  setReview: (update: (prev: ReviewState) => ReviewState) => void;
  gapContext?: GapContext;
  onSelectResidue?: (id: string) => void;
  exportName?: string;
}

const STATUS_LABELS: Partial<Record<ReviewStatus, string>> = { accepted: 'Picked' };

export const PickCestPanel: React.FC<PickCestPanelProps> = props => {
  const {
    profiles, picks, onPick, pickMode, setPickMode, model, xiRatio, unitLabel, filterPlanes = [],
    isExcluded, toggleExclude, review, setReview, gapContext, onSelectResidue, exportName = 'pick_cest',
  } = props;
  const nStates = numStatesOf(model);
  const keys = PICK_KEYS.slice(0, Math.max(2, nStates));

  const rows = useMemo(
    () => buildBrowserRows(profiles.map(p => ({ id: p.residue, label: p.full_residue || p.residue })), gapContext),
    [profiles, gapContext]
  );

  const statusOverride = useCallback(
    (id: string, s: ReviewStatus): ReviewStatus => (s === 'unreviewed' && picks[id]?.cs_a != null ? 'accepted' : s),
    [picks]
  );

  const browser = useResidueBrowser({
    rows,
    review,
    setReview,
    isExcluded,
    toggleExclude,
    active: true,
    onArm: mode => setPickMode(mode),
    onAccept: () => {
      const prevMode = pickMode;
      setPickMode('cs_a');
      return () => setPickMode(prevMode);
    },
    statusOverride,
  });

  const selectedId = browser.selectedId;
  React.useEffect(() => {
    if (selectedId) onSelectResidue?.(selectedId);
  }, [selectedId, onSelectResidue]);

  const profile = profiles.find(p => p.residue === selectedId);
  const pick = selectedId ? picks[selectedId] : undefined;

  const nextMode = (mode: PickKey): PickKey => keys[(keys.indexOf(mode) + 1) % nStates] ?? 'cs_a';

  const handlePlotClick = (event: any) => {
    if (!profile) return;
    let x: number | undefined = event.points?.[0]?.x;
    if (event.event && event.points?.[0]?.xaxis) {
      const xaxis = event.points[0].xaxis;
      const preciseX = xaxis.p2c(event.event.layerX - (xaxis._offset || 0));
      if (preciseX !== undefined && !isNaN(preciseX)) x = preciseX;
    }
    if (x === undefined) return;
    const residue = profile.residue;
    const key = pickMode;
    const undoPick = onPick(residue, key, x);
    browser.recordUndo(`Pick ${key.toUpperCase()} ${residue}`, () => {
      undoPick();
      setPickMode(key);
    });
    setPickMode(nextMode(key));
  };

  const columns: ResidueColumn[] = keys.map(k => ({
    key: k,
    header: `${k.toUpperCase()} (${unitLabel})`,
    render: id => (picks[id]?.[k] != null ? (picks[id]![k] as number).toFixed(3) : <span className="text-slate-300 dark:text-slate-600">·</span>),
    sortValue: id => picks[id]?.[k] ?? null,
  }));

  const buildExport = (): ReviewExport => ({
    baseName: exportName,
    columns: keys,
    rows: rows.filter(r => r.present).map(r => ({
      residue: r.id,
      status: browser.status(r.id),
      flagged: isFlagged(review, r.id),
      note: noteOf(review, r.id),
      values: Object.fromEntries(keys.map(k => [k, picks[r.id]?.[k] ?? null])),
    })),
    masks: [],
    meta: { page: 'Pick CEST', model },
  });

  if (profiles.length === 0) return null;

  const excluded = selectedId ? isExcluded(selectedId) : false;
  const modeCls =
    pickMode === 'cs_a'
      ? 'bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800'
      : pickMode === 'cs_b'
      ? 'bg-purple-100 text-purple-700 border-purple-300 dark:bg-purple-900/30 dark:text-purple-400 dark:border-purple-800'
      : 'bg-emerald-100 text-emerald-700 border-emerald-300 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800';

  return (
    <div className="space-y-4 animate-in fade-in">
      <ResidueNavBar browser={browser} statusLabels={STATUS_LABELS} buildExport={buildExport}>
        <button
          type="button"
          onClick={() => setPickMode(nextMode(pickMode))}
          className={`text-xs font-bold px-3 py-1 rounded-full border transition-all ${modeCls}`}
          title="Click to cycle pick mode (A / B)"
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
          title="Accept and go to the next residue (Enter)"
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
              <Plot
                data={profile.experiments.filter(e => !e.error).map((exp, idx) => {
                  const all = exp.offsets.map((o, i) => ({ o, i: exp.intensities[i], err: exp.uncertainties?.[i] ?? 0, planeIdx: i }));
                  const ref = all.find(p => p.o < -10000);
                  const i0 = ref && ref.i !== 0 ? ref.i : 1.0;
                  const pts = all.filter(p => p.o > -10000);
                  const toPpm = (hz: number) => hz / ((exp.b0 || 600.0) * xiRatio) + (exp.carrier || 0.0);
                  const color = idx === 0 ? PLOT_COLORS.primary : '#9333ea';
                  return {
                    x: pts.map(p => toPpm(p.o)),
                    y: pts.map(p => Math.max(0, p.i / i0)),
                    error_y: { type: 'data', array: pts.map(p => Math.abs((p.err || 0) / i0)), visible: true, color, thickness: 1.5, width: 3.5 },
                    type: 'scatter',
                    mode: 'lines+markers',
                    line: { shape: 'spline' },
                    marker: {
                      color: pts.map(p => (filterPlanes.includes(p.planeIdx) ? '#94a3b8' : color)),
                      size: pts.map(p => (filterPlanes.includes(p.planeIdx) ? 6 : 8)),
                      symbol: pts.map(p => (filterPlanes.includes(p.planeIdx) ? 'x' : 'circle')),
                      line: { width: 1.2, color: '#ffffff' },
                    },
                    name: `B1: ${exp.b1_actual || exp.b1} Hz (${exp.b0} MHz)`,
                  };
                })}
                layout={{
                  xaxis: { title: `Shift (${unitLabel})`, autorange: 'reversed' },
                  yaxis: { title: 'I / I₀', autorange: true },
                  margin: { l: 60, r: 30, t: 40, b: 60 },
                  shapes: keys
                    .map((k, i) => {
                      const v = pick?.[k];
                      return v != null
                        ? { type: 'line', x0: v, x1: v, y0: 0, y1: 1, yref: 'paper', line: { color: PICK_COLORS[i], width: 2, dash: 'dash' } }
                        : null;
                    })
                    .filter(Boolean),
                }}
                style={{ width: '100%', height: '400px' }}
                onClick={handlePlotClick}
              />
            </div>
            <ResidueNotePanel browser={browser} label={profile.full_residue || profile.residue} />
          </div>
          <ResidueTable browser={browser} columns={columns} statusLabels={STATUS_LABELS} className="lg:col-span-1 h-[480px]" />
        </div>
      )}
    </div>
  );
};
