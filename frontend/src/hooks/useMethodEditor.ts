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
import { createDefaultMethodConfig, createDefaultStep, migrateSavedConfig, newMethodId, normalizeMethodConfig } from '../lib/methodConfig';
import { setRolesFrom, stepDisplayName, uniqueStepName } from '../lib/methodSteps';
import { configToToml, tomlToConfig } from '../lib/methodToml';
import { validateMethodConfig, type ValidationError } from '../lib/methodValidation';
import { partitionDismissed, restoreIssue as restoreIssueIn, type QuickFix } from '../lib/methodQuickFixes';
import type { MethodTemplate } from '../lib/methodTemplates';
import { DEFAULT_PARAM_METAS, type AvailableParamMeta } from '../components/methods/ParameterTable';
import type { ResidueItem } from '../components/methods/ResidueSelector';
import { useBaselineRoles } from './useBaselineRoles';
import { useResolvedRoles } from './useResolvedRoles';
import { useStepTimings } from './useStepTimings';
import { useLastRunMethod } from './useLastRunMethod';
import { useProjectSettings } from './useProjectSettings';
import { useRunOverview } from './useRunOverview';
import { deEdgeIssues, gridEdgeIssues } from '../lib/runChecks';
import { scienceIssues } from '../lib/scienceChecks';
import { isPreviousMethod } from '../lib/runOverview';
import { chemexIssues } from '../lib/resolvedRoles';


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
  /** Fingerprint of the experiment inputs (generated experiment files); refreshes the ChemEx baseline roles. */
  inputsKey?: string;
  /** While a run is in progress the method is the submitted snapshot: no automatic edits. */
  locked?: boolean;
  /** Current (possibly unsaved) parameters.toml, used for ChemEx inspection/resolution. */
  parameterToml?: string;
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
  /** Project-level Methods metadata (sequence offset, check toggles, named selections, templates). */
  const projectSettings = useProjectSettings(projectUuid);
  /** Roles ChemEx assigns with no ROLES actions — what "Default" means for this analysis. */
  const baselineRoles = useBaselineRoles({
    projectUuid,
    analysisUuid,
    model,
    inputsKey: opts.inputsKey ?? '',
    parameterToml: opts.parameterToml,
  });


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
    if (opts.locked) return; // re-runs on unlock
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
  }, [opts.exclusionKey, opts.locked]);

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

  /** Index of a step id in `steps` (keeps the user's active step across reorder/delete). */
  const indexOfId = (steps: Step[], id: string | undefined, fallback: number) => {
    const k = id ? steps.findIndex(s => s.id === id) : -1;
    return k === -1 ? Math.max(0, Math.min(fallback, steps.length - 1)) : k;
  };

  const stepHandlers = {
    onSelectStep: setActiveStepIdx,
    onAddStep: () => {
      const steps = [...methodConfig.steps, createDefaultStep(uniqueStepName(`STEP${methodConfig.steps.length + 1}`, methodConfig.steps))];
      updateSteps(steps, steps.length - 1);
    },
    onDuplicateStep: (idx: number) => {
      const src = methodConfig.steps[idx];
      if (!src) return;
      const copy: Step = JSON.parse(JSON.stringify(src));
      const dup: Step = {
        ...copy,
        id: newStepId(),
        name: uniqueStepName(`${stepDisplayName(src, idx)}_COPY`, methodConfig.steps),
        // Fresh ids so rules/axes of the two steps never share DOM ids or React keys.
        roleRules: (copy.roleRules ?? []).map(r => ({ ...r, id: newMethodId('rule') })),
        search: copy.search ? { ...copy.search, axes: copy.search.axes.map(a => ({ ...a, id: newMethodId('axis') })) } : copy.search,
      };
      const steps = [...methodConfig.steps];
      steps.splice(idx + 1, 0, dup);
      updateSteps(steps, idx + 1);
    },
    /**
     * Steps whose ROLES_FROM pointed at the deleted step keep the (now dangling)
     * reference: validation shows it instead of silently changing their roles.
     */
    onDeleteStep: (idx: number) => {
      if (methodConfig.steps.length <= 1) return;
      const activeId = methodConfig.steps[activeStepIdx]?.id;
      const steps = methodConfig.steps.filter((_, i) => i !== idx);
      updateSteps(steps, indexOfId(steps, activeId === methodConfig.steps[idx]?.id ? undefined : activeId, Math.min(activeStepIdx, idx)));
    },
    onRenameStep: (idx: number, name: string) => {
      const target = methodConfig.steps[idx];
      if (!target) return;
      const newName = name.trim();
      // References are by id; only the name snapshot used for display/legacy needs refreshing.
      const steps = methodConfig.steps.map((s, i) => {
        if (i === idx) return { ...s, name: newName };
        if (s.rolesFromStepId === target.id) return { ...s, rolesFrom: newName };
        return s;
      });
      updateSteps(steps);
    },
    /**
     * Insert a plain TRF step right after a GRID step: ROLES_FROM the grid step (so its
     * roles carry over and the grid axes are released as ordinary FIT coordinates) and
     * the same residue selection; values continue from the committed grid state.
     */
    onAddRefineStep: (idx: number) => {
      const src = methodConfig.steps[idx];
      if (!src) return;
      const name = uniqueStepName(`${stepDisplayName(src, idx)}_REFINE`, methodConfig.steps);
      const refine: Step = setRolesFrom(
        { id: newStepId(), name, parameters: [], residueMode: src.residueMode, residues: [...(src.residues || [])], roleRules: [] },
        src,
        idx
      );
      const steps = [...methodConfig.steps];
      steps.splice(idx + 1, 0, refine);
      updateSteps(steps, idx + 1);
    },
    /** Reordering never rewrites ROLES_FROM; a reference that now points forward is reported. */
    onReorderSteps: (from: number, to: number) => {
      if (from === to || to < 0 || to >= methodConfig.steps.length) return;
      const activeId = methodConfig.steps[activeStepIdx]?.id;
      const steps = [...methodConfig.steps];
      const [moved] = steps.splice(from, 1);
      steps.splice(to, 0, moved);
      updateSteps(steps, indexOfId(steps, activeId, to));
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
  /** 'method' templates replace the method; 'addition' templates change the current one. */
  const applyTemplate = (template: MethodTemplate) => {
    if (template.kind === 'addition') {
      const next = template.apply(methodConfig, activeStepIdx);
      setMethodConfig(next.config);
      setActiveStepIdx(next.activeStepIdx);
      notify?.(`Added: ${template.name}`);
      return;
    }
    setMethodConfig(migrateSavedConfig(JSON.parse(JSON.stringify(template.config))));
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
  /** Instant local checks (ChemEx's own verdict is merged in below). */
  const baselineFitNames = useMemo(
    () =>
      Object.entries(baselineRoles.roles ?? {})
        .filter(([, c]) => c.fit > 0)
        .map(([name]) => name)
        .sort(),
    [baselineRoles.roles]
  );
  const localValidationErrors = useMemo(
    () =>
      validateMethodConfig(methodConfig, knownParamNames, residueItems.filter(r => r.hasData).length, baselineRoles.catalog, {
        baselineFitNames,
      }),
    [methodConfig, knownParamNames, residueItems, baselineRoles.catalog, baselineFitNames]
  );

  // ── Persistence ──
  const effectiveMethodToml = isRawEditMode ? methodToml : configToToml(methodConfig);

  /** method.toml of the last completed run (for the TOML panel's diff view). */
  const lastRunMethod = useLastRunMethod(projectUuid, analysisUuid, opts.locked ? 'running' : 'idle');

  /** Last run's per-step durations (refreshed when a run ends) for runtime estimates. */
  const runTimings = useStepTimings(projectUuid, analysisUuid, opts.locked ? 'running' : 'idle');
  const stepTimings = runTimings.steps;
  const runWorkers = runTimings.workers;

  /** Last completed run per step (values, GRID landscape, MCMC flags), from the results bundle. */
  const runOverview = useRunOverview(projectUuid, analysisUuid, opts.locked ? 'running' : 'idle');
  /** The method changed since that run: its committed values belong to a previous method. */
  const previousMethod = useMemo(() => isPreviousMethod(runOverview.overview, effectiveMethodToml), [runOverview.overview, effectiveMethodToml]);
  const checkSettings = projectSettings.settings.scientific_checks;
  const runIssues = useMemo(
    () => [
      ...gridEdgeIssues(methodConfig, runOverview.overview, { family, settings: checkSettings }),
      ...deEdgeIssues(methodConfig, runOverview.overview, { family, settings: checkSettings }),
    ],
    [methodConfig, runOverview.overview, family, checkSettings]
  );

  /** Per-step effective roles of every concrete parameter, resolved by ChemEx (debounced). */
  const resolvedRoles = useResolvedRoles({
    projectUuid,
    analysisUuid,
    model,
    inputsKey: opts.inputsKey ?? '',
    methodToml: effectiveMethodToml,
    parameterToml: opts.parameterToml,
  });

  /**
   * All problems: instant local checks + what ChemEx reported for the current method text
   * (a stale report is ignored — the run pre-flight re-checks with ChemEx anyway).
   * Every error blocks Run.
   */
  const { active: validationErrors, dismissed: dismissedIssues } = useMemo(() => {
    const fromChemex = resolvedRoles.stale ? [] : chemexIssues(resolvedRoles.report, methodConfig.steps);
    // Scientific hints need a current ChemEx resolution (stale roles would point at an older method).
    const science = resolvedRoles.stale
      ? []
      : scienceIssues({ config: methodConfig, report: resolvedRoles.report, overview: runOverview.overview, family, settings: checkSettings });
    return partitionDismissed<ValidationError>([...localValidationErrors, ...runIssues, ...science, ...fromChemex], methodConfig);
  }, [localValidationErrors, runIssues, resolvedRoles.report, resolvedRoles.stale, methodConfig, runOverview.overview, family, checkSettings]);
  /** Apply an issue's quick-fix (ignored while the method is locked by a run). */
  const applyQuickFix = useCallback(
    (fix: QuickFix) => {
      if (opts.locked) return;
      setMethodConfig(normalizeMethodConfig(fix.apply(methodConfig)));
    },
    [methodConfig, opts.locked, setMethodConfig]
  );
  const restoreIssue = useCallback(
    (stepId: string, key: string) => {
      if (opts.locked) return;
      setMethodConfig(restoreIssueIn(methodConfig, stepId, key));
    },
    [methodConfig, opts.locked, setMethodConfig]
  );
  const blockingErrors = useMemo(() => validationErrors.filter(e => e.severity === 'error'), [validationErrors]);
  const methodConfigForSave: MethodConfig & { rawOverride?: string } = isRawEditMode
    ? { ...methodConfig, rawOverride: methodToml }
    : methodConfig;

  /** Restore from a saved (already normalized) config. Returns true if anything was restored. */
  const restore = useCallback((saved: SavedMethodState): boolean => {
    const cfg = saved.method_config;
    if (cfg && Array.isArray(cfg.steps) && cfg.steps.length > 0) {
      const { rawOverride, ...rest } = cfg;
      // Configs saved by older versions: explicit search FITs and "All profiles" (same meaning).
      const structured = migrateSavedConfig(rest as MethodConfig);
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
    projectUuid,
    analysisUuid,
    projectSettings,
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
    baselineRoles,
    resolvedRoles,
    stepTimings,
    runWorkers,
    lastRunMethod,
    runOverview,
    previousMethod,
    knownParamNames,
    validationErrors,
    dismissedIssues,
    applyQuickFix,
    restoreIssue,
    blockingErrors,
    effectiveMethodToml,
    methodConfigForSave,
    restore,
  };
}

export type MethodEditor = ReturnType<typeof useMethodEditor>;
