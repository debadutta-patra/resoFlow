import React, { useMemo } from 'react';
import { Layers, Info } from 'lucide-react';
import type { ExtraGlobalField, ParameterConfig, ParamValue } from '../../lib/parameterConfig';
import { getUnitDef } from '../../lib/unitRegistry';
import { ParameterBadge } from './ParameterBadge';

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
}

const BASE_GLOBALS = ['PB', 'KEX_AB', 'TAUC_A'];

const FIELD_DEFAULTS: Record<string, number> = { pb: 0.05, kex_ab: 500, tauc_a: 4.0, pc: 0.01, kex_ac: 500, kex_bc: 500 };

const FIELD_HINTS: Record<string, string> = {
  pb: 'Fraction of minor state B (e.g. 0.05 = 5%)',
  pc: 'Fraction of minor state C',
  kex_ab: 'Sum of forward & reverse rates: k_ab + k_ba',
  kex_ac: 'Sum of forward & reverse rates: k_ac + k_ca',
  kex_bc: 'Sum of forward & reverse rates: k_bc + k_cb',
  tauc_a: 'Rotational correlation time in nanoseconds',
};

export const GlobalParametersCard: React.FC<GlobalParametersCardProps> = ({
  config,
  onChange,
  catalogGlobals,
  extraGlobals = [],
}) => {
  const globals = config.globals || {};

  const fields = useMemo(() => {
    const keys: string[] = [];
    const push = (k: string) => {
      const lower = k.toLowerCase();
      if (!keys.includes(lower)) keys.push(lower);
    };
    (catalogGlobals && catalogGlobals.length > 0 ? catalogGlobals : BASE_GLOBALS).forEach(push);
    extraGlobals.forEach(f => push(f.key));
    Object.keys(globals).forEach(push);
    return keys.map(key => {
      const extra = extraGlobals.find(f => f.key.toLowerCase() === key);
      const def = getUnitDef(key);
      return {
        key,
        label: extra?.label ?? def.label,
        hint: extra?.hint ?? FIELD_HINTS[key] ?? def.gloss,
        unit: def.uiUnit === 'fraction' ? (def.max !== undefined ? `${def.min ?? 0} - ${def.max}` : '') : def.uiUnit,
        min: def.min,
        max: def.max,
        step: def.step ?? 0.01,
        defaultValue: extra?.defaultValue ?? FIELD_DEFAULTS[key] ?? 0,
      };
    });
  }, [catalogGlobals, extraGlobals, globals]);

  const handleUpdate = (paramKey: string, val: number) => {
    onChange({
      ...config,
      globals: {
        ...globals,
        [paramKey]: { value: val, source: { kind: 'manual' as const, at: new Date().toISOString() } },
      },
    });
  };

  return (
    <div className="bg-slate-50 dark:bg-slate-800/50 p-5 rounded-xl border border-slate-200 dark:border-slate-700 shadow-2xs">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-blue-500" />
          <h4 className="text-sm font-bold text-slate-800 dark:text-slate-200">Global Fit Settings</h4>
        </div>
        <span className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
          <Info className="w-3.5 h-3.5" />
          Applies to all residues in [GLOBAL]
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {fields.map(f => {
          const param: ParamValue = globals[f.key] || { value: f.defaultValue, source: { kind: 'default' } };
          return (
            <div key={f.key} className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label
                  htmlFor={`global-${f.key}`}
                  className="block text-xs font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wider"
                >
                  {f.label}
                </label>
                <ParameterBadge source={param.source} compact />
              </div>
              <div className="relative rounded-lg shadow-2xs">
                <input
                  id={`global-${f.key}`}
                  type="number"
                  min={f.min}
                  max={f.max}
                  step={f.step}
                  value={isNaN(param.value) ? '' : param.value}
                  onChange={e => handleUpdate(f.key, parseFloat(e.target.value) || 0)}
                  className="w-full text-sm pl-3 pr-16 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-slate-800 dark:text-slate-200 font-mono transition-colors"
                  placeholder={String(f.defaultValue)}
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
            </div>
          );
        })}
      </div>
    </div>
  );
};
