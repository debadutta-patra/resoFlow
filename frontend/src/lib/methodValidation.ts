import type { MethodConfig, Step } from './methodConfig';
import { normalizeStep } from './methodConfig';
import { stepRoleActions, stepTomlName } from './methodToml';
import { axisPointCount } from './searchDefaults';

export interface ValidationError {
  stepId: string;
  stepName: string;
  paramName?: string;
  message: string;
  severity: 'error' | 'warning';
}

export type MethodValidationError = ValidationError;

const STEP_NAME = /^[A-Za-z0-9_-]+$/;
const SELECTOR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const QUALIFIER = /^(NUC|T|B0|\[P\]|\[L\]|D2O)\s*->\s*\S.*$/i;
const MAX_SEED = Number.MAX_SAFE_INTEGER;

/** Check a v2 selector "NAME[, QUAL->value]..." — returns an error message or null. */
export function selectorError(selector: string, knownUpper?: Set<string>): string | null {
  const parts = selector.split(',').map(s => s.trim());
  const name = parts[0];
  if (!name) return 'Selector is empty.';
  if (!SELECTOR_NAME.test(name)) return `Invalid parameter name "${name}".`;
  const seen = new Set<string>();
  for (const frag of parts.slice(1)) {
    if (!QUALIFIER.test(frag)) return `Invalid qualifier "${frag}" — use NUC->, T->, B0->, [P]->, [L]-> or D2O->.`;
    const key = frag.split('->')[0].trim().toUpperCase();
    if (seen.has(key)) return `Duplicate qualifier ${key}.`;
    seen.add(key);
  }
  if (knownUpper && knownUpper.size > 0 && !knownUpper.has(name.toUpperCase())) {
    return `Unknown parameter "${name.toUpperCase()}".`;
  }
  return null;
}

/** Validate a constraint equation "[SEL] = expr". Returns an error message or null. */
export function constraintError(eq: string): string | null {
  if ((eq.match(/=/g) || []).length !== 1) return 'Constraint must contain exactly one "=".';
  const [lhs, rhs] = eq.split('=');
  if (!/^\s*\[[^\]]+\]\s*$/.test(lhs)) return 'Constraint left side must be one bracketed selector, e.g. [R2_B].';
  if (!rhs.trim()) return 'Constraint right side is empty.';
  if ((rhs.match(/\[/g) || []).length !== (rhs.match(/\]/g) || []).length) return 'Unmatched brackets in constraint.';
  const stripped = rhs.replace(/\[[^\]]*\]/g, '0');
  if (/[^0-9eE.+\-*/()\s]/.test(stripped)) return 'Constraint right side may only use numbers, [parameters], ( ), + - * /.';
  let depth = 0;
  for (const ch of stripped) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth < 0) return 'Unbalanced parentheses in constraint.';
  }
  if (depth !== 0) return 'Unbalanced parentheses in constraint.';
  return null;
}

/**
 * Validates a MethodConfig against ChemEx v2 method rules and known parameters.
 */
