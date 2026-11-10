import type { MethodConfig, Step } from './methodConfig';
import { normalizeStep } from './methodConfig';
import { stepRoleActions, stepTomlName } from './methodToml';
import { axisPointCount } from './searchDefaults';
import { seedError } from './seed';
import { rolesFromError, stepNameError } from './methodSteps';
import { rulesByTargetName, type ChemexSource } from './resolvedRoles';
import { constraintTargetName, parseConstraint, parseSelector, selectorName } from './methodGrammar';
import type { ParameterCatalog } from './baselineRoles';
import { dismissFix, inheritRolesFix, issueKey, type QuickFix } from './methodQuickFixes';

/**
 * error: blocks Run (red) · warning: likely problem (amber) · info: note worth reading (blue).
 * ChemEx's own validation failures are always errors.
 */
export type IssueSeverity = 'error' | 'warning' | 'info';

export const SEVERITY_ORDER: Record<IssueSeverity, number> = { error: 0, warning: 1, info: 2 };

export interface ValidationError {
  stepId: string;
  stepName: string;
  paramName?: string;
  message: string;
  severity: IssueSeverity;
  /** 'chemex' for problems reported by ChemEx itself (with its location), else instant local checks. */
  origin?: 'local' | 'chemex';
  source?: ChemexSource;
  /** Stable rule id; warnings/info with a code can be dismissed per step. */
  code?: string;
  /** Second line of explanation (e.g. the parameters concerned). */
  detail?: string;
  /** Config edits that resolve the issue (shown as buttons). */
  actions?: QuickFix[];
}

/** Context the local checks use when available (all optional; checks degrade gracefully). */
export interface ValidationContext {
  /** Parameter names ChemEx fits with no ROLES actions (baseline FIT), for the no-FIT note. */
  baselineFitNames?: string[];
}

/** Highest severity present, or null when there are no issues. */
export function highestSeverity(issues: Array<{ severity: IssueSeverity }>): IssueSeverity | null {
  let best: IssueSeverity | null = null;
  for (const i of issues) if (best === null || SEVERITY_ORDER[i.severity] < SEVERITY_ORDER[best]) best = i.severity;
  return best;
}

export function severityCounts(issues: Array<{ severity: IssueSeverity }>): Record<IssueSeverity, number> {
  const out: Record<IssueSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const i of issues) out[i.severity] += 1;
  return out;
}

/** Whether a step runs any STATISTICS analysis. */
export function hasStatistics(step: Step): boolean {
  const st = step.statistics;
  return !!(st?.mc?.enabled || st?.bs?.enabled || st?.bsn?.enabled || st?.mcmc?.enabled);
}

function isGridStep(step: Step | undefined): boolean {
  return !!step?.search && step.search.mode === 'grid' && step.search.axes.length > 0;
}

export type MethodValidationError = ValidationError;

/** Check a v2 selector "NAME[, QUAL->value]..." with ChemEx's grammar — returns an error message or null. */
export function selectorError(selector: string, knownUpper?: Set<string>): string | null {
  const { selector: parsed, error } = parseSelector(selector);
  if (error || !parsed) return `${error?.message ?? 'Invalid selector'}.`;
  if (knownUpper && knownUpper.size > 0 && !knownUpper.has(parsed.name)) return `Unknown parameter "${parsed.name}".`;
  return null;
}

/** Validate a constraint equation "[SEL] = expr" with ChemEx's grammar. Returns an error message or null. */
export function constraintError(eq: string): string | null {
  const { error } = parseConstraint(eq);
  return error ? `${error.message}.` : null;
}

/**
 * Instant check that a DE coordinate can resolve to exactly one fitted coordinate:
 * every dimension along which ChemEx instantiated several copies of the parameter
 * (residues, fields, temperatures, concentrations) must be pinned by a qualifier.
 * ChemEx's resolution remains authoritative (it also sees the step's selection).
 */
