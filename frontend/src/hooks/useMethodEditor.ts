/**
 * Shared Methods-tab state for every ChemEx analysis page (CEST, CPMG, EXCHANGE).
 *
 * Owns the structured MethodConfig, its raw method.toml mirror, raw-edit mode, the
 * active step, backend parameter metadata, validation, and the save/restore shape.
 * State lives in the manager (not in the tab component) so nothing is lost when the
 * user switches tabs.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../services/api';
import type { ChemexEndpointFamily } from '../lib/experimentPlugin';
import type { MethodConfig, Step } from '../lib/methodConfig';
import { createDefaultMethodConfig, createDefaultStep, normalizeMethodConfig } from '../lib/methodConfig';
import { configToToml, tomlToConfig } from '../lib/methodToml';
import { validateMethodConfig } from '../lib/methodValidation';
import type { MethodTemplate } from '../lib/methodTemplates';
import { DEFAULT_PARAM_METAS, type AvailableParamMeta } from '../components/methods/ParameterTable';
import type { ResidueItem } from '../components/methods/ResidueSelector';


/** URL segment of the per-analysis ChemEx routes for each family. */
export function chemexAnalysisBase(projectUuid: string, analysisUuid: string, family: ChemexEndpointFamily): string {
  const root = `/api/projects/${projectUuid}/analysis`;
  return family === 'exchange' ? `${root}/${analysisUuid}/exchange` : `${root}/${analysisUuid}/${family}`;
}

/** Fallback parameter names used for validation until backend metadata arrives. */
export const FALLBACK_KNOWN_PARAM_NAMES = DEFAULT_PARAM_METAS.map(p => p.name);

export interface SavedMethodState {
  method_config?: (MethodConfig & { rawOverride?: string }) | null;
  method_toml?: string | null;
}

export interface UseMethodEditorOptions {
  projectUuid: string;
  analysisUuid: string;
  family: ChemexEndpointFamily;
  model: string;
  /** Residues selectable in a step (already filtered for exclusions by the caller). */
  residueItems: ResidueItem[];
  /** Exclusion predicate used to prune excluded residues out of step selections. */
  isResidueExcluded: (resId: string) => boolean;
  /** Changes whenever the exclusion set changes (e.g. parameterConfig.excludedResidues). */
  exclusionKey: unknown;
  notify?: (message: string) => void;
}

