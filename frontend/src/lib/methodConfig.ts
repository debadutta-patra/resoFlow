import { type Seed, randomSeed as randomU64Seed, toSeed } from './seed';
import { linkRolesFrom } from './methodSteps';
export type { Seed } from './seed';

export const KINETIC_MODELS = [
  '1st',
  '2st',
  '2st_binding',
  '2st_eyring',
  '2st_hd',
  '2st_monomer_dimer',
  '2st_monomer_tetramer',
  '2st_monomer_trimer',
  '2st_rs',
  '3st',
  '3st_binding_cs',
  '3st_binding_if',
  '3st_binding_partner_2st',
  '3st_double_binding',
  '3st_eyring',
  '3st_fork',
  '3st_linear',
  '3st_monomer_dimer_tetramer',
  '3st_monomer_dimer_trimer',
  '3st_triangle',
  '4st',
  '4st_binding_3_bound_states',
  '4st_binding_partner_2st',
  '4st_eyring',
  '4st_hd',
  '5st',
  '6st',
] as const;

export type KineticModel = (typeof KINETIC_MODELS)[number];


/**
 * ChemEx v2 method model (FORMAT_VERSION = 2).
 *
 * A step's effective roles are built in this order:
 *   1. baseline model roles, or the effective roles of the ROLES_FROM step (`rolesFromStepId`)
 *   2. the per-parameter table (`parameters`) — plain-name CONSTRAIN → FIX → FIT
 *   3. `roleRules`, top to bottom — selector-qualified overrides (later wins)
 * then an optional deterministic search (`search`: GRID or DE), then STATISTICS.
 *
 * 'grid' is a legacy mode kept only so old saved configs/TOML can be read;
 * `normalizeMethodConfig` converts it into `fit` + a GRID search axis.
 */
export type ParamMode = 'default' | 'fit' | 'fix' | 'constrain' | 'grid';

/** Legacy v1 per-parameter grid spec (only read for migration). */
export interface GridSpec {
  min: number;
  max: number;
  steps: number;
  scale: 'lin' | 'log';
}

export interface ParamSetting {
  name: string;             // e.g. "PB", "KEX_AB", "DW_AB", "CS_A", "R2_A", "R2_B"
  mode: ParamMode;
  value?: number;           // unused by ChemEx v2 (values come from parameters.toml)
  /** Legacy v1 inequality bound (e.g. "< 0.5"). Not expressible in v2 method files; never emitted. */
  bounds?: string;
  expression?: string;      // mode === 'constrain', right-hand side, e.g. "0.5 * [R2_A]"
  grid?: GridSpec;          // legacy mode === 'grid'
}

export type RoleAction = 'FIT' | 'FIX' | 'CONSTRAIN';

/**
 * One ordered ROLES action. `entries` are selectors for FIT/FIX
 * (e.g. "DW_AB, NUC->G24N-H") or full equations for CONSTRAIN
 * (e.g. "[DW_AB, NUC->G31N-H] = [DW_AB, NUC->G24N-H]").
 */
export interface RoleRule {
  id: string;
  action: RoleAction;
  entries: string[];
}

export type SearchFunction = 'lin' | 'log' | 'values';
export type SearchMode = 'none' | 'grid' | 'de';

/**
 * One GRID axis or DE coordinate.
 * GRID: lin/log(low, high, count) or values(...). DE: lin/log(low, high) only.
 */
export interface SearchAxis {
  id: string;
  param: string;            // parameter name, e.g. "KEX_AB"
  qualifier?: string;       // optional selector qualifiers, e.g. "NUC->G24N-H, B0->800MHz"
  fn: SearchFunction;
  low: number;
  high: number;
  count: number;
  values?: number[];        // fn === 'values'
}

export interface StepSearch {
  mode: SearchMode;
  axes: SearchAxis[];
  /** DE only — required unsigned 64-bit seed (decimal string; see lib/seed). */
  seed?: Seed;
}

