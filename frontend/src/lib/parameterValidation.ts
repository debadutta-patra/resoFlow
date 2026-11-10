import type { ParameterConfig, ParamValue } from './parameterConfig';
import type { MethodConfig, Step } from './methodConfig';
import { getNucleusInfoForModule } from './experimentPlugin';
import { effectiveBounds, fallbackDefaults, fmtDefault, type ParamDefaultsLookup } from './chemexDefaults';

export interface ParameterIssue {
  id: string;
  scope: 'global' | 'residue';
  residue?: string;
  paramKey?: string;
  severity: 'warning' | 'info';
  message: string;
}

export interface ValidationOptions {
  availableResidues?: string[]; // Residues present in experiments data
  methodConfig?: MethodConfig;
  selectedModule?: string;
  nucleusRange?: [number, number];
  nucleusLabel?: string;
  n15Range?: [number, number]; // Backwards compatibility alias
  maxDwWarn?: number;
  /** ChemEx default values/bounds (backend catalogue); defaults to the static table. */
  defaults?: ParamDefaultsLookup;
}

/** Bound checks for one value: inverted bounds, and a start value ChemEx would reject. */
function boundIssues(
  name: string,
  pv: ParamValue | undefined,
  lookup: ParamDefaultsLookup,
  where: { scope: 'global' | 'residue'; residue?: string }
): ParameterIssue[] {
  if (!pv || Number.isNaN(pv.value)) return [];
  const upperName = name.toUpperCase();
  const idBase = where.residue ? `${upperName}-${where.residue}` : upperName;
  const at = where.residue ? ` for ${where.residue}` : '';
  const issues: ParameterIssue[] = [];
  if (upperName === 'TREF' && (pv.lower !== undefined || pv.upper !== undefined)) {
    issues.push({
      id: `bounds-tref-${idBase}`,
      ...where,
      paramKey: upperName,
      severity: 'warning',
      message: 'TREF is a protected model constant: ChemEx rejects bounds on it, so they are not written.',
    });
    return issues;
  }
  if (pv.lower !== undefined && pv.upper !== undefined && pv.lower >= pv.upper) {
    issues.push({
      id: `bounds-inverted-${idBase}`,
      ...where,
      paramKey: upperName,
      severity: 'warning',
      message: `${upperName}${at}: lower bound (${fmtDefault(pv.lower)}) must be below upper bound (${fmtDefault(pv.upper)}).`,
    });
    return issues;
  }
  const { lower, upper, custom } = effectiveBounds(upperName, pv, lookup);
  const below = lower !== null && pv.value < lower;
  const above = upper !== null && pv.value > upper;
  if (below || above) {
    const range = `[${fmtDefault(lower)}, ${fmtDefault(upper)}]`;
    issues.push({
      id: `start-outside-bounds-${idBase}`,
      ...where,
      paramKey: upperName,
      severity: 'warning',
      message: `${upperName}${at} starts at ${fmtDefault(pv.value)}, outside its ${custom ? '' : 'ChemEx default '}bounds ${range}. ChemEx refuses to start a fit outside its bounds.`,
    });
  }
  return issues;
}

/** Upper-case names optimised in a step: table FIT, FIT role rules, and ChemEx's default-fit set. */
function fittedNames(step: Step, lookup: ParamDefaultsLookup): Set<string> {
  const names = new Set<string>();
  for (const p of step.parameters || []) {
    const n = p.name.toUpperCase();
    if (p.mode === 'fit' || p.mode === 'grid' || (p.mode === 'default' && lookup(n)?.vary)) names.add(n);
  }
  for (const rule of step.roleRules || []) {
    if (rule.action !== 'FIT') continue;
    for (const entry of rule.entries) {
      const n = entry.split(',')[0].trim().replace(/^\[|\]$/g, '').toUpperCase();
      if (n) names.add(n);
    }
  }
  return names;
}

/** True when a parameter carries explicit bounds anywhere in the config. */
function hasExplicitBounds(config: ParameterConfig, name: string): boolean {
  const key = name.toLowerCase();
  const isSet = (pv?: ParamValue) => !!pv && (pv.lower !== undefined || pv.upper !== undefined);
  if (isSet(config.globals?.[key])) return true;
  return Object.values(config.residues || {}).some(r => isSet(r?.[key]));
}

