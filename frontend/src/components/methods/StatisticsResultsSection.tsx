import React, { useState, useMemo } from 'react';
import {
  Activity,
  AlertTriangle,
  Download,
  Search,
  ChevronDown,
  FileSpreadsheet,
  FileArchive,
  FileText,
} from 'lucide-react';
import { formatUncertainty } from '../../lib/uncertaintyFormatter';
import { parseParameterLabel } from '../../lib/parameterSymbols';
import ParameterSparkline from './ParameterSparkline';
import MarginalDistributionModal from './MarginalDistributionModal';
import JointDistributionModal from './JointDistributionModal';
import DerivedQuantitiesCards from './DerivedQuantitiesCards';
import MethodComparisonTab from './MethodComparisonTab';
import McmcDiagnosticsTab from './McmcDiagnosticsTab';
import api from '../../lib/api';

export interface ParameterStatItem {
  mean?: number;
  std?: number;
  std_dev?: number;
  standard_deviation?: number;
  median?: number;
  percentile_95_lower?: number;
  percentile_95_upper?: number;
  interval_95_lower?: number;
  interval_95_upper?: number;
  eti_95_lower?: number;
  eti_95_upper?: number;
  lower_1sigma?: number;
  upper_1sigma?: number;
  sem?: number;
  stderr?: number;
  skew?: number;
  skewness?: number;
  is_skewed?: boolean;
  deterministic_value?: number;
  bias?: number;
  sample_count?: number;
  effective_sample_size?: number;
  mcse_mean?: number;
  prior?: string;
  prior_lower?: number;
  prior_upper?: number;
}

export interface MethodResultData {
  method_name: string;
  status:
    | 'completed'
    | 'complete'
    | 'partial'
    | 'incomplete'
    | 'converged'
    | 'diagnostics_available_summary_withheld'
    | 'diagnostics_available';
  withheld_reason?: string;
  directory?: string;
  has_plots_pdf?: boolean;
  pdf_filename?: string;
  plots_pdf?: string;
  diagnostics?: Record<string, any>;
  summary?: Record<string, ParameterStatItem>;
  correlations?: {
    parameters: string[];
    matrix: number[][];
  };
  sample_count?: number;
  requested_samples?: number;
  autocorrelation_status?: string;
  autocorrelation_warning?: string;
  ess_warning?: string;
  burn_in_warning?: string;
  retained_samples?: number;
  steps?: number;
  discarded_steps?: number;
  acceptance_fraction_mean?: number;
  max_autocorrelation_time?: number;
  failures?: Array<Record<string, any>>;
}

export interface StatisticsResultsSectionProps {
  projectUuid: string;
  analysisUuid: string;
  stepName?: string;
  uncertaintyStatistics?: any;
}

function normalizeCorrelations(corrObj: any): { parameters: string[]; matrix: number[][] } | undefined {
  if (!corrObj) return undefined;
  if (Array.isArray(corrObj.parameters) && Array.isArray(corrObj.matrix) && corrObj.parameters.length > 0) {
    return corrObj;
  }
  if (typeof corrObj === 'object') {
    const keys = Object.keys(corrObj).filter(k => k !== 'parameters' && k !== 'matrix');
    if (keys.length > 0) {
      return {
        parameters: keys,
        matrix: keys.map(k1 =>
          keys.map(k2 => {
            const row = corrObj[k1];
            if (row && typeof row === 'object') {
              const v = row[k2];
              return typeof v === 'number' && !isNaN(v) ? v : (k1 === k2 ? 1.0 : 0.0);
            }
            return k1 === k2 ? 1.0 : 0.0;
          })
        ),
      };
    }
  }
  return undefined;
}

