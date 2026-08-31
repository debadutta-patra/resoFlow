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

export type ParamMode = 'default' | 'fit' | 'fix' | 'constrain' | 'grid';

export interface GridSpec {
  min: number;
  max: number;
  steps: number;
  scale: 'lin' | 'log';
}

export interface ParamSetting {
  name: string;             // e.g. "PB", "KEX_AB", "DW_AB", "CS_A", "R2_A", "R2_B"
  mode: ParamMode;
  value?: number;           // mode === 'fix'
  bounds?: string;          // mode === 'fit', optional constraint bound e.g. "< 0.5", "> 0"
  expression?: string;      // mode === 'constrain', e.g. "0.5 * [R2_A]"
  grid?: GridSpec;          // mode === 'grid'
}

export interface ResamplingConfig {
  enabled: boolean;
  replicates: number;
  seed?: number;
}

export interface McmcConfig {
  enabled: boolean;
  steps: number;
  burn: number | 'auto';
  thin: number;
  walkers?: number;
  seed?: number;
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
  residues: string[];       // resonance ids e.g. ["13N", "14N"]
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

export const createDefaultStep = (name = 'STEP1', id?: string): Step => ({
  id: id || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `step_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`),
  name,
  parameters: [
    { name: 'PB', mode: 'default' },
    { name: 'KEX_AB', mode: 'default' },
    { name: 'DW_AB', mode: 'default' },
    { name: 'CS_A', mode: 'default' },
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
