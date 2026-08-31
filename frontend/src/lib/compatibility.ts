/**
 * Compatibility rules, constants, and evaluation logic for parameter inheritance.
 */

export const MAX_SAFE_RELATIVE_ERROR = 0.50; // Flag uncertainty if sigma / |value| > 50%
export const CS_TOLERANCE_PPM = 0.01;        // Threshold for pick vs inherited cs_a conflict

export interface SourceRunSummary {
  analysis_uuid: string;
  name: string;
  analysis_type: string;
  status: string;
  created_at: string;
  completed_at?: string;
  model: string;
  nucleus: string;
  fit_mode: 'global' | 'individual';
  static_field: number;
  temperature: number;
  chi2_red?: number;
  total_residues: number;
  is_compatible: boolean;
  block_reasons: string[];
  warning_reasons: string[];
}

export interface TargetAnalysisMeta {
  analysis_uuid?: string;
  name?: string;
  analysis_type: string;
  model: string;
  nucleus: string;
  static_field: number;
  temperature: number;
}

export interface CompatibilityResult {
  isCompatible: boolean;
  blockReasons: string[];
  warningReasons: string[];
}

/**
 * Evaluates whether a source run can be inherited into a target analysis.
 * - Block: Different kinetic model (2st vs 3st), different nucleus, non-CEST experiment.
 * - Warn: Different temperature (> 1.0 K difference).
 * - Allow: Different static field (B0).
 */
export function evaluateRunCompatibility(
  source: {
    analysis_type?: string;
    model?: string;
    nucleus?: string;
    temperature?: number;
    static_field?: number;
  },
  target: {
    analysis_type?: string;
    model?: string;
    nucleus?: string;
    temperature?: number;
    static_field?: number;
  }
): CompatibilityResult {
  const blockReasons: string[] = [];
  const warningReasons: string[] = [];

  const srcType = (source.analysis_type || '').toUpperCase();
  if (srcType && !srcType.includes('CEST')) {
    blockReasons.push(`Incompatible experiment type: ${source.analysis_type || 'Unknown'}`);
  }

  const srcModel = (source.model || '2st').toLowerCase();
  const tgtModel = (target.model || '2st').toLowerCase();
  const srcIs3st = srcModel.includes('3');
  const tgtIs3st = tgtModel.includes('3');

  if (srcIs3st !== tgtIs3st) {
    blockReasons.push(
      `Different kinetic model: Source is ${srcModel.toUpperCase()}, Target is ${tgtModel.toUpperCase()}`
    );
  }

  const srcNuc = (source.nucleus || '15N').toUpperCase();
  const tgtNuc = (target.nucleus || '15N').toUpperCase();
  if (srcNuc !== tgtNuc) {
    blockReasons.push(`Different nucleus: Source is ${srcNuc}, Target is ${tgtNuc}`);
  }

  const srcTemp = source.temperature ?? 298.15;
  const tgtTemp = target.temperature ?? 298.15;
  if (Math.abs(srcTemp - tgtTemp) > 1.0) {
    warningReasons.push(
      `Different temperature: Source is ${srcTemp.toFixed(1)} K, Target is ${tgtTemp.toFixed(1)} K (kex_ab is strongly temperature-dependent)`
    );
  }

  return {
    isCompatible: blockReasons.length === 0,
    blockReasons,
    warningReasons,
  };
}

/**
 * Checks if a parameter's uncertainty is considered high (> 50% relative error).
 */
export function isHighUncertainty(value?: number | null, err?: number | null): boolean {
  if (value === undefined || value === null || isNaN(value)) return false;
  if (err === undefined || err === null || isNaN(err) || err <= 0) return false;
  if (value === 0) return false;
  return Math.abs(err / value) > MAX_SAFE_RELATIVE_ERROR;
}

/**
 * Returns formatted uncertainty string: e.g. "±0.025" or "±5.34"
 */
export function formatUncertainty(err?: number | null, precision = 3): string {
  if (err === undefined || err === null || isNaN(err)) return '';
  if (Math.abs(err) < 1e-3 || Math.abs(err) >= 1e4) {
    return `±${err.toExponential(2)}`;
  }
  return `±${err.toFixed(precision)}`;
}