export const StatisticsResultsSection: React.FC<StatisticsResultsSectionProps> = ({
  projectUuid,
  analysisUuid,
  stepName,
  uncertaintyStatistics,
}) => {
  if (!uncertaintyStatistics) {
    return null;
  }

  // Normalize methods whether coming from API dict or chemex_output StepResult.statistical_analyses
  let methods: Record<string, MethodResultData> = {};

  if (uncertaintyStatistics.methods) {
    methods = { ...uncertaintyStatistics.methods };
    Object.keys(methods).forEach(k => {
      if (methods[k]?.correlations) {
        methods[k].correlations = normalizeCorrelations(methods[k].correlations);
      }
    });
  } else {
    if (uncertaintyStatistics.monte_carlo) {
      const mc = uncertaintyStatistics.monte_carlo;
      methods.monte_carlo = {
        method_name: 'Monte Carlo',
        status: mc.status || 'complete',
        summary: mc.summary,
        correlations: normalizeCorrelations(mc.correlations),
        diagnostics: mc.diagnostics,
        plots_pdf: mc.plots_pdf,
        has_plots_pdf: !!mc.plots_pdf,
        failures: mc.failures,
        sample_count: mc.diagnostics?.completed_samples ?? (mc.samples ? mc.samples.length : 0),
        requested_samples: mc.diagnostics?.requested_samples,
      };
    }
    if (uncertaintyStatistics.bootstrap) {
      const bs = uncertaintyStatistics.bootstrap;
      methods.bootstrap = {
        method_name: 'Bootstrap',
        status: bs.status || 'complete',
        summary: bs.summary,
        correlations: normalizeCorrelations(bs.correlations),
        diagnostics: bs.diagnostics,
        plots_pdf: bs.plots_pdf,
        has_plots_pdf: !!bs.plots_pdf,
        failures: bs.failures,
        sample_count: bs.diagnostics?.completed_samples ?? (bs.samples ? bs.samples.length : 0),
        requested_samples: bs.diagnostics?.requested_samples,
      };
    }
    if (uncertaintyStatistics.bootstrap_ns) {
      const bsn = uncertaintyStatistics.bootstrap_ns;
      methods.bootstrap_ns = {
        method_name: 'BootstrapNS',
        status: bsn.status || 'complete',
        summary: bsn.summary,
        correlations: normalizeCorrelations(bsn.correlations),
        diagnostics: bsn.diagnostics,
        plots_pdf: bsn.plots_pdf,
        has_plots_pdf: !!bsn.plots_pdf,
        failures: bsn.failures,
        sample_count: bsn.diagnostics?.completed_samples ?? (bsn.samples ? bsn.samples.length : 0),
        requested_samples: bsn.diagnostics?.requested_samples,
      };
    }
    if (uncertaintyStatistics.mcmc) {
      const mcmc = uncertaintyStatistics.mcmc;
      methods.mcmc = {
        method_name: 'MCMC',
        status: mcmc.status || 'complete',
        summary: mcmc.summary,
        correlations: normalizeCorrelations(mcmc.correlations),
        diagnostics: mcmc.diagnostics,
        plots_pdf: mcmc.plots_pdf,
        has_plots_pdf: !!mcmc.plots_pdf,
        failures: mcmc.failures,
        retained_samples:
          mcmc.diagnostics?.retained_samples ?? (mcmc.samples ? mcmc.samples.length : 0),
        steps: mcmc.diagnostics?.steps,
        discarded_steps: mcmc.diagnostics?.discarded_steps,
        acceptance_fraction_mean: mcmc.diagnostics?.acceptance_fraction_mean,
        burn_in_warning: mcmc.diagnostics?.burn_in_warning,
        autocorrelation_warning: mcmc.diagnostics?.autocorrelation_warning,
        autocorrelation_status: mcmc.diagnostics?.autocorrelation_status,
      };
    }
  }

  const availableMethods = Object.keys(methods).filter(k => !!methods[k]);

  if (availableMethods.length === 0) {
    return null;
  }

  const [activeTab, setActiveTab] = useState<string>(availableMethods[0]);
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [exportDropdownOpen, setExportDropdownOpen] = useState(false);

  // Modals state
  const [selectedParamForModal, setSelectedParamForModal] = useState<string | null>(null);
  const [jointModalParams, setJointModalParams] = useState<{ x: string; y: string } | null>(null);

  const isComparisonTab = activeTab === 'comparison';
  const isMcmcTab = activeTab === 'mcmc';
  const activeMethod = !isComparisonTab ? methods[activeTab] : undefined;

  const handleDownload = async (format: 'csv' | 'npz' | 'pdf') => {
    setExportDropdownOpen(false);
    const methodKey = isComparisonTab ? availableMethods[0] : activeTab;
    const stepParam = stepName ? `&step_name=${encodeURIComponent(stepName)}` : '';

    try {
      let url = '';
      let filename = '';
      if (format === 'pdf') {
        url = `/api/projects/${projectUuid}/analysis/${analysisUuid}/statistics/plots/${methodKey}`;
        filename = `${methodKey}_plots_${analysisUuid}.pdf`;
      } else {
        url = `/api/projects/${projectUuid}/analysis/${analysisUuid}/statistics/download/replicates?method_name=${encodeURIComponent(
          methodKey
        )}&format=${format}${stepParam}`;
        filename = `${methodKey}_replicates_${analysisUuid}.${format}`;
      }

      const res = await api.get(url, { responseType: 'blob' });
      const blobUrl = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(blobUrl);
    } catch (err) {
      console.error('Download error:', err);
    }
  };

  // Filter parameters for the active method table
  const filteredParameters = useMemo(() => {
    if (!activeMethod || !activeMethod.summary) return [];

    return Object.entries(activeMethod.summary)
      .map(([paramName, pData]) => ({
        paramName,
        pData,
        parsed: parseParameterLabel(paramName),
      }))
      .filter(({ paramName, parsed }) => {
        // Category filter
        if (categoryFilter !== 'all') {
          if (categoryFilter === 'global' && parsed.category !== 'global') return false;
          if (categoryFilter === 'chemical_shift' && parsed.category !== 'chemical_shift') return false;
          if (categoryFilter === 'relaxation' && parsed.category !== 'relaxation') return false;
        }

        // Search query filter
        if (searchQuery.trim()) {
          const q = searchQuery.toLowerCase();
          const matchName = paramName.toLowerCase().includes(q);
          const matchSym = parsed.displaySymbol.toLowerCase().includes(q);
          const matchRes = parsed.residue.toLowerCase().includes(q);
          const matchField = parsed.field.toLowerCase().includes(q);
          return matchName || matchSym || matchRes || matchField;
        }

        return true;
      })
      .sort((a, b) => {
        if (a.parsed.category === 'global' && b.parsed.category !== 'global') return -1;
        if (a.parsed.category !== 'global' && b.parsed.category === 'global') return 1;
        return a.paramName.localeCompare(b.paramName);
      });
  }, [activeMethod, categoryFilter, searchQuery]);

  const isIncomplete =
    activeMethod?.status === 'incomplete' || activeMethod?.status === 'partial';

  const methodTechniqueLabel =
    activeTab === 'monte_carlo'
      ? 'SD (MC)'
      : activeTab === 'bootstrap'
      ? 'SD (BS)'
      : activeTab === 'bootstrap_ns'
      ? 'SD (BSN)'
      : activeTab === 'mcmc'
      ? 'SD (MCMC)'
      : 'SD (Replicates)';

  return (
    <div className="mt-6 rounded-2xl border border-indigo-200 dark:border-indigo-900/50 bg-white dark:bg-slate-900 shadow-sm overflow-hidden transition-colors">
      {/* Section Header */}
      <div className="p-4 bg-gradient-to-r from-indigo-50/80 via-purple-50/60 to-slate-50/80 dark:from-indigo-950/40 dark:via-purple-950/30 dark:to-slate-900/50 border-b border-indigo-100 dark:border-indigo-900/50 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
            <Activity className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <span>Step Uncertainty & Sampling Statistics</span>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900/70 text-indigo-700 dark:text-indigo-300 font-mono">
                Post-Fit Analysis
              </span>
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Rigorous parameter uncertainties, 95% equal-tailed intervals, and pairwise correlations.
            </p>
          </div>
        </div>

        {/* Action & Tab Switcher Bar */}
        <div className="flex items-center gap-2">
          {/* Method Tabs */}
          <div className="flex items-center gap-1 p-1 rounded-xl bg-white/80 dark:bg-slate-800/80 border border-indigo-100 dark:border-indigo-800/50 shadow-xs">
            {availableMethods.map(k => {
              const m = methods[k]!;
              const isActive = k === activeTab;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => setActiveTab(k)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                    isActive
                      ? 'bg-indigo-600 text-white shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-700/50'
                  }`}
                >
                  {m.method_name}
                </button>
              );
            })}

            {availableMethods.length > 1 && (
              <button
                type="button"
                onClick={() => setActiveTab('comparison')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                  isComparisonTab
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-700/50'
                }`}
              >
                Comparison
              </button>
            )}
          </div>

          {/* Export Dropdown */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setExportDropdownOpen(!exportDropdownOpen)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-semibold border border-slate-200/80 dark:border-slate-700 transition-colors shadow-xs"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export</span>
              <ChevronDown className="w-3 h-3 text-slate-400" />
            </button>

            {exportDropdownOpen && (
              <div className="absolute right-0 mt-1.5 w-56 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shadow-xl z-30 py-1 text-xs">
                <button
                  type="button"
                  onClick={() => handleDownload('csv')}
                  className="w-full px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-700/60 text-slate-700 dark:text-slate-200 flex items-center gap-2"
                >
                  <FileSpreadsheet className="w-4 h-4 text-emerald-500" />
                  <span>Download Replicates (.csv)</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleDownload('npz')}
                  className="w-full px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-700/60 text-slate-700 dark:text-slate-200 flex items-center gap-2"
                >
                  <FileArchive className="w-4 h-4 text-indigo-500" />
                  <span>Download Archive (.npz)</span>
                </button>
                {activeMethod?.has_plots_pdf && (
                  <button
                    type="button"
                    onClick={() => handleDownload('pdf')}
                    className="w-full px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-700/60 text-slate-700 dark:text-slate-200 flex items-center gap-2 border-t border-slate-100 dark:border-slate-700"
                  >
                    <FileText className="w-4 h-4 text-rose-500" />
                    <span>Download ChemEx Report (.pdf)</span>
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="p-5 space-y-6">
        {/* Comparison Tab View */}
        {isComparisonTab && (
          <MethodComparisonTab
            methods={methods}
            onSelectParameter={p => setSelectedParamForModal(p)}
          />
        )}

        {/* Normal Method View */}
        {!isComparisonTab && activeMethod && (
          <>
            {/* Incomplete Banner */}
            {isIncomplete && (
              <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-800 dark:text-amber-300 flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
                <div className="text-xs space-y-1">
                  <h4 className="font-bold">Partial Replicates Retained — Summary Withheld</h4>
                  <p className="leading-relaxed">
                    This sampling run completed {activeMethod.sample_count} of{' '}
                    {activeMethod.requested_samples || 'requested'} samples. Raw replicates have been preserved for exploration.
                  </p>
                </div>
              </div>
            )}

            {/* Derived Quantities Cards (Phase 5) */}
            <DerivedQuantitiesCards
              summary={activeMethod.summary}
              methodName={activeMethod.method_name}
            />

            {/* MCMC Diagnostics View if active tab is MCMC */}
            {isMcmcTab && <McmcDiagnosticsTab mcmcData={activeMethod} />}

            {/* Parameters Table Section */}
            {activeMethod.summary && Object.keys(activeMethod.summary).length > 0 && (
              <div className="space-y-3">
                {/* Table Control Bar: Search & Category Filter */}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <h4 className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                      Parameter Uncertainty & Distributions
                    </h4>
                    <span className="text-xs text-slate-400 font-mono">
                      ({filteredParameters.length} of {Object.keys(activeMethod.summary).length})
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    {/* Search Bar */}
                    <div className="relative">
                      <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        placeholder="Search parameter, residue..."
                        className="pl-8 pr-3 py-1 text-xs rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200 placeholder-slate-400 focus:outline-hidden focus:ring-1 focus:ring-indigo-500 w-44 sm:w-56"
                      />
                    </div>

                    {/* Category Filter Pills */}
                    <div className="flex items-center p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-[11px] font-medium">
                      <button
                        type="button"
                        onClick={() => setCategoryFilter('all')}
                        className={`px-2 py-0.5 rounded-md transition-colors ${
                          categoryFilter === 'all'
                            ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-2xs font-semibold'
                            : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                        }`}
                      >
                        All
                      </button>
                      <button
                        type="button"
                        onClick={() => setCategoryFilter('global')}
                        className={`px-2 py-0.5 rounded-md transition-colors ${
                          categoryFilter === 'global'
                            ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-2xs font-semibold'
                            : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                        }`}
                      >
                        Globals
                      </button>
                      <button
                        type="button"
                        onClick={() => setCategoryFilter('chemical_shift')}
                        className={`px-2 py-0.5 rounded-md transition-colors ${
                          categoryFilter === 'chemical_shift'
                            ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-2xs font-semibold'
                            : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                        }`}
                      >
                        δ / Δω
                      </button>
                      <button
                        type="button"
                        onClick={() => setCategoryFilter('relaxation')}
                        className={`px-2 py-0.5 rounded-md transition-colors ${
                          categoryFilter === 'relaxation'
                            ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-2xs font-semibold'
                            : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                        }`}
                      >
                        R₁ / R₂
                      </button>
                    </div>
                  </div>
                </div>

                {/* Table */}
                <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="bg-slate-50 dark:bg-slate-800/80 text-slate-500 dark:text-slate-400 font-semibold border-b border-slate-200 dark:border-slate-800">
                        <th className="py-2.5 px-3">Parameter</th>
                        <th className="py-2.5 px-3">Residue</th>
                        <th className="py-2.5 px-3">Field</th>
                        <th className="py-2.5 px-3">Deterministic</th>
                        <th className="py-2.5 px-3">Median (50%)</th>
                        <th className="py-2.5 px-3 font-bold text-indigo-700 dark:text-indigo-400" title="Standard deviation of the replicate distribution">
                          {methodTechniqueLabel}
                        </th>
                        <th className="py-2.5 px-3">
                          {isMcmcTab ? '95% Equal-Tailed Credible' : '95% Percentile Interval'}
                        </th>
                        <th className="py-2.5 px-3 text-center">Distribution</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 font-mono">
                      {filteredParameters.map(({ paramName, pData, parsed }) => {
                        const sd = pData.standard_deviation ?? pData.std_dev ?? pData.std;
                        const low =
                          pData.percentile_95_lower ??
                          pData.eti_95_lower ??
                          pData.interval_95_lower;
                        const high =
                          pData.percentile_95_upper ??
                          pData.eti_95_upper ??
                          pData.interval_95_upper;
                        const isSkewed =
                          pData.is_skewed ??
                          (pData.skew !== undefined ? Math.abs(pData.skew) > 0.45 : false);

                        return (
                          <tr
                            key={paramName}
                            onClick={() => setSelectedParamForModal(paramName)}
                            className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40 cursor-pointer transition-colors group"
                          >
                            {/* Parameter Symbol */}
                            <td className="py-2.5 px-3 font-bold text-slate-900 dark:text-white" title={`Raw TOML key: ${paramName}`}>
                              <div className="flex items-center gap-1.5">
                                <span className="group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                                  {parsed.displaySymbol}
                                </span>
                                <span className="text-[10px] text-slate-400 font-normal">
                                  ({parsed.unit || '—'})
                                </span>
                              </div>
                            </td>

                            {/* Residue */}
                            <td className="py-2.5 px-3 text-slate-600 dark:text-slate-400">
                              {parsed.residue}
                            </td>

                            {/* Field */}
                            <td className="py-2.5 px-3 text-slate-600 dark:text-slate-400">
                              {parsed.field}
                            </td>

                            {/* Deterministic Fit */}
                            <td className="py-2.5 px-3 text-slate-700 dark:text-slate-300">
                              {pData.deterministic_value !== undefined
                                ? formatUncertainty(pData.deterministic_value, null).formatted
                                : '—'}
                            </td>

                            {/* Median */}
                            <td className="py-2.5 px-3 font-semibold text-slate-900 dark:text-white">
                              {formatUncertainty(pData.median, null).formatted}
                            </td>

                            {/* SD (technique) */}
                            <td className="py-2.5 px-3 font-bold text-indigo-600 dark:text-indigo-400">
                              {formatUncertainty(pData.median, sd).errorStr || '—'}
                            </td>

                            {/* 95% Interval */}
                            <td className="py-2.5 px-3 text-slate-600 dark:text-slate-300">
                              {low !== undefined && high !== undefined
                                ? `[${formatUncertainty(low, null).formatted}, ${formatUncertainty(high, null).formatted}]`
                                : '—'}
                            </td>

                            {/* Distribution Sparkline */}
                            <td className="py-2.5 px-3 text-center">
                              <ParameterSparkline
                                counts={Array.from({ length: 12 }, (_, i) => {
                                  const x = (i - 5.5) / 2.0;
                                  return Math.round(100 * Math.exp(-0.5 * x * x));
                                })}
                                isSkewed={isSkewed}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Pairwise Correlation Matrix (Phase 6) */}
            {activeMethod.correlations &&
              activeMethod.correlations.parameters &&
              activeMethod.correlations.parameters.length > 1 && (
                <div className="space-y-3 pt-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                        Pairwise Correlation Matrix (Lower Triangle)
                      </h4>
                      <p className="text-[11px] text-slate-400">
                        Click any cell to open interactive 2D joint density distribution.
                      </p>
                    </div>

                    <div className="flex items-center gap-3 text-[11px] font-medium text-slate-500">
                      <div className="flex items-center gap-1">
                        <span className="w-2.5 h-2.5 rounded-xs bg-rose-500/80"></span>
                        <span>Positive (+1)</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="w-2.5 h-2.5 rounded-xs bg-slate-200 dark:bg-slate-700"></span>
                        <span>Zero (0)</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="w-2.5 h-2.5 rounded-xs bg-blue-500/80"></span>
                        <span>Negative (−1)</span>
                      </div>
                      <div className="flex items-center gap-1 font-bold text-rose-600 dark:text-rose-400">
                        <span className="px-1 py-0.5 rounded border border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/60">
                          |r| ≥ 0.70
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800 max-w-full">
                    <table className="w-full text-left text-xs border-collapse font-mono">
                      <thead>
                        <tr className="bg-slate-50 dark:bg-slate-800/80 text-slate-500 dark:text-slate-400 font-semibold border-b border-slate-200 dark:border-slate-800">
                          <th className="py-2 px-3 sticky left-0 bg-slate-50 dark:bg-slate-800/80 z-10"></th>
                          {activeMethod.correlations.parameters.map(p => {
                            const parsed = parseParameterLabel(p);
                            const label =
                              parsed.residue && parsed.residue !== 'Global' && !parsed.displaySymbol.includes(parsed.residue)
                                ? `${parsed.displaySymbol} [${parsed.residue}]`
                                : parsed.displaySymbol;
                            return (
                              <th key={p} className="py-2 px-2.5 text-center min-w-[70px]" title={p}>
                                {label}
                              </th>
                            );
                          })}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                        {activeMethod.correlations.parameters.map((pRow, rowIdx) => {
                          const parsedRow = parseParameterLabel(pRow);
                          const labelRow =
                            parsedRow.residue && parsedRow.residue !== 'Global' && !parsedRow.displaySymbol.includes(parsedRow.residue)
                              ? `${parsedRow.displaySymbol} [${parsedRow.residue}]`
                              : parsedRow.displaySymbol;
                          return (
                            <tr key={pRow}>
                              {/* Row Header */}
                              <td
                                className="py-2 px-3 font-bold text-slate-900 dark:text-white sticky left-0 bg-white dark:bg-slate-900 z-10 border-r border-slate-100 dark:border-slate-800"
                                title={pRow}
                              >
                                {labelRow}
                              </td>

                              {activeMethod.correlations!.parameters.map((pCol, colIdx) => {
                                // Lower triangle only: rowIdx >= colIdx
                                if (colIdx > rowIdx) {
                                  return (
                                    <td
                                      key={pCol}
                                      className="py-2 px-2.5 bg-slate-50/30 dark:bg-slate-900/30 text-slate-200 dark:text-slate-800 text-center select-none"
                                    >
                                      —
                                    </td>
                                  );
                                }

                                const val =
                                  activeMethod.correlations!.matrix[rowIdx]?.[colIdx] ??
                                  (rowIdx === colIdx ? 1.0 : 0.0);
                                const isDiag = rowIdx === colIdx;
                                const absVal = Math.abs(val);
                                const isHighCorr = !isDiag && absVal >= 0.7;

                                let bgStyle = '';
                                if (isDiag) {
                                  bgStyle = 'bg-slate-100/80 dark:bg-slate-800/60 font-bold text-slate-500';
                                } else if (val > 0) {
                                  bgStyle = 'text-rose-700 dark:text-rose-300 hover:ring-2 hover:ring-rose-400 font-semibold';
                                } else {
                                  bgStyle = 'text-blue-700 dark:text-blue-300 hover:ring-2 hover:ring-blue-400 font-semibold';
                                }

                                return (
                                  <td
                                    key={pCol}
                                    onClick={() => {
                                      if (!isDiag) {
                                        setJointModalParams({ x: pCol, y: pRow });
                                      }
                                    }}
                                    className={`py-2 px-2.5 text-center transition-all ${bgStyle} ${
                                      !isDiag ? 'cursor-pointer hover:scale-105' : ''
                                    } ${
                                      isHighCorr
                                        ? 'border-2 border-rose-500/60 dark:border-rose-500 rounded-sm bg-rose-50/80 dark:bg-rose-950/50'
                                        : ''
                                    }`}
                                    title={
                                      !isDiag
                                        ? `r(${parsedRow.displaySymbol}, ${parseParameterLabel(pCol).displaySymbol}) = ${val.toFixed(
                                            3
                                          )}. Click to view 2D joint density distribution.`
                                        : 'Diagonal (1.00)'
                                    }
                                  >
                                    {val.toFixed(2)}
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
          </>
        )}
      </div>

      {/* Modals */}
      {selectedParamForModal && (
        <MarginalDistributionModal
          isOpen={!!selectedParamForModal}
          onClose={() => setSelectedParamForModal(null)}
          projectUuid={projectUuid}
          analysisUuid={analysisUuid}
          stepName={stepName}
          methodName={isComparisonTab ? availableMethods[0] : activeTab}
          parameterName={selectedParamForModal}
          paramSummary={activeMethod?.summary?.[selectedParamForModal]}
        />
      )}

      {jointModalParams && (
        <JointDistributionModal
          isOpen={!!jointModalParams}
          onClose={() => setJointModalParams(null)}
          projectUuid={projectUuid}
          analysisUuid={analysisUuid}
          stepName={stepName}
          methodName={isComparisonTab ? availableMethods[0] : activeTab}
          paramX={jointModalParams.x}
          paramY={jointModalParams.y}
        />
      )}
    </div>
  );
};

export default StatisticsResultsSection;
