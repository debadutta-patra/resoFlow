import SaveButton from './chemex/SaveButton';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import StartingValuesMenu from './chemex/StartingValuesMenu';
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';
import {
  Play, ChevronLeft, ChevronRight,
  Beaker, Loader2, RotateCcw, Square, Workflow, Sparkles, RefreshCw, Sliders, MinusCircle, PlusCircle,
  Activity, X, Check, AlertCircle, Download, AlertTriangle, ChevronDown, ChevronUp, ArrowUpDown, LayoutGrid, Maximize2, FileText, Search
} from 'lucide-react';
import Plot, { PLOT_COLORS } from './Plot';
import { useTheme } from '../context/ThemeContext';
import { useOptionalUserRuns } from '../context/RunsContext';
import { formatUncertainty } from '../lib/uncertaintyFormatter';
import { deduplicateSpinKeys } from '../lib/spinSystem';
import StatisticsResultsSection from './methods/StatisticsResultsSection';
import { GridSearchSection } from './grid/GridSearchSection';
import { KINETIC_MODELS } from '../lib/methodConfig';
import type { ResidueItem } from './methods/ResidueSelector';
import { MethodsTab } from './methods/MethodsTab';
import { ParametersTab } from './parameters/ParametersTab';
import { ConfigChangedBadge, LastCommittedBadge, LineageBadge, LiveRunBadge, StaleStartingValuesBadge } from './chemex/RunStatusBadges';
import type { RunProgress } from '../lib/runProgress';
import { committedGlobalsByStep, lastCommittedStep } from '../lib/committedResults';
import { minorPickFlag } from '../lib/residueSelection';
import type { ProfileRef } from '../lib/parameterConfig';
import {
  computePickHash,
  canonicalizeParameterConfig,
  isResidueExcluded,
  sortSpinKeys,
  applyGridCoordinatesToConfig,
  startingProvenance,
  withValue,
} from '../lib/parameterConfig';
import { NestedConfigGroup, type B1DistributionConfig } from './cest/NestedConfigGroup';
import { ProfileFilterControls } from './cest/ProfileFilterControls';
import { CpmgDispersionTab, type CpmgProfileItem } from './cpmg/CpmgDispersionTab';
import { getNucleusInfoForModule } from '../lib/experimentPlugin';
import { chemexConfigHash, experimentsFingerprint, findLineage, isRunActive, preflightChemexValidation, RERUN_CONFIRM_MESSAGE } from '../lib/chemexRun';
import { useMethodEditor } from '../hooks/useMethodEditor';
import { useParameterEditor } from '../hooks/useParameterEditor';
import { exchangePlugin } from '../plugins/exchangePlugin';
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
export interface Spectrum {
  id: number;
  spectrum_uuid?: string;
  name: string;
  experiment_type?: string | null;
  is_fitted?: boolean;
  b1?: number | null;
  b0?: number | null;
  carrier?: number | null;
  t_relax?: number | null;
  f3list_path?: string | null;
  temperature?: number | null;
}

export interface Analysis {
  id: number;
  analysis_uuid: string;
  name: string;
  analysis_type: string;
  status: string;
  parameters?: string | null;
  spectra?: Spectrum[];
  use_height?: boolean;
  has_backup?: boolean;
  error_message?: string;
  bundle_status?: string;
  summary_redchi?: number;
  summary_n_residues?: number;
  completed_at?: string;
}

export interface CestExperiment {
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

export interface CestProfile {
  residue: string;
  full_residue?: string;
  experiments: CestExperiment[];
}

export interface CestPick {
  cs_a: number | null;
  cs_b: number | null;
  cs_c: number | null;
  cs_d: number | null;
  cs_e: number | null;
  cs_f: number | null;
}

export interface ExchangeAnalysisManagerProps {
  analysis: Analysis;
  projectUuid: string;
  availableSpectra?: Spectrum[];
  spectra?: Spectrum[];
  allAnalyses?: Analysis[];
  onStatusChange?: (status: string) => void;
  onUpdate?: () => void;
  onDelete?: () => void;
  onClose?: () => void;
}

type TabKey = 'experiments' | 'pick_cest' | 'dispersion' | 'parameters' | 'methods' | 'logs' | 'results';

const STATUS_COLORS: Record<string, string> = {
  PENDING: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800',
  RUNNING: 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800',
  CANCELLING: 'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700',
  CANCELLED: 'bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700',
  COMPLETED: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800',
  FAILED: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800',
};

export const ExchangeAnalysisManager: React.FC<ExchangeAnalysisManagerProps> = ({
  analysis,
  projectUuid,
  availableSpectra = [],
  spectra = [],
  allAnalyses: _allAnalyses = [],
  onStatusChange,
  onUpdate,
  onDelete: _onDelete,
  onClose: _onClose,
}) => {
  const { theme } = useTheme();
  const userRuns = useOptionalUserRuns();
  const navigate = useNavigate();

  const isDarkTheme = theme === 'dark';
  const nmrSpectraIcon = isDarkTheme ? nmrSpectraDark : nmrSpectraLight;
  const atomSpinIcon = isDarkTheme ? atomSpinDark : atomSpinLight;
  const peakFittingIcon = isDarkTheme ? peakFittingDark : peakFittingLight;
  const fitParametersIcon = isDarkTheme ? fitParametersDark : fitParametersLight;
  const terminalLogsIcon = isDarkTheme ? terminalLogsDark : terminalLogsLight;

  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => {
    try {
      return typeof localStorage !== 'undefined' && localStorage.getItem('resoFlow_sidebar_collapsed') === 'true';
    } catch {
      return false;
    }
  });
  const [error, setError] = useState<string>('');
  const [successMsg, setSuccessMsg] = useState<string>('');
  const [status, setStatus] = useState<string>(analysis.status);

  useEffect(() => {
    setStatus(analysis.status);
  }, [analysis.status]);

  const allSpectra = useMemo(() => {
    const list = availableSpectra.length > 0 ? availableSpectra : spectra;
    return list;
  }, [availableSpectra, spectra]);

  // Tab State
  const [activeTab, setActiveTab] = useState<TabKey>(() => {
    if (analysis.status === 'RUNNING' || analysis.status === 'PENDING') return 'logs';
    if (analysis.status === 'COMPLETED') return 'results';
    return 'experiments';
  });

  // Experiment Setup State
  const [selectedSpectrumIds, setSelectedSpectrumIds] = useState<number[]>([]);
  const [model, setModel] = useState<string>('2st');
  const [useHeight, setUseHeight] = useState<boolean>(true);
  const [cestModuleName, setCestModuleName] = useState<string>('cest_15n');
  const [cpmgModuleName, setCpmgModuleName] = useState<string>('cpmg_15n_ip');
  const [b1Distribution, setB1Distribution] = useState<B1DistributionConfig>({ type: 'dephasing' });
  const [filterOffsets, setFilterOffsets] = useState<Array<[number, number]>>([]);
  const [filterOffsetsBySpectrum, setFilterOffsetsBySpectrum] = useState<Record<number, Array<[number, number]>>>({});
  const [filterPlanes, setFilterPlanes] = useState<number[]>([]);
  const [dataError, setDataError] = useState<'file' | 'scatter'>('scatter');
  const [cpmgTimeT2, setCpmgTimeT2] = useState<number>(0.04);
  const [cpmgCarrier, setCpmgCarrier] = useState<number>(117.0);

