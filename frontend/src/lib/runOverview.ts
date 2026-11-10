/**
 * Last completed run, as cached in the results bundle (GET …/chemex/run-overview), and the
 * pure views the Methods page builds from it: "Last committed" values per parameter, step
 * results (status, red-χ², MCMC flags), grid-edge positions and strong correlations.
 */

import { SpinSystemKey } from './spinSystem';

export interface CommittedCopy {
  residue: string;
  qualifier: string;
  role: 'fit' | 'fix' | 'constrained';
  value: number | null;
  stderr: number | null;
}

export interface CommittedParam {
  scope: 'global' | 'residue';
  roles: string[];
  copies: CommittedCopy[];
}

export interface OverviewGridAxis {
  param: string;
  fn: 'lin' | 'log' | 'values';
  qualifier: string;
  values: number[];
  low: number | null;
  high: number | null;
  count: number;
  best: number | null;
  edge: 'low' | 'high' | null;
}

export interface OverviewGrid {
  status?: string;
  chisqr: number | null;
  axes: OverviewGridAxis[];
  best: Record<string, number | null>;
  pairs: Array<[string, string]>;
  profiles_1d: Record<string, { x: number[]; chisqr: number[] }>;
}

export interface OverviewMcmc {
  status?: string;
  tau_max: number | null;
  tau_tentative: boolean;
  tentative_burn: boolean;
  ess_min: number | null;
  ess_withheld: boolean;
  posterior_withheld: boolean;
  steps?: number | null;
  recommended_min_steps?: number | null;
  warnings: string[];
  seconds: number | null;
}

export interface OverviewCorrelation {
  a: string;
  b: string;
  rho: number;
  method: string;
}

export interface OverviewStep {
  name: string;
  status: string;
  redchi: number | null;
  chisqr: number | null;
  ndata: number | null;
  nvarys: number | null;
  values: Record<string, CommittedParam>;
  residue_redchi: Record<string, number | null>;
  grid: OverviewGrid | null;
  mcmc: OverviewMcmc | null;
  correlations: OverviewCorrelation[];
}

export interface RunOverview {
  schema: number;
  state: string;
  method_toml: string | null;
  step_order: string[];
  steps: OverviewStep[];
}

export interface GridSurface {
  x_param: string;
  y_param: string;
  x: number[];
  y: number[];
  z_chisqr: Array<Array<number | null>>;
  z_delta: Array<Array<number | null>>;
  min_point: { x: number | null; y: number | null; chisqr: number | null };
}

export function overviewStep(ov: RunOverview | null | undefined, name: string | undefined): OverviewStep | undefined {
  if (!ov || !name) return undefined;
  const upper = name.trim().toUpperCase();
  return ov.steps.find(s => s.name.toUpperCase() === upper);
}

/** Canonical comparison of two method.toml texts (comments, blank lines and trailing spaces ignored). */
export function normalizeMethodText(text: string | null | undefined): string {
  return (text ?? '')
    .split(/\r?\n/)
    .map(l => l.replace(/#.*$/, '').trimEnd())
    .filter(l => l.trim())
    .join('\n');
}

/** The run's method differs from the current one: committed values belong to a previous method. */
export function isPreviousMethod(ov: RunOverview | null | undefined, currentToml: string): boolean {
  if (!ov?.method_toml) return false;
  return normalizeMethodText(ov.method_toml) !== normalizeMethodText(currentToml);
}

export function fmtValue(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e4 || a < 1e-4)) return v.toExponential(2);
  return String(Number(v.toPrecision(3)));
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface CommittedSummary {
  /** e.g. "0.012 ± 0.002" (global) or "median 1.2 (0.8–2.1) · 3 res" (residue-level). */
  text: string;
  scope: 'global' | 'residue';
  /** Per-residue copies (residue-level only), natural residue order. */
  perResidue: CommittedCopy[];
}

/** "Last committed" cell for one parameter name in one step. */
export function committedSummary(step: OverviewStep | undefined, name: string): CommittedSummary | null {
  const param = step?.values[name.toUpperCase()];
  if (!param) return null;
  const copies = param.copies.filter(c => c.value !== null);
  if (copies.length === 0) return null;
  if (param.scope === 'global' && copies.length === 1) {
    const c = copies[0];
    return { text: c.stderr !== null ? `${fmtValue(c.value)} ± ${fmtValue(c.stderr)}` : fmtValue(c.value), scope: 'global', perResidue: [] };
  }
  const vals = copies.map(c => c.value as number);
  const residues = new Set(copies.map(c => c.residue).filter(Boolean));
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const perResidue = [...copies].sort((a, b) => {
    const ka = SpinSystemKey.parse(a.residue);
    const kb = SpinSystemKey.parse(b.residue);
    return ka.resNum - kb.resNum || a.qualifier.localeCompare(b.qualifier);
  });
  const range = lo === hi ? '' : ` (${fmtValue(lo)}–${fmtValue(hi)})`;
  return { text: `median ${fmtValue(median(vals))}${range} · ${residues.size || copies.length} res`, scope: 'residue', perResidue };
}

/** Badge facts for a step tab after a run. */
export interface StepResultBadge {
  state: 'ok' | 'failed' | 'not-run';
  redchi: number | null;
  mcmc: { tauMax: number | null; essMin: number | null; tentative: boolean; withheld: boolean; essWithheld: boolean } | null;
}

export function stepResultBadge(ov: RunOverview | null | undefined, name: string): StepResultBadge {
  const s = overviewStep(ov, name);
  if (!s) return { state: 'not-run', redchi: null, mcmc: null };
  const failed = s.status === 'missing' || s.status === 'failed';
  const m = s.mcmc;
  return {
    state: failed ? 'failed' : 'ok',
    redchi: s.redchi,
    mcmc: m
      ? { tauMax: m.tau_max, essMin: m.ess_min, tentative: m.tentative_burn, withheld: m.posterior_withheld, essWithheld: m.ess_withheld }
      : null,
  };
}

/** Parameter name of a ChemEx id ("__DW_AB_13N", "__R1_A_13N_499_2MHZ") or label ("[DW_AB, NUC->13N]"). */
export function parameterNameOfId(id: string): string {
  let s = id.trim().replace(/^_+/, '').replace(/^\[/, '').replace(/\]$/, '');
  s = s.split(',')[0].trim();
  return s.split(/_(?=\d)/)[0].toUpperCase();
}

/** Strong correlations (|ρ| > threshold) per parameter name, with the partner names. */
export function strongCorrelationsByName(
  step: OverviewStep | undefined,
  threshold = 0.9
): Record<string, Array<{ other: string; rho: number; method: string; a: string; b: string }>> {
  const out: Record<string, Array<{ other: string; rho: number; method: string; a: string; b: string }>> = {};
  const nameOf = (id: string) => parameterNameOfId(id);
  for (const c of step?.correlations ?? []) {
    if (Math.abs(c.rho) <= threshold) continue;
    const na = nameOf(c.a);
    const nb = nameOf(c.b);
    (out[na] ??= []).push({ other: nb, rho: c.rho, method: c.method, a: c.a, b: c.b });
    if (nb !== na) (out[nb] ??= []).push({ other: na, rho: c.rho, method: c.method, a: c.a, b: c.b });
  }
  return out;
}
