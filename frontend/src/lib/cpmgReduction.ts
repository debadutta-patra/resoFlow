export interface R2effResult {
  nu_cpmg: number[];
  r2eff: number[];
  r2eff_err: number[];
  i0: number;
  i0_err: number;
  invalid_points: number[];
  valid: boolean;
  error?: string;
}

export interface RexFlatnessResult {
  rex: number;
  rex_raw: number;
  rex_err: number;
  chi2_red: number;
  is_flat: boolean;
  weighted_mean_r2: number;
}

export function computeR2effProfile(
  ncycs: number[],
  intensities: number[],
  uncertainties: number[] | undefined,
  time_t2: number
): R2effResult {
  if (time_t2 <= 0) {
    return {
      error: "time_t2 must be positive",
      nu_cpmg: [],
      r2eff: [],
      r2eff_err: [],
      i0: 0,
      i0_err: 0,
      invalid_points: [],
      valid: false,
    };
  }

  // Find reference plane (ncyc == 0)
  let ref_idx: number | null = null;
  for (let i = 0; i < ncycs.length; i++) {
    if (Math.abs(ncycs[i]) < 1e-6) {
      ref_idx = i;
      break;
    }
  }

  if (ref_idx === null) {
    return {
      error: "Missing reference plane (ncyc = 0)",
      nu_cpmg: [],
      r2eff: [],
      r2eff_err: [],
      i0: 0,
      i0_err: 0,
      invalid_points: [],
      valid: false,
    };
  }

  const i0 = intensities[ref_idx];
  if (i0 <= 0) {
    return {
      error: `Non-positive reference intensity: ${i0}`,
      nu_cpmg: [],
      r2eff: [],
      r2eff_err: [],
      i0: 0,
      i0_err: 0,
      invalid_points: [],
      valid: false,
    };
  }

  const i0_err = uncertainties && uncertainties.length > ref_idx ? uncertainties[ref_idx] : 0.02 * i0;

  const nu_list: number[] = [];
  const r2eff_list: number[] = [];
  const err_list: number[] = [];
  const invalid_points: number[] = [];

  for (let idx = 0; idx < ncycs.length; idx++) {
    const ncyc = ncycs[idx];
    if (Math.abs(ncyc) < 1e-6) continue; // Skip reference plane

    const i_val = intensities[idx];
    if (i_val <= 0) {
      invalid_points.push(idx);
      continue;
    }

    const nu = ncyc / time_t2;
    const ratio = i_val / i0;
    const r2eff = -Math.log(ratio) / time_t2;

    const i_err = uncertainties && uncertainties.length > idx ? uncertainties[idx] : 0.02 * i_val;
    const rel_err_sq = Math.pow(i_err / i_val, 2) + Math.pow(i0_err / i0, 2);
    const r2eff_err = Math.sqrt(rel_err_sq) / time_t2;

    nu_list.push(nu);
    r2eff_list.push(r2eff);
    err_list.push(r2eff_err);
  }

  return {
    nu_cpmg: nu_list,
    r2eff: r2eff_list,
    r2eff_err: err_list,
    i0,
    i0_err,
    invalid_points,
    valid: nu_list.length > 0,
  };
}

export function computeRexAndFlatness(
  nu_cpmg: number[],
  r2eff: number[],
  r2eff_err: number[]
): RexFlatnessResult {
  if (nu_cpmg.length < 2 || r2eff.length < 2) {
    return {
      rex: 0.0,
      rex_raw: 0.0,
      rex_err: 0.0,
      chi2_red: 0.0,
      is_flat: true,
      weighted_mean_r2: r2eff[0] || 0.0,
    };
  }

  // Combine and sort by nu_cpmg
  const points = nu_cpmg.map((nu, i) => ({
    nu,
    r2: r2eff[i],
    err: r2eff_err[i] && r2eff_err[i] > 1e-6 ? r2eff_err[i] : 1.0,
  })).sort((a, b) => a.nu - b.nu);

  const r2_min = points[0].r2;
  const err_min = points[0].err;
  const r2_max = points[points.length - 1].r2;
  const err_max = points[points.length - 1].err;

  const rex_raw = r2_min - r2_max;
  const rex_err = Math.sqrt(err_min * err_min + err_max * err_max);

  // Weighted mean for flatness test
  let sum_w = 0;
  let sum_wr = 0;
  for (const p of points) {
    const w = 1.0 / (p.err * p.err);
    sum_w += w;
    sum_wr += w * p.r2;
  }
  const weighted_mean_r2 = sum_w > 0 ? sum_wr / sum_w : r2_min;

  let chi2 = 0;
  for (const p of points) {
    const w = 1.0 / (p.err * p.err);
    chi2 += w * Math.pow(p.r2 - weighted_mean_r2, 2);
  }
  const dof = Math.max(1, points.length - 1);
  const chi2_red = chi2 / dof;

  return {
    rex: Math.max(0, rex_raw),
    rex_raw,
    rex_err,
    chi2_red,
    is_flat: chi2_red < 1.5,
    weighted_mean_r2,
  };
}

export function estimateDeltaOmegaFastExchange(
  rex: number,
  kex: number,
  pb: number,
  b0_mhz: number,
  xi_ratio: number = 0.101329118
): number {
  if (rex <= 0 || kex <= 0 || pb <= 0 || pb >= 1.0 || b0_mhz <= 0) {
    return 0.0;
  }

  const pa = 1.0 - pb;
  const denom = pa * pb;
  if (denom <= 1e-9) return 0.0;

  const dw_rad_s = Math.sqrt((rex * kex) / denom);
  const nu0_mhz = b0_mhz * xi_ratio;
  const dw_ppm = dw_rad_s / (2.0 * Math.PI * nu0_mhz);
  return Number(dw_ppm.toFixed(3));
}
