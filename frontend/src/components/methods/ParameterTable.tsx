import React, { useState, useMemo } from 'react';
import type { Step, ParamSetting, ParamMode } from '../../lib/methodConfig';
import type { StartingProvenance } from '../../lib/parameterConfig';
import { baselineRoleLabel } from '../../lib/baselineRoles';
import type { BaselineRolesState } from '../../hooks/useBaselineRoles';
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Activity,
} from 'lucide-react';

export interface AvailableParamMeta {
  name: string;
  gloss: string;
  scope: 'global' | 'residue';
  default_mode?: ParamMode;
  default_bounds?: string;
  default_expression?: string;
  category?: string;
  is_primary?: boolean;
}

export const DEFAULT_PARAM_METAS: AvailableParamMeta[] = [
  {
    name: 'PB',
    gloss: 'Population of minor state B (0 - 0.5)',
    scope: 'global',
    default_mode: 'default',
    category: 'kinetic',
    is_primary: true,
  },
  {
    name: 'KEX_AB',
    gloss: 'Exchange rate between states A and B (s⁻¹)',
    scope: 'global',
    default_mode: 'default',
    category: 'kinetic',
    is_primary: true,
  },
  {
    name: 'CS_A',
    gloss: 'Chemical shift of major state A (ppm)',
    scope: 'residue',
    default_mode: 'default',
    category: 'chemical_shift',
    is_primary: true,
  },
  {
    name: 'DW_AB',
    gloss: 'Chemical shift difference CS_B - CS_A (ppm)',
    scope: 'residue',
    default_mode: 'default',
    category: 'chemical_shift',
    is_primary: true,
  },
  {
    name: 'R2_A',
    gloss: 'Transverse relaxation rate of state A (s⁻¹)',
    scope: 'residue',
    default_mode: 'default',
    category: 'relaxation',
    is_primary: true,
  },
  {
    name: 'R2_B',
    gloss: 'Transverse relaxation rate of state B (s⁻¹)',
    scope: 'residue',
    default_mode: 'default',
    default_expression: '[R2_A]',
    category: 'relaxation',
    is_primary: true,
  },
  {
    name: 'R1_A',
    gloss: 'Longitudinal relaxation rate of state A (s⁻¹)',
    scope: 'residue',
    default_mode: 'default',
    category: 'relaxation',
    is_primary: true,
  },
  {
    name: 'R1_B',
    gloss: 'Longitudinal relaxation rate of state B (s⁻¹)',
    scope: 'residue',
    default_mode: 'default',
    default_expression: '[R1_A]',
    category: 'relaxation',
    is_primary: true,
  },
  {
    name: 'TAUC_A',
    gloss: 'Rotational correlation time of state A (s)',
    scope: 'global',
    default_mode: 'default',
    category: 'hydrodynamic',
    is_primary: false,
  },
];

interface ParameterTableProps {
  step: Step;
  onChange: (updatedStep: Step) => void;
  availableParams?: AvailableParamMeta[];
  startingValues?: Record<string, number | string>;
  onNavigateToParameters?: () => void;
  readOnly?: boolean;
  /** Parameter names targeted by this step's SEARCH (shown as a badge). */
  searchTargets?: Record<string, 'grid' | 'de'>;
  /** Position of this step in the method (0 = first). */
  stepIndex?: number;
  /** Name of the step before this one (later steps start from its committed result). */
  previousStepName?: string;
  /** Last completed run's committed global values per step name (upper-case keys). */
  committedByStep?: Record<string, Record<string, number>>;
  /** Step-1 starting-value provenance per parameter (upper-case keys). */
  startingProvenance?: Record<string, StartingProvenance>;
  /** ChemEx-resolved baseline roles: what "Default" means for this analysis. */
  baselineRoles?: BaselineRolesState;
}

const fmtValue = (v: number | string) => {
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isFinite(n)) return String(v);
  return Math.abs(n) >= 1e4 || (Math.abs(n) < 1e-3 && n !== 0) ? n.toExponential(3) : String(Number(n.toPrecision(4)));
};

const PREVIOUS_STEP_TITLE =
  'ChemEx v2 starts every step from the latest successfully committed fit, whatever ROLES_FROM says. ' +
  'Parameter-file values only seed the first step.';

