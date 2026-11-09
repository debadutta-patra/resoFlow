import type { MethodConfig, ParamSetting, SearchMode, Step } from './methodConfig';
import { createSearchAxis, type ExperimentFamily } from './searchDefaults';

export interface MethodTemplate {
  id: string;
  name: string;
  description: string;
  /** Experiment families this template is aimed at (shown first for those families). */
  families?: ExperimentFamily[];
  config: MethodConfig;
}

const relaxTied2st: ParamSetting[] = [
  { name: 'R1_A', mode: 'fix' },
  { name: 'R2_A', mode: 'fix' },
  { name: 'R1_B', mode: 'constrain', expression: '[R1_A]' },
  { name: 'R2_B', mode: 'constrain', expression: '[R2_A]' },
];

const step = (id: string, name: string, parameters: ParamSetting[], extra: Partial<Step> = {}): Step => ({
  id,
  name,
  parameters,
  residueMode: 'include',
  residues: [],
  roleRules: [],
  ...extra,
});

const search = (mode: Exclude<SearchMode, 'none'>, family: ExperimentFamily, params: string[], seed?: string) => ({
  mode,
  axes: params.map(p => createSearchAxis(p, mode, family)),
  ...(seed !== undefined ? { seed } : {}),
});

function gridThenRefine(family: ExperimentFamily, id: string, name: string, description: string, base: ParamSetting[]): MethodTemplate {
  return {
    id,
    name,
    description,
    families: [family],
    config: {
      steps: [
        step(`${id}_grid`, 'GRID_SEARCH', base, { search: search('grid', family, ['PB', 'KEX_AB']) }),
        step(`${id}_refine`, 'REFINE', [
          { name: 'PB', mode: 'fit' },
          { name: 'KEX_AB', mode: 'fit' },
        ], { rolesFrom: 'GRID_SEARCH' }),
      ],
    },
  };
}

