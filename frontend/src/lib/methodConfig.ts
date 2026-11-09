import { type Seed, randomSeed as randomU64Seed, toSeed } from './seed';
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
 *   1. baseline model roles, or the effective roles of `rolesFrom` (ROLES_FROM)
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
  /** ROLES_FROM: name of an earlier step whose effective roles this step starts from. */
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
  return { ...config, steps: (config.steps || []).map(normalizeStep) };
}
