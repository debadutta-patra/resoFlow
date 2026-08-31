/**
 * Unit Registry declaring ChemEx expected units, UI display units,
 * range bounds, precision, and conversions.
 */

export interface ParamUnitDef {
  name: string;
  label: string;
  chemexUnit: string;
  uiUnit: string;
  scope: 'global' | 'residue';
  category: 'kinetic' | 'chemical_shift' | 'relaxation' | 'hydrodynamic';
  min?: number;
  max?: number;
  step?: number;
  precision: number;
  gloss: string;
  toChemEx: (uiVal: number) => number;
  fromChemEx: (chemexVal: number) => number;
}

const REGISTRY: Record<string, ParamUnitDef> = {
  PB: {
    name: 'PB',
    label: 'p_b (Minor State Population)',
    chemexUnit: 'fraction',
    uiUnit: 'fraction',
    scope: 'global',
    category: 'kinetic',
    min: 0,
    max: 1,
    step: 0.001,
    precision: 4,
    gloss: 'Population of minor state B (0 - 1.0)',
    toChemEx: (v) => v,
    fromChemEx: (v) => v,
  },
  KEX_AB: {
    name: 'KEX_AB',
    label: 'k_ex (Exchange Rate)',
    chemexUnit: 's⁻¹',
    uiUnit: 's⁻¹',
    scope: 'global',
    category: 'kinetic',
    min: 0.01,
    step: 1,
    precision: 2,
    gloss: 'Exchange rate between states A and B (s⁻¹)',
    toChemEx: (v) => v,
    fromChemEx: (v) => v,
  },
  TAUC_A: {
    name: 'TAUC_A',
    label: 'τ_c (Correlation Time)',
    chemexUnit: 'ns',
    uiUnit: 'ns',
    scope: 'global',
    category: 'hydrodynamic',
    min: 0.01,
    step: 0.1,
    precision: 2,
    gloss: 'Rotational correlation time (ns). ChemEx calculates τ = TAUC × 10⁻⁹ s.',
    toChemEx: (v) => v,
    fromChemEx: (v) => v,
  },
  CS_A: {
    name: 'CS_A',
    label: 'CS_A (Major State Shift)',
    chemexUnit: 'ppm',
    uiUnit: 'ppm',
    scope: 'residue',
    category: 'chemical_shift',
    step: 0.01,
    precision: 3,
    gloss: 'Chemical shift of ground state A (ppm)',
    toChemEx: (v) => v,
    fromChemEx: (v) => v,
  },
  DW_AB: {
    name: 'DW_AB',
    label: 'Δω_AB (Shift Difference)',
    chemexUnit: 'ppm',
    uiUnit: 'ppm',
    scope: 'residue',
    category: 'chemical_shift',
    step: 0.01,
    precision: 3,
    gloss: 'Chemical shift difference between states B and A: CS_B - CS_A (ppm)',
    toChemEx: (v) => v,
    fromChemEx: (v) => v,
  },
  DW_AC: {
    name: 'DW_AC',
    label: 'Δω_AC (Shift Difference)',
    chemexUnit: 'ppm',
    uiUnit: 'ppm',
    scope: 'residue',
    category: 'chemical_shift',
    step: 0.01,
    precision: 3,
    gloss: 'Chemical shift difference between states C and A: CS_C - CS_A (ppm)',
    toChemEx: (v) => v,
    fromChemEx: (v) => v,
  },
  DW_AD: {
    name: 'DW_AD',
    label: 'Δω_AD (Shift Difference)',
    chemexUnit: 'ppm',
    uiUnit: 'ppm',
    scope: 'residue',
    category: 'chemical_shift',
    step: 0.01,
    precision: 3,
    gloss: 'Chemical shift difference between states D and A (ppm)',
    toChemEx: (v) => v,
    fromChemEx: (v) => v,
  },
  DW_AE: {
    name: 'DW_AE',
    label: 'Δω_AE (Shift Difference)',
    chemexUnit: 'ppm',
    uiUnit: 'ppm',
    scope: 'residue',
    category: 'chemical_shift',
    step: 0.01,
    precision: 3,
    gloss: 'Chemical shift difference between states E and A (ppm)',
    toChemEx: (v) => v,
    fromChemEx: (v) => v,
  },
  DW_AF: {
    name: 'DW_AF',
    label: 'Δω_AF (Shift Difference)',
    chemexUnit: 'ppm',
    uiUnit: 'ppm',
    scope: 'residue',
    category: 'chemical_shift',
    step: 0.01,
    precision: 3,
    gloss: 'Chemical shift difference between states F and A (ppm)',
    toChemEx: (v) => v,
    fromChemEx: (v) => v,
  },
  R1_A: {
    name: 'R1_A',
    label: 'R1_A (Longitudinal Rate)',
    chemexUnit: 's⁻¹',
    uiUnit: 's⁻¹',
    scope: 'residue',
    category: 'relaxation',
    min: 0.0001,
    step: 0.01,
    precision: 4,
    gloss: 'Longitudinal relaxation rate of state A (s⁻¹)',
    toChemEx: (v) => v,
    fromChemEx: (v) => v,
  },
  R2_A: {
    name: 'R2_A',
    label: 'R2_A (Transverse Rate)',
    chemexUnit: 's⁻¹',
    uiUnit: 's⁻¹',
    scope: 'residue',
    category: 'relaxation',
    min: 0.01,
    step: 0.1,
    precision: 4,
    gloss: 'Transverse relaxation rate of state A (s⁻¹)',
    toChemEx: (v) => v,
    fromChemEx: (v) => v,
  },
  R1_B: {
    name: 'R1_B',
    label: 'R1_B (Longitudinal Rate)',
    chemexUnit: 's⁻¹',
    uiUnit: 's⁻¹',
    scope: 'residue',
    category: 'relaxation',
    min: 0.0001,
    step: 0.01,
    precision: 4,
    gloss: 'Longitudinal relaxation rate of state B (s⁻¹)',
    toChemEx: (v) => v,
    fromChemEx: (v) => v,
  },
  R2_B: {
    name: 'R2_B',
    label: 'R2_B (Transverse Rate)',
    chemexUnit: 's⁻¹',
    uiUnit: 's⁻¹',
    scope: 'residue',
    category: 'relaxation',
    min: 0.01,
    step: 0.1,
    precision: 4,
    gloss: 'Transverse relaxation rate of state B (s⁻¹)',
    toChemEx: (v) => v,
    fromChemEx: (v) => v,
  },
};

/**
 * Returns unit definition for a parameter name (case-insensitive).
 */
export function getUnitDef(name: string): ParamUnitDef {
  const upper = name.toUpperCase();
  if (REGISTRY[upper]) return REGISTRY[upper];
  // Default fallback for dynamic/unknown parameters
  return {
    name: upper,
    label: upper,
    chemexUnit: '',
    uiUnit: '',
    scope: upper.includes('_') ? 'residue' : 'global',
    category: 'kinetic',
    precision: 3,
    gloss: `Parameter ${upper}`,
    toChemEx: (v) => v,
    fromChemEx: (v) => v,
  };
}

/**
 * Formats a value according to its parameter precision and unit.
 */
export function formatParamValue(name: string, value: number | null | undefined): string {
  if (value === null || value === undefined || isNaN(value)) return '—';
  const def = getUnitDef(name);
  return value.toFixed(def.precision);
}
