/**
 * Uncertainty-aware number formatter (NIST / Particle Data Group conventions).
 * Formats value ± error pairs by rounding the error to 1-2 significant figures
 * and aligning the value to the matching decimal precision.
 * Supports grouped scientific notation: (3.60 ± 0.06) × 10⁻³
 * and asymmetric intervals: 448.6 +18.2 / -15.4
 */

export interface FormattedUncertainty {
  formatted: string;
  valueStr: string;
  errorStr?: string;
  errorLowStr?: string;
  errorHighStr?: string;
  unit?: string;
  isDerived?: boolean;
  isAsymmetric?: boolean;
}

export interface FormatOptions {
  unit?: string;
  isPercent?: boolean;
  isDerived?: boolean;
  forceSign?: boolean;
  fixedDecimals?: number;
  useScientific?: boolean;
}

function superscriptExponent(exp: number): string {
  const supMap: Record<string, string> = {
    '-': '⁻',
    '+': '⁺',
    '0': '⁰',
    '1': '¹',
    '2': '²',
    '3': '³',
    '4': '⁴',
    '5': '⁵',
    '6': '⁶',
    '7': '⁷',
    '8': '⁸',
    '9': '⁹',
  };
  return String(exp)
    .split('')
    .map(c => supMap[c] || c)
    .join('');
}

function roundTo(num: number, decimals: number): string {
  const factor = Math.pow(10, decimals);
  const rounded = Math.round((num + Number.EPSILON) * factor) / factor;
  return rounded.toFixed(decimals);
}

export function getPdgPrecision(error: number): { decimals: number; sigFigs: number } {
  if (error <= 0 || isNaN(error) || !isFinite(error)) {
    return { decimals: 2, sigFigs: 1 };
  }
  const exp = Math.floor(Math.log10(error));
  const leadTwo = error / Math.pow(10, exp);
  // PDG rule: 2 sig figs if leading digits < 3.55 (i.e. 1.00..3.54), else 1 sig fig (3.55..9.99)
  const sigFigs = leadTwo < 3.55 ? 2 : 1;
  const decimals = Math.max(0, -exp + sigFigs - (exp >= 1 ? 0 : 1));
  return { decimals, sigFigs };
}

export function formatUncertainty(
  val: number | null | undefined,
  err?: number | null,
  options?: FormatOptions
): FormattedUncertainty {
  if (val === null || val === undefined || isNaN(val)) {
    return { formatted: '—', valueStr: '—', unit: options?.unit };
  }

  let value = val;
  let error = err;
  const isPercent = options?.isPercent ?? false;
  const unit = isPercent ? '%' : (options?.unit || '');
  const forceSign = options?.forceSign ?? false;

  if (isPercent) {
    value = value * 100;
    if (error !== null && error !== undefined) {
      error = error * 100;
    }
  }

  const unitSuffix = unit ? ` ${unit}` : '';

  // 1. When error is present and positive
  if (error !== null && error !== undefined && !isNaN(error) && error > 0) {
    const isSci =
      options?.useScientific ??
      ((Math.abs(value) > 0 && (Math.abs(value) < 0.001 || Math.abs(value) >= 10000)) ||
        (error < 0.001 || error >= 10000));

    if (isSci && Math.abs(value) > 0) {
      const exp = Math.floor(Math.log10(Math.abs(value)));
      const scale = Math.pow(10, exp);
      const scaledVal = value / scale;
      const scaledErr = error / scale;
      const { decimals } = getPdgPrecision(scaledErr);

      const valStr = roundTo(scaledVal, decimals);
      const errStr = roundTo(scaledErr, decimals);
      const expStr = superscriptExponent(exp);

      const formatted = `(${valStr} ± ${errStr}) × 10${expStr}${unitSuffix}`;
      return {
        formatted,
        valueStr: valStr,
        errorStr: errStr,
        unit,
        isDerived: options?.isDerived,
      };
    }

    let decimals: number;
    if (options?.fixedDecimals !== undefined) {
      decimals = options.fixedDecimals;
    } else {
      const precision = getPdgPrecision(error);
      decimals = precision.decimals;
    }

    let valStr = roundTo(value, decimals);
    const errStr = roundTo(error, decimals);

    if (forceSign && value > 0 && !valStr.startsWith('+')) {
      valStr = `+${valStr}`;
    }

    const formatted = `${valStr} ± ${errStr}${unitSuffix}`;
    return {
      formatted,
      valueStr: valStr,
      errorStr: errStr,
      unit,
      isDerived: options?.isDerived,
    };
  }

  // 2. When error is absent or zero
  const isSci =
    options?.useScientific ??
    (Math.abs(value) > 0 && (Math.abs(value) < 0.001 || Math.abs(value) >= 10000));

  if (isSci && Math.abs(value) > 0) {
    const exp = Math.floor(Math.log10(Math.abs(value)));
    const scale = Math.pow(10, exp);
    const scaledVal = value / scale;
    const valStr = roundTo(scaledVal, 2);
    const expStr = superscriptExponent(exp);
    const formatted = `${valStr} × 10${expStr}${unitSuffix}`;
    return {
      formatted,
      valueStr: valStr,
      unit,
      isDerived: options?.isDerived,
    };
  }

  let decimals = options?.fixedDecimals;
  if (decimals === undefined) {
    if (Math.abs(value) >= 100) {
      decimals = 1;
    } else if (Math.abs(value) >= 10) {
      decimals = 2;
    } else {
      decimals = 3;
    }
  }

  let valStr = roundTo(value, decimals);
  if (forceSign && value > 0 && !valStr.startsWith('+')) {
    valStr = `+${valStr}`;
  }

  const formatted = `${valStr}${unitSuffix}`;
  return {
    formatted,
    valueStr: valStr,
    unit,
    isDerived: options?.isDerived,
  };
}