export const METHOD_TEMPLATES: MethodTemplate[] = [
  {
    id: '2st_standard_cpmg',
    name: '2-State Standard CPMG',
    description: 'Standard 2-state CPMG relaxation dispersion fit of PB, KEX_AB, |DW_AB| and R2_A, with R2_B tied to R2_A.',
    families: ['cpmg'],
    config: {
      steps: [
        step('step_2st_cpmg', 'STEP1', [
          { name: 'PB', mode: 'fit' },
          { name: 'KEX_AB', mode: 'fit' },
          { name: 'DW_AB', mode: 'fit' },
          { name: 'R2_A', mode: 'fit' },
          { name: 'R2_B', mode: 'constrain', expression: '[R2_A]' },
        ]),
      ],
    },
  },
  {
    id: '2st_standard',
    name: '2-State Standard CEST',
    description: 'Standard 2-state CEST fit of PB, KEX_AB, DW_AB and CS_A; R1/R2 of state A fixed, state B tied to A.',
    families: ['cest'],
    config: {
      steps: [
        step('step_2st_std', 'STEP1', [
          { name: 'PB', mode: 'fit' },
          { name: 'KEX_AB', mode: 'fit' },
          { name: 'DW_AB', mode: 'fit' },
          { name: 'CS_A', mode: 'fit' },
          ...relaxTied2st,
        ]),
      ],
    },
  },
  {
    id: '3st_standard',
    name: '3-State Multi-Pathway CEST',
    description: 'Fit 3-state exchange populations (PB, PC), exchange rates (KEX_AB, KEX_AC), and shift differences.',
    families: ['cest'],
    config: {
      steps: [
        step('step_3st_std', 'STEP1', [
          { name: 'PB', mode: 'fit' },
          { name: 'PC', mode: 'fit' },
          { name: 'KEX_AB', mode: 'fit' },
          { name: 'KEX_AC', mode: 'fit' },
          { name: 'CS_A', mode: 'fit' },
          { name: 'DW_AB', mode: 'fit' },
          { name: 'DW_AC', mode: 'fit' },
          ...relaxTied2st,
          { name: 'R1_C', mode: 'constrain', expression: '[R1_A]' },
          { name: 'R2_C', mode: 'constrain', expression: '[R2_A]' },
        ]),
      ],
    },
  },
  gridThenRefine(
    'cest',
    'grid_and_refine',
    'Grid Search → Refinement (CEST)',
    'Step 1 profiles χ² on a log grid of PB (0.5–20 %) and KEX_AB (20–2000 s⁻¹) while fitting DW_AB/CS_A; Step 2 inherits the roles and releases PB and KEX_AB in a full TRF for covariance errors.',
    [{ name: 'DW_AB', mode: 'fit' }, { name: 'CS_A', mode: 'fit' }, ...relaxTied2st]
  ),
  gridThenRefine(
    'cpmg',
    'grid_and_refine_cpmg',
    'Grid Search → Refinement (CPMG)',
    'Step 1 profiles χ² on a log grid of PB (0.5–20 %) and KEX_AB (10²–10⁴ s⁻¹) while fitting |DW_AB| and R2_A; Step 2 releases PB and KEX_AB in a full TRF.',
    [{ name: 'DW_AB', mode: 'fit' }, { name: 'R2_A', mode: 'fit' }, { name: 'R2_B', mode: 'constrain', expression: '[R2_A]' }]
  ),
  {
    id: 'de_then_trf',
    name: 'Differential Evolution → TRF',
    description: 'Stochastic DE over the basin-defining PB and KEX_AB (other fitted coordinates held at their start), seeding one full-coordinate TRF. Use when the χ² surface has several minima.',
    config: {
      steps: [
        step('step_de', 'DE_FIT', [
          { name: 'PB', mode: 'fit' },
          { name: 'KEX_AB', mode: 'fit' },
          { name: 'DW_AB', mode: 'fit' },
          { name: 'CS_A', mode: 'fit' },
          ...relaxTied2st,
        ], { search: search('de', 'cest', ['PB', 'KEX_AB'], '597') }),
      ],
    },
  },
  {
    id: 'global_then_local',
    name: 'Global → Local Fits',
    description: 'Step 1 fits the global exchange parameters on all (or selected) residues; Step 2 inherits the roles, fixes PB and KEX_AB and refits the residue-specific DW_AB.',
    config: {
      steps: [
        step('step_global', 'GLOBAL_FIT', [
          { name: 'PB', mode: 'fit' },
          { name: 'KEX_AB', mode: 'fit' },
          { name: 'DW_AB', mode: 'fit' },
          { name: 'CS_A', mode: 'fit' },
          ...relaxTied2st,
        ]),
        step('step_local', 'LOCAL_FITS', [
          { name: 'PB', mode: 'fix' },
          { name: 'KEX_AB', mode: 'fix' },
          { name: 'DW_AB', mode: 'fit' },
        ], { rolesFrom: 'GLOBAL_FIT' }),
      ],
    },
  },
  {
    id: '2st_standard_exchange',
    name: '2-State Combined Exchange (CEST + CPMG)',
    description: 'Joint fit of CEST and CPMG data for PB, KEX_AB, DW_AB and CS_A.',
    families: ['exchange'],
    config: {
      steps: [
        step('step_2st_exchange', 'STEP1', [
          { name: 'PB', mode: 'fit' },
          { name: 'KEX_AB', mode: 'fit' },
          { name: 'DW_AB', mode: 'fit' },
          { name: 'CS_A', mode: 'fit' },
          ...relaxTied2st,
        ]),
      ],
    },
  },
  gridThenRefine(
    'exchange',
    'grid_and_refine_exchange',
    'Grid Search → Refinement (Exchange)',
    'Joint CEST+CPMG: Step 1 grids PB (0.5–20 %) and KEX_AB (20–10⁴ s⁻¹, log); Step 2 releases them in a full TRF.',
    [{ name: 'DW_AB', mode: 'fit' }, { name: 'CS_A', mode: 'fit' }, ...relaxTied2st]
  ),
];
