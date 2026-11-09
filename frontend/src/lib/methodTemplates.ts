/**
 * Method templates. `kind: 'method'` replaces the whole method with a valid v2
 * config; `kind: 'addition'` changes the current method (e.g. add constraints to the
 * active step, append a statistics step) through a pure `apply` function.
 */

import type { MethodConfig, ParamSetting, SearchMode, Step } from './methodConfig';
import { newMethodId } from './methodConfig';
import { setRolesFrom, stepDisplayName, uniqueStepName } from './methodSteps';
import { createSearchAxis, type ExperimentFamily } from './searchDefaults';

interface TemplateBase {
  id: string;
  name: string;
  /** One line. */
  description: string;
  /** Experiment families this template is aimed at (shown first for those families). */
  families?: ExperimentFamily[];
  /** Kinetic model the template's parameters assume (default '2st'). */
  model?: string;
}

export interface MethodReplacementTemplate extends TemplateBase {
  kind: 'method';
  config: MethodConfig;
}

export interface MethodAdditionTemplate extends TemplateBase {
  kind: 'addition';
  /** Returns the changed method and the step to show. */
  apply: (config: MethodConfig, activeStepIdx: number) => { config: MethodConfig; activeStepIdx: number };
}

export type MethodTemplate = MethodReplacementTemplate | MethodAdditionTemplate;

const step = (id: string, name: string, parameters: ParamSetting[], extra: Partial<Step> = {}): Step => ({
  id,
  name,
  parameters,
  residueMode: 'all',
  residues: [],
  roleRules: [],
  ...extra,
});

const fit = (...names: string[]): ParamSetting[] => names.map(name => ({ name, mode: 'fit' as const }));
const fix = (...names: string[]): ParamSetting[] => names.map(name => ({ name, mode: 'fix' as const }));

/** State B relaxation tied to state A (ChemEx constraints `[R2_B] = [R2_A]`, `[R1_B] = [R1_A]`). */
export const TIE_B_TO_A = ['[R2_B] = [R2_A]', '[R1_B] = [R1_A]'];

const search = (mode: Exclude<SearchMode, 'none'>, family: ExperimentFamily, params: string[], seed?: string) => ({
  mode,
  axes: params.map(p => createSearchAxis(p, mode, family)),
  ...(seed !== undefined ? { seed } : {}),
});

function gridThenRefine(family: ExperimentFamily, label: string, local: ParamSetting[]): MethodReplacementTemplate {
  const grid = step(`grid_${family}`, 'GRID_SEARCH', [...fit('PB', 'KEX_AB'), ...local], {
    search: search('grid', family, ['PB', 'KEX_AB']),
  });
  return {
    kind: 'method',
    id: `grid_and_refine_${family}`,
    name: `GRID → TRF refine (${label})`,
    description: 'Profile χ² over a PB × KEX_AB grid, then a TRF step (ROLES_FROM the grid) that releases both and gives covariance errors.',
    families: [family],
    config: { steps: [grid, setRolesFrom(step(`refine_${family}`, 'REFINE', []), grid, 0)] },
  };
}

const globalFit = step('global_fit', 'GLOBAL_FIT', fit('PB', 'KEX_AB', 'DW_AB'));