export interface ResamplingConfig {
  enabled: boolean;
  replicates: number;
  /** Optional unsigned 64-bit seed (decimal string). Omitted → ChemEx generates and records one. */
  seed?: Seed;
}

export interface McmcConfig {
  enabled: boolean;
  steps: number;
  /** 'auto' → BURN omitted (ChemEx discards ceil(2·τ_max)). */
  burn: number | 'auto';
  /** Optional unsigned 64-bit seed (decimal string). */
  seed?: Seed;
  /** Legacy v1-only controls; ChemEx v2 rejects them and they are never emitted. */
  thin?: number;
  walkers?: number;
  workers?: number;
  update_parameters?: boolean;
}

export interface StatisticsConfig {
  mc?: ResamplingConfig;
  bs?: ResamplingConfig;
  bsn?: ResamplingConfig;
  mcmc?: McmcConfig;
}

export interface Step {
  id: string;               // UUID or unique ID
  name: string;             // TOML section name, e.g. "STEP1"
  parameters: ParamSetting[];
  residueMode: 'include' | 'exclude';
  residues: string[];       // profile/spin-system names or residue numbers; empty = all profiles
  /**
   * ROLES_FROM target, by step id (authoritative; survives renames and reordering).
   * Serialised as that step's current name.
   */
  rolesFromStepId?: string;
  /**
   * Last known name of the ROLES_FROM target. Used to link imported / legacy name-only
   * references, and as the serialised name if the target step was deleted (which
   * validation then reports instead of silently dropping the reference).
   */
  rolesFrom?: string;
  /** Ordered selector-level ROLES actions applied after the parameter table. */
  roleRules?: RoleRule[];
  search?: StepSearch;
  statistics?: StatisticsConfig;
}

export interface MethodConfig {
  steps: Step[];
  rawOverride?: string;     // set only when user drops to raw editing
}

export interface ParseResult {
  config: MethodConfig;
  unparsed: string[];       // lines or comments the model couldn't represent
  /** 'v1' when FORMAT_VERSION was absent (the file was migrated to v2). */
  format: 'v1' | 'v2';
  /** What the v1 → v2 migration changed, one human-readable line each (empty for v2). */
  migration: string[];
}

export const newMethodId = (prefix = 'id'): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

/** Full-range random ChemEx SEED (unsigned 64-bit, decimal string). */
export const randomSeed = (): Seed => randomU64Seed();

export const createDefaultStep = (name = 'STEP1', id?: string): Step => ({
  id: id || newMethodId('step'),
  name,
  parameters: [
    { name: 'PB', mode: 'fit' },
    { name: 'KEX_AB', mode: 'fit' },
    { name: 'DW_AB', mode: 'fit' },
    { name: 'CS_A', mode: 'fit' },
    { name: 'R2_A', mode: 'default' },
    { name: 'R2_B', mode: 'default' },
    { name: 'R1_A', mode: 'default' },
    { name: 'R1_B', mode: 'default' },
  ],
  residueMode: 'include',
  residues: [],
});

export const createDefaultMethodConfig = (): MethodConfig => ({
  steps: [createDefaultStep()],
});

/**
 * Upgrade a step loaded from an older (v1-era) saved config or template:
 * legacy 'grid' parameters become FIT + a GRID axis; legacy MCMC burn strings
 * are normalised. Idempotent.
 */
