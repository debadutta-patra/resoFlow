import React, { useState, useMemo } from "react";
import { Plot } from "../Plot";
import { useTheme } from "../../context/ThemeContext";

import {
  ChevronLeft,
  ChevronRight,
  Search,
  Sparkles,
  CheckCircle2,
  XCircle,
  BarChart2,
} from "lucide-react";
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
  overall_rex?: number;
  estimated_dw?: number;
}

export interface CpmgDispersionTabProps {
  profiles: CpmgProfileItem[];
  currentIndex: number;
  onSelectIndex: (idx: number) => void;
  parameterConfig: CpmgParameterConfig;
  onToggleExcludeResidue: (resKey: string) => void;
  onBulkSetExcludedResidues: (excluded: string[]) => void;
  onSeedDeltaOmega: (resKey: string, dwPpm: number) => void;
  onBulkSeedDeltaOmega: (seeds: Record<string, number>) => void;
  xiRatio?: number;
  unitLabel?: string;
}

export const CpmgDispersionTab: React.FC<CpmgDispersionTabProps> = ({
  profiles = [],
  currentIndex = 0,
  onSelectIndex,
  parameterConfig,
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

  const [searchTerm, setSearchTerm] = useState("");
  const [rexCutoff, setRexCutoff] = useState<number>(2.0);
  const [showScreeningModal, setShowScreeningModal] = useState(false);

  const currentProfile = safeProfiles[currentIndex] || safeProfiles[0];
  const excludedSet = useMemo(
    () => new Set(parameterConfig?.excludedResidues || []),
    [parameterConfig?.excludedResidues]
  );

  const isCurrentExcluded = currentProfile ? excludedSet.has(currentProfile.residue) : false;

  const filteredProfiles = useMemo(() => {
    if (!searchTerm.trim()) return safeProfiles;
    const q = searchTerm.toLowerCase();
    return safeProfiles.filter(
      (p) =>
        (p?.residue || "").toLowerCase().includes(q) ||
        (p?.full_residue || "").toLowerCase().includes(q)
    );
  }, [safeProfiles, searchTerm]);

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
    const pb = parameterConfig?.globals?.pb?.value || 0.05;
    const kex = parameterConfig?.globals?.kex_ab?.value || 500.0;
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

  const btnSecondary = "px-3 py-1.5 bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 text-xs font-semibold rounded-lg transition-all flex items-center gap-1";
  const sectionCls = "bg-slate-50 dark:bg-slate-800/50 p-5 rounded-xl border border-slate-200 dark:border-slate-700";

  return (
    <div className="space-y-4 animate-in fade-in">
      {/* Top Header Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-50 dark:bg-slate-800/50 p-4 border border-slate-200 dark:border-slate-700 rounded-xl">
        <div className="flex items-center gap-2">
          <button
            onClick={() => onSelectIndex(Math.max(0, currentIndex - 1))}
            disabled={currentIndex === 0 || safeProfiles.length === 0}
            className={`${btnSecondary} disabled:opacity-40`}
          >
            <ChevronLeft className="w-4 h-4" /> Previous
          </button>
          <span className="text-xs font-mono font-bold px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-300">
            {safeProfiles.length > 0 ? currentIndex + 1 : 0} / {safeProfiles.length}
          </span>
          <button
            onClick={() => onSelectIndex(Math.min(safeProfiles.length - 1, currentIndex + 1))}
            disabled={currentIndex >= safeProfiles.length - 1 || safeProfiles.length === 0}
            className={`${btnSecondary} disabled:opacity-40`}
          >
            Next <ChevronRight className="w-4 h-4" />
          </button>

          <button
            onClick={() => currentProfile && onToggleExcludeResidue(currentProfile.residue)}
            disabled={!currentProfile}
            className={`ml-2 px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
              isCurrentExcluded
                ? "bg-red-50 text-red-600 border border-red-200 dark:bg-red-950/40 dark:border-red-900"
                : "bg-emerald-50 text-emerald-600 border border-emerald-200 dark:bg-emerald-950/40 dark:border-emerald-900"
            }`}
          >
            {isCurrentExcluded ? <XCircle className="w-3.5 h-3.5" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
            {isCurrentExcluded ? "Excluded from Fit" : "Included in Fit"}
          </button>
        </div>

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
          </div>

          {/* Residue Selection Table (1 Col) */}
          <div className="bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden flex flex-col h-[480px]">
            <div className="p-3 border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-slate-400" />
                <input
                  type="text"
                  placeholder="Filter residues..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full pl-8 pr-2 py-1 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200"
                />
              </div>
            </div>

            <div className="overflow-auto flex-1">
              <table className="w-full text-xs text-left">
                <thead className="sticky top-0 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 font-bold uppercase tracking-wider z-10 border-b border-slate-200 dark:border-slate-700">
                  <tr>
                    <th className="px-3 py-2">Residue</th>
                    <th className="px-3 py-2 text-right">Rex (s⁻¹)</th>
                    <th className="px-3 py-2 text-right">|Δω| ({unitLabel})</th>
                    <th className="px-3 py-2 text-center">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                  {filteredProfiles.map((p, idx) => {
                    const isEx = p?.residue ? excludedSet.has(p.residue) : false;
                    const isCurrent = currentProfile?.residue === p?.residue;
                    const maxRex = Math.max(...(p?.experiments || []).map((e) => e?.rex || 0), 0);

                    return (
                      <tr
                        key={p?.residue || idx}
                        onClick={() => onSelectIndex(idx)}
                        className={`cursor-pointer hover:bg-blue-50/50 dark:hover:bg-blue-900/20 transition-colors ${
                          isCurrent
                            ? "bg-blue-50 dark:bg-blue-900/30"
                            : isEx
                            ? "opacity-50 bg-slate-100/40 dark:bg-slate-900/40"
                            : ""
                        }`}
                      >
                        <td className="px-3 py-2 font-bold text-slate-800 dark:text-slate-200">
                          <span className={isEx ? "line-through text-slate-400" : ""}>
                            {p?.full_residue || p?.residue}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right font-mono font-semibold text-slate-700 dark:text-slate-300">
                          {typeof maxRex === "number" && !isNaN(maxRex) ? maxRex.toFixed(1) : "—"}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-purple-600 dark:text-purple-400 font-semibold">
                          {typeof p?.estimated_dw === "number" && !isNaN(p.estimated_dw) ? p.estimated_dw.toFixed(2) : "—"}
                        </td>
                        <td className="px-3 py-2 text-center">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (p?.residue) onToggleExcludeResidue(p.residue);
                            }}
                            className={`p-1 rounded transition-colors ${
                              isEx ? "text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30" : "text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/30"
                            }`}
                            title={isEx ? "Excluded from analysis" : "Included in analysis"}
                          >
                            {isEx ? <XCircle className="w-3.5 h-3.5" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : (
        <div className="p-8 text-center bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-500">
          No CPMG dispersion profiles available. Select spectra in the Experiments tab and click Generate Data Files.
        </div>
      )}
    </div>
  );
};