/** Where a FIT/FIX parameter's numeric value comes from in this step. */
const StartingValueNote: React.FC<{
  label: string;
  name: string;
  stepIndex: number;
  previousStepName?: string;
  committed?: number;
  startVal?: number | string;
  provenance?: StartingProvenance;
  onNavigateToParameters?: () => void;
}> = ({ label, name, stepIndex, previousStepName, committed, startVal, provenance, onNavigateToParameters }) => {
  if (stepIndex > 0) {
    return (
      <div className="flex flex-wrap items-center gap-1.5 text-slate-500 dark:text-slate-400 text-xs" title={PREVIOUS_STEP_TITLE}>
        <Activity className="w-3.5 h-3.5 text-blue-500" />
        <span>{label}</span>
        <span className="font-semibold text-slate-800 dark:text-slate-200">From previous step result</span>
        {committed !== undefined && previousStepName && (
          <span className="font-mono text-[11px] text-slate-400 dark:text-slate-500">
            (last run, {previousStepName}: {fmtValue(committed)})
          </span>
        )}
      </div>
    );
  }
  const value = startVal ?? provenance?.value;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-slate-500 dark:text-slate-400 text-xs">
      <Activity className="w-3.5 h-3.5 text-blue-500" />
      <span>{label}</span>
      <span className="font-mono font-semibold text-slate-800 dark:text-slate-200">
        {value !== undefined ? fmtValue(value) : 'Auto'}
      </span>
      {provenance?.source ? (
        <span className="text-[11px] text-slate-400 dark:text-slate-500">· {provenance.source}</span>
      ) : value === undefined ? (
        <span className="text-[11px] text-slate-400 dark:text-slate-500" title={`No ${name} entry in parameters.toml`}>
          · ChemEx default
        </span>
      ) : null}
      {onNavigateToParameters && (
        <button
          type="button"
          onClick={onNavigateToParameters}
          className="text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-0.5 ml-1 text-[11px]"
          title="Jump to the Parameters tab to adjust starting values"
        >
          <span>Params</span>
          <ExternalLink className="w-2.5 h-2.5" />
        </button>
      )}
    </div>
  );
};

