/**
 * Scientific soft hints for a method (Phase C). Never errors: each is a warning or info with
 * a one-line reason and, where sensible, a quick-fix. Computed from ChemEx's resolved roles
 * (incl. per-spin data counts and experiment B1 fields reported by the backend) and the last
 * completed run. Every check can be switched off per project (settings.scientific_checks).
 */

import type { MethodConfig, RoleRule, Step } from './methodConfig';
import { newMethodId } from './methodConfig';
import { stepTomlName } from './methodToml';
import type { ValidationError } from './methodValidation';
import { dismissFix, issueKey, mapStep, type QuickFix } from './methodQuickFixes';
import type { ResolveReport, ResolvedStep } from './resolvedRoles';
import { fmtValue, overviewStep, parameterNameOfId, type RunOverview } from './runOverview';

export type ScienceCheckId = 'data-ratio' | 'b1-fields' | 'r2b-per-residue' | 'kex-cest-window' | 'strong-correlation';

export interface ScienceCheckDef {
  id: ScienceCheckId;
  label: string;
  description: string;
  /** Default threshold, for checks that have one. */
  threshold?: { value: number; label: string };
}

export const SCIENCE_CHECKS: ScienceCheckDef[] = [
  {
    id: 'data-ratio',
    label: 'Data points per fitted coordinate',
    description: 'Warn when an included residue has few data points per residue-local fitted coordinate.',
    threshold: { value: 10, label: 'Minimum points per local coordinate' },
  },
  { id: 'b1-fields', label: 'Global exchange from one B1 field (CEST)', description: 'Note when PB or KEX_AB are fitted globally from a single B1 field.' },
  { id: 'r2b-per-residue', label: 'R2_B fitted per residue (CEST)', description: 'Suggest [R2_B] = [R2_A] or one global R2_B.' },
  { id: 'kex-cest-window', label: 'Narrow KEX_AB search range (CEST)', description: 'Add the CEST sensitivity window to grid/DE edge warnings on KEX_AB.' },
  { id: 'strong-correlation', label: 'Strong correlations in the last run', description: 'Note pairs of fitted coordinates with |ρ| > 0.9.' },
];

export type ScienceSettings = Partial<Record<string, { enabled: boolean; threshold?: number | null }>>;

export const checkEnabled = (settings: ScienceSettings | undefined, id: ScienceCheckId) => settings?.[id]?.enabled !== false;
export const checkThreshold = (settings: ScienceSettings | undefined, id: ScienceCheckId) =>
  settings?.[id]?.threshold ?? SCIENCE_CHECKS.find(c => c.id === id)?.threshold?.value ?? 0;

/** CEST template default for KEX_AB searches. */
export const CEST_KEX_WINDOW: [number, number] = [20, 2000];

export interface DataRatio {
  ndata: number;
  coords: number;
  globalCoords: number;
  /** Per residue (spin): data points, residue-local FIT coordinates and their ratio. */
  perResidue: Array<{ spin: string; points: number; local: number; ratio: number | null }>;
}

/** Data / parameter ratio of a resolved step (null until the backend reports data counts). */
export function dataParamRatio(step: ResolvedStep | undefined): DataRatio | null {
  if (!step || !step.data_points) return null;
  const fits = step.parameters.filter(p => p.role === 'fit');
  const localBySpin: Record<string, number> = {};
  for (const p of fits) if (p.spin) localBySpin[p.spin] = (localBySpin[p.spin] ?? 0) + 1;
  const perResidue = Object.entries(step.data_points).map(([spin, points]) => {
    const local = localBySpin[spin] ?? 0;
    return { spin, points, local, ratio: local > 0 ? points / local : null };
  });
  return {
    ndata: step.ndata ?? Object.values(step.data_points).reduce((a, b) => a + b, 0),
    coords: fits.length,
    globalCoords: fits.filter(p => !p.spin).length,
    perResidue,
  };
}

function resolvedFor(report: ResolveReport | null | undefined, name: string): ResolvedStep | undefined {
  return report?.steps.find(s => s.name.toUpperCase() === name.toUpperCase());
}

function withDismiss(issue: ValidationError, extra: QuickFix[] = []): ValidationError {
  issue.actions = [...extra, dismissFix(issue.stepId, issueKey(issue) as string)];
  return issue;
}

const appendRules = (stepId: string, rules: RoleRule[]) => (config: MethodConfig) =>
  mapStep(config, stepId, step => ({ ...step, roleRules: [...(step.roleRules ?? []), ...rules] }));

/**
 * Quick-fixes for R2_B fitted per residue: tie each to its own R2_A, or share one R2_B.
 * ChemEx rejects a constraint whose reference falls inside its own target ("[R2_B] = [R2_B, NUC->X]"),
 * and v2 selectors have no "all except", so the shared form FITs the anchor copy and constrains every
 * other residue to it explicitly. It is offered only when each residue has a single R2_B copy (one
 * field), so the reference resolves to exactly one coordinate.
 */
