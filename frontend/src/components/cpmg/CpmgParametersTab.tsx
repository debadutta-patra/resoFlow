import React, { useState, useMemo } from "react";
import {
  Sliders,
  Layers,
  Search,
  Upload,
  Code,
  FileCode,
  Copy,
  Download,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronUp,
  Info,
  GitFork,
  ArrowUpDown,
  Filter,
  Check,
} from "lucide-react";
import type { CpmgParameterConfig } from "../../lib/cpmgConfig";
import { configToCpmgToml, cpmgTomlToConfig } from "../../lib/cpmgConfig";
import { ParameterBadge } from "../parameters/ParameterBadge";
import { ParametersImportModal } from "../parameters/ParametersImportModal";
import { SourceRunPickerModal } from "../parameters/SourceRunPickerModal";
import type { SourceRunSummary } from "../../lib/compatibility";
import api from "../../services/api";

export interface CpmgParametersTabProps {
  parameterConfig: CpmgParameterConfig;
  onChangeConfig: (updated: CpmgParameterConfig) => void;
  availableResidues: string[];
  residueLabels?: Record<string, string>;
  fields: number[]; // e.g. [600, 800]
  unitLabel?: string;
  projectUuid?: string;
  analysisUuid?: string;
  analysisName?: string;
  model?: string;
  onToggleExcludeResidue?: (resKey: string) => void;
}

export type FilterSource = "all" | "active" | "manual" | "inherited" | "pick" | "excluded";
export type SortField = "residue" | "cs_a" | "status";

