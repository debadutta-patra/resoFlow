/**
 * One-line, generated (never free text) summary of a method step, and the runtime estimate
 * of a step / the whole method from the last run's timings (Phases E1/E2).
 *
 * e.g. "Fits PB, KEX_AB globally + 8 residue coords on 14N, 23N · profiles a 10×10 grid ·
 *       MCMC 2000 steps · ≈ 7 min · 244 points / 10 coords"
 */

import type { Step } from './methodConfig';
import { axisPointCount } from './searchDefaults';
import { estimateStatistics, estimateStepSeconds, formatDuration, type StepTiming } from './searchEstimate';
import type { ResolvedStep } from './resolvedRoles';
import { dataParamRatio } from './scienceChecks';

export interface StepRuntime {
  /** Best estimate in seconds (null when nothing could be estimated). */
  seconds: number | null;
  /** Some requested part (fit, resampling, MCMC, DE) had no timing to scale from. */
  partial: boolean;
  /** The deterministic part was scaled from a one-residue test run (no full-run timing). */
  fromTest?: boolean;
}

export interface TestTimings {
  residue: string;
  steps: StepTiming[];
}

/**
 * Time per fit from a one-residue test run, scaled to the step's residue count: residue-local
 * work grows with the number of residues, so this is a rough, usually conservative, estimate.
 */
function fromTestRun(fits: number, name: string, test: TestTimings | null | undefined, residues: number): number | null {
  const est = estimateStepSeconds(fits, name, test?.steps);
  if (!est || est.proxy) return null;
  return est.seconds * Math.max(1, residues);
}

/** Deterministic part + MC/BS/BSN + MCMC, scaled from the last run's timings. */
export function stepRuntime(
  step: Step,
  name: string,
  resolved: ResolvedStep | undefined,
  timings: StepTiming[] | null | undefined,
  workers: number | null | undefined,
  test?: TestTimings | null
): StepRuntime {
  let partial = false;
  let fromTest = false;
  let total = 0;
  let any = false;
  const search = step.search;
  if (search && search.mode === 'de' && search.axes.length > 0) {
    partial = true; // stochastic: no per-evaluation cost
  } else {
    const fits = search?.mode === 'grid' && search.axes.length > 0 ? resolved?.search?.evaluations ?? null : 1;
    const det = fits ? estimateStepSeconds(fits, name, timings) : null;
    const residues = resolved ? new Set(resolved.parameters.filter(p => p.spin).map(p => p.spin)).size : 1;
    const viaTest = !det && fits ? fromTestRun(fits, name, test, residues) : null;
    if (det) {
      total += det.seconds;
      any = true;
    } else if (viaTest !== null) {
      total += viaTest;
      any = true;
      fromTest = true;
    } else partial = true;
  }
  const st = step.statistics;
  if (st && (st.mc?.enabled || st.bs?.enabled || st.bsn?.enabled || st.mcmc?.enabled)) {
    const est = estimateStatistics(st, name, timings, workers);
    if (est.refits > 0) {
      if (est.resamplingSeconds !== null) {
        total += est.resamplingSeconds;
        any = true;
      } else partial = true;
    }
    if (st.mcmc?.enabled) {
      if (est.mcmcSeconds !== null) {
        total += est.mcmcSeconds;
        any = true;
      } else partial = true;
    }
  }
  return { seconds: any ? total : null, partial, fromTest };
}

export function methodRuntime(
  steps: Array<{ step: Step; name: string; resolved?: ResolvedStep }>,
  timings: StepTiming[] | null | undefined,
  workers: number | null | undefined,
  test?: TestTimings | null
): StepRuntime {
  let seconds = 0;
  let any = false;
  let partial = false;
  let fromTest = false;
  for (const s of steps) {
    const r = stepRuntime(s.step, s.name, s.resolved, timings, workers, test);
    fromTest = fromTest || !!r.fromTest;
    if (r.seconds !== null) {
      seconds += r.seconds;
      any = true;
    }
    partial = partial || r.partial;
  }
  return { seconds: any ? seconds : null, partial, fromTest };
}

export function runtimeText(r: StepRuntime): string | null {
  if (r.seconds === null) return null;
  return `≈ ${formatDuration(r.seconds)}${r.partial ? '+' : ''}${r.fromTest ? ' (from test run)' : ''}`;
}

function listSpins(spins: string[], max = 4): string {
  return spins.length <= max ? spins.join(', ') : `${spins.slice(0, max).join(', ')} +${spins.length - max}`;
}

export function stepSummaryText(step: Step, resolved: ResolvedStep | undefined, runtime: StepRuntime | null): string {
  if (!resolved) return 'Resolving roles with ChemEx…';
  if (resolved.error) return resolved.error.message;
  const parts: string[] = [];
  const fits = resolved.parameters.filter(p => p.role === 'fit');
  const globalNames = Array.from(new Set(fits.filter(p => !p.spin).map(p => p.name.toUpperCase())));
  const local = fits.filter(p => p.spin);
  const spins = Array.from(new Set(local.map(p => p.spin)));
  const fitText: string[] = [];
  if (globalNames.length) fitText.push(`${globalNames.join(', ')} globally`);
  if (local.length) fitText.push(`${local.length} residue coord${local.length === 1 ? '' : 's'} on ${listSpins(spins)}`);
  parts.push(fitText.length ? `Fits ${fitText.join(' + ')}` : 'Fits nothing (no FIT coordinates)');
  const search = step.search;
  if (search && search.mode === 'grid' && search.axes.length) parts.push(`profiles a ${search.axes.map(a => axisPointCount(a)).join('×')} grid`);
  if (search && search.mode === 'de' && search.axes.length) parts.push(`DE over ${search.axes.length} coordinate${search.axes.length === 1 ? '' : 's'}`);
  const st = step.statistics;
  const stats = [
    st?.mc?.enabled ? `MC ×${st.mc.replicates}` : null,
    st?.bs?.enabled ? `BS ×${st.bs.replicates}` : null,
    st?.bsn?.enabled ? `BSN ×${st.bsn.replicates}` : null,
    st?.mcmc?.enabled ? `MCMC ${st.mcmc.steps} steps` : null,
  ].filter(Boolean);
  if (stats.length) parts.push(stats.join(', '));
  const rt = runtime ? runtimeText(runtime) : null;
  if (rt) parts.push(rt);
  const ratio = dataParamRatio(resolved);
  if (ratio) parts.push(`${ratio.ndata} points / ${ratio.coords} coords`);
  return parts.join(' · ');
}
