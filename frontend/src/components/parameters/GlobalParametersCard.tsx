import React, { useMemo, useState } from 'react';
import { Layers, Info, ChevronDown, ChevronRight, Plus, X } from 'lucide-react';
import type { AvailableParamMeta } from '../methods/ParameterTable';
import { GLOBAL_PRECEDENCE_HELP, addableGlobals } from '../../lib/globalParams';
import type { RoleChip } from '../../lib/parameterRoleChip';
import { derivedKinetics } from '../../lib/kineticDerived';
import { fmtNum } from '../../lib/parameterRoleView';
import type { ExtraGlobalField, ParameterConfig, ParamValue } from '../../lib/parameterConfig';
import { withBound, withValue } from '../../lib/parameterConfig';
import { getUnitDef } from '../../lib/unitRegistry';
import { fallbackDefaults, fmtDefault, type ParamDefaultsLookup } from '../../lib/chemexDefaults';
import { ParameterBadge } from './ParameterBadge';
import { NumericField } from './NumericField';
import { TaucEstimator } from './TaucEstimator';

export type { ExtraGlobalField };

interface GlobalParametersCardProps {
  config: ParameterConfig;
  onChange: (updatedConfig: ParameterConfig) => void;
  /**
   * Names of global parameters in the ChemEx catalogue for the current model
   * (e.g. ['PB', 'KEX_AB', 'TAUC_A'] or the 3-state set). Order is preserved.
   */
  catalogGlobals?: string[];
  extraGlobals?: ExtraGlobalField[];
  /** ChemEx default values and bounds (backend catalogue); defaults to the static table. */
  defaults?: ParamDefaultsLookup;
  /** Full backend catalogue for the model: source of "+ Add global parameter". */
  catalog?: AvailableParamMeta[] | null;
  /** Role of each global (lower-case key) in the active method step; null = no chip (e.g. TREF). */
  roleChip?: (key: string) => RoleChip | null;
  /** Click on a role chip (e.g. open the Methods tab). */
  onRoleClick?: () => void;
  /** Kinetic model, for the derived PA/KAB/KBA/τ strip. */
  model?: string;
  /** Sample temperature in °C (TAUC_A estimator default). */
  temperatureC?: number;
}

const CHIP_TONES: Record<RoleChip['tone'], string> = {
  fit: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800',
  fix: 'bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700',
  constrain: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-900/30 dark:text-violet-300 dark:border-violet-800',
  search: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800',
  mixed: 'bg-slate-50 text-slate-600 border-slate-300 dark:bg-slate-800/60 dark:text-slate-400 dark:border-slate-700',
};

const boundInputClass =
  'w-full text-xs px-2 py-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-slate-800 dark:text-slate-200 font-mono';

const BASE_GLOBALS = ['PB', 'KEX_AB', 'TAUC_A'];

const FIELD_HINTS: Record<string, string> = {
  pb: 'Fraction of minor state B (e.g. 0.05 = 5%)',
  pc: 'Fraction of minor state C',
  kex_ab: 'Sum of forward & reverse rates: k_ab + k_ba',
  kex_ac: 'Sum of forward & reverse rates: k_ac + k_ca',
  kex_bc: 'Sum of forward & reverse rates: k_bc + k_cb',
  tauc_a: 'Rotational correlation time (ns). Seeds relaxation estimates (model-free / R1·R2 initialisation); fixed by default.',
};