export function r2bFixes(stepId: string, spins: string[], singleCopyPerSpin: boolean): QuickFix[] {
  const fixes: QuickFix[] = [
    {
      id: 'r2b-equals-r2a',
      label: 'Constrain [R2_B] = [R2_A]',
      title: 'Adds a CONSTRAIN rule: every residue’s R2_B follows its own R2_A.',
      apply: appendRules(stepId, [{ id: newMethodId('rule'), action: 'CONSTRAIN', entries: ['[R2_B] = [R2_A]'] }]),
    },
  ];
  const [anchor, ...others] = spins;
  if (singleCopyPerSpin && anchor && others.length > 0) {
    fixes.push({
      id: 'r2b-global',
      label: 'One global R2_B',
      title: `FIT R2_B for ${anchor} and constrain the other ${others.length} residue(s) to it.`,
      apply: appendRules(stepId, [
        { id: newMethodId('rule'), action: 'FIT', entries: [`R2_B, NUC->${anchor}`] },
        { id: newMethodId('rule'), action: 'CONSTRAIN', entries: others.map(sp => `[R2_B, NUC->${sp}] = [R2_B, NUC->${anchor}]`) },
      ]),
    });
  }
  return fixes;
}

export interface ScienceInput {
  config: MethodConfig;
  report: ResolveReport | null | undefined;
  overview?: RunOverview | null;
  family: string;
  settings?: ScienceSettings;
}

export function scienceIssues({ config, report, overview, family, settings }: ScienceInput): ValidationError[] {
  const out: ValidationError[] = [];
  const cest = family === 'cest';
  config.steps.forEach((step: Step, i) => {
    const stepName = stepTomlName(step, i);
    const resolved = resolvedFor(report, stepName);
    const base = { stepId: step.id, stepName };

    // C1 — data / parameter ratio per residue.
    if (resolved && checkEnabled(settings, 'data-ratio')) {
      const ratio = dataParamRatio(resolved);
      const min = checkThreshold(settings, 'data-ratio');
      const low = (ratio?.perResidue ?? []).filter(r => r.ratio !== null && r.ratio < min);
      if (low.length > 0) {
        const list = low
          .slice(0, 6)
          .map(r => `${r.spin} ${r.points}/${r.local}`)
          .join(', ');
        out.push(
          withDismiss({
            ...base,
            severity: 'warning',
            code: 'data-ratio',
            message: `${low.length} residue${low.length === 1 ? ' has' : 's have'} fewer than ${min} data points per residue-local fitted coordinate.`,
            detail: `Points / local coords: ${list}${low.length > 6 ? ', …' : ''}. Fix more per-residue parameters, or constrain them, so each coordinate is determined.`,
          })
        );
      }
    }

    // C2 — global exchange parameters from a single B1 field (CEST).
    if (resolved && cest && checkEnabled(settings, 'b1-fields') && resolved.experiments) {
      const globals = resolved.parameters.filter(p => p.role === 'fit' && !p.spin && (p.name.toUpperCase() === 'PB' || p.name.toUpperCase() === 'KEX_AB'));
      const b1 = new Set(resolved.experiments.map(e => e.b1_frq).filter((v): v is number => typeof v === 'number'));
      if (globals.length > 0 && b1.size === 1) {
        out.push(
          withDismiss({
            ...base,
            severity: 'info',
            code: 'b1-fields',
            message: `${globals.map(p => p.name.toUpperCase()).join(' and ')} fitted globally from one B1 field (${[...b1][0]} Hz).`,
            detail: 'Global exchange parameters are usually much better determined with two or more B1 fields.',
          })
        );
      }
    }

    // C3 — R2_B as independent per-residue FIT coordinates (CEST).
    if (resolved && cest && checkEnabled(settings, 'r2b-per-residue')) {
      const r2b = resolved.parameters.filter(p => p.name.toUpperCase() === 'R2_B' && p.role === 'fit' && p.spin);
      const spins = Array.from(new Set(r2b.map(p => p.spin)));
      if (spins.length > 1) {
        out.push(
          withDismiss(
            {
              ...base,
              severity: 'info',
              code: 'r2b-per-residue',
              message: `R2_B is fitted independently for ${spins.length} residues.`,
              detail: 'CEST rarely determines a per-residue R2_B; consider [R2_B] = [R2_A] or a single global R2_B.',
            },
            r2bFixes(step.id, spins, r2b.length === spins.length)
          )
        );
      }
    }

    // C5 — strong correlations in the last completed run.
    if (overview && checkEnabled(settings, 'strong-correlation')) {
      const ran = overviewStep(overview, stepName);
      const seen = new Set<string>();
      for (const c of ran?.correlations ?? []) {
        if (Math.abs(c.rho) <= 0.9) continue;
        const a = parameterNameOfId(c.a);
        const b = parameterNameOfId(c.b);
        const key = [c.a, c.b].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(
          withDismiss({
            ...base,
            paramName: `${a}~${b}`,
            severity: 'info',
            code: 'strong-correlation',
            message: `${a} and ${b} were strongly correlated in the last run (ρ = ${c.rho.toFixed(2)}, ${c.method}).`,
            detail: 'Their individual uncertainties may be large even when the fit is good; consider a joint-distribution view or more informative data.',
          })
        );
      }
    }
  });
  return out;
}

/** C4: extra text for a KEX_AB edge warning on CEST when the range is much narrower than the CEST window. */
export function kexWindowNote(param: string, low: number, high: number, family: string, settings?: ScienceSettings): string | null {
  if (family !== 'cest' || param.toUpperCase() !== 'KEX_AB' || !checkEnabled(settings, 'kex-cest-window')) return null;
  const [wl, wh] = CEST_KEX_WINDOW;
  if (!(low > 0 && high > low)) return null;
  const inside = low >= wl && high <= wh;
  const narrow = Math.log10(high / low) < 0.5 * Math.log10(wh / wl);
  if (!inside || !narrow) return null;
  return `The range ${fmtValue(low)}–${fmtValue(high)} s⁻¹ covers only part of the window CEST is sensitive to (≈${wl}–${wh} s⁻¹); widen it towards that window.`;
}
