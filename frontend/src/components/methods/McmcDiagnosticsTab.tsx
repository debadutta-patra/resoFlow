import React from 'react';
import { AlertCircle } from 'lucide-react';
import { formatUncertainty } from '../../lib/uncertaintyFormatter';
import { parseParameterLabel } from '../../lib/parameterSymbols';

interface McmcDiagnosticsTabProps {
  mcmcData: any;
}

export const McmcDiagnosticsTab: React.FC<McmcDiagnosticsTabProps> = ({ mcmcData }) => {
  if (!mcmcData) return null;

  const diag = mcmcData.diagnostics || {};
  const summary = mcmcData.summary || {};
  const isWithheld = mcmcData.status === 'diagnostics_available_summary_withheld';

  const walkers = diag.walkers || 1;
  const steps = diag.steps || diag.n_steps || 0;
  const discarded = diag.discarded_steps ?? mcmcData.discarded_steps ?? 0;
  const thin = diag.thin || 1;
  const retained = diag.retained_samples || (walkers * Math.max(0, steps - discarded)) / thin;
  const meanAcceptance = diag.acceptance_fraction_mean ?? mcmcData.acceptance_fraction_mean;
  const tauMax = diag.max_autocorrelation_time ?? diag.tau_max;

  return (
    <div className="space-y-4">
      {/* Metric Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="p-3.5 rounded-xl bg-slate-50/80 dark:bg-slate-800/40 border border-slate-200/70 dark:border-slate-700/60">
          <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 block mb-1">
            Chains & Walkers
          </span>
          <span className="text-sm font-bold font-mono text-slate-800 dark:text-slate-200">
            {walkers} walkers × {steps} steps
          </span>
          <span className="text-[10px] text-slate-400 block mt-1">
            Burn-in: {discarded} discarded
          </span>
        </div>

        <div className="p-3.5 rounded-xl bg-slate-50/80 dark:bg-slate-800/40 border border-slate-200/70 dark:border-slate-700/60">
          <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 block mb-1">
            Retained Posterior Draws
          </span>
          <span className="text-sm font-bold font-mono text-indigo-600 dark:text-indigo-400">
            {Number(retained).toLocaleString()}
          </span>
          <span className="text-[10px] text-slate-400 block mt-1">
            Thinning stride: {thin}
          </span>
        </div>

        <div className="p-3.5 rounded-xl bg-slate-50/80 dark:bg-slate-800/40 border border-slate-200/70 dark:border-slate-700/60">
          <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 block mb-1">
            Mean Acceptance Rate
          </span>
          <span className="text-sm font-bold font-mono text-emerald-600 dark:text-emerald-400">
            {meanAcceptance ? `${(meanAcceptance * 100).toFixed(1)}%` : '—'}
          </span>
          <span className="text-[10px] text-slate-400 block mt-1">
            Optimal: 20% – 50%
          </span>
        </div>

        <div className="p-3.5 rounded-xl bg-slate-50/80 dark:bg-slate-800/40 border border-slate-200/70 dark:border-slate-700/60">
          <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 block mb-1">
            Integrated Autocorr (τ)
          </span>
          <span className="text-sm font-bold font-mono text-slate-800 dark:text-slate-200">
            {tauMax ? `${Number(tauMax).toFixed(1)} steps` : 'Calculated'}
          </span>
          <span className="text-[10px] text-slate-400 block mt-1">
            {mcmcData.autocorrelation_status || 'Converged'}
          </span>
        </div>
      </div>

      {/* Diagnostics Warning if Withheld */}
      {isWithheld && (
        <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/60 text-amber-800 dark:text-amber-300 text-xs flex items-start gap-2.5">
          <AlertCircle className="w-4 h-4 shrink-0 text-amber-500 mt-0.5" />
          <div>
            <span className="font-bold">Chain Length Recommendation:</span>{' '}
            The MCMC chain length is shorter than 50 times the estimated integrated autocorrelation time (N &lt; 50τ). For authoritative publication intervals, consider increasing total steps.
          </div>
        </div>
      )}

      {/* Per-Parameter Posterior Convergence Table */}
      {Object.keys(summary).length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
            Parameter Posterior Convergence & Priors
          </h4>
          <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
            <table className="w-full text-left text-xs border-collapse font-mono">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-800/80 text-slate-500 dark:text-slate-400 font-semibold border-b border-slate-200 dark:border-slate-800">
                  <th className="py-2 px-3">Parameter</th>
                  <th className="py-2 px-3">Prior</th>
                  <th className="py-2 px-3">Prior Bounds</th>
                  <th className="py-2 px-3">MCSE (Mean)</th>
                  <th className="py-2 px-3">Effective Sample Size (ESS)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                {Object.entries(summary).map(([paramName, pData]: [string, any]) => {
                  const parsed = parseParameterLabel(paramName);
                  return (
                    <tr key={paramName} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30">
                      <td className="py-2 px-3 font-bold text-slate-900 dark:text-white">
                        {parsed.displaySymbol}
                      </td>
                      <td className="py-2 px-3 text-slate-600 dark:text-slate-400 capitalize">
                        {pData.prior || 'Uniform'}
                      </td>
                      <td className="py-2 px-3 text-slate-600 dark:text-slate-400">
                        {pData.prior_lower !== undefined && pData.prior_upper !== undefined
                          ? `[${pData.prior_lower}, ${pData.prior_upper}]`
                          : 'Unbounded'}
                      </td>
                      <td className="py-2 px-3 text-slate-600 dark:text-slate-300">
                        {pData.mcse_mean !== undefined && pData.mcse_mean !== null
                          ? formatUncertainty(pData.mcse_mean).formatted
                          : '—'}
                      </td>
                      <td className="py-2 px-3 text-slate-800 dark:text-slate-200 font-semibold">
                        {pData.effective_sample_size !== undefined && pData.effective_sample_size !== null
                          ? Math.round(pData.effective_sample_size).toLocaleString()
                          : isWithheld
                          ? <span className="text-amber-500 italic">Withheld (N &lt; 50τ)</span>
                          : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

export default McmcDiagnosticsTab;
