import React from 'react';
import { Layers, Zap, Clock, ShieldCheck } from 'lucide-react';
import { formatUncertainty } from '../../lib/uncertaintyFormatter';
import { ppmToHz } from '../../lib/parameterSymbols';

interface DerivedQuantitiesCardsProps {
  summary?: Record<string, any>;
  methodName?: string;
}

export const DerivedQuantitiesCards: React.FC<DerivedQuantitiesCardsProps> = ({
  summary = {},
}) => {
  // Extract globals or clean keys
  const getParam = (candidates: string[]) => {
    for (const key of Object.keys(summary)) {
      const clean = key.trim().replace(/^\[|\]$/g, '').toUpperCase();
      for (const cand of candidates) {
        if (clean === cand || clean.startsWith(`${cand},`) || clean.startsWith(`${cand}_`)) {
          return summary[key];
        }
      }
    }
    return undefined;
  };

  const kexStat = getParam(['KEX_AB', 'KEX']);
  const pbStat = getParam(['PB']);
  const kabStat = getParam(['KAB']);
  const kbaStat = getParam(['KBA']);
  const taubStat = getParam(['TAU_B_MS', 'TAU_B', 'TAUB']);
  const dwStat = getParam(['DW_AB', 'DW']);

  const kexVal = kexStat?.median ?? kexStat?.mean;
  const kexErr = kexStat?.standard_deviation ?? kexStat?.std_dev ?? kexStat?.std;

  const pbVal = pbStat?.median ?? pbStat?.mean;
  const pbErr = pbStat?.standard_deviation ?? pbStat?.std_dev ?? pbStat?.std;

  // Propagated derived values if not directly present in summary
  const kabVal = kabStat ? (kabStat.median ?? kabStat.mean) : kexVal !== undefined && pbVal !== undefined ? kexVal * pbVal : undefined;
  const kabErr = kabStat
    ? (kabStat.standard_deviation ?? kabStat.std_dev ?? kabStat.std)
    : kexVal && pbVal && kexErr && pbErr
    ? Math.sqrt(Math.pow(pbVal * kexErr, 2) + Math.pow(kexVal * pbErr, 2))
    : undefined;

  const kbaVal = kbaStat
    ? (kbaStat.median ?? kbaStat.mean)
    : kexVal !== undefined && pbVal !== undefined
    ? kexVal * (1.0 - pbVal)
    : undefined;
  const kbaErr = kbaStat
    ? (kbaStat.standard_deviation ?? kbaStat.std_dev ?? kbaStat.std)
    : kexVal && pbVal && kexErr && pbErr
    ? Math.sqrt(Math.pow((1.0 - pbVal) * kexErr, 2) + Math.pow(kexVal * pbErr, 2))
    : undefined;

  const taubVal = taubStat
    ? (taubStat.median ?? taubStat.mean)
    : kbaVal && kbaVal > 0
    ? (1.0 / kbaVal) * 1000.0
    : undefined;
  const taubErr = taubStat
    ? (taubStat.standard_deviation ?? taubStat.std_dev ?? taubStat.std)
    : kbaVal && kbaErr && kbaVal > 0
    ? (kbaErr / Math.pow(kbaVal, 2)) * 1000.0
    : undefined;

  // Exchange Regime Calculation
  let alpha: number | null = null;
  let regimeLabel = '—';
  let regimeBadgeClass = 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400';
  let regimeDesc = 'Provide chemical shift difference Δω to compute exchange regime.';

  const dwVal = dwStat?.median ?? dwStat?.mean;
  if (kexVal !== undefined && dwVal !== undefined && dwVal !== 0) {
    const dwHz = Math.abs(ppmToHz(dwVal, 600.0, '15N'));
    if (dwHz > 0) {
      alpha = kexVal / dwHz;
      if (alpha < 0.5) {
        regimeLabel = 'Slow Exchange';
        regimeBadgeClass = 'bg-blue-100 text-blue-800 dark:bg-blue-950/70 dark:text-blue-300 border border-blue-300 dark:border-blue-800';
        regimeDesc = `α = k_ex / |Δω| = ${alpha.toFixed(2)} (< 0.5). Peaks remain distinctly separated.`;
      } else if (alpha <= 2.0) {
        regimeLabel = 'Intermediate Exchange';
        regimeBadgeClass = 'bg-amber-100 text-amber-800 dark:bg-amber-950/70 dark:text-amber-300 border border-amber-300 dark:border-amber-800';
        regimeDesc = `α = k_ex / |Δω| = ${alpha.toFixed(2)} (0.5 – 2.0). Broadened coalescence regime.`;
      } else {
        regimeLabel = 'Fast Exchange';
        regimeBadgeClass = 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-800';
        regimeDesc = `α = k_ex / |Δω| = ${alpha.toFixed(2)} (> 2.0). Population-averaged single peak.`;
      }
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider flex items-center gap-2">
          <span>Kinetic & Thermodynamic Derived Quantities</span>
          <span className="text-[10px] font-mono font-medium px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
            Propagated per-replicate
          </span>
        </h4>

        {alpha !== null && (
          <div className="flex items-center gap-2" title={regimeDesc}>
            <span className="text-xs text-slate-500 font-medium">Exchange Regime:</span>
            <span className={`px-2.5 py-0.5 rounded-md text-xs font-bold ${regimeBadgeClass}`}>
              {regimeLabel} (α = {alpha.toFixed(2)})
            </span>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        {/* k_ex Card */}
        <div className="p-3.5 rounded-xl bg-slate-50/80 dark:bg-slate-800/40 border border-slate-200/70 dark:border-slate-700/60 flex flex-col justify-between">
          <div className="flex items-center justify-between text-slate-500 dark:text-slate-400 mb-1">
            <span className="text-xs font-bold font-mono text-slate-800 dark:text-slate-200">
              k_ex(AB)
            </span>
            <span className="text-[10px] font-mono text-slate-400">s⁻¹</span>
          </div>
          <div className="text-base font-bold font-mono text-slate-900 dark:text-white my-1">
            {formatUncertainty(kexVal, kexErr, { unit: 's⁻¹' }).formatted}
          </div>
          <div className="text-[10px] text-slate-400 flex items-center gap-1 mt-1 border-t border-slate-100 dark:border-slate-700/40 pt-1">
            <Zap className="w-3 h-3 text-indigo-500" />
            <span>Fitted exchange rate (k_AB + k_BA)</span>
          </div>
        </div>

        {/* p_B Card */}
        <div className="p-3.5 rounded-xl bg-slate-50/80 dark:bg-slate-800/40 border border-slate-200/70 dark:border-slate-700/60 flex flex-col justify-between">
          <div className="flex items-center justify-between text-slate-500 dark:text-slate-400 mb-1">
            <span className="text-xs font-bold font-mono text-slate-800 dark:text-slate-200">
              p_B
            </span>
            <span className="text-[10px] font-mono text-slate-400">%</span>
          </div>
          <div className="text-base font-bold font-mono text-indigo-600 dark:text-indigo-400 my-1">
            {formatUncertainty(pbVal, pbErr, { isPercent: true }).formatted}
          </div>
          <div className="text-[10px] text-slate-400 flex items-center gap-1 mt-1 border-t border-slate-100 dark:border-slate-700/40 pt-1">
            <Layers className="w-3 h-3 text-indigo-500" />
            <span>Minor state population</span>
          </div>
        </div>

        {/* k_AB Card */}
        <div className="p-3.5 rounded-xl bg-slate-50/80 dark:bg-slate-800/40 border border-slate-200/70 dark:border-slate-700/60 flex flex-col justify-between">
          <div className="flex items-center justify-between text-slate-500 dark:text-slate-400 mb-1">
            <span className="text-xs font-bold font-mono text-slate-800 dark:text-slate-200">
              k_AB
            </span>
            <span className="text-[10px] font-mono text-slate-400">s⁻¹</span>
          </div>
          <div className="text-base font-bold font-mono text-slate-900 dark:text-white my-1">
            {formatUncertainty(kabVal, kabErr, { unit: 's⁻¹' }).formatted}
          </div>
          <div className="text-[10px] text-slate-400 flex items-center gap-1 mt-1 border-t border-slate-100 dark:border-slate-700/40 pt-1">
            <ShieldCheck className="w-3 h-3 text-emerald-500" />
            <span>Forward rate = k_ex × p_B</span>
          </div>
        </div>

        {/* k_BA Card */}
        <div className="p-3.5 rounded-xl bg-slate-50/80 dark:bg-slate-800/40 border border-slate-200/70 dark:border-slate-700/60 flex flex-col justify-between">
          <div className="flex items-center justify-between text-slate-500 dark:text-slate-400 mb-1">
            <span className="text-xs font-bold font-mono text-slate-800 dark:text-slate-200">
              k_BA
            </span>
            <span className="text-[10px] font-mono text-slate-400">s⁻¹</span>
          </div>
          <div className="text-base font-bold font-mono text-slate-900 dark:text-white my-1">
            {formatUncertainty(kbaVal, kbaErr, { unit: 's⁻¹' }).formatted}
          </div>
          <div className="text-[10px] text-slate-400 flex items-center gap-1 mt-1 border-t border-slate-100 dark:border-slate-700/40 pt-1">
            <ShieldCheck className="w-3 h-3 text-emerald-500" />
            <span>Reverse rate = k_ex × (1 − p_B)</span>
          </div>
        </div>

        {/* tau_B Card */}
        <div className="p-3.5 rounded-xl bg-slate-50/80 dark:bg-slate-800/40 border border-slate-200/70 dark:border-slate-700/60 flex flex-col justify-between">
          <div className="flex items-center justify-between text-slate-500 dark:text-slate-400 mb-1">
            <span className="text-xs font-bold font-mono text-slate-800 dark:text-slate-200">
              τ_B (Lifetime)
            </span>
            <span className="text-[10px] font-mono text-slate-400">ms</span>
          </div>
          <div className="text-base font-bold font-mono text-emerald-600 dark:text-emerald-400 my-1">
            {formatUncertainty(taubVal, taubErr, { unit: 'ms' }).formatted}
          </div>
          <div className="text-[10px] text-slate-400 flex items-center gap-1 mt-1 border-t border-slate-100 dark:border-slate-700/40 pt-1">
            <Clock className="w-3 h-3 text-emerald-500" />
            <span>Lifetime = 1 / k_BA</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DerivedQuantitiesCards;