export function formatAsymmetricInterval(
  val: number | null | undefined,
  errLow: number | null | undefined,
  errHigh: number | null | undefined,
  options?: FormatOptions
): FormattedUncertainty {
  if (val === null || val === undefined || isNaN(val)) {
    return { formatted: '—', valueStr: '—', unit: options?.unit };
  }

  if (
    errLow === null ||
    errLow === undefined ||
    isNaN(errLow) ||
    errHigh === null ||
    errHigh === undefined ||
    isNaN(errHigh)
  ) {
    return formatUncertainty(val, null, options);
  }

  let value = val;
  let low = Math.abs(errLow);
  let high = Math.abs(errHigh);
  const isPercent = options?.isPercent ?? false;
  const unit = isPercent ? '%' : (options?.unit || '');
  const unitSuffix = unit ? ` ${unit}` : '';

  if (isPercent) {
    value = value * 100;
    low = low * 100;
    high = high * 100;
  }

  const refErr = Math.max(low, high);
  const isSci =
    options?.useScientific ??
    ((Math.abs(value) > 0 && (Math.abs(value) < 0.001 || Math.abs(value) >= 10000)) ||
      (refErr < 0.001 || refErr >= 10000));

  if (isSci && Math.abs(value) > 0) {
    const exp = Math.floor(Math.log10(Math.abs(value)));
    const scale = Math.pow(10, exp);
    const scaledVal = value / scale;
    const scaledLow = low / scale;
    const scaledHigh = high / scale;
    const { decimals } = getPdgPrecision(refErr / scale);

    const valStr = roundTo(scaledVal, decimals);
    const lowStr = roundTo(scaledLow, decimals);
    const highStr = roundTo(scaledHigh, decimals);
    const expStr = superscriptExponent(exp);

    const formatted = `(${valStr} +${highStr} / -${lowStr}) × 10${expStr}${unitSuffix}`;
    return {
      formatted,
      valueStr: valStr,
      errorLowStr: lowStr,
      errorHighStr: highStr,
      unit,
      isDerived: options?.isDerived,
      isAsymmetric: true,
    };
  }

  const { decimals } = getPdgPrecision(refErr);
  const valStr = roundTo(value, decimals);
  const lowStr = roundTo(low, decimals);
  const highStr = roundTo(high, decimals);

  const formatted = `${valStr} +${highStr} / -${lowStr}${unitSuffix}`;
  return {
    formatted,
    valueStr: valStr,
    errorLowStr: lowStr,
    errorHighStr: highStr,
    unit,
    isDerived: options?.isDerived,
    isAsymmetric: true,
  };
}
