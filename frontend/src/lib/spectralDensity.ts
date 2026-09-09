/**
 * Pure helpers for the reduced spectral density mapping (RSDM) setup panel
 * and results views.
 *
 * Kept free of React so the validation rules -- which are the part that
 * actually protects the user from a meaningless result -- can be unit tested
 * directly.
 */

export const R_NH_PRESETS = ['1.02', '1.015'] as const;
export const DELTA_SIGMA_PRESETS = ['-160', '-170', '-172'] as const;

export type RNhPreset = (typeof R_NH_PRESETS)[number];
export type DeltaSigmaPreset = (typeof DELTA_SIGMA_PRESETS)[number];

/**
 * Two spectrometers both described as "600 MHz" rarely report an identical
 * 1H frequency, but a 600/800 mix must never pass. Matches the backend's
 * B0_TOLERANCE_MHZ -- the frontend check is a courtesy that explains the
 * problem before submitting; the backend's is the one that enforces it.
 */
export const B0_TOLERANCE_MHZ = 1.0;

export interface SourceAnalysisOption {
  analysis_uuid: string;
  name: string;
  analysis_type: string;
  status: string;
  b0: number | null;
}

export interface ConstantsForm {
  mode: 'preset' | 'custom';
  rNhPreset: string;
  deltaSigmaPreset: string;
  rNhAngstrom: string;
  deltaSigmaPpm: string;
}

export const defaultConstantsForm = (): ConstantsForm => ({
  mode: 'preset',
  rNhPreset: '1.02',
  deltaSigmaPreset: '-160',
  rNhAngstrom: '1.02',
  deltaSigmaPpm: '-160',
});

export interface ValidationIssue {
  field: string;
  message: string;
}

/**
 * Validate the constants form.
 *
 * The bounds catch unit mistakes -- a value in metres typed where Angstrom
 * was meant, a CSA entered as a fraction rather than ppm -- rather than
 * legislating chemistry. They mirror the backend's, so the user finds out
 * before a round trip.
 */
export function validateConstants(form: ConstantsForm): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (form.mode === 'preset') {
    if (!R_NH_PRESETS.includes(form.rNhPreset as RNhPreset)) {
      issues.push({ field: 'rNhPreset', message: `Unknown r_NH preset "${form.rNhPreset}".` });
    }
    if (!DELTA_SIGMA_PRESETS.includes(form.deltaSigmaPreset as DeltaSigmaPreset)) {
      issues.push({
        field: 'deltaSigmaPreset',
        message: `Unknown CSA preset "${form.deltaSigmaPreset}".`,
      });
    }
    return issues;
  }

  const rNh = Number(form.rNhAngstrom);
  if (form.rNhAngstrom.trim() === '' || Number.isNaN(rNh)) {
    issues.push({ field: 'rNhAngstrom', message: 'r_NH is required.' });
  } else if (!(rNh > 0)) {
    issues.push({ field: 'rNhAngstrom', message: 'r_NH must be positive.' });
  } else if (rNh < 0.5 || rNh > 2.0) {
    issues.push({
      field: 'rNhAngstrom',
      message: `r_NH = ${rNh} Å is outside the plausible range 0.5–2.0 Å; check the units.`,
    });
  }

  const csa = Number(form.deltaSigmaPpm);
  if (form.deltaSigmaPpm.trim() === '' || Number.isNaN(csa)) {
    issues.push({ field: 'deltaSigmaPpm', message: 'Δσ is required.' });
  } else if (csa < -400 || csa > 400) {
    issues.push({
      field: 'deltaSigmaPpm',
      message: `Δσ = ${csa} ppm is outside the plausible range ±400 ppm; check the units.`,
    });
  } else if (csa > 0) {
    issues.push({
      field: 'deltaSigmaPpm',
      message: 'Δσ for amide ¹⁵N is negative; a positive value is almost certainly a sign error.',
    });
  }

  return issues;
}