export function deBreadthError(param: string, qualifier: string | undefined, catalog?: ParameterCatalog | null): string | null {
  const entry = catalog?.[param.trim().toUpperCase()];
  if (!entry) return null;
  const used = new Set(
    (qualifier || '')
      .split(',')
      .map(f => f.split('->')[0].trim().toUpperCase())
      .filter(Boolean)
  );
  const dims: Array<[string, number, string]> = [
    ['NUC', entry.spins.length, 'residues'],
    ['B0', entry.B0.length, 'B0 fields'],
    ['T', entry.T.length, 'temperatures'],
    ['[P]', entry['[P]'].length, 'protein concentrations'],
    ['[L]', entry['[L]'].length, 'ligand concentrations'],
    ['D2O', entry.D2O.length, 'D2O fractions'],
  ];
  const open = dims.filter(([key, n]) => n > 1 && !used.has(key));
  if (!open.length) return null;
  return `matches copies for ${open.map(([, n, what]) => `${n} ${what}`).join(' and ')}; each DE coordinate must resolve to exactly one FIT coordinate — add ${open
    .map(([key]) => `${key}->`)
    .join(', ')}.`;
}

/** Why a method action may not target this parameter name (model-owned / not estimable), or null. */
export function protectedTargetError(name: string, action: 'FIT' | 'FIX' | 'CONSTRAIN' | 'SEARCH', catalog?: ParameterCatalog | null): string | null {
  const entry = catalog?.[name.toUpperCase()];
  if (!entry) return null;
  if (entry.protected) return `${entry.name} is model-derived (protected); method roles cannot change it.`;
  if ((action === 'FIT' || action === 'SEARCH') && !entry.estimable) return `${entry.name} cannot be estimated by ChemEx, so it cannot be FIT.`;
  return null;
}

/**
 * Validates a MethodConfig against ChemEx v2 method rules and known parameters.
 */