  // Generation & Data
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedExperiments, setGeneratedExperiments] = useState<any[]>([]);
  const [previewFilePath, setPreviewFilePath] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string>('');

  // Profiles
  const [cestProfiles, setCestProfiles] = useState<CestProfile[]>([]);
  const [cpmgProfiles, setCpmgProfiles] = useState<CpmgProfileItem[]>([]);
  const [currentCestProfileIdx, setCurrentCestProfileIdx] = useState<number>(0);
  const [currentCpmgProfileIdx, setCurrentCpmgProfileIdx] = useState<number>(0);
  const [picks, setPicks] = useState<Record<string, CestPick>>({});
  const [pickMode, setPickMode] = useState<'cs_a' | 'cs_b' | 'cs_c'>('cs_a');

  const [residueMapping, setResidueMapping] = useState<Record<string, string>>({});

  // Run & Logs State
  const [logs, setLogs] = useState<string>('');
  const [isFitting, setIsFitting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const logContainerRef = useRef<HTMLDivElement>(null);

  // Results State
  const [analysisResults, setAnalysisResults] = useState<any>(null);
  const committedByStep = useMemo(() => committedGlobalsByStep(analysisResults), [analysisResults]);
  const lastCommitted = useMemo(() => lastCommittedStep(analysisResults), [analysisResults]);
  const [progressInfo, setProgressInfo] = useState<RunProgress | null>(null);
  const [selectedResultResidue, setSelectedResultResidue] = useState<string>('');
  const [selectedResultStep, setSelectedResultStep] = useState<string>('');
  const [fieldColors, setFieldColors] = useState<Record<string, string>>({});
  const [resultsSortColumn, setResultsSortColumn] = useState<'res' | 'dw' | 'redchi' | 'r2'>('res');
  const [resultsSortDirection, setResultsSortDirection] = useState<'asc' | 'desc'>('asc');
  const [resultsSearchQuery, setResultsSearchQuery] = useState<string>('');
  const [resultsViewMode, setResultsViewMode] = useState<'single' | 'grid'>('single');
  const [showStepStats, setShowStepStats] = useState<boolean>(false);

  const nucleusInfo = getNucleusInfoForModule(cestModuleName || 'cest_15n');

  // Filtered spectra by experiment type
  const cestSpectra = useMemo(
    () => allSpectra.filter(s => (s.experiment_type || '').toUpperCase().includes('CEST') && (s.is_fitted ?? true)),
    [allSpectra]
  );
  const cpmgSpectra = useMemo(
    () => allSpectra.filter(s => (s.experiment_type || '').toUpperCase().includes('CPMG') && (s.is_fitted ?? true)),
    [allSpectra]
  );

  // Combined profiles for both CEST and CPMG
  const combinedProfiles = useMemo<CestProfile[]>(() => {
    const map = new Map<string, CestProfile>();
    for (const p of cestProfiles) {
      map.set(p.residue, p);
    }
    for (const cp of cpmgProfiles) {
      if (!map.has(cp.residue)) {
        map.set(cp.residue, {
          residue: cp.residue,
          full_residue: cp.full_residue || cp.residue,
          experiments: [],
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => {
      const numA = parseInt(a.residue.replace(/\D/g, ''), 10) || 0;
      const numB = parseInt(b.residue.replace(/\D/g, ''), 10) || 0;
      return numA - numB;
    });
  }, [cestProfiles, cpmgProfiles]);

  const notify = (msg: string, ms = 3000) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(''), ms);
  };

  /** Profiles shown in the Parameters table: CEST profile, else the CPMG dispersion. */
  const tableProfiles = useMemo<ProfileRef[]>(() => {
    const cestKeys = new Set(cestProfiles.map(p => p.residue));
    return [...cestProfiles, ...cpmgProfiles.filter(p => !cestKeys.has(p.residue))];
  }, [cestProfiles, cpmgProfiles]);

  // ── Parameters & Methods (shared ChemEx editors) ──
  const parameterEditor = useParameterEditor({
    createDefault: exchangePlugin.parameters.createDefaultParameters,
    codec: exchangePlugin.parameters.codec,
    profiles: combinedProfiles,
    picks: picks as any,
  });
  const { parameterConfig, setParameterConfig } = parameterEditor;

  const residueItems: ResidueItem[] = useMemo(() => {
    const withData = new Set([...cestProfiles.map(p => p.residue), ...cpmgProfiles.map(p => p.residue)]);
    const keys = sortSpinKeys(Array.from(new Set([...Object.keys(parameterConfig.residues || {}), ...withData])));
    return keys
      .filter(k => !isResidueExcluded(parameterConfig, k, combinedProfiles))
      .map(k => ({
        id: k,
        number: parseInt(k.replace(/\D/g, ''), 10) || 0,
        label: residueMapping[k] || k,
        hasData: withData.has(k),
        hasMinorPick: minorPickFlag(picks, k),
      }));
  }, [parameterConfig, cestProfiles, cpmgProfiles, combinedProfiles, residueMapping, picks]);

  const runLocked = isRunActive(status, isFitting);
  const methodEditor = useMethodEditor({
    onCatalog: parameterEditor.setCatalog,
    projectUuid,
    analysisUuid: analysis.analysis_uuid,
    family: exchangePlugin.endpointFamily,
    model,
    residueItems,
    isResidueExcluded: parameterEditor.isExcluded,
    exclusionKey: parameterConfig.excludedResidues,
    inputsKey: experimentsFingerprint(generatedExperiments),
    locked: runLocked,
    parameterToml: parameterEditor.effectiveParameterToml,
    notify,
  });
  const { methodConfig } = methodEditor;
  const effectiveParameterToml = parameterEditor.effectiveParameterToml;
  const effectiveMethodToml = methodEditor.effectiveMethodToml;
  const staleParamCount = parameterEditor.staleResidues.length;

  const [lastRunConfigHash, setLastRunConfigHash] = useState('');
  const [lastRunTimestamp, setLastRunTimestamp] = useState('');
  const currentConfigHash = chemexConfigHash({
    parameterToml: effectiveParameterToml,
    methodToml: effectiveMethodToml,
    model,
    fitMode: 'global',
  });
  const isConfigChangedSinceRun = status === 'COMPLETED' && !!lastRunConfigHash && currentConfigHash !== lastRunConfigHash;
  const lineageInfo = useMemo(() => findLineage(parameterConfig), [parameterConfig]);
  const sourceRunStillExists = !!lineageInfo && (_allAnalyses || []).some((a: any) => a.analysis_uuid === lineageInfo.sourceRunId);
  const catalogGlobals = useMemo(
    () => methodEditor.availableParamsMeta.filter(p => p.scope === 'global').map(p => p.name),
    [methodEditor.availableParamsMeta]
  );

  /** Parameters/Methods payload shared by save and run (same keys on every ChemEx page). */
  const chemexPayload = (overrides: { last_run_hash?: string; last_run_timestamp?: string } = {}) => ({
    parameter_toml: effectiveParameterToml,
    parameter_config: parameterEditor.parameterConfigForSave,
    method_toml: effectiveMethodToml,
    method_config: methodEditor.methodConfigForSave,
    model,
    last_run_hash: overrides.last_run_hash ?? lastRunConfigHash,
    last_run_timestamp: overrides.last_run_timestamp ?? lastRunTimestamp,
  });

  // Load existing config and results on mount
  useEffect(() => {
    loadExchangeConfig();
    if (analysis.status === 'COMPLETED') {
      loadResults();
    }
  }, [analysis.analysis_uuid]);

  useEffect(() => {
    if (analysisResults && analysisResults.residues) {
      const uniqueLabels = new Set<string>();
      Object.values(analysisResults.residues).forEach((res: any) => {
        res.experiments?.forEach((exp: any) => {
          if (exp.b1_label) uniqueLabels.add(exp.b1_label);
          else if (exp.b0) uniqueLabels.add(`${exp.b0}MHz`);
          else if (exp.exp_name) uniqueLabels.add(exp.exp_name);
        });
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

  // Poll logs when RUNNING or PENDING
  useEffect(() => {
    let interval: number;
    if (status === 'RUNNING' || status === 'PENDING') {
      fetchLogs();
      interval = window.setInterval(fetchLogs, 2000);
    }
    return () => clearInterval(interval);
  }, [status, analysis.analysis_uuid]);

  // Auto-scroll logs
  useEffect(() => {
    if (activeTab === 'logs' && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, activeTab]);

  const loadExchangeConfig = async () => {
    try {
      const res = await api.get(`/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/exchange/config`);
      const cfg = res.data;
      if (!cfg || Object.keys(cfg).length === 0) return;

      if (cfg.spectrum_ids) setSelectedSpectrumIds(cfg.spectrum_ids);
      if (cfg.model) setModel(cfg.model);
      if (cfg.use_height !== undefined) setUseHeight(cfg.use_height);
      if (cfg.cest_module_name) setCestModuleName(cfg.cest_module_name);
      if (cfg.cpmg_module_name) setCpmgModuleName(cfg.cpmg_module_name);
      if (cfg.generatedExperiments) setGeneratedExperiments(cfg.generatedExperiments);
      if (cfg.cest_profiles) setCestProfiles(cfg.cest_profiles);
      if (cfg.cpmg_profiles) setCpmgProfiles(cfg.cpmg_profiles);
      if (cfg.residue_mapping) setResidueMapping(cfg.residue_mapping);
      if (cfg.picks) setPicks(cfg.picks);

      if (cfg.last_run_hash) setLastRunConfigHash(cfg.last_run_hash);
      if (cfg.last_run_timestamp) setLastRunTimestamp(cfg.last_run_timestamp);
      const savedCombined: ProfileRef[] = [...(cfg.cest_profiles || []), ...(cfg.cpmg_profiles || [])];
      parameterEditor.restore(cfg, savedCombined);
      methodEditor.restore(cfg);
    } catch (e) {
      console.warn("No previous exchange config loaded or error:", e);
    } finally {
      // Also when nothing was saved yet (early return above): the loaded state is the baseline.
      markClean();
    }
  };

  const loadResults = async () => {
    try {
      const res = await api.get(`/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/results`);
      if (res.data && res.data.results) {
        const payload = res.data.results;
        setAnalysisResults(payload);
        const effectiveStep = selectedResultStep || payload.primary_step || (payload.step_order ? payload.step_order[payload.step_order.length - 1] : '') || '';
        if (!selectedResultStep && effectiveStep) {
          setSelectedResultStep(effectiveStep);
        }
        const effectiveRes = (effectiveStep && payload.steps?.[effectiveStep]?.residues) || payload.residues || {};
        const resList = Object.keys(effectiveRes);
        if (resList.length > 0 && (!selectedResultResidue || !effectiveRes[selectedResultResidue])) {
          setSelectedResultResidue(resList[0]);
        }
      }
    } catch (e) {
      console.error("Failed to load exchange analysis results:", e);
    }
  };

  const handleStepSelect = (stepName: string) => {
    setSelectedResultStep(stepName);
    const targetStepObj = analysisResults?.steps?.[stepName];
    const effectiveRes = targetStepObj?.residues || analysisResults?.residues;
    if (effectiveRes && Object.keys(effectiveRes).length > 0) {
      if (!selectedResultResidue || !effectiveRes[selectedResultResidue]) {
        setSelectedResultResidue(Object.keys(effectiveRes)[0]);
      }
    }
  };

  const fetchLogs = async () => {
    try {
      const res = await api.get(`/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/exchange/logs`);
      setLogs(res.data.logs || '');
      const incoming = res.data.status;
      const terminal = ['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED'].includes(incoming);
      setProgressInfo(res.data.progress && !terminal ? res.data.progress : null);
    } catch (error) {
      console.error('Error fetching logs', error);
    }
  };

  const toggleSpectrumSelection = (id: number) => {
    setSelectedSpectrumIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  // Generate Data Files
  const handleGenerate = async () => {
    if (selectedSpectrumIds.length === 0) return;
    setIsGenerating(true);
    try {
      const payload = {
        spectrum_ids: selectedSpectrumIds,
        model,
        use_height: useHeight,
        cest_module_name: cestModuleName,
        cpmg_module_name: cpmgModuleName,
        b1_distribution: b1Distribution,
        filter_offsets: filterOffsets,
        filter_offsets_by_spectrum: filterOffsetsBySpectrum,
        data_error: dataError,
        cpmg_time_t2: cpmgTimeT2,
        cpmg_carrier: cpmgCarrier,
        picks: picks,
        excluded_residues: parameterConfig.excludedResidues || [],
      };

      const res = await api.post(`/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/exchange/generate`, payload);
      const data = res.data;

      setGeneratedExperiments(data.experiments || []);
      const newCest = data.cest_profiles || [];
      const newCpmg = data.cpmg_profiles || [];
      setCestProfiles(newCest);
      setCpmgProfiles(newCpmg);
      if (data.residue_mapping) setResidueMapping(data.residue_mapping);
      if (data.picks) setPicks(data.picks);

      // Build next combined profiles
      const map = new Map<string, CestProfile>();
      for (const p of newCest) map.set(p.residue, p);
      for (const cp of newCpmg) {
        if (!map.has(cp.residue)) {
          map.set(cp.residue, {
            residue: cp.residue,
            full_residue: cp.full_residue || cp.residue,
            experiments: [],
          });
        }
      }
      const nextCombined = Array.from(map.values());
      const base = (data.parameter_config && Object.keys(data.parameter_config.residues || {}).length > 0)
        ? data.parameter_config
        : parameterConfig;
      parameterEditor.replaceConfig(canonicalizeParameterConfig(base, nextCombined));

      onUpdate?.();
      setSuccessMsg("Exchange experiment files generated successfully!");
      setTimeout(() => setSuccessMsg(''), 4000);
    } catch (err: any) {
      console.error("Generate failed:", err);
      const detail = err.response?.data?.detail || err.message || "Failed to generate experiments";
      setError(`Generation failed: ${detail}`);
      setTimeout(() => setError(''), 5000);
    } finally {
      setIsGenerating(false);
    }
  };

  // Save Configuration
  const savePayload = {
    spectrum_ids: selectedSpectrumIds,
    use_height: useHeight,
    cest_module_name: cestModuleName,
    cpmg_module_name: cpmgModuleName,
    b1_distribution: b1Distribution,
    filter_offsets: filterOffsets,
    filter_offsets_by_spectrum: filterOffsetsBySpectrum,
    filter_planes: filterPlanes,
    data_error: dataError,
    cpmg_time_t2: cpmgTimeT2,
    cpmg_carrier: cpmgCarrier,
    picks,
    ...chemexPayload(),
    excluded_residues: parameterConfig.excludedResidues || [],
  };
  const { dirty: unsaved, markClean } = useUnsavedChanges(savePayload);

  const saveConfig = async () => {
    try {
      await api.put(`/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/exchange/config`, savePayload);
      markClean();
      setSuccessMsg('Configuration saved successfully');
      setTimeout(() => setSuccessMsg(''), 4000);
    } catch (err: any) {
      console.error('Failed to save configuration:', err);
      setError(err.response?.data?.detail || err.message || 'Failed to save configuration');
      setTimeout(() => setError(''), 5000);
    }
  };

  // Run / Start Fit
  const handleStartFit = async () => {
    if (methodEditor.blockingErrors.length > 0) {
      setError(`Cannot run ChemEx: ${methodEditor.blockingErrors[0].message}`);
      return;
    }
    if (status === 'COMPLETED' && !window.confirm(RERUN_CONFIRM_MESSAGE)) return;
    setIsFitting(true);
    try {
      const validationError = await preflightChemexValidation({
        projectUuid,
        analysisUuid: analysis.analysis_uuid,
        parameterToml: effectiveParameterToml,
        methodToml: effectiveMethodToml,
        model,
      });
      if (validationError) {
        setError(validationError);
        return;
      }

      const runHash = currentConfigHash;
      const runTime = new Date().toLocaleString();
      setLastRunConfigHash(runHash);
      setLastRunTimestamp(runTime);

      await api.post(`/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/exchange/run`, {
        spectrum_ids: selectedSpectrumIds,
        ...chemexPayload({ last_run_hash: runHash, last_run_timestamp: runTime }),
      });

      setStatus('PENDING');
      setActiveTab('logs');
      onStatusChange?.('PENDING');
      onUpdate?.();
      userRuns?.refreshRuns();
    } catch (err: any) {
      console.error("Start fit error:", err);
      const detail = err.response?.data?.detail || err.message || "Failed to start fit";
      setError(`Start fit failed: ${detail}`);
      setTimeout(() => setError(''), 5000);
    } finally {
      setIsFitting(false);
    }
  };

  // Cancel Fit
  const handleCancelFit = async () => {
    setIsCancelling(true);
    try {
      await api.post(`/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/exchange/cancel`);
      setStatus('CANCELLING');
      onStatusChange?.('CANCELLING');
      onUpdate?.();
      userRuns?.refreshRuns();
    } catch (err: any) {
      console.error("Cancel failed:", err);
      setError("Failed to cancel fit");
      setTimeout(() => setError(''), 5000);
    } finally {
      setIsCancelling(false);
    }
  };

  const handleContinueRun = async () => {
    try {
      setIsFitting(true);
      setError('');
      const res = await api.post(`/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/continue`);
      onUpdate?.();
      userRuns?.refreshRuns();
      if (res.data?.analysis_uuid) {
        navigate(`/projects/${projectUuid}/analysis/${res.data.analysis_uuid}`);
      }
    } catch (err: any) {
      setError(err.response?.data?.detail || "Failed to continue from this run.");
    } finally {
      setIsFitting(false);
    }
  };

  // Restore Backup
  const handleRestoreBackup = async () => {
    if (!confirm("Are you sure you want to restore the previous run? Current results will be overwritten.")) return;
    setIsRestoring(true);
    try {
      await api.post(`/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/exchange/restore`);
      await loadResults();
      onUpdate?.();
      setSuccessMsg("Restored previous run successfully!");
      setTimeout(() => setSuccessMsg(''), 4000);
    } catch (err: any) {
      console.error("Restore failed:", err);
      setError("Failed to restore backup");
      setTimeout(() => setError(''), 5000);
    } finally {
      setIsRestoring(false);
    }
  };

  // Pick CEST handlers
  const currentCestProfile = cestProfiles[currentCestProfileIdx];
  const currentPick = currentCestProfile ? picks[currentCestProfile.residue] : null;

  const handlePickCestClick = (event: any) => {
    if (!currentCestProfile) return;
    const res = currentCestProfile.residue;
    let x: number | undefined = event.points?.[0]?.x;
    if (event.event && event.points?.[0]?.xaxis) {
      const xaxis = event.points[0].xaxis;
      const xPixel = event.event.layerX - (xaxis._offset || 0);
      const preciseX = xaxis.p2c(xPixel);
      if (preciseX !== undefined && !isNaN(preciseX)) x = preciseX;
    }
    if (x === undefined) return;

    const existing = picks[res] || { cs_a: null, cs_b: null, cs_c: null, cs_d: null, cs_e: null, cs_f: null };
    const updated = { ...existing, [pickMode]: x };
    setPicks(prev => ({ ...prev, [res]: updated }));

    const pickHash = computePickHash(updated);
    const nowIso = new Date().toISOString();

    // Sync to parameterConfig
    setParameterConfig(prev => {
      const curRes = prev.residues[res] || {};
      const updatedRes = { ...curRes };
      if (pickMode === 'cs_a') {
        updatedRes.cs_a = withValue(updatedRes.cs_a, x, { kind: 'pick', pickSetHash: pickHash, at: nowIso });
      } else if (pickMode === 'cs_b') {
        updatedRes.cs_b = withValue(updatedRes.cs_b, x, { kind: 'pick', pickSetHash: pickHash, at: nowIso });
        const csA = updatedRes.cs_a?.value;
        if (csA !== undefined) {
          updatedRes.dw_ab = withValue(updatedRes.dw_ab, x - csA, { kind: 'pick', pickSetHash: pickHash, at: nowIso });
        }
      } else if (pickMode === 'cs_c') {
        updatedRes.cs_c = withValue(updatedRes.cs_c, x, { kind: 'pick', pickSetHash: pickHash, at: nowIso });
        const csA = updatedRes.cs_a?.value;
        if (csA !== undefined) {
          updatedRes.dw_ac = withValue(updatedRes.dw_ac, x - csA, { kind: 'pick', pickSetHash: pickHash, at: nowIso });
        }
      }
      return {
        ...prev,
        residues: {
          ...prev.residues,
          [res]: updatedRes,
        },
      };
    });

    const stateMatch = model.match(/^(\d)st/);
    const numStates = stateMatch ? parseInt(stateMatch[1], 10) : 2;
    const modes: Array<'cs_a' | 'cs_b' | 'cs_c'> = ['cs_a', 'cs_b', 'cs_c'];
    const currentModeIdx = modes.indexOf(pickMode);
    const nextModeIdx = (currentModeIdx + 1) % numStates;
    setPickMode(modes[nextModeIdx]);
  };

  const cyclePickMode = () => {
    const stateMatch = model.match(/^(\d)st/);
    const numStates = stateMatch ? parseInt(stateMatch[1], 10) : 2;
    const modes: Array<'cs_a' | 'cs_b' | 'cs_c'> = ['cs_a', 'cs_b', 'cs_c'];
    const currentModeIdx = modes.indexOf(pickMode);
    const nextModeIdx = (currentModeIdx + 1) % numStates;
    setPickMode(modes[nextModeIdx]);
  };

  const handleToggleExcludeResidue = parameterEditor.toggleExclude;

  // Inspect Dispersion handlers
  const handleSeedSingleDw = (resKey: string, dwPpm: number) => {
    setParameterConfig(prev => {
      const curRes = prev.residues[resKey] || {};
      return {
        ...prev,
        residues: {
          ...prev.residues,
          [resKey]: {
            ...curRes,
            dw_ab: withValue(curRes.dw_ab, dwPpm, { kind: 'manual', at: new Date().toISOString() }),
          },
        },
      };
    });
  };

  const handleBulkSeedDw = (seeds: Record<string, number>) => {
    setParameterConfig(prev => {
      const nextRes = { ...prev.residues };
      for (const [resKey, dwVal] of Object.entries(seeds)) {
        nextRes[resKey] = {
          ...(nextRes[resKey] || {}),
          dw_ab: withValue(nextRes[resKey]?.dw_ab, dwVal, { kind: 'manual', at: new Date().toISOString() }),
        };
      }
      return { ...prev, residues: nextRes };
    });
  };

  const handleBulkSetExcluded = parameterEditor.addExcluded;

  // Styles
  const tabCls = (key: TabKey) =>
    `flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 whitespace-nowrap w-auto md:w-full ${
      isSidebarCollapsed ? 'md:justify-center' : 'md:justify-start'
    } ${
      activeTab === key
        ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400 font-semibold text-base scale-[1.03] shadow-sm border border-blue-100/50 dark:border-blue-900/50'
        : 'text-sm text-slate-600 hover:text-slate-900 hover:bg-slate-50 dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800/50'
    }`;

  const sectionCls = "bg-slate-50 dark:bg-slate-800/50 p-5 rounded-xl border border-slate-200 dark:border-slate-700";
  const btnPrimary = "px-4 py-2 bg-blue-600 hover:bg-blue-700 dark:bg-indigo-600 dark:hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-all shadow-sm disabled:opacity-50";
  const btnSecondary = "px-4 py-2 bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 text-sm font-medium rounded-lg transition-all";
  const inputCls = "w-full text-sm px-3 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-slate-800 dark:text-slate-200";

  return (
    <div className="space-y-6">
      {/* Top Banner & Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white dark:bg-slate-800 p-4 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100">{analysis.name}</h2>
          <span className={`px-2 py-0.5 rounded-full text-xs font-bold border ${STATUS_COLORS[status] || 'bg-slate-100'}`}>
            {status}
          </span>
          <span className="px-2.5 py-0.5 rounded-full text-[10px] font-extrabold tracking-wider uppercase border bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 border-indigo-200 dark:border-indigo-800">
            Combined Exchange (CEST + CPMG)
          </span>
          {runLocked && progressInfo && <LiveRunBadge progress={progressInfo} />}
          <StaleStartingValuesBadge count={staleParamCount} noun="pick" onClick={() => setActiveTab('parameters')} />
          <ConfigChangedBadge show={isConfigChangedSinceRun} />
          <LineageBadge lineage={lineageInfo} projectUuid={projectUuid} sourceExists={sourceRunStillExists} />
          {lastCommitted && (
            <LastCommittedBadge stepName={lastCommitted.name} redchi={lastCommitted.redchi} at={analysis.completed_at} />
          )}
        </div>

        {/* Global Action Buttons */}
        <div className="flex flex-wrap items-center gap-2">
          {(status === 'RUNNING' || status === 'PENDING' || status === 'CANCELLING') && (
            <button
              onClick={handleCancelFit}
              disabled={isCancelling || status === 'CANCELLING'}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-red-50 hover:bg-red-100 text-red-700 text-xs font-bold rounded-lg border border-red-200 transition-all shadow-sm disabled:opacity-50"
            >
              <Square size={13} fill="currentColor" /> {isCancelling || status === 'CANCELLING' ? 'Cancelling...' : 'Stop Run'}
            </button>
          )}

          <StartingValuesMenu
            overview={methodEditor.runOverview.overview}
            parameterConfig={parameterConfig}
            onApply={(next, message) => {
              setParameterConfig(next);
              notify(message, 5000);
            }}
            onContinueFromRun={status === 'COMPLETED' ? handleContinueRun : undefined}
            disabled={isFitting}
          />

          {analysis.has_backup && (
            <button
              onClick={handleRestoreBackup}
              disabled={isRestoring || isFitting}
              className="flex items-center gap-1 px-2.5 py-1.5 bg-amber-50 hover:bg-amber-100 text-amber-800 dark:text-amber-700 text-xs font-bold rounded-lg border border-amber-200 dark:border-amber-300 transition-all disabled:opacity-50"
              title="Swap the current results with the previous run's results (backup). Starting values are not changed."
            >
              <RotateCcw size={13} />
              <span>Restore previous results</span>
            </button>
          )}

          <SaveButton dirty={unsaved} onSave={saveConfig} className={btnSecondary} />

          <button
            onClick={handleStartFit}
            disabled={isFitting || status === 'RUNNING' || status === 'PENDING' || methodEditor.blockingErrors.length > 0}
            title={methodEditor.blockingErrors.length > 0 ? `Cannot run: ${methodEditor.blockingErrors[0].message}` : undefined}
            className={`${btnPrimary} flex items-center gap-1`}
          >
            {isFitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5 fill-current" />}
            <span>{isFitting ? 'Running...' : 'Run ChemEx'}</span>
          </button>
        </div>
      </div>

      {/* Messages */}
      {error && (
        <div className="p-3 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/60 rounded-xl text-xs text-red-700 dark:text-red-300 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
          <button onClick={() => setError('')} className="hover:opacity-75">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
      {successMsg && (
        <div className="p-3 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/60 rounded-xl text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
          <Check className="w-4 h-4 shrink-0" />
          <span>{successMsg}</span>
        </div>
      )}

      {/* Main Layout: Left Sidebar Tab Bar + Right Content */}
      <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden shadow-sm flex flex-col md:flex-row min-h-[600px]">
        {/* Sidebar */}
        <div className={`${isSidebarCollapsed ? 'w-full md:w-20' : 'w-full md:w-64'} flex-shrink-0 border-b md:border-b-0 md:border-r border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-900/10 p-4 flex flex-row md:flex-col gap-2 overflow-x-auto md:overflow-x-visible transition-all duration-300`}>
          <button onClick={() => setActiveTab('experiments')} className={tabCls('experiments')} title="Experiments">
            <img src={nmrSpectraIcon} className="w-7 h-7 min-w-[28px] aspect-square object-cover rounded-lg flex-shrink-0 shadow-sm border border-slate-200 dark:border-slate-700" alt="" />
            <span className={isSidebarCollapsed ? 'md:hidden' : 'md:inline'}>Experiments</span>
            {generatedExperiments.length > 0 && !isSidebarCollapsed && (
              <span className="ml-auto px-1.5 py-0.5 bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 rounded-full text-[10px]">
                {generatedExperiments.length}
              </span>
            )}
          </button>

          <button onClick={() => setActiveTab('pick_cest')} className={tabCls('pick_cest')} title="Pick CEST">
            <img src={atomSpinIcon} className="w-7 h-7 min-w-[28px] aspect-square object-cover rounded-lg flex-shrink-0 shadow-sm border border-slate-200 dark:border-slate-700" alt="" />
            <span className={isSidebarCollapsed ? 'md:hidden' : 'md:inline'}>Pick CEST</span>
            {cestProfiles.length > 0 && !isSidebarCollapsed && (
              <span className="ml-auto px-1.5 py-0.5 bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 rounded-full text-[10px]">
                {cestProfiles.length}
              </span>
            )}
          </button>

          <button onClick={() => setActiveTab('dispersion')} className={tabCls('dispersion')} title="Inspect Dispersion">
            <img src={atomSpinIcon} className="w-7 h-7 min-w-[28px] aspect-square object-cover rounded-lg flex-shrink-0 shadow-sm border border-slate-200 dark:border-slate-700" alt="" />
            <span className={isSidebarCollapsed ? 'md:hidden' : 'md:inline'}>Inspect Dispersion</span>
            {cpmgProfiles.length > 0 && !isSidebarCollapsed && (
              <span className="ml-auto px-1.5 py-0.5 bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 rounded-full text-[10px]">
                {cpmgProfiles.length}
              </span>
            )}
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

          {(status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED' || analysisResults) && (
            <button onClick={() => { setActiveTab('results'); if (!analysisResults) loadResults(); }} className={tabCls('results')} title="Results">
              <img src={peakFittingIcon} className="w-7 h-7 min-w-[28px] aspect-square object-cover rounded-lg flex-shrink-0 shadow-sm border border-slate-200 dark:border-slate-700" alt="" />
              <span className={isSidebarCollapsed ? 'md:hidden' : 'md:inline'}>Results</span>
            </button>
          )}

          {/* Collapse toggle at bottom */}
          <div className="hidden md:flex flex-grow flex-col justify-end mt-4">
            <button
              onClick={() => {
                const newVal = !isSidebarCollapsed;
                setIsSidebarCollapsed(newVal);
                try {
                  localStorage.setItem('resoFlow_sidebar_collapsed', String(newVal));
                } catch {
                  /* storage unavailable (private mode): keep the in-memory toggle */
                }
              }}
              className="flex items-center gap-2 p-2 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs w-full justify-center transition-colors"
              title={isSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {isSidebarCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
              {!isSidebarCollapsed && <span>Collapse Sidebar</span>}
            </button>
          </div>
        </div>

        {/* Right Content Area */}
        <div className="flex-1 p-6 overflow-y-auto">

      {/* Tab 1: Experiments Setup */}
      {activeTab === 'experiments' && (
        <div className="space-y-6 animate-in fade-in">
          {/* Global Experiment Config */}
          <div className={sectionCls}>
            <h3 className="text-sm font-bold text-slate-800 dark:text-slate-200 mb-4 flex items-center gap-2">
              <Sliders className="w-4 h-4 text-blue-600" />
              <span>Global Exchange Fit Settings</span>
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">Kinetic Exchange Model</label>
                <select value={model} onChange={e => setModel(e.target.value)} className={inputCls}>
                  {KINETIC_MODELS.map(m => <option key={m} value={m}>{m} State</option>)}
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">Intensity Metric</label>
                <select value={useHeight ? 'height' : 'amp'} onChange={e => setUseHeight(e.target.value === 'height')} className={inputCls}>
                  <option value="height">Peak Height (Default)</option>
                  <option value="amp">Peak Amplitude / Volume</option>
                </select>
              </div>

              <div className="flex items-end">
                <button
                  onClick={handleGenerate}
                  disabled={isGenerating || selectedSpectrumIds.length === 0}
                  className={`w-full ${btnPrimary} py-2.5 flex items-center justify-center gap-2`}
                >
                  {isGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Beaker className="w-4 h-4" />}
                  <span>{isGenerating ? 'Generating Experiment Files...' : 'Generate Experiment Files'}</span>
                </button>
              </div>
            </div>
          </div>

          {/* Dual Experiment Columns: CEST & CPMG */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* CEST Column */}
            <div className="space-y-6">
              <div className={sectionCls}>
                <div className="flex items-center justify-between mb-4">
                  <h4 className="text-sm font-bold text-blue-600 dark:text-blue-400 flex items-center gap-2">
                    <Activity className="w-4 h-4" />
                    <span>CEST Experiments Setup</span>
                  </h4>
                  <span className="text-xs text-slate-500 font-semibold">{cestSpectra.length} available</span>
                </div>

                <div className="mb-4">
                  <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">CEST ChemEx Module</label>
                  <select value={cestModuleName} onChange={e => setCestModuleName(e.target.value)} className={inputCls}>
                    <option value="cest_15n">cest_15n (15N standard CEST)</option>
                    <option value="cest_13c">cest_13c (13C standard CEST)</option>
                    <option value="cest_1h">cest_1h (1H standard CEST)</option>
                  </select>
                </div>

                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-2">Select CEST Spectra</label>
                <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                  {cestSpectra.map(s => (
                    <label
                      key={s.id}
                      className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all ${
                        selectedSpectrumIds.includes(s.id)
                          ? 'border-blue-400 bg-blue-50/60 dark:bg-blue-900/20'
                          : 'border-slate-200 dark:border-slate-800 hover:border-slate-300'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={selectedSpectrumIds.includes(s.id)}
                        onChange={() => toggleSpectrumSelection(s.id)}
                        className="w-4 h-4 accent-blue-600 rounded"
                      />
                      <div className="flex-1 min-w-0">
                        <span className="text-xs font-bold text-slate-800 dark:text-slate-200 block truncate">{s.name}</span>
                        <div className="flex gap-3 text-[10px] text-slate-500 mt-0.5">
                          {s.b0 != null && <span>B0: {s.b0} MHz</span>}
                          {s.b1 != null && <span>B1: {s.b1} Hz</span>}
                        </div>
                      </div>
                    </label>
                  ))}
                  {cestSpectra.length === 0 && (
                    <p className="text-xs text-slate-500 italic p-3">No CEST spectra in this project.</p>
                  )}
                </div>
              </div>

              {/* CEST B1 Distribution & Filter Controls */}
              <NestedConfigGroup
                distribution={b1Distribution}
                onChangeDistribution={d => setB1Distribution(d)}
              />
              <ProfileFilterControls
                selectedSpectra={cestSpectra.filter(s => selectedSpectrumIds.includes(s.id))}
                filterOffsetsBySpectrum={filterOffsetsBySpectrum}
                onChangeFilterOffsetsForSpectrum={(specId, offsets) => setFilterOffsetsBySpectrum(prev => ({ ...prev, [specId]: offsets }))}
                onResetOffsetsForSpectrum={specId => {
                  setFilterOffsetsBySpectrum(prev => {
                    const next = { ...prev };
                    delete next[specId];
                    return next;
                  });
                }}
                filterOffsets={filterOffsets}
                onChangeFilterOffsets={offsets => setFilterOffsets(offsets)}
                filterPlanes={filterPlanes}
                onChangeFilterPlanes={planes => setFilterPlanes(planes)}
                dataError={dataError}
                onChangeDataError={err => setDataError(err)}
              />
            </div>

            {/* CPMG Column */}
            <div className="space-y-6">
              <div className={sectionCls}>
                <div className="flex items-center justify-between mb-4">
                  <h4 className="text-sm font-bold text-emerald-600 dark:text-emerald-400 flex items-center gap-2">
                    <Sliders className="w-4 h-4" />
                    <span>CPMG Experiments Setup</span>
                  </h4>
                  <span className="text-xs text-slate-500 font-semibold">{cpmgSpectra.length} available</span>
                </div>

                <div className="mb-4">
                  <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">CPMG ChemEx Module</label>
                  <select value={cpmgModuleName} onChange={e => setCpmgModuleName(e.target.value)} className={inputCls}>
                    <option value="cpmg_15n_ip">cpmg_15n_ip (15N In-Phase CPMG)</option>
                    <option value="cpmg_15n_ap">cpmg_15n_ap (15N Anti-Phase CPMG)</option>
                    <option value="cpmg_13c_ap">cpmg_13c_ap (13C Anti-Phase CPMG)</option>
                    <option value="cpmg_1h_ip">cpmg_1h_ip (1H In-Phase CPMG)</option>
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-3 mb-4">
                  <div>
                    <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">T-Relax (s)</label>
                    <input
                      type="number"
                      step="0.005"
                      value={cpmgTimeT2}
                      onChange={e => setCpmgTimeT2(parseFloat(e.target.value) || 0.04)}
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">Carrier (ppm)</label>
                    <input
                      type="number"
                      step="0.5"
                      value={cpmgCarrier}
                      onChange={e => setCpmgCarrier(parseFloat(e.target.value) || 117.0)}
                      className={inputCls}
                    />
                  </div>
                </div>

                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-2">Select CPMG Spectra</label>
                <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                  {cpmgSpectra.map(s => (
                    <label
                      key={s.id}
                      className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all ${
                        selectedSpectrumIds.includes(s.id)
                          ? 'border-emerald-400 bg-emerald-50/60 dark:bg-emerald-900/20'
                          : 'border-slate-200 dark:border-slate-800 hover:border-slate-300'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={selectedSpectrumIds.includes(s.id)}
                        onChange={() => toggleSpectrumSelection(s.id)}
                        className="w-4 h-4 accent-emerald-600 rounded"
                      />
                      <div className="flex-1 min-w-0">
                        <span className="text-xs font-bold text-slate-800 dark:text-slate-200 block truncate">{s.name}</span>
                        <div className="flex gap-3 text-[10px] text-slate-500 mt-0.5">
                          {s.b0 != null && <span>B0: {s.b0} MHz</span>}
                          {s.temperature != null && <span>Temp: {s.temperature} K</span>}
                        </div>
                      </div>
                    </label>
                  ))}
                  {cpmgSpectra.length === 0 && (
                    <p className="text-xs text-slate-500 italic p-3">No CPMG spectra in this project.</p>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Generated Experiments List */}
          {generatedExperiments.length > 0 && (
            <div className={sectionCls}>
              <h4 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-3">Generated Experiment Files</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {generatedExperiments.map((exp, i) => (
                  <div
                    key={i}
                    onClick={() => {
                      setPreviewFilePath(exp.path);
                      setPreviewContent(exp.toml_content || '');
                    }}
                    className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700 rounded-xl text-xs cursor-pointer hover:border-blue-500 hover:shadow-sm transition-all"
                  >
                    <div className="min-w-0 mr-3">
                      <span className="font-mono font-bold text-slate-800 dark:text-slate-200 truncate block">
                        {exp.filename || exp.path?.split('/').pop()}
                      </span>
                      <span className="text-[10px] text-slate-500">
                        {exp.type || 'Experiment'} • {exp.residue_count || 0} residues
                      </span>
                    </div>
                    <span className="text-[10px] font-bold text-blue-600 dark:text-blue-400 shrink-0">
                      View TOML
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tab 2: Pick CEST */}
      {activeTab === 'pick_cest' && (
        <div className="space-y-4 animate-in fade-in">
          {cestProfiles.length > 0 ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setCurrentCestProfileIdx(Math.max(0, currentCestProfileIdx - 1))}
                    disabled={currentCestProfileIdx === 0}
                    className={btnSecondary}
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <select
                    value={currentCestProfileIdx}
                    onChange={e => setCurrentCestProfileIdx(Number(e.target.value))}
                    className={`${inputCls} w-48`}
                  >
                    {cestProfiles.map((p, i) => {
                      const isEx = isResidueExcluded(parameterConfig, p.residue, cestProfiles);
                      return (
                        <option key={i} value={i}>
                          {p.full_residue || p.residue} {isEx ? '(Excluded)' : (picks[p.residue]?.cs_a != null ? '✓' : '')}
                        </option>
                      );
                    })}
                  </select>
                  <button
                    onClick={() => setCurrentCestProfileIdx(Math.min(cestProfiles.length - 1, currentCestProfileIdx + 1))}
                    disabled={currentCestProfileIdx >= cestProfiles.length - 1}
                    className={btnSecondary}
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>

                  {currentCestProfile && (
                    <button
                      type="button"
                      onClick={() => handleToggleExcludeResidue(currentCestProfile.residue)}
                      className={`px-3 py-1.5 rounded-lg border text-xs font-semibold flex items-center gap-1.5 transition-all ${
                        isResidueExcluded(parameterConfig, currentCestProfile.residue, cestProfiles)
                          ? 'bg-rose-50 text-rose-700 border-rose-300 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-700 hover:bg-rose-100 dark:hover:bg-rose-900/50'
                          : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-600 hover:text-rose-600 dark:hover:text-rose-400 hover:border-rose-300'
                      }`}
                      title={
                        isResidueExcluded(parameterConfig, currentCestProfile.residue, cestProfiles)
                          ? 'Include this residue in parameters (uncomment in parameters.toml)'
                          : 'Exclude this residue from parameters (comment out in parameters.toml)'
                      }
                    >
                      {isResidueExcluded(parameterConfig, currentCestProfile.residue, cestProfiles) ? (
                        <PlusCircle className="w-3.5 h-3.5 text-emerald-500" />
                      ) : (
                        <MinusCircle className="w-3.5 h-3.5 text-rose-500" />
                      )}
                      <span>
                        {isResidueExcluded(parameterConfig, currentCestProfile.residue, cestProfiles)
                          ? 'Excluded (Click to Include)'
                          : 'Exclude'}
                      </span>
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={cyclePickMode}
                    className={`text-xs font-bold px-3 py-1 rounded-full border transition-all ${
                      pickMode === 'cs_a'
                        ? 'bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800'
                        : pickMode === 'cs_b'
                        ? 'bg-purple-100 text-purple-700 border-purple-300 dark:bg-purple-900/30 dark:text-purple-400 dark:border-purple-800'
                        : 'bg-emerald-100 text-emerald-700 border-emerald-300 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800'
                    }`}
                    title="Click to cycle pick mode"
                  >
                    Click to set: {pickMode.toUpperCase()}
                  </button>
                  <button
                    onClick={() => {
                      if (currentCestProfileIdx < cestProfiles.length - 1) {
                        setCurrentCestProfileIdx(currentCestProfileIdx + 1);
                        setPickMode('cs_a');
                      }
                    }}
                    className={btnPrimary}
                  >
                    Accept & Next
                  </button>
                </div>
              </div>

              {currentCestProfile && (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                  <div className="lg:col-span-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl p-2">
                    {isResidueExcluded(parameterConfig, currentCestProfile.residue, cestProfiles) && (
                      <div className="mb-2 px-3 py-1.5 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 rounded-lg text-xs text-rose-700 dark:text-rose-300 font-semibold flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <MinusCircle className="w-3.5 h-3.5 text-rose-500 shrink-0" />
                          <span>This residue is excluded and commented out in the ChemEx parameter file.</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleToggleExcludeResidue(currentCestProfile.residue)}
                          className="underline hover:text-rose-900 dark:hover:text-white cursor-pointer ml-2"
                        >
                          Include Residue
                        </button>
                      </div>
                    )}
                    <Plot
                      data={currentCestProfile.experiments.filter(e => !e.error).map((exp, idx) => {
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
                          name: `B1: ${exp.b1_actual || exp.b1} Hz (${exp.b0} MHz)`,
                        };
                      })}
                      layout={{
                        xaxis: { title: `Shift (${nucleusInfo.unitLabel})`, autorange: 'reversed' },
                        yaxis: { title: 'I / I₀', autorange: true },
                        margin: { l: 60, r: 30, t: 40, b: 60 },
                        shapes: [
                          ...((['cs_a', 'cs_b', 'cs_c', 'cs_d', 'cs_e', 'cs_f'] as const).slice(0, parseInt(model || '2')).map((key, idx) => {
                            const val = currentPick?.[key];
                            return val != null ? {
                              type: 'line',
                              x0: val, x1: val, y0: 0, y1: 1, yref: 'paper',
                              line: { color: [PLOT_COLORS.primary, '#ef4444', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6'][idx], width: 2, dash: 'dash' }
                            } : null;
                          }).filter(Boolean) as any),
                        ]
                      }}
                      style={{ width: '100%', height: '400px' }}
                      onClick={handlePickCestClick}
                    />
                  </div>

                  {/* Residue Shifts Table */}
                  <div className="lg:col-span-1 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden h-[416px] flex flex-col">
                    <div className="overflow-auto flex-1">
                      <table className="w-full text-xs text-left">
                        <thead className="sticky top-0 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 font-bold uppercase tracking-wider z-10">
                          <tr>
                            <th className="px-4 py-2">Residue</th>
                            <th className="px-4 py-2">CS_A ({nucleusInfo.unitLabel})</th>
                            <th className="px-4 py-2">CS_B ({nucleusInfo.unitLabel})</th>
                            {parseInt(model || '2') >= 3 && <th className="px-4 py-2">CS_C</th>}
                            <th className="px-4 py-2 text-right">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                          {cestProfiles.map((p, idx) => {
                            const pk = picks[p.residue];
                            const isEx = isResidueExcluded(parameterConfig, p.residue, cestProfiles);
                            return (
                              <tr
                                key={p.residue}
                                onClick={() => setCurrentCestProfileIdx(idx)}
                                className={`cursor-pointer hover:bg-blue-50/50 dark:hover:bg-blue-900/10 ${
                                  isEx
                                    ? 'opacity-60 bg-slate-100/50 dark:bg-slate-900/50'
                                    : currentCestProfile.residue === p.residue
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
                                {parseInt(model || '2') >= 3 && <td className="px-4 py-2">{pk?.cs_c?.toFixed(3) || '—'}</td>}
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
            </>
          ) : (
            <div className="flex flex-col items-center justify-center p-12 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl text-center">
              <Activity className="w-12 h-12 text-slate-400 mb-3" />
              <h4 className="text-sm font-bold text-slate-800 dark:text-slate-200">No CEST Profiles Available</h4>
              <p className="text-xs text-slate-500 mt-1 max-w-sm">
                Select CEST spectra in the Experiments tab and click "Generate Experiment Files" to populate the Pick CEST interactive view.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Tab 3: Inspect Dispersion */}
      {activeTab === 'dispersion' && (
        <div className="space-y-4 animate-in fade-in">
          {cpmgProfiles.length > 0 ? (
            <CpmgDispersionTab
              profiles={cpmgProfiles}
              currentIndex={currentCpmgProfileIdx}
              onSelectIndex={idx => setCurrentCpmgProfileIdx(idx)}
              parameterConfig={parameterConfig as any}
              onToggleExcludeResidue={handleToggleExcludeResidue}
              onBulkSetExcludedResidues={handleBulkSetExcluded}
              onSeedDeltaOmega={handleSeedSingleDw}
              onBulkSeedDeltaOmega={handleBulkSeedDw}
              xiRatio={nucleusInfo.xiRatio}
              unitLabel={nucleusInfo.unitLabel}
            />
          ) : (
            <div className="flex flex-col items-center justify-center p-12 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl text-center">
              <Sliders className="w-12 h-12 text-slate-400 mb-3" />
              <h4 className="text-sm font-bold text-slate-800 dark:text-slate-200">No CPMG Dispersion Profiles Available</h4>
              <p className="text-xs text-slate-500 mt-1 max-w-sm">
                Select CPMG spectra in the Experiments tab and click "Generate Experiment Files" to inspect dispersion curves and seed Δω.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Tab 4: Parameters */}
      {activeTab === 'parameters' && (
        <ParametersTab
          editor={parameterEditor}
          capabilities={exchangePlugin.parameters}
          projectUuid={projectUuid}
          analysisUuid={analysis.analysis_uuid}
          targetAnalysis={{
            analysis_uuid: analysis.analysis_uuid,
            name: analysis.name,
            analysis_type: analysis.analysis_type,
            model,
            nucleus: nucleusInfo.nucleus,
            static_field: combinedProfiles[0]?.experiments?.[0]?.b0 || 600.0,
            temperature: 298.15,
          }}
          picks={picks as any}
          profiles={tableProfiles}
          residueLabels={Object.fromEntries(tableProfiles.map(p => [p.residue, residueMapping[p.residue] || p.full_residue || p.residue]))}
          methodConfig={methodConfig}
          activeStepIdx={methodEditor.activeStepIdx}
          selectedModule={cestModuleName}
          catalogGlobals={catalogGlobals}
          onNavigateToMethods={() => setActiveTab('methods')}
          onApplyInherited={(params, method, newPicks) => {
            parameterEditor.replaceConfig(params);
            if (method) methodEditor.setMethodConfig(method);
            if (newPicks) setPicks(newPicks as any);
          }}
          notify={notify}
        />
      )}

      {activeTab === 'methods' && (
        <MethodsTab
          editor={methodEditor}
          analysisUuid={analysis.analysis_uuid}
          residueItems={residueItems}
          startingValues={parameterEditor.startingValues}
          startingProvenance={startingProvenance(parameterConfig, 'Pick CEST')}
          committedByStep={committedByStep}
          resultsSteps={analysisResults?.steps}
          onNavigateToParameters={() => setActiveTab('parameters')}
          notify={notify}
          readOnly={runLocked}
        />
      )}

      {/* Tab 6: Logs */}
      {activeTab === 'logs' && (
        <div className="space-y-4 animate-in fade-in">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 font-mono text-xs overflow-hidden flex flex-col h-[600px]">
            <div className="flex items-center justify-between pb-4 border-b border-slate-800 mb-4 shrink-0">
              <div className="flex items-center gap-3">
                <span className="text-emerald-400 font-bold uppercase tracking-widest flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
                  <span>{analysis.status}</span>
                </span>
                <span className="text-slate-500">•</span>
                <span className="text-slate-400">UUID: {analysis.analysis_uuid}</span>
              </div>
              <button
                onClick={fetchLogs}
                className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition-colors"
                title="Refresh logs"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>

            <div ref={logContainerRef} className="flex-1 overflow-y-auto space-y-1 text-slate-300 pr-2 custom-scrollbar-terminal">
              <pre className="whitespace-pre-wrap leading-relaxed">
                {logs || '> Waiting for ChemEx logs...'}
              </pre>
            </div>
          </div>
        </div>
      )}

      {/* Tab 7: Results */}
      {activeTab === 'results' && analysisResults && (() => {
        const currentStepData = (selectedResultStep && analysisResults.steps)
          ? analysisResults.steps[selectedResultStep]
          : (analysisResults.step_order && analysisResults.steps
              ? analysisResults.steps[analysisResults.step_order[analysisResults.step_order.length - 1]]
              : null);
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
            const mapped = (analysisResults.residue_mapping?.[k] || residueMapping[k] || k).toLowerCase();
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

        const isCpmgExp = (exp: any) => {
          if (exp.experiment_type === 'cpmg') return true;
          if (exp.experiment_type === 'cest') return false;
          const label = (exp.b1_label || exp.exp_name || '').toLowerCase();
          if (label.includes('cpmg')) return true;
          if (label.includes('cest')) return false;
          const xs = exp.exp_points?.x || exp.nu_cpmg || [];
          if (xs.length > 0 && Math.max(...xs) > 40) return true;
          const ys = exp.exp_points?.y || exp.r2eff || [];
          if (ys.length > 0 && Math.max(...ys) > 1.5) return true;
          return false;
        };

        const resToUse = selectedResultResidue || (resKeys.length > 0 ? resKeys[0] : '');
        const currResObj = activeResidues[resToUse];
        const currParams = currResObj?.parameters || {};

        let csA = currResObj?.cs_a?.value ?? (typeof currParams?.CS_A === 'object' ? currParams?.CS_A?.value : currParams?.CS_A) ?? currParams?.cs_a;
        if (csA == null) {
          const matchingPick = picks[resToUse];
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

        const exps: any[] = currResObj?.experiments || [];
        const cestExps = exps.filter((e: any) => !isCpmgExp(e));
        const cpmgExps = exps.filter((e: any) => isCpmgExp(e));

        // Residuals for CEST
        const cestResidualsData = cestExps.map((exp: any) => {
          const expPts = exp.exp_points || { x: [], y: [], y_err: [] };
          const calcPts = exp.calc_points || exp.fit_curve || { x: [], y: [] };
          const resX: number[] = [];
          const resY: number[] = [];

          if (expPts.x && calcPts.x && expPts.x.length > 0 && calcPts.x.length > 0) {
            for (let i = 0; i < expPts.x.length; i++) {
              const xi = expPts.x[i];
              const yi = expPts.y[i];
              const erri = (expPts.y_err && expPts.y_err[i] > 0) ? expPts.y_err[i] : 1.0;

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
              if (yCalc != null && yi != null) {
                resX.push(xi);
                resY.push((yi - yCalc) / erri);
              }
            }
          }

          return {
            b1_label: exp.b1_label || exp.exp_name || 'CEST',
            x: resX,
            y: resY,
          };
        });

        // Residuals for CPMG
        const cpmgResidualsData = cpmgExps.map((exp: any, expIdx: number) => {
          const expLabel = exp.b1_label || (exp.b0 ? `${exp.b0}MHz` : exp.exp_name || `Exp ${expIdx + 1}`);
          const expX = exp.exp_points?.x || exp.nu_cpmg || [];
          const expY = exp.exp_points?.y || exp.r2eff || [];
          const expErr = exp.exp_points?.y_err || exp.r2eff_err || [];
          const calcPts = exp.calc_points || exp.fit_curve || { x: exp.fit_curve?.nu_cpmg, y: exp.fit_curve?.r2eff };

          const rawResidues: Array<{ nu: number; res: number }> = [];

          if (expX.length > 0 && calcPts.x && calcPts.x.length > 0) {
            for (let i = 0; i < expX.length; i++) {
              const xi = expX[i];
              const yi = expY[i];
              const erri = (expErr && expErr[i] > 0) ? expErr[i] : 1.0;

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
              if (yCalc != null && yi != null) {
                rawResidues.push({ nu: xi, res: (yi - yCalc) / erri });
              }
            }
          }

          rawResidues.sort((a, b) => a.nu - b.nu);

          return {
            b1_label: expLabel,
            x: rawResidues.map(r => r.nu),
            y: rawResidues.map(r => r.res),
          };
        });

        return (
          <div className="space-y-6 animate-in fade-in">
            {/* Results Header & Controls */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-200 dark:border-slate-800">
              <div className="flex items-center gap-3 flex-wrap">
                <h4 className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                  Global Analysis Summary
                </h4>

                {/* Step Selector Dropdown */}
                {analysisResults.is_multi_step && analysisResults.step_order && analysisResults.step_order.length > 1 && (
                  <div className="flex items-center gap-1.5 bg-slate-100 dark:bg-slate-800 px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700 shadow-2xs">
                    <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Step:</span>
                    <select
                      value={selectedResultStep}
                      onChange={(e) => handleStepSelect(e.target.value)}
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
                            {sname} ({sStatus} {badge}){gridTag}{statsTag}
                          </option>
                        );
                      })}
                    </select>
                  </div>
                )}

                {/* Statistics Affordance Button */}
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

              <div className="flex items-center gap-2 self-start sm:self-auto">
                <button
                  onClick={async () => {
                    try {
                      const res = await api.get(`/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/report?style=publication`, { responseType: 'blob' });
                      const url = window.URL.createObjectURL(new Blob([res.data]));
                      const link = document.createElement('a');
                      link.href = url;
                      link.setAttribute('download', `exchange_${analysis.analysis_uuid}_report.pdf`);
                      document.body.appendChild(link);
                      link.click();
                      link.remove();
                    } catch (err) {
                      console.error('Download failed:', err);
                      alert('Failed to download report. Please check if the analysis results exist.');
                    }
                  }}
                  className="px-3.5 py-1.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-lg text-[10px] font-bold flex items-center gap-1.5 transition-all border border-slate-200 dark:border-slate-700 shadow-xs"
                >
                  <FileText className="w-3.5 h-3.5" />
                  Report (PDF)
                </button>

                <button
                  onClick={async () => {
                    try {
                      const res = await api.post(`/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/export-token`, {
                        include_data: false,
                        include_plots: true,
                        include_statistics: true,
                        style: 'publication',
                      });
                      const token = res.data.token;
                      window.location.href = `/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/export?token=${token}`;
                    } catch (err: any) {
                      console.error('Export failed:', err);
                      alert(err.response?.data?.detail || 'Failed to export analysis archive.');
                    }
                  }}
                  disabled={analysis.status !== 'COMPLETED'}
                  title={analysis.status !== 'COMPLETED' ? 'Analysis must be completed to export archive' : 'Download reproducible archive (ZIP)'}
                  className="px-3.5 py-1.5 bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-950/50 dark:hover:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300 rounded-lg text-[10px] font-bold flex items-center gap-1.5 transition-all border border-indigo-200 dark:border-indigo-800 shadow-xs disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download Output (ZIP)
                </button>
              </div>
            </div>

            {/* Step Statistics Drawer */}
            {showStepStats && (
              <div className="animate-in fade-in slide-in-from-top-2 duration-200">
                <StatisticsResultsSection
                  projectUuid={projectUuid!}
                  analysisUuid={analysis.analysis_uuid}
                  uncertaintyStatistics={currentStepData?.statistical_analyses || (analysisResults as any)?.uncertainty_statistics}
                  excludedResidues={parameterConfig.excludedResidues}
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
                  Step '{selectedResultStep}' was not reached
                </h4>
                <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
                  This step was planned in the method configuration, but the fit was interrupted or halted before this step was executed. No parameters or curves were written to disk for this step.
                </p>
              </div>
            ) : (
              <>
                {/* Summary Cards Grid */}
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

                  {/* Card 5: τ_B (Excited state lifetime) */}
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

                  {/* Card 8: AIC */}
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
                {currentStepData?.has_grid && (
                  <GridSearchSection
                    projectUuid={projectUuid!}
                    analysisUuid={analysis.analysis_uuid}
                    stepName={selectedResultStep || analysisResults.step_order?.[0] || 'STEP1'}
                    onApplyStartingParameters={(coords) => {
                      const { nextConfig, updatedCount } = applyGridCoordinatesToConfig(parameterConfig, coords, selectedResultResidue || undefined);
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
                            const isSelected = (selectedResultResidue || resKeys[0]) === res;
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
                                onClick={() => setSelectedResultResidue(res)}
                                title={rChi2Raw != null ? `resoFlow-derived raw χ²*: ${rChi2Raw.toFixed(1)} (DOF = Ndata - Nvarys)` : undefined}
                                className={`cursor-pointer transition-colors ${isSelected ? 'bg-blue-600 text-white font-bold' : 'hover:bg-blue-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300'}`}
                              >
                                <td className="px-3 py-2 font-sans font-medium">
                                  {analysisResults.residue_mapping?.[res] || residueMapping[res] || res}
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
                      Δω from DW_AB; Reduced χ² and R₂ with covariance error bars. τ_B = 1/K_BA is resoFlow-derived.
                    </div>

                    {/* Colors Customization */}
                    <div className="p-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30">
                      <h5 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2 flex items-center justify-between">
                        <span>Fields & Colors</span>
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
                      /* Thumbnail Grid View */
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
                            const rExps = rObj?.experiments || [];
                            const p = rObj?.parameters || {};
                            const dwVal = rObj?.dw_ab?.value ?? (p?.dw_ab as any)?.value ?? p?.dw_ab ?? (p?.DW_AB as any)?.value ?? p?.DW_AB;
                            const rChi2Red = rObj?.chi2_red ?? (p?.chi2_red as any)?.value ?? p?.chi2_red;
                            const rCest = rExps.filter((e: any) => !isCpmgExp(e));
                            const rCpmg = rExps.filter((e: any) => isCpmgExp(e));

                            return (
                              <div
                                key={res}
                                onClick={() => {
                                  setSelectedResultResidue(res);
                                  setResultsViewMode('single');
                                }}
                                className="p-2.5 rounded-xl border border-slate-200 dark:border-slate-800 hover:border-blue-500 hover:shadow-md cursor-pointer transition-all bg-slate-50/50 dark:bg-slate-800/40 group"
                              >
                                <div className="flex items-center justify-between mb-1.5">
                                  <span className="text-xs font-bold text-slate-800 dark:text-white group-hover:text-blue-600">
                                    {analysisResults.residue_mapping?.[res] || residueMapping[res] || res}
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
                                <div className="space-y-1.5 pointer-events-none">
                                  {rCest.length > 0 && (
                                    <div className="w-full h-24">
                                      <Plot
                                        data={rCest.flatMap((exp: any) => {
                                          const color = fieldColors[exp.b1_label || exp.exp_name] || PLOT_COLORS.primary;
                                          const expPoints = exp.exp_points || { x: [], y: [] };
                                          const calcPoints = exp.calc_points || exp.fit_curve || { x: [], y: [] };
                                          return [
                                            {
                                              x: expPoints.x || [],
                                              y: expPoints.y || [],
                                              type: 'scatter',
                                              mode: 'markers',
                                              marker: { color, size: 3.5 },
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
                                          margin: { l: 2, r: 2, t: 2, b: 2 },
                                          paper_bgcolor: 'transparent',
                                          plot_bgcolor: 'transparent',
                                        }}
                                        style={{ width: '100%', height: '100%' }}
                                        config={{ responsive: true, displayModeBar: false }}
                                      />
                                    </div>
                                  )}
                                  {rCpmg.length > 0 && (
                                    <div className="w-full h-24">
                                      <Plot
                                        data={rCpmg.flatMap((exp: any, expIdx: number) => {
                                          const expLabel = exp.b1_label || (exp.b0 ? `${exp.b0}MHz` : exp.exp_name || `Exp ${expIdx + 1}`);
                                          const color = fieldColors[expLabel] || PLOT_COLORS.primary;
                                          const expX = exp.exp_points?.x || exp.nu_cpmg || [];
                                          const expY = exp.exp_points?.y || exp.r2eff || [];
                                          const fitX = exp.fit_curve?.x || exp.fit_curve?.nu_cpmg || exp.calc_points?.x || [];
                                          const fitY = exp.fit_curve?.y || exp.fit_curve?.r2eff || exp.calc_points?.y || [];

                                          const sortedExp = expX.map((nu: number, i: number) => ({ nu, y: expY[i] ?? 0 })).sort((a: any, b: any) => a.nu - b.nu);
                                          const sortedFit = Array.isArray(fitX) ? fitX.map((nu: number, i: number) => ({ nu, y: fitY[i] ?? 0 })).sort((a: any, b: any) => a.nu - b.nu) : [];

                                          return [
                                            {
                                              x: sortedExp.map((p: any) => p.nu),
                                              y: sortedExp.map((p: any) => p.y),
                                              type: 'scatter',
                                              mode: 'markers',
                                              marker: { color, size: 3.5 },
                                              showlegend: false,
                                            },
                                            ...(sortedFit.length > 0 ? [{
                                              x: sortedFit.map((p: any) => p.nu),
                                              y: sortedFit.map((p: any) => p.y),
                                              type: 'scatter',
                                              mode: 'lines',
                                              line: { color, width: 1.5, shape: 'spline' },
                                              showlegend: false,
                                            }] : [])
                                          ];
                                        })}
                                        layout={{
                                          xaxis: { visible: false, autorange: true },
                                          yaxis: { visible: false },
                                          margin: { l: 2, r: 2, t: 2, b: 2 },
                                          paper_bgcolor: 'transparent',
                                          plot_bgcolor: 'transparent',
                                        }}
                                        style={{ width: '100%', height: '100%' }}
                                        config={{ responsive: true, displayModeBar: false }}
                                      />
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ) : (
                      /* Single Detailed Residue Profile & Residuals */
                      <div className="space-y-6">
                        <div className="flex items-center justify-between flex-wrap gap-2 border-b border-slate-100 dark:border-slate-800 pb-3">
                          <div>
                            <h4 className="text-lg font-bold text-slate-900 dark:text-white leading-none mb-1 flex items-center gap-2">
                              <Sparkles className="w-4 h-4 text-blue-600" />
                              <span>{analysisResults.residue_mapping?.[resToUse] || residueMapping[resToUse] || resToUse || 'Select a Residue'}</span>
                            </h4>
                            <p className="text-[10px] font-medium text-slate-500 italic">
                              Combined Exchange Curves: CEST Profile (reversed ppm axis) and CPMG Relaxation Dispersion (forward Hz axis)
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

                        {/* If CEST experiments exist */}
                        {cestExps.length > 0 && (
                          <div className="space-y-3 p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-800/20">
                            <h5 className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider flex items-center gap-2">
                              <span>CEST Profiles (I/I₀ vs Offset)</span>
                              <span className="text-[10px] text-slate-400 font-normal">({cestExps.length} experiments)</span>
                            </h5>

                            {/* Main CEST Plot */}
                            <div className="w-full" style={{ height: '320px' }}>
                              <Plot
                                className="w-full h-full"
                                useResizeHandler={true}
                                style={{ width: '100%', height: '100%' }}
                                data={cestExps.flatMap((exp: any) => {
                                  const color = fieldColors[exp.b1_label || exp.exp_name] || PLOT_COLORS.primary;
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
                                      name: exp.b1_label || exp.exp_name,
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
                                      name: `${exp.b1_label || exp.exp_name} (Fit)`,
                                      line: { color, width: 2.2, shape: 'spline' },
                                      showlegend: false,
                                    }
                                  ];
                                })}
                                layout={{
                                  xaxis: { title: `¹⁵N Offset (${nucleusInfo?.unitLabel || 'ppm'})`, autorange: 'reversed' },
                                  yaxis: { title: 'I / I₀', autorange: true },
                                  margin: { l: 60, r: 30, t: 25, b: 45 },
                                  legend: { orientation: 'h', x: 0.5, xanchor: 'center', y: -0.25 },
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

                            {/* CEST Residuals Strip Plot */}
                            <div className="w-full pt-1 border-t border-slate-100 dark:border-slate-800" style={{ height: '140px' }}>
                              <Plot
                                className="w-full h-full"
                                useResizeHandler={true}
                                style={{ width: '100%', height: '100%' }}
                                data={cestResidualsData.map((resExp: any) => {
                                  const color = fieldColors[resExp.b1_label] || PLOT_COLORS.primary;
                                  return {
                                    x: resExp.x,
                                    y: resExp.y,
                                    type: 'scatter',
                                    mode: 'markers',
                                    name: `${resExp.b1_label} Residuals`,
                                    marker: { color, size: 5, opacity: 0.8 },
                                    showlegend: false,
                                    hovertemplate: `Offset: %{x:.2f} ppm<br>Residual: %{y:.2f} σ<extra>${resExp.b1_label}</extra>`,
                                  };
                                })}
                                layout={{
                                  xaxis: { title: `¹⁵N Offset (${nucleusInfo?.unitLabel || 'ppm'})`, autorange: 'reversed' },
                                  yaxis: { title: 'Res. (σ)', autorange: true, range: [-3.5, 3.5], zeroline: true, zerolinecolor: '#94a3b8' },
                                  margin: { l: 60, r: 30, t: 10, b: 35 },
                                  paper_bgcolor: 'transparent',
                                  plot_bgcolor: 'transparent',
                                  shapes: [
                                    { type: 'line', x0: 0, x1: 1, xref: 'paper', y0: 1, y1: 1, line: { color: '#94a3b8', width: 1, dash: 'dot' } },
                                    { type: 'line', x0: 0, x1: 1, xref: 'paper', y0: -1, y1: -1, line: { color: '#94a3b8', width: 1, dash: 'dot' } },
                                    { type: 'line', x0: 0, x1: 1, xref: 'paper', y0: 2, y1: 2, line: { color: '#ef4444', width: 1, dash: 'dash' } },
                                    { type: 'line', x0: 0, x1: 1, xref: 'paper', y0: -2, y1: -2, line: { color: '#ef4444', width: 1, dash: 'dash' } },
                                  ],
                                }}
                                config={{ responsive: true, displayModeBar: false }}
                              />
                            </div>
                          </div>
                        )}

                        {/* If CPMG experiments exist */}
                        {cpmgExps.length > 0 && (
                          <div className="space-y-3 p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-800/20">
                            <h5 className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider flex items-center gap-2">
                              <span>CPMG Relaxation Dispersion (R₂,eff vs ν_CPMG)</span>
                              <span className="text-[10px] text-slate-400 font-normal">({cpmgExps.length} experiments)</span>
                            </h5>

                            {/* Main CPMG Profile Plot */}
                            <div className="w-full" style={{ height: '320px' }}>
                              <Plot
                                className="w-full h-full"
                                useResizeHandler={true}
                                style={{ width: '100%', height: '100%' }}
                                data={cpmgExps.flatMap((exp: any, expIdx: number) => {
                                  const expLabel = exp.b1_label || (exp.b0 ? `${exp.b0}MHz` : exp.exp_name || `Exp ${expIdx + 1}`);
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
                                    gridcolor: isDarkTheme ? '#1e293b' : '#f1f5f9',
                                    zeroline: false,
                                  },
                                  yaxis: {
                                    title: 'R₂,eff (s⁻¹)',
                                    autorange: true,
                                    gridcolor: isDarkTheme ? '#1e293b' : '#f1f5f9',
                                    zeroline: false,
                                  },
                                  margin: { l: 60, r: 30, t: 25, b: 45 },
                                  legend: { orientation: 'h', x: 0.5, xanchor: 'center', y: -0.25 },
                                  paper_bgcolor: 'transparent',
                                  plot_bgcolor: 'transparent',
                                }}
                                config={{ responsive: true, displayModeBar: true, showTips: false }}
                              />
                            </div>

                            {/* CPMG Residuals Strip Plot */}
                            <div className="w-full pt-1 border-t border-slate-100 dark:border-slate-800" style={{ height: '140px' }}>
                              <Plot
                                className="w-full h-full"
                                useResizeHandler={true}
                                style={{ width: '100%', height: '100%' }}
                                data={cpmgResidualsData.map((resExp: any) => {
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
                                    gridcolor: isDarkTheme ? '#1e293b' : '#f1f5f9',
                                  },
                                  yaxis: {
                                    title: 'Res. (σ)',
                                    autorange: true,
                                    range: [-3.5, 3.5],
                                    gridcolor: isDarkTheme ? '#1e293b' : '#f1f5f9',
                                    zeroline: true,
                                    zerolinecolor: '#94a3b8',
                                  },
                                  margin: { l: 60, r: 30, t: 10, b: 35 },
                                  paper_bgcolor: 'transparent',
                                  plot_bgcolor: 'transparent',
                                  shapes: [
                                    { type: 'line', x0: 0, x1: 1, xref: 'paper', y0: 1, y1: 1, line: { color: '#94a3b8', width: 1, dash: 'dot' } },
                                    { type: 'line', x0: 0, x1: 1, xref: 'paper', y0: -1, y1: -1, line: { color: '#94a3b8', width: 1, dash: 'dot' } },
                                    { type: 'line', x0: 0, x1: 1, xref: 'paper', y0: 2, y1: 2, line: { color: '#ef4444', width: 1, dash: 'dash' } },
                                    { type: 'line', x0: 0, x1: 1, xref: 'paper', y0: -2, y1: -2, line: { color: '#ef4444', width: 1, dash: 'dash' } },
                                  ],
                                }}
                                config={{ responsive: true, displayModeBar: false }}
                              />
                            </div>
                          </div>
                        )}

                        {cestExps.length === 0 && cpmgExps.length === 0 && (
                          <p className="text-xs text-slate-500 italic p-4 text-center">Fitted plot points are loading or unavailable for this residue.</p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        );
      })()}
        </div>
      </div>

      {/* File Preview Modal */}
      {previewFilePath && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl">
            <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <span className="font-mono text-xs font-bold text-slate-800 dark:text-slate-200 truncate">{previewFilePath}</span>
              <button onClick={() => setPreviewFilePath(null)} className="p-1 text-slate-400 hover:text-slate-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 flex-1 overflow-auto bg-slate-950 font-mono text-xs text-slate-200">
              <pre className="whitespace-pre-wrap">{previewContent}</pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ExchangeAnalysisManager;