/** Serialise the constants form into the API request shape. */
export function constantsPayload(form: ConstantsForm): Record<string, unknown> {
  if (form.mode === 'custom') {
    return {
      r_nh_angstrom: Number(form.rNhAngstrom),
      delta_sigma_ppm: Number(form.deltaSigmaPpm),
    };
  }
  return {
    r_nh_preset: form.rNhPreset,
    delta_sigma_preset: form.deltaSigmaPreset,
  };
}

/** Completed analyses of one type, usable as a mapping source. */
export function eligibleSources(
  analyses: SourceAnalysisOption[],
  analysisType: 'R1' | 'R2' | 'hetNOE' | 'CPMG',
): SourceAnalysisOption[] {
  const wanted = analysisType.toUpperCase();
  return analyses.filter(
    (a) => (a.analysis_type || '').toUpperCase() === wanted && a.status === 'COMPLETED',
  );
}

/**
 * Where R₂ comes from.
 *
 * `echo_decay` — a direct R₂ relaxation experiment. THE DEFAULT.
 * `cpmg_r2_0`  — ChemEx's fitted R₂,₀ from a CPMG run, which already has
 *   exchange removed by the fitted model. Not an R_ex correction and not
 *   gated by the experimental flag, but it does inherit whatever exchange
 *   model the CPMG fit assumed, which the direct experiment does not.
 */
export type R2Provenance = 'echo_decay' | 'cpmg_r2_0';

export const R2_PROVENANCE_OPTIONS: Array<{
  value: R2Provenance;
  label: string;
  sourceType: 'R2' | 'CPMG';
  hint: string;
}> = [
  {
    value: 'echo_decay',
    label: 'R₂ experiment (echo decay)',
    sourceType: 'R2',
    hint: 'Direct measurement. Any chemical exchange it contains will land on J(0).',
  },
  {
    value: 'cpmg_r2_0',
    label: 'R₂,₀ from a CPMG fit',
    sourceType: 'CPMG',
    hint:
      'ChemEx\'s fitted R₂,₀, exchange-free by construction — but conditional on ' +
      'the exchange model that CPMG fit assumed.',
  },
];

/** Which analysis type feeds the R₂ slot for a given provenance. */
export function r2SourceType(provenance: R2Provenance): 'R2' | 'CPMG' {
  return provenance === 'cpmg_r2_0' ? 'CPMG' : 'R2';
}

export interface FieldCheck {
  ok: boolean;
  /** Present only when every selected source reports a field. */
  b0: number | null;
  spread: number | null;
  message: string | null;
  fields: Record<string, number | null>;
}

/**
 * Check that the three chosen sources share a static field.
 *
 * RSDM is a single-field method: mixing a 600 MHz R1 with an 800 MHz R2
 * produces J values that look entirely reasonable and are entirely wrong.
 * The backend rejects it outright; this exists so the UI can say so before
 * the user submits, and can grey out the mismatched options.
 */
export function checkFieldConsistency(
  sources: Array<{ role: string; source: SourceAnalysisOption | null }>,
  toleranceMhz: number = B0_TOLERANCE_MHZ,
): FieldCheck {
  const fields: Record<string, number | null> = {};
  for (const { role, source } of sources) {
    fields[role] = source?.b0 ?? null;
  }

  const chosen = sources.filter((s) => s.source !== null);
  if (chosen.length < sources.length) {
    return { ok: false, b0: null, spread: null, message: null, fields };
  }

  const missing = chosen.filter((s) => s.source?.b0 == null).map((s) => s.role);
  if (missing.length > 0) {
    return {
      ok: false,
      b0: null,
      spread: null,
      message:
        `No static field recorded for: ${missing.join(', ')}. ` +
        'Set B₀ on the linked spectra — it is not safe to assume a default.',
      fields,
    };
  }

  const values = chosen.map((s) => s.source!.b0 as number);
  const spread = Math.max(...values) - Math.min(...values);
  if (spread > toleranceMhz) {
    const described = Object.entries(fields)
      .map(([role, v]) => `${role} ${v?.toFixed(2)} MHz`)
      .join(', ');
    return {
      ok: false,
      b0: null,
      spread,
      message:
        `Sources were recorded at different static fields (${described}). ` +
        'Reduced spectral density mapping is a single-field method; mixing ' +
        'fields produces plausible-looking but meaningless J values.',
      fields,
    };
  }

  return {
    ok: true,
    b0: values.reduce((a, b) => a + b, 0) / values.length,
    spread,
    message: null,
    fields,
  };
}

