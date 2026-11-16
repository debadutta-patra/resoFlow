import React, { useState, useMemo, useCallback, useEffect } from "react";
import { Sparkles, BarChart2, Info, ArrowDownToLine, X, AlertTriangle } from "lucide-react";
import { useResidueBrowser } from "../../hooks/useResidueBrowser";
import { ResidueNavBar, ResidueNotePanel, ResidueTable, type ResidueColumn, type ResidueFilter, type ReviewExport } from "../review/ResidueBrowser";
import { EMPTY_REVIEW, buildBrowserRows, isFlagged, noteOf, type GapContext, type ReviewState } from "../../lib/residueReview";
import { Plot } from "../Plot";
import api from "../../services/api";
import { fallbackDefaults } from "../../lib/chemexDefaults";
import { useTheme } from "../../context/ThemeContext";
import { SpinSystemKey } from "../../lib/spinSystem";
import {
  REX_DEFINITION,
  cestDw,
  cestRexConsistency,
  curveForField,
  duplicateMask,
  dwSeedRange,
  formatFieldMHz,
  matchCestPick,
  meanByNu,
  residualsAgainst,
  type FitCurve,
  type SeedAssumptions,
  type SeedRange,
} from "../../lib/cpmgInspection";
import type { CpmgParameterConfig } from "../../lib/cpmgConfig";

export interface CpmgExpCurve {
  b0: number;
  time_t2: number;
  carrier: number;
  nu_cpmg: number[];
  r2eff: number[];
  r2eff_err: number[];
  rex: number;
  rex_err: number;
  chi2_red: number;
  is_flat: boolean;
}

export interface CpmgProfileItem {
  residue: string;
  full_residue: string;
  experiments: CpmgExpCurve[];
  /** Ground-state shift from peak fitting (ppm), when available. */
  cs_a?: number;
  overall_rex?: number;
  estimated_dw?: number;
}

interface FieldScreening {
  b0: number | null;
  rex: number | null;
  rex_err: number | null;
  rex_err_pooled: number | null;
  duplicates: { pooled_sd: number | null; dof: number; reported_rms: number | null; ratio: number | null };
}
interface ResidueScreening {
  fields: FieldScreening[];
  rex: number | null;
  rex_err: number | null;
  rex_b0: number | null;
  max_ratio: number | null;
}

/** Assumptions recorded with the analysis when |Δω| is seeded from Rex. */
export interface RexSeedRecord extends SeedAssumptions {
  appliedAt: string;
  residues: number;
  relation: string;
}

export interface CpmgDispersionTabProps {
  profiles: CpmgProfileItem[];
  /** Kept in sync with the browser selection (index into `profiles`). */
  currentIndex?: number;
  onSelectIndex?: (idx: number) => void;
  parameterConfig: CpmgParameterConfig;
  /** SpinSystemKey-aware exclusion test (falls back to the config's excluded list). */
  isExcluded?: (resKey: string) => boolean;
  review?: ReviewState;
  setReview?: (update: (prev: ReviewState) => ReviewState) => void;
  gapContext?: GapContext;
  exportName?: string;
  onToggleExcludeResidue: (resKey: string) => void;
  onBulkSetExcludedResidues: (excluded: string[]) => void;
  onSeedDeltaOmega: (resKey: string, dwPpm: number) => void;
  onBulkSeedDeltaOmega: (seeds: Record<string, number>) => void;
  xiRatio?: number;
  unitLabel?: string;
  /** For the screening endpoint (Rex with error, pooled duplicate error). */
  projectUuid?: string;
  analysisUuid?: string;
  /** Fitted curves from the last run, per residue. */
  fitCurves?: Record<string, FitCurve[]>;
  /** Pick CEST picks for the same residues (same analysis or another CEST analysis). */
  cestPicks?: Record<string, { cs_a?: number | null; cs_b?: number | null }>;
  cestSourceLabel?: string;
  /** Last recorded Rex-seed assumptions, and the callback that records new ones. */
  rexSeed?: RexSeedRecord | null;
  onRexSeed?: (record: RexSeedRecord) => void;
}

