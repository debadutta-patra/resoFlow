/**
 * Methods tab shared by every ChemEx analysis page (CEST, CPMG, EXCHANGE).
 *
 * Purely presentational over a `MethodEditor` (see hooks/useMethodEditor): the
 * manager owns the state, this component renders the identical layout everywhere.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { BookmarkPlus, FlaskConical, FlaskRound, History, Lock, Redo2, Sparkles, Undo2, Upload, Workflow } from 'lucide-react';
import type { StartingProvenance } from '../../lib/parameterConfig';
import type { MethodEditor } from '../../hooks/useMethodEditor';
import { METHOD_TEMPLATES, additionTarget, type MethodAdditionTemplate, type MethodTemplate } from '../../lib/methodTemplates';
import { tomlToConfig } from '../../lib/methodToml';
import ParameterTable from './ParameterTable';
import ResidueSelector, { type ResidueItem } from './ResidueSelector';
import StepTabs from './StepTabs';
import StepStatisticsSection from './StepStatisticsSection';
import StepSearchSection from './StepSearchSection';
import StepRolesSection from './StepRolesSection';
import ResolvedRolesSummary from './ResolvedRolesSummary';
import { errorsForStep, resolvedCountsByName, ruleDomId, rulesByTargetName, stepBadge, type StepBadge } from '../../lib/resolvedRoles';
import MethodTomlPanel from './MethodTomlPanel';
import MethodIssueBanner from './MethodIssueBanner';
import SequenceImportModal from './SequenceImportModal';
import { overviewStep, stepResultBadge, type StepResultBadge } from '../../lib/runOverview';
import McmcDiagnosticsTab from './McmcDiagnosticsTab';
import { toMcmcMethodData } from './StatisticsResultsSection';
import GridLandscape from './GridLandscape';
import PipelineStrip from './PipelineStrip';
import { LoadFromRunModal, SaveTemplateModal, TestRunModal } from './MethodWorkflowModals';
import { useUserPreferences } from '../../hooks/useUserPreferences';
import type { StoredMethodTemplate } from '../../hooks/useProjectSettings';
import type { MethodConfig } from '../../lib/methodConfig';
import { STEP_SECTIONS, sectionCounts, sectionDomId } from '../../lib/issueSections';
import { methodRuntime, runtimeText, stepRuntime, stepSummaryText } from '../../lib/stepSummary';
import ResiduePreview from './ResiduePreview';
import { availableChipMetrics, chipMetricValues, gapNumbers, type ChipMetric, type PickLike } from '../../lib/residueMetrics';
import { sequenceRange } from '../../lib/sequence';
import type { CestProfile } from '../parameters/ProfileThumbnail';
import ScienceChecksModal from './ScienceChecksModal';
import { checkEnabled } from '../../lib/scienceChecks';
import { JointDistributionModal } from './JointDistributionModal';
import { strongCorrelationsByName } from '../../lib/runOverview';
import { itemHasType, labelWithSequence } from '../../lib/sequence';
import { stepDisplayName } from '../../lib/methodSteps';
import {
  ChemexModalShell,
  ChemexTabHeader,
  RawModeToggleButton,
  RawTomlEditor,
  UnparsedLinesNotice,
  actionBtnAccent,
  actionBtnNeutral,
  chemexBtnPrimary,
  chemexBtnSecondary,
  chemexInputCls,
} from '../chemex/TomlEditorParts';

export interface MethodsTabProps {
  editor: MethodEditor;
  analysisUuid: string;
  residueItems: ResidueItem[];
  startingValues: Record<string, number | string>;
  onNavigateToParameters: () => void;
  notify?: (message: string) => void;
  /** Step-1 starting-value provenance per parameter (upper-case keys). */
  startingProvenance?: Record<string, StartingProvenance>;
  /** Last completed run's committed global values per step name. */
  committedByStep?: Record<string, Record<string, number>>;
  /** True while a run is queued or in progress: the editor shows the submitted snapshot read-only. */
  readOnly?: boolean;
  /** Raw per-step results of the last run (results bundle), for the MCMC diagnostics view. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resultsSteps?: Record<string, any>;
  /** CEST profiles and Pick CEST picks (chip shading by dip depth, hover thumbnails). */
  profiles?: CestProfile[];
  picks?: Record<string, PickLike | null | undefined>;
}