export function normalizeStep(step: Step): Step {
  const legacyGrid = (step.parameters || []).filter(p => p.mode === 'grid');
  const roleRules = step.roleRules ?? [];
  let search = step.search;
  if (legacyGrid.length > 0) {
    const axes: SearchAxis[] = [...(search?.axes ?? [])];
    for (const p of legacyGrid) {
      const g = p.grid ?? { min: 0.01, max: 0.2, steps: 10, scale: 'lin' as const };
      if (!axes.some(a => a.param.toUpperCase() === p.name.toUpperCase() && !a.qualifier)) {
        axes.push({
          id: newMethodId('axis'),
          param: p.name.toUpperCase(),
          fn: g.scale === 'log' ? 'log' : 'lin',
          low: g.min,
          high: g.max,
          count: g.steps,
        });
      }
    }
    search = { mode: 'grid', axes, seed: search?.seed };
  }
  if (search && search.seed !== undefined && typeof search.seed !== 'string') {
    search = { ...search, seed: toSeed(search.seed) };
  }
  const parameters = (step.parameters || []).map(p =>
    p.mode === 'grid' ? { name: p.name, mode: 'fit' as const } : p
  );
  let statistics = step.statistics;
  if (statistics) {
    // Legacy saved configs stored seeds as JS numbers; carry them as decimal strings.
    for (const key of ['mc', 'bs', 'bsn', 'mcmc'] as const) {
      const conf: ResamplingConfig | McmcConfig | undefined = statistics[key];
      if (conf && conf.seed !== undefined && typeof conf.seed !== 'string') {
        statistics = { ...statistics, [key]: { ...conf, seed: toSeed(conf.seed) } };
      }
    }
  }
  if (statistics?.mcmc) {
    const burn = statistics.mcmc.burn as unknown;
    const normBurn =
      typeof burn === 'number' ? burn : typeof burn === 'string' && /^\d+$/.test(burn) ? parseInt(burn, 10) : 'auto';
    if (normBurn !== statistics.mcmc.burn) statistics = { ...statistics, mcmc: { ...statistics.mcmc, burn: normBurn } };
  }
  return {
    ...step,
    parameters,
    residueMode: step.residueMode || 'include',
    residues: step.residues || [],
    roleRules,
    search,
    statistics,
  };
}

export function normalizeMethodConfig(config: MethodConfig): MethodConfig {
  return linkRolesFrom({ ...config, steps: (config.steps || []).map(normalizeStep) });
}

/**
 * One-off migration for configs saved before search targets stopped being
 * auto-added to FIT: makes that implicit FIT explicit, at the same position the
 * old emitter put it (unqualified targets → table FIT; qualified selectors → a FIT
 * rule directly after the table actions), so the method's roles are unchanged.
 * Applied to restored configs and templates only — never to imported TOML, whose
 * meaning is exactly what ChemEx reads.
 */
export function materializeLegacySearchFits(config: MethodConfig): MethodConfig {
  let changed = false;
  const steps = config.steps.map(raw => {
    const step = normalizeStep(raw);
    const search = step.search;
    if (!search || search.mode === 'none' || search.axes.length === 0) return step;
    const modeOf = new Map(step.parameters.map(p => [p.name.toUpperCase(), p.mode]));
    const ruleFit = new Set(
      (step.roleRules ?? []).filter(r => r.action === 'FIT').flatMap(r => r.entries.map(e => e.trim().toUpperCase()))
    );
    const parameters = [...step.parameters];
    const qualified: string[] = [];
    for (const axis of search.axes) {
      const name = axis.param.trim().toUpperCase();
      const qual = (axis.qualifier || '').trim().replace(/^,\s*/, '');
      const selector = qual ? `${name}, ${qual}` : name;
      if ((modeOf.get(name) ?? 'default') !== 'default' || ruleFit.has(selector.toUpperCase())) continue;
      if (qual) {
        if (!qualified.includes(selector)) qualified.push(selector);
      } else {
        const k = parameters.findIndex(p => p.name.toUpperCase() === name);
        if (k === -1) parameters.push({ name, mode: 'fit' });
        else parameters[k] = { ...parameters[k], mode: 'fit' };
        modeOf.set(name, 'fit');
      }
    }
    if (parameters.length === step.parameters.length && parameters.every((p, i) => p === step.parameters[i]) && qualified.length === 0) return step;
    changed = true;
    const roleRules = qualified.length
      ? [{ id: newMethodId('rule'), action: 'FIT' as const, entries: qualified }, ...(step.roleRules ?? [])]
      : step.roleRules;
    return { ...step, parameters, roleRules };
  });
  return changed ? { ...config, steps } : config;
}
