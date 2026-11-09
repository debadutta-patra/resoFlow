/**
 * ChemEx v2 STATISTICS for one method step: MC, BS, BSN (replicates + optional
 * SEED) and MCMC (STEPS, optional BURN, optional SEED). Written in the compact
 * `STATISTICS = { … }` form unless a seed or BURN is set (then expanded tables).
 */

import React, { useState } from 'react';
import { Activity, ChevronDown, ChevronUp, Dices, Flame, Info } from 'lucide-react';
import type { McmcConfig, ResamplingConfig, StatisticsConfig, Step } from '../../lib/methodConfig';
import { compactStatistics } from '../../lib/methodToml';
import { randomSeed, seedError, toSeed } from '../../lib/seed';
import { estimateStatistics, formatDuration, type StepTiming } from '../../lib/searchEstimate';

interface StepStatisticsSectionProps {
  step: Step;
  onChange: (updatedStep: Step) => void;
  readOnly?: boolean;
  /** Last run's per-step durations, for the cost estimate. */
  timings?: StepTiming[];
  /** Workers the last run used (ChemEx-resolved). */
  workers?: number | null;
}

type ResamplingKey = 'mc' | 'bs' | 'bsn';

const RESAMPLING: Array<{ key: ResamplingKey; code: string; title: string; hint: string; accent: string; on: string }> = [
  { key: 'mc', code: 'MC', title: 'Monte Carlo', hint: 'Synthetic noise added to the profiles, then refit', accent: 'text-blue-600 dark:text-blue-400', on: 'bg-blue-50/40 dark:bg-blue-950/20 border-blue-200 dark:border-blue-800/80' },
  { key: 'bs', code: 'BS', title: 'Bootstrap', hint: 'Points resampled with replacement within each profile, then refit', accent: 'text-emerald-600 dark:text-emerald-400', on: 'bg-emerald-50/40 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800/80' },
  { key: 'bsn', code: 'BSN', title: 'Nucleus bootstrap', hint: 'Profiles resampled grouped by nucleus, then refit', accent: 'text-amber-600 dark:text-amber-400', on: 'bg-amber-50/40 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800/80' },
];

const OFF = 'bg-slate-50/50 dark:bg-slate-800/30 border-slate-200/70 dark:border-slate-800';
const fieldCls =
  'px-2 py-1 font-mono text-[11px] rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white outline-none focus:border-blue-500 disabled:opacity-60';
const SEED_PLACEHOLDER = 'ChemEx generates and records one';

const SeedField: React.FC<{ id: string; value?: string; onChange: (v: string | undefined) => void; readOnly: boolean }> = ({ id, value, onChange, readOnly }) => {
  const err = seedError(value);
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-slate-600 dark:text-slate-400 font-medium">
          Seed <span className="font-normal text-slate-400">(optional)</span>
        </label>
        <div className="flex items-center gap-1">
          <input
            id={id}
            type="text"
            inputMode="numeric"
            placeholder={SEED_PLACEHOLDER}
            value={value ?? ''}
            onChange={e => onChange(toSeed(e.target.value))}
            disabled={readOnly}
            className={`${fieldCls} w-56 ${err ? 'border-red-400 dark:border-red-500' : ''}`}
          />
          <button type="button" disabled={readOnly} onClick={() => onChange(randomSeed())} className="p-1 text-slate-400 hover:text-blue-500 rounded disabled:opacity-40" title="Draw a random 64-bit seed" aria-label={`Random seed for ${id}`}>
            <Dices className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      {err && <p className="text-[11px] text-red-600 dark:text-red-400 text-right">{err}</p>}
    </div>
  );
};

