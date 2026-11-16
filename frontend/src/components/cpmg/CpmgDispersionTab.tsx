import React, { useState, useMemo, useCallback } from "react";
import { useResidueBrowser } from "../../hooks/useResidueBrowser";
import { ResidueNavBar, ResidueNotePanel, ResidueTable, type ResidueColumn, type ReviewExport } from "../review/ResidueBrowser";
import { EMPTY_REVIEW, buildBrowserRows, isFlagged, noteOf, type GapContext, type ReviewState } from "../../lib/residueReview";
import { Plot } from "../Plot";
import { fallbackDefaults } from "../../lib/chemexDefaults";
import { useTheme } from "../../context/ThemeContext";

import { Sparkles, BarChart2 } from "lucide-react";
import { estimateDeltaOmegaFastExchange } from "../../lib/cpmgReduction";
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
}

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
  onSeedDeltaOmega: _onSeedDeltaOmega,
  onBulkSeedDeltaOmega,
  xiRatio = 0.101329118,
  unitLabel = "ppm",
}) => {
  const { theme } = useTheme();
  const isDark = theme === "dark";

  const safeProfiles = useMemo(() => Array.isArray(profiles) ? profiles : [], [profiles]);

  const [rexCutoff, setRexCutoff] = useState<number>(2.0);
  const [showScreeningModal, setShowScreeningModal] = useState(false);

  const excludedSet = useMemo(
    () => new Set(parameterConfig?.excludedResidues || []),
    [parameterConfig?.excludedResidues]
  );
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
  const browser = useResidueBrowser({
    rows,
    review,
    setReview,
    isExcluded,
    toggleExclude: onToggleExcludeResidue,
    active: true,
  });
  const currentProfile = safeProfiles.find(p => p.residue === browser.selectedId);
  React.useEffect(() => {
    const i = safeProfiles.findIndex(p => p.residue === browser.selectedId);
    if (i >= 0) onSelectIndex?.(i);
  }, [browser.selectedId, safeProfiles, onSelectIndex]);

  const maxRexOf = (p: CpmgProfileItem | undefined) => Math.max(...(p?.experiments || []).map((e) => e?.rex || 0), 0);
  const profileOf = (id: string) => safeProfiles.find(p => p.residue === id);
  const columns: ResidueColumn[] = [
    {
      key: "rex",
      header: "Rex (s⁻¹)",
      className: "text-right",
      render: id => maxRexOf(profileOf(id)).toFixed(1),
      sortValue: id => maxRexOf(profileOf(id)),
    },
    {
      key: "dw",
      header: `|Δω| (${unitLabel})`,
      className: "text-right text-purple-600 dark:text-purple-400",
      render: id => {
        const dw = profileOf(id)?.estimated_dw;
        return typeof dw === "number" && !isNaN(dw) ? dw.toFixed(2) : "·";
      },
      sortValue: id => profileOf(id)?.estimated_dw ?? null,
    },
  ];
  const buildExport = (): ReviewExport => ({
    baseName: exportName,
    columns: ["rex", "estimated_dw"],
    rows: rows.filter(r => r.present).map(r => ({
      residue: r.id,
      status: browser.status(r.id),
      flagged: isFlagged(review, r.id),
      note: noteOf(review, r.id),
      values: { rex: maxRexOf(profileOf(r.id)), estimated_dw: profileOf(r.id)?.estimated_dw ?? null },
    })),
    meta: { page: "Inspect Dispersion" },
  });

  // Screening statistics
  const screeningCounts = useMemo(() => {
    let includedCount = 0;
    let excludedCount = 0;
    for (const p of safeProfiles) {
      const rex = p?.overall_rex || 0;
      if (rex >= rexCutoff) {
        includedCount++;
      } else {
        excludedCount++;
      }
    }
    return { includedCount, excludedCount };
  }, [safeProfiles, rexCutoff]);

  const handleApplyCutoff = () => {
    const toExclude: string[] = [];
    for (const p of safeProfiles) {
      const rex = p?.overall_rex || 0;
      if (rex < rexCutoff && p?.residue) {
        toExclude.push(p.residue);
      }
    }
    onBulkSetExcludedResidues(toExclude);
    setShowScreeningModal(false);
  };

  const handleSeedAllRex = () => {
    // Unset globals start from ChemEx's defaults.
    const pb = parameterConfig?.globals?.pb?.value ?? fallbackDefaults('PB')?.value ?? 0.05;
    const kex = parameterConfig?.globals?.kex_ab?.value ?? fallbackDefaults('KEX_AB')?.value ?? 200;
    const seeds: Record<string, number> = {};

    for (const p of safeProfiles) {
      if (p?.experiments && p.experiments.length > 0) {
        const b0 = p.experiments[0]?.b0 || 600.0;
        const maxRex = Math.max(...p.experiments.map((e) => e?.rex || 0), 0);
        const dw = estimateDeltaOmegaFastExchange(maxRex, kex, pb, b0, xiRatio);
        if (dw > 0 && p.residue) {
          seeds[p.residue] = dw;
        }
      }
    }
    onBulkSeedDeltaOmega(seeds);
  };

  // Field color palette
  const fieldPalette = ["#3b82f6", "#a855f7", "#06b6d4", "#f43f5e", "#10b981", "#f59e0b"];

  const sectionCls = "bg-slate-50 dark:bg-slate-800/50 p-5 rounded-xl border border-slate-200 dark:border-slate-700";

  return (
    <div className="space-y-4 animate-in fade-in">
      {/* Top Header Controls */}
      <ResidueNavBar browser={browser} buildExport={buildExport}>
        <button
          type="button"
          onClick={browser.acceptAndNext}
          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 dark:bg-indigo-600 text-white rounded-lg text-xs font-bold"
          title="Accept and go to the next residue (Enter)"
        >
          Accept & Next
        </button>
        <button
          type="button"
          onClick={() => browser.markNoExcited()}
          className="px-3 py-1.5 bg-sky-50 hover:bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300 border border-sky-200 dark:border-sky-800 rounded-lg text-xs font-bold"
          title="No exchange contribution for this residue (N)"
        >
          No excited state
        </button>
      </ResidueNavBar>
      <div className="flex flex-wrap items-center justify-end gap-3">
        {/* Action Buttons */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowScreeningModal(!showScreeningModal)}
            className="px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:hover:bg-blue-900/50 dark:text-blue-300 border border-blue-200 dark:border-blue-800 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors"
          >
            <BarChart2 className="w-3.5 h-3.5" />
            Screen on Rex Cutoff
          </button>

          <button
            onClick={handleSeedAllRex}
            className="px-3 py-1.5 bg-purple-50 hover:bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:hover:bg-purple-900/50 dark:text-purple-300 border border-purple-200 dark:border-purple-800 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors"
            title="Estimate |Δω| in fast-exchange approximation"
          >
            <Sparkles className="w-3.5 h-3.5 text-purple-500" />
            Seed All |Δω| from Rex
          </button>
        </div>
      </div>

      {/* Screening Modal Panel */}
      {showScreeningModal && (
        <div className="bg-white dark:bg-slate-900 p-5 border border-blue-200 dark:border-blue-800/80 rounded-xl shadow-md space-y-4 animate-in slide-in-from-top-2">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
              <BarChart2 className="w-4 h-4 text-blue-600 dark:text-blue-400" />
              Rex Dispersion Screening Cutoff
            </h4>
            <span className="text-xs text-slate-500">
              Bulk-filter flat dispersion profiles based on exchange contribution.
            </span>
          </div>

          <div className="flex flex-col sm:flex-row items-center gap-6 bg-slate-50 dark:bg-slate-800/50 p-4 rounded-xl border border-slate-200 dark:border-slate-700">
            <div className="flex-1 w-full space-y-2">
              <div className="flex justify-between text-xs font-semibold text-slate-700 dark:text-slate-300">
                <span>Minimum Rex Threshold:</span>
                <span className="font-mono text-blue-600 dark:text-blue-400 font-bold">
                  {typeof rexCutoff === "number" ? rexCutoff.toFixed(1) : "2.0"} s⁻¹
                </span>
              </div>
              <input
                type="range"
                min="0.0"
                max="15.0"
                step="0.2"
                value={rexCutoff}
                onChange={(e) => setRexCutoff(parseFloat(e.target.value) || 0)}
                className="w-full h-2 bg-slate-200 dark:bg-slate-700 rounded-lg appearance-none cursor-pointer accent-blue-600"
              />
            </div>

            <div className="flex items-center gap-4 text-xs font-medium">
              <div className="px-3 py-2 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 rounded-lg text-emerald-700 dark:text-emerald-300 text-center">
                <span className="font-bold text-sm block">{screeningCounts.includedCount}</span>
                Passing
              </div>
              <div className="px-3 py-2 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 rounded-lg text-red-700 dark:text-red-300 text-center">
                <span className="font-bold text-sm block">{screeningCounts.excludedCount}</span>
                Below Cutoff
              </div>
              <button
                onClick={handleApplyCutoff}
                className="px-4 py-2.5 bg-blue-600 hover:bg-blue-700 dark:bg-indigo-600 dark:hover:bg-indigo-700 text-white font-bold rounded-lg text-xs shadow-sm transition-all"
              >
                Apply Selection
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Content: Dispersion Curve Plot & Residue Table */}
      {currentProfile ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Plot Card (2 Cols) */}
          <div className={`lg:col-span-2 ${sectionCls} space-y-4`}>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 dark:border-slate-700 pb-3">
              <div>
                <h3 className="text-base font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
                  <span>{currentProfile.full_residue || currentProfile.residue}</span>
                  <span className="text-xs font-normal text-slate-400 font-mono">({currentProfile.residue})</span>
                </h3>
              </div>

              {/* Per-field Rex metrics */}
              <div className="flex items-center gap-2 text-xs flex-wrap">
                {(currentProfile.experiments || []).map((exp, idx) => (
                  <div
                    key={idx}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-mono font-semibold"
                    style={{
                      borderColor: fieldPalette[idx % fieldPalette.length] + "40",
                      backgroundColor: fieldPalette[idx % fieldPalette.length] + "15",
                    }}
                  >
                    <span style={{ color: fieldPalette[idx % fieldPalette.length] }}>{exp?.b0 || 600} MHz:</span>
                    <span className="text-slate-800 dark:text-slate-200">
                      Rex = {typeof exp?.rex === "number" ? exp.rex.toFixed(1) : "—"} ± {typeof exp?.rex_err === "number" ? exp.rex_err.toFixed(1) : "—"} s⁻¹
                    </span>
                    <span className="text-slate-400 text-[10px]">
                      (χ²red = {typeof exp?.chi2_red === "number" ? exp.chi2_red.toFixed(2) : "—"})
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Plotly R2eff vs nu_cpmg */}
            <div className="rounded-xl overflow-hidden bg-white dark:bg-slate-900 p-2 border border-slate-200 dark:border-slate-700">
              <Plot
                data={(currentProfile.experiments || []).map((exp, idx) => {
                  const color = fieldPalette[idx % fieldPalette.length];
                  const points = (exp?.nu_cpmg || [])
                    .map((nu, i) => ({
                      nu,
                      r2eff: exp?.r2eff?.[i] ?? 0,
                      err: exp?.r2eff_err?.[i] ?? 0,
                    }))
                    .sort((a, b) => a.nu - b.nu);

                  return {
                    x: points.map((p) => p.nu),
                    y: points.map((p) => p.r2eff),
                    error_y: {
                      type: "data" as const,
                      array: points.map((p) => p.err),
                      visible: true,
                      color: color,
                      thickness: 1.5,
                      width: 3.5,
                    },
                    type: "scatter" as const,
                    mode: "lines+markers" as const,
                    line: { shape: "linear" as const, color, width: 1.5 },
                    marker: {
                      color,
                      size: 8,
                      line: { width: 1.2, color: "#ffffff" },
                    },
                    name: `${exp?.b0 || 600} MHz`,
                  };
                })}

                layout={{
                  xaxis: {
                    title: { text: "ν_CPMG (Hz)", font: { color: isDark ? "#cbd5e1" : "#475569" } },
                    gridcolor: isDark ? "#334155" : "#e2e8f0",
                    zerolinecolor: isDark ? "#475569" : "#cbd5e1",
                    tickfont: { color: isDark ? "#94a3b8" : "#64748b" },
                  } as any,
                  yaxis: {
                    title: { text: "R2,eff (s⁻¹)", font: { color: isDark ? "#cbd5e1" : "#475569" } },
                    gridcolor: isDark ? "#334155" : "#e2e8f0",
                    zerolinecolor: isDark ? "#475569" : "#cbd5e1",
                    tickfont: { color: isDark ? "#94a3b8" : "#64748b" },
                  } as any,
                  paper_bgcolor: "transparent",
                  plot_bgcolor: "transparent",
                  margin: { l: 55, r: 25, t: 20, b: 50 },
                  legend: {
                    orientation: "h",
                    x: 0.5,
                    xanchor: "center",
                    y: -0.22,
                    font: { color: isDark ? "#cbd5e1" : "#475569" },
                  },
                }}
                style={{ width: "100%", height: "380px" }}
                config={{ displayModeBar: false, responsive: true }}
              />
            </div>
            <ResidueNotePanel browser={browser} label={currentProfile.full_residue || currentProfile.residue} />
          </div>

          {/* Residue browser table (1 Col) */}
          <ResidueTable browser={browser} columns={columns} className="h-[480px]" />
        </div>
      ) : (
        <div className="p-8 text-center bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-500">
          No CPMG dispersion profiles available. Select spectra in the Experiments tab and click Generate Data Files.
        </div>
      )}
    </div>
  );
};

