/**
 * Parser and formatter for ChemEx parameter labels.
 * Transforms raw internal strings like "R2_A, NUC->55N, B0->600.3MHZ"
 * into formatted symbols (R₂⁰(A)), residue identifiers (55N), and field strengths (600 MHz).
 */

export interface ParsedParameterLabel {
  raw: string;
  cleanKey: string;
  symbol: string;
  displaySymbol: string;
  residue: string;
  field: string;
  category: 'global' | 'chemical_shift' | 'relaxation' | 'other';
  unit: string;
}

export function parseParameterLabel(rawName: string): ParsedParameterLabel {
  const clean = rawName.trim().replace(/^\[|\]$/g, '').trim();
  const parts = clean.split(',').map(s => s.trim());
  const baseParam = parts[0].toUpperCase();

  let residue = '';
  let field = '';

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    if (part.toUpperCase().startsWith('NUC->')) {
      residue = part.substring(5).trim();
    } else if (part.toUpperCase().startsWith('B0->')) {
      const fieldRaw = part.substring(4).trim();
      const numMatch = fieldRaw.match(/([\d.]+)/);
      if (numMatch) {
        const mhz = Math.round(parseFloat(numMatch[1]));
        field = `${mhz} MHz`;
      } else {
        field = fieldRaw;
      }
    }
  }

  // Symbol Formatting
  let symbol = baseParam;
  let displaySymbol = baseParam;
  let category: 'global' | 'chemical_shift' | 'relaxation' | 'other' = 'other';
  let unit = '';

  switch (baseParam) {
    case 'KEX_AB':
    case 'KEX':
      symbol = 'k_ex';
      displaySymbol = 'k_ex(AB)';
      if (!residue) {
        category = 'global';
        residue = 'Global';
        field = 'Global';
      } else {
        category = 'relaxation';
        field = field || '—';
      }
      unit = 's⁻¹';
      break;
    case 'PB':
      symbol = 'p_B';
      displaySymbol = 'p_B';
      if (!residue) {
        category = 'global';
        residue = 'Global';
        field = 'Global';
      } else {
        category = 'relaxation';
        field = field || '—';
      }
      unit = 'fraction';
      break;
    case 'PA':
      symbol = 'p_A';
      displaySymbol = 'p_A';
      if (!residue) {
        category = 'global';
        residue = 'Global';
        field = 'Global';
      } else {
        category = 'relaxation';
        field = field || '—';
      }
      unit = 'fraction';
      break;
    case 'KAB':
      symbol = 'k_AB';
      displaySymbol = 'k_AB';
      if (!residue) {
        category = 'global';
        residue = 'Global';
        field = 'Global';
      } else {
        category = 'relaxation';
        field = field || '—';
      }
      unit = 's⁻¹';
      break;
    case 'KBA':
      symbol = 'k_BA';
      displaySymbol = 'k_BA';
      if (!residue) {
        category = 'global';
        residue = 'Global';
        field = 'Global';
      } else {
        category = 'relaxation';
        field = field || '—';
      }
      unit = 's⁻¹';
      break;
    case 'TAU_B':
    case 'TAUB':
      symbol = 'τ_B';
      displaySymbol = 'τ_B';
      if (!residue) {
        category = 'global';
        residue = 'Global';
        field = 'Global';
      } else {
        category = 'relaxation';
        field = field || '—';
      }
      unit = 'ms';
      break;
    case 'TAUC_A':
    case 'TAUC':
      symbol = 'τ_c';
      displaySymbol = 'τ_c';
      category = 'global';
      residue = 'Global';
      field = 'Global';
      unit = 'ns';
      break;
    case 'CS_A':
      symbol = 'CS_A';
      displaySymbol = 'δ_A';
      category = 'chemical_shift';
      unit = 'ppm';
      break;
    case 'CS_B':
      symbol = 'CS_B';
      displaySymbol = 'δ_B';
      category = 'chemical_shift';
      unit = 'ppm';
      break;
    case 'DW_AB':
    case 'DW':
      symbol = 'Δω_AB';
      displaySymbol = 'Δω_AB';
      category = 'chemical_shift';
      unit = 'ppm';
      break;
    case 'DW_AC':
      symbol = 'Δω_AC';
      displaySymbol = 'Δω_AC';
      category = 'chemical_shift';
      unit = 'ppm';
      break;
    case 'R1_A':
      symbol = 'R₁_A';
      displaySymbol = 'R₁⁰(A)';
      category = 'relaxation';
      unit = 's⁻¹';
      break;
    case 'R2_A':
      symbol = 'R₂_A';
      displaySymbol = 'R₂⁰(A)';
      category = 'relaxation';
      unit = 's⁻¹';
      break;
    case 'R2_B':
      symbol = 'R₂_B';
      displaySymbol = 'R₂⁰(B)';
      category = 'relaxation';
      unit = 's⁻¹';
      break;
    case 'R1_B':
      symbol = 'R₁_B';
      displaySymbol = 'R₁⁰(B)';
      category = 'relaxation';
      unit = 's⁻¹';
      break;
    case 'R1RHO_A':
      symbol = 'R₁ρ_A';
      displaySymbol = 'R₁ρ(A)';
      category = 'relaxation';
      unit = 's⁻¹';
      break;
    default:
      if (baseParam.startsWith('CS_')) {
        symbol = baseParam;
        displaySymbol = `δ_${baseParam.substring(3)}`;
        category = 'chemical_shift';
        unit = 'ppm';
      } else if (baseParam.startsWith('DW_')) {
        symbol = baseParam;
        displaySymbol = `Δω_${baseParam.substring(3)}`;
        category = 'chemical_shift';
        unit = 'ppm';
      } else if (baseParam.startsWith('R1_')) {
        symbol = baseParam;
        displaySymbol = `R₁(${baseParam.substring(3)})`;
        category = 'relaxation';
        unit = 's⁻¹';
      } else if (baseParam.startsWith('R2_')) {
        symbol = baseParam;
        displaySymbol = `R₂(${baseParam.substring(3)})`;
        category = 'relaxation';
        unit = 's⁻¹';
      }
      break;
  }

  return {
    raw: rawName,
    cleanKey: clean,
    symbol,
    displaySymbol,
    residue: residue || (category === 'global' ? 'Global' : '—'),
    field: field || (category === 'global' ? 'Global' : '—'),
    category,
    unit,
  };
}

/**
 * Converts chemical shift differences in ppm to frequency units in Hz
 * at a given spectrometer proton frequency B0 (in MHz) and nucleus type.
 * Default 15N gyromagnetic ratio ratio ~ 0.10137 x 1H freq.
 */
export function ppmToHz(dwPpm: number, b0MHz: number = 600.0, nucleus: string = '15N'): number {
  let gammaRatio = 0.10137; // 15N / 1H
  if (nucleus.toUpperCase().includes('13C')) {
    gammaRatio = 0.25145;
  } else if (nucleus.toUpperCase().includes('1H')) {
    gammaRatio = 1.0;
  }
  const larmorFreqMHz = b0MHz * gammaRatio;
  return dwPpm * larmorFreqMHz;
}
