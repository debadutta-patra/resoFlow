import type { MethodConfig } from './methodConfig';

export interface ValidationError {
  stepId: string;
  stepName: string;
  paramName?: string;
  message: string;
  severity: 'error' | 'warning';
}

export type MethodValidationError = ValidationError;

/**
 * Validates a MethodConfig against known parameters and ChemEx consistency rules.
 */
export function validateMethodConfig(
  config: MethodConfig,
  knownParamNames: string[] = ['PB', 'PC', 'KEX_AB', 'KEX_AC', 'KEX_BC', 'CS_A', 'DW_AB', 'DW_AC', 'R1_A', 'R2_A', 'R1_B', 'R2_B', 'R1_C', 'R2_C', 'TAUC_A'],
  totalAvailableResiduesCount = 0
): ValidationError[] {
  const errors: ValidationError[] = [];
  const knownUpper = new Set(knownParamNames.map(n => n.toUpperCase()));

  if (!config.steps || config.steps.length === 0) {
    errors.push({
      stepId: 'global',
      stepName: 'Global',
      message: 'Method configuration must have at least one step.',
      severity: 'error',
    });
    return errors;
  }

  // Check unique step names
  const seenStepNames = new Set<string>();

  for (let i = 0; i < config.steps.length; i++) {
    const step = config.steps[i];
    const stepName = (step.name || `STEP${i + 1}`).trim().toUpperCase();

    if (seenStepNames.has(stepName)) {
      errors.push({
        stepId: step.id,
        stepName,
        message: `Duplicate step name "${stepName}". Step names must be unique.`,
        severity: 'error',
      });
    }
    seenStepNames.add(stepName);

    // 1. Step must have something to optimize
    const fitParams = step.parameters.filter(p => p.mode === 'fit');
    const gridParams = step.parameters.filter(p => p.mode === 'grid');
    if (fitParams.length === 0 && gridParams.length === 0) {
      errors.push({
        stepId: step.id,
        stepName,
        message: `Step "${stepName}" has no parameters in FIT and no GRID search defined.`,
        severity: 'warning',
      });
    }

    // 2. Validate individual parameters
    const paramModes = new Map<string, string>();

    for (const param of step.parameters) {
      const uName = param.name.toUpperCase();

      // Check parameter name against known list
      if (knownUpper.size > 0 && !knownUpper.has(uName)) {
        errors.push({
          stepId: step.id,
          stepName,
          paramName: uName,
          message: `Unknown parameter "${uName}". Please check spelling.`,
          severity: 'warning',
        });
      }

      // Check duplicate mode definitions in same step
      if (paramModes.has(uName)) {
        errors.push({
          stepId: step.id,
          stepName,
          paramName: uName,
          message: `Parameter "${uName}" is defined multiple times in step "${stepName}".`,
          severity: 'error',
        });
      }
      paramModes.set(uName, param.mode);

      // Validate expression in constrain mode
      if (param.mode === 'constrain') {
        const expr = param.expression || '';
        if (!expr.trim()) {
          errors.push({
            stepId: step.id,
            stepName,
            paramName: uName,
            message: `Constraint for "${uName}" has an empty expression.`,
            severity: 'error',
          });
        } else {
          // Check bracket balance
          const openBrackets = (expr.match(/\[/g) || []).length;
          const closeBrackets = (expr.match(/\]/g) || []).length;
          if (openBrackets !== closeBrackets) {
            errors.push({
              stepId: step.id,
              stepName,
              paramName: uName,
              message: `Unmatched brackets in constraint expression for "${uName}".`,
              severity: 'error',
            });
          }

          // Check referenced parameter names
          const referencedParams = Array.from(expr.matchAll(/\[([A-Za-z0-9_]+)\]/g)).map(m => m[1].toUpperCase());
          for (const ref of referencedParams) {
            if (knownUpper.size > 0 && !knownUpper.has(ref)) {
              errors.push({
                stepId: step.id,
                stepName,
                paramName: uName,
                message: `Constraint references unknown parameter "${ref}".`,
                severity: 'error',
              });
            }
          }
        }
      }

      // Validate grid bounds
      if (param.mode === 'grid' && param.grid) {
        if (param.grid.min >= param.grid.max) {
          errors.push({
            stepId: step.id,
            stepName,
            paramName: uName,
            message: `Grid search for "${uName}" has min (${param.grid.min}) >= max (${param.grid.max}).`,
            severity: 'error',
          });
        }
        if (param.grid.steps < 2) {
          errors.push({
            stepId: step.id,
            stepName,
            paramName: uName,
            message: `Grid search for "${uName}" must have at least 2 steps.`,
            severity: 'error',
          });
        }
      }
    }

    // 3. Residue selection validation
    if (step.residues && step.residues.length > 0 && totalAvailableResiduesCount > 0) {
      if (step.residueMode === 'exclude' && step.residues.length >= totalAvailableResiduesCount) {
        errors.push({
          stepId: step.id,
          stepName,
          message: `Step "${stepName}" excludes all residues, leaving no data to fit.`,
          severity: 'error',
        });
      }
    }

    // 4. Statistics Validation
    if (step.statistics) {
      const stats = step.statistics;
      const isAnyStatsActive =
        stats.mc?.enabled || stats.bs?.enabled || stats.bsn?.enabled || stats.mcmc?.enabled;

      // Check Grid + Statistics conflict
      if (gridParams.length > 0 && isAnyStatsActive) {
        errors.push({
          stepId: step.id,
          stepName,
          message: `Step "${stepName}" has both GRID search and STATISTICS enabled. ChemEx will disable statistics for steps performing grid search.`,
          severity: 'warning',
        });
      }

      // Check Resampling Replicate Counts
      const resamplingMethods: Array<{ key: 'mc' | 'bs' | 'bsn'; label: string }> = [
        { key: 'mc', label: 'Monte Carlo (MC)' },
        { key: 'bs', label: 'Bootstrap (BS)' },
        { key: 'bsn', label: 'Nucleus-Specific Bootstrap (BSN)' },
      ];

      for (const { key, label } of resamplingMethods) {
        const conf = stats[key];
        if (conf?.enabled) {
          if (!conf.replicates || conf.replicates < 1 || isNaN(conf.replicates)) {
            errors.push({
              stepId: step.id,
              stepName,
              message: `${label} replicate count must be a positive integer (>= 1).`,
              severity: 'error',
            });
          } else if (conf.replicates > 200) {
            errors.push({
              stepId: step.id,
              stepName,
              message: `${label} replicate count (${conf.replicates}) requires ${conf.replicates} full refits and may have high execution cost.`,
              severity: 'warning',
            });
          }
        }
      }

      // Check MCMC Settings
      if (stats.mcmc?.enabled) {
        const m = stats.mcmc;
        if (!m.steps || m.steps < 1 || isNaN(m.steps)) {
          errors.push({
            stepId: step.id,
            stepName,
            message: 'MCMC steps must be a positive integer (>= 1).',
            severity: 'error',
          });
        }

        const burnVal = m.burn === 'auto' || m.burn === undefined ? 0 : Number(m.burn);
        if (m.burn !== 'auto' && (isNaN(burnVal) || burnVal < 0)) {
          errors.push({
            stepId: step.id,
            stepName,
            message: 'MCMC burn must be a non-negative integer (>= 0) or "auto".',
            severity: 'error',
          });
        } else if (m.steps && burnVal >= m.steps) {
          errors.push({
            stepId: step.id,
            stepName,
            message: `MCMC burn (${burnVal}) must be smaller than total steps (${m.steps}).`,
            severity: 'error',
          });
        }

        const thinVal = m.thin ?? 1;
        if (thinVal < 1 || isNaN(thinVal)) {
          errors.push({
            stepId: step.id,
            stepName,
            message: 'MCMC thin must be a positive integer (>= 1).',
            severity: 'error',
          });
        } else if (m.steps && burnVal < m.steps && Math.floor((m.steps - burnVal) / thinVal) < 1) {
          errors.push({
            stepId: step.id,
            stepName,
            message: `MCMC settings retain 0 samples with steps=${m.steps}, burn=${burnVal}, thin=${thinVal}. Decrease thin or increase steps.`,
            severity: 'error',
          });
        }

        if (m.walkers !== undefined && m.walkers !== null) {
          if (m.walkers < 1 || isNaN(m.walkers)) {
            errors.push({
              stepId: step.id,
              stepName,
              message: 'MCMC walkers must be a positive integer (>= 1).',
              severity: 'error',
            });
          } else if (fitParams.length > 0 && m.walkers < 2 * fitParams.length) {
            errors.push({
              stepId: step.id,
              stepName,
              message: `MCMC walkers (${m.walkers}) must be at least 2x number of fitted parameters (2 * ${fitParams.length} = ${2 * fitParams.length}).`,
              severity: 'error',
            });
          }
        }

        if (m.workers !== undefined && m.workers !== null && (m.workers < 1 || isNaN(m.workers))) {
          errors.push({
            stepId: step.id,
            stepName,
            message: 'MCMC workers must be a positive integer (>= 1).',
            severity: 'error',
          });
        }
      }
    }
  }

  return errors;
}