export const GlobalParametersCard: React.FC<GlobalParametersCardProps> = ({
  config,
  onChange,
  catalogGlobals,
  extraGlobals = [],
  defaults = fallbackDefaults,
  catalog,
  roleChip,
  onRoleClick,
  model,
  temperatureC = 25,
}) => {
  const globals = useMemo(() => config.globals || {}, [config.globals]);
  const [openBounds, setOpenBounds] = useState<Record<string, boolean>>({});
  // Parameters added from the catalogue that have no value yet (kept visible until removed).
  const [added, setAdded] = useState<string[]>([]);
  const [toAdd, setToAdd] = useState('');

  const handleBound = (
    paramKey: string,
    side: 'lower' | 'upper',
    bound: number | undefined,
    displayed: number | null | undefined
  ) => {
    const next = withBound(globals[paramKey], side, bound, displayed);
    const nextGlobals = { ...globals };
    if (next) nextGlobals[paramKey] = next;
    else delete nextGlobals[paramKey];
    onChange({ ...config, globals: nextGlobals });
  };

  const fields = useMemo(() => {
    const keys: string[] = [];
    const push = (k: string) => {
      const lower = k.toLowerCase();
      if (!keys.includes(lower)) keys.push(lower);
    };
    (catalogGlobals && catalogGlobals.length > 0 ? catalogGlobals : BASE_GLOBALS).forEach(push);
    const builtIn = new Set<string>();
    (catalogGlobals && catalogGlobals.length > 0 ? catalogGlobals : BASE_GLOBALS).forEach(k => builtIn.add(k.toLowerCase()));
    extraGlobals.forEach(f => push(f.key));
    extraGlobals.forEach(f => builtIn.add(f.key.toLowerCase()));
    Object.keys(globals).forEach(push);
    added.forEach(push);
    return keys.map(key => {
      const extra = extraGlobals.find(f => f.key.toLowerCase() === key);
      const def = getUnitDef(key);
      const meta = catalog?.find(r => r.name.toLowerCase() === key);
      return {
        key,
        removable: !builtIn.has(key),
        perResidue: meta?.scope === 'residue',
        breaksLink: meta?.derived ? meta.default_expression : undefined,
        label: extra?.label ?? def.label,
        hint: extra?.hint ?? FIELD_HINTS[key] ?? def.gloss,
        // A fraction has no unit; its 0–1 range belongs to the bounds row, not the unit chip.
        unit: def.uiUnit === 'fraction' ? '' : def.uiUnit,
        chemexDefault: defaults(key)?.value ?? null,
      };
    });
  }, [catalogGlobals, extraGlobals, globals, defaults, added, catalog]);

  const candidates = addableGlobals(catalog, fields.map(f => f.key));
  const derived = model
    ? derivedKinetics(model, name => globals[name.toLowerCase()]?.value ?? defaults(name)?.value ?? null)
    : null;

  const handleAdd = () => {
    if (!toAdd) return;
    setAdded(prev => (prev.includes(toAdd) ? prev : [...prev, toAdd]));
    setToAdd('');
  };

  const handleRemove = (key: string) => {
    setAdded(prev => prev.filter(k => k !== key));
    const nextGlobals = { ...globals };
    delete nextGlobals[key];
    onChange({ ...config, globals: nextGlobals });
  };

  /** A cleared field is removed from [GLOBAL] (with its bounds), so ChemEx's default applies. */
  const handleUpdate = (paramKey: string, val: number | undefined) => {
    const nextGlobals = { ...globals };
    if (val === undefined) delete nextGlobals[paramKey];
    else nextGlobals[paramKey] = withValue(globals[paramKey], val, { kind: 'manual', at: new Date().toISOString() });
    onChange({ ...config, globals: nextGlobals });
  };

  return (
    <div className="bg-slate-50 dark:bg-slate-800/50 p-5 rounded-xl border border-slate-200 dark:border-slate-700 shadow-2xs">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-blue-500" />
          <h4 className="text-sm font-bold text-slate-800 dark:text-slate-200">Global starting values [GLOBAL]</h4>
        </div>
        <span className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1" title={GLOBAL_PRECEDENCE_HELP}>
          <Info className="w-3.5 h-3.5" />
          Applies to all residues in [GLOBAL]; per-residue sections override it
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {fields.map(f => {
          const param: ParamValue | undefined = globals[f.key];
          const placeholder = f.chemexDefault !== null ? `ChemEx default: ${fmtDefault(f.chemexDefault)}` : 'ChemEx default';
          return (
            <div key={f.key} className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label
                  htmlFor={`global-${f.key}`}
                  className="block text-xs font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wider"
                >
                  {f.label}
                </label>
                <span className="flex items-center gap-1">
                  {(() => {
                    const chip = roleChip?.(f.key);
                    return chip ? (
                      <button
                        type="button"
                        onClick={onRoleClick}
                        title={`${chip.title}. Roles live in the method file, not in parameters.toml.`}
                        className={`px-1.5 py-0.5 rounded text-[9px] font-extrabold tracking-wider border ${CHIP_TONES[chip.tone]}`}
                      >
                        {chip.label}
                      </button>
                    ) : null;
                  })()}
                  {f.key === 'tauc_a' && (
                    <TaucEstimator
                      temperatureC={temperatureC}
                      onUse={tau => handleUpdate('tauc_a', tau)}
                    />
                  )}
                  <ParameterBadge source={param?.source} chemexDefault={f.chemexDefault} unit={f.unit} compact />
                  {f.removable && (
                    <button
                      type="button"
                      onClick={() => handleRemove(f.key)}
                      className="p-0.5 rounded text-slate-400 hover:text-rose-600 dark:hover:text-rose-400"
                      aria-label={`Remove ${f.key.toUpperCase()} from [GLOBAL]`}
                      title="Remove from [GLOBAL]"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </span>
              </div>
              <div className="relative rounded-lg shadow-2xs">
                <NumericField
                  id={`global-${f.key}`}
                  value={param?.value}
                  onCommit={v => handleUpdate(f.key, v)}
                  className="w-full text-sm pl-3 pr-16 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-slate-800 dark:text-slate-200 font-mono transition-colors placeholder:text-slate-400"
                  placeholder={placeholder}
                  title={param ? undefined : `Not set: ChemEx starts at its default. Clear a value to fall back to it.`}
                />
                {f.unit && (
                  <div className="absolute inset-y-0 right-0 flex items-center pr-2.5 pointer-events-none">
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700">
                      {f.unit}
                    </span>
                  </div>
                )}
              </div>
              <p className="text-[10px] text-slate-400">{f.hint}</p>
              {f.perResidue && (
                <p className="text-[10px] text-slate-500 dark:text-slate-400">
                  Blanket starting value for every residue; per-residue [{f.key.toUpperCase()}] entries override it.
                </p>
              )}
              {f.breaksLink && (
                <p className="text-[10px] text-amber-700 dark:text-amber-400">
                  Setting this in [GLOBAL] replaces ChemEx's default link ({f.key.toUpperCase()} = {f.breaksLink}) for every residue.
                </p>
              )}
              {f.key !== 'tref' && (() => {
                const def = defaults(f.key);
                const custom = param?.lower !== undefined || param?.upper !== undefined;
                const open = openBounds[f.key] ?? custom;
                return (
                  <div className="pt-0.5">
                    <button
                      type="button"
                      onClick={() => setOpenBounds(prev => ({ ...prev, [f.key]: !open }))}
                      className="flex items-center gap-1 text-[10px] font-semibold text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                      aria-expanded={open}
                      title="ChemEx [init, lower, upper]: explicit bounds replace ChemEx's default bounds (and the MCMC prior support)"
                    >
                      {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                      <span>Bounds</span>
                      {custom ? (
                        <span className="ml-1 w-1.5 h-1.5 rounded-full bg-blue-500" aria-label="custom bounds" />
                      ) : (
                        <span className="font-normal text-slate-400">
                          ChemEx [{fmtDefault(def?.lower)}, {fmtDefault(def?.upper)}]
                        </span>
                      )}
                    </button>
                    {open && (
                      <div className="mt-1.5 grid grid-cols-2 gap-2">
                        <NumericField
                          ariaLabel={`${f.label} lower bound`}
                          value={param?.lower}
                          onCommit={v => handleBound(f.key, 'lower', v, param?.value ?? f.chemexDefault)}
                          placeholder={`lower: ${fmtDefault(def?.lower)}`}
                          className={boundInputClass}
                        />
                        <NumericField
                          ariaLabel={`${f.label} upper bound`}
                          value={param?.upper}
                          onCommit={v => handleBound(f.key, 'upper', v, param?.value ?? f.chemexDefault)}
                          placeholder={`upper: ${fmtDefault(def?.upper)}`}
                          className={boundInputClass}
                        />
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          );
        })}
      </div>

      {derived && derived.length > 0 && (
        <div
          className="mt-4 pt-3 border-t border-slate-200 dark:border-slate-700 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400"
          aria-label="Derived kinetic quantities"
          title="Read-only, derived from the starting values above (ChemEx defaults where unset): PA = 1 − ΣP, k_ij = KEX_ij·p_j/(p_i+p_j), τ_X = 1/Σk_Xj"
        >
          <span className="font-semibold text-slate-600 dark:text-slate-300">Derived</span>
          {derived.map(q => (
            <span key={q.key} className="font-mono">
              {q.label} = {q.value === null ? '—' : fmtNum(q.value)}
              {q.unit && q.value !== null ? ` ${q.unit}` : ''}
            </span>
          ))}
        </div>
      )}

      {candidates.length > 0 && (
        <div className="mt-4 pt-3 border-t border-slate-200 dark:border-slate-700 flex flex-wrap items-center gap-2 text-xs">
          <label htmlFor="add-global-param" className="font-semibold text-slate-600 dark:text-slate-400">
            Add global parameter
          </label>
          <select
            id="add-global-param"
            value={toAdd}
            onChange={e => setToAdd(e.target.value)}
            className="px-2 py-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-md text-slate-800 dark:text-slate-200 font-mono"
          >
            <option value="">Choose…</option>
            {candidates.map(r => (
              <option key={r.name} value={r.name.toLowerCase()} title={r.gloss}>
                {r.name}
                {r.scope === 'residue' ? ' (blanket for all residues)' : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleAdd}
            disabled={!toAdd}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-blue-600 hover:bg-blue-700 text-white font-semibold disabled:opacity-40"
          >
            <Plus className="w-3 h-3" />
            Add
          </button>
          <span className="text-[10px] text-slate-400" title={GLOBAL_PRECEDENCE_HELP}>
            Written to [GLOBAL] as a blanket starting value.
          </span>
        </div>
      )}
    </div>
  );
};
