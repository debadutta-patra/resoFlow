import React, { useState, useEffect, useMemo } from 'react';
import Plot, { PLOT_COLORS } from '../Plot';
import { useTheme } from '../../context/ThemeContext';
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
  Download,
  FileText,
  GitFork,
  Info,
  LayoutGrid,
  Loader2,
  Maximize2,
  RotateCcw,
  Search,
} from 'lucide-react';
import { deduplicateSpinKeys } from '../../lib/spinSystem';
import type { CpmgDiagnosticsResult } from '../../lib/cpmgDiagnostics';
import StatisticsResultsSection from '../methods/StatisticsResultsSection';
import { GridSearchSection } from '../grid/GridSearchSection';
import { formatUncertainty } from '../../lib/uncertaintyFormatter';
import api from '../../services/api';

export interface CpmgFitExpCurve {
  b0?: number;
  b1_label?: string;
  time_t2?: number;
  nu_cpmg?: number[];
  r2eff?: number[];
  r2eff_err?: number[];
  exp_points?: {
    x?: number[];
    y?: number[];
    y_err?: number[];
  };
  fit_curve?: {
    nu_cpmg?: number[];
    r2eff?: number[];
    x?: number[];
    y?: number[];
  };
  calc_points?: {
    x?: number[];
    y?: number[];
  };
}

export interface CpmgResultResidue {
  residue?: string;
  full_residue?: string;
  experiments?: CpmgFitExpCurve[];
  parameters?: {
    pb?: number | { value: number; stderr?: number };
    kex_ab?: number | { value: number; stderr?: number };
    dw_ab?: number | { value: number; stderr?: number };
    r1_a?: number | { value: number; stderr?: number };
    r2_a?: number | { value: number; stderr?: number };
    r2_b?: number | { value: number; stderr?: number };
    cs_a?: number | { value: number; stderr?: number };
    cs_b?: number | { value: number; stderr?: number };
    chi2?: number | { value: number };
    chi2_red?: number | { value: number };
    [key: string]: any;
  };
  dw_ab?: { value: number; stderr?: number; error?: number };
  r2_a?: Record<string, { value: number; stderr?: number; error?: number }> | { value: number; stderr?: number } | number;
  r2_b?: Record<string, { value: number; stderr?: number; error?: number }> | { value: number; stderr?: number } | number;
  dw?: number;
  chi2?: number;
  chi2_red?: number;
}

export interface CpmgResultsTabProps {
  projectUuid?: string;
  analysisUuid?: string;
  analysisName?: string;
  analysisResults?: any;
  residues?: Record<string, CpmgResultResidue>;
  globalParameters?: Record<string, any>;
  statistics?: {
    chi2?: number;
    chi2_red?: number;
    points?: number;
    parameters?: number;
    aic?: number;
  };
  residueMapping?: Record<string, string>;
  fitMode?: string;
  lineageInfo?: {
    sourceRunId: string;
    sourceRunLabel: string;
    at?: string;
  } | null;
  sourceRunStillExists?: boolean;
  diagnostics?: CpmgDiagnosticsResult;
  unitLabel?: string;
  onApplyStartingParameters?: (coords: Record<string, number>) => void;
}

