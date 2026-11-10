import React, { useState } from 'react';
import { Calculator, X } from 'lucide-react';
import { estimateTaucNs, KDA_PER_NS_AT_300K } from '../../lib/taucEstimate';
import { NumericField } from './NumericField';

const fieldClass =
  'w-full px-2 py-1 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded text-xs font-mono text-slate-800 dark:text-slate-200';

/** Popover next to TAUC_A: estimate τc from molecular weight, temperature and viscosity. */
export const TaucEstimator: React.FC<{
  temperatureC: number;
  onUse: (taucNs: number, note: string) => void;
}> = ({ temperatureC, onUse }) => {
  const [open, setOpen] = useState(false);
  const [mw, setMw] = useState<number | undefined>(undefined);
  const [temp, setTemp] = useState<number | undefined>(temperatureC);
  const [eta, setEta] = useState<number | undefined>(1);
  const tau = mw !== undefined && temp !== undefined ? estimateTaucNs({ mwKDa: mw, temperatureC: temp, viscosityRel: eta ?? 1 }) : null;

  return (
    <span className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="p-0.5 rounded text-slate-400 hover:text-blue-600 dark:hover:text-blue-400"
        aria-label="Estimate TAUC_A"
        title="Estimate τc from molecular weight and temperature"
      >
        <Calculator className="w-3.5 h-3.5" />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="TAUC_A estimator"
          className="absolute z-30 right-0 mt-1 w-64 p-3 space-y-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-lg text-xs text-slate-700 dark:text-slate-300"
        >
          <div className="flex items-center justify-between">
            <span className="font-bold">Estimate τc</span>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close estimator" className="text-slate-400 hover:text-slate-700">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <label className="block">
            <span className="text-[10px] font-semibold text-slate-500">Molecular weight (kDa)</span>
            <NumericField ariaLabel="Molecular weight (kDa)" value={mw} onCommit={setMw} className={fieldClass} placeholder="e.g. 15" />
          </label>
          <label className="block">
            <span className="text-[10px] font-semibold text-slate-500">Temperature (°C)</span>
            <NumericField ariaLabel="Temperature (°C)" value={temp} onCommit={setTemp} className={fieldClass} />
          </label>
          <label className="block">
            <span className="text-[10px] font-semibold text-slate-500">Viscosity relative to water (optional)</span>
            <NumericField ariaLabel="Relative viscosity" value={eta} onCommit={setEta} className={fieldClass} placeholder="1" />
          </label>
          <p className="text-[10px] text-slate-400">
            ≈ 1 ns per {KDA_PER_NS_AT_300K} kDa at 300 K, scaled by η/T (globular protein). A starting value only.
          </p>
          <div className="flex items-center justify-between pt-1">
            <span className="font-mono font-bold" aria-label="Estimated τc">
              {tau === null ? '—' : `${tau.toFixed(2)} ns`}
            </span>
            <button
              type="button"
              disabled={tau === null}
              onClick={() => {
                if (tau === null) return;
                onUse(Number(tau.toFixed(2)), `estimated from ${mw} kDa at ${temp} °C, η_rel ${eta ?? 1}`);
                setOpen(false);
              }}
              className="px-2.5 py-1 rounded-md bg-blue-600 hover:bg-blue-700 text-white font-semibold disabled:opacity-40"
            >
              Use
            </button>
          </div>
        </div>
      )}
    </span>
  );
};
