import React, { useState, useEffect, useMemo, useRef } from "react";
import api from "../services/api";
import { useTheme } from "../context/ThemeContext";
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
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Code,
  Copy,
  Download,
  FileCode,
  Info,
  Loader2,
  Play,
  Sparkles,
  Square,
  Upload,
  Workflow,
  X,
} from "lucide-react";

import { CpmgModuleSelector, CPMG_MODULES } from "./cpmg/CpmgModuleSelector";
import { CpmgSetupForm } from "./cpmg/CpmgSetupForm";
import { CpmgDispersionTab, type CpmgProfileItem } from "./cpmg/CpmgDispersionTab";
import { CpmgParametersTab } from "./cpmg/CpmgParametersTab";
import { CpmgResultsTab, type CpmgResultResidue } from "./cpmg/CpmgResultsTab";
import StepTabs from "./methods/StepTabs";
import ParameterTable, { type AvailableParamMeta, DEFAULT_PARAM_METAS } from "./methods/ParameterTable";
import ResidueSelector, { type ResidueItem } from "./methods/ResidueSelector";
import StepStatisticsSection from "./methods/StepStatisticsSection";
import {
  type CpmgParameterConfig,
  createDefaultCpmgParameterConfig,
  configToCpmgToml,
  applyGridCoordinatesToCpmgConfig,
} from "../lib/cpmgConfig";
import {
  createDefaultMethodConfig,
  createDefaultStep,
  type MethodConfig,
  type Step,
} from "../lib/methodConfig";
import { configToToml as methodConfigToToml, tomlToConfig } from "../lib/methodToml";
import { METHOD_TEMPLATES, type MethodTemplate } from "../lib/methodTemplates";
import { validateMethodConfig } from "../lib/methodValidation";
import { evaluateCpmgDiagnostics, type CpmgDiagnosticsResult } from "../lib/cpmgDiagnostics";
import { getNucleusInfoForModule } from "../lib/experimentPlugin";
import { SpinSystemKey } from "../lib/spinSystem";

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

interface Analysis {
  id: number;
  analysis_uuid: string;
  name: string;
  analysis_type: string;
  status: string;
}

interface CpmgAnalysisManagerProps {
  projectUuid: string;
  analysis: Analysis;
  spectra: Spectrum[];
  onUpdate?: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  PENDING: "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800",
  RUNNING: "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800",
  CANCELLING: "bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700",
  CANCELLED: "bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700",
  COMPLETED: "bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800",
  FAILED: "bg-red-100 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800",
};

