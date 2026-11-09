/**
 * Run-header text for ChemEx analysis pages. Live progress (from progress.json)
 * and the last committed result are always labelled separately so a running
 * fit's χ² is never confused with the previous run's.
 */

/** Live progress as written to progress.json by the run launcher. */
export interface RunProgress {
  kind: string;
  stage?: string;
  percent?: number;
  iteration?: number;
  redchi?: number;
  message?: string;
  /** Method step currently running (absent for runs that predate step reporting). */
  step?: { name: string; index?: number; total?: number };
}

const fmtChi = (v: number) => (Math.abs(v) >= 1e4 ? v.toExponential(2) : v.toFixed(2));

/** "Running <STEP> · iter N · red-χ² X" (or the current stage for grid / statistics). */
export function liveRunText(p: RunProgress): string {
  const step = p.step;
  const stepLabel = step ? `${step.name || 'DEFAULT'}${step.total && step.total > 1 ? ` (${step.index}/${step.total})` : ''}` : '';
  const parts = [`Running${stepLabel ? ` ${stepLabel}` : ''}`];
  if (p.kind === 'fit') {
    if (p.iteration !== undefined && p.iteration !== null) parts.push(`iter ${p.iteration}`);
    if (typeof p.redchi === 'number' && Number.isFinite(p.redchi)) parts.push(`red-χ² ${fmtChi(p.redchi)}`);
  } else if (p.kind === 'step') {
    parts.push('starting');
  } else if (p.stage) {
    parts.push(p.percent !== undefined ? `${p.stage} ${p.percent.toFixed(0)}%` : p.stage);
  }
  return parts.join(' · ');
}

/** "Last committed: <STEP> · red-χ² Y · <time>", or null when there is no committed result. */
export function lastCommittedText(c: { stepName?: string; redchi?: number; at?: string | null }): string | null {
  if (c.redchi === undefined && !c.stepName) return null;
  const parts: string[] = [];
  if (c.stepName) parts.push(c.stepName);
  if (c.redchi !== undefined && Number.isFinite(c.redchi)) parts.push(`red-χ² ${fmtChi(c.redchi)}`);
  const when = c.at ? new Date(c.at) : null;
  if (when && !Number.isNaN(when.getTime())) parts.push(when.toLocaleString());
  return `Last committed: ${parts.join(' · ')}`;
}

/** One-line explanation of the Global / Individual toggle relative to method steps. */
export const FIT_MODE_HELP =
  'Global runs the whole method (all steps) once over all residues. Individual runs the whole method separately for each residue, so every step, even PB/KEX_AB, is fitted per residue.';