export const MethodsTab: React.FC<MethodsTabProps> = ({
  editor,
  analysisUuid,
  residueItems,
  startingValues,
  onNavigateToParameters,
  notify,
  startingProvenance,
  committedByStep,
  readOnly = false,
  resultsSteps,
  profiles,
  picks,
}) => {
  const [showTemplates, setShowTemplates] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showSequence, setShowSequence] = useState(false);
  const [showChecks, setShowChecks] = useState(false);
  const [joint, setJoint] = useState<{ x: string; y: string; method: string; step: string } | null>(null);
  const { sequence, settings: projectSettings } = editor.projectSettings;
  /** Chips carry the residue type from assignment names, else from the project sequence. */
  const labeledResidues = useMemo(
    () => labelWithSequence(residueItems, sequence, projectSettings.sequence_offset),
    [residueItems, sequence, projectSettings.sequence_offset]
  );
  const [showSaveTemplate, setShowSaveTemplate] = useState(false);
  const [showLoadRun, setShowLoadRun] = useState(false);
  const [showTestRun, setShowTestRun] = useState(false);
  const userPrefs = useUserPreferences();
  const userTemplates = useMemo(
    () => [
      ...projectSettings.method_templates.map(t => ({ ...t, scope: 'project' as const })),
      ...userPrefs.prefs.method_templates.map(t => ({ ...t, scope: 'user' as const })),
    ],
    [projectSettings.method_templates, userPrefs.prefs.method_templates]
  );
  const saveTemplate = async ({ name, description, scope }: { name: string; description: string; scope: 'project' | 'user' }) => {
    const entry: StoredMethodTemplate = {
      id: `tmpl_${Date.now().toString(36)}`,
      name,
      description,
      family: editor.family,
      config: JSON.parse(JSON.stringify(editor.methodConfigForSave)),
      created_at: new Date().toISOString(),
    };
    const ok =
      scope === 'project'
        ? await editor.projectSettings.update({ method_templates: [...projectSettings.method_templates.filter(t => t.name !== name), entry] })
        : await userPrefs.update({ method_templates: [...userPrefs.prefs.method_templates.filter(t => t.name !== name), entry] });
    if (ok) notify?.(`Saved template "${name}"`);
    return ok;
  };
  const residueTypesKnown = useMemo(() => labeledResidues.some(itemHasType), [labeledResidues]);
  const gaps = useMemo(
    () => gapNumbers(residueItems, sequence ? sequenceRange(sequence, projectSettings.sequence_offset) : null),
    [residueItems, sequence, projectSettings.sequence_offset]
  );
  const { methodConfig, activeStep } = editor;
  const { report, stale } = editor.resolvedRoles;
  const resolvedStep = report?.steps.find(s => s.name.toUpperCase() === (activeStep.name || '').trim().toUpperCase());
  const resolvedCounts = useMemo(() => resolvedCountsByName(resolvedStep), [resolvedStep]);
  const activeOverview = overviewStep(editor.runOverview.overview, activeStep.name || '');
  // Chip shading: this step's last run, else the run's last step.
  const metricRunStep = activeOverview ?? editor.runOverview.overview?.steps.at(-1);
  const metricSources = useMemo(() => ({ profiles, picks, runStep: metricRunStep }), [profiles, picks, metricRunStep]);
  const metricOptions = useMemo(() => availableChipMetrics(residueItems, metricSources), [residueItems, metricSources]);
  const [chipMetricChoice, setChipMetricChoice] = useState<ChipMetric | null | undefined>(undefined);
  // Default: dip depth when available (first option), until the user picks.
  const chipMetric = chipMetricChoice === undefined ? metricOptions[0] ?? null : chipMetricChoice && metricOptions.includes(chipMetricChoice) ? chipMetricChoice : null;
  const chipValues = useMemo(() => (chipMetric ? chipMetricValues(chipMetric, residueItems, metricSources) : {}), [chipMetric, residueItems, metricSources]);
  const profileById = useMemo(() => new Map((profiles ?? []).map(p => [p.residue, p])), [profiles]);
  const namedSelections = projectSettings.named_selections;
  // C5: strongly correlated pairs (last run) noted next to the parameter names.
  const correlationNotes = useMemo(() => {
    const strong = strongCorrelationsByName(activeOverview);
    const sampled: Record<string, string> = { MCMC: 'mcmc', MonteCarlo: 'monte_carlo', Bootstrap: 'bootstrap', BootstrapNS: 'bootstrap_ns' };
    const notes: Record<string, React.ReactNode> = {};
    if (checkEnabled(editor.projectSettings.settings.scientific_checks, 'strong-correlation')) {
      for (const [name, list] of Object.entries(strong)) {
        notes[name] = (
          <div className="mt-1 space-y-0.5" data-testid={`corr-${name}`}>
            {list.map((c, i) => (
              <p key={i} className="text-xs text-blue-900 dark:text-blue-700">
                ρ = {c.rho.toFixed(2)} with {c.other} ({c.method}){' '}
                {sampled[c.method] && activeOverview && (
                  <button
                    type="button"
                    className="underline hover:no-underline"
                    onClick={() => setJoint({ x: c.a, y: c.b, method: sampled[c.method], step: activeOverview.name })}
                  >
                    joint distribution
                  </button>
                )}
              </p>
            ))}
          </div>
        );
      }
    }
    return notes;
  }, [activeOverview, editor.projectSettings.settings.scientific_checks]);
  // Error locations index ROLES actions, so only map them onto rules for the current method text.
  const chemexErrors = useMemo(() => (stale ? [] : errorsForStep(report, activeStep.name || '')), [report, stale, activeStep.name]);

  // Step tabs: resolved counts, blocking errors, which steps have last-run results.
  const stepBadges = useMemo(() => {
    const out: Record<string, StepBadge> = {};
    methodConfig.steps.forEach((s, i) => {
      const name = stepDisplayName(s, i);
      out[s.id] = stepBadge(s, report?.steps.find(r => r.name === name));
    });
    return out;
  }, [methodConfig.steps, report]);
  const errorCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const e of editor.validationErrors) if (e.severity === 'error') out[e.stepId] = (out[e.stepId] ?? 0) + 1;
    return out;
  }, [editor.validationErrors]);
  const activeChemexIssues = useMemo(
    () => editor.validationErrors.filter(e => e.origin === 'chemex' && e.stepId === activeStep.id),
    [editor.validationErrors, activeStep.id]
  );
  const stepResults = useMemo(() => {
    const out: Record<string, StepResultBadge> = {};
    methodConfig.steps.forEach((s, i) => {
      out[s.id] = stepResultBadge(editor.runOverview.overview, stepDisplayName(s, i));
    });
    return out;
  }, [methodConfig.steps, editor.runOverview.overview]);
  const [mcmcStep, setMcmcStep] = useState<string | null>(null);
  const mcmcData = useMemo(() => {
    if (!mcmcStep) return null;
    const raw = resultsSteps?.[mcmcStep]?.statistical_analyses?.mcmc;
    const ov = overviewStep(editor.runOverview.overview, mcmcStep)?.mcmc;
    if (!raw && !ov) return null;
    const data = raw ? toMcmcMethodData(raw) : { method_name: 'MCMC', status: ov?.status, summary: {}, diagnostics: {} };
    // τ is cached in the run overview (not in the parsed diagnostics model).
    return { ...data, diagnostics: { ...(data.diagnostics ?? {}), tau_max: ov?.tau_max ?? undefined } };
  }, [mcmcStep, resultsSteps, editor.runOverview.overview]);
  // Residues fitted in the active step (per-residue overrides in the table).
  const stepResidueIds = useMemo(() => {
    const withData = residueItems.filter(r => r.hasData).map(r => r.id);
    if (activeStep.residueMode === 'include') return withData.filter(id => activeStep.residues.includes(id));
    if (activeStep.residueMode === 'exclude') return withData.filter(id => !activeStep.residues.includes(id));
    return withData;
  }, [residueItems, activeStep.residueMode, activeStep.residues]);
  // E1/E2: generated step summary, per-step and whole-method runtime from the last run's timings.
  const runtimes = useMemo(
    () =>
      methodConfig.steps.map((s, i) => {
        const name = stepDisplayName(s, i);
        const resolved = stale ? undefined : report?.steps.find(r => r.name === name);
        return { name, resolved, runtime: stepRuntime(s, name, resolved, editor.stepTimings, editor.runWorkers, editor.testTimings) };
      }),
    [methodConfig.steps, report, stale, editor.stepTimings, editor.runWorkers, editor.testTimings]
  );
  const activeSummary = stepSummaryText(activeStep, runtimes[editor.activeStepIdx]?.resolved, runtimes[editor.activeStepIdx]?.runtime ?? null);
  const totalRuntime = runtimeText(methodRuntime(methodConfig.steps.map((s, i) => ({ step: s, name: runtimes[i].name, resolved: runtimes[i].resolved })), editor.stepTimings, editor.runWorkers, editor.testTimings));
  const pipelineInfo = runtimes.map(r => ({
    residues: r.resolved && !r.resolved.error ? new Set(r.resolved.parameters.filter(p => p.spin).map(p => p.spin)).size : null,
    runtime: runtimeText(r.runtime),
  }));
  const sectionIssueCounts = useMemo(() => sectionCounts(editor.validationErrors.filter(e => e.stepId === activeStep.id)), [editor.validationErrors, activeStep.id]);
  const stepsWithResults = useMemo(() => new Set(Object.keys(committedByStep ?? {})), [committedByStep]);

  // Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z (and Ctrl+Y). Text fields keep their native undo.
  const { undo, redo } = editor;
  useEffect(() => {
    if (readOnly || editor.isRawEditMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [readOnly, editor.isRawEditMode, undo, redo]);

  // "Mixed · N rules" → highlight and scroll to the rules targeting that parameter.
  const [highlighted, setHighlighted] = useState<Set<string>>(() => new Set());
  const showRules = (name: string) => {
    const ids = rulesByTargetName(activeStep)[name] ?? [];
    setHighlighted(new Set(ids));
    if (ids[0]) requestAnimationFrame(() => document.getElementById(ruleDomId(ids[0]))?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  };
  useEffect(() => {
    if (highlighted.size === 0) return;
    const t = window.setTimeout(() => setHighlighted(new Set()), 2500);
    return () => window.clearTimeout(t);
  }, [highlighted]);
  const searchTargets = useMemo(() => {
    const out: Record<string, 'grid' | 'de'> = {};
    const s = activeStep.search;
    if (s && s.mode !== 'none') for (const a of s.axes) out[a.param.toUpperCase()] = s.mode;
    return out;
  }, [activeStep.search]);

  return (
    <div className="space-y-6 animate-in fade-in">
      <ChemexTabHeader
        icon={<Workflow className="w-5 h-5 text-blue-700" />}
        title="ChemEx Method Configuration"
        description="ChemEx v2 method (FORMAT_VERSION = 2): ordered steps with parameter roles, role inheritance, optional GRID/DE search, profile selection and statistics."
        actions={
          <>
            <button type="button" disabled={readOnly} onClick={() => setShowTemplates(true)} className={`${actionBtnAccent} disabled:opacity-50 disabled:cursor-not-allowed`}>
              <Sparkles className="w-3.5 h-3.5 text-blue-700" />
              <span>Templates</span>
            </button>
            <button type="button" disabled={readOnly} onClick={() => setShowImport(true)} className={`${actionBtnNeutral} disabled:opacity-50 disabled:cursor-not-allowed`}>
              <Upload className="w-3.5 h-3.5" />
              <span>Import TOML</span>
            </button>
            <button
              type="button"
              onClick={editor.undo}
              disabled={readOnly || !editor.canUndo}
              className={`${actionBtnNeutral} disabled:opacity-50 disabled:cursor-not-allowed`}
              title="Undo (Ctrl/Cmd+Z)"
              aria-label="Undo"
            >
              <Undo2 className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={editor.redo}
              disabled={readOnly || !editor.canRedo}
              className={`${actionBtnNeutral} disabled:opacity-50 disabled:cursor-not-allowed`}
              title="Redo (Ctrl/Cmd+Shift+Z)"
              aria-label="Redo"
            >
              <Redo2 className="w-3.5 h-3.5" />
            </button>
            <button type="button" disabled={readOnly} onClick={() => setShowSaveTemplate(true)} className={`${actionBtnNeutral} disabled:opacity-50`} title="Save the current method as a project or personal template">
              <BookmarkPlus className="w-3.5 h-3.5" />
              <span>Save as template</span>
            </button>
            <button type="button" disabled={readOnly} onClick={() => setShowLoadRun(true)} className={`${actionBtnNeutral} disabled:opacity-50`} title="Load the method a completed run used">
              <History className="w-3.5 h-3.5" />
              <span>Load from run…</span>
            </button>
            <button
              type="button"
              disabled={readOnly || editor.blockingErrors.length > 0 || residueItems.every(r => !r.hasData)}
              onClick={() => setShowTestRun(true)}
              className={`${actionBtnNeutral} disabled:opacity-50`}
              title={editor.blockingErrors.length > 0 ? 'Fix the method errors first' : 'Run this method quickly on one residue (no statistics, ≤ 3 grid points per axis)'}
            >
              <FlaskRound className="w-3.5 h-3.5" />
              <span>Test on 1 residue</span>
            </button>
            <button type="button" onClick={() => setShowChecks(true)} className={actionBtnNeutral} title="Scientific checks for this project">
              <FlaskConical className="w-3.5 h-3.5" />
              <span>Checks</span>
            </button>
            <RawModeToggleButton active={editor.isRawEditMode} onClick={editor.toggleRawMode} disabled={readOnly} />
          </>
        }
      />

      {readOnly && (
        <div
          role="status"
          className="flex items-center gap-2 p-3 rounded-xl border border-blue-200 dark:border-blue-800/80 bg-blue-50 dark:bg-blue-950/40 text-xs text-blue-800 dark:text-blue-500"
        >
          <Lock className="w-3.5 h-3.5 flex-shrink-0" />
          <span>
            <strong>Showing the method snapshot used by the running job.</strong> Editing unlocks when the run completes, fails or is stopped.
          </span>
        </div>
      )}

      <MethodIssueBanner
        issues={editor.validationErrors}
        dismissed={editor.dismissedIssues}
        onApplyFix={editor.applyQuickFix}
        onRestore={editor.restoreIssue}
        readOnly={readOnly}
      />

      {!editor.isRawEditMode && (
        <UnparsedLinesNotice
          count={editor.unparsedTomlLines.length}
          subject="configuration"
          onViewRaw={editor.enterRawMode}
          lines={editor.unparsedTomlLines}
        />
      )}

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(20rem,28rem)] lg:gap-6 lg:items-start">
      <div className="min-w-0 space-y-6">
      {editor.isRawEditMode ? (
        <RawTomlEditor
          fileName="method.toml"
          value={editor.methodToml}
          onChange={editor.setMethodToml}
          onApply={editor.applyRawToml}
          onDiscard={editor.discardRawToml}
          rows={16}
          readOnly={readOnly}
        />
      ) : (
        <div className="space-y-4">
          <PipelineStrip
            steps={methodConfig.steps}
            activeIdx={editor.activeStepIdx}
            onSelect={editor.stepHandlers.onSelectStep}
            info={pipelineInfo}
            totalRuntime={totalRuntime}
          />
          <StepTabs
            steps={methodConfig.steps}
            activeStepIdx={editor.activeStepIdx}
            {...editor.stepHandlers}
            readOnly={readOnly}
            badges={stepBadges}
            badgesStale={stale}
            errorCounts={errorCounts}
            stepsWithResults={stepsWithResults}
            results={stepResults}
            onOpenMcmc={idx => setMcmcStep(stepDisplayName(methodConfig.steps[idx], idx))}
          />

          <nav
            aria-label="Step sections"
            className="sticky z-20 flex flex-wrap gap-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-slate-900/95 backdrop-blur px-2 py-1 text-xs"
            style={{ top: 'env(safe-area-inset-top, 0px)' }}
          >
            {STEP_SECTIONS.map(sec => (
              <a
                key={sec.id}
                href={`#${sectionDomId(sec.id)}`}
                onClick={e => {
                  e.preventDefault();
                  document.getElementById(sectionDomId(sec.id))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }}
                className="px-2 py-0.5 rounded-md text-slate-900 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                {sec.label}
                {sectionIssueCounts[sec.id] > 0 && (
                  <span className="ml-1 px-1.5 rounded-full bg-amber-100 text-amber-900 dark:bg-amber-200 dark:text-amber-700 font-semibold" data-testid={`nav-count-${sec.id}`}>
                    {sectionIssueCounts[sec.id]}
                  </span>
                )}
              </a>
            ))}
          </nav>

          <section id={sectionDomId('summary')} aria-label="Step summary" className="scroll-mt-12 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 px-3 py-2 text-xs text-slate-900 dark:text-slate-200" data-testid="step-summary">
            <span className="font-mono font-bold mr-2">{activeStep.name}</span>
            {activeSummary}
          </section>

          <div id={sectionDomId('residues')} className="scroll-mt-12">
            <ResidueSelector
              residues={labeledResidues}
              residueTypesKnown={residueTypesKnown}
              onImportSequence={() => setShowSequence(true)}
              gaps={gaps}
              metric={metricOptions.length ? { options: metricOptions, active: chipMetric, values: chipValues, onChange: setChipMetricChoice } : undefined}
              renderPreview={
                profiles
                  ? item => (
                      <ResiduePreview
                        projectUuid={editor.projectUuid}
                        analysisUuid={analysisUuid}
                        residue={item.id}
                        stepName={metricRunStep?.name ?? null}
                        profile={profileById.get(item.id)}
                        csA={picks?.[item.id]?.cs_a ?? null}
                        csB={picks?.[item.id]?.cs_b ?? null}
                      />
                    )
                  : undefined
              }
              namedSelections={namedSelections}
              onSaveSelection={(name, residues) =>
                editor.projectSettings.update({
                  named_selections: [
                    ...namedSelections.filter(n => n.name !== name),
                    { id: `sel_${Date.now().toString(36)}`, name, residues, created_at: new Date().toISOString() },
                  ],
                })
              }
              onDeleteSelection={id => editor.projectSettings.update({ named_selections: namedSelections.filter(n => n.id !== id) })}
              mode={activeStep.residueMode || 'all'}
              selectedIds={activeStep.residues || []}
              onModeChange={residueMode => editor.handleStepChange({ ...activeStep, residueMode })}
              onSelectionChange={residues => editor.handleStepChange({ ...activeStep, residues })}
              readOnly={readOnly}
              onCopyFromPrevious={
                editor.activeStepIdx > 0
                  ? () => {
                      const prev = methodConfig.steps[editor.activeStepIdx - 1];
                      editor.handleStepChange({ ...activeStep, residueMode: prev.residueMode, residues: [...(prev.residues || [])] });
                    }
                  : undefined
              }
              previousStepName={editor.activeStepIdx > 0 ? methodConfig.steps[editor.activeStepIdx - 1]?.name : undefined}
            />
          </div>

          <div id={sectionDomId('parameters')} className="scroll-mt-12 space-y-4">
            <div className="space-y-2">
              <h4 className="text-xs font-bold text-slate-900 dark:text-slate-200 uppercase tracking-wider">
                Parameters for Step: <span className="font-mono text-blue-700 dark:text-blue-700">{activeStep.name}</span>
              </h4>
              <ParameterTable
                step={activeStep}
                onChange={editor.handleStepChange}
                availableParams={editor.availableParamsMeta}
                startingValues={startingValues}
                onNavigateToParameters={onNavigateToParameters}
                searchTargets={searchTargets}
                baselineRoles={editor.baselineRoles}
                stepIndex={editor.activeStepIdx}
                previousStepName={editor.activeStepIdx > 0 ? methodConfig.steps[editor.activeStepIdx - 1]?.name : undefined}
                committedByStep={committedByStep}
                startingProvenance={startingProvenance}
                readOnly={readOnly}
                resolvedCounts={resolvedCounts}
                resolvedParams={resolvedStep?.parameters}
                committedStep={activeOverview}
                committedFromPreviousMethod={editor.previousMethod}
                nameNotes={correlationNotes}
              stepResidueIds={stepResidueIds}
                onShowRules={showRules}
              />
            </div>
            <StepRolesSection
              step={activeStep}
              stepIdx={editor.activeStepIdx}
              steps={methodConfig.steps}
              onChange={editor.handleStepChange}
              readOnly={readOnly}
              paramNames={editor.knownParamNames}
              catalog={editor.baselineRoles.catalog}
              chemexErrors={chemexErrors}
              highlightedRuleIds={highlighted}
            />
          </div>

          <div id={sectionDomId('resolved')} className="scroll-mt-12">
            <ResolvedRolesSummary state={editor.resolvedRoles} stepName={activeStep.name || ''} />
          </div>

          <div id={sectionDomId('search')} className="scroll-mt-12">
            <StepSearchSection
              step={activeStep}
              onChange={editor.handleStepChange}
              family={editor.family}
              availableParams={editor.availableParamsMeta}
              startingValues={startingValues}
              readOnly={readOnly}
              catalog={editor.baselineRoles.catalog}
              resolvedSearch={resolvedStep?.search ?? null}
              resolvedStale={stale}
              timings={editor.stepTimings}
              onAddRefineStep={() => editor.stepHandlers.onAddRefineStep(editor.activeStepIdx)}
              chemexIssues={activeChemexIssues}
              runAxisIssues={editor.validationErrors.filter(e => e.stepId === activeStep.id && (e.code === 'grid-edge' || e.code === 'de-edge'))}
              onApplyFix={editor.applyQuickFix}
              landscape={
                activeOverview?.grid ? (
                  <GridLandscape
                    stepName={activeOverview.name}
                    grid={activeOverview.grid}
                    axes={activeStep.search?.axes ?? []}
                    loadSurface={editor.runOverview.loadSurface}
                    previousMethod={editor.previousMethod}
                  />
                ) : undefined
              }
            />
          </div>

          <div id={sectionDomId('statistics')} className="scroll-mt-12">
            <StepStatisticsSection
              step={activeStep}
              onChange={editor.handleStepChange}
              readOnly={readOnly}
              timings={editor.stepTimings}
              workers={editor.runWorkers}
              chemexIssues={activeChemexIssues}
            />
          </div>
        </div>
      )}
      </div>

      <aside className="mt-6 lg:mt-0 lg:sticky lg:top-4">
        <MethodTomlPanel
          toml={editor.effectiveMethodToml}
          downloadName={`method_${analysisUuid}.toml`}
          stepCount={methodConfig.steps.length}
          lastRunToml={editor.lastRunMethod.toml}
          lastRunAt={editor.lastRunMethod.completedAt}
          chemexVersion={report?.chemex_version ?? null}
          validation={{
            checking: editor.resolvedRoles.loading,
            known: !!report && !stale,
            errors: editor.blockingErrors.length,
            warnings: editor.validationErrors.filter(e => e.severity === 'warning').length,
            notes: editor.validationErrors.filter(e => e.severity === 'info').length,
          }}
          onCopied={notify}
        />
      </aside>
      </div>

      {showTemplates && (
        <MethodTemplatesModal
          userTemplates={userTemplates}
          onDeleteUserTemplate={t =>
            t.scope === 'project'
              ? editor.projectSettings.update({ method_templates: projectSettings.method_templates.filter(x => x.id !== t.id) })
              : userPrefs.update({ method_templates: userPrefs.prefs.method_templates.filter(x => x.id !== t.id) })
          }
          family={editor.family}
          onClose={() => setShowTemplates(false)}
          onApply={tmpl => {
            editor.applyTemplate(tmpl);
            setShowTemplates(false);
          }}
          additionTarget={t => additionTarget(t, methodConfig, editor.activeStepIdx)}
        />
      )}
      {showSaveTemplate && <SaveTemplateModal onClose={() => setShowSaveTemplate(false)} onSave={saveTemplate} />}
      {showLoadRun && (
        <LoadFromRunModal
          projectUuid={editor.projectUuid}
          family={editor.family}
          currentToml={editor.effectiveMethodToml}
          currentAnalysisUuid={analysisUuid}
          onClose={() => setShowLoadRun(false)}
          onLoad={(toml, label) => {
            const err = editor.importToml(toml);
            if (err) notify?.(err);
            else {
              notify?.(`Loaded the method of ${label}`);
              setShowLoadRun(false);
            }
          }}
        />
      )}
      {showTestRun && (
        <TestRunModal
          projectUuid={editor.projectUuid}
          analysisUuid={analysisUuid}
          methodToml={editor.effectiveMethodToml}
          parameterToml={editor.parameterToml}
          model={editor.model}
          residues={(stepResidueIds.length ? stepResidueIds : residueItems.filter(r => r.hasData).map(r => r.id))}
          onClose={() => setShowTestRun(false)}
          onFinished={editor.refreshTimings}
        />
      )}
      {showChecks && (
        <ScienceChecksModal
          settings={editor.projectSettings.settings.scientific_checks}
          onClose={() => setShowChecks(false)}
          onSave={next => editor.projectSettings.update({ scientific_checks: next })}
        />
      )}
      {joint && (
        <JointDistributionModal
          isOpen
          onClose={() => setJoint(null)}
          projectUuid={editor.projectUuid}
          analysisUuid={analysisUuid}
          methodName={joint.method}
          stepName={joint.step}
          paramX={joint.x}
          paramY={joint.y}
        />
      )}
      {mcmcStep && (
        <ChemexModalShell
          icon={<Workflow size={20} />}
          title={`MCMC diagnostics · ${mcmcStep}`}
          subtitle="Last completed run"
          onClose={() => setMcmcStep(null)}
          footer={
            <button type="button" onClick={() => setMcmcStep(null)} className={chemexBtnSecondary}>
              Close
            </button>
          }
        >
          {mcmcData ? <McmcDiagnosticsTab mcmcData={mcmcData} /> : <p className="text-xs text-slate-900 dark:text-slate-200">No MCMC results stored for this step.</p>}
        </ChemexModalShell>
      )}
      {showSequence && (
        <SequenceImportModal
          initialSequence={sequence}
          initialOffset={projectSettings.sequence_offset}
          sampleResidue={residueItems[0]?.number}
          onClose={() => setShowSequence(false)}
          onSave={(seq, offset) => editor.projectSettings.saveSequence(seq, offset)}
        />
      )}
      {showImport && (
        <MethodImportModal
          onClose={() => setShowImport(false)}
          onImport={text => {
            const err = editor.importToml(text);
            if (!err) setShowImport(false);
            return err;
          }}
        />
      )}
    </div>
  );
};

// ── Templates modal ─────────────────────────────────────────────────────

export const MethodTemplatesModal: React.FC<{
  /** Project and personal templates (saved methods), shown beside the built-ins. */
  userTemplates?: Array<StoredMethodTemplate & { scope: 'project' | 'user' }>;
  onDeleteUserTemplate?: (t: StoredMethodTemplate & { scope: 'project' | 'user' }) => void;
  family?: string;
  onClose: () => void;
  onApply: (template: MethodTemplate) => void;
  /** For addition templates: where they will be added (e.g. "to STEP2"). */
  additionTarget?: (template: MethodAdditionTemplate) => string;
}> = ({ family, onClose, onApply, additionTarget, userTemplates = [], onDeleteUserTemplate }) => {
  const forFamily = (t: MethodTemplate) => !t.families || t.families.includes((family ?? '') as never);
  const ordered = [...METHOD_TEMPLATES].sort((a, b) => Number(forFamily(b)) - Number(forFamily(a)));
  const sections: Array<{ title: string; items: MethodTemplate[] }> = [
    { title: 'Replace the method', items: ordered.filter(t => t.kind === 'method') },
    { title: 'Add to the current method', items: ordered.filter(t => t.kind === 'addition') },
  ];
  return (
    <ChemexModalShell
      icon={<Sparkles size={20} />}
      title="Method Templates"
      subtitle="Start from a ChemEx v2 strategy, or add a common piece to the current method."
      onClose={onClose}
      footer={
        <button type="button" onClick={onClose} className={chemexBtnSecondary}>
          Cancel
        </button>
      }
    >
      {userTemplates.length > 0 && (
        <div className="space-y-2" aria-label="Your templates">
          <h4 className="text-xs font-bold uppercase tracking-wider text-slate-900 dark:text-slate-200">Your templates</h4>
          {userTemplates.map(t => (
            <div key={`${t.scope}-${t.id}`} className="p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800/40 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h5 className="text-sm font-bold text-slate-900 dark:text-white">{t.name}</h5>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-slate-200 dark:bg-slate-700 text-slate-900 dark:text-slate-200">{t.scope === 'project' ? 'project' : 'mine'}</span>
                  <span className="text-xs text-slate-900 dark:text-slate-200">{((t.config as unknown as MethodConfig).steps ?? []).length} step(s)</span>
                </div>
                {t.description && <p className="text-xs text-slate-900 dark:text-slate-200">{t.description}</p>}
              </div>
              <div className="flex items-center gap-2">
                {onDeleteUserTemplate && (
                  <button type="button" onClick={() => onDeleteUserTemplate(t)} className="px-2 py-1 text-xs text-red-700 dark:text-red-600 hover:underline">
                    Delete
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onApply({ id: t.id, kind: 'method', name: t.name, description: t.description, config: t.config as unknown as MethodConfig })}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-lg shadow-sm whitespace-nowrap"
                >
                  Use template
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {sections.map(section => (
        <div key={section.title} className="space-y-2">
          <h4 className="text-xs font-bold uppercase tracking-wider text-slate-900 dark:text-slate-200">{section.title}</h4>
          {section.items.map(tmpl => {
            const steps = tmpl.kind === 'method' ? tmpl.config.steps : [];
            const searchModes = Array.from(new Set(steps.map(s => s.search?.mode).filter(m => m && m !== 'none'))) as string[];
            const fitParams = Array.from(new Set(steps.flatMap(s => (s.parameters || []).filter(p => p.mode === 'fit').map(p => p.name))));
            return (
              <div
                key={tmpl.id}
                className="p-4 rounded-xl border border-slate-200 dark:border-slate-700/80 bg-slate-50/50 dark:bg-slate-800/40 hover:border-blue-300 dark:hover:border-blue-700 transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-4 group"
              >
                <div className="space-y-1.5 flex-grow">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="text-sm font-bold text-slate-900 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">{tmpl.name}</h4>
                    {tmpl.kind === 'method' && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-500 font-bold">
                        {steps.length} step{steps.length > 1 ? 's' : ''}
                      </span>
                    )}
                    {searchModes.map(m => (
                      <span key={m} className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-400 font-bold uppercase">
                        {m}
                      </span>
                    ))}
                    {tmpl.model && tmpl.model !== '2st' && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300 font-bold">model {tmpl.model}</span>
                    )}
                  </div>
                  <p className="text-xs text-slate-900 dark:text-slate-200 leading-relaxed max-w-lg">{tmpl.description}</p>
                  {fitParams.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1 pt-1">
                      <span className="text-xs text-slate-900 font-semibold uppercase tracking-wider mr-1">Fitted:</span>
                      {fitParams.map(p => (
                        <span key={p} className="px-1.5 py-0.2 rounded bg-slate-200 dark:bg-slate-700 text-slate-900 dark:text-slate-200 font-mono text-xs font-bold">
                          {p}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => onApply(tmpl)}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-lg shadow-sm whitespace-nowrap transition-colors flex-shrink-0"
                >
                  {tmpl.kind === 'addition' ? `Add ${additionTarget ? additionTarget(tmpl) : ''}`.trim() : 'Use template'}
                </button>
              </div>
            );
          })}
        </div>
      ))}
    </ChemexModalShell>
  );
};

// ── Import modal ────────────────────────────────────────────────────────

export const MethodImportModal: React.FC<{
  onClose: () => void;
  /** Returns an error message, or null on success. */
  onImport: (text: string) => string | null;
}> = ({ onClose, onImport }) => {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Preview what the import would do before anything is applied.
  const preview = useMemo(() => {
    if (!text.trim()) return null;
    try {
      return { result: tomlToConfig(text), error: null as string | null };
    } catch (err) {
      return { result: null, error: err instanceof Error ? err.message : String(err) };
    }
  }, [text]);
  const result = preview?.result ?? null;
  const steps = result?.config.steps ?? [];
  return (
    <ChemexModalShell
      icon={<Upload size={20} />}
      title="Import method.toml"
      subtitle="Upload a .toml file or paste a method. Nothing is applied until you confirm."
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className={chemexBtnSecondary}>
            Cancel
          </button>
          <button type="button" disabled={!result} onClick={() => setError(onImport(text))} className={chemexBtnPrimary}>
            {result?.format === 'v1' ? 'Apply migrated v2 method' : 'Apply method'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="text-xs font-bold text-slate-900 dark:text-slate-200 block">Upload file or paste TOML:</label>
        <input
          type="file"
          accept=".toml,.txt"
          aria-label="Method file"
          onChange={e => {
            const file = e.target.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = ev => {
              const content = ev.target?.result as string;
              if (content) setText(content);
            };
            reader.readAsText(file);
          }}
          className="block w-full text-xs text-slate-900 file:mr-4 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 dark:file:bg-blue-900/30 dark:file:text-blue-300"
        />
        <textarea
          aria-label="Method TOML"
          value={text}
          onChange={e => {
            setText(e.target.value);
            setError(null);
          }}
          rows={10}
          placeholder={`FORMAT_VERSION = 2\n\n[STEP1]\nROLES = [\n  { CONSTRAIN = ["[R2_B] = [R2_A]"] },\n  { FIT = ["PB", "KEX_AB", "DW_AB", "CS_A"] },\n]\n\n(v1 files are migrated to v2; you will see what changes before applying)`}
          className={`${chemexInputCls} font-mono text-xs`}
        />

        {preview?.error && <p className="text-xs text-red-600 dark:text-red-500">Cannot parse: {preview.error}</p>}

        {result && (
          <div className="space-y-2 text-xs" aria-label="Import preview">
            <p className="text-slate-900 dark:text-slate-200">
              <span className={`mr-2 px-1.5 py-0.5 rounded font-bold text-xs ${result.format === 'v1' ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-400' : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-500'}`}>
                {result.format === 'v1' ? 'VERSION 1' : 'VERSION 2'}
              </span>
              {steps.length} step{steps.length === 1 ? '' : 's'}: <span className="font-mono">{steps.map(s => s.name).join(', ')}</span>
            </p>

            {result.migration.length > 0 && (
              <div className="p-2.5 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-950/30">
                <p className="font-semibold text-amber-800 dark:text-amber-400 mb-1">Migration to v2 — what changes</p>
                <ul className="list-disc pl-4 space-y-0.5 text-amber-900 dark:text-amber-400" aria-label="Migration summary">
                  {result.migration.map((m, i) => (
                    <li key={i} className="break-words">
                      {m}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {result.unparsed.length > 0 && (
              <div className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
                <p className="font-semibold text-slate-900 dark:text-slate-200 mb-1">
                  {result.unparsed.length} line{result.unparsed.length === 1 ? '' : 's'} will not be in the structured method
                </p>
                <ul className="space-y-0.5 font-mono text-xs text-slate-900 dark:text-slate-200 max-h-40 overflow-y-auto" aria-label="Not imported">
                  {result.unparsed.map((l, i) => (
                    <li key={i} className="break-all">
                      {l}
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-xs text-slate-900">They stay listed above the editor after import; use raw mode to keep them verbatim.</p>
              </div>
            )}
          </div>
        )}
        {error && <p className="text-xs text-red-600 dark:text-red-500">{error}</p>}
      </div>
    </ChemexModalShell>
  );
};

export default MethodsTab;
