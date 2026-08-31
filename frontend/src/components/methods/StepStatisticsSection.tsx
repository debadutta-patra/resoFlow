import React, { useState } from 'react';
import type { Step, StatisticsConfig, ResamplingConfig, McmcConfig } from '../../lib/methodConfig';
import {
  Activity,
  ChevronDown,
  ChevronUp,
  Dices,
  Flame,
  Settings2,
} from 'lucide-react';

interface StepStatisticsSectionProps {
  step: Step;
  onChange: (updatedStep: Step) => void;
  readOnly?: boolean;
}

export const StepStatisticsSection: React.FC<StepStatisticsSectionProps> = ({
  step,
  onChange,
  readOnly = false,
}) => {
  const stats: StatisticsConfig = step.statistics || {};
  const [isOpen, setIsOpen] = useState(false);
  const [showAdvancedMcmc, setShowAdvancedMcmc] = useState(false);

  const updateStats = (newStats: StatisticsConfig) => {
    onChange({
      ...step,
      statistics: newStats,
    });
  };

  const handleToggleResampling = (key: 'mc' | 'bs' | 'bsn') => {
    if (readOnly) return;
    const current = stats[key];
    const isNowEnabled = !current?.enabled;
    updateStats({
      ...stats,
      [key]: {
        enabled: isNowEnabled,
        replicates: current?.replicates && current.replicates > 0 ? current.replicates : 100,
        seed: current?.seed,
      },
    });
  };

  const handleUpdateResampling = (key: 'mc' | 'bs' | 'bsn', field: keyof ResamplingConfig, value: any) => {
    if (readOnly) return;
    const current = stats[key] || { enabled: true, replicates: 100 };
    updateStats({
      ...stats,
      [key]: {
        ...current,
        [field]: value,
      },
    });
  };

  const handleToggleMcmc = () => {
    if (readOnly) return;
    const current = stats.mcmc;
    const isNowEnabled = !current?.enabled;
    updateStats({
      ...stats,
      mcmc: {
        enabled: isNowEnabled,
        steps: current?.steps && current.steps > 0 ? current.steps : 5000,
        burn: current?.burn !== undefined ? current.burn : 'auto',
        thin: current?.thin && current.thin > 0 ? current.thin : 1,
        walkers: current?.walkers,
        seed: current?.seed,
        workers: current?.workers,
        update_parameters: current?.update_parameters || false,
      },
    });
  };

  const handleUpdateMcmc = (field: keyof McmcConfig, value: any) => {
    if (readOnly) return;
    const current = stats.mcmc || { enabled: true, steps: 5000, burn: 'auto', thin: 1 };
    updateStats({
      ...stats,
      mcmc: {
        ...current,
        [field]: value,
      },
    });
  };

  const generateRandomSeed = () => Math.floor(Math.random() * 1000000) + 1;

  // Calculate live cost estimates
  const mcReps = stats.mc?.enabled ? Number(stats.mc.replicates || 0) : 0;
  const bsReps = stats.bs?.enabled ? Number(stats.bs.replicates || 0) : 0;
  const bsnReps = stats.bsn?.enabled ? Number(stats.bsn.replicates || 0) : 0;
  const totalRefits = mcReps + bsReps + bsnReps;
  const isHighRefits = totalRefits > 200;

  const anyActive = !!(stats.mc?.enabled || stats.bs?.enabled || stats.bsn?.enabled || stats.mcmc?.enabled);

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-sm transition-colors">
      {/* Header / Accordion trigger */}
      <div className="p-3.5 bg-slate-50/80 dark:bg-slate-800/60 flex items-center justify-between">
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center gap-2 text-xs font-bold text-slate-700 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
        >
          {isOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          <Activity className="w-4 h-4 text-purple-500" />
          <span>Error Analysis & Statistics (Monte Carlo, Bootstrap, MCMC)</span>
          {anyActive && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-100 dark:bg-purple-900/60 text-purple-700 dark:text-purple-300 font-mono font-bold">
              Active
            </span>
          )}
        </button>

        {/* Live Cost Badge */}
        {totalRefits > 0 && (
          <div
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold border ${
              isHighRefits
                ? 'bg-amber-500/10 border-amber-500/30 text-amber-600 dark:text-amber-400 animate-pulse'
                : 'bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
            }`}
            title="Estimated computing workload based on configured synthetic replicates"
          >
            <Flame className={`w-3.5 h-3.5 ${isHighRefits ? 'text-amber-500' : 'text-slate-400'}`} />
            <span>Cost: {totalRefits} full refits</span>
          </div>
        )}
      </div>

      {/* Body */}
      {isOpen && (
        <div className="p-4 space-y-4 text-xs">
          <p className="text-slate-500 dark:text-slate-400 leading-relaxed">
            Configure uncertainty estimation methods for step{' '}
            <span className="font-mono font-bold text-slate-700 dark:text-slate-300">{step.name}</span>.
            Statistics run after the deterministic fit converges and provide robust confidence intervals and posterior distributions.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            {/* 1. Monte Carlo (MC) */}
            <div
              className={`p-3.5 rounded-xl border transition-all ${
                stats.mc?.enabled
                  ? 'bg-blue-50/40 dark:bg-blue-950/20 border-blue-200 dark:border-blue-800/80 shadow-sm'
                  : 'bg-slate-50/50 dark:bg-slate-800/30 border-slate-200/70 dark:border-slate-800 opacity-80'
              }`}
            >
              <div className="flex items-center justify-between mb-2.5">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id={`mc-toggle-${step.id}`}
                    checked={!!stats.mc?.enabled}
                    onChange={() => handleToggleResampling('mc')}
                    disabled={readOnly}
                    className="w-4 h-4 rounded text-blue-600 focus:ring-blue-500 dark:focus:ring-blue-600 dark:bg-slate-800 border-slate-300 dark:border-slate-700 cursor-pointer"
                  />
                  <label htmlFor={`mc-toggle-${step.id}`} className="font-bold text-slate-800 dark:text-slate-200 cursor-pointer">
                    Monte Carlo (<span className="font-mono text-blue-600 dark:text-blue-400">MC</span>)
                  </label>
                </div>
                <span className="text-[10px] text-slate-400 dark:text-slate-500" title="Adds Gaussian synthetic noise to profiles and refits">
                  Synthetic Noise
                </span>
              </div>

              {stats.mc?.enabled && (
                <div className="space-y-2.5 pt-1 border-t border-slate-200/60 dark:border-slate-800/60">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-slate-600 dark:text-slate-400 font-medium">Replicates:</label>
                    <input
                      type="number"
                      min={1}
                      max={10000}
                      value={stats.mc.replicates ?? 100}
                      onChange={e => handleUpdateResampling('mc', 'replicates', parseInt(e.target.value, 10) || 0)}
                      disabled={readOnly}
                      className="w-24 px-2 py-1 font-mono rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white outline-none focus:border-blue-500"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-slate-600 dark:text-slate-400 font-medium">Seed (opt):</label>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        placeholder="None"
                        value={stats.mc.seed ?? ''}
                        onChange={e => handleUpdateResampling('mc', 'seed', e.target.value ? parseInt(e.target.value, 10) : undefined)}
                        disabled={readOnly}
                        className="w-20 px-2 py-1 font-mono text-[11px] rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => handleUpdateResampling('mc', 'seed', generateRandomSeed())}
                        className="p-1 text-slate-400 hover:text-blue-500 hover:bg-slate-100 dark:hover:bg-slate-800 rounded"
                        title="Generate random seed"
                      >
                        <Dices className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* 2. Bootstrap (BS) */}
            <div
              className={`p-3.5 rounded-xl border transition-all ${
                stats.bs?.enabled
                  ? 'bg-emerald-50/40 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800/80 shadow-sm'
                  : 'bg-slate-50/50 dark:bg-slate-800/30 border-slate-200/70 dark:border-slate-800 opacity-80'
              }`}
            >
              <div className="flex items-center justify-between mb-2.5">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id={`bs-toggle-${step.id}`}
                    checked={!!stats.bs?.enabled}
                    onChange={() => handleToggleResampling('bs')}
                    disabled={readOnly}
                    className="w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500 dark:focus:ring-emerald-600 dark:bg-slate-800 border-slate-300 dark:border-slate-700 cursor-pointer"
                  />
                  <label htmlFor={`bs-toggle-${step.id}`} className="font-bold text-slate-800 dark:text-slate-200 cursor-pointer">
                    Bootstrap (<span className="font-mono text-emerald-600 dark:text-emerald-400">BS</span>)
                  </label>
                </div>
                <span className="text-[10px] text-slate-400 dark:text-slate-500" title="Resamples points with replacement within each profile">
                  Resample Points
                </span>
              </div>

              {stats.bs?.enabled && (
                <div className="space-y-2.5 pt-1 border-t border-slate-200/60 dark:border-slate-800/60">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-slate-600 dark:text-slate-400 font-medium">Replicates:</label>
                    <input
                      type="number"
                      min={1}
                      max={10000}
                      value={stats.bs.replicates ?? 100}
                      onChange={e => handleUpdateResampling('bs', 'replicates', parseInt(e.target.value, 10) || 0)}
                      disabled={readOnly}
                      className="w-24 px-2 py-1 font-mono rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white outline-none focus:border-emerald-500"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-slate-600 dark:text-slate-400 font-medium">Seed (opt):</label>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        placeholder="None"
                        value={stats.bs.seed ?? ''}
                        onChange={e => handleUpdateResampling('bs', 'seed', e.target.value ? parseInt(e.target.value, 10) : undefined)}
                        disabled={readOnly}
                        className="w-20 px-2 py-1 font-mono text-[11px] rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => handleUpdateResampling('bs', 'seed', generateRandomSeed())}
                        className="p-1 text-slate-400 hover:text-emerald-500 hover:bg-slate-100 dark:hover:bg-slate-800 rounded"
                        title="Generate random seed"
                      >
                        <Dices className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* 3. Nucleus-Specific Bootstrap (BSN) */}
            <div
              className={`p-3.5 rounded-xl border transition-all ${
                stats.bsn?.enabled
                  ? 'bg-amber-50/40 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800/80 shadow-sm'
                  : 'bg-slate-50/50 dark:bg-slate-800/30 border-slate-200/70 dark:border-slate-800 opacity-80'
              }`}
            >
              <div className="flex items-center justify-between mb-2.5">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id={`bsn-toggle-${step.id}`}
                    checked={!!stats.bsn?.enabled}
                    onChange={() => handleToggleResampling('bsn')}
                    disabled={readOnly}
                    className="w-4 h-4 rounded text-amber-600 focus:ring-amber-500 dark:focus:ring-amber-600 dark:bg-slate-800 border-slate-300 dark:border-slate-700 cursor-pointer"
                  />
                  <label htmlFor={`bsn-toggle-${step.id}`} className="font-bold text-slate-800 dark:text-slate-200 cursor-pointer">
                    Nucleus Bootstrap (<span className="font-mono text-amber-600 dark:text-amber-400">BSN</span>)
                  </label>
                </div>
                <span className="text-[10px] text-slate-400 dark:text-slate-500" title="Resamples grouped by active nucleus">
                  Resample by Nucleus
                </span>
              </div>

              {stats.bsn?.enabled && (
                <div className="space-y-2.5 pt-1 border-t border-slate-200/60 dark:border-slate-800/60">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-slate-600 dark:text-slate-400 font-medium">Replicates:</label>
                    <input
                      type="number"
                      min={1}
                      max={10000}
                      value={stats.bsn.replicates ?? 100}
                      onChange={e => handleUpdateResampling('bsn', 'replicates', parseInt(e.target.value, 10) || 0)}
                      disabled={readOnly}
                      className="w-24 px-2 py-1 font-mono rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white outline-none focus:border-amber-500"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-slate-600 dark:text-slate-400 font-medium">Seed (opt):</label>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        placeholder="None"
                        value={stats.bsn.seed ?? ''}
                        onChange={e => handleUpdateResampling('bsn', 'seed', e.target.value ? parseInt(e.target.value, 10) : undefined)}
                        disabled={readOnly}
                        className="w-20 px-2 py-1 font-mono text-[11px] rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => handleUpdateResampling('bsn', 'seed', generateRandomSeed())}
                        className="p-1 text-slate-400 hover:text-amber-500 hover:bg-slate-100 dark:hover:bg-slate-800 rounded"
                        title="Generate random seed"
                      >
                        <Dices className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* 4. MCMC Posterior Sampling */}
            <div
              className={`p-3.5 rounded-xl border transition-all ${
                stats.mcmc?.enabled
                  ? 'bg-purple-50/40 dark:bg-purple-950/20 border-purple-200 dark:border-purple-800/80 shadow-sm'
                  : 'bg-slate-50/50 dark:bg-slate-800/30 border-slate-200/70 dark:border-slate-800 opacity-80'
              }`}
            >
              <div className="flex items-center justify-between mb-2.5">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id={`mcmc-toggle-${step.id}`}
                    checked={!!stats.mcmc?.enabled}
                    onChange={handleToggleMcmc}
                    disabled={readOnly}
                    className="w-4 h-4 rounded text-purple-600 focus:ring-purple-500 dark:focus:ring-purple-600 dark:bg-slate-800 border-slate-300 dark:border-slate-700 cursor-pointer"
                  />
                  <label htmlFor={`mcmc-toggle-${step.id}`} className="font-bold text-slate-800 dark:text-slate-200 cursor-pointer">
                    MCMC Posterior (<span className="font-mono text-purple-600 dark:text-purple-400">emcee</span>)
                  </label>
                </div>
                <span className="text-[10px] text-slate-400 dark:text-slate-500" title="Ensemble sampler for Bayesian credible intervals">
                  Markov Chain
                </span>
              </div>

              {stats.mcmc?.enabled && (
                <div className="space-y-2.5 pt-1 border-t border-slate-200/60 dark:border-slate-800/60">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-slate-600 dark:text-slate-400 font-medium">Chain Steps:</label>
                    <input
                      type="number"
                      min={100}
                      step={500}
                      value={stats.mcmc.steps ?? 5000}
                      onChange={e => handleUpdateMcmc('steps', parseInt(e.target.value, 10) || 0)}
                      disabled={readOnly}
                      className="w-24 px-2 py-1 font-mono rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white outline-none focus:border-purple-500"
                    />
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <label className="text-slate-600 dark:text-slate-400 font-medium">Burn-in (steps):</label>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => handleUpdateMcmc('burn', stats.mcmc?.burn === 'auto' ? 1000 : 'auto')}
                        className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-bold uppercase transition-colors ${
                          stats.mcmc.burn === 'auto'
                            ? 'bg-purple-100 dark:bg-purple-900/60 text-purple-700 dark:text-purple-300'
                            : 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300'
                        }`}
                      >
                        Auto (2τ)
                      </button>
                      {stats.mcmc.burn !== 'auto' && (
                        <input
                          type="number"
                          min={0}
                          value={stats.mcmc.burn ?? 1000}
                          onChange={e => handleUpdateMcmc('burn', parseInt(e.target.value, 10) || 0)}
                          disabled={readOnly}
                          className="w-16 px-1.5 py-1 font-mono text-[11px] rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white outline-none"
                        />
                      )}
                    </div>
                  </div>

                  {/* Toggle Advanced MCMC settings */}
                  <div className="pt-1">
                    <button
                      type="button"
                      onClick={() => setShowAdvancedMcmc(!showAdvancedMcmc)}
                      className="text-[11px] text-purple-600 dark:text-purple-400 hover:underline flex items-center gap-1"
                    >
                      <Settings2 className="w-3 h-3" />
                      <span>{showAdvancedMcmc ? 'Hide Advanced Settings' : 'Show Advanced MCMC Settings (Thin, Walkers, Seed)'}</span>
                    </button>
                  </div>

                  {showAdvancedMcmc && (
                    <div className="p-2 rounded-lg bg-slate-100/70 dark:bg-slate-800/50 space-y-2 border border-slate-200 dark:border-slate-700/60">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-slate-600 dark:text-slate-400">Thinning:</span>
                        <input
                          type="number"
                          min={1}
                          value={stats.mcmc.thin ?? 1}
                          onChange={e => handleUpdateMcmc('thin', parseInt(e.target.value, 10) || 1)}
                          disabled={readOnly}
                          className="w-16 px-1.5 py-0.5 font-mono text-[11px] rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white"
                        />
                      </div>

                      <div className="flex items-center justify-between gap-2">
                        <span className="text-slate-600 dark:text-slate-400">Walkers:</span>
                        <input
                          type="number"
                          placeholder="Auto (max(32, 2p))"
                          value={stats.mcmc.walkers ?? ''}
                          onChange={e => handleUpdateMcmc('walkers', e.target.value ? parseInt(e.target.value, 10) : undefined)}
                          disabled={readOnly}
                          className="w-24 px-1.5 py-0.5 font-mono text-[11px] rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white"
                        />
                      </div>

                      <div className="flex items-center justify-between gap-2">
                        <span className="text-slate-600 dark:text-slate-400">Workers:</span>
                        <input
                          type="number"
                          placeholder="Inherit"
                          value={stats.mcmc.workers ?? ''}
                          onChange={e => handleUpdateMcmc('workers', e.target.value ? parseInt(e.target.value, 10) : undefined)}
                          disabled={readOnly}
                          className="w-20 px-1.5 py-0.5 font-mono text-[11px] rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white"
                        />
                      </div>

                      <div className="flex items-center justify-between gap-2">
                        <span className="text-slate-600 dark:text-slate-400">Seed:</span>
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            placeholder="None"
                            value={stats.mcmc.seed ?? ''}
                            onChange={e => handleUpdateMcmc('seed', e.target.value ? parseInt(e.target.value, 10) : undefined)}
                            disabled={readOnly}
                            className="w-20 px-1.5 py-0.5 font-mono text-[11px] rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white"
                          />
                          <button
                            type="button"
                            onClick={() => handleUpdateMcmc('seed', generateRandomSeed())}
                            className="p-1 text-slate-400 hover:text-purple-500"
                            title="Generate random seed"
                          >
                            <Dices className="w-3 h-3" />
                          </button>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 pt-1">
                        <input
                          type="checkbox"
                          id={`update-params-${step.id}`}
                          checked={!!stats.mcmc.update_parameters}
                          onChange={e => handleUpdateMcmc('update_parameters', e.target.checked)}
                          disabled={readOnly}
                          className="w-3.5 h-3.5 rounded text-purple-600"
                        />
                        <label htmlFor={`update-params-${step.id}`} className="text-slate-600 dark:text-slate-400 cursor-pointer">
                          Update fitted values with posterior medians
                        </label>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default StepStatisticsSection;
