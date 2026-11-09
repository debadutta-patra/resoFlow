/**
 * Runtime estimates from the previous run's per-step wall-clock timings
 * (GET …/chemex/step-timings). ChemEx reports no grid progress, so the backend
 * returns how many fits each step performed (`evaluations`: 1 for plain TRF,
 * the profiled point count for GRID); time per fit = seconds / evaluations.
 */

export interface StepTiming {
  name: string;
  index?: number;
  seconds: number | null;
  evaluations?: number | null;
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
  if (t.incomplete || !(typeof t.seconds === 'number' && t.seconds > 0)) return null;
  if (!(typeof t.evaluations === 'number' && t.evaluations > 0)) return null;
  return t.seconds / t.evaluations;
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