export const CpmgAnalysisManager: React.FC<CpmgAnalysisManagerProps> = ({
  projectUuid,
  analysis,
  spectra,
  onUpdate,
}) => {
  const { theme } = useTheme();
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
  const [isFitting, setIsFitting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [previewFile, setPreviewFile] = useState<{ name: string; content: string } | null>(null);

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

  // ── Parameters Tab State ──
  const [parameterConfig, setParameterConfig] = useState<CpmgParameterConfig>(createDefaultCpmgParameterConfig);

  // ── Methods Tab State ──
  const [methodConfig, setMethodConfig] = useState<MethodConfig>(createDefaultMethodConfig);
  const [activeStepIdx, setActiveStepIdx] = useState<number>(0);
  const [isRawEditMode, setIsRawEditMode] = useState<boolean>(false);
  const [methodToml, setMethodToml] = useState<string>(() => methodConfigToToml(createDefaultMethodConfig()));
  const [unparsedTomlLines, setUnparsedTomlLines] = useState<string[]>([]);
  const [showTemplateModal, setShowTemplateModal] = useState<boolean>(false);
  const [showImportModal, setShowImportModal] = useState<boolean>(false);
  const [importTomlText, setImportTomlText] = useState<string>("");
  const [showGeneratedPreview, setShowGeneratedPreview] = useState<boolean>(false);
  const [availableParamsMeta, setAvailableParamsMeta] = useState<AvailableParamMeta[]>(DEFAULT_PARAM_METAS);

  // ── Results Tab State ──
  const [analysisResults, setAnalysisResults] = useState<any>(null);
  const [resultsResidues, setResultsResidues] = useState<Record<string, CpmgResultResidue>>({});
  const [resultsGlobals, setResultsGlobals] = useState<Record<string, { value: number; error?: number }>>({});
  const [resultsStats, setResultsStats] = useState<any>({});
  const [diagnostics, setDiagnostics] = useState<CpmgDiagnosticsResult | undefined>(undefined);

  const logRef = useRef<HTMLDivElement>(null);

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

  const availableResidueKeys = useMemo(
    () => profiles.map((p) => p.residue),
    [profiles]
  );

  const residueMapping = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of profiles) {
      if (p.residue) {
        map[p.residue] = p.full_residue || p.residue;
      }
    }
    return map;
  }, [profiles]);

  useEffect(() => {
    const fetchParams = async () => {
      try {
        const res = await api.get(
          `/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/cpmg/method-parameters`,
          { params: { model } }
        );
        if (res.data?.parameters) {
          setAvailableParamsMeta(res.data.parameters);
        }
      } catch {
        // fallback to default
      }
    };
    fetchParams();
  }, [model, projectUuid, analysis.analysis_uuid]);

  const fetchLogs = async () => {
    try {
      const res = await api.get(`/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/cpmg/logs`);
      if (res.data.logs) setLogs(res.data.logs);
      if (res.data.status && res.data.status !== status) {
        setStatus(res.data.status);
        if (res.data.status === "COMPLETED" || res.data.status === "FAILED") {
          setIsFitting(false);
          await fetchResults();
          if (res.data.status === "COMPLETED") {
            setActiveTab("results");
          }
          if (onUpdate) onUpdate();
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
        if (c.fitMode) setFitMode(c.fitMode);
        if (c.parameterConfig) {
          const defGlobals = createDefaultCpmgParameterConfig().globals;
          const rawRes = c.parameterConfig.residues || {};
          const cleanRes: Record<string, any> = {};
          for (const [k, v] of Object.entries(rawRes)) {
            const parsed = SpinSystemKey.parse(k);
            const canonKey = (parsed.resNum > 0 && parsed.spins.length <= 1) ? `${parsed.resNum}N` : (parsed.short || k);
            if (!cleanRes[canonKey] || k === canonKey) {
              cleanRes[canonKey] = v;
            }
          }
          setParameterConfig({
            ...c.parameterConfig,
            globals: { ...defGlobals, ...(c.parameterConfig.globals || {}) },
            residues: cleanRes,
          });
        }
        if (c.profiles) {
          setProfiles(c.profiles);
          setParameterConfig((prev) => {
            const resMap: Record<string, any> = {};
            const oldRes = prev.residues || {};
            for (const p of c.profiles) {
              if (!p?.residue) continue;
              const canonKey = p.residue;
              const existing = oldRes[canonKey] || (p.full_residue ? oldRes[p.full_residue] : undefined);
              resMap[canonKey] = {
                ...(existing || {}),
                cs_a: existing?.cs_a || (p.cs_a !== undefined ? { value: p.cs_a, source: { kind: "pick", pickSetHash: "peak_fit", at: new Date().toISOString() } } : undefined),
              };
            }
            return { ...prev, residues: resMap };
          });
        }
        if (c.generatedExperiments) setGeneratedExperiments(c.generatedExperiments);

        if (c.method_config && Array.isArray(c.method_config.steps) && c.method_config.steps.length > 0) {
          setMethodConfig(c.method_config);
          setMethodToml(methodConfigToToml(c.method_config));
          setIsRawEditMode(!!c.method_config.rawOverride);
        } else if (c.methodConfig && Array.isArray(c.methodConfig.steps) && c.methodConfig.steps.length > 0) {
          setMethodConfig(c.methodConfig);
          setMethodToml(methodConfigToToml(c.methodConfig));
          setIsRawEditMode(!!c.methodConfig.rawOverride);
        } else if (c.method_toml) {
          setMethodToml(c.method_toml);
          const parsed = tomlToConfig(c.method_toml);
          setMethodConfig(parsed.config);
          setUnparsedTomlLines(parsed.unparsed);
        }
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (!parameterConfig.excludedResidues || parameterConfig.excludedResidues.length === 0) return;

    setMethodConfig((prevConfig) => {
      let changed = false;
      const excludedSet = new Set(parameterConfig.excludedResidues);
      const nextSteps = prevConfig.steps.map((step) => {
        if (!step.residues || step.residues.length === 0) return step;
        const filtered = step.residues.filter((r) => !excludedSet.has(r));
        if (filtered.length !== step.residues.length) {
          changed = true;
          return { ...step, residues: filtered };
        }
        return step;
      });

      if (changed) {
        const next = { ...prevConfig, steps: nextSteps };
        setMethodToml(methodConfigToToml(next));
        return next;
      }
      return prevConfig;
    });
  }, [parameterConfig.excludedResidues]);

  const activeStep: Step = useMemo(() => {
    return methodConfig.steps[activeStepIdx] || methodConfig.steps[0] || createDefaultStep("STEP1");
  }, [methodConfig.steps, activeStepIdx]);

  const startingValues = useMemo<Record<string, number | string>>(() => {
    const pbVal = parameterConfig.globals?.pb?.value ?? 0.05;
    const kexVal = parameterConfig.globals?.kex_ab?.value ?? 500.0;
    return {
      pb: pbVal,
      kex_ab: kexVal,
      PB: pbVal,
      KEX_AB: kexVal,
    };
  }, [parameterConfig.globals]);

  const residueItems: ResidueItem[] = useMemo(() => {
    const excluded = new Set(parameterConfig.excludedResidues || []);
    return profiles
      .filter((p) => !excluded.has(p.residue) && !excluded.has(p.full_residue || ""))
      .map((p) => {
        const num = parseInt(p.residue.replace(/\D/g, ""), 10) || 0;
        const hasExp = p.experiments && p.experiments.length > 0;
        return {
          id: p.residue,
          number: num,
          label: p.full_residue || p.residue,
          hasData: !!hasExp,
        };
      });
  }, [profiles, parameterConfig.excludedResidues]);

  const knownParamNames = useMemo(() => {
    return availableParamsMeta.length > 0
      ? availableParamsMeta.map((p) => p.name)
      : ["PB", "KEX_AB", "DW_AB", "R2_A", "R2_B", "CS_A", "R1_A", "TAUC_A"];
  }, [availableParamsMeta]);

  const validationErrors = useMemo(() => {
    return validateMethodConfig(
      methodConfig,
      knownParamNames,
      residueItems.filter((r) => r.hasData).length
    );
  }, [methodConfig, knownParamNames, residueItems]);

  const blockingErrors = useMemo(() => {
    return validationErrors.filter((e) => e.severity === "error");
  }, [validationErrors]);

  const saveConfig = async () => {
    try {
      const effectiveMethodToml = isRawEditMode ? methodToml : methodConfigToToml(methodConfig);
      await api.put(`/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/cpmg/config`, {
        selectedSpectrumIds,
        selectedParentModule,
        resolvedModuleName,
        is0013,
        isAntiTrosy,
        isSmallProtein,
        isDoubleQuantum,
        setupValues,
        model,
        fitMode,
        parameterConfig,
        methodConfig,
        method_config: isRawEditMode ? { ...methodConfig, rawOverride: methodToml } : methodConfig,
        method_toml: effectiveMethodToml,
        profiles,
        generatedExperiments,
      });
      setSuccessMsg("Configuration saved");
      setTimeout(() => setSuccessMsg(""), 3000);
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
        const oldRes = parameterConfig.residues || {};
        const resMap: Record<string, any> = {};
        for (const p of res.data.profiles) {
          if (!p?.residue) continue;
          const canonKey = p.residue;
          const existing = oldRes[canonKey] || (p.full_residue ? oldRes[p.full_residue] : undefined);
          resMap[canonKey] = {
            ...(existing || {}),
            cs_a: existing?.cs_a || (p.cs_a !== undefined ? { value: p.cs_a, source: { kind: "pick", pickSetHash: "peak_fit", at: new Date().toISOString() } } : undefined),
          };
        }
        setParameterConfig((prev) => ({ ...prev, residues: resMap }));
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

  const handleToggleExclude = (resKey: string) => {
    const cur = new Set(parameterConfig.excludedResidues || []);
    if (cur.has(resKey)) {
      cur.delete(resKey);
    } else {
      cur.add(resKey);
    }
    setParameterConfig({
      ...parameterConfig,
      excludedResidues: Array.from(cur),
    });
  };

  const handleBulkSetExcluded = (excluded: string[]) => {
    setParameterConfig({
      ...parameterConfig,
      excludedResidues: excluded,
    });
  };

  const handleSeedSingleDw = (resKey: string, dwPpm: number) => {
    const curRes = parameterConfig.residues[resKey] || {};
    setParameterConfig({
      ...parameterConfig,
      residues: {
        ...parameterConfig.residues,
        [resKey]: {
          ...curRes,
          dw_ab: { value: dwPpm, source: { kind: "estimated_from_rex" } },
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
        dw_ab: { value: dwVal, source: { kind: "estimated_from_rex" } },
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

  const handleUseGridMinAsStarting = async () => {
    if (!analysisResults) return;
    try {
      const stepToUse = analysisResults.step_order?.[0] || 'STEP1';
      const res = await api.get(`/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/steps/${stepToUse}/grid`);
      const gridData = res.data;
      if (gridData && gridData.min_point && gridData.min_point.coordinates) {
        const coords = gridData.min_point.coordinates;
        const { nextConfig, updatedCount } = applyGridCoordinatesToCpmgConfig(parameterConfig, coords);
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

  const handleStepChange = (updatedStep: Step) => {
    const nextSteps = [...methodConfig.steps];
    nextSteps[activeStepIdx] = updatedStep;
    const nextConfig = {
      ...methodConfig,
      steps: nextSteps,
    };
    setMethodConfig(nextConfig);
    setMethodToml(methodConfigToToml(nextConfig));
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
    setMethodToml(methodConfigToToml(nextConfig));
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
    setMethodToml(methodConfigToToml(nextConfig));
  };

  const handleDeleteStep = (idx: number) => {
    if (methodConfig.steps.length <= 1) return;
    const nextSteps = methodConfig.steps.filter((_, i) => i !== idx);
    const nextConfig = { ...methodConfig, steps: nextSteps };
    setMethodConfig(nextConfig);
    setActiveStepIdx(Math.max(0, Math.min(activeStepIdx, nextSteps.length - 1)));
    setMethodToml(methodConfigToToml(nextConfig));
  };

  const handleRenameStep = (idx: number, newName: string) => {
    const nextSteps = [...methodConfig.steps];
    if (nextSteps[idx]) {
      nextSteps[idx] = { ...nextSteps[idx], name: newName };
      const nextConfig = { ...methodConfig, steps: nextSteps };
      setMethodConfig(nextConfig);
      setMethodToml(methodConfigToToml(nextConfig));
    }
  };

  const handleReorderSteps = (startIdx: number, endIdx: number) => {
    const nextSteps = [...methodConfig.steps];
    const [moved] = nextSteps.splice(startIdx, 1);
    nextSteps.splice(endIdx, 0, moved);
    const nextConfig = { ...methodConfig, steps: nextSteps };
    setMethodConfig(nextConfig);
    setActiveStepIdx(endIdx);
    setMethodToml(methodConfigToToml(nextConfig));
  };

  const handleApplyTemplate = (template: MethodTemplate) => {
    const cloned: MethodConfig = JSON.parse(JSON.stringify(template.config));
    setMethodConfig(cloned);
    setActiveStepIdx(0);
    setMethodToml(methodConfigToToml(cloned));
    setIsRawEditMode(false);
    setShowTemplateModal(false);
    setSuccessMsg(`Applied template: ${template.name}`);
    setTimeout(() => setSuccessMsg(""), 3000);
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
    setImportTomlText("");
    setSuccessMsg("Imported method.toml successfully");
    setTimeout(() => setSuccessMsg(""), 3000);
  };

  const handleRunFitting = async () => {
    if (blockingErrors.length > 0) {
      setError(`Cannot run ChemEx: ${blockingErrors[0].message}`);
      return;
    }
    try {
      setIsFitting(true);
      setError("");
      setActiveTab("logs");
      setLogs("Initiating ChemEx CPMG fitting...\n");

      const paramToml = configToCpmgToml(parameterConfig, selectedSpectraFields);
      const effectiveMethodToml = isRawEditMode ? methodToml : methodConfigToToml(methodConfig);

      const res = await api.post(`/api/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/cpmg/run`, {
        parameters_toml: paramToml,
        method_toml: effectiveMethodToml,
        method_config: isRawEditMode ? { ...methodConfig, rawOverride: methodToml } : methodConfig,
        fit_mode: fitMode,
        model: model,
        generatedExperiments,
        profiles,
        parameter_config: parameterConfig,
      });

      setStatus(res.data.status || "RUNNING");
    } catch (e: any) {
      setError(e.response?.data?.detail || "Failed to start fitting run");
      setIsFitting(false);
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

  const tabCls = (key: TabKey) =>
    `flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 whitespace-nowrap w-auto md:w-full ${
      isSidebarCollapsed ? "md:justify-center" : "md:justify-start"
    } ${
      activeTab === key
        ? "bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400 font-semibold text-base scale-[1.03] shadow-sm border border-blue-100/50 dark:border-blue-900/50"
        : "text-sm text-slate-600 hover:text-slate-900 hover:bg-slate-50 dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800/50"
    }`;

  const btnPrimary = "px-4 py-2 bg-blue-600 hover:bg-blue-700 dark:bg-indigo-600 dark:hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-all shadow-sm disabled:opacity-50";
  const btnSecondary = "px-4 py-2 bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 text-sm font-medium rounded-lg transition-all";
  const sectionCls = "bg-slate-50 dark:bg-slate-800/50 p-5 rounded-xl border border-slate-200 dark:border-slate-700";

  return (
    <div className="space-y-4">
      {/* Top Header Card */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4 rounded-2xl shadow-xs">
        <div className="flex items-center gap-3">
          <button
            onClick={() => window.history.back()}
            className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl text-slate-500 transition-colors"
          >
            <ChevronLeft size={20} />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-bold text-slate-900 dark:text-white">{analysis.name}</h2>
              <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wider border flex items-center gap-1.5 ${STATUS_COLORS[status] || STATUS_COLORS.PENDING}`}>
                {(status === "RUNNING" || status === "CANCELLING") && <Loader2 className="w-3 h-3 animate-spin" />}
                {status === "COMPLETED" && <CheckCircle2 className="w-3 h-3 text-emerald-600" />}
                <span>{status}</span>
              </span>
              <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wider bg-blue-50 text-blue-700 border border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800">
                {fitMode.toUpperCase()} FIT
              </span>
            </div>
          </div>
        </div>

        {/* Global Action Buttons */}
        <div className="flex items-center gap-2">
          {/* Fit Mode Switcher */}
          <div className="flex bg-slate-100 dark:bg-slate-800 p-1 rounded-xl border border-slate-200 dark:border-slate-700 mr-2">
            <button
              onClick={() => setFitMode("global")}
              className={`px-3 py-1 text-xs font-bold rounded-lg transition-all ${
                fitMode === "global"
                  ? "bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-400 shadow-xs"
                  : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
              }`}
            >
              Global
            </button>
            <button
              onClick={() => setFitMode("individual")}
              className={`px-3 py-1 text-xs font-bold rounded-lg transition-all ${
                fitMode === "individual"
                  ? "bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-400 shadow-xs"
                  : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
              }`}
            >
              Individual
            </button>
          </div>

          {/* Use Grid Minimum as Starting */}
          {(status === "COMPLETED" || status === "FAILED") &&
            analysisResults?.steps &&
            Object.values(analysisResults.steps).some((s: any) => s?.has_grid) && (
              <button
                onClick={handleUseGridMinAsStarting}
                className="px-3 py-1.5 bg-amber-50 hover:bg-amber-100 dark:bg-amber-950/40 dark:hover:bg-amber-900/40 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all shadow-xs"
                title="Populate starting parameters with grid minimum values"
              >
                <Sparkles className="w-3.5 h-3.5 text-amber-500" />
                <span>Use grid minimum as starting</span>
              </button>
          )}

          <button onClick={saveConfig} className={btnSecondary}>
            Save Config
          </button>

          {status === "RUNNING" || status === "CANCELLING" || isFitting ? (
            <button
              onClick={handleStop}
              disabled={isCancelling || status === "CANCELLING"}
              className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-bold rounded-lg shadow-sm transition-all flex items-center gap-1.5 disabled:opacity-50"
            >
              <Square size={16} />
              <span>{isCancelling || status === "CANCELLING" ? "Cancelling..." : "Stop ChemEx"}</span>
            </button>
          ) : (
            <button
              onClick={handleRunFitting}
              disabled={isFitting || generatedExperiments.length === 0 || blockingErrors.length > 0}
              className={`${btnPrimary} flex items-center gap-1.5 font-bold`}
            >
              {isFitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4 fill-current" />}
              <span>Run ChemEx</span>
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      {error && (
        <div className="p-4 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 rounded-xl text-xs text-red-600 dark:text-red-400 flex items-center justify-between">
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
        <div className="p-4 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 rounded-xl text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{successMsg}</span>
        </div>
      )}

      {/* Main Layout: Left Tab Bar + Right Content */}
      <div className="flex flex-col md:flex-row bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-xs overflow-hidden min-h-[700px]">
        {/* Sidebar Tabs */}
        <div
          className={`flex md:flex-col border-b md:border-b-0 md:border-r border-slate-200 dark:border-slate-800 p-3 bg-slate-50/50 dark:bg-slate-900/50 gap-1.5 transition-all duration-300 overflow-x-auto ${
            isSidebarCollapsed ? "md:w-20" : "md:w-64"
          }`}
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

          {(status === "COMPLETED" || status === "FAILED") && (
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
            <CpmgParametersTab
              parameterConfig={parameterConfig}
              onChangeConfig={(updated) => setParameterConfig(updated)}
              availableResidues={availableResidueKeys}
              residueLabels={residueMapping}
              fields={selectedSpectraFields}
              unitLabel={nucleusInfo.unitLabel}
              projectUuid={projectUuid}
              analysisUuid={analysis.analysis_uuid}
              analysisName={analysis.name}
              model={model}
              onToggleExcludeResidue={handleToggleExclude}
            />
          )}

          {activeTab === "methods" && (
            <div className="space-y-6 animate-in fade-in">
              {/* Header Bar */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-800 gap-4">
                <div>
                  <h3 className="text-base font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
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
                        setMethodToml(methodConfigToToml(methodConfig));
                      }
                      setIsRawEditMode(!isRawEditMode);
                    }}
                    className={`px-3 py-1.5 text-xs font-bold rounded-lg border transition-all flex items-center gap-1.5 shadow-sm ${
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
                      <span className="font-semibold">Notice:</span> This configuration contains{" "}
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
                    onChange={(e) => setMethodToml(e.target.value)}
                    rows={16}
                    className="w-full px-3 py-2 border rounded-xl bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 border-slate-300 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-xs"
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
                      onNavigateToParameters={() => setActiveTab("parameters")}
                    />
                  </div>

                  {/* Active Step Residue Selector */}
                  <ResidueSelector
                    residues={residueItems}
                    mode={activeStep.residueMode || "include"}
                    selectedIds={activeStep.residues || []}
                    onModeChange={(newMode) => handleStepChange({ ...activeStep, residueMode: newMode })}
                    onSelectionChange={(newRes) => handleStepChange({ ...activeStep, residues: newRes })}
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
                      {methodConfig.steps.length} step{methodConfig.steps.length > 1 ? "s" : ""}
                    </span>
                  </button>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        const toml = isRawEditMode ? methodToml : methodConfigToToml(methodConfig);
                        navigator.clipboard.writeText(toml);
                        setSuccessMsg("Copied method.toml to clipboard");
                        setTimeout(() => setSuccessMsg(""), 2500);
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
                        const toml = isRawEditMode ? methodToml : methodConfigToToml(methodConfig);
                        const blob = new Blob([toml], { type: "text/plain" });
                        const url = URL.createObjectURL(blob);
                        const link = document.createElement("a");
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
                      {isRawEditMode ? methodToml : methodConfigToToml(methodConfig)}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === "logs" && (
            <div className="bg-slate-950 text-slate-200 font-mono text-xs p-4 rounded-xl h-[500px] overflow-auto" ref={logRef}>
              <pre>{logs || "No logs yet. Execute fitting from the top action bar to see ChemEx stdout."}</pre>
            </div>
          )}

          {activeTab === "results" && (
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
            />
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
              {METHOD_TEMPLATES.map((tmpl) => {
                const stepCount = tmpl.config.steps.length;
                const fitParams = Array.from(
                  new Set(
                    tmpl.config.steps.flatMap((s) =>
                      s.parameters.filter((p) => p.mode === "fit").map((p) => p.name)
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
                          {stepCount} Step{stepCount > 1 ? "s" : ""}
                        </span>
                      </div>
                      <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed max-w-lg">
                        {tmpl.description}
                      </p>
                      <div className="flex flex-wrap items-center gap-1 pt-1">
                        <span className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider mr-1">Fitted:</span>
                        {fitParams.map((p) => (
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
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      const reader = new FileReader();
                      reader.onload = (ev) => {
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
                  onChange={(e) => setImportTomlText(e.target.value)}
                  rows={10}
                  placeholder={`[STEP1]\nFIT = ["PB", "KEX_AB", "DW_AB", "R2_A"]\nCONSTRAINTS = ["[PB] < 0.5"]`}
                  className="w-full px-3 py-2 border rounded-xl bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 border-slate-300 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-xs"
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
    </div>
  );
};
