/**
 * Run-side helpers shared by every ChemEx analysis page (CEST, CPMG, EXCHANGE):
 * the "config changed since last run" fingerprint, lineage lookup for inherited
 * parameters, and the pre-flight ChemEx validation call.
 */

import api from '../services/api';
import type { ParameterConfig } from './parameterConfig';

/** Fingerprint of everything that determines a ChemEx fit. */
export function chemexConfigHash(input: {
  parameterToml: string;
  methodToml: string;
  model: string;
  fitMode: string;
}): string {
  return JSON.stringify({
    method: input.methodToml.trim(),
    params: input.parameterToml.trim(),
    model: input.model,
    fitMode: input.fitMode,
  });
}

export interface LineageInfo {
  sourceRunId: string;
  sourceRunLabel: string;
  at: string;
}

/** The run this parameter config was seeded from, if any. */
export function findLineage(config: ParameterConfig): LineageInfo | null {
  if (config.inheritedFrom?.sourceRunId) return config.inheritedFrom;
  const values = [
    ...Object.values(config.globals || {}),
    ...Object.values(config.residues || {}).flatMap(r => Object.values(r || {})),
  ];
  for (const v of values) {
    if (v?.source?.kind === 'inherited') {
      return { sourceRunId: v.source.sourceRunId, sourceRunLabel: v.source.sourceRunLabel, at: v.source.at };
    }
  }
  return null;
}

/**
 * Validate parameters.toml + method.toml with ChemEx before queueing a run.
 * Returns an error message when ChemEx rejects the config, `null` when it is valid
 * or when the validator could not be reached (the run then proceeds as before).
 */
export async function preflightChemexValidation(req: {
  projectUuid: string;
  analysisUuid: string;
  parameterToml: string;
  methodToml: string;
  model: string;
}): Promise<string | null> {
  try {
    const res = await api.post('/api/chemex/validate', {
      analysis_uuid: req.analysisUuid,
      project_uuid: req.projectUuid,
      parameter_toml: req.parameterToml,
      method_toml: req.methodToml,
      model: req.model,
    });
    const errors: any[] = res.data?.errors || [];
    if (res.data && !res.data.valid && errors.length > 0) {
      return `ChemEx Validation Error:\n${errors.map(e => e?.message || String(e)).join('\n')}`;
    }
  } catch (err) {
    console.warn('Pre-flight validation check skipped:', err);
  }
  return null;
}

export const RERUN_CONFIRM_MESSAGE =
  'Rerunning this analysis will overwrite your current results. A backup of the current results will be created. Proceed?';
