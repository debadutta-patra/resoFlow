/**
 * Read-only views over the last completed run's results bundle, shared by the
 * ChemEx analysis pages: committed global values per step (what the next step
 * would start from) and the last committed step for the run header.
 */

export interface ResultsLike {
  steps?: Record<string, { status?: string; globals?: Record<string, unknown>; statistics?: Record<string, unknown> } | undefined>;
  step_order?: string[];
  global?: Record<string, unknown>;
}

function numeric(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v && typeof v === 'object' && 'value' in v) {
    const inner = (v as { value: unknown }).value;
    if (typeof inner === 'number' && Number.isFinite(inner)) return inner;
  }
  return undefined;
}

function committed(step: { status?: string } | undefined): boolean {
  return !!step && step.status !== 'missing';
}

/** Committed global parameter values per step name, keyed by upper-case parameter name. */
export function committedGlobalsByStep(results: ResultsLike | null | undefined): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const name of results?.step_order ?? []) {
    const step = results?.steps?.[name];
    if (!committed(step)) continue;
    const values: Record<string, number> = {};
    for (const [key, raw] of Object.entries(step?.globals ?? {})) {
      const n = numeric(raw);
      if (n !== undefined) values[key.toUpperCase()] = n;
    }
    out[name.toUpperCase()] = values;
  }
  return out;
}

export interface CommittedStepSummary {
  /** Step name ('' for a single unnamed step). */
  name: string;
  redchi?: number;
}

/** The last step of the run that produced committed results, with its reduced χ². */
export function lastCommittedStep(results: ResultsLike | null | undefined): CommittedStepSummary | null {
  if (!results) return null;
  const order = results.step_order ?? [];
  for (let i = order.length - 1; i >= 0; i--) {
    const step = results.steps?.[order[i]];
    if (!committed(step)) continue;
    const stats = step?.statistics ?? {};
    return { name: order[i], redchi: numeric(stats.redchi) ?? numeric(stats.chi2_red) ?? numeric(results.global?.chi2_red) };
  }
  const redchi = numeric(results.global?.chi2_red) ?? numeric(results.global?.redchi);
  return redchi === undefined ? null : { name: '', redchi };
}
