import React from 'react';
import { Layers, Zap, Clock, ShieldCheck, Activity, BarChart2 } from 'lucide-react';
import { formatUncertainty } from '../../lib/uncertaintyFormatter';
import { ppmToHz } from '../../lib/parameterSymbols';

interface DerivedQuantitiesCardsProps {
  summary?: Record<string, any>;
  methodName?: string;
}

export const DerivedQuantitiesCards: React.FC<DerivedQuantitiesCardsProps> = ({
  summary = {},
  methodName,
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

  const hasExchange = Boolean(kexStat || pbStat || kabStat || kbaStat);

  // If exchange parameters exist (CPMG / CEST)
  if (hasExchange) {
    const kexVal = kexStat?.median ?? kexStat?.mean;
    const kexErr = kexStat?.standard_deviation ?? kexStat?.std_dev ?? kexStat?.std;

    const pbVal = pbStat?.median ?? pbStat?.mean;
    const pbErr = pbStat?.standard_deviation ?? pbStat?.std_dev ?? pbStat?.std;

    // Propagated derived values if not directly present in summary
    const kabVal = kabStat
      ? kabStat.median ?? kabStat.mean
      : kexVal !== undefined && pbVal !== undefined
      ? kexVal * pbVal
      : undefined;
    const kabErr = kabStat
      ? kabStat.standard_deviation ?? kabStat.std_dev ?? kabStat.std
      : kexVal && pbVal && kexErr && pbErr
      ? Math.sqrt(Math.pow(pbVal * kexErr, 2) + Math.pow(kexVal * pbErr, 2))
      : undefined;

    const kbaVal = kbaStat
      ? kbaStat.median ?? kbaStat.mean
      : kexVal !== undefined && pbVal !== undefined
      ? kexVal * (1.0 - pbVal)
      : undefined;
    const kbaErr = kbaStat
      ? kbaStat.standard_deviation ?? kbaStat.std_dev ?? kbaStat.std
      : kexVal && pbVal && kexErr && pbErr
      ? Math.sqrt(Math.pow((1.0 - pbVal) * kexErr, 2) + Math.pow(kexVal * pbErr, 2))
      : undefined;

    const taubVal = taubStat
      ? taubStat.median ?? taubStat.mean
      : kbaVal && kbaVal > 0
      ? (1.0 / kbaVal) * 1000.0
      : undefined;
    const taubErr = taubStat
      ? taubStat.standard_deviation ?? taubStat.std_dev ?? taubStat.std
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
          regimeBadgeClass =
            'bg-blue-100 text-blue-800 dark:bg-blue-950/70 dark:text-blue-300 border border-blue-300 dark:border-blue-800';
          regimeDesc = `α = k_ex / |Δω| = ${alpha.toFixed(2)} (< 0.5). Peaks remain distinctly separated.`;
        } else if (alpha <= 2.0) {
          regimeLabel = 'Intermediate Exchange';
          regimeBadgeClass =
            'bg-amber-100 text-amber-800 dark:bg-amber-950/70 dark:text-amber-300 border border-amber-300 dark:border-amber-800';
          regimeDesc = `α = k_ex / |Δω| = ${alpha.toFixed(2)} (0.5 – 2.0). Broadened coalescence regime.`;
        } else {
          regimeLabel = 'Fast Exchange';
          regimeBadgeClass =
            'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-800';
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
  }

  // If NO exchange is being estimated, check for relaxation rates (R1, R2, hetNOE)
  const rateEntries = Object.entries(summary).filter(([key]) => {
    const clean = key.trim().replace(/^\[|\]$/g, '').toUpperCase();
    const parts = clean.split(',').map(s => s.trim());
    const base = parts[0];
    return (
      base === 'R1' ||
      base === 'R2' ||
      base === 'HETNOE' ||
      base === 'NOE' ||
      base === 'R1_A' ||
      base === 'R2_A' ||
      base === 'R1RHO' ||
      base.startsWith('R1_') ||
      base.startsWith('R2_')
    );
  });

  if (rateEntries.length === 0) {
    return null;
  }

  // Detect relaxation experiment type
  const firstBase = rateEntries[0][0].trim().replace(/^\[|\]$/g, '').toUpperCase().split(',')[0].trim();
  const isHetnoe = firstBase === 'HETNOE' || firstBase === 'NOE';
  const isR1 = firstBase.startsWith('R1');
  const isR2 = firstBase.startsWith('R2');

  const expTitle = isHetnoe
    ? 'Steady-State hetNOE Ratio'
    : isR1
    ? 'R₁ Longitudinal Relaxation'
    : isR2
    ? 'R₂ Transverse Relaxation'
    : 'Relaxation Rates';
  const symbol = isHetnoe ? 'NOE' : isR1 ? 'R₁' : isR2 ? 'R₂' : 'Rate';
  const unit = isHetnoe ? '' : 's⁻¹';

  const rateVals: number[] = [];
  const errVals: number[] = [];
  for (const [, pData] of rateEntries) {
    const v = pData.median ?? pData.mean ?? pData.deterministic_value;
    const e = pData.standard_deviation ?? pData.std_dev ?? pData.std ?? pData.stderr;
    if (typeof v === 'number' && !isNaN(v)) rateVals.push(v);
    if (typeof e === 'number' && !isNaN(e)) errVals.push(e);
  }

  const count = rateVals.length;
  if (count === 0) return null;

  const meanRate = rateVals.reduce((a, b) => a + b, 0) / count;
  const sdRate =
    count > 1
      ? Math.sqrt(rateVals.reduce((acc, v) => acc + Math.pow(v - meanRate, 2), 0) / (count - 1))
      : 0;

  const sortedRates = [...rateVals].sort((a, b) => a - b);
  const medianRate =
    count % 2 === 0
      ? (sortedRates[count / 2 - 1] + sortedRates[count / 2]) / 2
      : sortedRates[Math.floor(count / 2)];

  const minRate = sortedRates[0];
  const maxRate = sortedRates[count - 1];

  const meanErr = errVals.length > 0 ? errVals.reduce((a, b) => a + b, 0) / errVals.length : 0;
  const relErrPct = meanRate !== 0 ? (meanErr / Math.abs(meanRate)) * 100 : 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider flex items-center gap-2">
          <BarChart2 className="w-4 h-4 text-indigo-500" />
          <span>{expTitle} Summary & Statistics</span>
          <span className="text-[10px] font-mono font-medium px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
            {methodName || 'Uncertainty'} Propagation
          </span>
        </h4>

        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500 font-medium">Sequence Overview:</span>
          <span className="px-2.5 py-0.5 rounded-md text-xs font-bold bg-indigo-100 text-indigo-800 dark:bg-indigo-950/70 dark:text-indigo-300 border border-indigo-300 dark:border-indigo-800">
            {count} Residues Analyzed
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        {/* Mean Rate Card */}
        <div className="p-3.5 rounded-xl bg-slate-50/80 dark:bg-slate-800/40 border border-slate-200/70 dark:border-slate-700/60 flex flex-col justify-between">
          <div className="flex items-center justify-between text-slate-500 dark:text-slate-400 mb-1">
            <span className="text-xs font-bold font-mono text-slate-800 dark:text-slate-200">
              Mean {symbol} (⟨{symbol}⟩)
            </span>
            <span className="text-[10px] font-mono text-slate-400">{unit || 'ratio'}</span>
          </div>
          <div className="text-base font-bold font-mono text-slate-900 dark:text-white my-1">
            {meanRate.toFixed(3)}
            <span className="text-xs text-slate-400 font-normal"> ± {sdRate.toFixed(3)}</span>
          </div>
          <div className="text-[10px] text-slate-400 flex items-center gap-1 mt-1 border-t border-slate-100 dark:border-slate-700/40 pt-1">
            <Activity className="w-3 h-3 text-indigo-500" />
            <span>Sequence SD across {count} residues</span>
          </div>
        </div>

        {/* Median Rate Card */}
        <div className="p-3.5 rounded-xl bg-slate-50/80 dark:bg-slate-800/40 border border-slate-200/70 dark:border-slate-700/60 flex flex-col justify-between">
          <div className="flex items-center justify-between text-slate-500 dark:text-slate-400 mb-1">
            <span className="text-xs font-bold font-mono text-slate-800 dark:text-slate-200">
              Median {symbol}
            </span>
            <span className="text-[10px] font-mono text-slate-400">{unit || 'ratio'}</span>
          </div>
          <div className="text-base font-bold font-mono text-indigo-600 dark:text-indigo-400 my-1">
            {medianRate.toFixed(3)} {unit}
          </div>
          <div className="text-[10px] text-slate-400 flex items-center gap-1 mt-1 border-t border-slate-100 dark:border-slate-700/40 pt-1">
            <Zap className="w-3 h-3 text-emerald-500" />
            <span>50th percentile across sequence</span>
          </div>
        </div>

        {/* Mean Uncertainty Card */}
        <div className="p-3.5 rounded-xl bg-slate-50/80 dark:bg-slate-800/40 border border-slate-200/70 dark:border-slate-700/60 flex flex-col justify-between">
          <div className="flex items-center justify-between text-slate-500 dark:text-slate-400 mb-1">
            <span className="text-xs font-bold font-mono text-slate-800 dark:text-slate-200">
              Mean Uncertainty (⟨σ⟩)
            </span>
            <span className="text-[10px] font-mono text-slate-400">{unit || 'ratio'}</span>
          </div>
          <div className="text-base font-bold font-mono text-slate-900 dark:text-white my-1">
            ±{meanErr.toFixed(4)} {unit}
          </div>
          <div className="text-[10px] text-slate-400 flex items-center gap-1 mt-1 border-t border-slate-100 dark:border-slate-700/40 pt-1">
            <ShieldCheck className="w-3 h-3 text-indigo-500" />
            <span>Avg {methodName || 'sampling'} error ({relErrPct.toFixed(1)}% rel)</span>
          </div>
        </div>

        {/* Range Card */}
        <div className="p-3.5 rounded-xl bg-slate-50/80 dark:bg-slate-800/40 border border-slate-200/70 dark:border-slate-700/60 flex flex-col justify-between">
          <div className="flex items-center justify-between text-slate-500 dark:text-slate-400 mb-1">
            <span className="text-xs font-bold font-mono text-slate-800 dark:text-slate-200">
              {symbol} Range (Min – Max)
            </span>
            <span className="text-[10px] font-mono text-slate-400">{unit || 'ratio'}</span>
          </div>
          <div className="text-sm font-bold font-mono text-purple-600 dark:text-purple-400 my-1 truncate">
            [{minRate.toFixed(2)}, {maxRate.toFixed(2)}] {unit}
          </div>
          <div className="text-[10px] text-slate-400 flex items-center gap-1 mt-1 border-t border-slate-100 dark:border-slate-700/40 pt-1">
            <Layers className="w-3 h-3 text-purple-500" />
            <span>Dynamic range across sequence</span>
          </div>
        </div>

        {/* Fitted Residues Card */}
        <div className="p-3.5 rounded-xl bg-slate-50/80 dark:bg-slate-800/40 border border-slate-200/70 dark:border-slate-700/60 flex flex-col justify-between">
          <div className="flex items-center justify-between text-slate-500 dark:text-slate-400 mb-1">
            <span className="text-xs font-bold font-mono text-slate-800 dark:text-slate-200">
              Fitted Residues
            </span>
            <span className="text-[10px] font-mono text-slate-400">count</span>
          </div>
          <div className="text-base font-bold font-mono text-emerald-600 dark:text-emerald-400 my-1">
            {count}
          </div>
          <div className="text-[10px] text-slate-400 flex items-center gap-1 mt-1 border-t border-slate-100 dark:border-slate-700/40 pt-1">
            <Clock className="w-3 h-3 text-emerald-500" />
            <span>Converged fits in dataset</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DerivedQuantitiesCards;