const newStepId = () => `step_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

export function useMethodEditor(opts: UseMethodEditorOptions) {
  const { projectUuid, analysisUuid, family, model, residueItems, notify } = opts;

  const [methodConfig, setMethodConfigState] = useState<MethodConfig>(createDefaultMethodConfig);
  const [methodToml, setMethodToml] = useState<string>(() => configToToml(createDefaultMethodConfig()));
  const [isRawEditMode, setIsRawEditMode] = useState(false);
  const [unparsedTomlLines, setUnparsedTomlLines] = useState<string[]>([]);
  const [activeStepIdx, setActiveStepIdx] = useState(0);
  const [availableParamsMeta, setAvailableParamsMeta] = useState<AvailableParamMeta[]>(DEFAULT_PARAM_METAS);

  /** Replace the structured config and keep the TOML mirror in sync. */
  const setMethodConfig = useCallback((next: MethodConfig) => {
    setMethodConfigState(next);
    setMethodToml(configToToml(next));
  }, []);

  // ── Backend parameter catalogue (same source for every experiment) ──
  useEffect(() => {
    let cancelled = false;
    api
      .get(`${chemexAnalysisBase(projectUuid, analysisUuid, family)}/method-parameters`, { params: { model } })
      .then(res => {
        const list: AvailableParamMeta[] = res.data?.parameters || (Array.isArray(res.data) ? res.data : []);
        if (!cancelled && list.length > 0) setAvailableParamsMeta(list);
      })
      .catch(err => console.warn('Failed to fetch method parameters from backend', err));
    return () => {
      cancelled = true;
    };
  }, [projectUuid, analysisUuid, family, model]);

  // ── Prune excluded residues out of step selections ──
  const isExcludedRef = useRef(opts.isResidueExcluded);
  useEffect(() => {
    isExcludedRef.current = opts.isResidueExcluded;
  });
  useEffect(() => {
    setMethodConfigState(prev => {
      let changed = false;
      const steps = prev.steps.map(step => {
        if (!step.residues || step.residues.length === 0) return step;
        const kept = step.residues.filter(r => !isExcludedRef.current(r));
        if (kept.length === step.residues.length) return step;
        changed = true;
        return { ...step, residues: kept };
      });
      if (!changed) return prev;
      const next = { ...prev, steps };
      setMethodToml(configToToml(next));
      return next;
    });
  }, [opts.exclusionKey]);

  const activeStep: Step = methodConfig.steps[activeStepIdx] || methodConfig.steps[0] || createDefaultStep();

  // ── Step operations ──
  const updateSteps = useCallback(
    (steps: Step[], nextActive?: number) => {
      setMethodConfig({ ...methodConfig, steps });
      if (nextActive !== undefined) setActiveStepIdx(nextActive);
    },
    [methodConfig, setMethodConfig]
  );

  const handleStepChange = (updated: Step) => {
    const steps = [...methodConfig.steps];
    steps[activeStepIdx] = updated;
    updateSteps(steps);
  };

  const stepHandlers = {
    onSelectStep: setActiveStepIdx,
    onAddStep: () => {
      const steps = [...methodConfig.steps, createDefaultStep(`STEP${methodConfig.steps.length + 1}`)];
      updateSteps(steps, steps.length - 1);
    },
    onDuplicateStep: (idx: number) => {
      const src = methodConfig.steps[idx];
      if (!src) return;
      const dup: Step = { ...JSON.parse(JSON.stringify(src)), id: newStepId(), name: `${src.name}_COPY` };
      const steps = [...methodConfig.steps];
      steps.splice(idx + 1, 0, dup);
      updateSteps(steps, idx + 1);
    },
    onDeleteStep: (idx: number) => {
      if (methodConfig.steps.length <= 1) return;
      const steps = methodConfig.steps.filter((_, i) => i !== idx);
      updateSteps(steps, Math.max(0, Math.min(activeStepIdx, steps.length - 1)));
    },
    onRenameStep: (idx: number, name: string) => {
      if (!methodConfig.steps[idx]) return;
      const oldName = (methodConfig.steps[idx].name || '').trim().toUpperCase();
      const newName = name.trim().toUpperCase();
      // Keep ROLES_FROM references pointing at the renamed step.
      const steps = methodConfig.steps.map((s, i) => {
        if (i === idx) return { ...s, name };
        if (oldName && s.rolesFrom && s.rolesFrom.trim().toUpperCase() === oldName) return { ...s, rolesFrom: newName };
        return s;
      });
      updateSteps(steps);
    },
    onReorderSteps: (from: number, to: number) => {
      const steps = [...methodConfig.steps];
      const [moved] = steps.splice(from, 1);
      steps.splice(to, 0, moved);
      updateSteps(steps, to);
    },
  };

  // ── Raw TOML mode ──
  const enterRawMode = () => {
    setMethodToml(configToToml(methodConfig));
    setIsRawEditMode(true);
  };
  const toggleRawMode = () => (isRawEditMode ? setIsRawEditMode(false) : enterRawMode());
  /** Parse the raw text back into the structured form. */
  const applyRawToml = () => {
    let parsed: ReturnType<typeof tomlToConfig>;
    try {
      parsed = tomlToConfig(methodToml);
    } catch (err: unknown) {
      notify?.(`Cannot parse method.toml: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    setMethodConfigState(normalizeMethodConfig(parsed.config));
    setUnparsedTomlLines(parsed.unparsed);
    setActiveStepIdx(0);
    setIsRawEditMode(false);
  };
  const discardRawToml = () => {
    setMethodToml(configToToml(methodConfig));
    setIsRawEditMode(false);
  };

  // ── Templates & import ──
  const applyTemplate = (template: MethodTemplate) => {
    setMethodConfig(normalizeMethodConfig(JSON.parse(JSON.stringify(template.config))));
    setActiveStepIdx(0);
    setUnparsedTomlLines([]);
    setIsRawEditMode(false);
    notify?.(`Applied template: ${template.name}`);
  };

  /** Returns an error message, or null on success. */
  const importToml = (text: string): string | null => {
    if (!text.trim()) return 'Nothing to import';
    try {
      const parsed = tomlToConfig(text);
      const cfg = normalizeMethodConfig(parsed.config);
      setMethodConfigState(cfg);
      // Show the canonical v2 rendering (legacy v1 input is migrated).
      setMethodToml(configToToml(cfg));
      setUnparsedTomlLines(parsed.unparsed);
      setActiveStepIdx(0);
      setIsRawEditMode(false);
      notify?.('Imported method.toml successfully');
      return null;
    } catch (err: any) {
      return `Failed to parse method TOML: ${err?.message || err}`;
    }
  };

  // ── Validation ──
  const knownParamNames = useMemo(
    () => Array.from(new Set([...FALLBACK_KNOWN_PARAM_NAMES, ...availableParamsMeta.map(p => p.name)])),
    [availableParamsMeta]
  );
  const validationErrors = useMemo(
    () => validateMethodConfig(methodConfig, knownParamNames, residueItems.filter(r => r.hasData).length),
    [methodConfig, knownParamNames, residueItems]
  );
  const blockingErrors = useMemo(() => validationErrors.filter(e => e.severity === 'error'), [validationErrors]);

  // ── Persistence ──
  const effectiveMethodToml = isRawEditMode ? methodToml : configToToml(methodConfig);
  const methodConfigForSave: MethodConfig & { rawOverride?: string } = isRawEditMode
    ? { ...methodConfig, rawOverride: methodToml }
    : methodConfig;

  /** Restore from a saved (already normalized) config. Returns true if anything was restored. */
  const restore = useCallback((saved: SavedMethodState): boolean => {
    const cfg = saved.method_config;
    if (cfg && Array.isArray(cfg.steps) && cfg.steps.length > 0) {
      const { rawOverride, ...rest } = cfg;
      const structured = normalizeMethodConfig(rest as MethodConfig);
      setMethodConfigState(structured);
      if (rawOverride && rawOverride.trim()) {
        setMethodToml(rawOverride);
        setIsRawEditMode(true);
      } else {
        setMethodToml(configToToml(structured));
        setIsRawEditMode(false);
      }
      setActiveStepIdx(0);
      return true;
    }
    if (saved.method_toml) {
      try {
        const parsed = tomlToConfig(saved.method_toml);
        setMethodConfigState(normalizeMethodConfig(parsed.config));
        setUnparsedTomlLines(parsed.unparsed);
      } catch {
        // Unparseable saved TOML: keep it verbatim in raw mode rather than losing it.
        setIsRawEditMode(true);
      }
      setMethodToml(saved.method_toml);
      setActiveStepIdx(0);
      return true;
    }
    return false;
  }, []);

  return {
    family,
    methodConfig,
    setMethodConfig,
    methodToml,
    setMethodToml,
    isRawEditMode,
    enterRawMode,
    toggleRawMode,
    applyRawToml,
    discardRawToml,
    unparsedTomlLines,
    activeStepIdx,
    setActiveStepIdx,
    activeStep,
    handleStepChange,
    stepHandlers,
    applyTemplate,
    importToml,
    availableParamsMeta,
    knownParamNames,
    validationErrors,
    blockingErrors,
    effectiveMethodToml,
    methodConfigForSave,
    restore,
  };
}

export type MethodEditor = ReturnType<typeof useMethodEditor>;