export const ParameterTable: React.FC<ParameterTableProps> = ({
  step,
  onChange,
  availableParams,
  startingValues = {},
  onNavigateToParameters,
  readOnly = false,
  searchTargets = {},
  stepIndex = 0,
  previousStepName,
  committedByStep = {},
  startingProvenance = {},
  baselineRoles,
}) => {
  const [showAllParams, setShowAllParams] = useState(false);
  const [activeAutocompleteParam, setActiveAutocompleteParam] = useState<string | null>(null);

  const effectiveAvailableParams = useMemo(() => {
    if (availableParams && availableParams.length > 0) {
      // Merge with default metas so descriptions and scopes are always rich
      const map = new Map<string, AvailableParamMeta>();
      for (const d of DEFAULT_PARAM_METAS) {
        map.set(d.name.toUpperCase(), d);
      }
      for (const a of availableParams) {
        const existing = map.get(a.name.toUpperCase());
        map.set(a.name.toUpperCase(), { ...existing, ...a });
      }
      return Array.from(map.values());
    }
    return DEFAULT_PARAM_METAS;
  }, [availableParams]);

  // Merge available parameters with step parameters
  const stepParamMap = useMemo(() => {
    const map = new Map<string, ParamSetting>();
    for (const p of step.parameters) {
      map.set(p.name.toUpperCase(), p);
    }
    return map;
  }, [step.parameters]);

  // Combined parameter list
  const allParams = useMemo(() => {
    const list: Array<{ meta: AvailableParamMeta; setting: ParamSetting }> = [];
    const knownNames = new Set<string>();

    for (const meta of effectiveAvailableParams) {
      const uName = meta.name.toUpperCase();
      knownNames.add(uName);
      const setting = stepParamMap.get(uName) || {
        name: uName,
        mode: meta.default_mode || 'default',
        bounds: meta.default_bounds,
        expression: meta.default_expression,
      };
      list.push({ meta, setting });
    }

    // Also include any custom/unlisted parameters that might be in step
    for (const p of step.parameters) {
      const uName = p.name.toUpperCase();
      if (!knownNames.has(uName)) {
        list.push({
          meta: {
            name: uName,
            gloss: 'Custom parameter',
            scope: 'residue',
            is_primary: true,
          },
          setting: p,
        });
      }
    }

    // Preferred standard ordering
    const standardOrder = ['PB', 'KEX_AB', 'CS_A', 'DW_AB', 'R2_A', 'R2_B', 'R1_A', 'R1_B', 'TAUC_A'];

    return list.sort((a, b) => {
      const idxA = standardOrder.indexOf(a.meta.name.toUpperCase());
      const idxB = standardOrder.indexOf(b.meta.name.toUpperCase());
      if (idxA !== -1 && idxB !== -1) return idxA - idxB;
      if (idxA !== -1) return -1;
      if (idxB !== -1) return 1;
      return a.meta.name.localeCompare(b.meta.name);
    });
  }, [effectiveAvailableParams, stepParamMap, step.parameters]);

  // Filtered list based on showAllParams
  const visibleParams = useMemo(() => {
    if (showAllParams) return allParams;
    return allParams.filter(item => {
      // Always show primary parameters (including R2_A, R2_B, R1_A, R1_B)
      if (item.meta.is_primary) return true;
      if (item.setting.mode !== 'default') return true;
      return false;
    });
  }, [allParams, showAllParams]);

  const hiddenCount = allParams.length - visibleParams.length;

  const updateParamSetting = (paramName: string, updates: Partial<ParamSetting>) => {
    if (readOnly) return;
    const uName = paramName.toUpperCase();
    const existingIdx = step.parameters.findIndex(p => p.name.toUpperCase() === uName);
    let newParams = [...step.parameters];

    if (existingIdx >= 0) {
      newParams[existingIdx] = { ...newParams[existingIdx], ...updates };
    } else {
      const meta = effectiveAvailableParams.find(m => m.name.toUpperCase() === uName);
      newParams.push({
        name: uName,
        mode: meta?.default_mode || 'default',
        ...updates,
      });
    }

    onChange({
      ...step,
      parameters: newParams,
    });
  };

  const handleModeChange = (paramName: string, newMode: ParamMode) => {
    const meta = effectiveAvailableParams.find(m => m.name.toUpperCase() === paramName.toUpperCase());
    const updates: Partial<ParamSetting> = { mode: newMode };

    if (newMode === 'constrain' && !stepParamMap.get(paramName.toUpperCase())?.expression) {
      updates.expression = meta?.default_expression || '';
    }

    updateParamSetting(paramName, updates);
  };

  return (
    <div className="space-y-4">
      {/* Parameter Table */}
      <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm">
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/75 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400">
              <th className="py-3 px-4 font-semibold uppercase tracking-wider w-1/4">Parameter</th>
              <th className="py-3 px-4 font-semibold uppercase tracking-wider w-1/4">Treatment</th>
              <th className="py-3 px-4 font-semibold uppercase tracking-wider w-1/2">Setting / Expression / Grid</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
            {visibleParams.map(({ meta, setting }) => {
              const startVal = startingValues[setting.name.toLowerCase()] ?? startingValues[setting.name.toUpperCase()];
              const isDefault = setting.mode === 'default';
              const isFitted = setting.mode === 'fit';
              const isFixed = setting.mode === 'fix';
              const isConstrained = setting.mode === 'constrain';
              const searchKind = searchTargets[setting.name.toUpperCase()];
              const uName = setting.name.toUpperCase();
              const committed = previousStepName ? committedByStep[previousStepName.toUpperCase()]?.[uName] : undefined;
              const baseline = baselineRoleLabel(baselineRoles?.roles?.[uName]);
              const valueNote = (label: string) => (
                <StartingValueNote
                  label={label}
                  name={uName}
                  stepIndex={stepIndex}
                  previousStepName={previousStepName}
                  committed={committed}
                  startVal={startVal}
                  provenance={startingProvenance[uName]}
                  onNavigateToParameters={onNavigateToParameters}
                />
              );

              return (
                <tr
                  key={meta.name}
                  className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition-colors"
                >
                  {/* Name Column */}
                  <td className="py-3.5 px-4 align-top">
                    <div className="flex items-start gap-2">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-bold text-sm text-slate-900 dark:text-white">
                            {meta.name}
                          </span>
                          <span
                            className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider ${
                              meta.scope === 'global'
                                ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
                                : 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300'
                            }`}
                          >
                            {meta.scope}
                          </span>
                          {searchKind && (
                            <span
                              className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                              title={searchKind === 'grid' ? 'Scanned by this step\'s GRID search (must be FIT)' : 'DE coordinate in this step (must be FIT)'}
                            >
                              {searchKind === 'grid' ? 'Grid' : 'DE'}
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 max-w-xs leading-snug">
                          {meta.gloss}
                        </p>
                      </div>
                    </div>
                  </td>

                  {/* Treatment (Segmented Control) */}
                  <td className="py-3.5 px-4 align-top">
                    <div className="inline-flex rounded-lg bg-slate-100 dark:bg-slate-800 p-1 border border-slate-200 dark:border-slate-700/80">
                      {(['default', 'fit', 'fix', 'constrain'] as ParamMode[]).map(mode => {
                        const isActive = setting.mode === mode;
                        const modeLabels: Record<ParamMode, string> = {
                          default: 'Default',
                          fit: 'Fit',
                          fix: 'Fix',
                          constrain: 'Constrain',
                          grid: 'Fit',
                        };

                        return (
                          <button
                            key={mode}
                            type="button"
                            disabled={readOnly}
                            onClick={() => handleModeChange(meta.name, mode)}
                            className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-all ${
                              isActive
                                ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-400 shadow-sm border border-slate-200/80 dark:border-slate-600'
                                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                            } disabled:opacity-50`}
                          >
                            {modeLabels[mode]}
                          </button>
                        );
                      })}
                    </div>
                  </td>

                  {/* Value / Expression / Grid Column */}
                  <td className="py-3.5 px-4 align-top">
                    {/* DEFAULT Mode */}
                    {isDefault && (
                      <div className="flex flex-wrap items-center gap-1.5 text-slate-400 dark:text-slate-500 text-xs py-1">
                        <span
                          className="font-semibold"
                          title={
                            baseline
                              ? 'Role ChemEx assigns when ROLES does not mention this parameter (resolved for the loaded experiments and model).'
                              : baselineRoles?.loading
                                ? 'Resolving the baseline role with ChemEx…'
                                : `Baseline role unknown${baselineRoles?.error ? `: ${baselineRoles.error}` : ''}`
                          }
                        >
                          Default → {baseline ?? (baselineRoles?.loading ? '…' : 'unresolved')}
                        </span>
                        <span className="italic">
                          {searchKind ? '· auto-added to FIT because it is a search target' : '· omitted from ROLES'}
                        </span>
                      </div>
                    )}
                    {/* FIT Mode */}
                    {isFitted && (
                      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                        {valueNote('Starting:')}

                        {setting.bounds && setting.bounds.trim() && (
                          <div className="flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                            <span title="v1 inequality constraints are not supported by ChemEx v2 method files">
                              Legacy bound "{setting.bounds}" ignored in v2
                            </span>
                            {!readOnly && (
                              <button
                                type="button"
                                onClick={() => updateParamSetting(meta.name, { bounds: undefined })}
                                className="underline hover:text-amber-700"
                              >
                                remove
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {/* FIX Mode */}
                    {isFixed && <div className="py-1">{valueNote('Held at:')}</div>}

                    {/* CONSTRAIN Mode */}
                    {isConstrained && (
                      <div className="space-y-1.5 max-w-md relative">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs text-slate-400">[{meta.name}] =</span>
                          <div className="relative flex-grow">
                            <input
                              type="text"
                              disabled={readOnly}
                              value={setting.expression || ''}
                              onFocus={() => setActiveAutocompleteParam(meta.name)}
                              onBlur={() => setTimeout(() => setActiveAutocompleteParam(null), 200)}
                              onChange={e => updateParamSetting(meta.name, { expression: e.target.value })}
                              placeholder="e.g. 0.5 * [R2_A] or [R1_A]"
                              className="w-full text-xs font-mono px-2.5 py-1 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200 focus:ring-1 focus:ring-blue-500 outline-none"
                            />

                            {/* Autocomplete Dropdown */}
                            {activeAutocompleteParam === meta.name && (
                              <div className="absolute top-full left-0 mt-1 w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg z-20 max-h-36 overflow-y-auto py-1">
                                <div className="px-2 py-1 text-[10px] font-bold text-slate-400 uppercase tracking-wider border-b border-slate-100 dark:border-slate-700">
                                  Insert Parameter Reference:
                                </div>
                                {effectiveAvailableParams
                                  .filter(p => p.name.toUpperCase() !== meta.name.toUpperCase())
                                  .map(p => (
                                    <button
                                      key={p.name}
                                      type="button"
                                      onMouseDown={() => {
                                        const current = setting.expression || '';
                                        const ref = `[${p.name}]`;
                                        updateParamSetting(meta.name, {
                                          expression: current ? `${current} ${ref}` : ref,
                                        });
                                      }}
                                      className="w-full text-left px-3 py-1 text-xs font-mono text-slate-700 dark:text-slate-300 hover:bg-blue-50 dark:hover:bg-blue-900/30 flex items-center justify-between"
                                    >
                                      <span>[{p.name}]</span>
                                      <span className="text-[10px] font-sans text-slate-400">{p.gloss.slice(0, 24)}...</span>
                                    </button>
                                  ))}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )}

                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Expand/Collapse secondary parameters */}
      {hiddenCount > 0 && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => setShowAllParams(!showAllParams)}
            className="text-xs font-semibold text-slate-600 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-dashed border-slate-300 dark:border-slate-700 hover:border-blue-400 transition-all"
          >
            {showAllParams ? (
              <>
                <ChevronUp className="w-3.5 h-3.5" />
                <span>Hide advanced parameters</span>
              </>
            ) : (
              <>
                <ChevronDown className="w-3.5 h-3.5" />
                <span>Show all parameters ({hiddenCount} additional)</span>
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
};
export default ParameterTable;