export function validateMethodConfig(
  config: MethodConfig,
  knownParamNames: string[] = ['PB', 'PC', 'KEX_AB', 'KEX_AC', 'KEX_BC', 'CS_A', 'DW_AB', 'DW_AC', 'R1_A', 'R2_A', 'R1_B', 'R2_B', 'R1_C', 'R2_C', 'TAUC_A'],
  totalAvailableResiduesCount = 0
): ValidationError[] {
  const errors: ValidationError[] = [];
  const knownUpper = new Set(knownParamNames.map(n => n.toUpperCase()));

  if (!config.steps || config.steps.length === 0) {
    errors.push({ stepId: 'global', stepName: 'Global', message: 'Method configuration must have at least one step.', severity: 'error' });
    return errors;
  }

  const earlier = new Set<string>();

  config.steps.forEach((rawStep, i) => {
    const step: Step = normalizeStep(rawStep);
    const stepName = stepTomlName(step, i);
    const push = (message: string, severity: 'error' | 'warning' = 'error', paramName?: string) =>
      errors.push({ stepId: step.id, stepName, paramName, message, severity });

    // ── Step name ──
    if (!STEP_NAME.test(stepName)) push(`Step name "${stepName}" may only contain letters, digits, "_" and "-".`);
    if (earlier.has(stepName)) push(`Duplicate step name "${stepName}". ChemEx v2 rejects duplicate steps.`);

    // ── ROLES_FROM ──
    if (step.rolesFrom) {
      const rf = step.rolesFrom.trim().toUpperCase();
      if (!earlier.has(rf)) push(`ROLES_FROM "${rf}" must name an earlier step.`);
    }

    // ── Parameter table ──
    const seen = new Set<string>();
    const modeOf = new Map<string, string>();
    for (const param of step.parameters) {
      const uName = param.name.toUpperCase();
      if (seen.has(uName)) push(`Parameter "${uName}" is defined multiple times in step "${stepName}".`, 'error', uName);
      seen.add(uName);
      modeOf.set(uName, param.mode);

      if (param.mode !== 'default' && knownUpper.size > 0 && !knownUpper.has(uName)) {
        push(`Unknown parameter "${uName}" for this model. Please check spelling.`, 'warning', uName);
      }
      if (param.mode === 'constrain') {
        const expr = (param.expression || '').trim();
        if (!expr) {
          push(`Constraint for "${uName}" has an empty expression.`, 'error', uName);
        } else {
          const eq = /^\s*\[[^\]]+\]\s*=/.test(expr) ? expr : `[${uName}] = ${expr}`;
          const msg = constraintError(eq);
          if (msg) push(`${uName}: ${msg}`, 'error', uName);
          for (const ref of Array.from(expr.matchAll(/\[([A-Za-z0-9_]+)[^\]]*\]/g)).map(m => m[1].toUpperCase())) {
            if (knownUpper.size > 0 && !knownUpper.has(ref)) push(`Constraint on "${uName}" references unknown parameter "${ref}".`, 'error', uName);
            if (ref === uName && !/^\s*\[/.test(expr)) push(`Constraint on "${uName}" references itself.`, 'error', uName);
          }
        }
      }
      if (param.bounds && param.bounds.trim()) {
        push(
          `Bound "${param.bounds.trim()}" on ${uName} is a v1 inequality constraint and is not part of ChemEx v2 method files; it is ignored. ChemEx's physical bounds apply.`,
          'warning',
          uName
        );
      }
    }

    // ── Ordered role rules ──
    for (const [ri, rule] of (step.roleRules ?? []).entries()) {
      const entries = rule.entries.map(e => e.trim()).filter(Boolean);
      if (entries.length === 0) {
        push(`Role rule #${ri + 1} (${rule.action}) is empty and will be skipped.`, 'warning');
        continue;
      }
      for (const e of entries) {
        const msg = rule.action === 'CONSTRAIN' ? constraintError(e) : selectorError(e, knownUpper);
        if (msg) push(`Role rule #${ri + 1} (${rule.action}) "${e}": ${msg}`, rule.action === 'CONSTRAIN' ? 'error' : msg.startsWith('Unknown') ? 'warning' : 'error');
      }
    }

    const actions = stepRoleActions(step);
    const hasFit = actions.some(a => a.action === 'FIT');
    const search = step.search;
    const searching = !!search && search.mode !== 'none' && search.axes.length > 0;
    if (!hasFit && !step.rolesFrom) {
      push(`Step "${stepName}" has no FIT action; ChemEx will fit the model's baseline parameters.`, 'warning');
    }

    // ── Deterministic search ──
    if (search && search.mode !== 'none') {
      const label = search.mode === 'grid' ? 'GRID' : 'DE';
      if (search.axes.length === 0) push(`${label} search is enabled but has no ${search.mode === 'grid' ? 'axes' : 'coordinates'}.`);
      if (search.mode === 'de') {
        if (search.seed === undefined || search.seed === null || !Number.isInteger(search.seed) || search.seed < 0 || search.seed > MAX_SEED) {
          push('DE search requires an integer SEED ≥ 0.');
        }
      }
      const selectors = new Set<string>();
      let globalProduct = 1;
      for (const axis of search.axes) {
        const sel = [axis.param.toUpperCase(), (axis.qualifier || '').trim()].filter(Boolean).join(', ');
        const selMsg = selectorError(sel, knownUpper);
        if (selMsg) push(`${label} axis "${sel}": ${selMsg}`, selMsg.startsWith('Unknown') ? 'warning' : 'error', axis.param);
        if (search.mode === 'de' && selectors.has(sel)) push(`DE coordinate "${sel}" is listed twice.`, 'error', axis.param);
        selectors.add(sel);

        const mode = modeOf.get(axis.param.toUpperCase());
        if (mode === 'fix' || mode === 'constrain') {
          push(`${label} target "${axis.param}" is set to ${mode.toUpperCase()} in the table; search targets must be fitted (FIT).`, 'error', axis.param);
        }

        if (axis.fn === 'values') {
          if (search.mode === 'de') push(`DE coordinate "${sel}" must use lin(low, high) or log(low, high), not values(...).`, 'error', axis.param);
          const vals = axis.values ?? [];
          if (vals.length === 0) push(`GRID axis "${sel}" has no values.`, 'error', axis.param);
          if (vals.some(v => !Number.isFinite(v))) push(`GRID axis "${sel}" contains a non-numeric value.`, 'error', axis.param);
          if (new Set(vals).size !== vals.length) push(`GRID axis "${sel}" contains duplicate values.`, 'error', axis.param);
        } else {
          if (!Number.isFinite(axis.low) || !Number.isFinite(axis.high)) push(`${label} range for "${sel}" must be finite.`, 'error', axis.param);
          else if (axis.low >= axis.high) push(`${label} range for "${sel}" must satisfy low < high (got ${axis.low} ≥ ${axis.high}).`, 'error', axis.param);
          if (axis.fn === 'log' && axis.low <= 0) push(`Logarithmic ${label} range for "${sel}" must be strictly positive.`, 'error', axis.param);
          if (search.mode === 'grid' && (!Number.isInteger(axis.count) || axis.count < 2)) {
            push(`GRID axis "${sel}" needs an integer point count ≥ 2.`, 'error', axis.param);
          }
        }
        const p = axis.param.toUpperCase();
        if (/^P[B-F]$/.test(p) && (axis.high > 1 || axis.low < 0)) push(`Population range for "${sel}" must lie within [0, 1].`, 'error', axis.param);
        if (/^(KEX_|R1_|R2_|TAUC)/.test(p) && axis.low < 0) push(`Range for "${sel}" must be non-negative (physical bound).`, 'error', axis.param);

        // Rough cost: only global axes multiply (residue-local axes are factorised per residue).
        if (search.mode === 'grid' && /^(P[B-F]|KEX_[A-F]{2}|K[A-Z_]*|TAUC.*)$/.test(p)) globalProduct *= Math.max(1, axisPointCount(axis));
      }
      if (search.mode === 'grid' && globalProduct > 1000) {
        push(`Global GRID axes span ${globalProduct} points; each point is a full profiled fit. Consider fewer points.`, 'warning');
      }
      if (searching && search.mode === 'grid' && i === config.steps.length - 1) {
        push(
          'The last step uses GRID: grid coordinates are never released by a final TRF and covariance errors are withheld. Add a following step without search to refine and obtain local uncertainties.',
          'warning'
        );
      }
    }

    // ── Residue selection ──
    if (step.residues && step.residues.length > 0 && totalAvailableResiduesCount > 0) {
      if (step.residueMode === 'exclude' && step.residues.length >= totalAvailableResiduesCount) {
        push(`Step "${stepName}" excludes all residues, leaving no data to fit.`);
      }
    }

    // ── Statistics ──
    const stats = step.statistics;
    if (stats) {
      const seedOk = (s?: number) => s === undefined || s === null || (Number.isInteger(s) && s >= 0 && s <= MAX_SEED);
      for (const { key, label } of [
        { key: 'mc', label: 'Monte Carlo (MC)' },
        { key: 'bs', label: 'Bootstrap (BS)' },
        { key: 'bsn', label: 'Nucleus-Specific Bootstrap (BSN)' },
      ] as const) {
        const conf = stats[key];
        if (!conf?.enabled) continue;
        if (!conf.replicates || conf.replicates < 1 || !Number.isInteger(conf.replicates)) {
          push(`${label} replicate count must be a positive integer (>= 1).`);
        } else if (conf.replicates > 200) {
          push(`${label} replicate count (${conf.replicates}) requires ${conf.replicates} full refits and may have high execution cost.`, 'warning');
        }
        if (!seedOk(conf.seed)) push(`${label} seed must be an integer ≥ 0.`);
      }

      if (stats.mcmc?.enabled) {
        const m = stats.mcmc;
        if (!m.steps || m.steps < 1 || !Number.isInteger(m.steps)) push('MCMC steps must be a positive integer (>= 1).');
        if (m.burn !== 'auto') {
          const b = Number(m.burn);
          if (!Number.isInteger(b) || b < 0) push('MCMC burn must be a non-negative integer, or Auto.');
          else if (m.steps && b >= m.steps) push(`MCMC burn (${b}) must be smaller than total steps (${m.steps}).`);
        }
        if (!seedOk(m.seed)) push('MCMC seed must be an integer ≥ 0.');
        const legacy = [
          m.thin && m.thin > 1 ? `THIN=${m.thin}` : null,
          m.walkers ? `WALKERS=${m.walkers}` : null,
          m.workers ? `WORKERS=${m.workers}` : null,
          m.update_parameters ? 'UPDATE_PARAMETERS' : null,
        ].filter(Boolean);
        if (legacy.length) {
          push(`MCMC ${legacy.join(', ')} are v1-only controls and are not emitted (ChemEx v2 manages walkers; set workers with "chemex fit --workers").`, 'warning');
        }
      }
    }

    earlier.add(stepName);
  });

  return errors;
}