/**
 * Points tracing a 1σ error ellipse for a 2×2 covariance block.
 *
 * The J(0)–J(ω_N) correlation plot needs ellipses, not crossed error bars:
 * the two are correlated by construction, so independent bars overstate the
 * plausible region along one diagonal and understate it along the other.
 *
 * @param cxx variance of the x quantity
 * @param cyy variance of the y quantity
 * @param cxy covariance between them
 */
export function errorEllipse(
  cx: number,
  cy: number,
  cxx: number,
  cyy: number,
  cxy: number,
  nSigma = 1,
  nPoints = 48,
): { x: number[]; y: number[] } {
  // Closed-form eigendecomposition of a symmetric 2x2 matrix.
  const trace = cxx + cyy;
  const det = cxx * cyy - cxy * cxy;
  const disc = Math.max(trace * trace / 4 - det, 0);
  const root = Math.sqrt(disc);
  const l1 = Math.max(trace / 2 + root, 0);
  const l2 = Math.max(trace / 2 - root, 0);

  // Principal axis direction; when cxy vanishes the ellipse is axis-aligned.
  const theta = Math.abs(cxy) < 1e-300 ? 0 : 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  const ct = Math.cos(theta);
  const st = Math.sin(theta);
  const a = nSigma * Math.sqrt(l1);
  const b = nSigma * Math.sqrt(l2);

  const x: number[] = [];
  const y: number[] = [];
  for (let i = 0; i <= nPoints; i += 1) {
    const t = (2 * Math.PI * i) / nPoints;
    const px = a * Math.cos(t);
    const py = b * Math.sin(t);
    x.push(cx + px * ct - py * st);
    y.push(cy + px * st + py * ct);
  }
  return { x, y };
}

/**
 * The two references for the J(ω_N) vs J(0) correlation plot.
 *
 * J(0) is on the abscissa and J(ω_N) on the ordinate, the conventional
 * orientation: exchange then displaces a residue horizontally, along the
 * axis it contaminates.
 *
 * `rigidRotorSweep` is parametric in τ:
 *     J(0)   = (2/5)τ
 *     J(ω_N) = (2/5)τ / (1 + (ω_N τ)²)
 * rising to a maximum at ω_N τ = 1 and decaying after it. It traces where a
 * rigid isotropic rotor of any size would sit — residues of one protein do
 * not move along it, since they share a τ_c, but it locates the family.
 *
 * @param omegaN 15N Larmor angular frequency in rad/s (sign ignored)
 * @param j0Max right-hand end of the curve, in ns/rad
 */
export function rigidRotorSweep(
  omegaN: number,
  j0Max: number,
  nPoints = 400,
): { j0: number[]; jwn: number[] } {
  const w = Math.abs(omegaN);
  const j0: number[] = [];
  const jwn: number[] = [];
  if (!(w > 0) || !(j0Max > 0)) return { j0, jwn };

  // Sampled in tau then clipped, so the maximum at omega_N tau = 1 is
  // resolved wherever it happens to fall in the plotted range.
  const tauMax = Math.max((2.5 * j0Max) / 1e9, 4 / w);
  for (let i = 0; i < nPoints; i += 1) {
    const tau = (tauMax * (i + 1)) / nPoints;
    const x = 0.4 * tau * 1e9;
    if (x > j0Max) break;
    j0.push(x);
    jwn.push(x / (1 + (w * tau) ** 2));
  }
  return { j0, jwn };
}

/**
 * The fixed-τ_c locus: J(ω_N) = J(0)/(1 + (ω_N τ_c)²).
 *
 * S² is what genuinely differs between residues of one protein, and both
 * spectral densities scale with it, so this straight line through the origin
 * is the reference residues actually scatter along.
 */
