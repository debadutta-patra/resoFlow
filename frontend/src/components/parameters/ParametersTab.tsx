/**
 * Parameters tab shared by every ChemEx analysis page (CEST, CPMG, EXCHANGE).
 *
 * Renders an identical layout over a `ParameterEditor` (hooks/useParameterEditor).
 * Experiment differences come only from the plugin's `ParameterTabCapabilities`.
 */

import React, { useMemo, useState } from 'react';
import { Activity, AlertTriangle, GitFork, Info, RefreshCw, Sliders, Upload, X } from 'lucide-react';
import type { ParameterEditor } from '../../hooks/useParameterEditor';
import type { ParameterTabCapabilities } from '../../lib/experimentPlugin';
import type { MethodConfig } from '../../lib/methodConfig';
import type { ParameterConfig, PickSetData, ProfileRef } from '../../lib/parameterConfig';
import { isResidueExcluded, seedCsAFromProfiles, unsetStartingParams } from '../../lib/parameterConfig';
import type { ParameterIssue } from '../../lib/parameterValidation';
import type { SourceRunSummary, TargetAnalysisMeta } from '../../lib/compatibility';
import { validateParameterConfig } from '../../lib/parameterValidation';
import { fmtDefault } from '../../lib/chemexDefaults';
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
        defaults: editor.defaults,
        zeroDwQuickFix: capabilities.zeroDwQuickFix,
      }),
    [parameterConfig, profiles, methodConfig, selectedModule, editor.defaults, capabilities.zeroDwQuickFix]
  );

  // Residues (with data, not excluded) that will start CS_A / DW_AB from ChemEx's defaults.
  const defaultStart = useMemo(() => {
    const active = profiles.filter(p => !isResidueExcluded(parameterConfig, p.residue, profiles));
    const starting = active.filter(p => unsetStartingParams(parameterConfig, p.residue, ['cs_a', 'dw_ab']).length > 0);
    return { total: active.length, count: starting.length };
  }, [profiles, parameterConfig]);

  const applyQuickFix = (issue: ParameterIssue) => {
    const fix = issue.quickFix;
    if (!fix || fix.kind !== 'set_global') return;
    editor.setParameterConfig(prev => ({
      ...prev,
      globals: {
        ...prev.globals,
        [fix.key]: { ...prev.globals?.[fix.key], value: fix.value, source: { kind: 'manual', at: new Date().toISOString() } },
      },
    }));
    notify?.(`${fix.label} applied`);
  };

  const seed = capabilities.seedFromProfiles;
  const handleSeedFromProfiles = () => {
    if (!seed) return;
    const { config, seeded } = seedCsAFromProfiles(parameterConfig, profiles, picks, p =>
      seed.estimate(p, { selectedModule })
    );
    if (seeded.length > 0) editor.setParameterConfig(config);
    notify?.(
      seeded.length > 0
        ? `Seeded CS_A from profiles for ${seeded.length} residue${seeded.length === 1 ? '' : 's'}`
        : 'No residue without a pick had a clear dip to seed CS_A from'
    );
  };

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
            {seed && (
              <button type="button" onClick={handleSeedFromProfiles} className={actionBtnNeutral} title={seed.title}>
                <Activity className="w-3.5 h-3.5" />
                <span>{seed.label}</span>
              </button>
            )}
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
            {issue.quickFix && (
              <button
                type="button"
                onClick={() => applyQuickFix(issue)}
                className="ml-2 px-2 py-0.5 rounded-md bg-amber-600 hover:bg-amber-700 text-white text-[10px] font-bold"
              >
                {issue.quickFix.label}
              </button>
            )}
          </>
        ))}
      />

      {editor.notices.length > 0 && (
        <div className="p-3.5 rounded-xl bg-blue-50/70 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 flex items-start justify-between gap-3 text-xs text-blue-800 dark:text-blue-300">
          <div className="flex items-start gap-2.5">
            <Info className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              {editor.notices.map((n, i) => (
                <p key={i}>{n}</p>
              ))}
            </div>
          </div>
          <button type="button" onClick={editor.dismissNotices} className="p-0.5 rounded hover:bg-blue-100 dark:hover:bg-blue-900/40" aria-label="Dismiss notice">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {!editor.isRawParamEditMode && defaultStart.count > 0 && (
        <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 flex items-center justify-between gap-3 text-xs text-slate-700 dark:text-slate-300">
          <span className="flex items-center gap-2">
            <Info className="w-4 h-4 text-slate-500 shrink-0" />
            <span>
              <strong>
                {defaultStart.count} of {defaultStart.total}
              </strong>{' '}
              residue{defaultStart.total === 1 ? '' : 's'} will start from ChemEx defaults (CS_A {fmtDefault(editor.defaults('cs_a')?.value)} ppm and/or DW_AB{' '}
              {fmtDefault(editor.defaults('dw_ab')?.value)} ppm).
            </span>
          </span>
        </div>
      )}

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
            defaults={editor.defaults}
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
              defaults={editor.defaults}
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
