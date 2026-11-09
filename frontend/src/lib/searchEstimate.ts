/**
 * Runtime estimates from the previous run's per-step wall-clock timings
 * (GET …/chemex/step-timings). ChemEx reports no grid progress, so the backend
 * returns how many fits each step performed (`evaluations`: 1 for plain TRF,
 * the profiled point count for GRID); time per fit = seconds / evaluations.
 */

export interface StepTiming {
  name: string;
  index?: number;
  /** Whole step, including its statistics. */
  seconds: number | null;
  /** Deterministic part only (until the step's statistics started), when it had statistics. */
  fit_seconds?: number | null;
  evaluations?: number | null;
  mcmc_seconds?: number | null;
  mcmc_steps?: number | null;
  incomplete?: boolean;
}

export interface StepEstimate {
  seconds: number;
  /** Step whose timing the estimate is based on. */
  basedOn: string;
  secondsPerFit: number;
  /** True when based on a different step than the one being estimated. */
  proxy: boolean;
}

function perFit(t: StepTiming): number | null {
  // Statistics time is not fitting time: prefer the deterministic part when recorded.
  const seconds = typeof t.fit_seconds === 'number' && t.fit_seconds > 0 ? t.fit_seconds : t.seconds;
  if (t.incomplete || !(typeof seconds === 'number' && seconds > 0)) return null;
  if (!(typeof t.evaluations === 'number' && t.evaluations > 0)) return null;
  return seconds / t.evaluations;
}

/**
 * Estimated wall time for `fits` fits of step `stepName`: uses the same-named step
 * of the last run when possible, otherwise the slowest completed step as a proxy.
 */
export function estimateStepSeconds(fits: number, stepName: string, timings: StepTiming[] | null | undefined): StepEstimate | null {
  if (!timings?.length || !(fits > 0)) return null;
  const same = timings.find(t => t.name.toLowerCase() === stepName.toLowerCase());
  const sameRate = same ? perFit(same) : null;
  if (sameRate !== null && same) return { seconds: sameRate * fits, basedOn: same.name || 'DEFAULT', secondsPerFit: sameRate, proxy: false };
  let best: { t: StepTiming; rate: number } | null = null;
  for (const t of timings) {
    const rate = perFit(t);
    if (rate !== null && (!best || rate > best.rate)) best = { t, rate };
  }
  return best ? { seconds: best.rate * fits, basedOn: best.t.name || 'DEFAULT', secondsPerFit: best.rate, proxy: true } : null;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} h`;
  return `${(seconds / 86400).toFixed(1)} days`;
}

export interface StatisticsEstimate {
  /** Full refits requested by MC + BS + BSN. */
  refits: number;
  /** Wall time of those refits (time per fit × refits ÷ workers), when timing exists. */
  resamplingSeconds: number | null;
  /** MCMC wall time scaled from the last run's chain on the same step, when available. */
  mcmcSeconds: number | null;
  workers: number | null;
  basedOn: string | null;
  secondsPerFit: number | null;
  proxy: boolean;
}

/** Cost of a step's statistics from the last run's timings (replicates run in parallel over workers). */
export function estimateStatistics(
  stats: { mc?: { enabled: boolean; replicates: number }; bs?: { enabled: boolean; replicates: number }; bsn?: { enabled: boolean; replicates: number }; mcmc?: { enabled: boolean; steps: number } } | undefined,
  stepName: string,
  timings: StepTiming[] | null | undefined,
  workers: number | null | undefined
): StatisticsEstimate {
  const refits = (['mc', 'bs', 'bsn'] as const).reduce((n, k) => n + (stats?.[k]?.enabled ? Math.max(0, Math.floor(stats[k]!.replicates || 0)) : 0), 0);
  const w = typeof workers === 'number' && workers >= 1 ? workers : null;
  const fit = refits > 0 ? estimateStepSeconds(refits, stepName, timings) : null;
  let mcmcSeconds: number | null = null;
  if (stats?.mcmc?.enabled && stats.mcmc.steps > 0) {
    const same = timings?.find(t => t.name.toLowerCase() === stepName.toLowerCase());
    if (same && !same.incomplete && typeof same.mcmc_seconds === 'number' && same.mcmc_seconds > 0 && same.mcmc_steps) {
      mcmcSeconds = (same.mcmc_seconds / same.mcmc_steps) * stats.mcmc.steps;
    }
  }
  return {
    refits,
    resamplingSeconds: fit ? fit.seconds / (w ?? 1) : null,
    mcmcSeconds,
    workers: w,
    basedOn: fit?.basedOn ?? null,
    secondsPerFit: fit?.secondsPerFit ?? null,
    proxy: fit?.proxy ?? false,
  };
}