export const StepStatisticsSection: React.FC<StepStatisticsSectionProps> = ({ step, onChange, readOnly = false, timings, workers }) => {
  const stats: StatisticsConfig = step.statistics || {};
  const anyActive = !!(stats.mc?.enabled || stats.bs?.enabled || stats.bsn?.enabled || stats.mcmc?.enabled);
  const [isOpen, setIsOpen] = useState(anyActive);
  const isGrid = !!step.search && step.search.mode === 'grid' && step.search.axes.length > 0;

  const updateStats = (next: StatisticsConfig) => !readOnly && onChange({ ...step, statistics: next });

  const toggleResampling = (key: ResamplingKey) => {
    const cur = stats[key];
    updateStats({ ...stats, [key]: { enabled: !cur?.enabled, replicates: cur?.replicates && cur.replicates > 0 ? cur.replicates : 100, seed: cur?.seed } });
  };
  const patchResampling = (key: ResamplingKey, patch: Partial<ResamplingConfig>) =>
    updateStats({ ...stats, [key]: { ...(stats[key] || { enabled: true, replicates: 100 }), ...patch } });

  const toggleMcmc = () => {
    const cur = stats.mcmc;
    updateStats({ ...stats, mcmc: { ...cur, enabled: !cur?.enabled, steps: cur?.steps && cur.steps > 0 ? cur.steps : 5000, burn: cur?.burn ?? 'auto', seed: cur?.seed } });
  };
  const patchMcmc = (patch: Partial<McmcConfig>) => updateStats({ ...stats, mcmc: { ...(stats.mcmc || { enabled: true, steps: 5000, burn: 'auto' as const }), ...patch } });

  const estimate = estimateStatistics(stats, step.name, timings, workers);
  const compact = compactStatistics(stats);
  const highCost = estimate.refits > 200;
  const totalSeconds = (estimate.resamplingSeconds ?? 0) + (estimate.mcmcSeconds ?? 0);
  const m = stats.mcmc;
  const burnError =
    m?.enabled && m.burn !== 'auto' && typeof m.burn === 'number' && (!Number.isInteger(m.burn) || m.burn < 0 || m.burn >= m.steps)
      ? 'BURN must be a non-negative integer smaller than STEPS.'
      : null;

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-sm transition-colors">
      <div className="p-3.5 bg-slate-50/80 dark:bg-slate-800/60 flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          aria-expanded={isOpen}
          className="flex items-center gap-2 text-xs font-bold text-slate-700 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
        >
          {isOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          <Activity className="w-4 h-4 text-purple-500" />
          <span>Statistics (MC, BS, BSN, MCMC)</span>
          {anyActive && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-100 dark:bg-purple-900/60 text-purple-700 dark:text-purple-300 font-mono font-bold">
              {[stats.mc?.enabled && 'MC', stats.bs?.enabled && 'BS', stats.bsn?.enabled && 'BSN', stats.mcmc?.enabled && 'MCMC'].filter(Boolean).join(' + ')}
            </span>
          )}
        </button>

        {(estimate.refits > 0 || estimate.mcmcSeconds) && (
          <div
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold border ${
              highCost ? 'bg-amber-500/10 border-amber-500/30 text-amber-600 dark:text-amber-400' : 'bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
            }`}
            title="Every MC/BS/BSN replicate is one full refit of this step"
          >
            <Flame className={`w-3.5 h-3.5 ${highCost ? 'text-amber-500' : 'text-slate-400'}`} />
            <span>
              {estimate.refits > 0 && `${estimate.refits} refits`}
              {totalSeconds > 0 && ` ≈ ${formatDuration(totalSeconds)}`}
            </span>
          </div>
        )}
      </div>

      {isOpen && (
        <div className="p-4 space-y-3 text-xs">
          <p className="text-slate-500 dark:text-slate-400 leading-relaxed">
            Statistics run once after <span className="font-mono font-bold text-slate-700 dark:text-slate-300">{step.name}</span>'s deterministic fit is
            committed and never change its central values. Walkers and parallelism are ChemEx policy (set workers globally with{' '}
            <code className="font-mono">chemex fit --workers</code>).
          </p>

          <div className="flex items-start gap-2 p-2.5 rounded-lg border border-sky-200 dark:border-sky-800 bg-sky-50/60 dark:bg-sky-950/30 text-sky-800 dark:text-sky-200">
            <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            <div className="space-y-1 leading-relaxed">
              <p>MC, BS and BSN write their summaries only if every replicate succeeds; MCMC withholds authoritative summaries from an incomplete chain.</p>
              {isGrid && (
                <p>
                  This is a <strong>GRID</strong> step: statistics start from the accepted grid state, and ChemEx withholds covariance errors here — add a
                  following TRF step for local covariance uncertainties.
                </p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {RESAMPLING.map(({ key, code, title, hint, accent, on }) => {
              const conf = stats[key];
              const id = `${key}-${step.id}`;
              return (
                <div key={key} className={`p-3 rounded-xl border transition-all ${conf?.enabled ? `${on} shadow-sm` : `${OFF} opacity-80`}`}>
                  <div className="flex items-center justify-between mb-2">
                    <label className="flex items-center gap-2 font-bold text-slate-800 dark:text-slate-200 cursor-pointer">
                      <input type="checkbox" checked={!!conf?.enabled} onChange={() => toggleResampling(key)} disabled={readOnly} className="w-4 h-4 rounded" />
                      {title} (<span className={`font-mono ${accent}`}>{code}</span>)
                    </label>
                    <span className="text-[10px] text-slate-400 dark:text-slate-500 text-right max-w-[45%]">{hint}</span>
                  </div>
                  {conf?.enabled && (
                    <div className="space-y-2 pt-2 border-t border-slate-200/60 dark:border-slate-800/60">
                      <div className="flex items-center justify-between gap-2">
                        <label htmlFor={`${id}-reps`} className="text-slate-600 dark:text-slate-400 font-medium">
                          Replicates
                        </label>
                        <input
                          id={`${id}-reps`}
                          type="number"
                          min={1}
                          step={1}
                          value={conf.replicates ?? 100}
                          onChange={e => patchResampling(key, { replicates: parseInt(e.target.value, 10) || 0 })}
                          disabled={readOnly}
                          className={`${fieldCls} w-24`}
                        />
                      </div>
                      <SeedField id={`${id}-seed`} value={conf.seed} onChange={seed => patchResampling(key, { seed })} readOnly={readOnly} />
                    </div>
                  )}
                </div>
              );
            })}

            <div className={`p-3 rounded-xl border transition-all ${m?.enabled ? 'bg-purple-50/40 dark:bg-purple-950/20 border-purple-200 dark:border-purple-800/80 shadow-sm' : `${OFF} opacity-80`}`}>
              <div className="flex items-center justify-between mb-2">
                <label className="flex items-center gap-2 font-bold text-slate-800 dark:text-slate-200 cursor-pointer">
                  <input type="checkbox" checked={!!m?.enabled} onChange={toggleMcmc} disabled={readOnly} className="w-4 h-4 rounded" />
                  MCMC posterior (<span className="font-mono text-purple-600 dark:text-purple-400">MCMC</span>)
                </label>
                <span className="text-[10px] text-slate-400 dark:text-slate-500">Ensemble sampler</span>
              </div>
              {m?.enabled && (
                <div className="space-y-2 pt-2 border-t border-slate-200/60 dark:border-slate-800/60">
                  <div className="flex items-center justify-between gap-2">
                    <label htmlFor={`mcmc-steps-${step.id}`} className="text-slate-600 dark:text-slate-400 font-medium">
                      STEPS
                    </label>
                    <input
                      id={`mcmc-steps-${step.id}`}
                      type="number"
                      min={1}
                      step={500}
                      value={m.steps ?? 5000}
                      onChange={e => patchMcmc({ steps: parseInt(e.target.value, 10) || 0 })}
                      disabled={readOnly}
                      className={`${fieldCls} w-24`}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <label htmlFor={`mcmc-burn-${step.id}`} className="text-slate-600 dark:text-slate-400 font-medium">
                      BURN <span className="font-normal text-slate-400">(optional)</span>
                    </label>
                    <input
                      id={`mcmc-burn-${step.id}`}
                      type="number"
                      min={0}
                      step={1}
                      placeholder="auto (ceil(2·τ_max))"
                      value={m.burn === 'auto' ? '' : m.burn}
                      onChange={e => patchMcmc({ burn: e.target.value.trim() === '' ? 'auto' : parseInt(e.target.value, 10) })}
                      disabled={readOnly}
                      className={`${fieldCls} w-44 ${burnError ? 'border-red-400 dark:border-red-500' : ''}`}
                    />
                  </div>
                  {burnError && <p className="text-[11px] text-red-600 dark:text-red-400 text-right">{burnError}</p>}
                  <SeedField id={`mcmc-seed-${step.id}`} value={m.seed} onChange={seed => patchMcmc({ seed })} readOnly={readOnly} />

                  {((m.thin && m.thin > 1) || m.walkers || m.workers || m.update_parameters) && (
                    <div className="pt-2 mt-1 border-t border-slate-200 dark:border-slate-700/60 text-[10px] space-y-1 text-amber-600 dark:text-amber-400">
                      <div className="flex items-center justify-between font-semibold uppercase tracking-wider">
                        <span>Legacy v1 settings (ignored by ChemEx v2)</span>
                        {!readOnly && (
                          <button type="button" className="normal-case underline" onClick={() => patchMcmc({ thin: undefined, walkers: undefined, workers: undefined, update_parameters: undefined })}>
                            clear
                          </button>
                        )}
                      </div>
                      {m.thin && m.thin > 1 && <div>Thinning: {m.thin}</div>}
                      {m.walkers && <div>Walkers: {m.walkers}</div>}
                      {m.workers && <div>Workers: {m.workers}</div>}
                      {m.update_parameters && <div>Update parameters: enabled</div>}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {anyActive && (
            <div className="space-y-1 text-[11px] text-slate-500 dark:text-slate-400">
              <p>
                {estimate.refits > 0 && (
                  <>
                    {(['mc', 'bs', 'bsn'] as const)
                      .filter(k => stats[k]?.enabled)
                      .map(k => `${k.toUpperCase()} ${stats[k]!.replicates}`)
                      .join(' + ')}{' '}
                    = {estimate.refits} full refits
                    {estimate.resamplingSeconds !== null && estimate.secondsPerFit !== null ? (
                      <>
                        {' '}≈ <strong>{formatDuration(estimate.resamplingSeconds)}</strong> with {estimate.workers ?? 1} worker{(estimate.workers ?? 1) === 1 ? '' : 's'} (
                        {estimate.proxy ? `rough, using last run's ${estimate.basedOn}` : `last run's ${estimate.basedOn}`}: {estimate.secondsPerFit.toFixed(2)} s per fit
                        {estimate.workers === null ? '; worker count unknown, assumed 1' : ''})
                      </>
                    ) : (
                      ' — a time estimate appears after a run (it uses that run’s step timing).'
                    )}
                  </>
                )}
                {estimate.mcmcSeconds !== null && <> MCMC ≈ {formatDuration(estimate.mcmcSeconds)} (scaled from the last run’s chain on this step).</>}
              </p>
              <p className="font-mono">
                {compact ? `Written as STATISTICS = { ${compact} }` : `Written as expanded [${step.name}.STATISTICS.…] tables (a seed or BURN is set)`}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default StepStatisticsSection;
