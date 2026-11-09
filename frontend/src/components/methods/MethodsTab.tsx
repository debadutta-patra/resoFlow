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
import { METHOD_TEMPLATES } from '../../lib/methodTemplates';
import ParameterTable from './ParameterTable';
import ResidueSelector, { type ResidueItem } from './ResidueSelector';
import StepTabs from './StepTabs';
import StepStatisticsSection from './StepStatisticsSection';
import StepSearchSection from './StepSearchSection';
import StepRolesSection from './StepRolesSection';
import ResolvedRolesSummary from './ResolvedRolesSummary';
import { errorsForStep, resolvedCountsByName, ruleDomId, rulesByTargetName } from '../../lib/resolvedRoles';
import {
  ChemexModalShell,
  ChemexTabHeader,
  RawModeToggleButton,
  RawTomlEditor,
  TomlPreviewStrip,
  UnparsedLinesNotice,
  ValidationBanner,
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
  const { methodConfig, activeStep } = editor;
  const { report, stale } = editor.resolvedRoles;
  const resolvedStep = report?.steps.find(s => s.name.toUpperCase() === (activeStep.name || '').trim().toUpperCase());
  const resolvedCounts = useMemo(() => resolvedCountsByName(resolvedStep), [resolvedStep]);
  // Error locations index ROLES actions, so only map them onto rules for the current method text.
  const chemexErrors = useMemo(() => (stale ? [] : errorsForStep(report, activeStep.name || '')), [report, stale, activeStep.name]);

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

      <ValidationBanner
        title="Method Validation Issues"
        items={editor.validationErrors.map(err => (
          <>
            <strong>[{err.stepName}]</strong> {err.message}
          </>
        ))}
      />

      {!editor.isRawEditMode && (
        <UnparsedLinesNotice
          count={editor.unparsedTomlLines.length}
          subject="configuration"
          onViewRaw={editor.enterRawMode}
        />
      )}

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
          <StepTabs steps={methodConfig.steps} activeStepIdx={editor.activeStepIdx} {...editor.stepHandlers} readOnly={readOnly} />

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
          />

          <ResidueSelector
            residues={residueItems}
            mode={activeStep.residueMode || 'include'}
            selectedIds={activeStep.residues || []}
            onModeChange={residueMode => editor.handleStepChange({ ...activeStep, residueMode })}
            onSelectionChange={residues => editor.handleStepChange({ ...activeStep, residues })}
            readOnly={readOnly}
          />

          <StepStatisticsSection step={activeStep} onChange={editor.handleStepChange} readOnly={readOnly} />
        </div>
      )}

      <TomlPreviewStrip
        fileName="method.toml"
        downloadName={`method_${analysisUuid}.toml`}
        toml={editor.effectiveMethodToml}
        badge={`${methodConfig.steps.length} step${methodConfig.steps.length > 1 ? 's' : ''}`}
        onCopied={notify}
      />

      {showTemplates && (
        <MethodTemplatesModal
          family={editor.family}
          onClose={() => setShowTemplates(false)}
          onApply={tmpl => {
            editor.applyTemplate(tmpl);
            setShowTemplates(false);
          }}
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
  onApply: (template: (typeof METHOD_TEMPLATES)[number]) => void;
}> = ({ family, onClose, onApply }) => (
  <ChemexModalShell
    icon={<Sparkles size={20} />}
    title="Method Strategy Templates"
    subtitle="Select a predefined fitting strategy for your ChemEx analysis."
    onClose={onClose}
    footer={
      <button type="button" onClick={onClose} className={chemexBtnSecondary}>
        Cancel
      </button>
    }
  >
    {[...METHOD_TEMPLATES]
      // Templates aimed at this experiment (or generic ones) first.
      .sort((a, b) => Number(!!b.families?.includes(family ?? '') || !b.families) - Number(!!a.families?.includes(family ?? '') || !a.families))
      .map(tmpl => {
      const stepCount = tmpl.config.steps.length;
      const searchModes = Array.from(new Set(tmpl.config.steps.map(s => s.search?.mode).filter(m => m && m !== 'none'))) as string[];
      const fitParams = Array.from(
        new Set(tmpl.config.steps.flatMap(s => (s.parameters || []).filter(p => p.mode === 'fit').map(p => p.name)))
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
              {searchModes.map(m => (
                <span key={m} className="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 font-bold uppercase">
                  {m}
                </span>
              ))}
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed max-w-lg">{tmpl.description}</p>
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
            onClick={() => onApply(tmpl)}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-lg shadow-sm whitespace-nowrap transition-colors flex-shrink-0"
          >
            Use Template
          </button>
        </div>
      );
    })}
  </ChemexModalShell>
);

// ── Import modal ────────────────────────────────────────────────────────

export const MethodImportModal: React.FC<{
  onClose: () => void;
  /** Returns an error message, or null on success. */
  onImport: (text: string) => string | null;
}> = ({ onClose, onImport }) => {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <ChemexModalShell
      icon={<Upload size={20} />}
      title="Import method.toml"
      subtitle="Upload a .toml file or paste method configuration text."
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className={chemexBtnSecondary}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!text.trim()}
            onClick={() => setError(onImport(text))}
            className={chemexBtnPrimary}
          >
            Parse & Apply Configuration
          </button>
        </>
      }
    >
      <div>
        <label className="text-xs font-bold text-slate-600 dark:text-slate-400 block mb-2">Upload file or paste TOML:</label>
        <input
          type="file"
          accept=".toml,.txt"
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
          className="mb-3 block w-full text-xs text-slate-500 file:mr-4 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 dark:file:bg-blue-900/30 dark:file:text-blue-300"
        />
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          rows={10}
          placeholder={`FORMAT_VERSION = 2\n\n[STEP1]\nROLES = [\n  { CONSTRAIN = ["[R2_B] = [R2_A]"] },\n  { FIT = ["PB", "KEX_AB", "DW_AB", "CS_A"] },\n]\n\n[STEP1.SEARCH.GRID]\nAXES = ["[PB] = log(0.005, 0.2, 10)"]\n\n(v1 files are migrated to v2 on import)`}
          className={`${chemexInputCls} font-mono text-xs`}
        />
        {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
      </div>
    </ChemexModalShell>
  );
};

export default MethodsTab;
