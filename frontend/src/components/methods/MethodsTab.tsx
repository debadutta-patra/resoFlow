/**
 * Methods tab shared by every ChemEx analysis page (CEST, CPMG, EXCHANGE).
 *
 * Purely presentational over a `MethodEditor` (see hooks/useMethodEditor): the
 * manager owns the state, this component renders the identical layout everywhere.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Lock, Sparkles, Upload, Workflow } from 'lucide-react';
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
}) => {
  const [showTemplates, setShowTemplates] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showSequence, setShowSequence] = useState(false);
  const { sequence, settings: projectSettings } = editor.projectSettings;
  /** Chips carry the residue type from assignment names, else from the project sequence. */
  const labeledResidues = useMemo(
    () => labelWithSequence(residueItems, sequence, projectSettings.sequence_offset),
    [residueItems, sequence, projectSettings.sequence_offset]
  );
  const residueTypesKnown = useMemo(() => labeledResidues.some(itemHasType), [labeledResidues]);
  const { methodConfig, activeStep } = editor;
  const { report, stale } = editor.resolvedRoles;
  const resolvedStep = report?.steps.find(s => s.name.toUpperCase() === (activeStep.name || '').trim().toUpperCase());
  const resolvedCounts = useMemo(() => resolvedCountsByName(resolvedStep), [resolvedStep]);
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
  const stepsWithResults = useMemo(() => new Set(Object.keys(committedByStep ?? {})), [committedByStep]);

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
        icon={<Workflow className="w-5 h-5 text-blue-500" />}
        title="ChemEx Method Configuration"
        description="ChemEx v2 method (FORMAT_VERSION = 2): ordered steps with parameter roles, role inheritance, optional GRID/DE search, profile selection and statistics."
        actions={
          <>
            <button type="button" disabled={readOnly} onClick={() => setShowTemplates(true)} className={`${actionBtnAccent} disabled:opacity-50 disabled:cursor-not-allowed`}>
              <Sparkles className="w-3.5 h-3.5 text-blue-500" />
              <span>Templates</span>
            </button>
            <button type="button" disabled={readOnly} onClick={() => setShowImport(true)} className={`${actionBtnNeutral} disabled:opacity-50 disabled:cursor-not-allowed`}>
              <Upload className="w-3.5 h-3.5" />
              <span>Import TOML</span>
            </button>
            <RawModeToggleButton active={editor.isRawEditMode} onClick={editor.toggleRawMode} disabled={readOnly} />
          </>
        }
      />

      {readOnly && (
        <div
          role="status"
          className="flex items-center gap-2 p-3 rounded-xl border border-blue-200 dark:border-blue-800/80 bg-blue-50 dark:bg-blue-950/40 text-xs text-blue-800 dark:text-blue-200"
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
        <div className="space-y-6">
          <StepTabs
            steps={methodConfig.steps}
            activeStepIdx={editor.activeStepIdx}
            {...editor.stepHandlers}
            readOnly={readOnly}
            badges={stepBadges}
            badgesStale={stale}
            errorCounts={errorCounts}
            stepsWithResults={stepsWithResults}
          />

          <div className="space-y-2">
            <h4 className="text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider">
              Parameters for Step: <span className="font-mono text-blue-600 dark:text-blue-400">{activeStep.name}</span>
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

          <ResolvedRolesSummary state={editor.resolvedRoles} stepName={activeStep.name || ''} />

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
          />

          <ResidueSelector
            residues={labeledResidues}
            residueTypesKnown={residueTypesKnown}
            onImportSequence={() => setShowSequence(true)}
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

          <StepStatisticsSection
            step={activeStep}
            onChange={editor.handleStepChange}
            readOnly={readOnly}
            timings={editor.stepTimings}
            workers={editor.runWorkers}
            chemexIssues={activeChemexIssues}
          />
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
          family={editor.family}
          onClose={() => setShowTemplates(false)}
          onApply={tmpl => {
            editor.applyTemplate(tmpl);
            setShowTemplates(false);
          }}
          additionTarget={t => additionTarget(t, methodConfig, editor.activeStepIdx)}
        />
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
  family?: string;
  onClose: () => void;
  onApply: (template: MethodTemplate) => void;
  /** For addition templates: where they will be added (e.g. "to STEP2"). */
  additionTarget?: (template: MethodAdditionTemplate) => string;
}> = ({ family, onClose, onApply, additionTarget }) => {
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
      {sections.map(section => (
        <div key={section.title} className="space-y-2">
          <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">{section.title}</h4>
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
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 font-bold">
                        {steps.length} step{steps.length > 1 ? 's' : ''}
                      </span>
                    )}
                    {searchModes.map(m => (
                      <span key={m} className="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 font-bold uppercase">
                        {m}
                      </span>
                    ))}
                    {tmpl.model && tmpl.model !== '2st' && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300 font-bold">model {tmpl.model}</span>
                    )}
                  </div>
                  <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed max-w-lg">{tmpl.description}</p>
                  {fitParams.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1 pt-1">
                      <span className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider mr-1">Fitted:</span>
                      {fitParams.map(p => (
                        <span key={p} className="px-1.5 py-0.2 rounded bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 font-mono text-[10px] font-bold">
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
        <label className="text-xs font-bold text-slate-600 dark:text-slate-400 block">Upload file or paste TOML:</label>
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
          className="block w-full text-xs text-slate-500 file:mr-4 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 dark:file:bg-blue-900/30 dark:file:text-blue-300"
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

        {preview?.error && <p className="text-xs text-red-600 dark:text-red-400">Cannot parse: {preview.error}</p>}

        {result && (
          <div className="space-y-2 text-xs" aria-label="Import preview">
            <p className="text-slate-700 dark:text-slate-300">
              <span className={`mr-2 px-1.5 py-0.5 rounded font-bold text-[10px] ${result.format === 'v1' ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300' : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'}`}>
                {result.format === 'v1' ? 'VERSION 1' : 'VERSION 2'}
              </span>
              {steps.length} step{steps.length === 1 ? '' : 's'}: <span className="font-mono">{steps.map(s => s.name).join(', ')}</span>
            </p>

            {result.migration.length > 0 && (
              <div className="p-2.5 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-950/30">
                <p className="font-semibold text-amber-800 dark:text-amber-300 mb-1">Migration to v2 — what changes</p>
                <ul className="list-disc pl-4 space-y-0.5 text-amber-900 dark:text-amber-200" aria-label="Migration summary">
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
                <p className="font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  {result.unparsed.length} line{result.unparsed.length === 1 ? '' : 's'} will not be in the structured method
                </p>
                <ul className="space-y-0.5 font-mono text-[11px] text-slate-600 dark:text-slate-400 max-h-40 overflow-y-auto" aria-label="Not imported">
                  {result.unparsed.map((l, i) => (
                    <li key={i} className="break-all">
                      {l}
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-[11px] text-slate-500">They stay listed above the editor after import; use raw mode to keep them verbatim.</p>
              </div>
            )}
          </div>
        )}
        {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      </div>
    </ChemexModalShell>
  );
};

export default MethodsTab;