const FIELD_PALETTE = ["#3b82f6", "#a855f7", "#06b6d4", "#f43f5e", "#10b981", "#f59e0b"];
const num = (v: number | null | undefined, d = 1) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : null);
const dot = <span className="text-slate-300 dark:text-slate-600">·</span>;

export const CpmgDispersionTab: React.FC<CpmgDispersionTabProps> = ({
  profiles = [],
  onSelectIndex,
  parameterConfig,
  isExcluded: isExcludedProp,
  review: reviewProp,
  setReview: setReviewProp,
  gapContext,
  exportName = "inspect_dispersion",
  onToggleExcludeResidue,
  onBulkSetExcludedResidues,
  onBulkSeedDeltaOmega,
  xiRatio = 0.101329118,
  unitLabel = "ppm",
  projectUuid,
  analysisUuid,
  fitCurves = {},
  cestPicks,
  cestSourceLabel = "Pick CEST",
  rexSeed,
  onRexSeed,
}) => {
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const axisFont = { color: isDark ? "#cbd5e1" : "#475569" };
  const gridColor = isDark ? "#334155" : "#e2e8f0";

  const safeProfiles = useMemo(() => (Array.isArray(profiles) ? profiles : []), [profiles]);

  const [rexCutoff, setRexCutoff] = useState<number>(2.0);
  const [dupFactor, setDupFactor] = useState<number>(3);
  const [consistencyTol, setConsistencyTol] = useState<number>(0.3);
  const [showGuide, setShowGuide] = useState(false);
  const [showScreeningModal, setShowScreeningModal] = useState(false);
  const [showSeedDialog, setShowSeedDialog] = useState(false);
  const [screening, setScreening] = useState<Record<string, ResidueScreening>>({});

  // Seed assumptions: last recorded, else the parameter config, else ChemEx's defaults.
  const defaultPb = parameterConfig?.globals?.pb?.value ?? fallbackDefaults("PB")?.value ?? 0.05;
  const defaultKex = parameterConfig?.globals?.kex_ab?.value ?? fallbackDefaults("KEX_AB")?.value ?? 200;
  const [assume, setAssume] = useState<SeedAssumptions>(() =>
    rexSeed
      ? { pb: rexSeed.pb, kex: rexSeed.kex, pbRange: rexSeed.pbRange, kexRange: rexSeed.kexRange }
      : { pb: defaultPb, kex: defaultKex, pbRange: [defaultPb / 2, Math.min(0.5, defaultPb * 2)], kexRange: [defaultKex / 2, defaultKex * 2] }
  );

  const excludedSet = useMemo(() => new Set(parameterConfig?.excludedResidues || []), [parameterConfig?.excludedResidues]);
  const isExcluded = useCallback(
    (id: string) => (isExcludedProp ? isExcludedProp(id) : excludedSet.has(id)),
    [isExcludedProp, excludedSet]
  );

  // Review state: owned by the page when provided, else local (unsaved).
  const [localReview, setLocalReview] = useState<ReviewState>(EMPTY_REVIEW);
  const review = reviewProp ?? localReview;
  const setReview = setReviewProp ?? ((u: (prev: ReviewState) => ReviewState) => setLocalReview(u));

  const rows = useMemo(
    () => buildBrowserRows(safeProfiles.map(p => ({ id: p.residue, label: p.full_residue || p.residue })), gapContext),
    [safeProfiles, gapContext]
  );
  const browser = useResidueBrowser({ rows, review, setReview, isExcluded, toggleExclude: onToggleExcludeResidue, active: true });
  const currentProfile = safeProfiles.find(p => p.residue === browser.selectedId);
  useEffect(() => {
    const i = safeProfiles.findIndex(p => p.residue === browser.selectedId);
    if (i >= 0) onSelectIndex?.(i);
  }, [browser.selectedId, safeProfiles, onSelectIndex]);

  // ── Backend screening: Rex ± error and pooled duplicate error ──
  useEffect(() => {
    if (!projectUuid || !analysisUuid || safeProfiles.length === 0) return;
    let live = true;
    api
      .post(`/api/projects/${projectUuid}/analysis/${analysisUuid}/inspection/cpmg/screening`, {
        profiles: safeProfiles.map(p => ({
          residue: p.residue,
          experiments: (p.experiments || []).map(e => ({ b0: e.b0, nu_cpmg: e.nu_cpmg, r2eff: e.r2eff, r2eff_err: e.r2eff_err })),
        })),
      })
      .then(res => {
        if (live && res?.data?.residues) setScreening(res.data.residues);
      })
      .catch(() => {
        /* fall back to the Rex stored with the profiles */
      });
    return () => {
      live = false;
    };
  }, [projectUuid, analysisUuid, safeProfiles]);

  const profileOf = useCallback((id: string) => safeProfiles.find(p => p.residue === id), [safeProfiles]);
  /** Residue Rex (field with the largest Rex) ± error. */
  const rexOf = useCallback(
    (id: string): { rex: number | null; err: number | null; b0: number | null } => {
      const s = screening[id];
      if (s) return { rex: s.rex, err: s.rex_err, b0: s.rex_b0 };
      const exps = profileOf(id)?.experiments || [];
      const best = exps.reduce<CpmgExpCurve | null>((a, e) => (a === null || (e?.rex ?? -Infinity) > (a.rex ?? -Infinity) ? e : a), null);
      return { rex: best?.rex ?? null, err: best?.rex_err ?? null, b0: best?.b0 ?? null };
    },
    [screening, profileOf]
  );
  const dupRatioOf = (id: string) => screening[id]?.max_ratio ?? null;
  const dupFlagged = (id: string) => (dupRatioOf(id) ?? 0) > dupFactor;
  const seedOf = useCallback(
    (id: string): SeedRange | null => {
      const r = rexOf(id);
      return r.rex === null ? null : dwSeedRange(r.rex, assume, r.b0 ?? 600, xiRatio);
    },
    [rexOf, assume, xiRatio]
  );
  const cestDwOf = (id: string) => cestDw(matchCestPick(cestPicks, id));

  const aboveCutoff = useMemo(
    () => safeProfiles.filter(p => (rexOf(p.residue).rex ?? -Infinity) >= rexCutoff).map(p => p.residue),
    [safeProfiles, rexOf, rexCutoff]
  );

  const handleApplyCutoff = () => {
    const keep = new Set(aboveCutoff);
    onBulkSetExcludedResidues(safeProfiles.map(p => p.residue).filter(r => !keep.has(r)));
    setShowScreeningModal(false);
  };

  const applySeeds = () => {
    const seeds: Record<string, number> = {};
    for (const p of safeProfiles) {
      const s = seedOf(p.residue);
      if (s) seeds[p.residue] = Number(s.value.toFixed(3));
    }
    onBulkSeedDeltaOmega(seeds);
    onRexSeed?.({
      ...assume,
      appliedAt: new Date().toISOString(),
      residues: Object.keys(seeds).length,
      relation: "fast exchange: Rex ≈ pA·pB·Δω²/kex",
    });
    setShowSeedDialog(false);
  };

  const inheritable = useMemo(
    () => safeProfiles.map(p => [p.residue, cestDwOf(p.residue)] as const).filter((e): e is readonly [string, number] => e[1] !== null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [safeProfiles, cestPicks]
  );
  const inheritFromCest = () => onBulkSeedDeltaOmega(Object.fromEntries(inheritable.map(([r, dw]) => [r, Number(dw.toFixed(3))])));

  // ── Table ──
  const columns: ResidueColumn[] = [
    {
      key: "rex",
      header: <span title={REX_DEFINITION} className="inline-flex items-center gap-1">Rex (s⁻¹)<Info className="w-3 h-3" /></span>,
      className: "text-right",
      render: id => {
        const r = rexOf(id);
        return r.rex === null ? dot : <span title={REX_DEFINITION}>{r.rex.toFixed(1)}{r.err !== null ? <span className="text-slate-400"> ±{r.err.toFixed(1)}</span> : null}</span>;
      },
      sortValue: id => rexOf(id).rex,
    },
    {
      key: "dup",
      header: <span title={`Pooled duplicate SD ÷ reported error; flagged above ${dupFactor}×`}>Dup ÷ σ</span>,
      className: "text-right",
      render: id => {
        const ratio = dupRatioOf(id);
        if (ratio === null) return dot;
        return <span className={dupFlagged(id) ? "text-amber-600 dark:text-amber-400 font-bold" : ""}>{ratio.toFixed(1)}×{dupFlagged(id) ? " ▲" : ""}</span>;
      },
      sortValue: id => dupRatioOf(id),
    },
    {
      key: "dw",
      header: `|Δω| seed (${unitLabel})`,
      className: "text-right text-purple-600 dark:text-purple-400",
      render: id => {
        const s = seedOf(id);
        return s ? <span title={`range ${s.min.toFixed(2)}–${s.max.toFixed(2)} over pB ${assume.pbRange.join("–")}, kex ${assume.kexRange.join("–")}`}>{s.value.toFixed(2)}</span> : dot;
      },
      sortValue: id => seedOf(id)?.value ?? null,
    },
  ];
  if (cestPicks && Object.keys(cestPicks).length) {
    columns.push({
      key: "cest",
      header: <span title={`Signed Δω = CS_B − CS_A from ${cestSourceLabel}; ✓ when |Δω| lies within the Rex-derived range ±${Math.round(consistencyTol * 100)} %`}>Δω CEST</span>,
      className: "text-right",
      render: id => {
        const dw = cestDwOf(id);
        if (dw === null) return dot;
        const c = cestRexConsistency(dw, seedOf(id), consistencyTol);
        return (
          <span className={c === "disagree" ? "text-amber-600 dark:text-amber-400 font-bold" : ""} data-consistency={c}>
            {dw >= 0 ? "+" : "−"}{Math.abs(dw).toFixed(2)} {c === "consistent" ? "✓" : c === "disagree" ? "⚠" : ""}
          </span>
        );
      },
      sortValue: id => cestDwOf(id),
    });
  }
  const filters: ResidueFilter[] = [
    { key: "dup", label: `Duplicate spread > ${dupFactor}×`, test: dupFlagged },
    { key: "above", label: `Rex ≥ cutoff (${rexCutoff.toFixed(1)})`, test: id => (rexOf(id).rex ?? -Infinity) >= rexCutoff },
  ];
  if (cestPicks) filters.push({ key: "disagree", label: "CEST/Rex disagree", test: id => cestRexConsistency(cestDwOf(id), seedOf(id), consistencyTol) === "disagree" });

  const buildExport = (): ReviewExport => ({
    baseName: exportName,
    columns: ["rex", "rex_err", "dup_ratio", "dw_seed", "dw_seed_min", "dw_seed_max", "dw_cest", "cest_consistency"],
    rows: rows.filter(r => r.present).map(r => {
      const s = seedOf(r.id);
      const dw = cestDwOf(r.id);
      return {
        residue: r.id,
        status: browser.status(r.id),
        flagged: isFlagged(review, r.id),
        note: noteOf(review, r.id),
        values: {
          rex: rexOf(r.id).rex,
          rex_err: rexOf(r.id).err,
          dup_ratio: dupRatioOf(r.id),
          dw_seed: s?.value ?? null,
          dw_seed_min: s?.min ?? null,
          dw_seed_max: s?.max ?? null,
          dw_cest: dw,
          cest_consistency: cestPicks ? cestRexConsistency(dw, s, consistencyTol) : null,
        },
      };
    }),
    meta: {
      page: "Inspect Dispersion",
      rex_definition: REX_DEFINITION,
      rex_cutoff: String(rexCutoff),
      duplicate_factor: String(dupFactor),
      seed_assumptions: `pb=${assume.pb} (${assume.pbRange.join("-")}), kex=${assume.kex} (${assume.kexRange.join("-")})`,
    },
  });

  // ── Dispersion plot ──
  const curves = currentProfile ? fitCurves[currentProfile.residue] : undefined;
  const plotTraces: any[] = [];
  let hasResiduals = false;
  (currentProfile?.experiments || []).forEach((exp, idx) => {
    const color = FIELD_PALETTE[idx % FIELD_PALETTE.length];
    const name = formatFieldMHz(exp?.b0);
    const nu = exp?.nu_cpmg || [];
    const r2 = exp?.r2eff || [];
    const dup = duplicateMask(nu);
    plotTraces.push({
      x: nu,
      y: r2,
      error_y: { type: "data", array: exp?.r2eff_err || [], visible: (exp?.r2eff_err || []).length > 0, color, thickness: 1.2, width: 3 },
      type: "scatter",
      mode: "markers",
      name,
      legendgroup: name,
      marker: {
        color,
        size: dup.map(d => (d ? 9 : 7)),
        symbol: dup.map(d => (d ? "diamond" : "circle")),
        line: { width: 1, color: "#ffffff" },
      },
      hovertemplate: `ν %{x:.0f} Hz<br>R2,eff %{y:.2f} s⁻¹<extra>${name}</extra>`,
    });
    if (showGuide) {
      const g = meanByNu(nu, r2);
      plotTraces.push({ x: g.x, y: g.y, type: "scatter", mode: "lines", name: `${name} mean`, legendgroup: name, showlegend: false, line: { color, width: 0.8, dash: "dot" }, hoverinfo: "skip" });
    }
    const curve = curveForField(curves, exp?.b0, idx);
    if (curve) {
      plotTraces.push({ x: curve.x, y: curve.y, type: "scatter", mode: "lines", name: `${name} fit`, legendgroup: name, line: { color, width: 1.8 } });
      const res = residualsAgainst(curve, nu, r2);
      hasResiduals = true;
      plotTraces.push({
        x: nu,
        y: res.map(v => (Number.isFinite(v) ? v : null)),
        yaxis: "y2",
        type: "scatter",
        mode: "markers",
        name: `${name} residual`,
        legendgroup: name,
        showlegend: false,
        marker: { color, size: 5, symbol: dup.map(d => (d ? "diamond" : "circle")) },
      });
    }
  });
  const anyDup = (currentProfile?.experiments || []).some(e => duplicateMask(e?.nu_cpmg || []).some(Boolean));
  const axis = (title: string, extra: any = {}) => ({ title: { text: title, font: axisFont }, gridcolor: gridColor, zerolinecolor: isDark ? "#475569" : "#cbd5e1", tickfont: { color: isDark ? "#94a3b8" : "#64748b" }, ...extra });

  // ── Rex bar chart ──
  const barIds = safeProfiles.map(p => p.residue).filter(id => rexOf(id).rex !== null);
  const barTrace = {
    type: "bar",
    x: barIds.map(id => SpinSystemKey.parse(id).resNum),
    y: barIds.map(id => rexOf(id).rex),
    customdata: barIds,
    error_y: { type: "data", array: barIds.map(id => rexOf(id).err ?? 0), visible: true, thickness: 1, width: 2, color: isDark ? "#94a3b8" : "#64748b" },
    marker: {
      color: barIds.map(id => (id === browser.selectedId ? "#f59e0b" : (rexOf(id).rex ?? 0) >= rexCutoff ? "#3b82f6" : "#cbd5e1")),
    },
    hovertemplate: "%{customdata}<br>Rex %{y:.2f} s⁻¹<extra></extra>",
    name: "Rex",
  };

  const sectionCls = "bg-slate-50 dark:bg-slate-800/50 p-5 rounded-xl border border-slate-200 dark:border-slate-700";
  const inputCls = "w-20 text-xs px-2 py-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded text-slate-800 dark:text-slate-200";

  return (
    <div className="space-y-4 animate-in fade-in">
      <ResidueNavBar browser={browser} buildExport={buildExport}>
        <button
          type="button"
          onClick={() => browser.markNoExcited()}
          className="px-3 py-1.5 bg-sky-50 hover:bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300 border border-sky-200 dark:border-sky-800 rounded-lg text-xs font-bold"
          title="No exchange contribution for this residue (N)"
        >
          No excited state
        </button>
        <button
          type="button"
          onClick={browser.acceptAndNext}
          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 dark:bg-indigo-600 text-white rounded-lg text-xs font-bold"
          title="Accept and go to the next residue (Enter)"
        >
          Accept & Next
        </button>
      </ResidueNavBar>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          onClick={() => setShowScreeningModal(!showScreeningModal)}
          className="px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:hover:bg-blue-900/50 dark:text-blue-300 border border-blue-200 dark:border-blue-800 rounded-lg text-xs font-bold flex items-center gap-1.5"
        >
          <BarChart2 className="w-3.5 h-3.5" />
          Screen on Rex Cutoff
        </button>
        {inheritable.length > 0 && (
          <button
            onClick={inheritFromCest}
            className="px-3 py-1.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 rounded-lg text-xs font-bold flex items-center gap-1.5"
            title={`Set DW_AB = CS_B − CS_A (signed) from ${cestSourceLabel} for ${inheritable.length} residue(s)`}
          >
            <ArrowDownToLine className="w-3.5 h-3.5" />
            Inherit Δω from {cestSourceLabel} ({inheritable.length})
          </button>
        )}
        <button
          onClick={() => setShowSeedDialog(true)}
          className="px-3 py-1.5 bg-purple-50 hover:bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:hover:bg-purple-900/50 dark:text-purple-300 border border-purple-200 dark:border-purple-800 rounded-lg text-xs font-bold flex items-center gap-1.5"
          title="Estimate |Δω| in the fast-exchange approximation"
        >
          <Sparkles className="w-3.5 h-3.5 text-purple-500" />
          Seed All |Δω| from Rex
        </button>
      </div>

      {/* Rex screening: bar chart with draggable cutoff */}
      {showScreeningModal && (
        <div className="bg-white dark:bg-slate-900 p-4 border border-blue-200 dark:border-blue-800/80 rounded-xl shadow-md space-y-3" data-testid="rex-screening">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h4 className="text-sm font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
              <BarChart2 className="w-4 h-4 text-blue-600 dark:text-blue-400" />
              Rex screening
              <span title={REX_DEFINITION}><Info className="w-3.5 h-3.5 text-slate-400" /></span>
            </h4>
            <div className="flex items-center gap-3 text-xs">
              <label className="flex items-center gap-1.5">
                Cutoff
                <input type="number" step={0.1} value={rexCutoff} onChange={e => setRexCutoff(parseFloat(e.target.value) || 0)} className={inputCls} aria-label="Rex cutoff" />
                s⁻¹
              </label>
              <span className="font-semibold text-emerald-700 dark:text-emerald-300" data-testid="rex-above-count">
                {aboveCutoff.length} / {safeProfiles.length} above cutoff
              </span>
              <button onClick={handleApplyCutoff} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 dark:bg-indigo-600 text-white font-bold rounded-lg">
                Exclude residues below cutoff
              </button>
            </div>
          </div>
          <p className="text-[11px] text-slate-500">{REX_DEFINITION} Drag the dashed line or type a value; click a bar to open that residue.</p>
          <Plot
            data={[barTrace]}
            layout={{
              xaxis: axis("Residue number"),
              yaxis: axis("Rex (s⁻¹)"),
              paper_bgcolor: "transparent",
              plot_bgcolor: "transparent",
              margin: { l: 55, r: 20, t: 10, b: 45 },
              bargap: 0.15,
              shapes: [{ type: "line", xref: "paper", x0: 0, x1: 1, y0: rexCutoff, y1: rexCutoff, line: { color: "#ef4444", width: 2, dash: "dash" } }],
            }}
            config={{ displayModeBar: false, responsive: true, edits: { shapePosition: true } }}
            style={{ width: "100%", height: "260px" }}
            onRelayout={(ev: any) => {
              const y = ev?.["shapes[0].y0"];
              if (typeof y === "number" && Number.isFinite(y)) setRexCutoff(Number(y.toFixed(2)));
            }}
            onClick={(ev: any) => {
              const id = ev?.points?.[0]?.customdata;
              if (typeof id === "string") browser.select(id);
            }}
          />
        </div>
      )}

      {/* Seed dialog */}
      {showSeedDialog && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" role="dialog" aria-label="Seed |Δω| from Rex">
          <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 shadow-xl max-w-lg w-full p-5 space-y-3 text-xs">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-bold text-slate-800 dark:text-slate-100">Seed |Δω| from Rex</h4>
              <button onClick={() => setShowSeedDialog(false)} aria-label="Close"><X className="w-4 h-4" /></button>
            </div>
            <p className="text-slate-600 dark:text-slate-300">
              Fast-exchange relation <span className="font-mono">Rex ≈ pA·pB·Δω²/kex</span>, so |Δω| = √(Rex·kex / (pA·pB)). Only the product
              pA·pB·Δω² is determined by Rex: the seed is shown as a range over the pB and kex spans below. Rex uses the field with the largest Rex.
              The sign is unknown; use Pick CEST to set it.
            </p>
            <div className="grid grid-cols-3 gap-2 items-center">
              <span />
              <span className="font-semibold">value</span>
              <span className="font-semibold">span (min – max)</span>
              <span>pB</span>
              <input aria-label="pB" type="number" step={0.01} className={inputCls} value={assume.pb} onChange={e => setAssume(a => ({ ...a, pb: parseFloat(e.target.value) }))} />
              <span className="flex gap-1">
                <input aria-label="pB min" type="number" step={0.01} className={inputCls} value={assume.pbRange[0]} onChange={e => setAssume(a => ({ ...a, pbRange: [parseFloat(e.target.value), a.pbRange[1]] }))} />
                <input aria-label="pB max" type="number" step={0.01} className={inputCls} value={assume.pbRange[1]} onChange={e => setAssume(a => ({ ...a, pbRange: [a.pbRange[0], parseFloat(e.target.value)] }))} />
              </span>
              <span>kex (s⁻¹)</span>
              <input aria-label="kex" type="number" step={50} className={inputCls} value={assume.kex} onChange={e => setAssume(a => ({ ...a, kex: parseFloat(e.target.value) }))} />
              <span className="flex gap-1">
                <input aria-label="kex min" type="number" step={50} className={inputCls} value={assume.kexRange[0]} onChange={e => setAssume(a => ({ ...a, kexRange: [parseFloat(e.target.value), a.kexRange[1]] }))} />
                <input aria-label="kex max" type="number" step={50} className={inputCls} value={assume.kexRange[1]} onChange={e => setAssume(a => ({ ...a, kexRange: [a.kexRange[0], parseFloat(e.target.value)] }))} />
              </span>
            </div>
            {currentProfile && (() => {
              const s = seedOf(currentProfile.residue);
              return (
                <div className="p-2 rounded-lg bg-purple-50 dark:bg-purple-950/30 text-purple-800 dark:text-purple-200" data-testid="seed-preview">
                  {currentProfile.full_residue || currentProfile.residue}: {s ? `|Δω| ≈ ${s.value.toFixed(2)} ${unitLabel} (range ${s.min.toFixed(2)} – ${s.max.toFixed(2)})` : "no positive Rex, no seed"}
                </div>
              );
            })()}
            {rexSeed && <p className="text-slate-400">Last applied {new Date(rexSeed.appliedAt).toLocaleString()}: pB {rexSeed.pb}, kex {rexSeed.kex} ({rexSeed.residues} residues).</p>}
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowSeedDialog(false)} className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600">Cancel</button>
              <button onClick={applySeeds} className="px-3 py-1.5 rounded-lg bg-purple-600 text-white font-bold">
                Apply central seeds to DW_AB
              </button>
            </div>
          </div>
        </div>
      )}

      {currentProfile ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className={`lg:col-span-2 ${sectionCls} space-y-3`}>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 dark:border-slate-700 pb-3">
              <h3 className="text-base font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
                <span>{currentProfile.full_residue || currentProfile.residue}</span>
                <span className="text-xs font-normal text-slate-400 font-mono">({currentProfile.residue})</span>
              </h3>
              <div className="flex items-center gap-2 text-xs flex-wrap">
                {(currentProfile.experiments || []).map((exp, idx) => {
                  const color = FIELD_PALETTE[idx % FIELD_PALETTE.length];
                  const f = screening[currentProfile.residue]?.fields?.[idx];
                  const rex = f?.rex ?? exp?.rex;
                  const err = f ? f.rex_err : exp?.rex_err;
                  const used = (exp?.r2eff_err || []).length ? Math.sqrt(exp.r2eff_err.reduce((s, e) => s + e * e, 0) / exp.r2eff_err.length) : null;
                  const ratio = f?.duplicates?.ratio ?? null;
                  const flagged = ratio !== null && ratio > dupFactor;
                  return (
                    <div key={idx} className="flex flex-wrap items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-mono font-semibold" style={{ borderColor: color + "40", backgroundColor: color + "15" }} data-testid="field-chip">
                      <span style={{ color }}>{formatFieldMHz(exp?.b0)}:</span>
                      <span className="text-slate-800 dark:text-slate-200" title={REX_DEFINITION}>
                        Rex = {num(rex) ?? "—"}{num(err) ? ` ± ${num(err)}` : ""} s⁻¹
                      </span>
                      <span className="text-slate-500" title="RMS of the reported R2,eff errors in use">σ in use {num(used, 2) ?? "—"}</span>
                      <span className={flagged ? "text-amber-600 dark:text-amber-400" : "text-slate-500"} title="Pooled SD of duplicate ν_CPMG points">
                        pooled dup {num(f?.duplicates?.pooled_sd, 2) ?? "n/a"}{ratio !== null ? ` (${ratio.toFixed(1)}×)` : ""}
                        {flagged && <AlertTriangle className="inline w-3 h-3 ml-0.5" />}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-600 dark:text-slate-300">
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={showGuide} onChange={e => setShowGuide(e.target.checked)} /> Guide line through mean R2,eff
              </label>
              <label className="flex items-center gap-1">
                Flag duplicates when spread &gt;
                <input type="number" min={0.5} step={0.5} value={dupFactor} onChange={e => setDupFactor(parseFloat(e.target.value) || 3)} className={inputCls} aria-label="Duplicate factor" /> × σ
              </label>
              {cestPicks && (
                <label className="flex items-center gap-1">
                  CEST tolerance
                  <input type="number" min={0} step={0.05} value={consistencyTol} onChange={e => setConsistencyTol(parseFloat(e.target.value) || 0)} className={inputCls} aria-label="CEST tolerance" />
                </label>
              )}
              {anyDup && <span className="text-slate-400">◆ = duplicate ν_CPMG</span>}
            </div>

            <div className="rounded-xl overflow-hidden bg-white dark:bg-slate-900 p-2 border border-slate-200 dark:border-slate-700">
              <Plot
                data={plotTraces}
                layout={{
                  xaxis: axis("ν_CPMG (Hz)", { anchor: hasResiduals ? "y2" : "y" }),
                  yaxis: axis("R2,eff (s⁻¹)", { domain: hasResiduals ? [0.3, 1] : [0, 1] }),
                  ...(hasResiduals ? { yaxis2: axis("Resid.", { domain: [0, 0.22] }) } : {}),
                  paper_bgcolor: "transparent",
                  plot_bgcolor: "transparent",
                  margin: { l: 55, r: 25, t: 20, b: 50 },
                  legend: { orientation: "h", x: 0.5, xanchor: "center", y: -0.22, font: axisFont },
                }}
                style={{ width: "100%", height: hasResiduals ? "440px" : "380px" }}
                config={{ displayModeBar: false, responsive: true }}
              />
            </div>
            <ResidueNotePanel browser={browser} label={currentProfile.full_residue || currentProfile.residue} />
          </div>

          <ResidueTable browser={browser} columns={columns} filters={filters} rowClassName={id => (dupFlagged(id) ? "border-l-2 border-amber-400" : "")} className="h-[560px]" />
        </div>
      ) : (
        <div className="p-8 text-center bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-500">
          No CPMG dispersion profiles available. Select spectra in the Experiments tab and click Generate Data Files.
        </div>
      )}
    </div>
  );
};
