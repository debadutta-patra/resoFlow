/**
 * Parameters tab shared by every ChemEx analysis page (CEST, CPMG, EXCHANGE).
 *
 * Renders an identical layout over a `ParameterEditor` (hooks/useParameterEditor).
 * Experiment differences come only from the plugin's `ParameterTabCapabilities`.
 */

import React, { useMemo, useState } from 'react';
import { AlertTriangle, GitFork, RefreshCw, Sliders, Upload } from 'lucide-react';
import type { ParameterEditor } from '../../hooks/useParameterEditor';
import type { ParameterTabCapabilities } from '../../lib/experimentPlugin';
import type { MethodConfig } from '../../lib/methodConfig';
import type { ParameterConfig, PickSetData, ProfileRef } from '../../lib/parameterConfig';
import type { SourceRunSummary, TargetAnalysisMeta } from '../../lib/compatibility';
import { validateParameterConfig } from '../../lib/parameterValidation';
import { GlobalParametersCard } from './GlobalParametersCard';
import { ResidueParametersTable } from './ResidueParametersTable';
import { ResyncModal } from './ResyncModal';
import { ParametersImportModal } from './ParametersImportModal';
import { SourceRunPickerModal } from './SourceRunPickerModal';
import { InheritParametersModal } from './InheritParametersModal';
import {
  ChemexTabHeader,
  RawModeToggleButton,
  RawTomlEditor,
  TomlPreviewStrip,
  UnparsedLinesNotice,
  ValidationBanner,
  actionBtnAccent,
  actionBtnInherit,
  actionBtnNeutral,
  actionBtnWarn,
} from '../chemex/TomlEditorParts';

export interface ParametersTabProps {
  editor: ParameterEditor;
  capabilities: ParameterTabCapabilities;
  projectUuid: string;
  analysisUuid: string;
  targetAnalysis: TargetAnalysisMeta;
  picks: Record<string, PickSetData>;
  profiles: ProfileRef[];
  residueLabels?: Record<string, string>;
  methodConfig: MethodConfig;
  activeStepIdx: number;
  /** ChemEx module, for nucleus-aware sanity ranges in validation. */
  selectedModule?: string;
  /** Names of [GLOBAL] parameters in the backend catalogue for the current model. */
  catalogGlobals?: string[];
  onNavigateToMethods: () => void;
  /** Apply an inherited source run (parameters, and optionally method + picks). */
  onApplyInherited: (params: ParameterConfig, method?: MethodConfig, picks?: Record<string, PickSetData>) => void;
  notify?: (message: string) => void;
}

