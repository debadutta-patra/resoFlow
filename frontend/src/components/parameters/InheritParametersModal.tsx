import React, { useState, useMemo, useEffect } from 'react';
import {
  X,
  GitFork,
  AlertTriangle,
  Lock,
  Unlock,
  CheckCircle2,
  MinusCircle,
  Loader2,
  ChevronDown,
  ChevronUp,
  Sliders,
} from 'lucide-react';
import api from '../../services/api';
import type {
  ParameterConfig,
  ParamValue,
  ProfileRef,
} from '../../lib/parameterConfig';
import {
  extractResidueNumber,
  normalizeResidueKey,
  getCanonicalResidueKey,
} from '../../lib/parameterConfig';
import type { MethodConfig } from '../../lib/methodConfig';
import type { SourceRunSummary } from '../../lib/compatibility';
import {
  isHighUncertainty,
  formatUncertainty,
  CS_TOLERANCE_PPM,
} from '../../lib/compatibility';
import { ParameterBadge } from './ParameterBadge';

interface InheritParametersModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectUuid: string;
  sourceRun: SourceRunSummary;
  currentParamConfig: ParameterConfig;
  currentMethodConfig: MethodConfig;
  currentPicks?: Record<string, any>;
  profiles?: ProfileRef[];
  residueLabels?: Record<string, string>;
  onApply: (
    updatedParamConfig: ParameterConfig,
    updatedMethodConfig?: MethodConfig,
    updatedPicks?: Record<string, any>
  ) => void;
}

interface ResidueInheritRow {
  canonicalResidue: string;
  displayLabel: string;
  // Current values
  currentCsA?: ParamValue;
  currentDwAB?: ParamValue;
  // Inherited values
  inheritedCsA?: { value: number; err: number | null };
  inheritedDwAB?: { value: number; err: number | null };
  // Pick reference
  pickCsA?: number | null;
  hasPickConflict: boolean;
  // Excluded in source run
  isExcludedInSource: boolean;
  // Status
  isMatched: boolean;
  selected: boolean;
}