export function rigidRotorLine(
  omegaN: number,
  tauCSeconds: number,
  j0Max: number,
  nPoints = 2,
): { j0: number[]; jwn: number[] } {
  const slope = 1 / (1 + (Math.abs(omegaN) * tauCSeconds) ** 2);
  const j0: number[] = [];
  const jwn: number[] = [];
  const steps = Math.max(nPoints, 2);
  for (let i = 0; i < steps; i += 1) {
    const x = (j0Max * i) / (steps - 1);
    j0.push(x);
    jwn.push(slope * x);
  }
  return { j0, jwn };
}

/**
 * τ_c from the trimmed-mean J(0)/J(ω_N) ratio, in seconds.
 *
 * For a rigid isotropic rotor J(0)/J(ω_N) = 1 + (ω_N τ_c)². Trimmed so the
 * outliers the plot exists to reveal do not set the reference they are
 * judged against. Returns null when the ratio is below 1, which no rigid
 * rotor can produce.
 */
export function tauCFromResidues(
  rows: SdmResidue[],
  omegaN: number,
  trimFraction = 0.1,
): number | null {
  const trimmed = (values: number[]): number => {
    const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    if (v.length === 0) return NaN;
    if (v.length < 3) return v.reduce((a, b) => a + b, 0) / v.length;
    const k = Math.floor(v.length * trimFraction);
    const core = 2 * k < v.length ? v.slice(k, v.length - k) : v;
    return core.reduce((a, b) => a + b, 0) / core.length;
  };

  const j0 = trimmed(rows.map((r) => r.j0));
  const jwn = trimmed(rows.map((r) => r.j_wn));
  if (!Number.isFinite(j0) || !Number.isFinite(jwn) || jwn <= 0) return null;
  const ratio = j0 / jwn;
  if (!(ratio > 1) || !omegaN) return null;
  return Math.sqrt(ratio - 1) / Math.abs(omegaN);
}

export interface SdmResidue {
  assignment: string;
  res_num: number | null;
  res_name: string | null;
  j0: number;
  j_wn: number;
  j_h: number;
  j0_err: number;
  j_wn_err: number;
  j_h_err: number;
  covariance: number[][];
  r1: number;
  r1_err: number;
  r2: number;
  r2_err: number;
  noe: number;
  noe_err: number;
  sigma: number;
  sigma_err: number;
  tau_c: number | null;
  flags: string[];
  rex?: number;
  rex_err?: number;
  /** Set by the server from the analysis's excludedResidues list. */
  excluded?: boolean;
  exclusion_reason?: string | null;
}

/**
 * The residues a plot should draw.
 *
 * Excluded residues stay in the TABLE, greyed out, so they can be toggled
 * back on and so exports can account for them. They must not reach the
 * plots: leaving them there would show points the summary no longer
 * describes, and a single excluded outlier would go on stretching the axes.
 *
 * Deliberately independent of the table's search and flagged-only filters,
 * which are browsing aids rather than statements about the data -- the same
 * split the relaxation module uses.
 */
export function includedResidues(rows: SdmResidue[]): SdmResidue[] {
  return rows.filter((r) => !r.excluded);
}

export type SortKey =
  | 'res_num' | 'assignment' | 'j0' | 'j_wn' | 'j_h'
  | 'r1' | 'r2' | 'noe' | 'tau_c';

/** Sort residues for the results table. Nulls always sort last. */
export function sortResidues(
  rows: SdmResidue[],
  key: SortKey,
  direction: 'asc' | 'desc',
): SdmResidue[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'string' || typeof bv === 'string') {
      return sign * String(av).localeCompare(String(bv));
    }
    return sign * ((av as number) - (bv as number));
  });
}

/** Filter by assignment/residue substring and by flagged-only. */
export function filterResidues(
  rows: SdmResidue[],
  query: string,
  flaggedOnly: boolean,
): SdmResidue[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => {
    if (flaggedOnly && (!r.flags || r.flags.length === 0)) return false;
    if (!q) return true;
    return (
      r.assignment.toLowerCase().includes(q) ||
      String(r.res_num ?? '').includes(q) ||
      (r.res_name ?? '').toLowerCase().includes(q)
    );
  });
}