export const ParametersTab: React.FC<ParametersTabProps> = ({
  editor,
  capabilities,
  projectUuid,
  analysisUuid,
  targetAnalysis,
  picks,
  profiles,
  residueLabels,
  methodConfig,
  activeStepIdx,
  selectedModule,
  catalogGlobals,
  onNavigateToMethods,
  onApplyInherited,
  notify,
}) => {
  const [showResync, setShowResync] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showSourcePicker, setShowSourcePicker] = useState(false);
  const [sourceRun, setSourceRun] = useState<SourceRunSummary | null>(null);

  const { parameterConfig } = editor;
  const staleCount = editor.staleResidues.length;
  const residueCount = Object.keys(parameterConfig.residues || {}).length;
  const labels = residueLabels ?? Object.fromEntries(profiles.map(p => [p.residue, p.full_residue || p.residue]));
  const table = capabilities.residueTable;
  // Keep the picker's target stable across parent re-renders (e.g. log polling) so it
  // does not refetch candidate runs while open.
  const targetKey = JSON.stringify(targetAnalysis);
  const stableTarget = useMemo(() => JSON.parse(targetKey) as TargetAnalysisMeta, [targetKey]);
  const validationIssues = useMemo(
    () =>
      validateParameterConfig(parameterConfig, {
        availableResidues: profiles.map(p => p.residue),
        methodConfig,
        selectedModule,
      }),
    [parameterConfig, profiles, methodConfig, selectedModule]
  );

  return (
    <div className="space-y-6 animate-in fade-in">
      <ChemexTabHeader
        icon={<Sliders className="w-5 h-5 text-blue-500" />}
        title="ChemEx Parameters Configuration"
        description={capabilities.description}
        actions={
          <>
            <button
              type="button"
              onClick={() => setShowSourcePicker(true)}
              className={actionBtnInherit}
              title="Seed starting parameters (kex_ab, pb, cs_a, dw_ab) from an earlier completed run"
            >
              <GitFork className="w-3.5 h-3.5" />
              <span>Inherit from run</span>
            </button>
            <button
              type="button"
              onClick={() => setShowResync(true)}
              className={staleCount > 0 ? `${actionBtnWarn} animate-pulse` : actionBtnAccent}
              title={capabilities.resync.buttonTitle}
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>{capabilities.resync.buttonLabel}</span>
              {staleCount > 0 && (
                <span className="ml-1 px-1.5 py-0.2 rounded-full bg-white text-amber-800 text-[10px] font-extrabold">
                  {staleCount}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setShowImport(true)}
              className={actionBtnNeutral}
              title="Import parameters from raw TOML"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>Import TOML</span>
            </button>
            <RawModeToggleButton active={editor.isRawParamEditMode} onClick={editor.toggleRawMode} />
          </>
        }
      />

      <ValidationBanner
        title="Parameter Validation Warnings"
        items={validationIssues.map(issue => (
          <>
            {issue.residue && <strong>[{issue.residue}] </strong>}
            {issue.paramKey && <strong>({issue.paramKey}) </strong>}
            {issue.message}
          </>
        ))}
      />

      {!editor.isRawParamEditMode && (
        <UnparsedLinesNotice
          count={editor.unparsedParamTomlLines.length}
          subject="parameter file"
          onViewRaw={editor.enterRawMode}
        />
      )}

      {staleCount > 0 && !editor.isRawParamEditMode && (
        <div className="p-3.5 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 flex items-center justify-between gap-3 text-xs text-amber-800 dark:text-amber-300">
          <div className="flex items-center gap-2.5">
            <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
            <span>
              <strong>Starting values out of date:</strong> {capabilities.resync.staleBanner(staleCount)}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setShowResync(true)}
            className="px-3 py-1 bg-amber-600 hover:bg-amber-700 text-white font-bold rounded-lg text-xs shadow-xs flex items-center gap-1"
          >
            <RefreshCw className="w-3 h-3" />
            <span>Review Diff & Re-sync</span>
          </button>
        </div>
      )}

      {editor.isRawParamEditMode ? (
        <RawTomlEditor
          fileName="parameters.toml"
          value={editor.rawParamToml}
          onChange={editor.setRawParamToml}
          onApply={editor.applyRawToml}
          onDiscard={editor.discardRawToml}
        />
      ) : (
        <div className="space-y-6">
          <GlobalParametersCard
            config={parameterConfig}
            onChange={editor.setParameterConfig}
            catalogGlobals={catalogGlobals}
            extraGlobals={capabilities.extraGlobals}
          />
          <div className="space-y-2">
            <h4 className="text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider">
              {table.heading}
            </h4>
            <ResidueParametersTable
              config={parameterConfig}
              onChange={editor.setParameterConfig}
              picks={picks}
              profiles={profiles}
              methodConfig={methodConfig}
              activeStepIdx={activeStepIdx}
              onNavigateToMethods={onNavigateToMethods}
              onToggleExclude={editor.toggleExclude}
              expectsBPicks={table.expectsBPicks}
              profileTitle={table.profileTitle}
              pickNoun={table.pickNoun}
              pickedLabel={table.pickedLabel}
              staleLabel={table.staleLabel}
              renderProfile={capabilities.renderResidueProfile}
            />
          </div>
        </div>
      )}

      <TomlPreviewStrip
        fileName="parameters.toml"
        downloadName={`parameters_${analysisUuid}.toml`}
        toml={editor.effectiveParameterToml}
        badge={`${residueCount} residue${residueCount === 1 ? '' : 's'}`}
        onCopied={notify}
      />

      <ResyncModal
        isOpen={showResync}
        onClose={() => setShowResync(false)}
        config={parameterConfig}
        picks={picks}
        profiles={profiles}
        residueLabels={labels}
        onApply={updated => {
          editor.replaceConfig(updated);
          notify?.(capabilities.resync.successMessage);
        }}
      />

      <ParametersImportModal
        isOpen={showImport}
        onClose={() => setShowImport(false)}
        codec={capabilities.codec}
        onImport={(imported, unparsed) => {
          editor.replaceConfig(imported, unparsed);
          notify?.('Imported parameters.toml successfully');
        }}
      />

      <SourceRunPickerModal
        isOpen={showSourcePicker}
        onClose={() => setShowSourcePicker(false)}
        projectUuid={projectUuid}
        targetAnalysis={stableTarget}
        onSelectRun={source => {
          setShowSourcePicker(false);
          setSourceRun(source);
        }}
      />

      {sourceRun && (
        <InheritParametersModal
          isOpen={!!sourceRun}
          onClose={() => setSourceRun(null)}
          projectUuid={projectUuid}
          sourceRun={sourceRun}
          currentParamConfig={parameterConfig}
          currentMethodConfig={methodConfig}
          currentPicks={picks}
          profiles={profiles}
          residueLabels={labels}
          onApply={(params, method, newPicks) => {
            onApplyInherited(params, method, newPicks);
            notify?.(`Inherited parameters applied from "${sourceRun.name}"`);
          }}
        />
      )}
    </div>
  );
};

export default ParametersTab;
