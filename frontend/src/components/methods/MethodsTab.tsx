/**
 * Methods tab shared by every ChemEx analysis page (CEST, CPMG, EXCHANGE).
 *
 * Purely presentational over a `MethodEditor` (see hooks/useMethodEditor): the
 * manager owns the state, this component renders the identical layout everywhere.
 */

import React, { useState } from 'react';
import { Sparkles, Upload, Workflow } from 'lucide-react';
import type { MethodEditor } from '../../hooks/useMethodEditor';
import { METHOD_TEMPLATES } from '../../lib/methodTemplates';
import ParameterTable from './ParameterTable';
import ResidueSelector, { type ResidueItem } from './ResidueSelector';
import StepTabs from './StepTabs';
import StepStatisticsSection from './StepStatisticsSection';
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
}

export const MethodsTab: React.FC<MethodsTabProps> = ({
  editor,
  analysisUuid,
  residueItems,
  startingValues,
  onNavigateToParameters,
  notify,
}) => {
  const [showTemplates, setShowTemplates] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const { methodConfig, activeStep } = editor;

  return (
    <div className="space-y-6 animate-in fade-in">
      <ChemexTabHeader
        icon={<Workflow className="w-5 h-5 text-blue-500" />}
        title="ChemEx Method Configuration"
        description="Define multi-step fitting protocols, parameter treatments, constraints, and residue selections."
        actions={
          <>
            <button type="button" onClick={() => setShowTemplates(true)} className={actionBtnAccent}>
              <Sparkles className="w-3.5 h-3.5 text-blue-500" />
              <span>Templates</span>
            </button>
            <button type="button" onClick={() => setShowImport(true)} className={actionBtnNeutral}>
              <Upload className="w-3.5 h-3.5" />
              <span>Import TOML</span>
            </button>
            <RawModeToggleButton active={editor.isRawEditMode} onClick={editor.toggleRawMode} />
          </>
        }
      />

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
        />
      ) : (
        <div className="space-y-6">
          <StepTabs steps={methodConfig.steps} activeStepIdx={editor.activeStepIdx} {...editor.stepHandlers} />

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
            />
          </div>

          <ResidueSelector
            residues={residueItems}
            mode={activeStep.residueMode || 'include'}
            selectedIds={activeStep.residues || []}
            onModeChange={residueMode => editor.handleStepChange({ ...activeStep, residueMode })}
            onSelectionChange={residues => editor.handleStepChange({ ...activeStep, residues })}
          />

          <StepStatisticsSection step={activeStep} onChange={editor.handleStepChange} />
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
  onClose: () => void;
  onApply: (template: (typeof METHOD_TEMPLATES)[number]) => void;
}> = ({ onClose, onApply }) => (
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
    {METHOD_TEMPLATES.map(tmpl => {
      const stepCount = tmpl.config.steps.length;
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
          placeholder={`[STEP1]\nFIT = ["PB", "KEX_AB", "DW_AB", "CS_A"]\nCONSTRAINTS = ["[PB] < 0.5"]`}
          className={`${chemexInputCls} font-mono text-xs`}
        />
        {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
      </div>
    </ChemexModalShell>
  );
};

export default MethodsTab;
