import React from 'react';
import { Layers, Info } from 'lucide-react';
import type { ParameterConfig, ParamValue } from '../../lib/parameterConfig';
import { ParameterBadge } from './ParameterBadge';

interface GlobalParametersCardProps {
  config: ParameterConfig;
  onChange: (updatedConfig: ParameterConfig) => void;
}

export const GlobalParametersCard: React.FC<GlobalParametersCardProps> = ({
  config,
  onChange,
}) => {
  const globals = config.globals || {};

  const handleUpdate = (paramKey: string, val: number) => {
    const nextGlobals = {
      ...globals,
      [paramKey]: {
        value: val,
        source: { kind: 'manual' as const, at: new Date().toISOString() },
      },
    };
    onChange({
      ...config,
      globals: nextGlobals,
    });
  };

  const pbParam: ParamValue = globals.pb || { value: 0.05, source: { kind: 'default' } };
  const kexParam: ParamValue = globals.kex_ab || { value: 500, source: { kind: 'default' } };
  const taucParam: ParamValue = globals.tauc_a || { value: 4.0, source: { kind: 'default' } };

  return (
    <div className="bg-slate-50 dark:bg-slate-800/50 p-5 rounded-xl border border-slate-200 dark:border-slate-700 shadow-2xs">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-blue-500" />
          <h4 className="text-sm font-bold text-slate-800 dark:text-slate-200">
            Global Fit Settings
          </h4>
        </div>
        <span className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
          <Info className="w-3.5 h-3.5" />
          Applies to all residues in [GLOBAL]
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {/* PB Input */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wider">
              Excited Population (p_b)
            </label>
            <ParameterBadge source={pbParam.source} compact />
          </div>
          <div className="relative rounded-lg shadow-2xs">
            <input
              type="number"
              min="0"
              max="1"
              step="0.001"
              value={isNaN(pbParam.value) ? '' : pbParam.value}
              onChange={(e) => handleUpdate('pb', parseFloat(e.target.value) || 0)}
              className="w-full text-sm pl-3 pr-16 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-slate-800 dark:text-slate-200 font-mono transition-colors"
              placeholder="0.05"
            />
            <div className="absolute inset-y-0 right-0 flex items-center pr-2.5 pointer-events-none">
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700">
                0 - 1.0
              </span>
            </div>
          </div>
          <p className="text-[10px] text-slate-400">Fraction of minor state B (e.g. 0.05 = 5%)</p>
        </div>

        {/* KEX_AB Input */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wider">
              Exchange Rate (k_ex)
            </label>
            <ParameterBadge source={kexParam.source} compact />
          </div>
          <div className="relative rounded-lg shadow-2xs">
            <input
              type="number"
              min="0.01"
              step="1"
              value={isNaN(kexParam.value) ? '' : kexParam.value}
              onChange={(e) => handleUpdate('kex_ab', parseFloat(e.target.value) || 0)}
              className="w-full text-sm pl-3 pr-14 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-slate-800 dark:text-slate-200 font-mono transition-colors"
              placeholder="500"
            />
            <div className="absolute inset-y-0 right-0 flex items-center pr-2.5 pointer-events-none">
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700">
                s⁻¹
              </span>
            </div>
          </div>
          <p className="text-[10px] text-slate-400">Sum of forward & reverse rates: k_ab + k_ba</p>
        </div>

        {/* TAUC_A Input */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wider">
              Correlation Time (τ_c)
            </label>
            <ParameterBadge source={taucParam.source} compact />
          </div>
          <div className="relative rounded-lg shadow-2xs">
            <input
              type="number"
              min="0.01"
              step="0.1"
              value={isNaN(taucParam.value) ? '' : taucParam.value}
              onChange={(e) => handleUpdate('tauc_a', parseFloat(e.target.value) || 0)}
              className="w-full text-sm pl-3 pr-12 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-slate-800 dark:text-slate-200 font-mono transition-colors"
              placeholder="4.0"
            />
            <div className="absolute inset-y-0 right-0 flex items-center pr-2.5 pointer-events-none">
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800">
                ns
              </span>
            </div>
          </div>
          <p className="text-[10px] text-slate-400">Rotational correlation time in nanoseconds</p>
        </div>
      </div>
    </div>
  );
};