export function validateMethodConfig(
  config: MethodConfig,
  knownParamNames: string[] = ['PB', 'PC', 'KEX_AB', 'KEX_AC', 'KEX_BC', 'CS_A', 'DW_AB', 'DW_AC', 'R1_A', 'R2_A', 'R1_B', 'R2_B', 'R1_C', 'R2_C', 'TAUC_A'],
  totalAvailableResiduesCount = 0,
  /** ChemEx parameter catalog (protection flags); omitted until inspection succeeds. */
  catalog?: ParameterCatalog | null,
  context: ValidationContext = {}
): ValidationError[] {
  const errors: ValidationError[] = [];
  const knownUpper = new Set(knownParamNames.map(n => n.toUpperCase()));

  if (!config.steps || config.steps.length === 0) {
    errors.push({ stepId: 'global', stepName: 'Global', message: 'Method configuration must have at least one step.', severity: 'error' });
    return errors;
  }

  config.steps.forEach((rawStep, i) => {
    const step: Step = normalizeStep(rawStep);
    const stepName = stepTomlName(step, i);
    const push = (
      message: string,
      severity: IssueSeverity = 'error',
      paramName?: string,
      extra: { code?: string; detail?: string; actions?: QuickFix[]; dismissLabel?: string } = {}
    ) => {
      const { dismissLabel, ...rest } = extra;
      const issue: ValidationError = { stepId: step.id, stepName, paramName, message, severity, ...rest };
      const key = severity !== 'error' ? issueKey(issue) : null;
      if (key) issue.actions = [...(issue.actions ?? []), dismissFix(step.id, key, dismissLabel)];
      errors.push(issue);
    };

    // ── Step name (TOML key and ChemEx output folder) ──
    const nameMsg = stepNameError(stepName, config.steps, i);
    if (nameMsg) push(nameMsg);

    // ── ROLES_FROM (by step id; a dangling or forward reference is an error, never auto-fixed) ──
    const rfMsg = rolesFromError(config.steps, i);
    if (rfMsg) push(rfMsg);

    // ── Parameter table ──
    const seen = new Set<string>();
    const modeOf = new Map<string, string>();
    for (const param of step.parameters) {
      const uName = param.name.toUpperCase();
      if (seen.has(uName)) push(`Parameter "${uName}" is defined multiple times in step "${stepName}".`, 'error', uName);
      seen.add(uName);
      modeOf.set(uName, param.mode);

      if (param.mode !== 'default') {
        const action = param.mode === 'fix' ? 'FIX' : param.mode === 'constrain' ? 'CONSTRAIN' : 'FIT';
        const prot = protectedTargetError(uName, action, catalog);
        if (prot) push(prot, 'error', uName);
      }
      if (param.mode !== 'default' && knownUpper.size > 0 && !knownUpper.has(uName)) {
        push(`Unknown parameter "${uName}" for this model. Please check spelling.`, 'warning', uName, { code: 'unknown-param' });
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
          uName,
          { code: 'legacy-bound' }
        );
      }
    }

    // ── Ordered role rules ──
    for (const [ri, rule] of (step.roleRules ?? []).entries()) {
      const entries = rule.entries.map(e => e.trim()).filter(Boolean);
      if (entries.length === 0) {
        push(`Role rule #${ri + 1} (${rule.action}) is empty and will be skipped.`, 'warning', undefined, { code: `empty-rule-${rule.id}` });
        continue;
      }
      for (const e of entries) {
        const target = rule.action === 'CONSTRAIN' ? constraintTargetName(e) : selectorName(e);
        const prot = target ? protectedTargetError(target, rule.action, catalog) : null;
        if (prot) push(`Role rule #${ri + 1} (${rule.action}) "${e}": ${prot}`, 'error', target ?? undefined);
        const msg = rule.action === 'CONSTRAIN' ? constraintError(e) : selectorError(e, knownUpper);
        if (msg) push(`Role rule #${ri + 1} (${rule.action}) "${e}": ${msg}`, rule.action === 'CONSTRAIN' ? 'error' : msg.startsWith('Unknown') ? 'warning' : 'error');
      }
    }

    const actions = stepRoleActions(step);
    const hasFit = actions.some(a => a.action === 'FIT');
    const search = step.search;
    const searching = !!search && search.mode !== 'none' && search.axes.length > 0;
    // No FIT action and no ROLES_FROM: ChemEx fits the baseline FIT set. Usually deliberate
    // right after a GRID step when the step only samples (refine-then-sample), so stay quiet there.
    const prevStep = i > 0 ? normalizeStep(config.steps[i - 1]) : undefined;
    if (!hasFit && !step.rolesFromStepId && !step.rolesFrom && !(isGridStep(prevStep) && hasStatistics(step))) {
      const names = context.baselineFitNames ?? [];
      push(
        `Step "${stepName}" has no FIT action; ChemEx will fit the model's baseline FIT parameters.`,
        'info',
        undefined,
        {
          code: 'no-fit-action',
          detail: names.length
            ? `Baseline FIT: ${names.join(', ')}.`
            : 'The baseline FIT set is shown once ChemEx has inspected the experiments.',
          actions: prevStep ? [inheritRolesFix(step.id, config.steps[i - 1], i - 1)] : [],
          dismissLabel: 'Mark as intentional',
        }
      );
    }

    // ── Deterministic search ──
    if (search && search.mode !== 'none') {
      const label = search.mode === 'grid' ? 'GRID' : 'DE';
      if (search.axes.length === 0) push(`${label} search is enabled but has no ${search.mode === 'grid' ? 'axes' : 'coordinates'}.`);
      if (search.mode === 'de') {
        const msg = seedError(search.seed, true);
        if (msg) push(`DE search: ${msg}`);
      }
      const selectors = new Set<string>();
      const ruleTargets = new Set(Object.keys(rulesByTargetName(step)));
      let globalProduct = 1;
      for (const axis of search.axes) {
        const sel = [axis.param.toUpperCase(), (axis.qualifier || '').trim()].filter(Boolean).join(', ');
        const selMsg = selectorError(sel, knownUpper);
        if (selMsg) push(`${label} axis "${sel}": ${selMsg}`, selMsg.startsWith('Unknown') ? 'warning' : 'error', axis.param);
        if (search.mode === 'de' && selectors.has(sel)) push(`DE coordinate "${sel}" is listed twice.`, 'error', axis.param);
        selectors.add(sel);

        const protAxis = protectedTargetError(axis.param, 'SEARCH', catalog);
        if (protAxis) push(`${label} target: ${protAxis}`, 'error', axis.param);
        const mode = modeOf.get(axis.param.toUpperCase());
        // A later rule may still make it FIT; then ChemEx's resolution is the judge.
        if ((mode === 'fix' || mode === 'constrain') && !ruleTargets.has(axis.param.toUpperCase())) {
          push(`${label} target "${axis.param}" is set to ${mode.toUpperCase()} in the table; search targets must be final FIT coordinates.`, 'error', axis.param);
        }
        if (search.mode === 'de') {
          const broad = deBreadthError(axis.param, axis.qualifier, catalog);
          if (broad) push(`DE coordinate "${sel}": ${broad}`, 'error', axis.param);
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
        push(`Global GRID axes span ${globalProduct} points; each point is a full profiled fit. Consider fewer points.`, 'warning', undefined, { code: 'grid-cost' });
      }
      if (searching && search.mode === 'grid' && i === config.steps.length - 1) {
        push(
          'The last step uses GRID: grid coordinates are never released by a final TRF and covariance errors are withheld. Add a following step without search to refine and obtain local uncertainties.',
          'warning',
          undefined,
          { code: 'grid-last-step' }
        );
      }
    }

    // ── Residue selection ──
    if (step.residueMode === 'include' && (!step.residues || step.residues.length === 0)) {
      push('INCLUDE selects no profiles, so ChemEx would skip this step. Choose residues, or "All profiles".');
    }
    if (step.residues && step.residues.length > 0 && totalAvailableResiduesCount > 0) {
      if (step.residueMode === 'exclude' && step.residues.length >= totalAvailableResiduesCount) {
        push(`Step "${stepName}" excludes all residues, leaving no data to fit.`);
      }
    }

    // ── Statistics ──
    const stats = step.statistics;
    if (stats) {
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
          push(`${label} replicate count (${conf.replicates}) requires ${conf.replicates} full refits and may have high execution cost.`, 'warning', undefined, { code: `stats-cost-${key}` });
        }
        const seedMsg = seedError(conf.seed);
        if (seedMsg) push(`${label}: ${seedMsg}`);
      }

      if (stats.mcmc?.enabled) {
        const m = stats.mcmc;
        if (!m.steps || m.steps < 1 || !Number.isInteger(m.steps)) push('MCMC steps must be a positive integer (>= 1).');
        if (m.burn !== 'auto') {
          const b = Number(m.burn);
          if (!Number.isInteger(b) || b < 0) push('MCMC burn must be a non-negative integer, or Auto.');
          else if (m.steps && b >= m.steps) push(`MCMC burn (${b}) must be smaller than total steps (${m.steps}).`);
        }
        const seedMsg = seedError(m.seed);
        if (seedMsg) push(`MCMC: ${seedMsg}`);
        const legacy = [
          m.thin && m.thin > 1 ? `THIN=${m.thin}` : null,
          m.walkers ? `WALKERS=${m.walkers}` : null,
          m.workers ? `WORKERS=${m.workers}` : null,
          m.update_parameters ? 'UPDATE_PARAMETERS' : null,
        ].filter(Boolean);
        if (legacy.length) {
          push(`MCMC ${legacy.join(', ')} are v1-only controls and are not emitted (ChemEx v2 manages walkers; set workers with "chemex fit --workers").`, 'warning', undefined, { code: 'mcmc-legacy' });
        }
      }
    }

  });

  return errors;
}