export const CpmgResultsTab: React.FC<CpmgResultsTabProps> = ({
  projectUuid,
  analysisUuid,
  analysisName: _analysisName,
  analysisResults,
  residues = {},
  globalParameters = {},
  statistics = {},
  residueMapping = {},
  fitMode = 'global',
  lineageInfo,
  sourceRunStillExists = true,
  diagnostics,
  unitLabel: _unitLabel,
  onApplyStartingParameters,
}) => {
  const { theme } = useTheme();
  const isDark = theme === 'dark';

  // ── Multi-Step & Step State ──
  const [selectedStep, setSelectedStep] = useState<string>('');
  const [showStepStats, setShowStepStats] = useState(false);
  const [showProvenance, setShowProvenance] = useState(false);
  const [isDownloadingReport, setIsDownloadingReport] = useState(false);

  // Initialize selectedStep from analysisResults.step_order
  useEffect(() => {
    if (analysisResults?.step_order && analysisResults.step_order.length > 0) {
      if (!selectedStep || !analysisResults.step_order.includes(selectedStep)) {
        setSelectedStep(analysisResults.step_order[analysisResults.step_order.length - 1]);
      }
    }
  }, [analysisResults, selectedStep]);

  // Extract current step object or fallback to root analysis results
  const currentStepData = useMemo(() => {
    if (selectedStep && analysisResults?.steps?.[selectedStep]) {
      return analysisResults.steps[selectedStep];
    }
    if (analysisResults?.step_order && analysisResults.step_order.length > 0 && analysisResults?.steps) {
      const lastStep = analysisResults.step_order[analysisResults.step_order.length - 1];
      return analysisResults.steps[lastStep] || null;
    }
    return null;
  }, [analysisResults, selectedStep]);

  const isStepMissing = currentStepData?.status === 'missing';
  const isStepPartial = currentStepData?.status === 'partial';

  const activeGlobals = useMemo(() => {
    return currentStepData?.globals || analysisResults?.globals || analysisResults?.global || globalParameters || {};
  }, [currentStepData, analysisResults, globalParameters]);

  const activeStats: any = useMemo(() => {
    return currentStepData?.statistics || analysisResults?.statistics || {
      chisqr: analysisResults?.global?.chi2 ?? analysisResults?.global?.chisqr ?? statistics?.chi2,
      redchi: analysisResults?.global?.chi2_red ?? analysisResults?.global?.redchi ?? statistics?.chi2_red,
      ndata: analysisResults?.global?.ndata ?? statistics?.points,
      nvarys: analysisResults?.global?.nvarys ?? statistics?.parameters,
      aic: (analysisResults?.global as any)?.aic ?? statistics?.aic,
    };
  }, [currentStepData, analysisResults, statistics]);

  const activeResidues: Record<string, CpmgResultResidue> = useMemo(() => {
    return currentStepData?.residues || analysisResults?.residues || residues || {};
  }, [currentStepData, analysisResults, residues]);

  const effectiveResidueMapping: Record<string, string> = useMemo(() => {
    return analysisResults?.residue_mapping || residueMapping || {};
  }, [analysisResults, residueMapping]);

  const hasGridAffordance = useMemo(() => {
    if (currentStepData?.has_grid) return true;
    if (analysisResults?.steps) {
      return Object.values(analysisResults.steps).some((s: any) => s?.has_grid);
    }
    return false;
  }, [currentStepData, analysisResults]);

  // ── Residue Sorting & Search State ──
  const [resultsSortColumn, setResultsSortColumn] = useState<'res' | 'dw' | 'redchi' | 'r2'>('res');
  const [resultsSortDirection, setResultsSortDirection] = useState<'asc' | 'desc'>('asc');
  const [resultsSearchQuery, setResultsSearchQuery] = useState<string>('');
  const [resultsViewMode, setResultsViewMode] = useState<'single' | 'grid'>('single');

  const sortedResidueKeys = useMemo(() => {
    return deduplicateSpinKeys(Object.keys(activeResidues));
  }, [activeResidues]);

  const [currentResultResidue, setCurrentResultResidue] = useState<string>(
    sortedResidueKeys[0] || ''
  );

  useEffect(() => {
    if (sortedResidueKeys.length > 0 && (!currentResultResidue || !activeResidues[currentResultResidue])) {
      setCurrentResultResidue(sortedResidueKeys[0]);
    }
  }, [sortedResidueKeys, activeResidues, currentResultResidue]);

  // Global and per-residue parameter helper (supports group fits / 2st_rs)
  const getGlobalParam = (key: string) => {
    const gObj = activeGlobals[key] || activeGlobals[key.toUpperCase()] || activeGlobals[key.toLowerCase()];
    if (gObj && typeof gObj === 'object' && 'value' in gObj && gObj.value != null) {
      return {
        value: gObj.value,
        stderr: gObj.stderr,
        hasStderr: gObj.has_stderr ?? (gObj.stderr != null),
        errorReason: gObj.error_reason,
        isDerived: gObj.is_derived ?? false,
      };
    }
    if (typeof gObj === 'number') {
      return {
        value: gObj,
        stderr: undefined,
        hasStderr: false,
        errorReason: null,
        isDerived: false,
      };
    }
    const legacyVal = (analysisResults?.global as any)?.[key];
    if (legacyVal != null) {
      const err = (analysisResults?.global as any)?.[`${key}_err`];
      return {
        value: legacyVal,
        stderr: err,
        hasStderr: err != null,
        errorReason: null,
        isDerived: false,
      };
    }

    // Fallback to active selected residue's parameters / properties (for individual / group / 2st_rs fits)
    const currResObj: any = currentResultResidue ? activeResidues[currentResultResidue] : null;
    if (currResObj) {
      const resParams = currResObj.parameters || {};
      const rObj = currResObj[key] || currResObj[key.toUpperCase()] || currResObj[key.toLowerCase()] ||
                   resParams[key] || resParams[key.toUpperCase()] || resParams[key.toLowerCase()];
      if (rObj != null) {
        if (typeof rObj === 'object' && 'value' in rObj && rObj.value != null) {
          return {
            value: rObj.value,
            stderr: rObj.stderr,
            hasStderr: rObj.has_stderr ?? (rObj.stderr != null),
            errorReason: rObj.error_reason,
            isDerived: rObj.is_derived ?? false,
          };
        }
        if (typeof rObj === 'number') {
          const err = currResObj[`${key}_err`] || resParams[`${key}_err`];
          return {
            value: rObj,
            stderr: err,
            hasStderr: err != null,
            errorReason: null,
            isDerived: false,
          };
        }
      }
    }

    return {
      value: undefined,
      stderr: undefined,
      hasStderr: false,
      errorReason: null,
      isDerived: false,
    };
  };

  const kex = getGlobalParam('kex_ab');
  const pb = getGlobalParam('pb');
  const kab = getGlobalParam('kab');
  const kba = getGlobalParam('kba');
  const tauB = getGlobalParam('tau_b');
  const chisqrVal = activeStats.chisqr ?? activeStats.chi2;
  const redchiVal = activeStats.redchi ?? activeStats.chi2_red;
  const ndataVal = activeStats.ndata;
  const nvarysVal = activeStats.nvarys;
  const aicVal = activeStats.aic;

  // Formatted kinetics with NIST/PDG uncertainty
  const formattedKex = formatUncertainty(kex.value, kex.stderr, { unit: 's⁻¹' });
  const formattedPb = formatUncertainty(pb.value, pb.stderr, { isPercent: true });
  const formattedKab = formatUncertainty(kab.value, kab.stderr, { unit: 's⁻¹' });
  const formattedKba = formatUncertainty(kba.value, kba.stderr, { unit: 's⁻¹' });
  const formattedTauB = formatUncertainty(tauB.value, tauB.stderr, { unit: 'ms', isDerived: true });

  // Helper getters for R2A and R2B
  const getR2AValue = (r: any): number | undefined => {
    const p = r?.parameters;
    if (p?.r2_a != null) return typeof p.r2_a === 'object' ? p.r2_a.value : p.r2_a;
    if (p?.r2a_a != null) return typeof p.r2a_a === 'object' ? p.r2a_a.value : p.r2a_a;
    if (p?.r2 != null) return typeof p.r2 === 'object' ? p.r2.value : p.r2;
    if (typeof r?.r2_a === 'number') return r.r2_a;
    if (typeof r?.r2_a === 'object') {
      if ('value' in r.r2_a) return r.r2_a.value;
      return (Object.values(r.r2_a)[0] as any)?.value;
    }
    return undefined;
  };

  const getR2AErr = (r: any): number | undefined => {
    const p = r?.parameters;
    if (p?.r2_a != null && typeof p.r2_a === 'object') return p.r2_a.stderr;
    if (typeof r?.r2_a === 'object' && r?.r2_a != null) {
      if ('stderr' in r.r2_a) return r.r2_a.stderr;
      if ('error' in r.r2_a) return (r.r2_a as any).error;
      return (Object.values(r.r2_a)[0] as any)?.stderr;
    }
    return undefined;
  };

  const getR2BValue = (r: any): number | undefined => {
    const p = r?.parameters;
    if (p?.r2_b != null) return typeof p.r2_b === 'object' ? p.r2_b.value : p.r2_b;
    if (p?.r2a_b != null) return typeof p.r2a_b === 'object' ? p.r2a_b.value : p.r2a_b;
    if (typeof r?.r2_b === 'number') return r.r2_b;
    if (typeof r?.r2_b === 'object') {
      if ('value' in r.r2_b) return r.r2_b.value;
      return (Object.values(r.r2_b)[0] as any)?.value;
    }
    return undefined;
  };

  const getR2BErr = (r: any): number | undefined => {
    const p = r?.parameters;
    if (p?.r2_b != null && typeof p.r2_b === 'object') return p.r2_b.stderr;
    if (typeof r?.r2_b === 'object' && r?.r2_b != null) {
      if ('stderr' in r.r2_b) return r.r2_b.stderr;
      if ('error' in r.r2_b) return (r.r2_b as any).error;
      return (Object.values(r.r2_b)[0] as any)?.stderr;
    }
    return undefined;
  };

  // Filter & Sort Residues
  const filteredSortedResKeys = useMemo(() => {
    let keys = [...sortedResidueKeys];
    if (resultsSearchQuery.trim()) {
      const q = resultsSearchQuery.toLowerCase().trim();
      keys = keys.filter(k => {
        const mapped = (effectiveResidueMapping[k] || k).toLowerCase();
        return mapped.includes(q) || k.toLowerCase().includes(q);
      });
    }

    keys.sort((a, b) => {
      const objA = activeResidues[a];
      const objB = activeResidues[b];
      if (resultsSortColumn === 'dw') {
        const pA = objA?.parameters || {};
        const pB = objB?.parameters || {};
        const valA = Math.abs(objA?.dw_ab?.value ?? (pA?.dw_ab as any)?.value ?? pA?.dw_ab ?? pA?.DW_AB ?? objA?.dw ?? 0);
        const valB = Math.abs(objB?.dw_ab?.value ?? (pB?.dw_ab as any)?.value ?? pB?.dw_ab ?? pB?.DW_AB ?? objB?.dw ?? 0);
        return resultsSortDirection === 'asc' ? valA - valB : valB - valA;
      } else if (resultsSortColumn === 'redchi') {
        const pA = objA?.parameters || {};
        const pB = objB?.parameters || {};
        const valA = objA?.chi2_red ?? (pA?.chi2_red as any)?.value ?? pA?.chi2_red ?? 0;
        const valB = objB?.chi2_red ?? (pB?.chi2_red as any)?.value ?? pB?.chi2_red ?? 0;
        return resultsSortDirection === 'asc' ? valA - valB : valB - valA;
      } else if (resultsSortColumn === 'r2') {
        const valA = getR2AValue(objA) ?? 0;
        const valB = getR2AValue(objB) ?? 0;
        return resultsSortDirection === 'asc' ? valA - valB : valB - valA;
      } else {
        const numA = parseInt(a.replace(/\D/g, ''), 10) || 0;
        const numB = parseInt(b.replace(/\D/g, ''), 10) || 0;
        return resultsSortDirection === 'asc' ? numA - numB : numB - numA;
      }
    });

    return keys;
  }, [sortedResidueKeys, activeResidues, resultsSearchQuery, resultsSortColumn, resultsSortDirection, effectiveResidueMapping]);

  const handleToggleSort = (col: 'res' | 'dw' | 'redchi' | 'r2') => {
    if (resultsSortColumn === col) {
      setResultsSortDirection(prev => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setResultsSortColumn(col);
      setResultsSortDirection(col === 'dw' || col === 'redchi' ? 'desc' : 'asc');
    }
  };

  // Field colors tracking
  const [fieldColors, setFieldColors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (activeResidues && Object.keys(activeResidues).length > 0) {
      const uniqueLabels = new Set<string>();
      Object.values(activeResidues).forEach((res) => {
        res.experiments?.forEach((exp) => {
          const label = exp.b1_label || (exp.b0 ? `${exp.b0}MHz` : 'Obs');
          uniqueLabels.add(label);
        });
      });

      const newColors: Record<string, string> = { ...fieldColors };
      const colorPalette = [
        PLOT_COLORS.primary,
        '#9333ea',
        '#0ea5e9',
        '#f43f5e',
        '#10b981',
        '#f59e0b',
        '#64748b',
      ];

      let updated = false;
      Array.from(uniqueLabels).forEach((label, idx) => {
        if (!newColors[label]) {
          newColors[label] = colorPalette[idx % colorPalette.length];
          updated = true;
        }
      });
      if (updated) setFieldColors(newColors);
    }
  }, [activeResidues]);

  const hasStatsAffordance = !!(
    currentStepData?.has_statistics ||
    currentStepData?.statistical_analyses ||
    (analysisResults as any)?.uncertainty_statistics
  );

  const handleDownloadReport = async () => {
    if (!projectUuid || !analysisUuid) return;
    setIsDownloadingReport(true);
    try {
      const res = await api.get(
        `/api/projects/${projectUuid}/analysis/${analysisUuid}/cpmg/report?style=publication`,
        { responseType: 'blob' }
      );
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `cpmg_${analysisUuid}_report.pdf`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Download failed:', err);
      alert('Failed to download report. Please check if the analysis results exist.');
    } finally {
      setIsDownloadingReport(false);
    }
  };

  const handleDownloadZip = async () => {
    if (!projectUuid || !analysisUuid) return;
    try {
      const res = await api.post(
        `/api/projects/${projectUuid}/analysis/${analysisUuid}/export-token`,
        {
          include_data: false,
          include_plots: true,
          include_statistics: true,
          style: 'publication',
        }
      );
      const token = res.data.token;
      window.location.href = `/api/projects/${projectUuid}/analysis/${analysisUuid}/export?token=${token}`;
    } catch (err: any) {
      console.error('Export failed:', err);
      alert(err.response?.data?.detail || 'Failed to export analysis archive.');
    }
  };

  const sectionCls =
    'bg-slate-50 dark:bg-slate-800/50 p-5 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs';

  if (!sortedResidueKeys || sortedResidueKeys.length === 0) {
    return (
      <div className="p-12 text-center bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-2xl text-slate-500">
        <p className="font-semibold text-sm">No fit results found.</p>
        <p className="text-xs text-slate-400 mt-1">Run fitting from the top action bar to view results.</p>
      </div>
    );
  }

  const resToUse = currentResultResidue || (filteredSortedResKeys.length > 0 ? filteredSortedResKeys[0] : sortedResidueKeys[0]);
  const currResObj = activeResidues[resToUse];
  const currParams = currResObj?.parameters || {};

  const dwVal = currResObj?.dw_ab?.value ?? (typeof currParams?.DW_AB === 'object' ? currParams?.DW_AB?.value : currParams?.DW_AB) ?? currParams?.dw_ab ?? currResObj?.dw;
  const dwErr = currResObj?.dw_ab?.stderr ?? currResObj?.dw_ab?.error ?? (currParams?.dw_ab as any)?.stderr ?? (currParams?.DW_AB as any)?.stderr;
  const formattedResDw = formatUncertainty(dwVal, dwErr, { unit: 'ppm', forceSign: true });

  const resR2A = getR2AValue(currResObj);
  const resR2AErr = getR2AErr(currResObj);
  const formattedResR2A = formatUncertainty(resR2A, resR2AErr, { unit: 's⁻¹' });

  const resR2B = getR2BValue(currResObj);
  const resR2BErr = getR2BErr(currResObj);
  const formattedResR2B = formatUncertainty(resR2B, resR2BErr, { unit: 's⁻¹' });

  const exps = currResObj?.experiments || [];

  // Compute normalized residuals per experiment
  const residualsData = exps.map((exp: any) => {
    const expX = exp.exp_points?.x || exp.nu_cpmg || [];
    const expY = exp.exp_points?.y || exp.r2eff || [];
    const expErr = exp.exp_points?.y_err || exp.r2eff_err || [];
    const fitX = exp.fit_curve?.x || exp.fit_curve?.nu_cpmg || exp.calc_points?.x || [];
    const fitY = exp.fit_curve?.y || exp.fit_curve?.r2eff || exp.calc_points?.y || [];

    const resX: number[] = [];
    const resY: number[] = [];

    if (expX.length > 0 && fitX.length > 0) {
      for (let i = 0; i < expX.length; i++) {
        const xi = expX[i];
        const yi = expY[i];
        const erri = (expErr[i] && expErr[i] > 0) ? expErr[i] : 1.0;

        let closestIdx = 0;
        let minDiff = Math.abs(fitX[0] - xi);
        for (let j = 1; j < fitX.length; j++) {
          const diff = Math.abs(fitX[j] - xi);
          if (diff < minDiff) {
            minDiff = diff;
            closestIdx = j;
          }
        }
        const yCalc = fitY[closestIdx];
        if (yCalc != null) {
          resX.push(xi);
          resY.push((yi - yCalc) / erri);
        }
      }
    }

    return {
      b1_label: exp.b1_label || (exp.b0 ? `${exp.b0}MHz` : 'Obs'),
      x: resX,
      y: resY,
    };
  });

  return (
    <div className="space-y-6 animate-in fade-in">
      {/* ── Header: Title, Multi-Step Selector, View Mode & PDF Download ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-200 dark:border-slate-800">
        <div className="flex items-center gap-3 flex-wrap">
          <h4 className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
            {fitMode === 'individual' && currentResultResidue
              ? `Metrics for ${effectiveResidueMapping[currentResultResidue] || currentResultResidue}`
              : 'Global Analysis Summary'}
          </h4>

          {/* Multi-Step Dropdown Selector */}
          {analysisResults?.step_order && analysisResults.step_order.length > 1 && (
            <div className="flex items-center gap-1.5 bg-slate-100 dark:bg-slate-800 px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700 shadow-2xs">
              <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Step:</span>
              <select
                value={selectedStep}
                onChange={(e) => setSelectedStep(e.target.value)}
                className="text-xs font-bold bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 px-2 py-0.5 rounded border border-slate-300 dark:border-slate-600 focus:ring-1 focus:ring-blue-500 cursor-pointer"
              >
                {analysisResults.step_order.map((sname: string) => {
                  const sObj = analysisResults.steps?.[sname];
                  const sStatus = sObj?.status || 'complete';
                  const badge = sStatus === 'complete' ? '✓' : (sStatus === 'partial' ? '⚠' : '✗');
                  const gridTag = sObj?.has_grid ? ' [grid ✓]' : '';
                  const statsTag = (sObj?.has_statistics || sObj?.statistical_analyses) ? ' [+Stats]' : '';
                  return (
                    <option key={sname} value={sname}>
                      {sname || 'STEP1'} ({sStatus} {badge}){gridTag}{statsTag}
                    </option>
                  );
                })}
              </select>
            </div>
          )}

          {/* Step Statistics Drawer Button */}
          {hasStatsAffordance && (
            <button
              type="button"
              onClick={() => setShowStepStats(prev => !prev)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold transition-all border shadow-2xs ${
                showStepStats
                  ? 'bg-purple-600 text-white border-purple-700 shadow-purple-500/20'
                  : 'bg-purple-50 hover:bg-purple-100 dark:bg-purple-950/40 dark:hover:bg-purple-900/40 text-purple-700 dark:text-purple-300 border-purple-200 dark:border-purple-800'
              }`}
              title="Step uncertainty & sampling analyses (Monte Carlo / Bootstrap / MCMC)"
            >
              <Activity className="w-3.5 h-3.5" />
              <span>Step Statistics</span>
              {showStepStats ? <ChevronUp className="w-3 h-3 ml-0.5" /> : <ChevronDown className="w-3 h-3 ml-0.5" />}
            </button>
          )}

          {/* View Mode Toggle: Single vs Thumbnails */}
          <div className="flex items-center bg-slate-100 dark:bg-slate-800 p-0.5 rounded-lg border border-slate-200 dark:border-slate-700">
            <button
              type="button"
              onClick={() => setResultsViewMode('single')}
              className={`px-2 py-1 rounded text-[11px] font-semibold flex items-center gap-1 transition-all ${
                resultsViewMode === 'single'
                  ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-2xs'
                  : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
              }`}
              title="Single residue detailed profile"
            >
              <Maximize2 className="w-3 h-3" />
              <span>Single</span>
            </button>
            <button
              type="button"
              onClick={() => setResultsViewMode('grid')}
              className={`px-2 py-1 rounded text-[11px] font-semibold flex items-center gap-1 transition-all ${
                resultsViewMode === 'grid'
                  ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-2xs'
                  : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
              }`}
              title="Small-multiples thumbnail layout of all residues"
            >
              <LayoutGrid className="w-3 h-3" />
              <span>Thumbnails</span>
            </button>
          </div>

          {/* Provisional State Badge */}
          {analysisResults?.is_provisional && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
              <AlertTriangle className="w-3 h-3 text-amber-500" />
              Provisional
            </span>
          )}

          {/* Partial Step Badge */}
          {isStepPartial && !analysisResults?.is_provisional && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
              <AlertTriangle className="w-3 h-3 text-amber-500" />
              Partial Step
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 self-start sm:self-auto">
          <button
            onClick={handleDownloadReport}
            disabled={isDownloadingReport || !projectUuid || !analysisUuid}
            className="px-3.5 py-1.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-lg text-[10px] font-bold flex items-center gap-1.5 transition-all border border-slate-200 dark:border-slate-700 shadow-xs disabled:opacity-50"
          >
            {isDownloadingReport ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <FileText className="w-3.5 h-3.5" />
            )}
            Report (PDF)
          </button>

          <button
            onClick={handleDownloadZip}
            disabled={!projectUuid || !analysisUuid}
            className="px-3.5 py-1.5 bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-950/50 dark:hover:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300 rounded-lg text-[10px] font-bold flex items-center gap-1.5 transition-all border border-indigo-200 dark:border-indigo-800 shadow-xs disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5" />
            Download Output (ZIP)
          </button>
        </div>
      </div>

      {/* ── Step Statistics Drawer ── */}
      {showStepStats && (
        <div className="animate-in fade-in slide-in-from-top-2 duration-200">
          <StatisticsResultsSection
            projectUuid={projectUuid!}
            analysisUuid={analysisUuid!}
            stepName={selectedStep || undefined}
            uncertaintyStatistics={currentStepData?.statistical_analyses || (analysisResults as any)?.uncertainty_statistics}
          />
        </div>
      )}

      {/* ── Lineage / Seeded Notice ── */}
      {lineageInfo && (
        <div className="p-3.5 rounded-xl bg-indigo-50/70 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800 flex items-center justify-between text-xs text-indigo-900 dark:text-indigo-300 shadow-2xs">
          <div className="flex items-center gap-2">
            <GitFork className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
            <span>
              This analysis was seeded from completed run{' '}
              {sourceRunStillExists && projectUuid ? (
                <a
                  href={`/project/${projectUuid}/analysis/${lineageInfo.sourceRunId}`}
                  className="font-bold underline hover:text-indigo-600 dark:hover:text-indigo-200"
                >
                  {lineageInfo.sourceRunLabel}
                </a>
              ) : (
                <strong className="font-bold">{lineageInfo.sourceRunLabel} (deleted)</strong>
              )}
              . Seeded parameters are not statistically independent of the source run.
            </span>
          </div>
        </div>
      )}

      {/* ── Diagnostics Alerts Banner ── */}
      {diagnostics?.warnings && diagnostics.warnings.length > 0 && (
        <div className="space-y-2">
          {diagnostics.warnings.map((w, idx) => (
            <div
              key={idx}
              className={`p-3.5 rounded-xl border flex items-start gap-3 text-xs ${
                w.severity === 'error'
                  ? 'bg-red-50 border-red-200 text-red-800 dark:bg-red-950/40 dark:border-red-900 dark:text-red-300'
                  : w.severity === 'warning'
                  ? 'bg-amber-50 border-amber-200 text-amber-800 dark:bg-amber-900/40 dark:border-amber-900 dark:text-amber-300'
                  : 'bg-blue-50 border-blue-200 text-blue-800 dark:bg-blue-950/40 dark:border-blue-900 dark:text-blue-300'
              }`}
            >
              {w.severity === 'error' ? (
                <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
              ) : w.severity === 'warning' ? (
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              ) : (
                <Info className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
              )}
              <div>
                {w.title && <span className="font-bold block">{w.title}</span>}
                {w.message && <p className="text-slate-600 dark:text-slate-300 mt-0.5">{w.message}</p>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Missing Step Empty State ── */}
      {isStepMissing ? (
        <div className="p-12 rounded-2xl bg-slate-50 dark:bg-slate-900 border border-dashed border-slate-300 dark:border-slate-700 text-center space-y-3">
          <div className="w-12 h-12 mx-auto rounded-full bg-amber-50 dark:bg-amber-950/50 flex items-center justify-center text-amber-500">
            <AlertTriangle className="w-6 h-6" />
          </div>
          <h4 className="text-sm font-bold text-slate-800 dark:text-slate-200">
            Step '{selectedStep}' was not reached
          </h4>
          <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
            This step was planned in the method configuration, but the fit was interrupted or halted before this step was executed.
          </p>
        </div>
      ) : (
        <>
          {/* ── Summary Stat Cards Grid (5 Kinetics + Quality) ── */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3.5">
            {/* Card 1: k_ex (ab) */}
            <div className="bg-white dark:bg-slate-900 p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs">
              <div className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest mb-1">
                k_ex (ab)
              </div>
              <div className="text-lg font-extrabold text-slate-900 dark:text-white font-mono">
                {formattedKex.formatted}
              </div>
            </div>

            {/* Card 2: p_b */}
            <div className="bg-white dark:bg-slate-900 p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs">
              <div className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest mb-1">
                p_b
              </div>
              <div className="text-lg font-extrabold text-slate-900 dark:text-white font-mono">
                {formattedPb.formatted}
              </div>
            </div>

            {/* Card 3: k_ab */}
            <div className="bg-white dark:bg-slate-900 p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs">
              <div className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest mb-1">
                k_ab (forward)
              </div>
              <div className="text-lg font-extrabold text-slate-900 dark:text-white font-mono">
                {formattedKab.formatted}
              </div>
            </div>

            {/* Card 4: k_ba */}
            <div className="bg-white dark:bg-slate-900 p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs">
              <div className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest mb-1">
                k_ba (backward)
              </div>
              <div className="text-lg font-extrabold text-slate-900 dark:text-white font-mono">
                {formattedKba.formatted}
              </div>
            </div>

            {/* Card 5: τ_B (Excited state lifetime, resoFlow-derived) */}
            <div className="bg-white dark:bg-slate-900 p-3.5 rounded-xl border border-indigo-200 dark:border-indigo-900/60 shadow-xs relative">
              <div className="flex items-center justify-between gap-1 mb-1">
                <div className="text-[10px] font-bold text-indigo-700 dark:text-indigo-400 uppercase tracking-widest">
                  τ_B (Lifetime)
                </div>
                <span
                  className="text-[9px] px-1.5 py-0.2 rounded bg-indigo-100 dark:bg-indigo-950/70 text-indigo-700 dark:text-indigo-300 font-bold border border-indigo-200 dark:border-indigo-800 cursor-help"
                  title="resoFlow-derived: τ_B = 1/k_BA with error σ(τ_B) = σ(k_BA)/k_BA²"
                >
                  derived*
                </span>
              </div>
              <div className="text-lg font-extrabold text-indigo-900 dark:text-indigo-200 font-mono">
                {formattedTauB.formatted}
              </div>
            </div>

            {/* Card 6: Reduced χ² */}
            <div className="bg-white dark:bg-slate-900 p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs">
              <div className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest mb-1">
                Reduced χ²
              </div>
              <div className="text-lg font-extrabold text-slate-900 dark:text-white font-mono">
                {redchiVal != null ? redchiVal.toFixed(2) : '—'}
              </div>
            </div>

            {/* Card 7: Overall χ² */}
            <div className="bg-white dark:bg-slate-900 p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs">
              <div className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest mb-1">
                Overall χ²
              </div>
              <div className="text-lg font-extrabold text-slate-900 dark:text-white font-mono flex items-baseline gap-1.5">
                <span>{chisqrVal != null ? chisqrVal.toFixed(1) : '—'}</span>
                {ndataVal != null && (
                  <span className="text-[10px] font-normal text-slate-400 font-sans">
                    (N={ndataVal}, p={nvarysVal ?? '—'})
                  </span>
                )}
              </div>
            </div>

            {/* Card 8: AIC (if available) */}
            {aicVal != null && (
              <div className="bg-white dark:bg-slate-900 p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs">
                <div className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest mb-1">
                  AIC (Akaike)
                </div>
                <div className="text-lg font-extrabold text-slate-900 dark:text-white font-mono">
                  {aicVal.toFixed(1)}
                </div>
              </div>
            )}
          </div>

          {/* Collapsible Grid Search Section */}
          {hasGridAffordance && (
            <GridSearchSection
              projectUuid={projectUuid!}
              analysisUuid={analysisUuid!}
              stepName={selectedStep || analysisResults?.step_order?.[0] || 'STEP1'}
              onApplyStartingParameters={(coords) => {
                if (onApplyStartingParameters) {
                  onApplyStartingParameters(coords);
                }
              }}
            />
          )}

          {/* ── Main Layout: Left Residues Table & Right Profile / Grid ── */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Left Column: Residues Table Panel (4 cols) */}
            <div className="lg:col-span-4 border border-slate-200 dark:border-slate-800 rounded-2xl bg-white dark:bg-slate-900 overflow-hidden flex flex-col shadow-sm">
              {/* Table Header & Search */}
              <div className="p-3.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/40 space-y-2.5">
                <div className="flex items-center justify-between">
                  <h5 className="text-xs font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                    <span>Residues</span>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300">
                      {filteredSortedResKeys.length} / {Object.keys(activeResidues).length}
                    </span>
                  </h5>
                </div>
                <div className="relative">
                  <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    value={resultsSearchQuery}
                    onChange={(e) => setResultsSearchQuery(e.target.value)}
                    placeholder="Filter residues (e.g. 55N)..."
                    className="w-full pl-8 pr-3 py-1.5 text-xs bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              </div>

              {/* Residues Table */}
              <div className="overflow-y-auto max-h-[480px]">
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="sticky top-0 bg-slate-100 dark:bg-slate-800 text-[10px] font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wider border-b border-slate-200 dark:border-slate-700 z-10">
                    <tr>
                      <th
                        onClick={() => handleToggleSort('res')}
                        className="px-3 py-2 cursor-pointer hover:bg-slate-200 dark:hover:bg-slate-700 select-none"
                      >
                        <div className="flex items-center gap-1">
                          <span>Res</span>
                          {resultsSortColumn === 'res' && <ArrowUpDown className="w-2.5 h-2.5" />}
                        </div>
                      </th>
                      <th
                        onClick={() => handleToggleSort('dw')}
                        className="px-2 py-2 cursor-pointer hover:bg-slate-200 dark:hover:bg-slate-700 select-none"
                        title="Chemical shift difference (Δω in ppm) with uncertainty"
                      >
                        <div className="flex items-center gap-1">
                          <span>Δω (ppm)</span>
                          {resultsSortColumn === 'dw' && <ArrowUpDown className="w-2.5 h-2.5" />}
                        </div>
                      </th>
                      <th
                        onClick={() => handleToggleSort('redchi')}
                        className="px-2 py-2 cursor-pointer hover:bg-slate-200 dark:hover:bg-slate-700 select-none"
                        title="Reduced χ² fit quality"
                      >
                        <div className="flex items-center gap-1">
                          <span>Red. χ²</span>
                          {resultsSortColumn === 'redchi' && <ArrowUpDown className="w-2.5 h-2.5" />}
                        </div>
                      </th>
                      <th
                        onClick={() => handleToggleSort('r2')}
                        className="px-2 py-2 cursor-pointer hover:bg-slate-200 dark:hover:bg-slate-700 select-none"
                        title="Transverse relaxation rate R₂ (s⁻¹)"
                      >
                        <div className="flex items-center gap-1">
                          <span>R₂ (s⁻¹)</span>
                          {resultsSortColumn === 'r2' && <ArrowUpDown className="w-2.5 h-2.5" />}
                        </div>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono">
                    {filteredSortedResKeys.map(res => {
                      const isSelected = (currentResultResidue || filteredSortedResKeys[0]) === res;
                      const resObj = activeResidues[res];
                      const p = resObj?.parameters || {};

                      const resDwVal = resObj?.dw_ab?.value ?? (p?.dw_ab as any)?.value ?? p?.dw_ab ?? (p?.DW_AB as any)?.value ?? p?.DW_AB ?? resObj?.dw;
                      const resDwErr = resObj?.dw_ab?.stderr ?? resObj?.dw_ab?.error ?? (p?.dw_ab as any)?.stderr ?? (p?.DW_AB as any)?.stderr;
                      const formattedDw = formatUncertainty(resDwVal, resDwErr, { unit: '', forceSign: true });

                      const rChi2Red = resObj?.chi2_red ?? (p?.chi2_red as any)?.value ?? p?.chi2_red;
                      const r2Val = getR2AValue(resObj);
                      const r2Err = getR2AErr(resObj);
                      const formattedR2 = formatUncertainty(r2Val, r2Err, { unit: '' });

                      let redChiBadgeCls = 'text-emerald-600 dark:text-emerald-400';
                      if (rChi2Red != null && rChi2Red > 2.0) {
                        redChiBadgeCls = 'text-red-600 dark:text-red-400 font-bold';
                      } else if (rChi2Red != null && rChi2Red > 1.2) {
                        redChiBadgeCls = 'text-amber-600 dark:text-amber-400';
                      }

                      return (
                        <tr
                          key={res}
                          onClick={() => setCurrentResultResidue(res)}
                          className={`cursor-pointer transition-colors ${
                            isSelected
                              ? 'bg-blue-600 text-white font-bold'
                              : 'hover:bg-blue-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300'
                          }`}
                        >
                          <td className="px-3 py-2 font-sans font-medium">
                            {effectiveResidueMapping[res] || res}
                          </td>
                          <td className="px-2 py-2">
                            {formattedDw.formatted}
                          </td>
                          <td className={`px-2 py-2 ${isSelected ? 'text-white' : redChiBadgeCls}`}>
                            {rChi2Red != null ? rChi2Red.toFixed(2) : '—'}
                          </td>
                          <td className="px-2 py-2 text-slate-500 dark:text-slate-400">
                            {formattedR2.formatted}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Footnote */}
              <div className="p-2.5 bg-slate-50 dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 text-[10px] text-slate-400 italic">
                Δω from DW_AB; Reduced χ² and R₂ with covariance error bars. τ_B = 1/k_BA is resoFlow-derived.
              </div>

              {/* Colors Customization */}
              <div className="p-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30">
                <h5 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2 flex items-center justify-between">
                  <span>B₀ Fields & Colors</span>
                  <RotateCcw
                    className="w-3 h-3 cursor-pointer hover:rotate-180 transition-transform text-slate-400 hover:text-slate-600"
                    onClick={() => setFieldColors({})}
                  />
                </h5>
                <div className="flex flex-wrap gap-2">
                  {Object.keys(fieldColors).map(label => (
                    <div key={label} className="flex items-center gap-1.5 px-2 py-1 bg-white dark:bg-slate-800 rounded-md border border-slate-200 dark:border-slate-700 shadow-2xs">
                      <input
                        type="color"
                        value={fieldColors[label]}
                        onChange={(e) => setFieldColors({ ...fieldColors, [label]: e.target.value })}
                        className="w-3.5 h-3.5 rounded cursor-pointer border-none bg-transparent p-0"
                      />
                      <span className="text-[9px] font-bold text-slate-700 dark:text-slate-300 font-mono">{label}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Right Column: Profile & Residuals Plot OR Thumbnail Grid (8 cols) */}
            <div className="lg:col-span-8 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-sm p-4">
              {resultsViewMode === 'grid' ? (
                /* Thumbnail Grid View (Small Multiples) */
                <div className="space-y-4">
                  <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-2">
                    <h4 className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                      All Residues Thumbnail Grid ({filteredSortedResKeys.length} items)
                    </h4>
                    <p className="text-[10px] text-slate-400">Click any thumbnail to promote to single view</p>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3.5 max-h-[640px] overflow-y-auto pr-1">
                    {filteredSortedResKeys.map(res => {
                      const rObj = activeResidues[res];
                      const resExps = rObj?.experiments || [];
                      const p = rObj?.parameters || {};
                      const itemDw = rObj?.dw_ab?.value ?? (p?.dw_ab as any)?.value ?? p?.dw_ab ?? (p?.DW_AB as any)?.value ?? p?.DW_AB ?? rObj?.dw;
                      const itemChi2 = rObj?.chi2_red ?? (p?.chi2_red as any)?.value ?? p?.chi2_red;

                      return (
                        <div
                          key={res}
                          onClick={() => {
                            setCurrentResultResidue(res);
                            setResultsViewMode('single');
                          }}
                          className="p-2.5 rounded-xl border border-slate-200 dark:border-slate-800 hover:border-blue-500 hover:shadow-md cursor-pointer transition-all bg-slate-50/50 dark:bg-slate-800/40 group"
                        >
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="text-xs font-bold text-slate-800 dark:text-white group-hover:text-blue-600">
                              {effectiveResidueMapping[res] || res}
                            </span>
                            <div className="flex items-center gap-1">
                              {itemDw != null && (
                                <span className="text-[9px] font-mono font-semibold px-1.5 py-0.2 rounded bg-purple-50 dark:bg-purple-950/60 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800">
                                  Δω: {itemDw > 0 ? `+${itemDw.toFixed(2)}` : itemDw.toFixed(2)}
                                </span>
                              )}
                              {itemChi2 != null && (
                                <span className={`text-[9px] font-mono px-1.5 py-0.2 rounded ${itemChi2 > 2.0 ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-600'}`}>
                                  χ²: {itemChi2.toFixed(2)}
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="w-full h-28 pointer-events-none">
                            <Plot
                              data={resExps.flatMap((exp: any, expIdx: number) => {
                                const expLabel = exp.b1_label || (exp.b0 ? `${exp.b0}MHz` : `Exp ${expIdx + 1}`);
                                const color = fieldColors[expLabel] || PLOT_COLORS.primary;
                                const expX = exp.exp_points?.x || exp.nu_cpmg || [];
                                const expY = exp.exp_points?.y || exp.r2eff || [];
                                const fitX = exp.fit_curve?.x || exp.fit_curve?.nu_cpmg || exp.calc_points?.x || [];
                                const fitY = exp.fit_curve?.y || exp.fit_curve?.r2eff || exp.calc_points?.y || [];
                                return [
                                  {
                                    x: expX,
                                    y: expY,
                                    type: 'scatter',
                                    mode: 'markers',
                                    marker: { color, size: 4 },
                                    showlegend: false,
                                  },
                                  {
                                    x: fitX,
                                    y: fitY,
                                    type: 'scatter',
                                    mode: 'lines',
                                    line: { color, width: 1.5, shape: 'spline' },
                                    showlegend: false,
                                  }
                                ];
                              })}
                              layout={{
                                xaxis: { visible: false },
                                yaxis: { visible: false },
                                margin: { l: 5, r: 5, t: 5, b: 5 },
                                paper_bgcolor: 'transparent',
                                plot_bgcolor: 'transparent',
                              }}
                              style={{ width: '100%', height: '100%' }}
                              config={{ responsive: true, displayModeBar: false }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                /* Single Detailed CPMG Dispersion Profile & Residuals */
                <div className="space-y-4">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div>
                      <h4 className="text-lg font-bold text-slate-900 dark:text-white leading-none mb-1">
                        {effectiveResidueMapping[resToUse] || resToUse || 'Select a Residue'}
                      </h4>
                      <p className="text-[10px] font-medium text-slate-500 italic">
                        Multi-field CPMG dispersion profile (R₂,eff vs ν_CPMG) with experimental points and fitted curves
                      </p>
                    </div>
                    <div className="flex items-center gap-2 text-xs font-mono flex-wrap">
                      {resR2A != null && (
                        <span className="px-2 py-0.5 rounded bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 font-semibold flex items-center gap-1">
                          <span className="w-2 h-0.5 bg-blue-600 inline-block" />
                          R₂⁰(A): {formattedResR2A.formatted}
                        </span>
                      )}
                      {resR2B != null && (
                        <span className="px-2 py-0.5 rounded bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800 font-semibold flex items-center gap-1">
                          <span className="w-2 h-0.5 border-t-2 border-dashed border-red-600 inline-block" />
                          R₂⁰(B): {formattedResR2B.formatted}
                        </span>
                      )}
                      {dwVal != null && (
                        <span className="px-2 py-0.5 rounded bg-purple-50 dark:bg-purple-950/40 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800 font-semibold">
                          Δω_AB: {formattedResDw.formatted}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Main CPMG Profile Plot */}
                  <div className="w-full" style={{ height: '360px' }}>
                    <Plot
                      className="w-full h-full"
                      useResizeHandler={true}
                      style={{ width: '100%', height: '100%' }}
                      data={exps.flatMap((exp: any, expIdx: number) => {
                        const expLabel = exp.b1_label || (exp.b0 ? `${exp.b0}MHz` : `Exp ${expIdx + 1}`);
                        const color = fieldColors[expLabel] || PLOT_COLORS.primary;

                        const expX = exp.exp_points?.x || exp.nu_cpmg || [];
                        const expY = exp.exp_points?.y || exp.r2eff || [];
                        const expErr = exp.exp_points?.y_err || exp.r2eff_err || [];

                        const points = expX
                          .map((nu: number, i: number) => ({
                            nu,
                            r2eff: expY[i] ?? 0,
                            err: expErr[i] ?? 0,
                          }))
                          .sort((a: any, b: any) => a.nu - b.nu);

                        const traces: any[] = [
                          {
                            x: points.map((p: any) => p.nu),
                            y: points.map((p: any) => p.r2eff),
                            error_y: {
                              type: 'data',
                              array: points.map((p: any) => p.err),
                              visible: true,
                              color: color,
                              thickness: 1.5,
                              width: 3.5,
                            },
                            type: 'scatter',
                            mode: 'markers',
                            name: `${expLabel} (Obs)`,
                            marker: {
                              color,
                              size: 7,
                              line: { width: 1.2, color: '#ffffff' },
                            },
                            hovertemplate: `ν_CPMG: %{x:.1f} Hz<br>R₂,eff: %{y:.2f} s⁻¹<extra>${expLabel}</extra>`,
                          },
                        ];

                        const fitX = exp.fit_curve?.x || exp.fit_curve?.nu_cpmg || exp.calc_points?.x || [];
                        const fitY = exp.fit_curve?.y || exp.fit_curve?.r2eff || exp.calc_points?.y || [];

                        if (Array.isArray(fitX) && fitX.length > 0) {
                          const fitPoints = fitX
                            .map((nu: number, i: number) => ({
                              nu,
                              r2eff: fitY[i] ?? 0,
                            }))
                            .sort((a: any, b: any) => a.nu - b.nu);

                          traces.push({
                            x: fitPoints.map((p: any) => p.nu),
                            y: fitPoints.map((p: any) => p.r2eff),
                            type: 'scatter',
                            mode: 'lines',
                            name: `${expLabel} (Fit)`,
                            line: { color, width: 2.2, shape: 'spline' },
                            showlegend: false,
                            hoverinfo: 'skip',
                          });
                        }

                        return traces;
                      })}
                      layout={{
                        xaxis: {
                          title: 'ν_CPMG (Hz)',
                          autorange: true,
                          gridcolor: isDark ? '#1e293b' : '#f1f5f9',
                          zeroline: false,
                        },
                        yaxis: {
                          title: 'R₂,eff (s⁻¹)',
                          autorange: true,
                          gridcolor: isDark ? '#1e293b' : '#f1f5f9',
                          zeroline: false,
                        },
                        margin: { l: 60, r: 30, t: 25, b: 45 },
                        legend: { orientation: 'h', x: 0.5, xanchor: 'center', y: -0.2 },
                        paper_bgcolor: 'transparent',
                        plot_bgcolor: 'transparent',
                      }}
                      config={{ responsive: true, displayModeBar: true, showTips: false }}
                    />
                  </div>

                  {/* Shared-x Residuals Strip Plot */}
                  <div className="w-full pt-1 border-t border-slate-100 dark:border-slate-800" style={{ height: '150px' }}>
                    <Plot
                      className="w-full h-full"
                      useResizeHandler={true}
                      style={{ width: '100%', height: '100%' }}
                      data={residualsData.map((resExp: any) => {
                        const color = fieldColors[resExp.b1_label] || PLOT_COLORS.primary;
                        return {
                          x: resExp.x,
                          y: resExp.y,
                          type: 'scatter',
                          mode: 'markers',
                          name: `${resExp.b1_label} Residuals`,
                          marker: { color, size: 5, opacity: 0.8 },
                          showlegend: false,
                          hovertemplate: `ν_CPMG: %{x:.1f} Hz<br>Residual: %{y:.2f} σ<extra>${resExp.b1_label}</extra>`,
                        };
                      })}
                      layout={{
                        xaxis: {
                          title: 'ν_CPMG (Hz)',
                          autorange: true,
                          gridcolor: isDark ? '#1e293b' : '#f1f5f9',
                        },
                        yaxis: {
                          title: 'Residual (σ)',
                          range: [-3.5, 3.5],
                          zeroline: true,
                          zerolinecolor: '#94a3b8',
                          gridcolor: isDark ? '#1e293b' : '#f1f5f9',
                        },
                        margin: { l: 60, r: 30, t: 10, b: 40 },
                        paper_bgcolor: 'transparent',
                        plot_bgcolor: 'transparent',
                        shapes: [
                          { type: 'line', x0: 0, x1: 1, xref: 'paper', y0: 0, y1: 0, line: { color: '#94a3b8', width: 1.2 } },
                          { type: 'line', x0: 0, x1: 1, xref: 'paper', y0: 1, y1: 1, line: { color: '#cbd5e1', width: 1, dash: 'dash' } },
                          { type: 'line', x0: 0, x1: 1, xref: 'paper', y0: -1, y1: -1, line: { color: '#cbd5e1', width: 1, dash: 'dash' } },
                          { type: 'line', x0: 0, x1: 1, xref: 'paper', y0: 2, y1: 2, line: { color: '#e2e8f0', width: 1, dash: 'dot' } },
                          { type: 'line', x0: 0, x1: 1, xref: 'paper', y0: -2, y1: -2, line: { color: '#e2e8f0', width: 1, dash: 'dot' } },
                        ],
                      }}
                      config={{ responsive: true, displayModeBar: false }}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* ── Diagnostic Sequence Plots (3 Columns + Kinetic Correlation) ── */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mt-6">
            {/* Panel 1: Reduced χ² vs Residue */}
            <div className={sectionCls}>
              <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-4 flex items-center gap-2">
                <span className="w-1.5 h-4 bg-blue-500 rounded-full" /> Reduced χ² vs Residue
              </h4>
              <Plot
                data={[{
                  x: sortedResidueKeys.map(res => effectiveResidueMapping[res] || res),
                  y: sortedResidueKeys.map(res => activeResidues[res]?.chi2_red ?? activeResidues[res]?.parameters?.chi2_red),
                  type: 'scatter',
                  mode: 'markers',
                  marker: { size: 9, color: PLOT_COLORS.primary, opacity: 0.8, line: { width: 1.2, color: '#fff' } },
                  name: 'Reduced χ²',
                }]}
                layout={{
                  xaxis: { title: 'Residue', tickangle: -45 },
                  yaxis: { title: 'Reduced χ²', rangemode: 'tozero' },
                  margin: { l: 55, r: 25, t: 15, b: 70 },
                  height: 320,
                  paper_bgcolor: 'transparent',
                  plot_bgcolor: 'transparent',
                  shapes: [
                    { type: 'line', x0: 0, x1: 1, xref: 'paper', y0: 1.0, y1: 1.0, line: { color: '#94a3b8', width: 1.2, dash: 'dash' } },
                  ],
                }}
                style={{ width: '100%' }}
                config={{ responsive: true, displayModeBar: false }}
              />
            </div>

            {/* Panel 2: R₂ Values vs Residue */}
            <div className={sectionCls}>
              <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-4 flex items-center gap-2">
                <span className="w-1.5 h-4 bg-emerald-500 rounded-full" /> R₂ (s⁻¹) vs Residue
              </h4>
              <Plot
                data={[
                  {
                    x: sortedResidueKeys.map(res => effectiveResidueMapping[res] || res),
                    y: sortedResidueKeys.map(res => getR2AValue(activeResidues[res])),
                    error_y: {
                      type: 'data',
                      array: sortedResidueKeys.map(res => getR2AErr(activeResidues[res]) ?? 0),
                      visible: true,
                      color: PLOT_COLORS.primary,
                    },
                    type: 'scatter',
                    mode: 'markers',
                    marker: { size: 9, color: PLOT_COLORS.primary, opacity: 0.85, line: { width: 1, color: '#fff' } },
                    name: 'R2A (Ground)',
                  },
                  {
                    x: sortedResidueKeys.map(res => effectiveResidueMapping[res] || res),
                    y: sortedResidueKeys.map(res => getR2BValue(activeResidues[res])),
                    error_y: {
                      type: 'data',
                      array: sortedResidueKeys.map(res => getR2BErr(activeResidues[res]) ?? 0),
                      visible: true,
                      color: '#ef4444',
                    },
                    type: 'scatter',
                    mode: 'markers',
                    marker: { size: 9, color: '#ef4444', opacity: 0.85, symbol: 'diamond-open', line: { width: 1.5, color: '#ef4444' } },
                    name: 'R2B (Excited)',
                  },
                ]}
                layout={{
                  xaxis: { title: 'Residue', tickangle: -45 },
                  yaxis: { title: 'R₂ (s⁻¹)', rangemode: 'tozero' },
                  margin: { l: 55, r: 25, t: 15, b: 70 },
                  height: 320,
                  paper_bgcolor: 'transparent',
                  plot_bgcolor: 'transparent',
                  legend: { orientation: 'h', y: -0.35, x: 0.5, xanchor: 'center' },
                }}
                style={{ width: '100%' }}
                config={{ responsive: true, displayModeBar: false }}
              />
            </div>

            {/* Panel 3: Δω vs Residue */}
            <div className={sectionCls}>
              <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-4 flex items-center gap-2">
                <span className="w-1.5 h-4 bg-purple-500 rounded-full" /> Δω (ppm) vs Residue
              </h4>
              <Plot
                data={[{
                  x: sortedResidueKeys.map(res => effectiveResidueMapping[res] || res),
                  y: sortedResidueKeys.map(res => {
                    const rObj = activeResidues[res];
                    const p = rObj?.parameters || {};
                    return rObj?.dw_ab?.value ?? (p?.dw_ab as any)?.value ?? p?.dw_ab ?? (p?.DW_AB as any)?.value ?? p?.DW_AB ?? rObj?.dw ?? 0;
                  }),
                  error_y: {
                    type: 'data',
                    array: sortedResidueKeys.map(res => {
                      const rObj = activeResidues[res];
                      const p = rObj?.parameters || {};
                      return rObj?.dw_ab?.stderr ?? rObj?.dw_ab?.error ?? (p?.dw_ab as any)?.stderr ?? (p?.DW_AB as any)?.stderr ?? 0;
                    }),
                    visible: true,
                    color: '#9333ea',
                  },
                  type: 'scatter',
                  mode: 'markers',
                  marker: {
                    size: 9,
                    color: '#9333ea',
                    opacity: 0.85,
                    line: { width: 1.2, color: '#fff' },
                  },
                  name: 'Δω (Signed)',
                }]}
                layout={{
                  xaxis: { title: 'Residue', tickangle: -45 },
                  yaxis: { title: 'Δω (ppm)', zeroline: true, zerolinecolor: '#94a3b8' },
                  margin: { l: 55, r: 25, t: 15, b: 70 },
                  height: 320,
                  paper_bgcolor: 'transparent',
                  plot_bgcolor: 'transparent',
                  shapes: [
                    { type: 'line', x0: 0, x1: 1, xref: 'paper', y0: 0, y1: 0, line: { color: '#94a3b8', width: 1.2, dash: 'dash' } },
                  ],
                }}
                style={{ width: '100%' }}
                config={{ responsive: true, displayModeBar: false }}
              />
            </div>
          </div>

          {/* Chart 4: Kinetic Correlation (k_ex vs p_b) */}
          <div className={`${sectionCls} mt-6`}>
            <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-4 flex items-center gap-2">
              <span className="w-1.5 h-4 bg-indigo-500 rounded-full" /> Kinetic Correlation (k_ex vs p_b)
            </h4>
            <Plot
              data={[
                {
                  x: sortedResidueKeys.map(
                    (res) => {
                      const r: any = activeResidues[res];
                      return ((typeof r?.parameters?.pb === 'object' ? r?.parameters?.pb?.value : r?.parameters?.pb) ??
                        (typeof r?.pb === 'object' ? r.pb?.value : r?.pb) ??
                        activeGlobals?.pb?.value ??
                        activeGlobals?.pb ??
                        0) * 100;
                    }
                  ),
                  y: sortedResidueKeys.map(
                    (res) => {
                      const r: any = activeResidues[res];
                      return (typeof r?.parameters?.kex_ab === 'object' ? r?.parameters?.kex_ab?.value : r?.parameters?.kex_ab) ??
                        (typeof r?.kex_ab === 'object' ? r.kex_ab?.value : r?.kex_ab) ??
                        activeGlobals?.kex_ab?.value ??
                        activeGlobals?.kex_ab ??
                        1;
                    }
                  ),
                  text: sortedResidueKeys.map(
                    (res) => effectiveResidueMapping[res] || res
                  ),
                  type: 'scatter',
                  mode: 'markers+text',
                  marker: {
                    size: 11,
                    color: PLOT_COLORS.primary,
                    opacity: 0.65,
                    line: { width: 1, color: 'white' },
                  },
                  textposition: 'top center',
                  textfont: { size: 9, color: isDark ? '#94a3b8' : '#64748b' },
                  name: 'Residues',
                },
              ]}
              layout={{
                xaxis: { title: 'Excited Population p_b (%)' },
                yaxis: { title: 'Exchange Rate k_ex (s⁻¹)', type: 'linear' },
                margin: { l: 70, r: 30, t: 30, b: 60 },
                height: 420,
                paper_bgcolor: 'transparent',
                plot_bgcolor: 'transparent',
                hovermode: 'closest',
              }}
              style={{ width: '100%' }}
              config={{ responsive: true, displayModeBar: false }}
            />
          </div>

          {/* ── Run Provenance Accordion ── */}
          {analysisResults?.provenance && (
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-2xs mt-6">
              <button
                type="button"
                onClick={() => setShowProvenance(prev => !prev)}
                className="w-full p-3 flex items-center justify-between text-xs font-bold text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <Info className="w-4 h-4 text-slate-400" />
                  <span>Run Provenance & Execution Details</span>
                </div>
                {showProvenance ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
              </button>
              {showProvenance && (
                <div className="p-4 border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/40 text-xs font-mono space-y-2">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-slate-600 dark:text-slate-400">
                    <div><strong className="text-slate-800 dark:text-slate-200 font-sans">ChemEx Version:</strong> {analysisResults.provenance.chemex_version || '2026.6.1'}</div>
                    <div><strong className="text-slate-800 dark:text-slate-200 font-sans">Execution Date:</strong> {analysisResults.provenance.date || '—'}</div>
                    <div className="sm:col-span-2"><strong className="text-slate-800 dark:text-slate-200 font-sans">Command:</strong> {analysisResults.provenance.command || 'chemex fit'}</div>
                    {analysisResults.provenance.root_seed && (
                      <div><strong className="text-slate-800 dark:text-slate-200 font-sans">Root Seed:</strong> {analysisResults.provenance.root_seed}</div>
                    )}
                    {analysisResults.provenance.git_commit && (
                      <div><strong className="text-slate-800 dark:text-slate-200 font-sans">Git Commit:</strong> {analysisResults.provenance.git_commit}</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
};
export default CpmgResultsTab;


