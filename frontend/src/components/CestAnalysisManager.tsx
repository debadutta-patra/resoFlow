import React, { useState, useEffect, useRef, useMemo } from 'react';
import api from '../services/api';
import {
  Play, FileText,
  ChevronLeft, ChevronRight, Check, AlertCircle,
  Beaker, Loader2, RotateCcw, Square,
  Workflow, Sparkles, Code, Copy, Download, Upload,
  AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Info,
  RefreshCw, FileCode, Sliders, MinusCircle, PlusCircle, GitFork,
  Activity, ArrowUpDown, LayoutGrid, Maximize2, Search
} from 'lucide-react';
import Plot, { PLOT_COLORS } from './Plot';
import { formatUncertainty } from '../lib/uncertaintyFormatter';
import { useTheme } from '../context/ThemeContext';
import type { MethodConfig, Step } from '../lib/methodConfig';
import { createDefaultMethodConfig, createDefaultStep, KINETIC_MODELS } from '../lib/methodConfig';
import { configToToml, tomlToConfig } from '../lib/methodToml';
import { validateMethodConfig } from '../lib/methodValidation';
import { METHOD_TEMPLATES, type MethodTemplate } from '../lib/methodTemplates';
import ParameterTable, { type AvailableParamMeta } from './methods/ParameterTable';
import ResidueSelector, { type ResidueItem } from './methods/ResidueSelector';
import StepTabs from './methods/StepTabs';
import StepStatisticsSection from './methods/StepStatisticsSection';
import StatisticsResultsSection from './methods/StatisticsResultsSection';
import type { ParameterConfig, ResidueParams } from '../lib/parameterConfig';
import {
  createDefaultParameterConfig,
  computePickHash,
  canonicalizeParameterConfig,
  isResidueExcluded,
  toggleExcludeResidue,
  sortSpinKeys,
  deduplicateSpinKeys,
  applyGridCoordinatesToConfig,
} from '../lib/parameterConfig';
import {
  configToToml as paramConfigToToml,
  tomlToConfig as paramTomlToConfig,
  applyExclusionsToExperimentToml,
} from '../lib/parameterToml';
import { validateParameterConfig, type ParameterIssue } from '../lib/parameterValidation';
import type { SourceRunSummary } from '../lib/compatibility';
import { GlobalParametersCard } from './parameters/GlobalParametersCard';
import { ResidueParametersTable } from './parameters/ResidueParametersTable';
import { ResyncModal } from './parameters/ResyncModal';
import { ParametersImportModal } from './parameters/ParametersImportModal';
import { SourceRunPickerModal } from './parameters/SourceRunPickerModal';
import { InheritParametersModal } from './parameters/InheritParametersModal';
import { ModuleSelectorCard } from './cest/ModuleSelectorCard';
import { NestedConfigGroup, type B1DistributionConfig } from './cest/NestedConfigGroup';
import { ProfileFilterControls } from './cest/ProfileFilterControls';
import { GridSearchSection } from './grid/GridSearchSection';
import { getNucleusInfoForModule } from '../lib/experimentPlugin';
import nmrSpectraDark from '../assets/nmr_spectra_dark.jpg';
import nmrSpectraLight from '../assets/nmr_spectra_light.jpg';
import atomSpinDark from '../assets/atom_spin_dark.jpg';
import atomSpinLight from '../assets/atom_spin_light.jpg';
import peakFittingDark from '../assets/peak_fitting_dark.jpg';
import peakFittingLight from '../assets/peak_fitting_light.jpg';
import fitParametersDark from '../assets/fit_parameters_dark.jpg';
import fitParametersLight from '../assets/fit_parameters_light.jpg';
import terminalLogsDark from '../assets/terminal_logs_dark.jpg';
import terminalLogsLight from '../assets/terminal_logs_light.jpg';

// ── Interfaces ──────────────────────────────────────────────────────────
interface Spectrum {
  id: number;
  spectrum_uuid: string;
  name: string;
  experiment_type?: string;
  is_fitted?: boolean;
  b1?: number;
  b0?: number;
  carrier?: number;
  t_relax?: number;
  f3list_path?: string;
}

interface Analysis {
  id: number;
  analysis_uuid: string;
  name: string;
  analysis_type: string;
  status: string;
  parameters?: string;
  spectra: Spectrum[];
  use_height: boolean;
  has_backup: boolean;
}

interface StepResidueResult {
  residue?: string;
  raw_key?: string;
  display_name?: string;
  is_unrecognized?: boolean;
  chi2?: number;
  chi2_red?: number;
  ndata?: number;
  nvarys?: number;
  dof_convention?: string;
  r2_a?: any;
  r2_b?: any;
  r1_a?: any;
  cs_a?: any;
  cs_b?: any;
  dw_ab?: any;
  parameters?: Record<string, any>;
  experiments?: Array<{
    b1_label: string;
    exp_points?: { x: number[]; y: number[]; y_err?: number[] };
    calc_points?: { x: number[]; y: number[] };
    masked_points?: { x: number[]; y: number[] };
    fit_curve?: { x: number[]; y: number[]; y_err?: number[] };
  }>;
  fit_curve?: { x: number[]; y: number[]; y_err?: number[] };
  exp_points?: { x: number[]; y: number[]; y_err?: number[] };
}

interface StepDataResult {
  name: string;
  status: 'complete' | 'partial' | 'missing';
  parameters?: any;
  data?: Record<string, any>;
  statistics?: {
    ndata?: number;
    nvarys?: number;
    chisqr?: number;
    chi2?: number;
    redchi?: number;
    chi2_red?: number;
    pvalue?: number;
    ks_pvalue?: number;
    aic?: number;
    bic?: number;
    extra?: Record<string, any>;
  };
  grid?: any;
  statistical_analyses?: any;
  plots?: string[];
  residues?: Record<string, StepResidueResult>;
  globals?: Record<string, any>;
  kab?: any;
  kba?: any;
  pa?: any;
  tau_b?: any;
  has_statistics?: boolean;
  has_grid?: boolean;
}

interface AnalysisResult {
  global: {
    pb?: number;
    pb_err?: number;
    kex_ab?: number;
    kex_ab_err?: number;
    chi2?: number;
    chi2_red?: number;
    chisqr?: number;
    redchi?: number;
    ndata?: number;
    nvarys?: number;
    [key: string]: any;
  };
  residues: Record<string, StepResidueResult>;
  steps?: Record<string, StepDataResult>;
  step_order?: string[];
  is_multi_step?: boolean;
  primary_step?: string;
  state?: string;
  is_provisional?: boolean;
  can_continue_fit?: boolean;
  continue_explanation?: string;
  restart_file_path?: string;
  provenance?: any;
  outcome?: any;
  warnings?: Array<{ code: string; message: string; path?: string }>;
  fit_mode: string;
  residue_mapping?: Record<string, string>;
}

interface CestExperiment {
  b1: string;
  b1_actual: number;
  b0: number;
  carrier: number;
  offsets: number[];
  intensities: number[];
  uncertainties: number[];
  filepath: string;
  error?: string;
}

interface CestProfile {
  residue: string;
  full_residue?: string;
  experiments: CestExperiment[];
}

interface CestPick {
  cs_a: number | null;
  cs_b: number | null;
  cs_c: number | null;
  cs_d: number | null;
  cs_e: number | null;
  cs_f: number | null;
}

interface CestAnalysisManagerProps {
  analysis: Analysis;
  projectUuid: string;
  availableSpectra: Spectrum[];
  allAnalyses: Analysis[];
  onStatusChange?: (status: string) => void;
  onDelete?: () => void;
  onClose?: () => void;
}

// ── Helpers ─────────────────────────────────────────────────────────────
const DEFAULT_METHOD_TOML = `[STEP1]
FIT = ["PB", "KEX_AB", "DW_AB", "CS_A"]
CONSTRAINTS = ["[PB] < 0.5"]
`;

const STATUS_COLORS: Record<string, string> = {
  PENDING: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800',
  RUNNING: 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800',
  CANCELLING: 'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700',
  CANCELLED: 'bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700',
  COMPLETED: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800',
  FAILED: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800',
};