export const METHOD_TEMPLATES: MethodTemplate[] = [
  {
    kind: 'method',
    id: '2st_standard',
    name: '2-state CEST',
    description: 'One TRF fit of PB, KEX_AB, DW_AB and CS_A; R1_A/R2_A fixed and state-B relaxation tied to A.',
    families: ['cest'],
    config: {
      steps: [step('std_cest', 'STEP1', [...fit('PB', 'KEX_AB', 'DW_AB', 'CS_A'), ...fix('R1_A', 'R2_A')], {
        roleRules: [{ id: 'tie_cest', action: 'CONSTRAIN', entries: TIE_B_TO_A }],
      })],
    },
  },
  {
    kind: 'method',
    id: '2st_standard_cpmg',
    name: '2-state CPMG',
    description: 'One TRF fit of PB, KEX_AB, |DW_AB| and R2_A with R2_B tied to R2_A.',
    families: ['cpmg'],
    config: {
      steps: [step('std_cpmg', 'STEP1', [...fit('PB', 'KEX_AB', 'DW_AB', 'R2_A'), { name: 'R2_B', mode: 'constrain', expression: '[R2_A]' }])],
    },
  },
  {
    kind: 'method',
    id: '2st_standard_exchange',
    name: '2-state CEST + CPMG',
    description: 'Joint TRF fit of CEST and CPMG data for PB, KEX_AB, DW_AB and CS_A with state-B relaxation tied to A.',
    families: ['exchange'],
    config: {
      steps: [step('std_exchange', 'STEP1', fit('PB', 'KEX_AB', 'DW_AB', 'CS_A'), {
        roleRules: [{ id: 'tie_exchange', action: 'CONSTRAIN', entries: TIE_B_TO_A }],
      })],
    },
  },
  {
    kind: 'method',
    id: 'two_step_global_local',
    name: 'Two-step: global → local fits',
    description: 'GLOBAL_FIT fits PB/KEX_AB (restrict its selection to well-behaved residues); LOCAL_FITS then fits DW_AB on all profiles with them fixed.',
    families: ['cest', 'exchange'],
    config: {
      steps: [
        globalFit,
        setRolesFrom(step('local_fits', 'LOCAL_FITS', [...fix('PB', 'KEX_AB'), ...fit('DW_AB')]), globalFit, 0),
      ],
    },
  },
  gridThenRefine('cest', 'CEST', fit('DW_AB', 'CS_A')),
  gridThenRefine('cpmg', 'CPMG', fit('DW_AB', 'R2_A')),
  gridThenRefine('exchange', 'CEST + CPMG', fit('DW_AB', 'CS_A')),
  {
    kind: 'method',
    id: 'de_seeding',
    name: 'DE seeding → TRF',
    description: "ChemEx's method_de.toml pattern for 2 states: DE over PB and KEX_AB (SEED 597; re-roll freely) seeds one full TRF.",
    config: {
      steps: [step('de', 'DE', fit('PB', 'KEX_AB', 'DW_AB', 'CS_A'), {
        search: {
          mode: 'de',
          seed: '597',
          axes: [
            { id: newMethodId('axis'), param: 'PB', fn: 'log', low: 0.001, high: 0.2, count: 0 },
            { id: newMethodId('axis'), param: 'KEX_AB', fn: 'log', low: 10, high: 5000, count: 0 },
          ],
        },
      })],
    },
  },
  {
    kind: 'method',
    id: '3st_standard',
    name: '3-state CEST',
    description: 'One TRF fit of PB, PC, KEX_AB, KEX_AC and the shifts; relaxation of states B and C tied to A.',
    families: ['cest'],
    model: '3st',
    config: {
      steps: [step('std_3st', 'STEP1', [...fit('PB', 'PC', 'KEX_AB', 'KEX_AC', 'CS_A', 'DW_AB', 'DW_AC'), ...fix('R1_A', 'R2_A')], {
        roleRules: [{ id: 'tie_3st', action: 'CONSTRAIN', entries: [...TIE_B_TO_A, '[R2_C] = [R2_A]', '[R1_C] = [R1_A]'] }],
      })],
    },
  },
  {
    kind: 'addition',
    id: 'tie_b_relaxation',
    name: 'Tie state-B relaxation to A',
    description: 'Adds CONSTRAIN [R2_B] = [R2_A] and [R1_B] = [R1_A] as the last rule of the current step.',
    apply: (config, activeStepIdx) => {
      const steps = config.steps.map((s, i) => {
        if (i !== activeStepIdx) return s;
        const present = new Set((s.roleRules ?? []).filter(r => r.action === 'CONSTRAIN').flatMap(r => r.entries.map(e => e.replace(/\s+/g, ''))));
        const entries = TIE_B_TO_A.filter(e => !present.has(e.replace(/\s+/g, '')));
        return entries.length ? { ...s, roleRules: [...(s.roleRules ?? []), { id: newMethodId('rule'), action: 'CONSTRAIN' as const, entries }] } : s;
      });
      return { config: { ...config, steps }, activeStepIdx };
    },
  },
  {
    kind: 'addition',
    id: 'final_statistics',
    name: 'Final statistics step (MC + BS)',
    description: 'Appends a step with ROLES_FROM the last step and the same selection that refits and runs MC (100) and BS (100).',
    apply: config => {
      const lastIdx = config.steps.length - 1;
      const last = config.steps[lastIdx];
      const stats: Step = setRolesFrom(
        step(newMethodId('step'), uniqueStepName('FINAL_STATISTICS', config.steps), [], {
          residueMode: last?.residueMode ?? 'all',
          residues: [...(last?.residues ?? [])],
          statistics: { mc: { enabled: true, replicates: 100 }, bs: { enabled: true, replicates: 100 } },
        }),
        last,
        lastIdx
      );
      return { config: { ...config, steps: [...config.steps, stats] }, activeStepIdx: config.steps.length };
    },
  },
];

/** Name of the step a template addition targets, for the confirmation text. */
export const additionTarget = (t: MethodAdditionTemplate, config: MethodConfig, activeStepIdx: number): string =>
  t.id === 'final_statistics' ? `after ${stepDisplayName(config.steps[config.steps.length - 1] ?? { name: '' }, config.steps.length - 1)}` : `to ${stepDisplayName(config.steps[activeStepIdx] ?? { name: '' }, activeStepIdx)}`;
