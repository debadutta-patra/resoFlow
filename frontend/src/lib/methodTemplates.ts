import type { MethodConfig } from './methodConfig';

export interface MethodTemplate {
  id: string;
  name: string;
  description: string;
  config: MethodConfig;
}

export const METHOD_TEMPLATES: MethodTemplate[] = [
  {
    id: '2st_standard_cpmg',
    name: '2-State Standard CPMG',
    description: 'Standard 2-state CPMG relaxation dispersion fit for population (PB), exchange rate (KEX_AB), chemical shift difference (|DW_AB|), and transverse relaxation (R2_A).',
    config: {
      steps: [
        {
          id: 'step_2st_cpmg',
          name: 'STEP1',
          parameters: [
            { name: 'PB', mode: 'fit', bounds: '< 0.5' },
            { name: 'KEX_AB', mode: 'fit' },
            { name: 'DW_AB', mode: 'fit' },
            { name: 'R2_A', mode: 'fit' },
            { name: 'R2_B', mode: 'constrain', expression: '[R2_A]' },
          ],
          residueMode: 'include',
          residues: [],
        },
      ],
    },
  },
  {
    id: '2st_standard',
    name: '2-State Standard CEST',
    description: 'Standard 2-state exchange fit for excited state population (PB), exchange rate (KEX_AB), and chemical shifts.',
    config: {
      steps: [
        {
          id: 'step_2st_std',
          name: 'STEP1',
          parameters: [
            { name: 'PB', mode: 'fit', bounds: '< 0.5' },
            { name: 'KEX_AB', mode: 'fit' },
            { name: 'DW_AB', mode: 'fit' },
            { name: 'CS_A', mode: 'fit' },
            { name: 'R1_A', mode: 'fix' },
            { name: 'R2_A', mode: 'fix' },
            { name: 'R1_B', mode: 'constrain', expression: '[R1_A]' },
            { name: 'R2_B', mode: 'constrain', expression: '[R2_A]' },
          ],
          residueMode: 'include',
          residues: [],
        },
      ],
    },
  },

  {
    id: '3st_standard',
    name: '3-State Multi-Pathway CEST',
    description: 'Fit 3-state exchange populations (PB, PC), exchange rates (KEX_AB, KEX_AC), and shift differences.',
    config: {
      steps: [
        {
          id: 'step_3st_std',
          name: 'STEP1',
          parameters: [
            { name: 'PB', mode: 'fit', bounds: '< 0.5' },
            { name: 'PC', mode: 'fit', bounds: '< 0.5' },
            { name: 'KEX_AB', mode: 'fit' },
            { name: 'KEX_AC', mode: 'fit' },
            { name: 'CS_A', mode: 'fit' },
            { name: 'DW_AB', mode: 'fit' },
            { name: 'DW_AC', mode: 'fit' },
            { name: 'R1_A', mode: 'fix' },
            { name: 'R2_A', mode: 'fix' },
            { name: 'R1_B', mode: 'constrain', expression: '[R1_A]' },
            { name: 'R2_B', mode: 'constrain', expression: '[R2_A]' },
            { name: 'R1_C', mode: 'constrain', expression: '[R1_A]' },
            { name: 'R2_C', mode: 'constrain', expression: '[R2_A]' },
          ],
          residueMode: 'include',
          residues: [],
        },
      ],
    },
  },
  {
    id: 'grid_and_refine',
    name: 'Grid Search → Refinement',
    description: 'Two-step protocol: Step 1 performs a global grid search over PB and KEX_AB to avoid local minima, followed by Step 2 free parameter refinement.',
    config: {
      steps: [
        {
          id: 'step_grid',
          name: 'GRID_SEARCH',
          parameters: [
            {
              name: 'PB',
              mode: 'grid',
              grid: { min: 0.01, max: 0.25, steps: 20, scale: 'lin' },
            },
            {
              name: 'KEX_AB',
              mode: 'grid',
              grid: { min: 50, max: 2500, steps: 25, scale: 'lin' },
            },
            { name: 'DW_AB', mode: 'fit' },
            { name: 'CS_A', mode: 'fit' },
          ],
          residueMode: 'include',
          residues: [],
        },
        {
          id: 'step_refine',
          name: 'REFINEMENT',
          parameters: [
            { name: 'PB', mode: 'fit', bounds: '< 0.5' },
            { name: 'KEX_AB', mode: 'fit' },
            { name: 'DW_AB', mode: 'fit' },
            { name: 'CS_A', mode: 'fit' },
            { name: 'R1_A', mode: 'fix' },
            { name: 'R2_A', mode: 'fix' },
          ],
          residueMode: 'include',
          residues: [],
        },
      ],
    },
  },
];