// ── Component ───────────────────────────────────────────────────────────
const CestAnalysisManager: React.FC<CestAnalysisManagerProps> = ({
  analysis, projectUuid, availableSpectra: _availableSpectra, allAnalyses,
  onStatusChange, onDelete: _onDelete, onClose: _onClose,
}) => {
  const { theme } = useTheme();
  const isDarkTheme = theme === 'dark';
  const nmrSpectraIcon = isDarkTheme ? nmrSpectraDark : nmrSpectraLight;
  const atomSpinIcon = isDarkTheme ? atomSpinDark : atomSpinLight;
  const peakFittingIcon = isDarkTheme ? peakFittingDark : peakFittingLight;
  const fitParametersIcon = isDarkTheme ? fitParametersDark : fitParametersLight;
  const terminalLogsIcon = isDarkTheme ? terminalLogsDark : terminalLogsLight;

  type TabKey = 'experiments' | 'pick_cest' | 'parameters' | 'methods' | 'logs' | 'results';
  const [activeTab, setActiveTab] = useState<TabKey>(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('tab')) return params.get('tab') as TabKey;
    if (analysis.status === 'COMPLETED' || params.get('step')) return 'results';
    return 'experiments';
  });
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => localStorage.getItem('resoFlow_sidebar_collapsed') === 'true');
  const [status, setStatus] = useState(analysis.status);
  const [isRunning, setIsRunning] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [hasBackup, setHasBackup] = useState(false);

  // ── Experiment Tab State ──
  const [selectedSpectrumIds, setSelectedSpectrumIds] = useState<number[]>([]);
  const [useHeight, setUseHeight] = useState(true);
  const [model, setModel] = useState('2st');
  const [fitMode, setFitMode] = useState<'global' | 'individual'>('global');
  const [r1AnalysisUuid, setR1AnalysisUuid] = useState('');
  const [r2AnalysisUuid, setR2AnalysisUuid] = useState('');
  const [generatedExperiments, setGeneratedExperiments] = useState<any[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);

  // ── CEST Module & Multi-Nucleus Configuration State ──
  const [selectedModule, setSelectedModule] = useState<string>('cest_15n');
  const [moduleExtraValues, setModuleExtraValues] = useState<Record<string, any>>({
    carrier_dec: 8.5,
    b1_frq_dec: 2000.0,
    d1: 1.0,
    taua: 0.002,
  });
  const [moduleFlags, setModuleFlags] = useState<Record<string, boolean>>({
    antitrosy: false,
    eta_block: false,
  });
  const [b1Distribution, setB1Distribution] = useState<B1DistributionConfig>({
    type: 'dephasing',
  });
  const [filterOffsets, setFilterOffsets] = useState<Array<[number, number]>>([[0.0, 25.0]]);
  const [filterPlanes, setFilterPlanes] = useState<number[]>([]);
  const [dataError, setDataError] = useState<'file' | 'scatter'>('scatter');

  // ── Pick CEST State ──
  const [profiles, setProfiles] = useState<CestProfile[]>([]);
  const [currentProfileIdx, setCurrentProfileIdx] = useState(0);
  const [picks, setPicks] = useState<Record<string, CestPick>>({});
  type PickMode = 'cs_a' | 'cs_b' | 'cs_c' | 'cs_d' | 'cs_e' | 'cs_f';
  const [pickMode, setPickMode] = useState<PickMode>('cs_a');

  // ── Parameter Tab State (Structured Single Source of Truth) ──
  const [parameterConfig, setParameterConfig] = useState<ParameterConfig>(createDefaultParameterConfig);
  const [isRawParamEditMode, setIsRawParamEditMode] = useState(false);
  const [rawParamToml, setRawParamToml] = useState('');
  const [unparsedParamTomlLines, setUnparsedParamTomlLines] = useState<string[]>([]);
  const [showResyncModal, setShowResyncModal] = useState(false);
  const [showParamImportModal, setShowParamImportModal] = useState(false);
  const [showParamGeneratedPreview, setShowParamGeneratedPreview] = useState(false);
  const [showSourcePickerModal, setShowSourcePickerModal] = useState(false);
  const [showInheritModal, setShowInheritModal] = useState(false);
  const [selectedSourceRun, setSelectedSourceRun] = useState<SourceRunSummary | null>(null);

  // ── Methods Tab State ──
  const [methodConfig, setMethodConfig] = useState<MethodConfig>(createDefaultMethodConfig);
  const [activeStepIdx, setActiveStepIdx] = useState(0);
  const [methodToml, setMethodToml] = useState(DEFAULT_METHOD_TOML);
  const [availableParamsMeta, setAvailableParamsMeta] = useState<AvailableParamMeta[]>([]);
  const [unparsedTomlLines, setUnparsedTomlLines] = useState<string[]>([]);
  const [isRawEditMode, setIsRawEditMode] = useState(false);
  const [showGeneratedPreview, setShowGeneratedPreview] = useState(false);
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importTomlText, setImportTomlText] = useState('');
  const [lastRunConfigHash, setLastRunConfigHash] = useState<string>('');
  const [lastRunTimestamp, setLastRunTimestamp] = useState<string>('');

  // ── Results Tab State ──
  const [analysisResults, setAnalysisResults] = useState<AnalysisResult | null>(null);
  const [selectedStep, setSelectedStep] = useState<string>('');
  const [currentResultResidue, setCurrentResultResidue] = useState<string>('');
  const [fieldColors, setFieldColors] = useState<Record<string, string>>({});
  const [resultsSortColumn, setResultsSortColumn] = useState<'res' | 'dw' | 'redchi' | 'r2'>('res');
  const [resultsSortDirection, setResultsSortDirection] = useState<'asc' | 'desc'>('asc');
  const [resultsSearchQuery, setResultsSearchQuery] = useState<string>('');
  const [resultsViewMode, setResultsViewMode] = useState<'single' | 'grid'>('single');
  const [showStepStats, setShowStepStats] = useState<boolean>(false);
  const [showProvenance, setShowProvenance] = useState<boolean>(false);

  // ── Logs State ──
  const [logs, setLogs] = useState('');
  const logRef = useRef<HTMLPreElement>(null);

  // ── Preview File State ──
  const [previewFile, setPreviewFile] = useState<{ name: string; content: string } | null>(null);

  // ── Fetch Method Parameters Metadata from Backend ──
  useEffect(() => {
    const fetchParams = async () => {
      try {
        const res = await api.get(`/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/cest/method-parameters`, {
          params: { model },
        });
        if (res.data?.parameters) {
          setAvailableParamsMeta(res.data.parameters);
        }
      } catch (err) {
        console.warn('Failed to fetch method parameters from backend', err);
      }
    };
    fetchParams();
  }, [model, projectUuid, analysis.analysis_uuid]);

  // Convert profiles to selectable ResidueItem list (excluding residues marked as excluded in Pick CEST or Parameters)
  const residueItems: ResidueItem[] = useMemo(() => {
    return profiles
      .filter(p => !isResidueExcluded(parameterConfig, p.residue, profiles))
      .map(p => {
        const num = parseInt(p.residue.replace(/\D/g, ''), 10) || 0;
        const hasExp = p.experiments && p.experiments.length > 0 && !p.experiments[0].error;
        return {
          id: p.residue,
          number: num,
          label: p.full_residue || p.residue,
          hasData: !!hasExp,
        };
      });
  }, [profiles, parameterConfig]);

  // Automatically prune excluded residues from Method step selections when exclusions change
  useEffect(() => {
    if (!parameterConfig.excludedResidues || parameterConfig.excludedResidues.length === 0) return;

    setMethodConfig(prevConfig => {
      let changed = false;
      const nextSteps = prevConfig.steps.map(step => {
        if (!step.residues || step.residues.length === 0) return step;
        const filteredRes = step.residues.filter(
          resId => !isResidueExcluded(parameterConfig, resId, profiles)
        );
        if (filteredRes.length !== step.residues.length) {
          changed = true;
          return { ...step, residues: filteredRes };
        }
        return step;
      });

      if (!changed) return prevConfig;
      const nextConfig = { ...prevConfig, steps: nextSteps };
      setMethodToml(configToToml(nextConfig));
      return nextConfig;
    });
  }, [parameterConfig.excludedResidues, profiles]);

  // Automatically update generatedExperiments to comment/uncomment excluded residues in [data.profiles]
  useEffect(() => {
    setGeneratedExperiments(prevExps => {
      if (!prevExps || prevExps.length === 0) return prevExps;
      let changed = false;
      const nextExps = prevExps.map(exp => {
        if (!exp || !exp.toml_content) return exp;
        const nextToml = applyExclusionsToExperimentToml(exp.toml_content, parameterConfig, profiles);
        if (nextToml !== exp.toml_content) {
          changed = true;
          return { ...exp, toml_content: nextToml };
        }
        return exp;
      });
      return changed ? nextExps : prevExps;
    });
  }, [parameterConfig.excludedResidues, profiles]);

  const activeStep = methodConfig.steps[activeStepIdx] || methodConfig.steps[0] || createDefaultStep();

  // Effective parameter TOML
  const effectiveParameterToml = useMemo(() => {
    return isRawParamEditMode ? rawParamToml : paramConfigToToml(parameterConfig);
  }, [isRawParamEditMode, rawParamToml, parameterConfig]);

  // Stale pick count detection across all residues
  const staleParamCount = useMemo(() => {
    let count = 0;
    for (const [res, rParams] of Object.entries(parameterConfig.residues || {})) {
      const pk = picks[res];
      const currentHash = computePickHash(pk);
      let resStale = false;
      if (rParams?.cs_a?.source.kind === 'pick') {
        const stored = (rParams.cs_a.source as any).pickSetHash;
        if (stored && stored !== currentHash) resStale = true;
      }
      if (rParams?.dw_ab?.source.kind === 'pick') {
        const stored = (rParams.dw_ab.source as any).pickSetHash;
        if (stored && stored !== currentHash) resStale = true;
      }
      if (resStale) count++;
    }
    return count;
  }, [parameterConfig.residues, picks]);

  // Extract starting values from parameterConfig.globals for Methods tab
  const startingValues = useMemo<Record<string, number | string>>(() => {
    const pbVal = parameterConfig.globals.pb?.value ?? 0.05;
    const kexVal = parameterConfig.globals.kex_ab?.value ?? 500.0;
    const taucVal = parameterConfig.globals.tauc_a?.value ?? 4.0;
    return {
      pb: pbVal,
      kex_ab: kexVal,
      tauc_a: taucVal,
      PB: pbVal,
      KEX_AB: kexVal,
      TAUC_A: taucVal,
    };
  }, [parameterConfig.globals]);

  // Validation
  const knownParamNames = useMemo(() => {
    return availableParamsMeta.length > 0 ? availableParamsMeta.map(p => p.name) : ['PB', 'KEX_AB', 'DW_AB', 'CS_A', 'R1_A', 'R2_A', 'R1_B', 'R2_B', 'TAUC_A'];
  }, [availableParamsMeta]);

  const validationErrors = useMemo(() => {
    return validateMethodConfig(methodConfig, knownParamNames, residueItems.filter(r => r.hasData).length);
  }, [methodConfig, knownParamNames, residueItems]);

  const blockingErrors = useMemo(() => {
    return validationErrors.filter(e => e.severity === 'error');
  }, [validationErrors]);

  const nucleusInfo = useMemo(() => getNucleusInfoForModule(selectedModule), [selectedModule]);

  const paramValidationIssues = useMemo<ParameterIssue[]>(() => {
    return validateParameterConfig(parameterConfig, {
      availableResidues: profiles.map(p => p.residue),
      methodConfig,
      selectedModule,
    });
  }, [parameterConfig, profiles, methodConfig, selectedModule]);

  // Run honesty hash
  const currentConfigHash = useMemo(() => {
    const currentMethodToml = isRawEditMode ? methodToml : configToToml(methodConfig);
    return JSON.stringify({
      method: currentMethodToml.trim(),
      params: effectiveParameterToml.trim(),
      model,
      fitMode,
    });
  }, [isRawEditMode, methodToml, methodConfig, effectiveParameterToml, model, fitMode]);

  const isConfigChangedSinceRun = status === 'COMPLETED' && !!lastRunConfigHash && currentConfigHash !== lastRunConfigHash;

  // Provenance and Lineage tracking
  const lineageInfo = useMemo(() => {
    if (parameterConfig.inheritedFrom) {
      return parameterConfig.inheritedFrom;
    }
    // Check globals
    for (const gVal of Object.values(parameterConfig.globals || {})) {
      if (gVal?.source?.kind === 'inherited') {
        return {
          sourceRunId: gVal.source.sourceRunId,
          sourceRunLabel: gVal.source.sourceRunLabel,
          at: gVal.source.at,
        };
      }
    }
    // Check residues
    for (const rParams of Object.values(parameterConfig.residues || {})) {
      for (const pVal of Object.values(rParams || {})) {
        if (pVal?.source?.kind === 'inherited') {
          return {
            sourceRunId: pVal.source.sourceRunId,
            sourceRunLabel: pVal.source.sourceRunLabel,
            at: pVal.source.at,
          };
        }
      }
    }
    return null;
  }, [parameterConfig]);

  const sourceRunStillExists = useMemo(() => {
    if (!lineageInfo) return false;
    return (allAnalyses || []).some(a => a.analysis_uuid === lineageInfo.sourceRunId);
  }, [lineageInfo, allAnalyses]);

  const handleSelectSourceRun = (source: SourceRunSummary) => {
    setSelectedSourceRun(source);
    setShowSourcePickerModal(false);
    setShowInheritModal(true);
  };

  const handleApplyInheritedParameters = (
    updatedParamConfig: ParameterConfig,
    updatedMethodConfig?: MethodConfig,
    updatedPicks?: Record<string, any>
  ) => {
    setParameterConfig(updatedParamConfig);
    setRawParamToml(paramConfigToToml(updatedParamConfig));
    if (updatedMethodConfig) {
      setMethodConfig(updatedMethodConfig);
      setMethodToml(configToToml(updatedMethodConfig));
    }
    if (updatedPicks) {
      setPicks(updatedPicks);
    }
    setSuccessMsg(`Inherited parameters and CEST picks applied from "${selectedSourceRun?.name || 'source run'}"`);
    setTimeout(() => setSuccessMsg(''), 4000);
  };

  const loadProfilesQuietly = async () => {
    try {
      const res = await api.get(`/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/cest/profiles`);
      const nextProfiles = res.data.profiles || [];
      if (nextProfiles.length > 0) {
        setProfiles(nextProfiles);
        setParameterConfig(prev => canonicalizeParameterConfig(prev, nextProfiles));
      }
    } catch { /* ignore */ }
  };

  // ── Load saved config on mount ──
  useEffect(() => {
    loadSavedConfig();
    loadProfilesQuietly();
    loadResults();
  }, [analysis.analysis_uuid]);

  // ── Poll logs while running ──
  useEffect(() => {
    if (status !== 'RUNNING' && status !== 'PENDING') return;
    const interval = setInterval(async () => {
      try {
        const res = await api.get(`/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/cest/logs`);
        setLogs(res.data.logs || '');
        if (res.data.status !== status) {
          setStatus(res.data.status);
          onStatusChange?.(res.data.status);
          if (res.data.status === 'COMPLETED' || res.data.status === 'FAILED') {
            setIsRunning(false);
            loadResults();
          }
        }
      } catch { /* ignore */ }
    }, 3000);
    return () => clearInterval(interval);
  }, [status]);

  // Auto-scroll logs
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const loadSavedConfig = async () => {
    try {
      const res = await api.get(`/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/cest/config`);
      if (res.data.config) {
        const c = res.data.config;
        if (c.model) setModel(c.model);
        if (c.fit_mode) setFitMode(c.fit_mode);
        if (c.picks) setPicks(c.picks);
        if (c.spectrum_ids) setSelectedSpectrumIds(c.spectrum_ids);
        if (c.generatedExperiments) setGeneratedExperiments(c.generatedExperiments);
        if (c.last_run_hash) setLastRunConfigHash(c.last_run_hash);
        if (c.last_run_timestamp) setLastRunTimestamp(c.last_run_timestamp);
        if (c.selected_module) setSelectedModule(c.selected_module);
        if (c.module_extra_values) setModuleExtraValues(c.module_extra_values);
        if (c.module_flags) setModuleFlags(c.module_flags);
        if (c.b1_distribution) setB1Distribution(c.b1_distribution);
        if (c.filter_offsets) setFilterOffsets(c.filter_offsets);
        if (c.filter_planes) setFilterPlanes(c.filter_planes);
        if (c.data_error) setDataError(c.data_error);
        setHasBackup(res.data.has_backup || false);

        // Handle Parameter configuration
        if (c.parameter_config && c.parameter_config.globals) {
          const canon = canonicalizeParameterConfig(c.parameter_config, profiles);
          setParameterConfig(canon);
          setRawParamToml(paramConfigToToml(canon));
          setIsRawParamEditMode(!!c.parameter_config.rawOverride);
        } else if (c.parameter_toml) {
          setRawParamToml(c.parameter_toml);
          const parsed = paramTomlToConfig(c.parameter_toml);
          const canon = canonicalizeParameterConfig(parsed.config, profiles);
          setParameterConfig(canon);
          setUnparsedParamTomlLines(parsed.unparsed);
        }

        // Handle Method configuration
        if (c.method_config && Array.isArray(c.method_config.steps) && c.method_config.steps.length > 0) {
          setMethodConfig(c.method_config);
          setMethodToml(configToToml(c.method_config));
          setIsRawEditMode(!!c.method_config.rawOverride);
        } else if (c.method_toml) {
          setMethodToml(c.method_toml);
          const parsed = tomlToConfig(c.method_toml);
          setMethodConfig(parsed.config);
          setUnparsedTomlLines(parsed.unparsed);
        }
      }
    } catch { /* no saved config */ }
  };

  useEffect(() => {
    if (analysisResults?.residues) {
      const uniqueLabels = new Set<string>();
      Object.values(analysisResults.residues).forEach(res => {
        res.experiments?.forEach(exp => uniqueLabels.add(exp.b1_label));
      });
      
      const newColors: Record<string, string> = { ...fieldColors };
      const colorPalette = [PLOT_COLORS.primary, '#9333ea', '#0ea5e9', '#f43f5e', '#10b981', '#f59e0b', '#64748b'];
      
      let updated = false;
      Array.from(uniqueLabels).forEach((label, idx) => {
        if (!newColors[label]) {
          newColors[label] = colorPalette[idx % colorPalette.length];
          updated = true;
        }
      });
      if (updated) setFieldColors(newColors);
    }
  }, [analysisResults]);

  const loadResults = async () => {
    try {
      const res = await api.get(`/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/results`);
      const results = res.data.results as AnalysisResult;
      setAnalysisResults(results);

      // Determine initial step (§3.13: default to last step)
      const urlStep = new URLSearchParams(window.location.search).get('step');
      let initialStep = '';
      if (urlStep && results.step_order && results.step_order.includes(urlStep)) {
        initialStep = urlStep;
      } else if (results.step_order && results.step_order.length > 0) {
        initialStep = results.step_order[results.step_order.length - 1];
      }
      setSelectedStep(initialStep);

      const targetStepObj = initialStep && results.steps ? results.steps[initialStep] : null;
      const effectiveRes = targetStepObj?.residues || results.residues;
      if (effectiveRes && Object.keys(effectiveRes).length > 0) {
        setCurrentResultResidue(prev => prev && effectiveRes[prev] ? prev : Object.keys(effectiveRes)[0]);
      }
      loadProfilesQuietly();
    } catch { /* likely no results yet */ } finally {
      // Done
    }
  };

  const handleStepSelect = (stepName: string) => {
    setSelectedStep(stepName);
    const url = new URL(window.location.href);
    if (stepName) {
      url.searchParams.set('step', stepName);
    } else {
      url.searchParams.delete('step');
    }
    window.history.replaceState(null, '', url.toString());

    const targetStepObj = analysisResults?.steps?.[stepName];
    const effectiveRes = targetStepObj?.residues || analysisResults?.residues;
    if (effectiveRes && Object.keys(effectiveRes).length > 0) {
      if (!currentResultResidue || !effectiveRes[currentResultResidue]) {
        setCurrentResultResidue(Object.keys(effectiveRes)[0]);
      }
    }
  };

  useEffect(() => {
    if (status === 'COMPLETED' || status === 'FAILED') {
      loadResults();
    }
  }, [status]);

  const saveConfig = async () => {
    try {
      const effectiveMethodToml = isRawEditMode ? methodToml : configToToml(methodConfig);
      await api.put(`/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/cest/config`, {
        parameter_toml: effectiveParameterToml,
        parameter_config: isRawParamEditMode ? { ...parameterConfig, rawOverride: rawParamToml } : parameterConfig,
        method_toml: effectiveMethodToml,
        method_config: isRawEditMode ? { ...methodConfig, rawOverride: methodToml } : methodConfig,
        model,
        fit_mode: fitMode,
        picks,
        spectrum_ids: selectedSpectrumIds,
        generatedExperiments,
        last_run_hash: lastRunConfigHash,
        last_run_timestamp: lastRunTimestamp,
        selected_module: selectedModule,
        module_extra_values: moduleExtraValues,
        module_flags: moduleFlags,
        b1_distribution: b1Distribution,
        filter_offsets: filterOffsets,
        filter_planes: filterPlanes,
        data_error: dataError,
      });
      setSuccessMsg('Configuration saved');
      setTimeout(() => setSuccessMsg(''), 3000);
    } catch (e: any) {
      setError(e.response?.data?.detail || 'Failed to save configuration');
    }
  };

  const handleToggleExcludeResidue = (resKey: string) => {
    const updated = toggleExcludeResidue(parameterConfig, resKey, profiles);
    setParameterConfig(updated);
  };

  const loadProfiles = async () => {
    await saveConfig();
    try {
      const res = await api.get(`/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/cest/profiles`);
      const nextProfiles = res.data.profiles || [];
      setProfiles(nextProfiles);
      setCurrentProfileIdx(0);
      setParameterConfig(prev => canonicalizeParameterConfig(prev, nextProfiles));
    } catch (e: any) {
      setError(e.response?.data?.detail || 'Failed to load profiles');
    }
  };

  const handleGenerate = async () => {
    if (selectedSpectrumIds.length === 0) {
      setError('Please select at least one CEST spectrum');
      return;
    }
    try {
      setIsGenerating(true);
      setError('');
      const res = await api.post(`/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/cest/generate`, {
        spectrum_ids: selectedSpectrumIds,
        use_height: useHeight,
        excluded_residues: parameterConfig.excludedResidues || [],
        selected_module: selectedModule,
        b1_distribution: b1Distribution,
        filter_offsets: filterOffsets,
        filter_planes: filterPlanes,
        data_error: dataError,
        ...moduleExtraValues,
        ...moduleFlags,
      });
      setGeneratedExperiments(res.data.experiments || []);
      setSuccessMsg(`Generated ${res.data.total_data_files} data files and ${res.data.experiments?.length || 0} experiment TOMLs`);
      setTimeout(() => setSuccessMsg(''), 5000);
    } catch (e: any) {
      setError(e.response?.data?.detail || 'Failed to generate CEST files');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleStepChange = (updatedStep: Step) => {
    const nextSteps = [...methodConfig.steps];
    nextSteps[activeStepIdx] = updatedStep;
    const nextConfig = {
      ...methodConfig,
      steps: nextSteps,
    };
    setMethodConfig(nextConfig);
    setMethodToml(configToToml(nextConfig));
  };

  const handleAddStep = () => {
    const newStepNum = methodConfig.steps.length + 1;
    const newStep = createDefaultStep(`STEP${newStepNum}`);
    const nextConfig = {
      ...methodConfig,
      steps: [...methodConfig.steps, newStep],
    };
    setMethodConfig(nextConfig);
    setActiveStepIdx(nextConfig.steps.length - 1);
    setMethodToml(configToToml(nextConfig));
  };

  const handleDuplicateStep = (idx: number) => {
    const src = methodConfig.steps[idx];
    if (!src) return;
    const dup: Step = {
      ...JSON.parse(JSON.stringify(src)),
      id: `step_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name: `${src.name}_COPY`,
    };
    const nextSteps = [...methodConfig.steps];
    nextSteps.splice(idx + 1, 0, dup);
    const nextConfig = { ...methodConfig, steps: nextSteps };
    setMethodConfig(nextConfig);
    setActiveStepIdx(idx + 1);
    setMethodToml(configToToml(nextConfig));
  };

  const handleDeleteStep = (idx: number) => {
    if (methodConfig.steps.length <= 1) return;
    const nextSteps = methodConfig.steps.filter((_, i) => i !== idx);
    const nextConfig = { ...methodConfig, steps: nextSteps };
    setMethodConfig(nextConfig);
    setActiveStepIdx(Math.max(0, Math.min(activeStepIdx, nextSteps.length - 1)));
    setMethodToml(configToToml(nextConfig));
  };

  const handleRenameStep = (idx: number, newName: string) => {
    const nextSteps = [...methodConfig.steps];
    if (nextSteps[idx]) {
      nextSteps[idx] = { ...nextSteps[idx], name: newName };
      const nextConfig = { ...methodConfig, steps: nextSteps };
      setMethodConfig(nextConfig);
      setMethodToml(configToToml(nextConfig));
    }
  };

  const handleReorderSteps = (startIdx: number, endIdx: number) => {
    const nextSteps = [...methodConfig.steps];
    const [moved] = nextSteps.splice(startIdx, 1);
    nextSteps.splice(endIdx, 0, moved);
    const nextConfig = { ...methodConfig, steps: nextSteps };
    setMethodConfig(nextConfig);
    setActiveStepIdx(endIdx);
    setMethodToml(configToToml(nextConfig));
  };

  const handleApplyTemplate = (template: MethodTemplate) => {
    const cloned: MethodConfig = JSON.parse(JSON.stringify(template.config));
    setMethodConfig(cloned);
    setActiveStepIdx(0);
    setMethodToml(configToToml(cloned));
    setIsRawEditMode(false);
    setShowTemplateModal(false);
    setSuccessMsg(`Applied template: ${template.name}`);
    setTimeout(() => setSuccessMsg(''), 3000);
  };

  const handleImportToml = () => {
    if (!importTomlText.trim()) return;
    const result = tomlToConfig(importTomlText);
    setMethodConfig(result.config);
    setActiveStepIdx(0);
    setMethodToml(importTomlText);
    setUnparsedTomlLines(result.unparsed);
    setIsRawEditMode(false);
    setShowImportModal(false);
    setImportTomlText('');
    setSuccessMsg('Imported method.toml successfully');
    setTimeout(() => setSuccessMsg(''), 3000);
  };

  const handleRun = async () => {
    if (blockingErrors.length > 0) {
      setError(`Cannot run ChemEx: ${blockingErrors[0].message}`);
      return;
    }
    try {
      if (status === 'COMPLETED') {
        if (!window.confirm("Rerunning this analysis will overwrite your current results. A backup of the current results will be created. Proceed?")) {
          return;
        }
      }
      setIsRunning(true);
      setError('');
      setStatus('PENDING');
      onStatusChange?.('PENDING');
      setActiveTab('logs');
      const effectiveMethodToml = isRawEditMode ? methodToml : configToToml(methodConfig);
      const runHash = currentConfigHash;
      const runTime = new Date().toLocaleString();
      setLastRunConfigHash(runHash);
      setLastRunTimestamp(runTime);

      await api.post(`/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/cest/run`, {
        parameter_toml: effectiveParameterToml,
        parameter_config: isRawParamEditMode ? { ...parameterConfig, rawOverride: rawParamToml } : parameterConfig,
        method_toml: effectiveMethodToml,
        method_config: isRawEditMode ? { ...methodConfig, rawOverride: methodToml } : methodConfig,
        model,
        fit_mode: fitMode,
        last_run_hash: runHash,
        last_run_timestamp: runTime,
      });
      loadSavedConfig();
    } catch (e: any) {
      setError(e.response?.data?.detail || 'Failed to start ChemEx');
      setIsRunning(false);
      setStatus('FAILED');
    }
  };

  const handleUseFittedAsStarting = () => {
    if (!analysisResults) return;
    let updated = false;
    const now = new Date().toISOString();
    const nextConfig: ParameterConfig = {
      ...parameterConfig,
      globals: { ...parameterConfig.globals },
      residues: { ...parameterConfig.residues },
    };

    if (analysisResults.global?.pb !== undefined) {
      nextConfig.globals.pb = {
        value: parseFloat(analysisResults.global.pb.toFixed(4)),
        source: { kind: 'manual', at: now },
      };
      updated = true;
    }
    if (analysisResults.global?.kex_ab !== undefined) {
      nextConfig.globals.kex_ab = {
        value: parseFloat(analysisResults.global.kex_ab.toFixed(2)),
        source: { kind: 'manual', at: now },
      };
      updated = true;
    }

    if (analysisResults.residues) {
      for (const [res, rData] of Object.entries(analysisResults.residues)) {
        const p = rData.parameters;
        if (p && (p.cs_a !== undefined || p.cs_b !== undefined || p.dw_ab !== undefined)) {
          const existing = nextConfig.residues[res] || {};
          const cs_a = p.cs_a !== undefined ? parseFloat(p.cs_a.toFixed(3)) : existing.cs_a?.value;
          const dw_ab = p.dw_ab !== undefined
            ? parseFloat(p.dw_ab.toFixed(3))
            : (p.cs_b !== undefined && cs_a !== undefined ? parseFloat((p.cs_b - cs_a).toFixed(3)) : existing.dw_ab?.value);

          const updatedRes: ResidueParams = {
            ...existing,
            ...(cs_a !== undefined ? { cs_a: { value: cs_a, source: { kind: 'manual' as const, at: now } } } : {}),
            ...(dw_ab !== undefined ? { dw_ab: { value: dw_ab, source: { kind: 'manual' as const, at: now } } } : {}),
          };
          delete (updatedRes as Record<string, unknown>).cs_b;
          nextConfig.residues[res] = updatedRes;
          updated = true;
        }
      }
    }

    if (updated) {
      setParameterConfig(nextConfig);
      setSuccessMsg('Updated starting parameters with values from completed fit.');
      setTimeout(() => setSuccessMsg(''), 4000);
    }
  };

  const handleUseGridMinAsStarting = async () => {
    if (!analysisResults) return;
    try {
      const stepToUse = selectedStep || analysisResults.step_order?.[0] || 'STEP1';
      const res = await api.get(`/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/steps/${stepToUse}/grid`);
      const gridData = res.data;
      if (gridData && gridData.min_point && gridData.min_point.coordinates) {
        const coords = gridData.min_point.coordinates;
        const { nextConfig, updatedCount } = applyGridCoordinatesToConfig(parameterConfig, coords, currentResultResidue || undefined);
        if (updatedCount > 0) {
          setParameterConfig(nextConfig);
          setSuccessMsg(`Updated starting parameters with grid minimum (${updatedCount} parameters updated).`);
          setTimeout(() => setSuccessMsg(''), 5000);
        }
      } else {
        alert('No grid search minimum coordinates found for this step.');
      }
    } catch (err) {
      console.error('Failed to fetch grid minimum:', err);
      alert('Failed to load grid search minimum coordinates.');
    }
  };

  const handleRestore = async () => {
    if (!window.confirm("This will restore the last version of your results. Current results will become the new backup. Proceed?")) return;
    try {
      setIsRunning(true);
      setError('');
      await api.post(`/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/cest/restore`);
      setSuccessMsg("Results restored successfully!");
      loadSavedConfig();
      const res = await api.get(`/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/cest/logs`);
      setLogs(res.data.logs || '');
      setTimeout(() => setSuccessMsg(''), 3000);
    } catch (err: any) {
      setError(err.response?.data?.detail || "Restore failed");
    } finally {
      setIsRunning(false);
    }
  };

  const handleStop = async () => {
    if (isCancelling || status === 'CANCELLING') return;
    if (!window.confirm("Are you sure you want to stop the current fitting run? Any partial results will be lost.")) return;
    setIsCancelling(true);
    setStatus('CANCELLING');
    onStatusChange?.('CANCELLING');
    try {
      await api.post(`/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/cest/stop`);
      setSuccessMsg("Analysis cancelled successfully.");
      setStatus('CANCELLED');
      onStatusChange?.('CANCELLED');
      setIsRunning(false);
      setTimeout(() => setSuccessMsg(''), 3000);
    } catch (err: any) {
      setError(err.response?.data?.detail || "Failed to stop analysis");
      setStatus('FAILED');
      onStatusChange?.('FAILED');
      setIsRunning(false);
    } finally {
      setIsCancelling(false);
    }
  };

  const handlePreviewFile = async (path: string) => {
    if (!path) return;
    try {
      const fileName = path.split('/').pop() || 'file.toml';
      const matchingExp = generatedExperiments.find(
        e => e.path === path || e.filename === fileName
      );
      if (matchingExp && matchingExp.toml_content) {
        const upToDateToml = applyExclusionsToExperimentToml(
          matchingExp.toml_content,
          parameterConfig,
          profiles
        );
        setPreviewFile({
          name: fileName,
          content: upToDateToml,
        });
        return;
      }
      const res = await api.get(`/api/fs/read`, { params: { path } });
      const rawContent = res.data.content;
      const content = (fileName.endsWith('.toml') && rawContent.includes('[data.profiles]'))
        ? applyExclusionsToExperimentToml(rawContent, parameterConfig, profiles)
        : rawContent;
      setPreviewFile({
        name: fileName,
        content,
      });
    } catch (e: any) {
      const detail = e.response?.data?.detail;
      const msg = typeof detail === 'string' ? detail : 
                  Array.isArray(detail) ? detail.map((d: any) => d.msg || JSON.stringify(d)).join(', ') :
                  JSON.stringify(detail || e.message);
      setError(`Failed to read file: ${msg}`);
      console.error("Read error:", e);
    }
  };

  const handleProfileClick = (event: any) => {
    if (!profiles[currentProfileIdx]) return;
    const residue = profiles[currentProfileIdx].residue;
    let x: number | undefined = event.points?.[0]?.x;
    if (event.event && event.points?.[0]?.xaxis) {
      const xaxis = event.points[0].xaxis;
      const xPixel = event.event.layerX - (xaxis._offset || 0);
      const preciseX = xaxis.p2c(xPixel);
      if (preciseX !== undefined && !isNaN(preciseX)) x = preciseX;
    }
    if (x === undefined) return;
    setPicks(prevPicks => {
      const residuePicks = prevPicks[residue] || { 
        cs_a: null, cs_b: null, cs_c: null, cs_d: null, cs_e: null, cs_f: null 
      };
      return { ...prevPicks, [residue]: { ...residuePicks, [pickMode]: x } };
    });
    const stateMatch = model.match(/^(\d)st/);
    const numStates = stateMatch ? parseInt(stateMatch[1], 10) : 2;
    const modes: PickMode[] = ['cs_a', 'cs_b', 'cs_c', 'cs_d', 'cs_e', 'cs_f'];
    const currentModeIdx = modes.indexOf(pickMode);
    const nextModeIdx = (currentModeIdx + 1) % numStates;
    setPickMode(modes[nextModeIdx]);
  };

  const tabCls = (key: TabKey) =>
    `flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 whitespace-nowrap w-auto md:w-full ${
      isSidebarCollapsed ? 'md:justify-center' : 'md:justify-start'
    } ${
      activeTab === key
        ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400 font-semibold text-base scale-[1.03] shadow-sm border border-blue-100/50 dark:border-blue-900/50'
        : 'text-sm text-slate-600 hover:text-slate-900 hover:bg-slate-50 dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800/50'
    }`;
  const inputCls = 'w-full text-sm px-3 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-slate-800 dark:text-slate-200';
  const labelCls = 'block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1 uppercase tracking-wider';
  const sectionCls = 'bg-slate-50 dark:bg-slate-800/50 p-5 rounded-xl border border-slate-200 dark:border-slate-700';
  const btnPrimary = 'px-4 py-2 bg-blue-600 hover:bg-blue-700 dark:bg-indigo-600 dark:hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-all shadow-sm disabled:opacity-50';
  const btnSecondary = 'px-4 py-2 bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 text-sm font-medium rounded-lg transition-all';

  const cestSpectra = _availableSpectra.filter(s => s.experiment_type === 'CEST' && s.is_fitted);
  const r1Analyses = (allAnalyses || []).filter(a => a.analysis_type === 'R1' && a.status === 'COMPLETED');
  const r2Analyses = (allAnalyses || []).filter(a => a.analysis_type === 'R2' && a.status === 'COMPLETED');
  const currentProfile = profiles[currentProfileIdx];
  const currentPick = currentProfile ? picks[currentProfile.residue] : null;

  const toggleSpectrumSelection = (id: number) => {
    setSelectedSpectrumIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className={`px-3 py-1 rounded-full text-xs font-bold border flex items-center gap-1.5 ${STATUS_COLORS[status] || ''}`}>
            {(status === 'RUNNING' || status === 'CANCELLING') && <Loader2 className="w-3 h-3 animate-spin" />}
            {status === 'COMPLETED' && <CheckCircle2 className="w-3 h-3 text-emerald-600" />}
            <span>{status}</span>
          </span>

          {staleParamCount > 0 && (
            <span
              onClick={() => setShowResyncModal(true)}
              className="px-2.5 py-1 rounded-full text-[10px] font-bold bg-amber-50 text-amber-800 border border-amber-300 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700 flex items-center gap-1 cursor-pointer hover:bg-amber-100 dark:hover:bg-amber-900/60 transition-colors shadow-2xs"
              title={`${staleParamCount} residue(s) have modified picks since parameters were synced. Click to review differences.`}
            >
              <AlertTriangle className="w-3 h-3 text-amber-500 animate-pulse" />
              <span>{staleParamCount} Pick{staleParamCount > 1 ? 's' : ''} moved</span>
            </span>
          )}

          {isConfigChangedSinceRun && (
            <span
              className="px-2.5 py-1 rounded-full text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-300 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-700 flex items-center gap-1"
              title="The configuration currently on screen differs from the one that produced the completed results below."
            >
              <AlertTriangle className="w-3 h-3 text-amber-500" />
              <span>Config changed since last run</span>
            </span>
          )}

          {lineageInfo && (
            <span className="px-2.5 py-1 rounded-full text-[10px] font-semibold bg-indigo-50 text-indigo-800 border border-indigo-200 dark:bg-indigo-950/40 dark:text-indigo-300 dark:border-indigo-800 flex items-center gap-1.5 shadow-2xs">
              <GitFork className="w-3 h-3 text-indigo-600 dark:text-indigo-400" />
              <span>Seeded from </span>
              {sourceRunStillExists ? (
                <a
                  href={`/project/${projectUuid}/analysis/${lineageInfo.sourceRunId}`}
                  className="font-bold underline hover:text-indigo-600 dark:hover:text-indigo-200"
                  title={`View source run (${lineageInfo.sourceRunId})`}
                >
                  {lineageInfo.sourceRunLabel}
                </a>
              ) : (
                <span className="font-bold" title={`Source run ID: ${lineageInfo.sourceRunId} (deleted)`}>
                  {lineageInfo.sourceRunLabel} <span className="text-[9px] opacity-70 font-normal">(deleted)</span>
                </span>
              )}
            </span>
          )}

          <span className={`px-2 py-0.5 rounded-full text-[10px] font-extrabold tracking-wider uppercase border ${
            fitMode === 'global' 
              ? 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-800'
              : 'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-900/20 dark:text-indigo-400 dark:border-indigo-800'
          }`}>
            {fitMode} Fit
          </span>

          {analysisResults?.global?.chi2_red !== undefined && (
            <span className="text-xs text-slate-500 dark:text-slate-400 font-mono">
              Red. χ²: <strong className="text-slate-800 dark:text-slate-200">{analysisResults.global.chi2_red.toFixed(2)}</strong>
            </span>
          )}

          {lastRunTimestamp && (
            <span className="text-[11px] text-slate-400 hidden xl:inline">
              • {lastRunTimestamp}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {(status === 'RUNNING' || status === 'PENDING' || status === 'CANCELLING') && (
            <button
              onClick={handleStop}
              disabled={isCancelling || status === 'CANCELLING'}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-red-50 hover:bg-red-100 text-red-700 text-xs font-bold rounded-lg border border-red-200 transition-all shadow-sm disabled:opacity-50"
            >
              <Square size={13} fill="currentColor" /> {isCancelling || status === 'CANCELLING' ? 'Cancelling...' : 'Stop Run'}
            </button>
          )}
          <div className="flex items-center bg-slate-100 dark:bg-slate-800 rounded-lg p-1 border border-slate-200 dark:border-slate-700">
            <button onClick={() => setFitMode('global')} className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-all ${fitMode === 'global' ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-400 shadow-sm border border-slate-200 dark:border-slate-600' : 'text-slate-500 hover:text-slate-700'}`}>Global</button>
            <button onClick={() => setFitMode('individual')} className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-all ${fitMode === 'individual' ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-400 shadow-sm border border-slate-200 dark:border-slate-600' : 'text-slate-500 hover:text-slate-700'}`}>Individual</button>
          </div>

          {status === 'COMPLETED' && analysisResults && (
            <button
              onClick={handleUseFittedAsStarting}
              className="flex items-center gap-1 px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 transition-all"
              title="Copy fitted parameters (pb, kex, chemical shifts) into the starting values of the Parameters tab"
            >
              <RefreshCw className="w-3 h-3 text-blue-500" />
              <span>Use fitted as starting</span>
            </button>
          )}

          {status === 'COMPLETED' && analysisResults && (
            <button
              onClick={handleUseGridMinAsStarting}
              className="flex items-center gap-1 px-2.5 py-1.5 bg-amber-50 hover:bg-amber-100 dark:bg-amber-950/40 dark:hover:bg-amber-900/40 text-amber-700 dark:text-amber-300 text-xs font-semibold rounded-lg border border-amber-200 dark:border-amber-800 transition-all"
              title="Copy grid search minimum coordinates into the starting values of the Parameters tab"
            >
              <Sparkles className="w-3 h-3 text-amber-500" />
              <span>Use grid minimum as starting</span>
            </button>
          )}

          {hasBackup && (
            <button
              onClick={handleRestore}
              disabled={isRunning}
              className="flex items-center gap-1 px-2.5 py-1.5 bg-amber-50 hover:bg-amber-100 text-amber-700 text-xs font-bold rounded-lg border border-amber-200 transition-all disabled:opacity-50"
              title="Restore previous run results from backup"
            >
              <RotateCcw size={13} />
              <span>Restore Last fit</span>
            </button>
          )}

          <button onClick={saveConfig} className={btnSecondary}>Save Config</button>

          <button
            onClick={handleRun}
            disabled={isRunning || !effectiveParameterToml || blockingErrors.length > 0}
            title={
              blockingErrors.length > 0
                ? `Cannot run: ${blockingErrors[0].message}`
                : !effectiveParameterToml
                ? 'Please configure parameters first'
                : 'Run ChemEx CEST fitting'
            }
            className={`${btnPrimary} flex items-center gap-1`}
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span>{isRunning ? 'Running...' : 'Run ChemEx'}</span>
          </button>
        </div>
      </div>

      {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm flex items-center gap-2"><AlertCircle className="w-4 h-4" /> {error}</div>}
      {successMsg && <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-emerald-700 text-sm flex items-center gap-2"><Check className="w-4 h-4" /> {successMsg}</div>}

      <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden shadow-sm flex flex-col md:flex-row min-h-[600px]">
        {/* Sidebar */}
        <div className={`${isSidebarCollapsed ? 'w-full md:w-20' : 'w-full md:w-64'} flex-shrink-0 border-b md:border-b-0 md:border-r border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-900/10 p-4 flex flex-row md:flex-col gap-2 overflow-x-auto md:overflow-x-visible transition-all duration-300`}>
          <button onClick={() => setActiveTab('experiments')} className={tabCls('experiments')} title="Experiments">
            <img src={nmrSpectraIcon} className="w-7 h-7 min-w-[28px] aspect-square object-cover rounded-lg flex-shrink-0 shadow-sm border border-slate-200 dark:border-slate-700" alt="" />
            <span className={isSidebarCollapsed ? 'md:hidden' : 'md:inline'}>Experiments</span>
          </button>
          <button onClick={() => { setActiveTab('pick_cest'); if (profiles.length === 0) loadProfiles(); }} className={tabCls('pick_cest')} title="Pick CEST">
            <img src={atomSpinIcon} className="w-7 h-7 min-w-[28px] aspect-square object-cover rounded-lg flex-shrink-0 shadow-sm border border-slate-200 dark:border-slate-700" alt="" />
            <span className={isSidebarCollapsed ? 'md:hidden' : 'md:inline'}>Pick CEST</span>
          </button>
          <button onClick={() => setActiveTab('parameters')} className={tabCls('parameters')} title="Parameters">
            <img src={fitParametersIcon} className="w-7 h-7 min-w-[28px] aspect-square object-cover rounded-lg flex-shrink-0 shadow-sm border border-slate-200 dark:border-slate-700" alt="" />
            <span className={isSidebarCollapsed ? 'md:hidden' : 'md:inline'}>Parameters</span>
          </button>
          <button onClick={() => setActiveTab('methods')} className={tabCls('methods')} title="Methods">
            <Workflow className="w-7 h-7 min-w-[28px] aspect-square flex-shrink-0 text-blue-500 dark:text-indigo-400" />
            <span className={isSidebarCollapsed ? 'md:hidden' : 'md:inline'}>Methods</span>
          </button>
          <button onClick={() => setActiveTab('logs')} className={tabCls('logs')} title="Logs">
            <img src={terminalLogsIcon} className="w-7 h-7 min-w-[28px] aspect-square object-cover rounded-lg flex-shrink-0 shadow-sm border border-slate-200 dark:border-slate-700" alt="" />
            <span className={isSidebarCollapsed ? 'md:hidden' : 'md:inline'}>Logs</span>
          </button>
          {(status === 'COMPLETED' || status === 'FAILED') && (
            <button onClick={() => setActiveTab('results')} className={tabCls('results')} title="Results">
              <img src={peakFittingIcon} className="w-7 h-7 min-w-[28px] aspect-square object-cover rounded-lg flex-shrink-0 shadow-sm border border-slate-200 dark:border-slate-700" alt="" />
              <span className={isSidebarCollapsed ? 'md:hidden' : 'md:inline'}>Results</span>
            </button>
          )}

          <div className="hidden md:flex flex-grow flex-col justify-end mt-4">
            <button
              onClick={() => {
                const newVal = !isSidebarCollapsed;
                setIsSidebarCollapsed(newVal);
                localStorage.setItem('resoFlow_sidebar_collapsed', String(newVal));
              }}
              className={`flex items-center px-4 py-3 text-sm font-medium text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-850 rounded-xl transition-all gap-3 ${isSidebarCollapsed ? 'justify-center' : 'justify-start'}`}
              title={isSidebarCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}
            >
              {isSidebarCollapsed ? <ChevronRight className="w-4 h-4 flex-shrink-0" /> : <ChevronLeft className="w-4 h-4 flex-shrink-0" />}
              <span className={isSidebarCollapsed ? 'hidden' : 'inline'}>Collapse Menu</span>
            </button>
          </div>
        </div>

        <div className="flex-1 p-6 overflow-x-hidden">
          {activeTab === 'experiments' && (
            <div className="space-y-6 animate-in fade-in">
              {/* Module Selection Card */}
              <ModuleSelectorCard
                selectedModule={selectedModule}
                onSelectModule={(mod) => setSelectedModule(mod)}
                extraValues={moduleExtraValues}
                onChangeExtraValue={(k, v) => setModuleExtraValues(prev => ({ ...prev, [k]: v }))}
                flags={moduleFlags}
                onToggleFlag={(flag, val) => setModuleFlags(prev => ({ ...prev, [flag]: val }))}
              />

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className={sectionCls}>
                  <h4 className="text-sm font-bold text-slate-800 dark:text-slate-200 mb-3">Select CEST Spectra</h4>
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {cestSpectra.map(s => (
                      <label key={s.id} className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all ${selectedSpectrumIds.includes(s.id) ? 'border-blue-400 bg-blue-50 dark:bg-blue-900/20' : 'border-slate-200 hover:border-slate-300'}`}>
                        <input type="checkbox" checked={selectedSpectrumIds.includes(s.id)} onChange={() => toggleSpectrumSelection(s.id)} className="w-4 h-4 accent-blue-600 rounded" />
                        <div className="flex-1 min-w-0">
                          <span className="text-sm font-medium text-slate-800 dark:text-slate-200 block truncate">{s.name}</span>
                          <div className="flex gap-3 text-[10px] text-slate-500 mt-0.5">
                            {s.b1 != null && <span>B1: {s.b1} Hz</span>}
                            {s.b0 != null && <span>B0: {s.b0} MHz</span>}
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
                <div className="space-y-4">
                  <div className={sectionCls}>
                    <h4 className="text-sm font-bold text-slate-800 dark:text-slate-200 mb-3">CEST Parameters</h4>
                    <div className="grid grid-cols-2 gap-3 mb-4">
                      <div><label className={labelCls}>Kinetic Model</label>
                        <select value={model} onChange={e => setModel(e.target.value)} className={inputCls}>
                          {KINETIC_MODELS.map(m => <option key={m} value={m}>{m}</option>)}
                        </select>
                      </div>
                      <div><label className={labelCls}>Intensity</label>
                        <select value={useHeight ? 'height' : 'amp'} onChange={e => setUseHeight(e.target.value === 'height')} className={inputCls}>
                          <option value="height">Height</option><option value="amp">Amplitude</option>
                        </select>
                      </div>
                    </div>
                    
                    <div className="space-y-3">
                      <div>
                        <label className={labelCls}>Inherit R1 from Analysis</label>
                        <select value={r1AnalysisUuid} onChange={e => setR1AnalysisUuid(e.target.value)} className={inputCls}>
                          <option value="">None (Fit R1)</option>
                          {r1Analyses.map(a => <option key={a.analysis_uuid} value={a.analysis_uuid}>{a.name}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className={labelCls}>Inherit R2 from Analysis</label>
                        <select value={r2AnalysisUuid} onChange={e => setR2AnalysisUuid(e.target.value)} className={inputCls}>
                          <option value="">None (Fit R2)</option>
                          {r2Analyses.map(a => <option key={a.analysis_uuid} value={a.analysis_uuid}>{a.name}</option>)}
                        </select>
                      </div>
                    </div>
                  </div>
                  <button onClick={handleGenerate} disabled={isGenerating || selectedSpectrumIds.length === 0} className={`w-full ${btnPrimary} flex items-center justify-center gap-2 mb-4`}>
                    {isGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Beaker className="w-4 h-4" />}
                    {isGenerating ? 'Generating...' : 'Generate Data Files'}
                  </button>

                  {generatedExperiments.length > 0 && (
                    <div className={sectionCls}>
                      <h4 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-3">Generated Experiments</h4>
                      <div className="space-y-2 max-h-48 overflow-y-auto">
                        {generatedExperiments.map((exp, i) => (
                          <div key={i} onClick={() => handlePreviewFile(exp.path)} className="flex items-center justify-between p-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-[10px] cursor-pointer hover:border-blue-500 hover:shadow-sm transition-all group">
                            <span className="font-mono text-slate-600 dark:text-slate-400 group-hover:text-blue-600 truncate mr-2">{exp.path?.split('/').pop() || 'Experiment'}</span>
                            <div className="flex gap-2 text-blue-600 dark:text-blue-400 font-bold shrink-0">
                              <span>B1: {exp.b1} Hz</span>
                              <span>Offsets: {exp.offsets?.length || 0}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Nested B1 Distribution Config & Filter Controls */}
              <div className="grid grid-cols-1 gap-6">
                <NestedConfigGroup
                  distribution={b1Distribution}
                  onChangeDistribution={(d) => setB1Distribution(d)}
                />
                <ProfileFilterControls
                  filterOffsets={filterOffsets}
                  onChangeFilterOffsets={(offsets) => setFilterOffsets(offsets)}
                  filterPlanes={filterPlanes}
                  onChangeFilterPlanes={(planes) => setFilterPlanes(planes)}
                  dataError={dataError}
                  onChangeDataError={(err) => setDataError(err)}
                />
              </div>
            </div>
          )}

          {activeTab === 'pick_cest' && (
            <div className="space-y-4 animate-in fade-in">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <button onClick={() => setCurrentProfileIdx(Math.max(0, currentProfileIdx - 1))} disabled={currentProfileIdx === 0} className={btnSecondary}><ChevronLeft className="w-4 h-4" /></button>
                  <select value={currentProfileIdx} onChange={e => setCurrentProfileIdx(Number(e.target.value))} className={`${inputCls} w-48`}>
                    {profiles.map((p, i) => {
                      const isEx = isResidueExcluded(parameterConfig, p.residue, profiles);
                      return (
                        <option key={i} value={i}>
                          {p.full_residue || p.residue} {isEx ? '(Excluded)' : (picks[p.residue]?.cs_a != null ? '✓' : '')}
                        </option>
                      );
                    })}
                  </select>
                  <button onClick={() => setCurrentProfileIdx(Math.min(profiles.length - 1, currentProfileIdx + 1))} disabled={currentProfileIdx >= profiles.length - 1} className={btnSecondary}><ChevronRight className="w-4 h-4" /></button>

                  {currentProfile && (
                    <button
                      type="button"
                      onClick={() => handleToggleExcludeResidue(currentProfile.residue)}
                      className={`px-3 py-1.5 rounded-lg border text-xs font-semibold flex items-center gap-1.5 transition-all ${
                        isResidueExcluded(parameterConfig, currentProfile.residue, profiles)
                          ? 'bg-rose-50 text-rose-700 border-rose-300 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-700 hover:bg-rose-100 dark:hover:bg-rose-900/50'
                          : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-600 hover:text-rose-600 dark:hover:text-rose-400 hover:border-rose-300'
                      }`}
                      title={
                        isResidueExcluded(parameterConfig, currentProfile.residue, profiles)
                          ? 'Include this residue in parameters (uncomment in parameters.toml)'
                          : 'Exclude this residue from parameters (comment out in parameters.toml)'
                      }
                    >
                      {isResidueExcluded(parameterConfig, currentProfile.residue, profiles) ? (
                        <PlusCircle className="w-3.5 h-3.5 text-emerald-500" />
                      ) : (
                        <MinusCircle className="w-3.5 h-3.5 text-rose-500" />
                      )}
                      <span>
                        {isResidueExcluded(parameterConfig, currentProfile.residue, profiles)
                          ? 'Excluded (Click to Include)'
                          : 'Exclude'}
                      </span>
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span className={`text-xs font-bold px-3 py-1 rounded-full border ${pickMode === 'cs_a' ? 'bg-blue-100 text-blue-700 border-blue-300' : 'bg-purple-100 text-purple-700 border-purple-300'}`}>Click to set: {pickMode.toUpperCase()}</span>
                  <button onClick={() => { if (currentProfileIdx < profiles.length - 1) { setCurrentProfileIdx(currentProfileIdx + 1); setPickMode('cs_a'); } }} className={btnPrimary}>Accept & Next</button>
                </div>
              </div>
              {currentProfile && (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                  <div className="lg:col-span-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl p-2">
                    {isResidueExcluded(parameterConfig, currentProfile.residue, profiles) && (
                      <div className="mb-2 px-3 py-1.5 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 rounded-lg text-xs text-rose-700 dark:text-rose-300 font-semibold flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <MinusCircle className="w-3.5 h-3.5 text-rose-500 shrink-0" />
                          <span>This residue is excluded and commented out in the ChemEx parameter file.</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleToggleExcludeResidue(currentProfile.residue)}
                          className="underline hover:text-rose-900 dark:hover:text-white cursor-pointer ml-2"
                        >
                          Include Residue
                        </button>
                      </div>
                    )}
                    <Plot
                      data={currentProfile.experiments.filter(e => !e.error).map((exp, idx) => {
                        const allPoints = exp.offsets.map((o, i) => ({
                          o,
                          i: exp.intensities[i],
                          err: exp.uncertainties ? exp.uncertainties[i] : 0,
                          planeIdx: i,
                        }));
                        const refPoint = allPoints.find(p => p.o < -10000);
                        const i0 = (refPoint && refPoint.i !== 0) ? refPoint.i : 1.0;
                        const points = allPoints.filter(p => p.o > -10000);
                        const toPpm = (hz: number) => hz / ((exp.b0 || 600.0) * nucleusInfo.xiRatio) + (exp.carrier || 0.0);
                        const color = idx === 0 ? PLOT_COLORS.primary : '#9333ea';
                        return {
                          x: points.map(p => toPpm(p.o)),
                          y: points.map(p => Math.max(0, p.i / i0)),
                          error_y: {
                            type: 'data',
                            array: points.map(p => Math.abs((p.err || 0) / i0)),
                            visible: true,
                            color: color,
                            thickness: 1.5,
                            width: 3.5,
                          },
                          type: 'scatter',
                          mode: 'lines+markers',
                          line: { shape: 'spline' },
                          marker: {
                            color: points.map(p => filterPlanes.includes(p.planeIdx) ? '#94a3b8' : color),
                            size: points.map(p => filterPlanes.includes(p.planeIdx) ? 6 : 8),
                            symbol: points.map(p => filterPlanes.includes(p.planeIdx) ? 'x' : 'circle'),
                            line: { width: 1.2, color: '#ffffff' },
                          },
                          name: `B1: ${exp.b1}Hz`,
                        };
                      })}
                      layout={{
                        xaxis: { title: `Shift (${nucleusInfo.unitLabel})`, autorange: 'reversed' },
                        yaxis: { title: 'I / I₀', autorange: true },
                        margin: { l: 60, r: 30, t: 40, b: 60 },
                        shapes: [
                          ...((['cs_a', 'cs_b', 'cs_c', 'cs_d', 'cs_e', 'cs_f'] as const).slice(0, parseInt(model || '2')).map((key, idx) => {
                            const val = currentPick?.[key];
                            return val != null ? { type: 'line', x0: val, x1: val, y0: 0, y1: 1, yref: 'paper', line: { color: [PLOT_COLORS.primary, '#ef4444', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6'][idx], width: 2, dash: 'dash' } } : null;
                          }).filter(Boolean) as any),
                        ]
                      }}
                      style={{ width: '100%', height: '400px' }}
                      onClick={handleProfileClick}
                    />
                  </div>
                  
                  <div className="lg:col-span-1 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden h-[416px] flex flex-col">
                    <div className="overflow-auto flex-1">
                      <table className="w-full text-xs text-left">
                        <thead className="sticky top-0 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 font-bold uppercase tracking-wider z-10">
                          <tr>
                            <th className="px-4 py-2">Residue</th>
                            <th className="px-4 py-2">CS_A ({nucleusInfo.unitLabel})</th>
                            <th className="px-4 py-2">CS_B ({nucleusInfo.unitLabel})</th>
                            {parseInt(model) >= 3 && <th className="px-4 py-2">CS_C</th>}
                            <th className="px-4 py-2 text-right">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                          {profiles.map((p, idx) => {
                            const pk = picks[p.residue];
                            const isEx = isResidueExcluded(parameterConfig, p.residue, profiles);
                            return (
                              <tr
                                key={p.residue}
                                onClick={() => setCurrentProfileIdx(idx)}
                                className={`cursor-pointer hover:bg-blue-50/50 dark:hover:bg-blue-900/10 ${
                                  isEx
                                    ? 'opacity-60 bg-slate-100/50 dark:bg-slate-900/50'
                                    : currentProfile.residue === p.residue
                                    ? 'bg-blue-50 dark:bg-blue-900/30'
                                    : ''
                                }`}
                              >
                                <td className="px-4 py-2 font-bold">
                                  <span className={isEx ? 'line-through text-slate-400 dark:text-slate-500' : ''}>
                                    {p.full_residue || p.residue}
                                  </span>
                                </td>
                                <td className="px-4 py-2">{pk?.cs_a?.toFixed(3) || '—'}</td>
                                <td className="px-4 py-2">{pk?.cs_b?.toFixed(3) || '—'}</td>
                                {parseInt(model) >= 3 && <td className="px-4 py-2">{pk?.cs_c?.toFixed(3) || '—'}</td>}
                                <td className="px-4 py-2 text-right">
                                  <div className="flex items-center justify-end gap-1.5" onClick={e => e.stopPropagation()}>
                                    {pk?.cs_a != null && !isEx && <Check size={14} className="text-emerald-500 inline" />}
                                    <button
                                      type="button"
                                      onClick={() => handleToggleExcludeResidue(p.residue)}
                                      className={`p-1 rounded transition-colors ${
                                        isEx
                                          ? 'text-rose-500 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/30'
                                          : 'text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30'
                                      }`}
                                      title={
                                        isEx
                                          ? 'Include this residue (uncomment in parameter file)'
                                          : 'Exclude this residue (comment out in parameter file)'
                                      }
                                    >
                                      {isEx ? (
                                        <PlusCircle className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                                      ) : (
                                        <MinusCircle className="w-3.5 h-3.5" />
                                      )}
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'parameters' && (
            <div className="space-y-6 animate-in fade-in">
              {/* Parameters Header & Quick Actions */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-2 border-b border-slate-100 dark:border-slate-800">
                <div>
                  <h3 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                    <Sliders className="w-5 h-5 text-blue-500" />
                    <span>ChemEx Parameters Configuration</span>
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Configure global kinetic settings, per-residue shifts & rates with full provenance and stale detection.
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowSourcePickerModal(true)}
                    className="px-3 py-1.5 bg-gradient-to-r from-indigo-500/10 to-purple-500/10 hover:from-indigo-500/20 hover:to-purple-500/20 text-indigo-600 dark:text-indigo-400 text-xs font-bold rounded-lg border border-indigo-200/70 dark:border-indigo-800/70 transition-all flex items-center gap-1.5 shadow-xs"
                    title="Seed starting parameters (kex_ab, pb, cs_a, dw_ab) from an earlier completed run"
                  >
                    <GitFork className="w-3.5 h-3.5" />
                    <span>Inherit from run</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setShowResyncModal(true)}
                    className={`px-3 py-1.5 text-xs font-bold rounded-lg border transition-all flex items-center gap-1.5 shadow-xs ${
                      staleParamCount > 0
                        ? 'bg-amber-500 hover:bg-amber-600 text-white border-amber-600 animate-pulse'
                        : 'bg-gradient-to-r from-blue-500/10 to-indigo-500/10 hover:from-blue-500/20 hover:to-indigo-500/20 text-blue-600 dark:text-blue-400 border-blue-200/60 dark:border-blue-800/60'
                    }`}
                    title="Non-destructively re-sync parameters from current CEST picks"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Re-sync from Picks</span>
                    {staleParamCount > 0 && (
                      <span className="ml-1 px-1.5 py-0.2 rounded-full bg-white text-amber-800 text-[10px] font-extrabold">
                        {staleParamCount}
                      </span>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => setShowParamImportModal(true)}
                    className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 text-xs font-bold rounded-lg border border-slate-200 dark:border-slate-700 transition-all flex items-center gap-1.5 shadow-xs"
                    title="Import parameters from raw TOML"
                  >
                    <Upload className="w-3.5 h-3.5" />
                    <span>Import TOML</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      if (!isRawParamEditMode) {
                        setRawParamToml(paramConfigToToml(parameterConfig));
                      }
                      setIsRawParamEditMode(!isRawParamEditMode);
                    }}
                    className={`px-3 py-1.5 text-xs font-bold rounded-lg border transition-all flex items-center gap-1.5 shadow-xs ${
                      isRawParamEditMode
                        ? 'bg-amber-500 text-white border-amber-600'
                        : 'bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700'
                    }`}
                  >
                    <Code className="w-3.5 h-3.5" />
                    <span>{isRawParamEditMode ? 'Return to Form' : 'Edit Raw TOML'}</span>
                  </button>
                </div>
              </div>

              {/* Parameter Validation Issues Banner */}
              {paramValidationIssues.length > 0 && (
                <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/80 space-y-2">
                  <div className="flex items-center gap-2 text-xs font-bold text-amber-800 dark:text-amber-300 uppercase tracking-wider">
                    <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                    <span>Parameter Validation Warnings ({paramValidationIssues.length})</span>
                  </div>
                  <ul className="space-y-1 text-xs text-amber-700 dark:text-amber-300 pl-6 list-disc">
                    {paramValidationIssues.map((issue, i) => (
                      <li key={i}>
                        {issue.residue && <strong>[{issue.residue}] </strong>}
                        {issue.paramKey && <strong>({issue.paramKey}) </strong>}
                        {issue.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Unparsed Comments / Custom Lines Banner */}
              {unparsedParamTomlLines.length > 0 && !isRawParamEditMode && (
                <div className="p-3.5 rounded-xl bg-blue-50/70 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 flex items-start justify-between gap-3 text-xs text-blue-800 dark:text-blue-300">
                  <div className="flex items-start gap-2.5">
                    <Info className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
                    <div>
                      <span className="font-semibold">Notice:</span> This parameter file contains{' '}
                      <strong>{unparsedParamTomlLines.length} comment/custom lines</strong> from a previous TOML file. Structured edits will generate clean TOML. You can switch to raw mode to preserve custom lines verbatim.
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setRawParamToml(paramConfigToToml(parameterConfig));
                      setIsRawParamEditMode(true);
                    }}
                    className="px-2.5 py-1 bg-white dark:bg-slate-800 border border-blue-300 dark:border-blue-700 rounded-md font-bold text-[11px] hover:bg-blue-50 dark:hover:bg-blue-900/40 whitespace-nowrap"
                  >
                    View in Raw Mode
                  </button>
                </div>
              )}

              {/* Stale Picks Notice Banner */}
              {staleParamCount > 0 && !isRawParamEditMode && (
                <div className="p-3.5 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 flex items-center justify-between gap-3 text-xs text-amber-800 dark:text-amber-300">
                  <div className="flex items-center gap-2.5">
                    <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
                    <span>
                      <strong>Picks moved:</strong> {staleParamCount} residue{staleParamCount === 1 ? '' : 's'} have updated peak positions in the Pick CEST tab.
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowResyncModal(true)}
                    className="px-3 py-1 bg-amber-600 hover:bg-amber-700 text-white font-bold rounded-lg text-xs shadow-xs flex items-center gap-1"
                  >
                    <RefreshCw className="w-3 h-3" />
                    <span>Review Diff & Re-sync</span>
                  </button>
                </div>
              )}

              {/* Raw TOML Mode vs Structured Form */}
              {isRawParamEditMode ? (
                <div className="space-y-3">
                  <div className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl flex items-center justify-between text-xs text-amber-800 dark:text-amber-300">
                    <span className="font-medium">
                      ✏️ <strong>Raw TOML Mode Active</strong>: You are editing parameters.toml directly.
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setRawParamToml(paramConfigToToml(parameterConfig));
                          setIsRawParamEditMode(false);
                        }}
                        className="px-3 py-1 bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 font-bold rounded-lg text-[11px]"
                      >
                        Discard Raw Edits
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const parsed = paramTomlToConfig(rawParamToml);
                          setParameterConfig(parsed.config);
                          setUnparsedParamTomlLines(parsed.unparsed);
                          setIsRawParamEditMode(false);
                        }}
                        className="px-3 py-1 bg-white dark:bg-slate-800 border border-amber-300 dark:border-amber-700 font-bold rounded-lg hover:bg-amber-50 text-[11px]"
                      >
                        Parse & Return to Structured Form
                      </button>
                    </div>
                  </div>
                  <textarea
                    value={rawParamToml}
                    onChange={(e) => setRawParamToml(e.target.value)}
                    rows={18}
                    className={`${inputCls} font-mono text-xs`}
                    placeholder="Enter raw ChemEx parameters.toml content..."
                  />
                </div>
              ) : (
                <div className="space-y-6">
                  {/* Global Parameters Card */}
                  <GlobalParametersCard
                    config={parameterConfig}
                    onChange={setParameterConfig}
                  />

                  {/* Residue Parameters Table */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider">
                        Per-Residue Chemical Shifts & Relaxation Rates
                      </h4>
                    </div>
                    <ResidueParametersTable
                      config={parameterConfig}
                      onChange={setParameterConfig}
                      picks={picks}
                      profiles={profiles}
                      methodConfig={methodConfig}
                      activeStepIdx={activeStepIdx}
                      onNavigateToMethods={() => setActiveTab('methods')}
                    />
                  </div>
                </div>
              )}

              {/* Collapsible Generated parameters.toml Preview */}
              <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden shadow-2xs">
                <div className="p-3.5 bg-slate-50/80 dark:bg-slate-800/60 flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => setShowParamGeneratedPreview(!showParamGeneratedPreview)}
                    className="flex items-center gap-2 text-xs font-bold text-slate-700 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                  >
                    {showParamGeneratedPreview ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    <FileCode className="w-4 h-4 text-blue-500" />
                    <span>Generated parameters.toml Preview</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 font-mono">
                      {Object.keys(parameterConfig.residues || {}).length} residue{Object.keys(parameterConfig.residues || {}).length === 1 ? '' : 's'}
                    </span>
                  </button>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        const toml = isRawParamEditMode ? rawParamToml : paramConfigToToml(parameterConfig);
                        navigator.clipboard.writeText(toml);
                        setSuccessMsg('Copied parameters.toml to clipboard');
                        setTimeout(() => setSuccessMsg(''), 2500);
                      }}
                      className="p-1.5 rounded-lg bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 text-xs font-semibold flex items-center gap-1 border border-slate-200 dark:border-slate-700 shadow-2xs"
                      title="Copy TOML to clipboard"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const toml = isRawParamEditMode ? rawParamToml : paramConfigToToml(parameterConfig);
                        const blob = new Blob([toml], { type: 'text/plain' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `parameters_${analysis.analysis_uuid}.toml`;
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

                {showParamGeneratedPreview && (
                  <div className="p-4 border-t border-slate-200 dark:border-slate-800 bg-slate-900 overflow-x-auto">
                    <pre className="text-xs font-mono text-emerald-400 whitespace-pre-wrap">
                      {isRawParamEditMode ? rawParamToml : paramConfigToToml(parameterConfig)}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'methods' && (
            <div className="space-y-6 animate-in fade-in">
              {/* Methods Header & Quick Actions */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-2 border-b border-slate-100 dark:border-slate-800">
                <div>
                  <h3 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                    <Workflow className="w-5 h-5 text-blue-500" />
                    <span>ChemEx Method Configuration</span>
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Define multi-step fitting protocols, parameter treatments, constraints, and residue selections.
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowTemplateModal(true)}
                    className="px-3 py-1.5 bg-gradient-to-r from-blue-500/10 to-indigo-500/10 hover:from-blue-500/20 hover:to-indigo-500/20 text-blue-600 dark:text-blue-400 text-xs font-bold rounded-lg border border-blue-200/60 dark:border-blue-800/60 transition-all flex items-center gap-1.5 shadow-sm"
                  >
                    <Sparkles className="w-3.5 h-3.5 text-blue-500" />
                    <span>Templates</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setShowImportModal(true)}
                    className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 text-xs font-bold rounded-lg border border-slate-200 dark:border-slate-700 transition-all flex items-center gap-1.5 shadow-sm"
                  >
                    <Upload className="w-3.5 h-3.5" />
                    <span>Import TOML</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      if (!isRawEditMode) {
                        setMethodToml(configToToml(methodConfig));
                      }
                      setIsRawEditMode(!isRawEditMode);
                    }}
                    className={`px-3 py-1.5 text-xs font-bold rounded-lg border transition-all flex items-center gap-1.5 shadow-sm ${
                      isRawEditMode
                        ? 'bg-amber-500 text-white border-amber-600'
                        : 'bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700'
                    }`}
                  >
                    <Code className="w-3.5 h-3.5" />
                    <span>{isRawEditMode ? 'Return to Form' : 'Edit Raw TOML'}</span>
                  </button>
                </div>
              </div>

              {/* Validation Errors/Warnings Banner */}
              {validationErrors.length > 0 && (
                <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/80 space-y-2">
                  <div className="flex items-center gap-2 text-xs font-bold text-amber-800 dark:text-amber-300 uppercase tracking-wider">
                    <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                    <span>Method Validation Issues ({validationErrors.length})</span>
                  </div>
                  <ul className="space-y-1 text-xs text-amber-700 dark:text-amber-300 pl-6 list-disc">
                    {validationErrors.map((err, i) => (
                      <li key={i}>
                        <strong>[{err.stepName}]</strong> {err.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Unparsed Comments Notice */}
              {unparsedTomlLines.length > 0 && !isRawEditMode && (
                <div className="p-3.5 rounded-xl bg-blue-50/70 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 flex items-start justify-between gap-3 text-xs text-blue-800 dark:text-blue-300">
                  <div className="flex items-start gap-2.5">
                    <Info className="w-4 h-4 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" />
                    <div>
                      <span className="font-semibold">Notice:</span> This configuration contains{' '}
                      <strong>{unparsedTomlLines.length} comment/custom lines</strong> from a previous TOML file.
                      Structured edits will generate clean TOML. You can switch to raw mode to preserve custom lines verbatim.
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsRawEditMode(true)}
                    className="px-2.5 py-1 bg-white dark:bg-slate-800 border border-blue-300 dark:border-blue-700 rounded-md font-bold text-[11px] hover:bg-blue-50 dark:hover:bg-blue-900/40 whitespace-nowrap"
                  >
                    View in Raw Mode
                  </button>
                </div>
              )}

              {/* Raw TOML Mode */}
              {isRawEditMode ? (
                <div className="space-y-3">
                  <div className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl flex items-center justify-between text-xs text-amber-800 dark:text-amber-300">
                    <span className="font-medium">
                      ✏️ <strong>Raw TOML Mode Active</strong>: You are editing the method.toml directly.
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        const parsed = tomlToConfig(methodToml);
                        setMethodConfig(parsed.config);
                        setUnparsedTomlLines(parsed.unparsed);
                        setIsRawEditMode(false);
                      }}
                      className="px-3 py-1 bg-white dark:bg-slate-800 border border-amber-300 dark:border-amber-700 font-bold rounded-lg hover:bg-amber-50 text-[11px]"
                    >
                      Parse & Return to Structured Form
                    </button>
                  </div>
                  <textarea
                    value={methodToml}
                    onChange={e => setMethodToml(e.target.value)}
                    rows={16}
                    className={`${inputCls} font-mono text-xs`}
                    placeholder="Enter raw ChemEx method.toml content..."
                  />
                </div>
              ) : (
                /* Structured Form Mode */
                <div className="space-y-6">
                  {/* Step Tabs Row */}
                  <StepTabs
                    steps={methodConfig.steps}
                    activeStepIdx={activeStepIdx}
                    onSelectStep={setActiveStepIdx}
                    onAddStep={handleAddStep}
                    onDuplicateStep={handleDuplicateStep}
                    onDeleteStep={handleDeleteStep}
                    onRenameStep={handleRenameStep}
                    onReorderSteps={handleReorderSteps}
                  />

                  {/* Active Step Parameter Table */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider">
                        Parameters for Step: <span className="font-mono text-blue-600 dark:text-blue-400">{activeStep.name}</span>
                      </h4>
                    </div>
                    <ParameterTable
                      step={activeStep}
                      onChange={handleStepChange}
                      availableParams={availableParamsMeta}
                      startingValues={startingValues}
                      onNavigateToParameters={() => setActiveTab('parameters')}
                    />
                  </div>

                  {/* Active Step Residue Selector */}
                  <ResidueSelector
                    residues={residueItems}
                    mode={activeStep.residueMode || 'include'}
                    selectedIds={activeStep.residues || []}
                    onModeChange={newMode => handleStepChange({ ...activeStep, residueMode: newMode })}
                    onSelectionChange={newRes => handleStepChange({ ...activeStep, residues: newRes })}
                  />

                  {/* Active Step Statistics Section */}
                  <StepStatisticsSection
                    step={activeStep}
                    onChange={handleStepChange}
                  />
                </div>
              )}

              {/* Collapsible Generated method.toml Strip */}
              <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden shadow-sm">
                <div className="p-3.5 bg-slate-50/80 dark:bg-slate-800/60 flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => setShowGeneratedPreview(!showGeneratedPreview)}
                    className="flex items-center gap-2 text-xs font-bold text-slate-700 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                  >
                    {showGeneratedPreview ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    <FileCode className="w-4 h-4 text-blue-500" />
                    <span>Generated method.toml Preview</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 font-mono">
                      {methodConfig.steps.length} step{methodConfig.steps.length > 1 ? 's' : ''}
                    </span>
                  </button>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        const toml = isRawEditMode ? methodToml : configToToml(methodConfig);
                        navigator.clipboard.writeText(toml);
                        setSuccessMsg('Copied method.toml to clipboard');
                        setTimeout(() => setSuccessMsg(''), 2500);
                      }}
                      className="p-1.5 rounded-lg bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 text-xs font-semibold flex items-center gap-1 border border-slate-200 dark:border-slate-700 shadow-sm"
                      title="Copy TOML to clipboard"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const toml = isRawEditMode ? methodToml : configToToml(methodConfig);
                        const blob = new Blob([toml], { type: 'text/plain' });
                        const url = URL.createObjectURL(blob);
                        const link = document.createElement('a');
                        link.href = url;
                        link.download = `method_${analysis.analysis_uuid}.toml`;
                        document.body.appendChild(link);
                        link.click();
                        link.remove();
                        URL.revokeObjectURL(url);
                      }}
                      className="p-1.5 rounded-lg bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 text-xs font-semibold flex items-center gap-1 border border-slate-200 dark:border-slate-700 shadow-sm"
                      title="Download method.toml"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Download</span>
                    </button>
                  </div>
                </div>

                {showGeneratedPreview && (
                  <div className="p-4 border-t border-slate-200 dark:border-slate-800 bg-slate-900 overflow-x-auto">
                    <pre className="text-xs font-mono text-emerald-400 whitespace-pre-wrap">
                      {isRawEditMode ? methodToml : configToToml(methodConfig)}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'logs' && (
            <div className="animate-in fade-in">
              <pre ref={logRef} className="bg-slate-900 text-green-400 text-xs font-mono p-4 rounded-xl overflow-auto max-h-[600px] whitespace-pre-wrap">{logs || 'No logs available.'}</pre>
            </div>
          )}

          {activeTab === 'results' && analysisResults && (() => {
            const currentStepData = (selectedStep && analysisResults.steps) ? analysisResults.steps[selectedStep] : (analysisResults.step_order && analysisResults.steps ? analysisResults.steps[analysisResults.step_order[analysisResults.step_order.length - 1]] : null);
            const isStepMissing = currentStepData?.status === 'missing';
            const isStepPartial = currentStepData?.status === 'partial';

            const activeGlobals = currentStepData?.globals || analysisResults.global || {};
            const activeStats: any = currentStepData?.statistics || {
              chisqr: analysisResults.global?.chi2 ?? analysisResults.global?.chisqr,
              redchi: analysisResults.global?.chi2_red ?? analysisResults.global?.redchi,
              ndata: analysisResults.global?.ndata,
              nvarys: analysisResults.global?.nvarys,
              aic: (analysisResults.global as any)?.aic,
            };
            const activeResidues = currentStepData?.residues || analysisResults.residues || {};

            const getGlobalParam = (key: string) => {
              const gObj = activeGlobals[key] || activeGlobals[key.toUpperCase()] || activeGlobals[key.toLowerCase()];
              if (gObj && typeof gObj === 'object' && 'value' in gObj) {
                return {
                  value: gObj.value,
                  stderr: gObj.stderr,
                  hasStderr: gObj.has_stderr,
                  errorReason: gObj.error_reason,
                  isDerived: gObj.is_derived,
                };
              }
              const val = typeof gObj === 'number' ? gObj : (analysisResults.global as any)?.[key];
              const err = (analysisResults.global as any)?.[`${key}_err`];
              return {
                value: val,
                stderr: err,
                hasStderr: err != null,
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

            // Formatted kinetics
            const formattedKex = formatUncertainty(kex.value, kex.stderr, { unit: 's⁻¹' });
            const formattedPb = formatUncertainty(pb.value, pb.stderr, { isPercent: true });
            const formattedKab = formatUncertainty(kab.value, kab.stderr, { unit: 's⁻¹' });
            const formattedKba = formatUncertainty(kba.value, kba.stderr, { unit: 's⁻¹' });
            const formattedTauB = formatUncertainty(tauB.value, tauB.stderr, { unit: 'ms', isDerived: true });

            // Sort & Filter Residues
            let resKeys = deduplicateSpinKeys(Object.keys(activeResidues));
            if (resultsSearchQuery.trim()) {
              const q = resultsSearchQuery.toLowerCase().trim();
              resKeys = resKeys.filter(k => {
                const mapped = (analysisResults.residue_mapping?.[k] || k).toLowerCase();
                return mapped.includes(q) || k.toLowerCase().includes(q);
              });
            }

            resKeys.sort((a, b) => {
              const objA = activeResidues[a];
              const objB = activeResidues[b];
              if (resultsSortColumn === 'dw') {
                const valA = Math.abs(objA?.dw_ab?.value ?? (objA?.parameters as any)?.dw_ab?.value ?? (objA?.parameters as any)?.DW_AB?.value ?? 0);
                const valB = Math.abs(objB?.dw_ab?.value ?? (objB?.parameters as any)?.dw_ab?.value ?? (objB?.parameters as any)?.DW_AB?.value ?? 0);
                return resultsSortDirection === 'asc' ? valA - valB : valB - valA;
              } else if (resultsSortColumn === 'redchi') {
                const valA = objA?.chi2_red ?? (objA?.parameters as any)?.chi2_red ?? 0;
                const valB = objB?.chi2_red ?? (objB?.parameters as any)?.chi2_red ?? 0;
                return resultsSortDirection === 'asc' ? valA - valB : valB - valA;
              } else if (resultsSortColumn === 'r2') {
                const valA = objA?.r2_a?.value ?? (objA?.parameters as any)?.r2_a?.value ?? 0;
                const valB = objB?.r2_a?.value ?? (objB?.parameters as any)?.r2_a?.value ?? 0;
                return resultsSortDirection === 'asc' ? valA - valB : valB - valA;
              } else {
                const numA = parseInt(a.replace(/\D/g, ''), 10) || 0;
                const numB = parseInt(b.replace(/\D/g, ''), 10) || 0;
                return resultsSortDirection === 'asc' ? numA - numB : numB - numA;
              }
            });

            const hasStatsAffordance = !!(currentStepData?.has_statistics || currentStepData?.statistical_analyses);

            const handleToggleSort = (col: 'res' | 'dw' | 'redchi' | 'r2') => {
              if (resultsSortColumn === col) {
                setResultsSortDirection(prev => (prev === 'asc' ? 'desc' : 'asc'));
              } else {
                setResultsSortColumn(col);
                setResultsSortDirection(col === 'dw' || col === 'redchi' ? 'desc' : 'asc');
              }
            };

            return (
              <div className="space-y-6 animate-in fade-in">
                {/* Results Header & Controls */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-200 dark:border-slate-800">
                  <div className="flex items-center gap-3 flex-wrap">
                    <h4 className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                      {analysisResults.fit_mode === 'individual' && currentResultResidue ? `Metrics for ${analysisResults.residue_mapping?.[currentResultResidue] || currentResultResidue}` : 'Global Analysis Summary'}
                    </h4>

                    {/* Step Selector Dropdown */}
                    {analysisResults.is_multi_step && analysisResults.step_order && analysisResults.step_order.length > 1 && (
                      <div className="flex items-center gap-1.5 bg-slate-100 dark:bg-slate-800 px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700 shadow-2xs">
                        <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Step:</span>
                        <select
                          value={selectedStep}
                          onChange={(e) => handleStepSelect(e.target.value)}
                          className="text-xs font-bold bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 px-2 py-0.5 rounded border border-slate-300 dark:border-slate-600 focus:ring-1 focus:ring-blue-500 cursor-pointer"
                        >
                          {analysisResults.step_order.map(sname => {
                            const sObj = analysisResults.steps?.[sname];
                            const sStatus = sObj?.status || 'complete';
                            const badge = sStatus === 'complete' ? '✓' : (sStatus === 'partial' ? '⚠' : '✗');
                            const gridTag = sObj?.has_grid ? ' [grid ✓]' : '';
                            const statsTag = (sObj?.has_statistics || sObj?.statistical_analyses) ? ' [+Stats]' : '';
                            return (
                              <option key={sname} value={sname}>
                                {sname} ({sStatus} {badge}){gridTag}{statsTag}
                              </option>
                            );
                          })}
                        </select>
                      </div>
                    )}

                    {/* Statistics Affordance Button (§2) */}
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
                    {analysisResults.is_provisional && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
                        <AlertTriangle className="w-3 h-3 text-amber-500" />
                        Provisional
                      </span>
                    )}

                    {/* Partial Step Badge */}
                    {isStepPartial && !analysisResults.is_provisional && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
                        <AlertTriangle className="w-3 h-3 text-amber-500" />
                        Partial Step
                      </span>
                    )}
                  </div>

                  <button 
                    onClick={async () => {
                      try {
                        const res = await api.get(`/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/cest/report`, { responseType: 'blob' });
                        const url = window.URL.createObjectURL(new Blob([res.data]));
                        const link = document.createElement('a');
                        link.href = url;
                        link.setAttribute('download', `cest_${analysis.analysis_uuid}_report.pdf`);
                        document.body.appendChild(link);
                        link.click();
                        link.remove();
                      } catch (err) {
                        console.error('Download failed:', err);
                        alert('Failed to download report. Please check if the analysis results exist.');
                      }
                    }}
                    className="px-4 py-1.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-lg text-[10px] font-bold flex items-center gap-2 transition-all border border-slate-200 dark:border-slate-700 shadow-xs self-start sm:self-auto"
                  >
                    <FileText className="w-3.5 h-3.5" />
                    Download Report (PDF)
                  </button>
                </div>

                {/* Step Statistics Drawer (§2) */}
                {showStepStats && (
                  <div className="animate-in fade-in slide-in-from-top-2 duration-200">
                    <StatisticsResultsSection
                      projectUuid={projectUuid!}
                      analysisUuid={analysis.analysis_uuid}
                      uncertaintyStatistics={currentStepData?.statistical_analyses || (analysisResults as any)?.uncertainty_statistics}
                    />
                  </div>
                )}

                {/* Missing Step Empty State */}
                {isStepMissing ? (
                  <div className="p-12 rounded-2xl bg-slate-50 dark:bg-slate-900 border border-dashed border-slate-300 dark:border-slate-700 text-center space-y-3">
                    <div className="w-12 h-12 mx-auto rounded-full bg-amber-50 dark:bg-amber-950/50 flex items-center justify-center text-amber-500">
                      <AlertTriangle className="w-6 h-6" />
                    </div>
                    <h4 className="text-sm font-bold text-slate-800 dark:text-slate-200">
                      Step '{selectedStep}' was not reached
                    </h4>
                    <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
                      This step was planned in the method configuration, but the fit was interrupted or halted before this step was executed. No parameters or curves were written to disk for this step.
                    </p>
                  </div>
                ) : (
                  <>
                    {/* Summary Cards Grid (§1.3, §3.1) */}
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
                            title="resoFlow-derived: τ_B = 1/K_BA with error σ(τ_B) = σ(K_BA)/K_BA²"
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

                    {/* Collapsible Grid Search Section (Rendered only when current step has_grid) */}
                    {currentStepData?.has_grid && (
                      <GridSearchSection
                        projectUuid={projectUuid!}
                        analysisUuid={analysis.analysis_uuid}
                        stepName={selectedStep || analysisResults.step_order?.[0] || 'STEP1'}
                        onApplyStartingParameters={(coords) => {
                          const { nextConfig, updatedCount } = applyGridCoordinatesToConfig(parameterConfig, coords, currentResultResidue || undefined);
                          if (updatedCount > 0) {
                            setParameterConfig(nextConfig);
                            setSuccessMsg(`Updated starting parameters with grid search minimum (${updatedCount} parameters updated).`);
                            setTimeout(() => setSuccessMsg(''), 5000);
                          }
                        }}
                      />
                    )}

                    {/* Main Layout: Left Residues Table & Right Profile / Grid */}
                    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                      {/* Left: Residues Table Panel (4 cols) */}
                      <div className="lg:col-span-4 border border-slate-200 dark:border-slate-800 rounded-2xl bg-white dark:bg-slate-900 overflow-hidden flex flex-col shadow-sm">
                        {/* Table Header & Search */}
                        <div className="p-3.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/40 space-y-2.5">
                          <div className="flex items-center justify-between">
                            <h5 className="text-xs font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                              <span>Residues</span>
                              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300">
                                {resKeys.length} / {Object.keys(activeResidues).length}
                              </span>
                            </h5>
                          </div>
                          <div className="relative">
                            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                            <input
                              type="text"
                              value={resultsSearchQuery}
                              onChange={(e) => setResultsSearchQuery(e.target.value)}
                              placeholder="Filter residues (e.g. 13N)..."
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
                                  title="Chemical shift difference (DW_AB in ppm) with uncertainty"
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
                              {resKeys.map(res => {
                                const isSelected = (currentResultResidue || resKeys[0]) === res;
                                const resObj = activeResidues[res];
                                const p = resObj?.parameters || {};

                                const dwVal = resObj?.dw_ab?.value ?? (p?.dw_ab as any)?.value ?? p?.dw_ab ?? (p?.DW_AB as any)?.value ?? p?.DW_AB;
                                const dwErr = resObj?.dw_ab?.stderr ?? (p?.dw_ab as any)?.stderr ?? (p?.DW_AB as any)?.stderr;
                                const formattedDw = formatUncertainty(dwVal, dwErr, { unit: '', forceSign: true });

                                const rChi2Red = resObj?.chi2_red ?? (p?.chi2_red as any)?.value ?? p?.chi2_red;
                                const rChi2Raw = resObj?.chi2 ?? (p?.chi2 as any)?.value ?? p?.chi2;

                                const r2Val = resObj?.r2_a?.value ?? (p?.r2_a as any)?.value ?? p?.r2_a ?? p?.r2_b;
                                const r2Err = resObj?.r2_a?.stderr ?? (p?.r2_a as any)?.stderr;
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
                                    title={rChi2Raw != null ? `resoFlow-derived raw χ²*: ${rChi2Raw.toFixed(1)} (DOF = Ndata - Nvarys)` : undefined}
                                    className={`cursor-pointer transition-colors ${isSelected ? 'bg-blue-600 text-white font-bold' : 'hover:bg-blue-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300'}`}
                                  >
                                    <td className="px-3 py-2 font-sans font-medium">
                                      {analysisResults.residue_mapping?.[res] || res}
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

                        {/* Footnote (§3.7) */}
                        <div className="p-2.5 bg-slate-50 dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 text-[10px] text-slate-400 italic">
                          Δω from DW_AB; Reduced χ² and R₂ with covariance error bars. τ_B = 1/K_BA is resoFlow-derived.
                        </div>

                        {/* Colors Customization */}
                        <div className="p-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30">
                          <h5 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2 flex items-center justify-between">
                            <span>B₁ Fields & Colors</span>
                            <RotateCcw className="w-3 h-3 cursor-pointer hover:rotate-180 transition-transform text-slate-400 hover:text-slate-600" onClick={() => setFieldColors({})} />
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

                      {/* Right: Profile & Residuals Plot OR Thumbnail Grid (8 cols) */}
                      <div className="lg:col-span-8 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-sm p-4">
                        {resultsViewMode === 'grid' ? (
                          /* Thumbnail Grid View (§4 Small Multiples) */
                          <div className="space-y-4">
                            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-2">
                              <h4 className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                                All Residues Thumbnail Grid ({resKeys.length} items)
                              </h4>
                              <p className="text-[10px] text-slate-400">Click any thumbnail to promote to single view</p>
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3.5 max-h-[640px] overflow-y-auto pr-1">
                              {resKeys.map(res => {
                                const rObj = activeResidues[res];
                                const exps = rObj?.experiments || [];
                                const p = rObj?.parameters || {};
                                const dwVal = rObj?.dw_ab?.value ?? (p?.dw_ab as any)?.value ?? p?.dw_ab ?? (p?.DW_AB as any)?.value ?? p?.DW_AB;
                                const rChi2Red = rObj?.chi2_red ?? (p?.chi2_red as any)?.value ?? p?.chi2_red;

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
                                        {analysisResults.residue_mapping?.[res] || res}
                                      </span>
                                      <div className="flex items-center gap-1">
                                        {dwVal != null && (
                                          <span className="text-[9px] font-mono font-semibold px-1.5 py-0.2 rounded bg-purple-50 dark:bg-purple-950/60 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800">
                                            Δω: {dwVal > 0 ? `+${dwVal.toFixed(2)}` : dwVal.toFixed(2)}
                                          </span>
                                        )}
                                        {rChi2Red != null && (
                                          <span className={`text-[9px] font-mono px-1.5 py-0.2 rounded ${rChi2Red > 2.0 ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-600'}`}>
                                            χ²: {rChi2Red.toFixed(2)}
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                    <div className="w-full h-28 pointer-events-none">
                                      <Plot
                                        data={exps.flatMap((exp: any) => {
                                          const color = fieldColors[exp.b1_label] || PLOT_COLORS.primary;
                                          const expPoints = exp.exp_points || { x: [], y: [], y_err: [] };
                                          const calcPoints = exp.calc_points || exp.fit_curve || { x: [], y: [] };
                                          return [
                                            {
                                              x: expPoints.x || [],
                                              y: expPoints.y || [],
                                              type: 'scatter',
                                              mode: 'markers',
                                              marker: { color, size: 4 },
                                              showlegend: false,
                                            },
                                            {
                                              x: calcPoints.x || [],
                                              y: calcPoints.y || [],
                                              type: 'scatter',
                                              mode: 'lines',
                                              line: { color, width: 1.5, shape: 'spline' },
                                              showlegend: false,
                                            }
                                          ];
                                        })}
                                        layout={{
                                          xaxis: { visible: false, autorange: 'reversed' },
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
                          /* Single Detailed Residue Profile & Residuals (§3.3, §3.5) */
                          (() => {
                            const resToUse = currentResultResidue || (resKeys.length > 0 ? resKeys[0] : '');
                            const currResObj = activeResidues[resToUse];
                            const currParams = currResObj?.parameters || {};

                            let csA = currResObj?.cs_a?.value ?? (typeof currParams?.CS_A === 'object' ? currParams?.CS_A?.value : currParams?.CS_A) ?? currParams?.cs_a;
                            if (csA == null) {
                              const matchingPick = picks[resToUse] || (currentProfile ? picks[currentProfile.residue] : null);
                              if (matchingPick?.cs_a != null) {
                                csA = matchingPick.cs_a;
                              } else if (parameterConfig.residues?.[resToUse]?.cs_a?.value != null) {
                                csA = parameterConfig.residues[resToUse].cs_a.value;
                              }
                            }

                            let csB = currResObj?.cs_b?.value ?? (typeof currParams?.CS_B === 'object' ? currParams?.CS_B?.value : currParams?.CS_B) ?? currParams?.cs_b;
                            const dwVal = currResObj?.dw_ab?.value ?? (typeof currParams?.DW_AB === 'object' ? currParams?.DW_AB?.value : currParams?.DW_AB) ?? currParams?.dw_ab;
                            if (csB == null && csA != null && dwVal != null) {
                              csB = csA + dwVal;
                            }

                            let csC = (currResObj?.parameters as any)?.cs_c?.value ?? (currResObj?.parameters as any)?.CS_C?.value;
                            const dwAC = (currResObj?.parameters as any)?.dw_ac?.value ?? (currResObj?.parameters as any)?.DW_AC?.value;
                            if (csC == null && csA != null && dwAC != null) {
                              csC = csA + dwAC;
                            }

                            const exps = currResObj?.experiments || [];

                            // Compute residuals per experiment for the Residuals Strip (§3.5)
                            const residualsData = exps.map((exp: any) => {
                              const expPts = exp.exp_points || { x: [], y: [], y_err: [] };
                              const calcPts = exp.calc_points || exp.fit_curve || { x: [], y: [] };
                              const resX: number[] = [];
                              const resY: number[] = [];

                              if (expPts.x && calcPts.x && expPts.x.length > 0 && calcPts.x.length > 0) {
                                for (let i = 0; i < expPts.x.length; i++) {
                                  const xi = expPts.x[i];
                                  const yi = expPts.y[i];
                                  const erri = (expPts.y_err && expPts.y_err[i] > 0) ? expPts.y_err[i] : 1.0;

                                  // Nearest neighbor or interpolation for y_calc
                                  let closestIdx = 0;
                                  let minDiff = Math.abs(calcPts.x[0] - xi);
                                  for (let j = 1; j < calcPts.x.length; j++) {
                                    const diff = Math.abs(calcPts.x[j] - xi);
                                    if (diff < minDiff) {
                                      minDiff = diff;
                                      closestIdx = j;
                                    }
                                  }
                                  const yCalc = calcPts.y[closestIdx];
                                  if (yCalc != null) {
                                    resX.push(xi);
                                    resY.push((yi - yCalc) / erri);
                                  }
                                }
                              }

                              return {
                                b1_label: exp.b1_label,
                                x: resX,
                                y: resY,
                              };
                            });

                            return (
                              <div className="space-y-4">
                                <div className="flex items-center justify-between flex-wrap gap-2">
                                  <div>
                                    <h4 className="text-lg font-bold text-slate-900 dark:text-white leading-none mb-1">
                                      {analysisResults.residue_mapping?.[resToUse] || resToUse || 'Select a Residue'}
                                    </h4>
                                    <p className="text-[10px] font-medium text-slate-500 italic">
                                      Ground state CS_A (solid blue), excited state CS_B (dashed red), and normalized I/I₀ profiles
                                    </p>
                                  </div>
                                  <div className="flex items-center gap-2 text-xs font-mono flex-wrap">
                                    {csA != null && (
                                      <span className="px-2 py-0.5 rounded bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 font-semibold flex items-center gap-1">
                                        <span className="w-2 h-0.5 bg-blue-600 inline-block" />
                                        CS_A: {typeof csA === 'number' ? csA.toFixed(2) : csA} ppm
                                      </span>
                                    )}
                                    {csB != null && (
                                      <span className="px-2 py-0.5 rounded bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800 font-semibold flex items-center gap-1">
                                        <span className="w-2 h-0.5 border-t-2 border-dashed border-red-600 inline-block" />
                                        CS_B: {typeof csB === 'number' ? csB.toFixed(2) : csB} ppm
                                      </span>
                                    )}
                                    {dwVal != null && (
                                      <span className="px-2 py-0.5 rounded bg-purple-50 dark:bg-purple-950/40 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800 font-semibold">
                                        Δω: {dwVal > 0 ? `+${dwVal.toFixed(2)}` : dwVal.toFixed(2)} ppm
                                      </span>
                                    )}
                                  </div>
                                </div>

                                {/* Main CEST Profile Plot */}
                                <div className="w-full" style={{ height: '360px' }}>
                                  <Plot
                                    className="w-full h-full"
                                    useResizeHandler={true}
                                    style={{ width: '100%', height: '100%' }}
                                    data={exps.flatMap((exp: any) => {
                                      const color = fieldColors[exp.b1_label] || PLOT_COLORS.primary;
                                      const expPoints = exp.exp_points || { x: [], y: [], y_err: [] };
                                      const calcPoints = exp.calc_points || exp.fit_curve || { x: [], y: [] };
                                      const x = expPoints.x || [];
                                      const y = expPoints.y || [];
                                      const y_err = expPoints.y_err || [];

                                      return [
                                        {
                                          x,
                                          y,
                                          error_y: {
                                            type: 'data',
                                            array: y_err,
                                            visible: true,
                                            color: color,
                                            thickness: 1.5,
                                            width: 3.5,
                                          },
                                          type: 'scatter',
                                          mode: 'markers',
                                          name: exp.b1_label,
                                          marker: {
                                            color,
                                            size: 7,
                                            line: { width: 1.2, color: '#ffffff' },
                                          },
                                        },
                                        {
                                          x: calcPoints.x || [],
                                          y: calcPoints.y || [],
                                          type: 'scatter',
                                          mode: 'lines',
                                          name: `${exp.b1_label} (Fit)`,
                                          line: { color, width: 2.2, shape: 'spline' },
                                          showlegend: false,
                                        }
                                      ];
                                    })}
                                    layout={{
                                      xaxis: { title: `¹⁵N Offset (${nucleusInfo?.unitLabel || 'ppm'})`, autorange: 'reversed' },
                                      yaxis: { title: 'I / I₀', autorange: true },
                                      margin: { l: 60, r: 30, t: 25, b: 45 },
                                      legend: { orientation: 'h', x: 0.5, xanchor: 'center', y: -0.2 },
                                      shapes: [
                                        ...(csA != null ? [{
                                          type: 'line' as const,
                                          x0: csA,
                                          x1: csA,
                                          y0: 0,
                                          y1: 1,
                                          yref: 'paper' as const,
                                          line: { color: '#2563eb', width: 2 }
                                        }] : []),
                                        ...(csB != null ? [{
                                          type: 'line' as const,
                                          x0: csB,
                                          x1: csB,
                                          y0: 0,
                                          y1: 1,
                                          yref: 'paper' as const,
                                          line: { color: '#dc2626', width: 2, dash: 'dash' as const }
                                        }] : []),
                                        ...(csC != null ? [{
                                          type: 'line' as const,
                                          x0: csC,
                                          x1: csC,
                                          y0: 0,
                                          y1: 1,
                                          yref: 'paper' as const,
                                          line: { color: '#059669', width: 2, dash: 'dot' as const }
                                        }] : []),
                                      ],
                                      annotations: [
                                        ...(csA != null ? [{
                                          x: csA,
                                          y: 1.02,
                                          yref: 'paper' as const,
                                          text: `CS_A: ${typeof csA === 'number' ? csA.toFixed(2) : csA}`,
                                          showarrow: false,
                                          font: { color: '#2563eb', size: 9, weight: 'bold' as const },
                                          yanchor: 'bottom' as const,
                                          bgcolor: 'rgba(255, 255, 255, 0.9)',
                                          bordercolor: '#2563eb',
                                          borderwidth: 1,
                                          borderpad: 2,
                                        }] : []),
                                        ...(csB != null ? [{
                                          x: csB,
                                          y: 1.02,
                                          yref: 'paper' as const,
                                          text: `CS_B: ${typeof csB === 'number' ? csB.toFixed(2) : csB}`,
                                          showarrow: false,
                                          font: { color: '#dc2626', size: 9, weight: 'bold' as const },
                                          yanchor: 'bottom' as const,
                                          bgcolor: 'rgba(255, 255, 255, 0.9)',
                                          bordercolor: '#dc2626',
                                          borderwidth: 1,
                                          borderpad: 2,
                                        }] : []),
                                      ]
                                    }}
                                    config={{ responsive: true, displayModeBar: true, showTips: false }}
                                  />
                                </div>

                                {/* Shared-x Residuals Strip Plot (§3.5) */}
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
                                      };
                                    })}
                                    layout={{
                                      xaxis: { title: `¹⁵N Offset (${nucleusInfo?.unitLabel || 'ppm'})`, autorange: 'reversed' },
                                      yaxis: { title: 'Residual (σ)', range: [-3.5, 3.5], zeroline: true, zerolinecolor: '#94a3b8' },
                                      margin: { l: 60, r: 30, t: 10, b: 40 },
                                      shapes: [
                                        { type: 'line', x0: 0, x1: 1, xref: 'paper', y0: 0, y1: 0, line: { color: '#94a3b8', width: 1.2 } },
                                        { type: 'line', x0: 0, x1: 1, xref: 'paper', y0: 1, y1: 1, line: { color: '#cbd5e1', width: 1, dash: 'dash' } },
                                        { type: 'line', x0: 0, x1: 1, xref: 'paper', y0: -1, y1: -1, line: { color: '#cbd5e1', width: 1, dash: 'dash' } },
                                        { type: 'line', x0: 0, x1: 1, xref: 'paper', y0: 2, y1: 2, line: { color: '#e2e8f0', width: 1, dash: 'dot' } },
                                        { type: 'line', x0: 0, x1: 1, xref: 'paper', y0: -2, y1: -2, line: { color: '#e2e8f0', width: 1, dash: 'dot' } },
                                      ]
                                    }}
                                    config={{ responsive: true, displayModeBar: false }}
                                  />
                                </div>
                              </div>
                            );
                          })()
                        )}
                      </div>
                    </div>

                    {/* Bottom Diagnostic Plots (Three Scatter Panels, §1.2, §3.2) */}
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mt-6">
                      {/* Panel 1: Reduced χ² vs Residue */}
                      <div className={sectionCls}>
                        <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-4 flex items-center gap-2">
                          <span className="w-1.5 h-4 bg-blue-500 rounded-full" /> Reduced χ² vs Residue
                        </h4>
                        <Plot
                          data={[{
                            x: sortSpinKeys(Object.keys(activeResidues)).map(res => analysisResults.residue_mapping?.[res] || res),
                            y: sortSpinKeys(Object.keys(activeResidues)).map(res => activeResidues[res]?.chi2_red ?? activeResidues[res]?.parameters?.chi2_red),
                            type: 'scatter',
                            mode: 'markers',
                            marker: { size: 9, color: PLOT_COLORS.primary, opacity: 0.8, line: { width: 1.2, color: '#fff' } },
                            name: 'Reduced χ²'
                          }]}
                          layout={{
                            xaxis: { title: 'Residue', tickangle: -45 },
                            yaxis: { title: 'Reduced χ²', rangemode: 'tozero' },
                            margin: { l: 55, r: 25, t: 15, b: 70 },
                            height: 320,
                            paper_bgcolor: 'transparent',
                            plot_bgcolor: 'transparent',
                            shapes: [
                              { type: 'line', x0: 0, x1: 1, xref: 'paper', y0: 1.0, y1: 1.0, line: { color: '#94a3b8', width: 1.2, dash: 'dash' } }
                            ]
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
                              x: sortSpinKeys(Object.keys(activeResidues)).map(res => analysisResults.residue_mapping?.[res] || res),
                              y: sortSpinKeys(Object.keys(activeResidues)).map(res => activeResidues[res]?.r2_a?.value ?? activeResidues[res]?.parameters?.r2_a),
                              error_y: {
                                type: 'data',
                                array: sortSpinKeys(Object.keys(activeResidues)).map(res => activeResidues[res]?.r2_a?.stderr ?? 0),
                                visible: true,
                                color: PLOT_COLORS.primary,
                              },
                              type: 'scatter',
                              mode: 'markers',
                              marker: { size: 9, color: PLOT_COLORS.primary, opacity: 0.85, line: { width: 1, color: '#fff' } },
                              name: 'R2A (Ground)'
                            },
                            {
                              x: sortSpinKeys(Object.keys(activeResidues)).map(res => analysisResults.residue_mapping?.[res] || res),
                              y: sortSpinKeys(Object.keys(activeResidues)).map(res => activeResidues[res]?.r2_b?.value ?? activeResidues[res]?.parameters?.r2_b),
                              error_y: {
                                type: 'data',
                                array: sortSpinKeys(Object.keys(activeResidues)).map(res => activeResidues[res]?.r2_b?.stderr ?? 0),
                                visible: true,
                                color: '#ef4444',
                              },
                              type: 'scatter',
                              mode: 'markers',
                              marker: { size: 9, color: '#ef4444', opacity: 0.85, symbol: 'diamond-open', line: { width: 1.5, color: '#ef4444' } },
                              name: 'R2B (Excited)'
                            }
                          ]}
                          layout={{
                            xaxis: { title: 'Residue', tickangle: -45 },
                            yaxis: { title: 'R₂ (s⁻¹)', rangemode: 'tozero' },
                            margin: { l: 55, r: 25, t: 15, b: 70 },
                            height: 320,
                            paper_bgcolor: 'transparent',
                            plot_bgcolor: 'transparent',
                            legend: { orientation: 'h', y: -0.35, x: 0.5, xanchor: 'center' }
                          }}
                          style={{ width: '100%' }}
                          config={{ responsive: true, displayModeBar: false }}
                        />
                      </div>

                      {/* Panel 3: Δω vs Residue (§1.2) */}
                      <div className={sectionCls}>
                        <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-4 flex items-center gap-2">
                          <span className="w-1.5 h-4 bg-purple-500 rounded-full" /> Δω (ppm) vs Residue
                        </h4>
                        <Plot
                          data={[{
                            x: sortSpinKeys(Object.keys(activeResidues)).map(res => analysisResults.residue_mapping?.[res] || res),
                            y: sortSpinKeys(Object.keys(activeResidues)).map(res => {
                              const rObj = activeResidues[res];
                              const p = rObj?.parameters || {};
                              return rObj?.dw_ab?.value ?? (p?.dw_ab as any)?.value ?? p?.dw_ab ?? (p?.DW_AB as any)?.value ?? p?.DW_AB ?? 0;
                            }),
                            error_y: {
                              type: 'data',
                              array: sortSpinKeys(Object.keys(activeResidues)).map(res => {
                                const rObj = activeResidues[res];
                                const p = rObj?.parameters || {};
                                return rObj?.dw_ab?.stderr ?? (p?.dw_ab as any)?.stderr ?? (p?.DW_AB as any)?.stderr ?? 0;
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
                              line: { width: 1.2, color: '#fff' }
                            },
                            name: 'Δω (Signed)'
                          }]}
                          layout={{
                            xaxis: { title: 'Residue', tickangle: -45 },
                            yaxis: { title: 'Δω (ppm)', zeroline: true, zerolinecolor: '#94a3b8' },
                            margin: { l: 55, r: 25, t: 15, b: 70 },
                            height: 320,
                            paper_bgcolor: 'transparent',
                            plot_bgcolor: 'transparent',
                            shapes: [
                              { type: 'line', x0: 0, x1: 1, xref: 'paper', y0: 0, y1: 0, line: { color: '#94a3b8', width: 1.2, dash: 'dash' } }
                            ]
                          }}
                          style={{ width: '100%' }}
                          config={{ responsive: true, displayModeBar: false }}
                        />
                      </div>
                    </div>

                    {/* Provenance Accordion (§5) */}
                    {analysisResults.provenance && (
                      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-2xs">
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
          })()}
        </div>
      </div>

      {/* ── File Preview Modal ── */}
      {previewFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in zoom-in duration-200">
          <div className="bg-white dark:bg-slate-900 w-full max-w-4xl max-h-[85vh] rounded-2xl shadow-2xl flex flex-col border border-slate-200 dark:border-slate-700 translate-y-0">
            <div className="flex items-center justify-between p-5 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-blue-50 dark:bg-blue-900/30 flex items-center justify-center">
                  <FileText className="text-blue-600 dark:text-blue-400" size={20} />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100 leading-none">{previewFile.name}</h3>
                  <p className="text-xs text-slate-500 mt-1">Generated Experiment Preview</p>
                </div>
              </div>
              <button onClick={() => setPreviewFile(null)} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-full text-slate-400 hover:text-slate-600 transition-all">
                <ChevronRight className="rotate-45" size={24} />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-6">
              <pre className="font-mono text-xs leading-relaxed text-slate-700 dark:text-slate-300 whitespace-pre">
                {previewFile.content}
              </pre>
            </div>
            <div className="p-4 border-t border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 flex justify-end">
              <button onClick={() => setPreviewFile(null)} className={btnPrimary}>Close Preview</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Method Template Modal ── */}
      {showTemplateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-white dark:bg-slate-900 w-full max-w-2xl rounded-2xl shadow-2xl flex flex-col border border-slate-200 dark:border-slate-700 max-h-[85vh] overflow-hidden">
            <div className="flex items-center justify-between p-5 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-blue-50 dark:bg-blue-900/30 flex items-center justify-center text-blue-600 dark:text-blue-400">
                  <Sparkles size={20} />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-800 dark:text-slate-100">Method Strategy Templates</h3>
                  <p className="text-xs text-slate-500 mt-0.5">Select a predefined fitting strategy for your ChemEx analysis.</p>
                </div>
              </div>
              <button
                onClick={() => setShowTemplateModal(false)}
                className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg text-slate-400 hover:text-slate-600"
              >
                ✕
              </button>
            </div>

            <div className="p-6 space-y-4 overflow-y-auto">
              {METHOD_TEMPLATES.map(tmpl => {
                const stepCount = tmpl.config.steps.length;
                const fitParams = Array.from(
                  new Set(
                    tmpl.config.steps.flatMap(s =>
                      s.parameters.filter(p => p.mode === 'fit').map(p => p.name)
                    )
                  )
                );

                return (
                  <div
                    key={tmpl.id}
                    className="p-4 rounded-xl border border-slate-200 dark:border-slate-700/80 bg-slate-50/50 dark:bg-slate-800/40 hover:border-blue-300 dark:hover:border-blue-700 transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-4 group"
                  >
                    <div className="space-y-1.5 flex-grow">
                      <div className="flex items-center gap-2">
                        <h4 className="text-sm font-bold text-slate-900 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                          {tmpl.name}
                        </h4>
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 font-bold">
                          {stepCount} Step{stepCount > 1 ? 's' : ''}
                        </span>
                      </div>
                      <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed max-w-lg">
                        {tmpl.description}
                      </p>
                      <div className="flex flex-wrap items-center gap-1 pt-1">
                        <span className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider mr-1">Fitted:</span>
                        {fitParams.map(p => (
                          <span
                            key={p}
                            className="px-1.5 py-0.2 rounded bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 font-mono text-[10px] font-bold"
                          >
                            {p}
                          </span>
                        ))}
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleApplyTemplate(tmpl)}
                      className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-lg shadow-sm whitespace-nowrap transition-colors flex-shrink-0"
                    >
                      Use Template
                    </button>
                  </div>
                );
              })}
            </div>

            <div className="p-4 border-t border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 flex justify-end">
              <button
                type="button"
                onClick={() => setShowTemplateModal(false)}
                className={btnSecondary}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Import method.toml Modal ── */}
      {showImportModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-white dark:bg-slate-900 w-full max-w-2xl rounded-2xl shadow-2xl flex flex-col border border-slate-200 dark:border-slate-700 max-h-[85vh] overflow-hidden">
            <div className="flex items-center justify-between p-5 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-blue-50 dark:bg-blue-900/30 flex items-center justify-center text-blue-600 dark:text-blue-400">
                  <Upload size={20} />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-800 dark:text-slate-100">Import method.toml</h3>
                  <p className="text-xs text-slate-500 mt-0.5">Upload a .toml file or paste method configuration text.</p>
                </div>
              </div>
              <button
                onClick={() => setShowImportModal(false)}
                className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg text-slate-400 hover:text-slate-600"
              >
                ✕
              </button>
            </div>

            <div className="p-6 space-y-4 overflow-y-auto">
              <div>
                <label className="text-xs font-bold text-slate-600 dark:text-slate-400 block mb-2">
                  Upload file or paste TOML:
                </label>
                <input
                  type="file"
                  accept=".toml,.txt"
                  onChange={e => {
                    const file = e.target.files?.[0];
                    if (file) {
                      const reader = new FileReader();
                      reader.onload = ev => {
                        const text = ev.target?.result as string;
                        if (text) setImportTomlText(text);
                      };
                      reader.readAsText(file);
                    }
                  }}
                  className="mb-3 block w-full text-xs text-slate-500 file:mr-4 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 dark:file:bg-blue-900/30 dark:file:text-blue-300"
                />
                <textarea
                  value={importTomlText}
                  onChange={e => setImportTomlText(e.target.value)}
                  rows={10}
                  placeholder={`[STEP1]\nFIT = ["PB", "KEX_AB", "DW_AB", "CS_A"]\nCONSTRAINTS = ["[PB] < 0.5"]`}
                  className={`${inputCls} font-mono text-xs`}
                />
              </div>
            </div>

            <div className="p-4 border-t border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowImportModal(false)}
                className={btnSecondary}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!importTomlText.trim()}
                onClick={handleImportToml}
                className={btnPrimary}
              >
                Parse & Apply Configuration
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Re-sync Parameters Modal */}
      <ResyncModal
        isOpen={showResyncModal}
        onClose={() => setShowResyncModal(false)}
        config={parameterConfig}
        picks={picks}
        profiles={profiles}
        residueLabels={Object.fromEntries(profiles.map(p => [p.residue, p.full_residue || p.residue]))}
        onApply={(updated) => {
          setParameterConfig(updated);
          setSuccessMsg('Re-synced parameters from picks successfully');
          setTimeout(() => setSuccessMsg(''), 3000);
        }}
      />

      {/* Import Parameters TOML Modal */}
      <ParametersImportModal
        isOpen={showParamImportModal}
        onClose={() => setShowParamImportModal(false)}
        onImport={(imported, unparsed) => {
          setParameterConfig(imported);
          setUnparsedParamTomlLines(unparsed);
          setIsRawParamEditMode(false);
          setSuccessMsg('Imported parameters.toml successfully');
          setTimeout(() => setSuccessMsg(''), 3000);
        }}
      />

      {/* Source Run Picker Modal */}
      <SourceRunPickerModal
        isOpen={showSourcePickerModal}
        onClose={() => setShowSourcePickerModal(false)}
        projectUuid={projectUuid}
        targetAnalysis={{
          analysis_uuid: analysis.analysis_uuid,
          name: analysis.name,
          analysis_type: analysis.analysis_type,
          model,
          nucleus: '15N',
          static_field: profiles[0]?.experiments[0]?.b0 || 600.0,
          temperature: 298.15,
        }}
        onSelectRun={handleSelectSourceRun}
      />

      {/* Inherit Parameters Diff & Apply Modal */}
      {selectedSourceRun && (
        <InheritParametersModal
          isOpen={showInheritModal}
          onClose={() => setShowInheritModal(false)}
          projectUuid={projectUuid}
          sourceRun={selectedSourceRun}
          currentParamConfig={parameterConfig}
          currentMethodConfig={methodConfig}
          currentPicks={picks}
          profiles={profiles}
          residueLabels={analysisResults?.residue_mapping}
          onApply={handleApplyInheritedParameters}
        />
      )}
    </div>
  );
};

export default CestAnalysisManager;