export const InheritParametersModal: React.FC<InheritParametersModalProps> = ({
  isOpen,
  onClose,
  projectUuid,
  sourceRun,
  currentParamConfig,
  currentMethodConfig,
  currentPicks = {},
  profiles = [],
  residueLabels = {},
  onApply,
}) => {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [sourceData, setSourceData] = useState<any>(null);

  // Global Inherit Options
  const [inheritKex, setInheritKex] = useState(true);
  const [fixKex, setFixKex] = useState(false);
  const [inheritPb, setInheritPb] = useState(true);
  const [fixPb, setFixPb] = useState(false);

  // Per-Residue Parameter Inherit Options
  const [inheritCsAColumn, setInheritCsAColumn] = useState(true);
  const [inheritDwABColumn, setInheritDwABColumn] = useState(true);
  const [updatePickCestTab, setUpdatePickCestTab] = useState(true);
  const [inheritExclusions, setInheritExclusions] = useState(true);

  // Unmatched Details Expand/Collapse
  const [showUnmatchedDetails, setShowUnmatchedDetails] = useState(false);

  // Per-residue rows state
  const [residueRows, setResidueRows] = useState<ResidueInheritRow[]>([]);

  // Fetch Source Parameters on Mount
  useEffect(() => {
    if (!isOpen || !sourceRun) return;

    const fetchParameters = async () => {
      setIsLoading(true);
      setError('');
      try {
        const res = await api.get(
          `/api/projects/${projectUuid}/analysis/source-parameters/${sourceRun.analysis_uuid}`
        );
        setSourceData(res.data?.parameters || null);
      } catch (err: any) {
        console.error('Failed to load source parameters:', err);
        setError(err.response?.data?.detail || 'Failed to fetch source parameter values.');
      } finally {
        setIsLoading(false);
      }
    };

    fetchParameters();
  }, [isOpen, projectUuid, sourceRun]);

  // Build Residue Comparison Rows
  const { comparisonRows, unmatchedInSource, unmatchedInTarget } = useMemo(() => {
    if (!sourceData) {
      return { comparisonRows: [], unmatchedInSource: [], unmatchedInTarget: [] };
    }

    const sourceResidues: Record<string, any> = sourceData.residues || {};
    const sourceExcludedList: string[] = sourceData.excluded_residues || [];
    const sourceExcludedCanonicalSet = new Set(
      sourceExcludedList.map((r) => getCanonicalResidueKey(r, profiles))
    );

    // Collect all canonical residue keys from target (profiles & config)
    const targetMap = new Map<string, { label: string; aliases: string[] }>();

    // 1. Target profiles
    for (const p of profiles) {
      const canonical = p.residue;
      targetMap.set(canonical, {
        label: residueLabels[canonical] || p.full_residue || normalizeResidueKey(canonical) || canonical,
        aliases: [
          p.residue,
          p.full_residue || '',
          normalizeResidueKey(p.full_residue || ''),
          normalizeResidueKey(p.residue),
        ].filter(Boolean),
      });
    }

    // 2. Target config residues
    for (const res of Object.keys(currentParamConfig.residues || {})) {
      const canonical = getCanonicalResidueKey(res, profiles);
      if (!targetMap.has(canonical)) {
        targetMap.set(canonical, {
          label: residueLabels[res] || normalizeResidueKey(res) || res,
          aliases: [res, canonical, normalizeResidueKey(res)],
        });
      }
    }

    // Helper to find source residue parameters across possible aliases
    const findSourceParams = (targetCanonical: string, aliases: string[]) => {
      // 1. Direct match on canonical
      if (sourceResidues[targetCanonical]) return sourceResidues[targetCanonical];

      // 2. Match on aliases
      for (const a of aliases) {
        if (sourceResidues[a]) return sourceResidues[a];
        const aNorm = normalizeResidueKey(a);
        if (sourceResidues[aNorm]) return sourceResidues[aNorm];
      }

      // 3. Match on number
      const targetNum = extractResidueNumber(targetCanonical);
      if (targetNum > 0) {
        for (const [sKey, sVal] of Object.entries(sourceResidues)) {
          if (extractResidueNumber(sKey) === targetNum) {
            return sVal;
          }
        }
      }

      return null;
    };

    const rows: ResidueInheritRow[] = [];
    const matchedSourceKeys = new Set<string>();

    const sortedTargetEntries = Array.from(targetMap.entries()).sort(([a], [b]) => {
      const numA = extractResidueNumber(a);
      const numB = extractResidueNumber(b);
      return numA !== numB ? numA - numB : a.localeCompare(b);
    });

    const inTargetUnmatched: string[] = [];

    for (const [canonicalKey, { label, aliases }] of sortedTargetEntries) {
      const currentRes = currentParamConfig.residues[canonicalKey] || {};
      const sParams = findSourceParams(canonicalKey, aliases);

      let inheritedCsA: { value: number; err: number | null } | undefined = undefined;
      let inheritedDwAB: { value: number; err: number | null } | undefined = undefined;

      if (sParams) {
        matchedSourceKeys.add(canonicalKey);
        if (sParams.cs_a) {
          inheritedCsA = {
            value: sParams.cs_a.value,
            err: sParams.cs_a.err,
          };
        }
        if (sParams.dw_ab) {
          inheritedDwAB = {
            value: sParams.dw_ab.value,
            err: sParams.dw_ab.err,
          };
        }
      } else {
        inTargetUnmatched.push(label || canonicalKey);
      }

      // Check for conflict with existing pick
      const pick = currentPicks[canonicalKey];
      const pickCsA = pick?.cs_a;
      let hasPickConflict = false;
      if (
        inheritedCsA &&
        pickCsA !== undefined &&
        pickCsA !== null &&
        !isNaN(pickCsA)
      ) {
        if (Math.abs(inheritedCsA.value - pickCsA) > CS_TOLERANCE_PPM) {
          hasPickConflict = true;
        }
      }

      const isExcludedInSource =
        sourceExcludedCanonicalSet.has(canonicalKey) ||
        sourceExcludedList.some(
          (r) =>
            normalizeResidueKey(r) === normalizeResidueKey(canonicalKey) ||
            extractResidueNumber(r) === extractResidueNumber(canonicalKey)
        );

      rows.push({
        canonicalResidue: canonicalKey,
        displayLabel: label,
        currentCsA: currentRes.cs_a,
        currentDwAB: currentRes.dw_ab,
        inheritedCsA,
        inheritedDwAB,
        pickCsA,
        hasPickConflict,
        isExcludedInSource,
        isMatched: sParams !== null,
        selected: sParams !== null,
      });
    }

    // Identify source residues not in target
    const inSourceUnmatched: string[] = [];
    for (const sKey of Object.keys(sourceResidues)) {
      const sCanonical = getCanonicalResidueKey(sKey, profiles);
      if (!targetMap.has(sCanonical) && !matchedSourceKeys.has(sKey)) {
        inSourceUnmatched.push(sKey);
      }
    }

    return {
      comparisonRows: rows,
      unmatchedInSource: inSourceUnmatched,
      unmatchedInTarget: inTargetUnmatched,
    };
  }, [sourceData, currentParamConfig, currentPicks, profiles, residueLabels]);

  useEffect(() => {
    setResidueRows(comparisonRows);
  }, [comparisonRows]);

  // Conflict and match metrics
  const matchedResidueCount = residueRows.filter((r) => r.isMatched).length;
  const totalTargetCount = residueRows.length;
  const pickConflictCount = residueRows.filter(
    (r) => r.isMatched && r.hasPickConflict
  ).length;

  const toggleSelectRow = (idx: number) => {
    setResidueRows((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], selected: !next[idx].selected };
      return next;
    });
  };

  const handleSelectAllRows = (select: boolean) => {
    setResidueRows((prev) =>
      prev.map((r) => (r.isMatched ? { ...r, selected: select } : r))
    );
  };

  const handleApply = () => {
    if (!sourceData) return;

    const sourceGlobals = sourceData.globals || {};
    const timestamp = new Date().toISOString();
    const sourceRunId = sourceRun.analysis_uuid;
    const sourceRunLabel = sourceRun.name;

    // 1. Update Globals
    const updatedGlobals = { ...currentParamConfig.globals };

    if (inheritKex && sourceGlobals.kex_ab) {
      updatedGlobals.kex_ab = {
        value: sourceGlobals.kex_ab.value,
        err: sourceGlobals.kex_ab.err,
        source: {
          kind: 'inherited',
          sourceRunId,
          sourceRunLabel,
          at: timestamp,
        },
      };
    }

    if (inheritPb && sourceGlobals.pb) {
      updatedGlobals.pb = {
        value: sourceGlobals.pb.value,
        err: sourceGlobals.pb.err,
        source: {
          kind: 'inherited',
          sourceRunId,
          sourceRunLabel,
          at: timestamp,
        },
      };
    }

    // 2. Update Residues
    const updatedResidues = { ...currentParamConfig.residues };

    for (const row of residueRows) {
      if (!row.selected || !row.isMatched) continue;

      const resKey = row.canonicalResidue;
      const currentR = updatedResidues[resKey] ? { ...updatedResidues[resKey] } : {};

      // CS_A
      if (inheritCsAColumn && row.inheritedCsA) {
        currentR.cs_a = {
          value: row.inheritedCsA.value,
          err: row.inheritedCsA.err,
          source: {
            kind: 'inherited',
            sourceRunId,
            sourceRunLabel,
            at: timestamp,
          },
        };
      }

      // DW_AB
      if (inheritDwABColumn && row.inheritedDwAB) {
        currentR.dw_ab = {
          value: row.inheritedDwAB.value,
          err: row.inheritedDwAB.err,
          source: {
            kind: 'inherited',
            sourceRunId,
            sourceRunLabel,
            at: timestamp,
          },
        };
      }

      updatedResidues[resKey] = currentR;
    }

    // 3. Update Excluded Residues
    let updatedExcludedResidues = [...(currentParamConfig.excludedResidues || [])];
    if (inheritExclusions && sourceData.excluded_residues && sourceData.excluded_residues.length > 0) {
      for (const sEx of sourceData.excluded_residues) {
        const canonical = getCanonicalResidueKey(sEx, profiles);
        if (!updatedExcludedResidues.includes(canonical)) {
          updatedExcludedResidues.push(canonical);
        }
      }
    }

    const updatedParamConfig: ParameterConfig = {
      ...currentParamConfig,
      globals: updatedGlobals,
      residues: updatedResidues,
      excludedResidues: updatedExcludedResidues.length > 0 ? updatedExcludedResidues : undefined,
      inheritedFrom: {
        sourceRunId,
        sourceRunLabel,
        at: timestamp,
      },
    };

    // 3. Update Method Config if seed-and-fix was selected
    let updatedMethodConfig: MethodConfig | undefined = undefined;

    if (fixKex || fixPb) {
      const steps = currentMethodConfig.steps.map((step, idx) => {
        if (idx === 0) {
          // Update step 1 parameters
          const params = [...step.parameters];

          if (fixKex) {
            const kexIdx = params.findIndex((p) => p.name.toUpperCase() === 'KEX_AB');
            if (kexIdx !== -1) {
              params[kexIdx] = { ...params[kexIdx], mode: 'fix' };
            } else {
              params.push({ name: 'KEX_AB', mode: 'fix' });
            }
          }

          if (fixPb) {
            const pbIdx = params.findIndex((p) => p.name.toUpperCase() === 'PB');
            if (pbIdx !== -1) {
              params[pbIdx] = { ...params[pbIdx], mode: 'fix' };
            } else {
              params.push({ name: 'PB', mode: 'fix' });
            }
          }

          return { ...step, parameters: params };
        }
        return step;
      });

      updatedMethodConfig = {
        ...currentMethodConfig,
        steps,
        rawOverride: undefined, // regenerate structured TOML
      };
    }

    // 4. Update Picks for Pick CEST tab if enabled
    let updatedPicks: Record<string, any> | undefined = undefined;

    if (updatePickCestTab) {
      updatedPicks = { ...(currentPicks || {}) };

      for (const row of residueRows) {
        if (!row.selected || !row.isMatched) continue;

        const resKey = row.canonicalResidue;
        const existingPick = updatedPicks[resKey] || {
          cs_a: null,
          cs_b: null,
          cs_c: null,
          cs_d: null,
          cs_e: null,
          cs_f: null,
        };

        let nextCsA = existingPick.cs_a;
        if (inheritCsAColumn && row.inheritedCsA) {
          nextCsA = row.inheritedCsA.value;
        }

        let nextCsB = existingPick.cs_b;
        if (inheritDwABColumn && row.inheritedDwAB && nextCsA != null) {
          nextCsB = nextCsA + row.inheritedDwAB.value;
        }

        const newPickObj = {
          ...existingPick,
          cs_a: nextCsA != null ? parseFloat(nextCsA.toFixed(4)) : null,
          cs_b: nextCsB != null ? parseFloat(nextCsB.toFixed(4)) : null,
        };

        updatedPicks[resKey] = newPickObj;

        // Also update matching profile residue keys in profiles if any
        for (const p of profiles) {
          if (
            p.residue === resKey ||
            getCanonicalResidueKey(p.residue, profiles) === resKey ||
            normalizeResidueKey(p.residue) === normalizeResidueKey(resKey)
          ) {
            updatedPicks[p.residue] = newPickObj;
          }
        }
      }
    }

    onApply(updatedParamConfig, updatedMethodConfig, updatedPicks);
    onClose();
  };

  if (!isOpen) return null;

  const sourceGlobals = sourceData?.globals || {};
  const isIndividualSource = sourceRun.fit_mode === 'individual';
  const kexHighUncertainty = isHighUncertainty(
    sourceGlobals.kex_ab?.value,
    sourceGlobals.kex_ab?.err
  );
  const pbHighUncertainty = isHighUncertainty(
    sourceGlobals.pb?.value,
    sourceGlobals.pb?.err
  );

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:block sm:p-0">
        <div className="fixed inset-0 transition-opacity" onClick={onClose}>
          <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-xs"></div>
        </div>
        <span className="hidden sm:inline-block sm:align-middle sm:h-screen">&#8203;</span>

        <div className="inline-block align-bottom bg-white dark:bg-slate-900 rounded-2xl text-left overflow-hidden shadow-2xl transform transition-all sm:my-8 sm:align-middle sm:max-w-5xl sm:w-full border border-slate-200 dark:border-slate-800">
          {/* Header */}
          <div className="px-6 py-5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800/60">
                <GitFork className="w-5 h-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-lg font-bold text-slate-900 dark:text-white">
                    Preview Inherited Parameters
                  </h3>
                  <span className="px-2 py-0.5 rounded-md text-[10px] font-extrabold uppercase bg-indigo-100 dark:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300">
                    {sourceRun.name}
                  </span>
                  <span className="px-2 py-0.5 rounded-md text-[10px] font-bold uppercase bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                    {sourceRun.fit_mode} Fit
                  </span>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Review values, uncertainties, and options before applying them to this analysis.
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Modal Body */}
          <div className="p-6 space-y-6 max-h-[68vh] overflow-y-auto">
            {isLoading ? (
              <div className="py-20 text-center">
                <Loader2 className="w-8 h-8 animate-spin mx-auto text-indigo-600 dark:text-indigo-400 mb-3" />
                <p className="text-sm font-medium text-slate-600 dark:text-slate-400">
                  Parsing fitted parameters and fit uncertainties...
                </p>
              </div>
            ) : error ? (
              <div className="p-4 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-300">
                {error}
              </div>
            ) : (
              <>
                {/* 1. Global Parameters Card */}
                <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800 space-y-4">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-extrabold uppercase tracking-wider text-slate-800 dark:text-slate-200 flex items-center gap-2">
                      <Sliders className="w-4 h-4 text-indigo-500" />
                      <span>Global Kinetics (kex_ab & pb)</span>
                    </h4>
                    {isIndividualSource && (
                      <span className="text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/40 px-2 py-0.5 rounded border border-indigo-200 dark:border-indigo-800/60">
                        Collapsed from {sourceGlobals.kex_ab?.stats?.count || 'individual'} residues via inverse-variance weighting
                      </span>
                    )}
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* KEX_AB Card */}
                    <div className="p-3.5 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 space-y-3">
                      <div className="flex items-start justify-between">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-sm text-slate-900 dark:text-white">kex_ab</span>
                            <span className="text-[10px] text-slate-500 dark:text-slate-400">Exchange rate (s⁻¹)</span>
                          </div>
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-xs text-slate-500 dark:text-slate-400">Current:</span>
                            <span className="font-semibold text-xs text-slate-700 dark:text-slate-300">
                              {currentParamConfig.globals.kex_ab?.value !== undefined
                                ? `${currentParamConfig.globals.kex_ab.value.toFixed(1)} s⁻¹`
                                : '—'}
                            </span>
                            <ParameterBadge source={currentParamConfig.globals.kex_ab?.source} compact />
                          </div>
                        </div>

                        <label className="flex items-center gap-2 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={inheritKex}
                            onChange={(e) => setInheritKex(e.target.checked)}
                            className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-4 h-4"
                          />
                          <span className="text-xs font-bold text-slate-700 dark:text-slate-300">Inherit</span>
                        </label>
                      </div>

                      {/* Inherited Value Display */}
                      <div className="flex items-center justify-between p-2.5 rounded-lg bg-indigo-50/70 dark:bg-indigo-950/30 border border-indigo-100 dark:border-indigo-900/40">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-indigo-900 dark:text-indigo-300 font-semibold">Inherited:</span>
                          <span className="text-sm font-bold text-indigo-700 dark:text-indigo-400">
                            {sourceGlobals.kex_ab?.value !== undefined
                              ? `${sourceGlobals.kex_ab.value.toFixed(1)} ${formatUncertainty(sourceGlobals.kex_ab.err, 1)} s⁻¹`
                              : '—'}
                          </span>
                          {kexHighUncertainty && (
                            <span
                              className="p-0.5 text-amber-600 dark:text-amber-400 cursor-help"
                              title={`Fit uncertainty exceeds 50% relative error (${formatUncertainty(sourceGlobals.kex_ab.err, 1)}). A poorly determined fit may be a worse starting point than the default.`}
                            >
                              <AlertTriangle className="w-3.5 h-3.5" />
                            </span>
                          )}
                        </div>

                        {/* Seed-and-Fix toggle */}
                        <label
                          className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs font-semibold cursor-pointer transition-colors ${
                            fixKex
                              ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
                              : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700'
                          }`}
                          title="Write kex_ab as fixed in the method config instead of fitting it"
                        >
                          <input
                            type="checkbox"
                            checked={fixKex}
                            onChange={(e) => setFixKex(e.target.checked)}
                            disabled={!inheritKex}
                            className="rounded border-slate-300 text-amber-600 focus:ring-amber-500 w-3.5 h-3.5"
                          />
                          {fixKex ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                          <span>Fix in run</span>
                        </label>
                      </div>

                      {/* Spread info for individual fits */}
                      {isIndividualSource && sourceGlobals.kex_ab?.stats && (
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 space-y-0.5">
                          <div className="flex justify-between">
                            <span>Median: {sourceGlobals.kex_ab.stats.median.toFixed(1)} s⁻¹</span>
                            <span>IQR: {sourceGlobals.kex_ab.stats.iqr.toFixed(1)} s⁻¹</span>
                          </div>
                          <div className="flex justify-between text-[10px] text-slate-400">
                            <span>Range: [{sourceGlobals.kex_ab.stats.min.toFixed(1)}, {sourceGlobals.kex_ab.stats.max.toFixed(1)}]</span>
                            <span>Spread: {((sourceGlobals.kex_ab.stats.iqr / (sourceGlobals.kex_ab.stats.median || 1)) * 100).toFixed(0)}%</span>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* PB Card */}
                    <div className="p-3.5 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 space-y-3">
                      <div className="flex items-start justify-between">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-sm text-slate-900 dark:text-white">pb</span>
                            <span className="text-[10px] text-slate-500 dark:text-slate-400">Minor state population (0–0.5)</span>
                          </div>
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-xs text-slate-500 dark:text-slate-400">Current:</span>
                            <span className="font-semibold text-xs text-slate-700 dark:text-slate-300">
                              {currentParamConfig.globals.pb?.value !== undefined
                                ? currentParamConfig.globals.pb.value.toFixed(4)
                                : '—'}
                            </span>
                            <ParameterBadge source={currentParamConfig.globals.pb?.source} compact />
                          </div>
                        </div>

                        <label className="flex items-center gap-2 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={inheritPb}
                            onChange={(e) => setInheritPb(e.target.checked)}
                            className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-4 h-4"
                          />
                          <span className="text-xs font-bold text-slate-700 dark:text-slate-300">Inherit</span>
                        </label>
                      </div>

                      {/* Inherited Value Display */}
                      <div className="flex items-center justify-between p-2.5 rounded-lg bg-indigo-50/70 dark:bg-indigo-950/30 border border-indigo-100 dark:border-indigo-900/40">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-indigo-900 dark:text-indigo-300 font-semibold">Inherited:</span>
                          <span className="text-sm font-bold text-indigo-700 dark:text-indigo-400">
                            {sourceGlobals.pb?.value !== undefined
                              ? `${sourceGlobals.pb.value.toFixed(4)} ${formatUncertainty(sourceGlobals.pb.err, 4)}`
                              : '—'}
                          </span>
                          {pbHighUncertainty && (
                            <span
                              className="p-0.5 text-amber-600 dark:text-amber-400 cursor-help"
                              title={`Fit uncertainty exceeds 50% relative error (${formatUncertainty(sourceGlobals.pb.err, 4)}). A poorly determined fit may be a worse starting point than the default.`}
                            >
                              <AlertTriangle className="w-3.5 h-3.5" />
                            </span>
                          )}
                        </div>

                        {/* Seed-and-Fix toggle */}
                        <label
                          className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs font-semibold cursor-pointer transition-colors ${
                            fixPb
                              ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
                              : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700'
                          }`}
                          title="Write pb as fixed in the method config instead of fitting it"
                        >
                          <input
                            type="checkbox"
                            checked={fixPb}
                            onChange={(e) => setFixPb(e.target.checked)}
                            disabled={!inheritPb}
                            className="rounded border-slate-300 text-amber-600 focus:ring-amber-500 w-3.5 h-3.5"
                          />
                          {fixPb ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                          <span>Fix in run</span>
                        </label>
                      </div>

                      {/* Spread info for individual fits */}
                      {isIndividualSource && sourceGlobals.pb?.stats && (
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 space-y-0.5">
                          <div className="flex justify-between">
                            <span>Median: {sourceGlobals.pb.stats.median.toFixed(4)}</span>
                            <span>IQR: {sourceGlobals.pb.stats.iqr.toFixed(4)}</span>
                          </div>
                          <div className="flex justify-between text-[10px] text-slate-400">
                            <span>Range: [{sourceGlobals.pb.stats.min.toFixed(4)}, {sourceGlobals.pb.stats.max.toFixed(4)}]</span>
                            <span>Spread: {((sourceGlobals.pb.stats.iqr / (sourceGlobals.pb.stats.median || 1)) * 100).toFixed(0)}%</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* 2. Residue Mapping & Pick Conflicts Summary Banner */}
                <div className="space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                        <span className="text-xs font-bold text-slate-900 dark:text-white">
                          Residue Intersection: {matchedResidueCount} of {totalTargetCount} target residues matched
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        {totalTargetCount - matchedResidueCount > 0
                          ? `${totalTargetCount - matchedResidueCount} target residue(s) not in source will use default/existing values.`
                          : 'All target residues found in source run.'}
                        {unmatchedInSource.length > 0 && ` (${unmatchedInSource.length} source residues unused)`}
                      </p>
                    </div>

                    {(unmatchedInSource.length > 0 || unmatchedInTarget.length > 0) && (
                      <button
                        type="button"
                        onClick={() => setShowUnmatchedDetails(!showUnmatchedDetails)}
                        className="text-xs font-bold text-indigo-600 dark:text-indigo-400 hover:underline flex items-center gap-1 shrink-0"
                      >
                        <span>{showUnmatchedDetails ? 'Hide unmatched' : 'View unmatched residues'}</span>
                        {showUnmatchedDetails ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                      </button>
                    )}
                  </div>

                  {/* Expandable Unmatched Lists */}
                  {showUnmatchedDetails && (
                    <div className="p-4 rounded-xl bg-slate-100/70 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                      <div>
                        <span className="font-bold text-slate-700 dark:text-slate-300 block mb-1">
                          In current analysis but NOT in source ({unmatchedInTarget.length}):
                        </span>
                        <div className="p-2 bg-white dark:bg-slate-900 rounded-lg max-h-24 overflow-y-auto text-slate-600 dark:text-slate-400 font-mono text-[11px]">
                          {unmatchedInTarget.length > 0 ? unmatchedInTarget.join(', ') : 'None'}
                        </div>
                      </div>

                      <div>
                        <span className="font-bold text-slate-700 dark:text-slate-300 block mb-1">
                          In source run but NOT in current analysis ({unmatchedInSource.length}):
                        </span>
                        <div className="p-2 bg-white dark:bg-slate-900 rounded-lg max-h-24 overflow-y-auto text-slate-600 dark:text-slate-400 font-mono text-[11px]">
                          {unmatchedInSource.length > 0 ? unmatchedInSource.join(', ') : 'None'}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Pick Conflict Notice */}
                  {pickConflictCount > 0 && (
                    <div className="p-3.5 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 flex items-start gap-3 text-xs text-amber-800 dark:text-amber-300">
                      <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                      <div>
                        <span className="font-bold">Chemical shift conflicts detected:</span>{' '}
                        {pickConflictCount} residue{pickConflictCount === 1 ? '' : 's'} have inherited cs_a values that differ from your current peak picks by &gt; {CS_TOLERANCE_PPM} ppm.
                        Inherited values are selected by default. You can uncheck cs_a below to preserve your pick-derived values.
                      </div>
                    </div>
                  )}

                  {/* Source Excluded Residues Banner */}
                  {sourceData?.excluded_residues && sourceData.excluded_residues.length > 0 && (
                    <div className="p-3.5 rounded-xl bg-rose-50/50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-900/40 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                      <div className="flex items-center gap-2">
                        <MinusCircle className="w-4 h-4 text-rose-500 shrink-0" />
                        <div>
                          <span className="font-bold text-slate-800 dark:text-slate-200">
                            Excluded in Source Run ({sourceData.excluded_residues.length}):
                          </span>{' '}
                          <span className="font-mono text-rose-700 dark:text-rose-300">
                            {sourceData.excluded_residues.join(', ')}
                          </span>
                        </div>
                      </div>
                      <label className="flex items-center gap-1.5 cursor-pointer select-none font-bold text-rose-700 dark:text-rose-300 bg-white dark:bg-slate-900 px-2.5 py-1 rounded-lg border border-rose-300 dark:border-rose-800 shrink-0 shadow-2xs">
                        <input
                          type="checkbox"
                          checked={inheritExclusions}
                          onChange={(e) => setInheritExclusions(e.target.checked)}
                          className="rounded border-rose-300 text-rose-600 focus:ring-rose-500 w-3.5 h-3.5"
                        />
                        <span>Inherit residue exclusions</span>
                      </label>
                    </div>
                  )}
                </div>

                {/* 3. Per-Residue Parameter Diff Table */}
                <div className="space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div className="flex items-center gap-3">
                      <h4 className="text-xs font-extrabold uppercase tracking-wider text-slate-800 dark:text-slate-200">
                        Per-Residue Parameters (cs_a & dw_ab)
                      </h4>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleSelectAllRows(true)}
                          className="text-[11px] font-bold text-indigo-600 dark:text-indigo-400 hover:underline"
                        >
                          Select all matched
                        </button>
                        <span className="text-slate-300 dark:text-slate-600">•</span>
                        <button
                          type="button"
                          onClick={() => handleSelectAllRows(false)}
                          className="text-[11px] font-bold text-slate-500 hover:underline"
                        >
                          Deselect all
                        </button>
                      </div>
                    </div>

                    {/* Column Level Toggles */}
                    <div className="flex flex-wrap items-center gap-3 text-xs font-semibold text-slate-700 dark:text-slate-300">
                      <label className="flex items-center gap-1.5 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={inheritCsAColumn}
                          onChange={(e) => setInheritCsAColumn(e.target.checked)}
                          className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-3.5 h-3.5"
                        />
                        <span>Inherit cs_a</span>
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={inheritDwABColumn}
                          onChange={(e) => setInheritDwABColumn(e.target.checked)}
                          className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-3.5 h-3.5"
                        />
                        <span>Inherit dw_ab</span>
                      </label>
                      <label
                        className="flex items-center gap-1.5 cursor-pointer select-none px-2 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800/60 text-indigo-700 dark:text-indigo-300 font-bold"
                        title="Update and fill chemical shifts (cs_a and cs_b = cs_a + dw_ab) in the Pick CEST tab"
                      >
                        <input
                          type="checkbox"
                          checked={updatePickCestTab}
                          onChange={(e) => setUpdatePickCestTab(e.target.checked)}
                          className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-3.5 h-3.5"
                        />
                        <span>Fill Pick CEST tab</span>
                      </label>
                    </div>
                  </div>

                  <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-xs">
                    <div className="max-h-72 overflow-y-auto">
                      <table className="w-full text-xs text-left">
                        <thead className="bg-slate-50 dark:bg-slate-800/90 text-slate-600 dark:text-slate-300 sticky top-0 border-b border-slate-200 dark:border-slate-700 z-10">
                          <tr>
                            <th className="px-3 py-2.5 w-10 text-center">
                              <span className="sr-only">Select</span>
                            </th>
                            <th className="px-3 py-2.5 font-bold">Residue</th>
                            <th className="px-3 py-2.5 font-bold">Current cs_a</th>
                            <th className="px-3 py-2.5 font-bold text-indigo-600 dark:text-indigo-400">
                              Inherited cs_a (ppm)
                            </th>
                            <th className="px-3 py-2.5 font-bold">Current dw_ab</th>
                            <th className="px-3 py-2.5 font-bold text-indigo-600 dark:text-indigo-400">
                              Inherited dw_ab (ppm)
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono">
                          {residueRows.map((row, idx) => {
                            const isCsAHighErr = isHighUncertainty(
                              row.inheritedCsA?.value,
                              row.inheritedCsA?.err
                            );
                            const isDwHighErr = isHighUncertainty(
                              row.inheritedDwAB?.value,
                              row.inheritedDwAB?.err
                            );

                            return (
                              <tr
                                key={row.canonicalResidue}
                                onClick={() => {
                                  if (row.isMatched) toggleSelectRow(idx);
                                }}
                                className={`transition-colors ${
                                  !row.isMatched
                                    ? 'bg-slate-50/50 dark:bg-slate-900/30 text-slate-400 opacity-60'
                                    : row.selected
                                    ? 'bg-indigo-50/30 dark:bg-indigo-950/20 hover:bg-indigo-50/60 dark:hover:bg-indigo-950/40 cursor-pointer'
                                    : 'hover:bg-slate-50 dark:hover:bg-slate-800/40 cursor-pointer'
                                }`}
                              >
                                <td className="px-3 py-2 text-center" onClick={(e) => e.stopPropagation()}>
                                  <input
                                    type="checkbox"
                                    checked={row.selected && row.isMatched}
                                    disabled={!row.isMatched}
                                    onChange={() => toggleSelectRow(idx)}
                                    className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-3.5 h-3.5"
                                  />
                                </td>
                                <td className="px-3 py-2 font-bold font-sans text-slate-900 dark:text-white">
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    <span>{row.displayLabel}</span>
                                    {row.isExcludedInSource && (
                                      <span
                                        className="px-1.5 py-0.5 rounded text-[9px] font-sans font-bold bg-rose-100 text-rose-800 dark:bg-rose-950/70 dark:text-rose-300 border border-rose-200 dark:border-rose-800"
                                        title="This residue was excluded from fitting in the source run"
                                      >
                                        Excluded in source
                                      </span>
                                    )}
                                  </div>
                                </td>

                                {/* Current cs_a */}
                                <td className="px-3 py-2">
                                  <div className="flex items-center gap-1.5 font-mono">
                                    <span>
                                      {row.currentCsA?.value !== undefined
                                        ? row.currentCsA.value.toFixed(3)
                                        : '—'}
                                    </span>
                                    {row.currentCsA && (
                                      <ParameterBadge source={row.currentCsA.source} compact />
                                    )}
                                  </div>
                                </td>

                                {/* Inherited cs_a */}
                                <td className="px-3 py-2 font-semibold">
                                  {row.inheritedCsA ? (
                                    <div className="flex items-center gap-1 text-indigo-700 dark:text-indigo-400 font-mono">
                                      <span>{row.inheritedCsA.value.toFixed(3)}</span>
                                      <span className="text-[10px] text-indigo-500 opacity-80">
                                        {formatUncertainty(row.inheritedCsA.err, 3)}
                                      </span>
                                      {isCsAHighErr && (
                                        <span title={`Relative uncertainty > 50% (${formatUncertainty(row.inheritedCsA.err, 3)})`}>
                                          <AlertTriangle className="w-3 h-3 text-amber-500 ml-0.5" />
                                        </span>
                                      )}
                                      {row.hasPickConflict && (
                                        <span
                                          className="px-1 py-0.2 rounded text-[9px] font-sans font-bold bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-300 ml-1"
                                          title={`Differs from pick (${row.pickCsA?.toFixed(3)}) by > ${CS_TOLERANCE_PPM} ppm`}
                                        >
                                          Pick Diff
                                        </span>
                                      )}
                                    </div>
                                  ) : (
                                    <span className="text-slate-400 font-sans italic text-[11px]">Unmatched</span>
                                  )}
                                </td>

                                {/* Current dw_ab */}
                                <td className="px-3 py-2">
                                  <div className="flex items-center gap-1.5 font-mono">
                                    <span>
                                      {row.currentDwAB?.value !== undefined
                                        ? row.currentDwAB.value.toFixed(3)
                                        : '—'}
                                    </span>
                                    {row.currentDwAB && (
                                      <ParameterBadge source={row.currentDwAB.source} compact />
                                    )}
                                  </div>
                                </td>

                                {/* Inherited dw_ab */}
                                <td className="px-3 py-2 font-semibold">
                                  {row.inheritedDwAB ? (
                                    <div className="flex items-center gap-1 text-indigo-700 dark:text-indigo-400 font-mono">
                                      <span>{row.inheritedDwAB.value.toFixed(3)}</span>
                                      <span className="text-[10px] text-indigo-500 opacity-80">
                                        {formatUncertainty(row.inheritedDwAB.err, 3)}
                                      </span>
                                      {isDwHighErr && (
                                        <span title={`Relative uncertainty > 50% (${formatUncertainty(row.inheritedDwAB.err, 3)})`}>
                                          <AlertTriangle className="w-3 h-3 text-amber-500 ml-0.5" />
                                        </span>
                                      )}
                                    </div>
                                  ) : (
                                    <span className="text-slate-400 font-sans italic text-[11px]">Unmatched</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Footer */}
          <div className="px-6 py-4 bg-slate-50 dark:bg-slate-900/80 border-t border-slate-200 dark:border-slate-800 flex justify-between items-center">
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Snapshotting values from <strong>{sourceRun.name}</strong> into parameter configuration.
            </span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-slate-700 rounded-lg font-medium hover:bg-slate-50 dark:hover:bg-slate-700 text-xs transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleApply}
                disabled={isLoading || !sourceData}
                className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-lg text-xs shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
              >
                <GitFork className="w-3.5 h-3.5" />
                <span>Apply Inherited Parameters</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