export function validateParameterConfig(
  config: ParameterConfig,
  options: ValidationOptions = {}
): ParameterIssue[] {
  const issues: ParameterIssue[] = [];
  const moduleInfo = options.selectedModule ? getNucleusInfoForModule(options.selectedModule) : null;
  
  const nucleusRange = options.nucleusRange || options.n15Range || (moduleInfo ? moduleInfo.sanityRange : [100, 135]);
  const nucleusLabel = options.nucleusLabel || (moduleInfo ? moduleInfo.unitLabel : 'ppm (¹⁵N)');
  const maxDwWarn = options.maxDwWarn ?? (moduleInfo ? moduleInfo.maxDwWarn : 6.0);
  const {
    availableResidues = [],
    methodConfig,
  } = options;
  const lookup = options.defaults ?? fallbackDefaults;

  // 0. Bounds (globals and residues)
  for (const [key, pv] of Object.entries(config.globals || {})) {
    issues.push(...boundIssues(key, pv, lookup, { scope: 'global' }));
  }
  for (const [resKey, params] of Object.entries(config.residues || {})) {
    for (const [key, pv] of Object.entries(params || {})) {
      issues.push(...boundIssues(key, pv, lookup, { scope: 'residue', residue: resKey }));
    }
  }

  // 1. Global parameters validation
  const pb = config.globals.pb?.value;
  if (pb !== undefined) {
    if (pb <= 0 || pb >= 1) {
      issues.push({
        id: 'global-pb-range',
        scope: 'global',
        paramKey: 'PB',
        severity: 'warning',
        message: `Excited population (p_b = ${pb}) should normally be between 0 and 1.0 (typically < 0.5).`,
      });
    }
  }

  const kex = config.globals.kex_ab?.value;
  if (kex !== undefined) {
    if (kex <= 0) {
      issues.push({
        id: 'global-kex-range',
        scope: 'global',
        paramKey: 'KEX_AB',
        severity: 'warning',
        message: `Exchange rate (k_ex = ${kex} s⁻¹) must be positive.`,
      });
    }
  }

  const tauc = config.globals.tauc_a?.value;
  if (tauc !== undefined) {
    if (tauc <= 0) {
      issues.push({
        id: 'global-tauc-range',
        scope: 'global',
        paramKey: 'TAUC_A',
        severity: 'warning',
        message: `Correlation time (τ_c = ${tauc} ns) must be positive.`,
      });
    }
  }

  // 2. Residue parameters validation
  const availableSet = new Set(availableResidues.map(r => r.toUpperCase()));
  const configResidues = Object.keys(config.residues || {});

  for (const resKey of configResidues) {
    const rParams = config.residues[resKey];
    if (!rParams) continue;

    // Check if residue is in experiment data
    if (availableSet.size > 0 && !availableSet.has(resKey.toUpperCase())) {
      // Also check with digits only
      const numOnly = resKey.replace(/\D/g, '');
      const hasMatch = Array.from(availableSet).some(ar => ar === resKey.toUpperCase() || ar.replace(/\D/g, '') === numOnly);
      if (!hasMatch) {
        issues.push({
          id: `res-missing-exp-${resKey}`,
          scope: 'residue',
          residue: resKey,
          severity: 'info',
          message: `Residue ${resKey} is present in parameters but not detected in loaded experiment data files.`,
        });
      }
    }

    // Check CS_A range
    const csa = rParams.cs_a?.value;
    if (csa !== undefined && !isNaN(csa)) {
      if (csa < nucleusRange[0] || csa > nucleusRange[1]) {
        issues.push({
          id: `res-csa-range-${resKey}`,
          scope: 'residue',
          residue: resKey,
          paramKey: 'CS_A',
          severity: 'warning',
          message: `Chemical shift CS_A (${csa.toFixed(2)} ${nucleusLabel}) is outside normal range (${nucleusRange[0]}–${nucleusRange[1]}).`,
        });
      }
    }

    // Check |DW_AB| magnitude
    const dw = rParams.dw_ab?.value;
    if (dw !== undefined && !isNaN(dw)) {
      if (Math.abs(dw) > maxDwWarn) {
        issues.push({
          id: `res-dw-range-${resKey}`,
          scope: 'residue',
          residue: resKey,
          paramKey: 'DW_AB',
          severity: 'warning',
          message: `|Δω_AB| = ${Math.abs(dw).toFixed(2)} ppm is unusually large (> ${maxDwWarn} ppm). Verify that the B-state pick is assigned correctly.`,
        });
      }
    }
  }

  // 3. Methods inclusion consistency
  if (methodConfig && methodConfig.steps) {
    for (const step of methodConfig.steps) {
      if (step.residueMode === 'include' && step.residues && step.residues.length > 0) {
        for (const incRes of step.residues) {
          const matchingParam = configResidues.find(
            cr => cr.toUpperCase() === incRes.toUpperCase() || cr.replace(/\D/g, '') === incRes.replace(/\D/g, '')
          );
          if (!matchingParam) {
            issues.push({
              id: `method-inc-missing-${incRes}`,
              scope: 'residue',
              residue: incRes,
              severity: 'warning',
              message: `Residue ${incRes} is included in Method Step "${step.name}" but has no parameters configured.`,
            });
          }
        }
      }
    }
  }

  // 4. MCMC samples a uniform prior over the effective bounds.
  if (methodConfig?.steps) {
    for (const step of methodConfig.steps) {
      if (!step.statistics?.mcmc?.enabled) continue;
      const onDefaults = Array.from(fittedNames(step, lookup))
        .filter(n => !lookup(n)?.protected && !lookup(n)?.derived && !hasExplicitBounds(config, n))
        .sort();
      if (onDefaults.length === 0) continue;
      issues.push({
        id: `mcmc-default-bounds-${step.id}`,
        scope: 'global',
        severity: 'info',
        message: `Step "${step.name}" runs MCMC, which samples a uniform prior over each parameter's bounds. ${onDefaults.join(', ')} still use ChemEx's default safety bounds; set explicit bounds if you have prior knowledge.`,
      });
    }
  }

  return issues;
}
