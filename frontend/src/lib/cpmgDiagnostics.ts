export interface DiagnosticWarning {
  code: string;
  severity: "error" | "warning" | "info";
  title: string;
  message: string;
}

export interface CpmgDiagnosticsResult {
  warnings: DiagnosticWarning[];
  regimes: Record<string, string>;
  fast_exchange_count: number;
  total_residues: number;
}

export function evaluateCpmgDiagnostics(
  globalParams: Record<string, { value?: number; error?: number }>,
  residueParams: Record<string, Record<string, { value?: number; error?: number }>>,
  numFields: number = 1
): CpmgDiagnosticsResult {
  const warnings: DiagnosticWarning[] = [];
  const regimes: Record<string, string> = {};
  const fastExchangeResidues: string[] = [];

  // 1. Static Field Warning
  if (numFields < 2) {
    warnings.push({
      code: "SINGLE_FIELD",
      severity: "warning",
      title: "Single Static Magnetic Field",
      message: "Only one static field present. Reliably separating pb from |dw| in CPMG generally requires two or more magnetic fields.",
    });
  }

  // 2. Global kex sensitivity window
  const kexVal = globalParams["kex_ab"]?.value;
  const pbVal = globalParams["pb"]?.value;
  const pbErr = globalParams["pb"]?.error;

  if (kexVal !== undefined) {
    if (kexVal < 150.0) {
      warnings.push({
        code: "KEX_TOO_SLOW",
        severity: "warning",
        title: "Slow Exchange Limit for CPMG",
        message: `kex (${kexVal.toFixed(1)} s⁻¹) is near/below the lower detection limit for CPMG (~150 s⁻¹). Consider CEST experiments for slow exchange.`,
      });
    } else if (kexVal > 10000.0) {
      warnings.push({
        code: "KEX_TOO_FAST",
        severity: "warning",
        title: "Fast Exchange Limit for CPMG",
        message: `kex (${kexVal.toFixed(0)} s⁻¹) is near/above the CPMG pulse train resolution limit (~10,000 s⁻¹).`,
      });
    }
  }

  // 3. Fast exchange product constraint
  for (const [resName, rDict] of Object.entries(residueParams)) {
    const dwVal = rDict["dw_ab"]?.value;
    const dwErr = rDict["dw_ab"]?.error;

    let isFastRegime = false;
    if (pbVal !== undefined && pbErr !== undefined && dwVal !== undefined && dwErr !== undefined) {
      if (pbVal > 0 && Math.abs(dwVal) > 0) {
        if (pbErr / pbVal > 0.25 && dwErr / Math.abs(dwVal) > 0.25) {
          isFastRegime = true;
        }
      }
    }

    if (isFastRegime) {
      fastExchangeResidues.push(resName);
      regimes[resName] = "fast_exchange_product_only";
    } else {
      regimes[resName] = "intermediate_exchange_resolved";
    }
  }

  if (fastExchangeResidues.length > 0) {
    warnings.push({
      code: "PRODUCT_ONLY_CONSTRAINED",
      severity: "info",
      title: "Fast Exchange Product Constraint",
      message: `${fastExchangeResidues.length} residue(s) exhibit high parameter correlation. In this regime, the product pa·pb·dw² is tightly determined, but individual pb and |dw| values have broad confidence intervals.`,
    });
  }

  return {
    warnings,
    regimes,
    fast_exchange_count: fastExchangeResidues.length,
    total_residues: Object.keys(residueParams).length,
  };
}
