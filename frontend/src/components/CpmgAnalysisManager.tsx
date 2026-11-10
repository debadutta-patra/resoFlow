import SaveButton from './chemex/SaveButton';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import StartingValuesMenu from './chemex/StartingValuesMenu';
import React, { useState, useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import api from "../services/api";
import { useTheme } from "../context/ThemeContext";
import { useOptionalUserRuns } from "../context/RunsContext";
import nmrSpectraLight from "../assets/nmr_spectra_light.jpg";
import nmrSpectraDark from "../assets/nmr_spectra_dark.jpg";
import atomSpinLight from "../assets/atom_spin_light.jpg";
import atomSpinDark from "../assets/atom_spin_dark.jpg";
import peakFittingLight from "../assets/peak_fitting_light.jpg";
import peakFittingDark from "../assets/peak_fitting_dark.jpg";
import fitParametersLight from "../assets/fit_parameters_light.jpg";
import fitParametersDark from "../assets/fit_parameters_dark.jpg";
import terminalLogsLight from "../assets/terminal_logs_light.jpg";
import terminalLogsDark from "../assets/terminal_logs_dark.jpg";

import {
  AlertCircle,
  AlertTriangle,
  Beaker,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Loader2,
  Play,
  RotateCcw,
  Square,
  Workflow,
  X,
} from "lucide-react";

import { CpmgModuleSelector, CPMG_MODULES } from "./cpmg/CpmgModuleSelector";
import { CpmgSetupForm } from "./cpmg/CpmgSetupForm";
import { CpmgDispersionTab, type CpmgProfileItem } from "./cpmg/CpmgDispersionTab";
import { CpmgResultsTab, type CpmgResultResidue } from "./cpmg/CpmgResultsTab";
import type { ResidueItem } from "./methods/ResidueSelector";
import { MethodsTab } from "./methods/MethodsTab";
import { ParametersTab } from "./parameters/ParametersTab";
import { ConfigChangedBadge, FitModeHelp, LastCommittedBadge, LineageBadge, LiveRunBadge, StaleStartingValuesBadge } from "./chemex/RunStatusBadges";
import { FIT_MODE_HELP } from "../lib/runProgress";
import { committedGlobalsByStep, lastCommittedStep } from "../lib/committedResults";
import {
  applyGridCoordinatesToCpmgConfig,
  peakFitPicks,
  seedCpmgResiduesFromProfiles,
} from "../lib/cpmgConfig";
import { startingProvenance, withValue } from "../lib/parameterConfig";
import { evaluateCpmgDiagnostics, type CpmgDiagnosticsResult } from "../lib/cpmgDiagnostics";
import { getNucleusInfoForModule } from "../lib/experimentPlugin";
import { chemexConfigHash, experimentsFingerprint, findLineage, isRunActive, preflightChemexValidation, RERUN_CONFIRM_MESSAGE } from "../lib/chemexRun";
import { useMethodEditor } from "../hooks/useMethodEditor";
import { useParameterEditor } from "../hooks/useParameterEditor";
import { cpmgPlugin } from "../plugins/cpmgPlugin";

interface Spectrum {
  id: number;
  spectrum_uuid: string;
  name: string;
  experiment_type?: string;
  b0?: number;
  carrier?: number;
  t_relax?: number;
  vdlist_path?: string;
  results_json_path?: string;
  is_fitted?: boolean;
}

interface ProgressInfo {
  kind: string;
  stage?: string;
  done?: number;
  total?: number;
  percent?: number;
  iteration?: number;
  chisqr?: number;
  redchi?: number;
  message?: string;
  updated_at?: number;
  step?: { name: string; index?: number; total?: number };
}

interface Analysis {
  id: number;
  analysis_uuid: string;
  name: string;
  analysis_type: string;
  status: string;
  error_message?: string;
  bundle_status?: string;
  summary_redchi?: number;
  summary_n_residues?: number;
  completed_at?: string;
}

interface CpmgAnalysisManagerProps {
  projectUuid: string;
  analysis: Analysis;
  spectra: Spectrum[];
  /** Project analyses, used to tell whether an inherited source run still exists. */
  allAnalyses?: { analysis_uuid: string }[];
  onUpdate?: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  PENDING: "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800",
  RUNNING: "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800",
  CANCELLING: "bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700",
  CANCELLED: "bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700",
  COMPLETED: "bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800",
  COMPLETED_WITH_ERRORS: "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800",
  FAILED: "bg-red-100 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800",
};

export const CpmgAnalysisManager: React.FC<CpmgAnalysisManagerProps> = ({
  projectUuid,
  analysis,
  spectra,
  allAnalyses = [],
  onUpdate,
}) => {
  const { theme } = useTheme();
  const userRuns = useOptionalUserRuns();
  const navigate = useNavigate();
  const isDarkTheme = theme === "dark";
  const nmrSpectraIcon = isDarkTheme ? nmrSpectraDark : nmrSpectraLight;
  const atomSpinIcon = isDarkTheme ? atomSpinDark : atomSpinLight;
  const peakFittingIcon = isDarkTheme ? peakFittingDark : peakFittingLight;
  const fitParametersIcon = isDarkTheme ? fitParametersDark : fitParametersLight;
  const terminalLogsIcon = isDarkTheme ? terminalLogsDark : terminalLogsLight;

  type TabKey = "experiments" | "dispersion" | "parameters" | "methods" | "logs" | "results";
  const [activeTab, setActiveTab] = useState<TabKey>("experiments");
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => localStorage.getItem("resoFlow_sidebar_collapsed") === "true");
  const [status, setStatus] = useState(analysis.status || "PENDING");
  const [fitMode, setFitMode] = useState<"global" | "individual">("global");
  const [logs, setLogs] = useState("");
  const [error, setError] = useState("");
  const [successMsg, setSuccessMsg] = useState("");
  const [isFitting, setIsFitting] = useState(
    analysis.status === "RUNNING" || analysis.status === "PENDING"
  );
  const isSubmittingRunRef = useRef(false);

  useEffect(() => {
    if (isSubmittingRunRef.current) return;
    if (analysis.status && analysis.status !== status) {
      setStatus(analysis.status);
      setIsFitting(analysis.status === "RUNNING" || analysis.status === "PENDING");
    }
  }, [analysis.status]);

  const [isCancelling, setIsCancelling] = useState(false);
  const [previewFile, setPreviewFile] = useState<{ name: string; content: string } | null>(null);
  const [progressInfo, setProgressInfo] = useState<ProgressInfo | null>(null);

  // ── Experiments Tab State ──
  const [selectedSpectrumIds, setSelectedSpectrumIds] = useState<number[]>([]);
  const [selectedParentModule, setSelectedParentModule] = useState<string>("cpmg_15n_ip");
  const [is0013, setIs0013] = useState(false);
  const [isAntiTrosy, setIsAntiTrosy] = useState(false);
  const [isSmallProtein, setIsSmallProtein] = useState(false);
  const [isDoubleQuantum, setIsDoubleQuantum] = useState(false);

  const [setupValues, setSetupValues] = useState<{
    time_t2: number;
    carrier: number;
    pw90: number;
    data_error: "duplicates" | "file";
    carrier_h?: number;
    carrier_n?: number;
    pw90_h?: number;
    pw90_n?: number;
    taub?: number;
    t_zeta?: number;
    ncyc_max?: number;
    temperature?: number;
    p_total?: number;
    l_total?: number;
  }>({
    time_t2: 0.04,
    carrier: 117.0,
    pw90: 35.0e-6,
    data_error: "duplicates",
    temperature: 298.15,
  });

  const [useHeight, setUseHeight] = useState(true);
  const [model, setModel] = useState("2st");
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedExperiments, setGeneratedExperiments] = useState<any[]>([]);

  // ── Dispersion Inspection Tab State ──
  const [profiles, setProfiles] = useState<CpmgProfileItem[]>([]);
  const [currentProfileIdx, setCurrentProfileIdx] = useState(0);

  const notify = (msg: string, ms = 3000) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(""), ms);
  };

  // ── Parameters & Methods (shared ChemEx editors) ──
  const picks = useMemo(() => peakFitPicks(profiles), [profiles]);
  const parameterEditor = useParameterEditor({
    createDefault: cpmgPlugin.parameters.createDefaultParameters,
    codec: cpmgPlugin.parameters.codec,
    profiles,
    picks,
  });
  const { parameterConfig, setParameterConfig } = parameterEditor;

  const residueItems: ResidueItem[] = useMemo(
    () =>
      profiles
        .filter((p) => !parameterEditor.isExcluded(p.residue))
        .map((p) => ({
          id: p.residue,
          number: parseInt(p.residue.replace(/\D/g, ""), 10) || 0,
          label: p.full_residue || p.residue,
          hasData: !!(p.experiments && p.experiments.length > 0),
        })),
    [profiles, parameterEditor.isExcluded]
  );

  const runLocked = isRunActive(status, isFitting);
  const methodEditor = useMethodEditor({
    onCatalog: parameterEditor.setCatalog,
    projectUuid,
    analysisUuid: analysis.analysis_uuid,
    family: cpmgPlugin.endpointFamily,
    model,
    residueItems,
    isResidueExcluded: parameterEditor.isExcluded,
    exclusionKey: parameterConfig.excludedResidues,
    inputsKey: experimentsFingerprint(generatedExperiments),
    locked: runLocked,
    parameterToml: parameterEditor.effectiveParameterToml,
    notify,
  });
  const { methodConfig, blockingErrors } = methodEditor;

  const [lastRunConfigHash, setLastRunConfigHash] = useState("");
  const [lastRunTimestamp, setLastRunTimestamp] = useState("");

  // ── Results Tab State ──
  const [analysisResults, setAnalysisResults] = useState<any>(null);
  const committedByStep = useMemo(() => committedGlobalsByStep(analysisResults), [analysisResults]);
  const lastCommitted = useMemo(() => lastCommittedStep(analysisResults), [analysisResults]);
  const [resultsResidues, setResultsResidues] = useState<Record<string, CpmgResultResidue>>({});
  const [resultsGlobals, setResultsGlobals] = useState<Record<string, { value: number; error?: number }>>({});
  const [resultsStats, setResultsStats] = useState<any>({});
  const [diagnostics, setDiagnostics] = useState<CpmgDiagnosticsResult | undefined>(undefined);
  const [hasBackup, setHasBackup] = useState(false);

  const [copyFeedback, setCopyFeedback] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  const moduleDef = useMemo(
    () => CPMG_MODULES.find((m) => m.id === selectedParentModule) || CPMG_MODULES[0],
    [selectedParentModule]
  );

  const resolvedModuleName = useMemo(() => {
    if (is0013 && moduleDef.has0013Variant) {
      return `${moduleDef.id}_0013`;
    }
    return moduleDef.id;
  }, [moduleDef, is0013]);

  const nucleusInfo = useMemo(() => getNucleusInfoForModule(resolvedModuleName), [resolvedModuleName]);

  const selectedSpectraFields = useMemo(() => {
    const selected = spectra.filter((s) => selectedSpectrumIds.includes(s.id));
    const b0Set = new Set<number>();
    selected.forEach((s) => b0Set.add(s.b0 || 600.0));
    return Array.from(b0Set).sort((a, b) => a - b);
  }, [spectra, selectedSpectrumIds]);

  const residueMapping = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of profiles) {
      if (p.residue) {
        map[p.residue] = p.full_residue || p.residue;
      }
    }
    return map;
  }, [profiles]);

  const fetchLogs = async () => {
    if (isSubmittingRunRef.current) return;
    try {
      const res = await api.get(`/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/cpmg/logs`);
      if (res.data.logs) setLogs(res.data.logs);
      const incomingStatus = res.data.status;
      const isTerminal = incomingStatus === "COMPLETED" || incomingStatus === "COMPLETED_WITH_ERRORS" || incomingStatus === "FAILED" || incomingStatus === "CANCELLED";

      if (res.data.progress && !isTerminal) {
        setProgressInfo(res.data.progress);
      } else if (isTerminal) {
        setProgressInfo(null);
        setIsFitting(false);
      }

      if (incomingStatus === "RUNNING" || incomingStatus === "PENDING") {
        setIsFitting(true);
      }

      if (incomingStatus && incomingStatus !== status) {
        setStatus(incomingStatus);
        if (incomingStatus === "COMPLETED" || incomingStatus === "COMPLETED_WITH_ERRORS") {
          await fetchResults();
          setActiveTab("results");
          onUpdate?.();
        } else if (incomingStatus === "FAILED" || incomingStatus === "CANCELLED" || incomingStatus === "RUNNING") {
          onUpdate?.();
        }
      }
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    loadSavedConfig();
    fetchResults();
    fetchLogs();
  }, [analysis.analysis_uuid]);

  useEffect(() => {
    if (activeTab === "results") {
      fetchResults();
    } else if (activeTab === "logs") {
      fetchLogs();
    }
  }, [activeTab]);

  // ── Reactive log & status polling while running/pending ──
  useEffect(() => {
    if (status !== "RUNNING" && status !== "PENDING") return;
    setIsFitting(true);
    fetchLogs();
    const interval = setInterval(fetchLogs, 2000);
    return () => clearInterval(interval);
  }, [status, projectUuid, analysis.analysis_uuid]);

  // ── Auto-scroll logs ──
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  const loadSavedConfig = async () => {
    try {
      const res = await api.get(`/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/cpmg/config`);
      if (res.data.config) {
        const c = res.data.config;
        if (c.selectedSpectrumIds) setSelectedSpectrumIds(c.selectedSpectrumIds);
        if (c.selectedParentModule) setSelectedParentModule(c.selectedParentModule);
        if (c.is0013 !== undefined) setIs0013(c.is0013);
        if (c.isAntiTrosy !== undefined) setIsAntiTrosy(c.isAntiTrosy);
        if (c.isSmallProtein !== undefined) setIsSmallProtein(c.isSmallProtein);
        if (c.isDoubleQuantum !== undefined) setIsDoubleQuantum(c.isDoubleQuantum);
        if (c.setupValues) setSetupValues(c.setupValues);
        if (c.model) setModel(c.model);
        if (c.fit_mode) setFitMode(c.fit_mode);
        if (c.last_run_hash) setLastRunConfigHash(c.last_run_hash);
        if (c.last_run_timestamp) setLastRunTimestamp(c.last_run_timestamp);
        const savedProfiles: CpmgProfileItem[] = Array.isArray(c.profiles) ? c.profiles : [];
        parameterEditor.restore(c, savedProfiles);
        if (savedProfiles.length > 0) {
          setProfiles(savedProfiles);
          setParameterConfig((prev) => seedCpmgResiduesFromProfiles(prev, savedProfiles));
        }
        if (c.generatedExperiments) setGeneratedExperiments(c.generatedExperiments);
        methodEditor.restore(c);
        setHasBackup(res.data.has_backup || false);
      } else {
        setHasBackup(res.data?.has_backup || false);
      }
    } catch {
      // ignore
    }
    markClean();
  };

  const currentConfigHash = chemexConfigHash({
    parameterToml: parameterEditor.effectiveParameterToml,
    methodToml: methodEditor.effectiveMethodToml,
    model,
    fitMode,
  });
  const isConfigChangedSinceRun = status === "COMPLETED" && !!lastRunConfigHash && currentConfigHash !== lastRunConfigHash;
  const lineageInfo = useMemo(() => findLineage(parameterConfig), [parameterConfig]);
  const sourceRunStillExists = !!lineageInfo && allAnalyses.some((a) => a.analysis_uuid === lineageInfo.sourceRunId);
  const catalogGlobals = useMemo(
    () => methodEditor.availableParamsMeta.filter((p) => p.scope === "global").map((p) => p.name),
    [methodEditor.availableParamsMeta]
  );

  /** Parameters/Methods payload shared by save and run (same keys on every ChemEx page). */
  const chemexPayload = (overrides: { last_run_hash?: string; last_run_timestamp?: string } = {}) => ({
    parameter_toml: parameterEditor.effectiveParameterToml,
    parameter_config: parameterEditor.parameterConfigForSave,
    method_toml: methodEditor.effectiveMethodToml,
    method_config: methodEditor.methodConfigForSave,
    model,
    fit_mode: fitMode,
    last_run_hash: overrides.last_run_hash ?? lastRunConfigHash,
    last_run_timestamp: overrides.last_run_timestamp ?? lastRunTimestamp,
  });

  const savePayload = {
        ...chemexPayload(),
        selectedSpectrumIds,
        selectedParentModule,
        resolvedModuleName,
        is0013,
        isAntiTrosy,
        isSmallProtein,
        isDoubleQuantum,
        setupValues,
        profiles,
        generatedExperiments,
  };
  const { dirty: unsaved, markClean } = useUnsavedChanges(savePayload);

  const saveConfig = async () => {
    try {
      await api.put(`/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/cpmg/config`, savePayload);
      markClean();
      notify("Configuration saved");
    } catch (e: any) {
      setError(e.response?.data?.detail || "Failed to save configuration");
    }
  };

  const handleGenerate = async () => {
    if (selectedSpectrumIds.length === 0) {
      setError("Please select at least one CPMG spectrum");
      return;
    }
    try {
      setIsGenerating(true);
      setError("");
      const res = await api.post(`/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/cpmg/generate`, {
        spectrum_ids: selectedSpectrumIds,
        selected_module: resolvedModuleName,
        time_t2: setupValues.time_t2,
        carrier: setupValues.carrier,
        pw90: setupValues.pw90,
        data_error: setupValues.data_error,
        use_height: useHeight,
        excluded_residues: parameterConfig.excludedResidues || [],
        carrier_h: setupValues.carrier_h,
        carrier_n: setupValues.carrier_n,
        pw90_h: setupValues.pw90_h,
        pw90_n: setupValues.pw90_n,
        taub: setupValues.taub,
        t_zeta: setupValues.t_zeta,
        ncyc_max: setupValues.ncyc_max,
        small_protein: isSmallProtein,
        antitrosy: isAntiTrosy,
        dq_flg: isDoubleQuantum,
      });

      setGeneratedExperiments(res.data.experiments || []);
      if (res.data.profiles) {
        setProfiles(res.data.profiles);
        setParameterConfig((prev) => seedCpmgResiduesFromProfiles(prev, res.data.profiles));
      }

      setSuccessMsg(`Generated ${res.data.total_data_files} data files and ${res.data.experiments?.length || 0} experiment TOMLs`);
      setTimeout(() => setSuccessMsg(""), 5000);
      await saveConfig();
    } catch (e: any) {
      setError(e.response?.data?.detail || "Failed to generate CPMG files");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleToggleExclude = parameterEditor.toggleExclude;
  const handleBulkSetExcluded = parameterEditor.setExcluded;

  const handleSeedSingleDw = (resKey: string, dwPpm: number) => {
    const curRes = parameterConfig.residues[resKey] || {};
    setParameterConfig({
      ...parameterConfig,
      residues: {
        ...parameterConfig.residues,
        [resKey]: {
          ...curRes,
          dw_ab: withValue(curRes.dw_ab, dwPpm, { kind: "estimated_from_rex" }),
        },
      },
    });
  };

  const handleBulkSeedDw = (seeds: Record<string, number>) => {
    const nextRes = { ...parameterConfig.residues };
    for (const [resKey, dwVal] of Object.entries(seeds)) {
      const cur = nextRes[resKey] || {};
      nextRes[resKey] = {
        ...cur,
        dw_ab: withValue(cur.dw_ab, dwVal, { kind: "estimated_from_rex" }),
      };
    }
    setParameterConfig({
      ...parameterConfig,
      residues: nextRes,
    });
    setSuccessMsg(`Seeded |Δω| from Rex for ${Object.keys(seeds).length} residues`);
    setTimeout(() => setSuccessMsg(""), 3000);
  };

  const fetchResults = async () => {
    try {
      const res = await api.get(`/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/results`);
      if (res.data) {
        if (res.data.status) setStatus(res.data.status);
        const dataPayload = res.data.results || res.data;
        setAnalysisResults(dataPayload);
        if (dataPayload.residues) setResultsResidues(dataPayload.residues);
        if (dataPayload.globals || dataPayload.global) setResultsGlobals(dataPayload.globals || dataPayload.global);
        if (dataPayload.statistics) setResultsStats(dataPayload.statistics);

        const diag = evaluateCpmgDiagnostics(
          dataPayload.globals || dataPayload.global || {},
          dataPayload.residues || {},
          selectedSpectraFields.length || 1
        );
        setDiagnostics(diag);
      }
    } catch {
      // ignore
    }
  };

  const handleRestore = async () => {
    if (!window.confirm("This will restore the last version of your results. Current results will become the new backup. Proceed?")) return;
    try {
      setIsFitting(true);
      setError('');
      await api.post(`/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/cpmg/restore`);
      setSuccessMsg("Results restored successfully!");
      loadSavedConfig();
      fetchResults();
      const res = await api.get(`/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/cpmg/logs`);
      setLogs(res.data.logs || '');
      setProgressInfo(null);
      userRuns?.refreshRuns();
      setTimeout(() => setSuccessMsg(''), 3000);
    } catch (err: any) {
      setError(err.response?.data?.detail || "Restore failed");
    } finally {
      setIsFitting(false);
    }
  };

  const handleRunFitting = async () => {
    if (blockingErrors.length > 0) {
      setError(`Cannot run ChemEx: ${blockingErrors[0].message}`);
      return;
    }
    if (isSubmittingRunRef.current) return;
    if (status === "COMPLETED" && !window.confirm(RERUN_CONFIRM_MESSAGE)) return;
    const previousStatus = status;
    try {
      isSubmittingRunRef.current = true;
      setIsFitting(true);
      setError("");
      setStatus("PENDING");
      setProgressInfo(null);
      setActiveTab("logs");
      setLogs(`[${new Date().toLocaleTimeString()}] Initiating ChemEx CPMG fitting...\n`);

      const validationError = await preflightChemexValidation({
        projectUuid,
        analysisUuid: analysis.analysis_uuid,
        parameterToml: parameterEditor.effectiveParameterToml,
        methodToml: methodEditor.effectiveMethodToml,
        model,
      });
      if (validationError) {
        setError(validationError);
        setIsFitting(false);
        setStatus(previousStatus);
        return;
      }

      const runHash = currentConfigHash;
      const runTime = new Date().toLocaleString();
      setLastRunConfigHash(runHash);
      setLastRunTimestamp(runTime);

      const res = await api.post(`/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/cpmg/run`, {
        ...chemexPayload({ last_run_hash: runHash, last_run_timestamp: runTime }),
        generatedExperiments,
        profiles,
      });

      const nextStatus = res.data?.status || "PENDING";
      setStatus(nextStatus);
      setIsFitting(true);
      userRuns?.refreshRuns();
      onUpdate?.();
    } catch (e: any) {
      setError(e.response?.data?.detail || "Failed to start fitting run");
      setIsFitting(false);
      setStatus("FAILED");
      onUpdate?.();
    } finally {
      isSubmittingRunRef.current = false;
      fetchLogs();
    }
  };

  const handleStop = async () => {
    if (isCancelling || status === "CANCELLING") return;
    if (!window.confirm("Are you sure you want to stop the current fitting run?")) return;
    setIsCancelling(true);
    setStatus("CANCELLING");
    try {
      await api.post(`/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/cpmg/stop`);
      setSuccessMsg("Analysis cancelled successfully.");
      setStatus("CANCELLED");
      setIsFitting(false);
      setProgressInfo(null);
      userRuns?.refreshRuns();
      onUpdate?.();
      setTimeout(() => setSuccessMsg(""), 3000);
    } catch (err: any) {
      setError(err.response?.data?.detail || "Failed to stop analysis");
      setStatus("FAILED");
      setIsFitting(false);
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

  const tabCls = (key: TabKey) =>
    `flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 whitespace-nowrap w-auto md:w-full ${
      isSidebarCollapsed ? 'md:justify-center' : 'md:justify-start'
    } ${
      activeTab === key
        ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400 font-semibold text-sm shadow-2xs border border-blue-200/60 dark:border-blue-800/60'
        : 'text-sm text-slate-600 hover:text-slate-900 hover:bg-white dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800/50 border border-transparent'
    }`;

  const btnPrimary = 'px-4 py-2 bg-blue-600 hover:bg-blue-700 dark:bg-indigo-600 dark:hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-all shadow-sm disabled:opacity-50';
  const btnSecondary = 'px-4 py-2 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 text-sm font-medium rounded-lg border border-slate-200 dark:border-slate-700 transition-all';
  const sectionCls = "bg-slate-50 dark:bg-slate-800/50 p-5 rounded-xl border border-slate-200 dark:border-slate-700";

  return (
    <div className="space-y-4">
      {/* Top Header Action Bar */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className={`px-3 py-1 rounded-full text-xs font-bold border flex items-center gap-1.5 ${STATUS_COLORS[status] || STATUS_COLORS.PENDING}`}>
            {(status === "RUNNING" || status === "CANCELLING" || isFitting) && <Loader2 className="w-3 h-3 animate-spin" />}
            {status === "COMPLETED" && <CheckCircle2 className="w-3 h-3 text-emerald-600" />}
            <span>{status}</span>
          </span>

          {(status === "RUNNING" || status === "CANCELLING" || isFitting) && progressInfo && <LiveRunBadge progress={progressInfo} />}

          <span className={`px-2 py-0.5 rounded-full text-[10px] font-extrabold tracking-wider uppercase border ${
            fitMode === 'global' 
              ? 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-800'
              : 'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-900/20 dark:text-indigo-400 dark:border-indigo-800'
          }`}>
            {fitMode} Fit
          </span>

          <StaleStartingValuesBadge count={parameterEditor.staleResidues.length} noun="peak-fit shift" onClick={() => setActiveTab("parameters")} />
          <ConfigChangedBadge show={isConfigChangedSinceRun} />
          <LineageBadge lineage={lineageInfo} projectUuid={projectUuid} sourceExists={sourceRunStillExists} />

          {lastCommitted && (
            <LastCommittedBadge stepName={lastCommitted.name} redchi={lastCommitted.redchi} at={analysis.completed_at} />
          )}
        </div>

        {/* Global Action Buttons */}
        <div className="flex flex-wrap items-center gap-2">
          {(status === "RUNNING" || status === "CANCELLING" || isFitting) && (
            <button
              onClick={handleStop}
              disabled={isCancelling || status === "CANCELLING"}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-red-50 hover:bg-red-100 text-red-700 text-xs font-bold rounded-lg border border-red-200 transition-all shadow-sm disabled:opacity-50"
            >
              <Square size={13} fill="currentColor" />
              <span>{isCancelling || status === "CANCELLING" ? "Cancelling..." : "Stop Run"}</span>
            </button>
          )}

          {/* Fit Mode Switcher */}
          <div role="radiogroup" aria-labelledby="fit-mode-label" title={FIT_MODE_HELP} className="flex items-center gap-1 bg-slate-100 dark:bg-slate-800 rounded-lg p-1 border border-slate-200 dark:border-slate-700">
            <span className="px-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300" id="fit-mode-label">Fit mode</span>
            <button
              onClick={() => setFitMode("global")}
              className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-all ${
                fitMode === "global"
                  ? "bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-400 shadow-sm border border-slate-200 dark:border-slate-600"
                  : "text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
              }`}
            >
              Global
            </button>
            <button
              onClick={() => setFitMode("individual")}
              className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-all ${
                fitMode === "individual"
                  ? "bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-400 shadow-sm border border-slate-200 dark:border-slate-600"
                  : "text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
              }`}
            >
              Individual
            </button>
            <FitModeHelp />
          </div>

          <StartingValuesMenu
            overview={methodEditor.runOverview.overview}
            parameterConfig={parameterConfig}
            onApply={(next, message) => {
              setParameterConfig(next);
              notify(message, 5000);
            }}
            onContinueFromRun={status === "COMPLETED" ? handleContinueRun : undefined}
            disabled={isFitting}
          />

          {hasBackup && (
            <button
              onClick={handleRestore}
              disabled={isFitting || status === "RUNNING" || status === "CANCELLING"}
              className="flex items-center gap-1 px-2.5 py-1.5 bg-amber-50 hover:bg-amber-100 text-amber-800 dark:text-amber-700 text-xs font-bold rounded-lg border border-amber-200 dark:border-amber-300 transition-all disabled:opacity-50"
              title="Swap the current results with the previous run's results (backup). Starting values are not changed."
            >
              <RotateCcw size={13} />
              <span>Restore previous results</span>
            </button>
          )}

          <SaveButton dirty={unsaved} onSave={saveConfig} className={btnSecondary} />

          <button
            onClick={handleRunFitting}
            disabled={isFitting || generatedExperiments.length === 0 || blockingErrors.length > 0}
            title={blockingErrors.length > 0 ? `Cannot run: ${blockingErrors[0].message}` : undefined}
            className={`${btnPrimary} flex items-center gap-1`}
          >
            {isFitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5 fill-current" />}
            <span>{isFitting ? "Running..." : "Run ChemEx"}</span>
          </button>
        </div>
      </div>

      {/* Messages */}
      {error && (
        <div className="p-3.5 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/60 rounded-xl text-xs text-red-700 dark:text-red-300 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
          <button onClick={() => setError("")} className="hover:opacity-75">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
      {successMsg && (
        <div className="p-3.5 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/60 rounded-xl text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{successMsg}</span>
        </div>
      )}

      {/* Main Layout: Left Tab Bar + Right Content */}
      <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden shadow-sm flex flex-col md:flex-row min-h-[600px]">
        {/* Sidebar Tabs */}
        <div
          className={`${
            isSidebarCollapsed ? "w-full md:w-20" : "w-full md:w-64"
          } flex-shrink-0 border-b md:border-b-0 md:border-r border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-900/10 p-4 flex flex-row md:flex-col gap-2 overflow-x-auto md:overflow-x-visible transition-all duration-300`}
        >
          <button onClick={() => setActiveTab("experiments")} className={tabCls("experiments")} title="Experiments">
            <img
              src={nmrSpectraIcon}
              className="w-7 h-7 min-w-[28px] aspect-square object-cover rounded-lg flex-shrink-0 shadow-sm border border-slate-200 dark:border-slate-700"
              alt=""
            />
            <span className={isSidebarCollapsed ? "md:hidden" : "md:inline"}>Experiments</span>
          </button>

          <button onClick={() => setActiveTab("dispersion")} className={tabCls("dispersion")} title="Inspect Dispersion">
            <img
              src={atomSpinIcon}
              className="w-7 h-7 min-w-[28px] aspect-square object-cover rounded-lg flex-shrink-0 shadow-sm border border-slate-200 dark:border-slate-700"
              alt=""
            />
            <span className={isSidebarCollapsed ? "md:hidden" : "md:inline"}>Inspect Dispersion</span>
          </button>

          <button onClick={() => setActiveTab("parameters")} className={tabCls("parameters")} title="Parameters">
            <img
              src={fitParametersIcon}
              className="w-7 h-7 min-w-[28px] aspect-square object-cover rounded-lg flex-shrink-0 shadow-sm border border-slate-200 dark:border-slate-700"
              alt=""
            />
            <span className={isSidebarCollapsed ? "md:hidden" : "md:inline"}>Parameters</span>
          </button>

          <button onClick={() => setActiveTab("methods")} className={tabCls("methods")} title="Methods">
            <Workflow className="w-7 h-7 min-w-[28px] aspect-square flex-shrink-0 text-blue-500 dark:text-indigo-400" />
            <span className={isSidebarCollapsed ? "md:hidden" : "md:inline"}>Methods</span>
          </button>

          <button onClick={() => setActiveTab("logs")} className={tabCls("logs")} title="Logs">
            <img
              src={terminalLogsIcon}
              className="w-7 h-7 min-w-[28px] aspect-square object-cover rounded-lg flex-shrink-0 shadow-sm border border-slate-200 dark:border-slate-700"
              alt=""
            />
            <span className={isSidebarCollapsed ? "md:hidden" : "md:inline"}>Logs</span>
          </button>

          {(status === "COMPLETED" || status === "FAILED" || status === "CANCELLED") && (
            <button onClick={() => setActiveTab("results")} className={tabCls("results")} title="Results">
              <img
                src={peakFittingIcon}
                className="w-7 h-7 min-w-[28px] aspect-square object-cover rounded-lg flex-shrink-0 shadow-sm border border-slate-200 dark:border-slate-700"
                alt=""
              />
              <span className={isSidebarCollapsed ? "md:hidden" : "md:inline"}>Results</span>
            </button>
          )}

          <div className="hidden md:flex flex-grow flex-col justify-end mt-4">
            <button
              onClick={() => {
                const newVal = !isSidebarCollapsed;
                setIsSidebarCollapsed(newVal);
                localStorage.setItem("resoFlow_sidebar_collapsed", String(newVal));
              }}
              className={`flex items-center px-4 py-3 text-sm font-medium text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-850 rounded-xl transition-all gap-3 ${
                isSidebarCollapsed ? "justify-center" : "justify-start"
              }`}
              title={isSidebarCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}
            >
              {isSidebarCollapsed ? <ChevronRight className="w-4 h-4 flex-shrink-0" /> : <ChevronLeft className="w-4 h-4 flex-shrink-0" />}
              <span className={isSidebarCollapsed ? "hidden" : "inline"}>Collapse Menu</span>
            </button>
          </div>
        </div>

        {/* Tab Content Area */}
        <div className="flex-1 p-6 overflow-x-hidden">
          {activeTab === "experiments" && (
            <div className="space-y-6 animate-in fade-in">
              {/* Module Selector Card */}
              <CpmgModuleSelector
                selectedParentId={selectedParentModule}
                onSelectParent={(parentId) => setSelectedParentModule(parentId)}
                is0013={is0013}
                onToggle0013={(val) => setIs0013(val)}
                isAntiTrosy={isAntiTrosy}
                onToggleAntiTrosy={(val) => setIsAntiTrosy(val)}
                isSmallProtein={isSmallProtein}
                onToggleSmallProtein={(val) => setIsSmallProtein(val)}
                isDoubleQuantum={isDoubleQuantum}
                onToggleDoubleQuantum={(val) => setIsDoubleQuantum(val)}
              />

              {/* Spectra Selector & Parameters */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Select CPMG Spectra */}
                <div className={sectionCls}>
                  <h4 className="text-sm font-bold text-slate-800 dark:text-slate-200 mb-3">
                    Select CPMG Spectra
                  </h4>
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {spectra.map((s) => {
                      const isSel = selectedSpectrumIds.includes(s.id);
                      return (
                        <label
                          key={s.id}
                          className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                            isSel
                              ? "border-blue-400 bg-blue-50 dark:bg-blue-900/20"
                              : "border-slate-200 hover:border-slate-300"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={isSel}
                            onChange={() => {
                              setSelectedSpectrumIds((prev) =>
                                isSel ? prev.filter((id) => id !== s.id) : [...prev, s.id]
                              );
                            }}
                            className="w-4 h-4 accent-blue-600 rounded"
                          />
                          <div className="flex-1 min-w-0">
                            <span className="text-sm font-medium text-slate-800 dark:text-slate-200 block truncate">
                              {s.name}
                            </span>
                            <div className="flex gap-3 text-[10px] text-slate-500 mt-0.5">
                              {s.b0 != null && <span>B0: {s.b0} MHz</span>}
                              {s.t_relax != null && <span>time_t2: {s.t_relax} s</span>}
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>

                {/* CPMG Parameters Setup Form */}
                <div className="space-y-4">
                  <CpmgSetupForm
                    moduleDef={moduleDef}
                    values={setupValues}
                    onChangeValue={(k, v) => setSetupValues((prev) => ({ ...prev, [k]: v }))}
                    selectedSpectraFields={selectedSpectraFields}
                    model={model}
                    onChangeModel={(m) => setModel(m)}
                    useHeight={useHeight}
                    onChangeUseHeight={(h) => setUseHeight(h)}
                  />

                  <button
                    onClick={handleGenerate}
                    disabled={isGenerating || selectedSpectrumIds.length === 0}
                    className={`w-full ${btnPrimary} flex items-center justify-center gap-2 mb-4`}
                  >
                    {isGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Beaker className="w-4 h-4" />}
                    {isGenerating ? "Generating..." : "Generate Data Files"}
                  </button>

                  {generatedExperiments.length > 0 && (
                    <div className={sectionCls}>
                      <h4 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-3">
                        Generated Experiments
                      </h4>
                      <div className="space-y-2 max-h-48 overflow-y-auto">
                        {generatedExperiments.map((exp, i) => (
                          <div
                            key={i}
                            onClick={() =>
                              setPreviewFile({
                                name: exp.filename || `experiment_${i}.toml`,
                                content: exp.toml_content || `# ChemEx experiment TOML\nmodule = "${resolvedModuleName}"\n`,
                              })
                            }
                            className="flex items-center justify-between p-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-[10px] cursor-pointer hover:border-blue-500 hover:shadow-sm transition-all group"
                          >
                            <span className="font-mono text-slate-600 dark:text-slate-400 group-hover:text-blue-600 truncate mr-2">
                              {exp.filename || `Experiment ${i + 1}`}
                            </span>
                            <div className="flex gap-2 text-blue-600 dark:text-blue-400 font-bold shrink-0">
                              <span>Profiles: {exp.profiles_count || 0}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {activeTab === "dispersion" && (
            <CpmgDispersionTab
              profiles={profiles}
              currentIndex={currentProfileIdx}
              onSelectIndex={(idx) => setCurrentProfileIdx(idx)}
              parameterConfig={parameterConfig}
              onToggleExcludeResidue={handleToggleExclude}
              onBulkSetExcludedResidues={handleBulkSetExcluded}
              onSeedDeltaOmega={handleSeedSingleDw}
              onBulkSeedDeltaOmega={handleBulkSeedDw}
              xiRatio={nucleusInfo.xiRatio}
              unitLabel={nucleusInfo.unitLabel}
            />
          )}

          {activeTab === "parameters" && (
            <ParametersTab
              editor={parameterEditor}
              capabilities={cpmgPlugin.parameters}
              projectUuid={projectUuid}
              analysisUuid={analysis.analysis_uuid}
              targetAnalysis={{
                analysis_uuid: analysis.analysis_uuid,
                name: analysis.name,
                analysis_type: analysis.analysis_type,
                model,
                nucleus: nucleusInfo.nucleus,
                static_field: selectedSpectraFields[0] || 600.0,
                temperature: setupValues.temperature || 298.15,
              }}
              picks={picks}
              profiles={profiles}
              residueLabels={residueMapping}
              methodConfig={methodConfig}
              activeStepIdx={methodEditor.activeStepIdx}
              selectedModule={resolvedModuleName}
              catalogGlobals={catalogGlobals}
              onNavigateToMethods={() => setActiveTab("methods")}
              onApplyInherited={(params, method) => {
                parameterEditor.replaceConfig(params);
                if (method) methodEditor.setMethodConfig(method);
              }}
              notify={notify}
            />
          )}

          {activeTab === "methods" && (
            <MethodsTab
              editor={methodEditor}
              analysisUuid={analysis.analysis_uuid}
              residueItems={residueItems}
              startingValues={parameterEditor.startingValues}
              startingProvenance={startingProvenance(parameterConfig, "peak fit")}
              committedByStep={committedByStep}
              resultsSteps={analysisResults?.steps}
              onNavigateToParameters={() => setActiveTab("parameters")}
              notify={notify}
              readOnly={runLocked}
            />
          )}

          {activeTab === "logs" && (
            <div className="space-y-3 animate-in fade-in">
              {(status === "RUNNING" || isFitting) && progressInfo && (
                <div className="bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800/80 rounded-xl p-3.5 space-y-2 shadow-2xs">
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-600 dark:text-blue-400" />
                      <span className="font-bold text-blue-900 dark:text-blue-100">
                        {progressInfo.message || progressInfo.stage || "Fitting in progress..."}
                      </span>
                    </div>
                    {progressInfo.percent !== undefined && (
                      <span className="font-mono font-extrabold text-blue-800 dark:text-blue-300">
                        {progressInfo.percent.toFixed(1)}%
                      </span>
                    )}
                  </div>
                  {progressInfo.percent !== undefined && (
                    <div className="w-full bg-blue-200/60 dark:bg-blue-900/50 rounded-full h-2 overflow-hidden">
                      <div
                        className="bg-blue-600 dark:bg-blue-500 h-2 rounded-full transition-all duration-300 ease-out"
                        style={{ width: `${Math.min(100, Math.max(0, progressInfo.percent))}%` }}
                      />
                    </div>
                  )}
                </div>
              )}

              <div className="flex items-center justify-between bg-slate-100 dark:bg-slate-800/80 px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 text-xs">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${status === 'RUNNING' ? 'bg-emerald-500 animate-ping' : status === 'COMPLETED' ? 'bg-emerald-500' : status === 'FAILED' ? 'bg-rose-500' : 'bg-slate-400'}`} />
                  <span className="font-semibold text-slate-700 dark:text-slate-300">
                    {status === 'RUNNING' ? 'Live Execution Logs' : 'Process Execution Log'}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(logs);
                      setCopyFeedback(true);
                      setTimeout(() => setCopyFeedback(false), 2000);
                    }}
                    disabled={!logs}
                    className="flex items-center gap-1 px-2.5 py-1 bg-white dark:bg-slate-700 hover:bg-slate-50 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 font-medium rounded-md border border-slate-200 dark:border-slate-600 transition-colors disabled:opacity-50"
                    title="Copy logs to clipboard"
                  >
                    {copyFeedback ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copyFeedback ? 'Copied!' : 'Copy'}</span>
                  </button>
                  <button
                    onClick={() => {
                      const blob = new Blob([logs], { type: 'text/plain' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `chemex_${analysis.name}_${new Date().toISOString().slice(0, 10)}.log`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                    disabled={!logs}
                    className="flex items-center gap-1 px-2.5 py-1 bg-white dark:bg-slate-700 hover:bg-slate-50 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 font-medium rounded-md border border-slate-200 dark:border-slate-600 transition-colors disabled:opacity-50"
                    title="Download full log file"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Download</span>
                  </button>
                </div>
              </div>
              <pre
                ref={logRef}
                className="bg-slate-950 text-emerald-400 text-xs font-mono p-4 rounded-xl overflow-auto max-h-[600px] min-h-[400px] whitespace-pre-wrap border border-slate-800 shadow-inner"
              >
                {logs || 'No logs available yet. Click "Run ChemEx" to start fitting and stream real-time logs.'}
              </pre>
            </div>
          )}

          {activeTab === "results" && (
            <>
              {status === "COMPLETED_WITH_ERRORS" && (
                <div className="mb-6 p-4 rounded-xl border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-semibold text-amber-900 dark:text-amber-200 text-sm">
                      Fit completed with warnings / post-processing issues
                    </div>
                    <div className="text-xs text-amber-700 dark:text-amber-300 mt-1">
                      {analysis.error_message || "Results bundle was partially generated. Raw ChemEx output files remain intact."}
                    </div>
                  </div>
                </div>
              )}
              <CpmgResultsTab
              projectUuid={projectUuid}
              analysisUuid={analysis.analysis_uuid}
              analysisName={analysis.name}
              analysisResults={analysisResults}
              residues={resultsResidues}
              globalParameters={resultsGlobals}
              statistics={resultsStats}
              residueMapping={residueMapping}
              fitMode={fitMode}
              diagnostics={diagnostics}
              unitLabel={nucleusInfo.unitLabel}
              onApplyStartingParameters={(coords) => {
                const { nextConfig, updatedCount } = applyGridCoordinatesToCpmgConfig(parameterConfig, coords);
                if (updatedCount > 0) {
                  setParameterConfig(nextConfig);
                  setSuccessMsg(`Updated starting parameters with grid search minimum (${updatedCount} parameters updated).`);
                  setTimeout(() => setSuccessMsg(''), 5000);
                }
              }}
              excludedResidues={parameterConfig.excludedResidues}
            />
            </>
          )}
        </div>
      </div>

      {/* Preview Modal for Generated Experiment Files */}
      {previewFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-white dark:bg-slate-900 w-full max-w-2xl rounded-2xl shadow-2xl flex flex-col border border-slate-200 dark:border-slate-700 max-h-[85vh] overflow-hidden">
            <div className="flex items-center justify-between p-5 border-b border-slate-100 dark:border-slate-800">
              <h3 className="text-base font-bold text-slate-800 dark:text-slate-100 font-mono">
                {previewFile.name}
              </h3>
              <button
                onClick={() => setPreviewFile(null)}
                className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg text-slate-400 hover:text-slate-600"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-6">
              <pre className="font-mono text-xs leading-relaxed text-slate-700 dark:text-slate-300 whitespace-pre">
                {previewFile.content}
              </pre>
            </div>
            <div className="p-4 border-t border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 flex justify-end">
              <button onClick={() => setPreviewFile(null)} className={btnPrimary}>
                Close Preview
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
