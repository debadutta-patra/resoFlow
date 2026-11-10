/**
 * Checks that compare the current method with the last completed run (results bundle):
 * a committed GRID minimum on the first/last grid value of an axis means the true minimum
 * may lie outside the scanned range.
 */

import type { MethodConfig, SearchAxis } from './methodConfig';
import { dismissFix, issueKey, mapStep, type QuickFix } from './methodQuickFixes';
import type { ValidationError } from './methodValidation';
import { fmtValue, overviewStep, type OverviewGridAxis, type RunOverview } from './runOverview';
import { stepTomlName } from './methodToml';

/** Physical bounds used when extending a range (populations in [0, 1], rates non-negative). */
function bounds(param: string): { min: number; max: number } {
  const p = param.toUpperCase();
  if (/^P[A-F]$/.test(p)) return { min: 0, max: 1 };
  if (/^(KEX_|K[A-F]{2}$|R1_|R2_|TAUC)/.test(p)) return { min: 0, max: Infinity };
  return { min: -Infinity, max: Infinity };
}

/**
 * Extend an axis past the edge holding the minimum, keeping its point density:
 * log axes by one decade (same points per decade), linear axes to twice the width
 * (same spacing). Returns null when a physical bound leaves no room.
 */
export function extendAxis(axis: SearchAxis, edge: 'low' | 'high'): SearchAxis | null {
  if (axis.fn === 'values') return null;
  const { min, max } = bounds(axis.param);
  const intervals = Math.max(1, axis.count - 1);
  if (axis.fn === 'log') {
    if (axis.low <= 0 || axis.high <= axis.low) return null;
    const decades = Math.log10(axis.high / axis.low);
    let low = axis.low;
    let high = axis.high;
    if (edge === 'high') high = Math.min(axis.high * 10, max);
    else low = Math.max(axis.low / 10, min > 0 ? min : Number.MIN_VALUE);
    if (low === axis.low && high === axis.high) return null;
    const newDecades = Math.log10(high / low);
    const count = Math.max(axis.count, Math.round((intervals * newDecades) / decades) + 1);
    return { ...axis, low: tidy(low), high: tidy(high), count };
  }
  const width = axis.high - axis.low;
  if (!(width > 0)) return null;
  let low = axis.low;
  let high = axis.high;
  if (edge === 'high') high = Math.min(axis.high + width, max);
  else low = Math.max(axis.low - width, min);
  if (low === axis.low && high === axis.high) return null;
  const count = Math.max(axis.count, Math.round((intervals * (high - low)) / width) + 1);
  return { ...axis, low: tidy(low), high: tidy(high), count };
}

const tidy = (v: number) => Number(v.toPrecision(6));

function axisRange(axis: SearchAxis): string {
  return `${fmtValue(axis.low)}–${fmtValue(axis.high)}`;
}

/** Whether the current axis no longer has the old edge (the user already widened it). */
function alreadyExtended(axis: SearchAxis, ran: OverviewGridAxis): boolean {
  if (ran.edge === 'high' && ran.high !== null) return axis.high > ran.high * (1 + 1e-9);
  if (ran.edge === 'low' && ran.low !== null) return axis.low < ran.low * (1 - 1e-9) || (ran.low === 0 && axis.low < 0);
  return true;
}

export function gridEdgeFix(stepId: string, axis: SearchAxis, edge: 'low' | 'high'): QuickFix | null {
  const next = extendAxis(axis, edge);
  if (!next) return null;
  return {
    id: `extend-axis:${axis.id}:${edge}`,
    label: `Extend to ${axis.fn}(${fmtValue(next.low)}–${fmtValue(next.high)}, ${next.count} pts)`,
    title: axis.fn === 'log' ? 'One more decade, same points per decade.' : 'Twice the width, same grid spacing.',
    apply: (config: MethodConfig) =>
      mapStep(config, stepId, step =>
        step.search ? { ...step, search: { ...step.search, axes: step.search.axes.map(a => (a.id === axis.id ? next : a)) } } : step
      ),
  };
}

/** Grid-edge warnings for every GRID axis whose last committed minimum sits on a range edge. */
export function gridEdgeIssues(config: MethodConfig, ov: RunOverview | null | undefined): ValidationError[] {
  if (!ov) return [];
  const out: ValidationError[] = [];
  config.steps.forEach((step, i) => {
    const name = stepTomlName(step, i);
    const ran = overviewStep(ov, name)?.grid;
    const search = step.search;
    if (!ran || !search || search.mode !== 'grid') return;
    for (const r of ran.axes) {
      if (!r.edge || r.best === null) continue;
      const axis = search.axes.find(a => a.param.toUpperCase() === r.param.toUpperCase() && (a.qualifier || '') === (r.qualifier || ''));
      if (!axis || alreadyExtended(axis, r)) continue;
      const next = extendAxis(axis, r.edge);
      const where = r.edge === 'high' ? 'upper' : 'lower';
      const suggestion = next ? `; consider extending to ${fmtValue(r.edge === 'high' ? next.high : next.low)}` : '';
      const fix = gridEdgeFix(step.id, axis, r.edge);
      const issue: ValidationError = {
        stepId: step.id,
        stepName: name,
        paramName: axis.param.toUpperCase(),
        severity: 'warning',
        code: 'grid-edge',
        message: `${axis.param}: last run's grid minimum is at the ${where} edge (${fmtValue(r.best)})${suggestion}.`,
        detail: `Scanned ${axisRange(axis)}; the true minimum may lie outside it.`,
      };
      issue.actions = [...(fix ? [fix] : []), dismissFix(step.id, issueKey(issue) as string)];
      out.push(issue);
    }
  });
  return out;
}