export const CpmgParametersTab: React.FC<CpmgParametersTabProps> = ({
  parameterConfig,
  onChangeConfig,
  availableResidues,
  residueLabels = {},
  fields,
  unitLabel = "ppm",
  projectUuid = "",
  analysisUuid = "",
  analysisName = "",
  model = "2st",
  onToggleExcludeResidue,
}) => {
  const [searchTerm, setSearchTerm] = useState("");
  const [sourceFilter, setSourceFilter] = useState<FilterSource>("all");
  const [sortField, setSortField] = useState<SortField>("residue");
  const [sortAsc, setSortAsc] = useState(true);

  const [isRawEditMode, setIsRawEditMode] = useState(false);
  const [rawToml, setRawToml] = useState("");
  const [unparsedLines, setUnparsedLines] = useState<string[]>([]);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showSourcePickerModal, setShowSourcePickerModal] = useState(false);
  const [showGeneratedPreview, setShowGeneratedPreview] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState(false);

  const excludedSet = useMemo(
    () => new Set(parameterConfig.excludedResidues || []),
    [parameterConfig.excludedResidues]
  );

  const fieldList = fields.length > 0 ? fields : [600];
  const globals = parameterConfig.globals || {};
  const pbParam = globals.pb || { value: 0.05, source: { kind: "default" } };
  const kexParam = globals.kex_ab || { value: 500.0, source: { kind: "default" } };
  const dwParam = globals.dw_ab || { value: 2.0, source: { kind: "default" } };
  const taucParam = globals.tauc_a || { value: 4.0, source: { kind: "default" } };

  const handleGlobalChange = (paramKey: string, val: number) => {
    onChangeConfig({
      ...parameterConfig,
      globals: {
        ...globals,
        [paramKey]: {
          value: val,
          source: { kind: "manual", at: new Date().toISOString() },
        },
      },
    });
  };

  const handleCsChange = (resKey: string, val: number) => {
    const curRes = parameterConfig.residues[resKey] || {};
    onChangeConfig({
      ...parameterConfig,
      residues: {
        ...parameterConfig.residues,
        [resKey]: {
          ...curRes,
          cs_a: {
            value: val,
            source: { kind: "manual", at: new Date().toISOString() },
          },
        },
      },
    });
  };

  const handleToggleExclude = (resKey: string) => {
    if (onToggleExcludeResidue) {
      onToggleExcludeResidue(resKey);
      return;
    }
    const nextSet = new Set(parameterConfig.excludedResidues || []);
    if (nextSet.has(resKey)) {
      nextSet.delete(resKey);
    } else {
      nextSet.add(resKey);
    }
    onChangeConfig({
      ...parameterConfig,
      excludedResidues: Array.from(nextSet),
    });
  };

  const handleImportToml = (importedConfig: any, unparsed: string[]) => {
    const nextRes: Record<string, any> = {};
    for (const [resKey, rData] of Object.entries(importedConfig.residues || {})) {
      const r: any = rData;
      nextRes[resKey] = {
        cs_a: r.cs_a || r.cs || (r.cs_a?.value !== undefined ? r.cs_a : undefined),
      };
    }

    onChangeConfig({
      ...parameterConfig,
      globals: importedConfig.globals || parameterConfig.globals,
      residues: Object.keys(nextRes).length > 0 ? nextRes : parameterConfig.residues,
    });
    setUnparsedLines(unparsed || []);
    setShowImportModal(false);
  };

  const handleSelectSourceRun = async (source: SourceRunSummary) => {
    setShowSourcePickerModal(false);
    try {
      const res = await api
        .get(`/api/projects/${projectUuid}/analysis/${source.analysis_uuid}/cpmg/config`)
        .catch(() =>
          api.get(`/api/projects/${projectUuid}/analysis/${source.analysis_uuid}/cest/config`)
        );
      const srcConfig = res.data?.config?.parameter_config;
      if (srcConfig) {
        const nextGlobals = { ...parameterConfig.globals };
        if (srcConfig.globals?.pb?.value !== undefined) {
          nextGlobals.pb = {
            value: srcConfig.globals.pb.value,
            source: {
              kind: "inherited",
              sourceRunId: source.analysis_uuid,
              sourceRunLabel: source.name,
              at: new Date().toISOString(),
            },
          };
        }
        if (srcConfig.globals?.kex_ab?.value !== undefined) {
          nextGlobals.kex_ab = {
            value: srcConfig.globals.kex_ab.value,
            source: {
              kind: "inherited",
              sourceRunId: source.analysis_uuid,
              sourceRunLabel: source.name,
              at: new Date().toISOString(),
            },
          };
        }
        if (srcConfig.globals?.dw_ab?.value !== undefined) {
          nextGlobals.dw_ab = {
            value: srcConfig.globals.dw_ab.value,
            source: {
              kind: "inherited",
              sourceRunId: source.analysis_uuid,
              sourceRunLabel: source.name,
              at: new Date().toISOString(),
            },
          };
        }

        const nextResidues = { ...parameterConfig.residues };
        for (const [resKey, rParams] of Object.entries(srcConfig.residues || {})) {
          const r: any = rParams;
          const cur = nextResidues[resKey] || {};
          nextResidues[resKey] = {
            ...cur,
            cs_a: r.cs_a
              ? {
                  ...r.cs_a,
                  source: {
                    kind: "inherited",
                    sourceRunId: source.analysis_uuid,
                    sourceRunLabel: source.name,
                    at: new Date().toISOString(),
                  },
                }
              : cur.cs_a,
          };
        }

        onChangeConfig({
          ...parameterConfig,
          globals: nextGlobals,
          residues: nextResidues,
          inheritedFrom: {
            analysisUuid: source.analysis_uuid,
            analysisName: source.name,
            timestamp: new Date().toISOString(),
          },
        });
      }
    } catch (err) {
      console.error("Failed to load source run parameters:", err);
    }
  };

  // Filter & sort residue table rows
  const filteredResidues = useMemo(() => {
    return availableResidues
      .filter((resKey) => {
        const isEx = excludedSet.has(resKey);
        const rParams = parameterConfig.residues[resKey] || {};
        const csKind = rParams.cs_a?.source?.kind;

        if (searchTerm.trim()) {
          const q = searchTerm.toLowerCase();
          const display = (residueLabels[resKey] || "").toLowerCase();
          if (!resKey.toLowerCase().includes(q) && !display.includes(q)) return false;
        }

        if (sourceFilter === "active" && isEx) return false;
        if (sourceFilter === "excluded" && !isEx) return false;
        if (sourceFilter === "pick" && csKind !== "pick") return false;
        if (sourceFilter === "manual" && csKind !== "manual") return false;
        if (sourceFilter === "inherited" && csKind !== "inherited") return false;

        return true;
      })
      .sort((a, b) => {
        if (sortField === "residue") {
          const numA = parseInt(a.replace(/\D/g, ""), 10) || 0;
          const numB = parseInt(b.replace(/\D/g, ""), 10) || 0;
          return sortAsc ? numA - numB : numB - numA;
        }
        if (sortField === "cs_a") {
          const csA = parameterConfig.residues[a]?.cs_a?.value ?? 0;
          const csB = parameterConfig.residues[b]?.cs_a?.value ?? 0;
          return sortAsc ? csA - csB : csB - csA;
        }
        if (sortField === "status") {
          const exA = excludedSet.has(a) ? 1 : 0;
          const exB = excludedSet.has(b) ? 1 : 0;
          return sortAsc ? exA - exB : exB - exA;
        }
        return 0;
      });
  }, [availableResidues, parameterConfig.residues, excludedSet, searchTerm, sourceFilter, sortField, sortAsc]);

  const inputCls =
    "w-full text-sm px-3 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-slate-800 dark:text-slate-200 transition-colors";
  const labelCls =
    "block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1 uppercase tracking-wider";
  const sectionCls =
    "bg-slate-50 dark:bg-slate-800/50 p-5 rounded-xl border border-slate-200 dark:border-slate-700 shadow-2xs";

  const currentToml = isRawEditMode ? rawToml : configToCpmgToml(parameterConfig, fieldList);

  return (
    <div className="space-y-6 animate-in fade-in">
      {/* Parameters Header & Quick Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-2 border-b border-slate-100 dark:border-slate-800">
        <div>
          <h3 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Sliders className="w-5 h-5 text-blue-500" />
            <span>ChemEx Parameters Configuration</span>
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Configure global exchange parameters (p<sub>b</sub>, k<sub>ex</sub>, universal DW_AB, τ<sub>c</sub>) and ground-state chemical shifts (CS_A) inherited from peak fitting.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {projectUuid && (
            <button
              type="button"
              onClick={() => setShowSourcePickerModal(true)}
              className="px-3 py-1.5 bg-gradient-to-r from-indigo-500/10 to-purple-500/10 hover:from-indigo-500/20 hover:to-purple-500/20 text-indigo-600 dark:text-indigo-400 text-xs font-bold rounded-lg border border-indigo-200/70 dark:border-indigo-800/70 transition-all flex items-center gap-1.5 shadow-2xs"
              title="Seed starting parameters from an earlier completed run"
            >
              <GitFork className="w-3.5 h-3.5" />
              <span>Inherit from run</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => setShowImportModal(true)}
            className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 text-xs font-bold rounded-lg border border-slate-200 dark:border-slate-700 transition-all flex items-center gap-1.5 shadow-2xs"
            title="Import parameters from raw TOML"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>Import TOML</span>
          </button>

          <button
            type="button"
            onClick={() => {
              if (!isRawEditMode) {
                setRawToml(configToCpmgToml(parameterConfig, fieldList));
              }
              setIsRawEditMode(!isRawEditMode);
            }}
            className={`px-3 py-1.5 text-xs font-bold rounded-lg border transition-all flex items-center gap-1.5 shadow-2xs ${
              isRawEditMode
                ? "bg-amber-500 text-white border-amber-600"
                : "bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700"
            }`}
          >
            <Code className="w-3.5 h-3.5" />
            <span>{isRawEditMode ? "Return to Form" : "Edit Raw TOML"}</span>
          </button>
        </div>
      </div>

      {/* Unparsed Comments Notice Banner */}
      {unparsedLines.length > 0 && !isRawEditMode && (
        <div className="p-3.5 rounded-xl bg-blue-50/70 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 flex items-start justify-between gap-3 text-xs text-blue-800 dark:text-blue-300">
          <div className="flex items-start gap-2.5">
            <Info className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold">Notice:</span> This parameter file contains{" "}
              <strong>{unparsedLines.length} comment/custom lines</strong> from a previous TOML file. Structured edits will generate clean TOML.
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setRawToml(configToCpmgToml(parameterConfig, fieldList));
              setIsRawEditMode(true);
            }}
            className="px-2.5 py-1 bg-white dark:bg-slate-800 border border-blue-300 dark:border-blue-700 rounded-md font-bold text-[11px] hover:bg-blue-50 dark:hover:bg-blue-900/40 whitespace-nowrap"
          >
            View in Raw Mode
          </button>
        </div>
      )}

      {/* Raw TOML Mode View */}
      {isRawEditMode ? (
        <div className="space-y-3">
          <div className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl flex items-center justify-between text-xs text-amber-800 dark:text-amber-300">
            <span className="font-medium">
              ✏️ <strong>Raw TOML Mode Active</strong>: You are editing parameters.toml directly.
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setRawToml(configToCpmgToml(parameterConfig, fieldList));
                  setIsRawEditMode(false);
                }}
                className="px-3 py-1 bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 font-bold rounded-lg text-[11px]"
              >
                Discard Raw Edits
              </button>
              <button
                type="button"
                onClick={() => {
                  const parsed = cpmgTomlToConfig(rawToml);
                  onChangeConfig(parsed.config);
                  setUnparsedLines(parsed.unparsed);
                  setIsRawEditMode(false);
                }}
                className="px-3 py-1 bg-white dark:bg-slate-800 border border-amber-300 dark:border-amber-700 font-bold rounded-lg hover:bg-amber-50 text-[11px]"
              >
                Parse & Return to Structured Form
              </button>
            </div>
          </div>
          <textarea
            value={rawToml}
            onChange={(e) => setRawToml(e.target.value)}
            rows={18}
            className={`${inputCls} font-mono text-xs`}
            placeholder="Enter raw ChemEx parameters.toml content..."
          />
        </div>
      ) : (
        <div className="space-y-6">
          {/* Global Parameters Card */}
          <div className={sectionCls}>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Layers className="w-4 h-4 text-blue-500" />
                <h4 className="text-sm font-bold text-slate-800 dark:text-slate-200">
                  Global Parameters [GLOBAL]
                </h4>
              </div>
              <span className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
                <Info className="w-3.5 h-3.5" />
                Applies globally across all residues
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
              {/* PB Input */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className={labelCls}>
                    Population (p<sub>b</sub>)
                  </label>
                  <ParameterBadge source={pbParam.source} compact />
                </div>
                <div className="relative rounded-lg shadow-2xs">
                  <input
                    type="number"
                    min="0"
                    max="0.5"
                    step="0.005"
                    value={isNaN(pbParam.value) ? "" : pbParam.value}
                    onChange={(e) => handleGlobalChange("pb", parseFloat(e.target.value) || 0.05)}
                    className="w-full text-sm pl-3 pr-16 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-slate-800 dark:text-slate-200 font-mono transition-colors"
                    placeholder="0.05"
                  />
                  <div className="absolute inset-y-0 right-0 flex items-center pr-2.5 pointer-events-none">
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700">
                      0 - 0.5
                    </span>
                  </div>
                </div>
                <p className="text-[10px] text-slate-400">Excited minor state population</p>
              </div>

              {/* KEX_AB Input */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className={labelCls}>
                    Exchange Rate (k<sub>ex</sub>)
                  </label>
                  <ParameterBadge source={kexParam.source} compact />
                </div>
                <div className="relative rounded-lg shadow-2xs">
                  <input
                    type="number"
                    min="1"
                    step="50"
                    value={isNaN(kexParam.value) ? "" : kexParam.value}
                    onChange={(e) => handleGlobalChange("kex_ab", parseFloat(e.target.value) || 500)}
                    className="w-full text-sm pl-3 pr-14 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-slate-800 dark:text-slate-200 font-mono transition-colors"
                    placeholder="500"
                  />
                  <div className="absolute inset-y-0 right-0 flex items-center pr-2.5 pointer-events-none">
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700">
                      s⁻¹
                    </span>
                  </div>
                </div>
                <p className="text-[10px] text-slate-400">Total exchange rate k<sub>AB</sub></p>
              </div>

              {/* Universal DW_AB Input */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className={labelCls}>
                    Universal Δω (DW_AB)
                  </label>
                  <ParameterBadge source={dwParam.source} compact />
                </div>
                <div className="relative rounded-lg shadow-2xs">
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={isNaN(dwParam.value) ? "" : dwParam.value}
                    onChange={(e) => handleGlobalChange("dw_ab", parseFloat(e.target.value) || 2.0)}
                    className="w-full text-sm pl-3 pr-14 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-slate-800 dark:text-slate-200 font-mono transition-colors"
                    placeholder="2.0"
                  />
                  <div className="absolute inset-y-0 right-0 flex items-center pr-2.5 pointer-events-none">
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700">
                      {unitLabel}
                    </span>
                  </div>
                </div>
                <p className="text-[10px] text-slate-400">Universal starting chemical shift difference</p>
              </div>

              {/* TAUC_A Input */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className={labelCls}>
                    Rotational τ<sub>c</sub>
                  </label>
                  <ParameterBadge source={taucParam.source} compact />
                </div>
                <div className="relative rounded-lg shadow-2xs">
                  <input
                    type="number"
                    min="0.1"
                    step="0.5"
                    value={isNaN(taucParam.value) ? "" : taucParam.value}
                    onChange={(e) => handleGlobalChange("tauc_a", parseFloat(e.target.value) || 4.0)}
                    className="w-full text-sm pl-3 pr-14 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-slate-800 dark:text-slate-200 font-mono transition-colors"
                    placeholder="4.0"
                  />
                  <div className="absolute inset-y-0 right-0 flex items-center pr-2.5 pointer-events-none">
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700">
                      ns
                    </span>
                  </div>
                </div>
                <p className="text-[10px] text-slate-400">Rotational correlation time</p>
              </div>
            </div>
          </div>

          {/* Per-Residue Chemical Shifts (CS_A) Table Card */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-2xs">
            {/* Toolbar */}
            <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-3 bg-slate-50/50 dark:bg-slate-800/40">
              <div className="flex items-center gap-3">
                <h4 className="text-sm font-bold text-slate-800 dark:text-slate-200 flex items-center gap-2">
                  <span>Ground-State Chemical Shifts [CS_A]</span>
                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
                    {filteredResidues.length} of {availableResidues.length}
                  </span>
                </h4>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {/* Search Bar */}
                <div className="relative">
                  <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder="Filter residue (e.g. 65)..."
                    className="text-xs pl-8 pr-3 py-1.5 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-blue-500 text-slate-800 dark:text-slate-200 w-44"
                  />
                </div>

                {/* Filter Selector */}
                <div className="flex items-center gap-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg px-2 py-1 text-xs">
                  <Filter className="w-3 h-3 text-slate-400" />
                  <select
                    value={sourceFilter}
                    onChange={(e) => setSourceFilter(e.target.value as FilterSource)}
                    className="bg-transparent text-slate-700 dark:text-slate-300 font-semibold focus:outline-hidden"
                  >
                    <option value="all">All Residues</option>
                    <option value="active">Active Only</option>
                    <option value="pick">From Peak Fitting</option>
                    <option value="manual">Manual Edits</option>
                    <option value="inherited">Inherited</option>
                    <option value="excluded">Excluded</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-50 dark:bg-slate-800/80 text-slate-600 dark:text-slate-400 font-bold uppercase tracking-wider border-b border-slate-200 dark:border-slate-700">
                  <tr>
                    <th
                      className="px-4 py-3 cursor-pointer hover:text-blue-600 select-none"
                      onClick={() => {
                        if (sortField === "residue") setSortAsc(!sortAsc);
                        else {
                          setSortField("residue");
                          setSortAsc(true);
                        }
                      }}
                    >
                      <div className="flex items-center gap-1">
                        <span>Residue</span>
                        <ArrowUpDown className="w-3 h-3" />
                      </div>
                    </th>

                    <th
                      className="px-4 py-3 cursor-pointer hover:text-blue-600 select-none"
                      onClick={() => {
                        if (sortField === "cs_a") setSortAsc(!sortAsc);
                        else {
                          setSortField("cs_a");
                          setSortAsc(true);
                        }
                      }}
                    >
                      <div className="flex items-center gap-1">
                        <span>CS_A Ground-State Chemical Shift ({unitLabel})</span>
                        <ArrowUpDown className="w-3 h-3" />
                      </div>
                    </th>

                    <th
                      className="px-4 py-3 text-center cursor-pointer hover:text-blue-600 select-none"
                      onClick={() => {
                        if (sortField === "status") setSortAsc(!sortAsc);
                        else {
                          setSortField("status");
                          setSortAsc(true);
                        }
                      }}
                    >
                      <div className="flex items-center justify-center gap-1">
                        <span>Fit Status</span>
                        <ArrowUpDown className="w-3 h-3" />
                      </div>
                    </th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                  {filteredResidues.length === 0 ? (
                    <tr>
                      <td
                        colSpan={3}
                        className="px-4 py-8 text-center text-slate-400 italic"
                      >
                        No residues match the selected search or filter criteria.
                      </td>
                    </tr>
                  ) : (
                    filteredResidues.map((resKey) => {
                      const rParams = parameterConfig.residues[resKey] || {};
                      const csVal = rParams.cs_a?.value ?? 0.0;
                      const csSource = rParams.cs_a?.source || { kind: "default" };
                      const isEx = excludedSet.has(resKey);

                      return (
                        <tr
                          key={resKey}
                          className={`transition-colors ${
                            isEx
                              ? "opacity-50 bg-slate-50/50 dark:bg-slate-900/50"
                              : "hover:bg-slate-50/70 dark:hover:bg-slate-800/40"
                          }`}
                        >
                          {/* Residue Label */}
                          <td className="px-4 py-2.5 font-bold text-slate-800 dark:text-slate-200">
                            <span className={isEx ? "line-through text-slate-400" : ""}>
                              {resKey}
                            </span>
                          </td>

                          {/* CS_A with Provenance Badge */}
                          <td className="px-4 py-2.5">
                            <div className="flex items-center gap-2">
                              <input
                                type="number"
                                step="0.01"
                                value={csVal || ""}
                                onChange={(e) =>
                                  handleCsChange(resKey, parseFloat(e.target.value) || 0)
                                }
                                placeholder="0.00"
                                className="w-32 px-2.5 py-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded font-mono text-xs text-slate-800 dark:text-slate-200 focus:ring-2 focus:ring-blue-500 shadow-2xs"
                              />
                              <ParameterBadge source={csSource} compact />
                            </div>
                          </td>

                          {/* Status Toggle Button */}
                          <td className="px-4 py-2.5 text-center">
                            <button
                              type="button"
                              onClick={() => handleToggleExclude(resKey)}
                              className={`inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1 rounded-lg border transition-all ${
                                isEx
                                  ? "bg-red-50 hover:bg-red-100 text-red-600 border-red-200 dark:bg-red-950/40 dark:border-red-900"
                                  : "bg-emerald-50 hover:bg-emerald-100 text-emerald-600 border-emerald-200 dark:bg-emerald-950/40 dark:border-emerald-900"
                              }`}
                            >
                              {isEx ? (
                                <>
                                  <XCircle className="w-3 h-3" /> Excluded
                                </>
                              ) : (
                                <>
                                  <CheckCircle2 className="w-3 h-3" /> Active
                                </>
                              )}
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Collapsible Generated parameters.toml Preview */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden shadow-2xs">
        <div className="p-3.5 bg-slate-50/80 dark:bg-slate-800/60 flex items-center justify-between">
          <button
            type="button"
            onClick={() => setShowGeneratedPreview(!showGeneratedPreview)}
            className="flex items-center gap-2 text-xs font-bold text-slate-700 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
          >
            {showGeneratedPreview ? (
              <ChevronUp className="w-4 h-4" />
            ) : (
              <ChevronDown className="w-4 h-4" />
            )}
            <FileCode className="w-4 h-4 text-blue-500" />
            <span>Generated parameters.toml Preview</span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 font-mono">
              {Object.keys(parameterConfig.residues || {}).length} configured
            </span>
          </button>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(currentToml);
                setCopyFeedback(true);
                setTimeout(() => setCopyFeedback(false), 2000);
              }}
              className="p-1.5 rounded-lg bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 text-xs font-semibold flex items-center gap-1 border border-slate-200 dark:border-slate-700 shadow-2xs"
              title="Copy TOML to clipboard"
            >
              {copyFeedback ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-500" />
                  <span className="text-emerald-500">Copied</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>Copy</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={() => {
                const blob = new Blob([currentToml], { type: "text/plain" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `parameters_${analysisUuid || "cpmg"}.toml`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
              }}
              className="p-1.5 rounded-lg bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 text-xs font-semibold flex items-center gap-1 border border-slate-200 dark:border-slate-700 shadow-2xs"
              title="Download parameters.toml"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download</span>
            </button>
          </div>
        </div>

        {showGeneratedPreview && (
          <div className="p-4 border-t border-slate-200 dark:border-slate-800 bg-slate-900 overflow-x-auto">
            <pre className="text-xs font-mono text-emerald-400 whitespace-pre-wrap leading-relaxed">
              {currentToml}
            </pre>
          </div>
        )}
      </div>

      {/* Raw TOML Import Modal */}
      <ParametersImportModal
        isOpen={showImportModal}
        onClose={() => setShowImportModal(false)}
        onImport={handleImportToml as any}
      />

      {/* Source Run Picker Modal */}
      {projectUuid && (
        <SourceRunPickerModal
          isOpen={showSourcePickerModal}
          onClose={() => setShowSourcePickerModal(false)}
          projectUuid={projectUuid}
          targetAnalysis={{
            analysis_uuid: analysisUuid,
            name: analysisName,
            analysis_type: "cpmg",
            model,
            nucleus: "15N",
            static_field: fieldList[0] || 600.0,
            temperature: 298.15,
          }}
          onSelectRun={handleSelectSourceRun}
        />
      )}
    </div>
  );
};


