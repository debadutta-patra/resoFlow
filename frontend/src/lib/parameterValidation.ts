import type { ParameterConfig, ParamValue } from './parameterConfig';
import { isResidueExcluded } from './parameterConfig';
import { isTcModel, obsoleteTcKeys, plainShiftResidues } from './tcModel';
import { topologyFor } from './kineticDerived';

/** State letters of an n-state model ("abc" for 3st), else null. */
const topologyStates = (model?: string): string | null => topologyFor(model ?? '')?.states ?? null;
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
  /** One-click fix offered next to the issue. */
  quickFix?:
    | { label: string; kind: 'set_global'; key: string; value: number }
    | { label: string; kind: 'convert_tc' };
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
  /** Dispersion experiments: warn when DW_AB starts at ChemEx's 0 and offer this [GLOBAL] value. */
  zeroDwQuickFix?: { value: number };
  /** Kinetic model (enables `.tc` checks). */
  model?: string;
  /** Distinct experiment temperatures (resoFlow analyses use one). */
  temperatureCount?: number;
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

/**
 * Whether `name` is optimised in `step`: an explicit FIT (table, FIT rule, GRID), else ChemEx's
 * default role unless the table or a FIX/CONSTRAIN rule overrides it (last rule wins).
 */
function isFitted(step: Step, name: string, lookup: ParamDefaultsLookup): boolean {
  const upper = name.toUpperCase();
  let fitted = !!lookup(upper)?.vary;
  const row = (step.parameters || []).find(p => p.name.toUpperCase() === upper);
  if (row && row.mode !== 'default') fitted = row.mode === 'fit' || row.mode === 'grid';
  for (const rule of step.roleRules || []) {
    for (const entry of rule.entries) {
      const target = entry.split(/[,=]/)[0].trim().replace(/^\[|\]$/g, '').toUpperCase();
      if (target === upper) fitted = rule.action === 'FIT';
    }
  }
  return fitted;
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
  const maxDwWarn = options.maxDwWarn ?? (moduleInfo ? moduleInfo.maxDwWarn : 15.0);
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
          severity: 'info',
          message: `|DW_AB| = ${Math.abs(dw).toFixed(2)} ppm is above ${maxDwWarn} ppm (${nucleusLabel}). Large shift differences do occur (ChemEx's own 15N CEST example uses 12.5 ppm); check the B-state assignment.`,
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

  // 4. Dispersion: Rex has zero gradient in Δω at ChemEx's default DW_AB = 0.
  if (options.zeroDwQuickFix && !config.globals?.dw_ab) {
    const residues = availableResidues.length > 0 ? availableResidues : configResidues;
    const atZero = residues.filter(r => {
      if (isResidueExcluded(config, r)) return false;
      const dw = config.residues?.[r]?.dw_ab?.value;
      return dw === undefined || dw === 0;
    });
    if (atZero.length > 0) {
      const v = options.zeroDwQuickFix.value;
      issues.push({
        id: 'dw-zero-start',
        scope: 'global',
        paramKey: 'DW_AB',
        severity: 'warning',
        message: `${atZero.length} residue${atZero.length === 1 ? '' : 's'} start DW_AB at ChemEx's default of 0 ppm. Rex has zero gradient with respect to Δω there, so the fit can stall. ChemEx's own CPMG examples set [GLOBAL] DW_AB = ${v}.`,
        quickFix: { label: `Set [GLOBAL] DW_AB = ${v}`, kind: 'set_global', key: 'dw_ab', value: v },
      });
    }
  }

  // 5. `.tc` models: plain CS_A/DW_AB freeze the shifts; free order-0/order-1 pairs are
  //    degenerate at a single temperature; DWP/DWM were removed.
  if (isTcModel(options.model)) {
    const plain = plainShiftResidues(config);
    if (plain.length > 0) {
      issues.push({
        id: 'tc-plain-shifts',
        scope: 'global',
        paramKey: 'CS_A/DW_AB',
        severity: 'warning',
        message: `${plain.length} residue${plain.length === 1 ? ' sets' : 's set'} plain CS_A/DW_AB. Under .tc these are model-owned: ChemEx accepts them but turns them into fixed constants, so the CS0/CS1 and DW0/DW1 coefficients no longer apply and DW is not fitted. Set CS0_A/DW0_AB instead.`,
        quickFix: { label: 'Move to CS0_A / DW0_AB', kind: 'convert_tc' },
      });
    }
    const obsolete = obsoleteTcKeys(config);
    if (obsolete.length > 0) {
      issues.push({
        id: 'tc-obsolete-dwp-dwm',
        scope: 'global',
        paramKey: obsolete.join(', '),
        severity: 'warning',
        message: `${obsolete.join(', ')} were removed in ChemEx 2026.9 (no alias); ChemEx refuses the file. Re-import it to convert: DW0_AX = DWP_AX + TREF·DWM_AX, DW1_AX = DWM_AX.`,
      });
    }
    const singleT = (options.temperatureCount ?? 1) <= 1;
    if (singleT && methodConfig?.steps) {
      for (const step of methodConfig.steps) {
        const stateLetters = (topologyStates(options.model) ?? 'ab').slice(1).toUpperCase().split('');
        const pairs = [['CS0_A', 'CS1_A'], ...stateLetters.map(s => [`DW0_A${s}`, `DW1_A${s}`])].filter(
          ([a, b]) => isFitted(step, a, lookup) && isFitted(step, b, lookup)
        );
        if (pairs.length === 0) continue;
        issues.push({
          id: `tc-degenerate-${step.id}`,
          scope: 'global',
          paramKey: pairs.map(p => p.join('/')).join(', '),
          severity: 'warning',
          message: `Step "${step.name}" fits ${pairs.map(p => `${p[0]} and ${p[1]}`).join(', ')} with data at a single temperature: an order-0 and order-1 coefficient then enter only as one combination and cannot be estimated independently. Fix or constrain one of each pair (e.g. FIX DW1_AB), or add data at other temperatures.`,
        });
      }
    }
  }

  // 6. MCMC samples a uniform prior over the effective bounds.
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
