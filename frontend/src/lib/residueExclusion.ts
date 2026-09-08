/**
 * Utility functions for residue exclusion filtering across
 * plots, tables, statistics cards, and exports.
 */

import { parseParameterLabel } from './parameterSymbols';

/**
 * Check whether a residue identifier (e.g., "10PHE", "10", 10, "55N")
 * is included in the user's excluded residues list.
 */
export function isResidueExcluded(
  residue: string | number | undefined | null,
  excludedResidues?: string[]
): boolean {
  if (!residue || !excludedResidues || excludedResidues.length === 0) {
    return false;
  }

  const resStr = String(residue).trim().toUpperCase();
  if (!resStr) return false;

  const resDigits = resStr.match(/\d+/)?.[0];
  const resLetters = resStr.replace(/[\d\W_]+/g, '');

  for (const ex of excludedResidues) {
    if (!ex) continue;
    const exStr = String(ex).trim().toUpperCase();
    if (!exStr) continue;

    // 1. Exact string match
    if (resStr === exStr) {
      return true;
    }

    // 2. Numeric match with compatible letters
    const exDigits = exStr.match(/\d+/)?.[0];
    const exLetters = exStr.replace(/[\d\W_]+/g, '');

    if (resDigits && exDigits && resDigits === exDigits) {
      // If letters exist on both, they must match. If either is purely numeric, it matches.
      if (!resLetters || !exLetters || resLetters === exLetters) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check whether a parameter label (e.g., "[R2, NUC->10PHE]", "R2, NUC->10PHE", "I0, NUC->10PHE")
 * belongs to an excluded residue. Global parameters are never excluded.
 */
export function isParameterExcluded(
  paramName: string,
  excludedResidues?: string[]
): boolean {
  if (!paramName || !excludedResidues || excludedResidues.length === 0) {
    return false;
  }

  const parsed = parseParameterLabel(paramName);
  if (parsed.category === 'global') {
    return false;
  }

  // If parsed residue is identified
  if (parsed.residue && parsed.residue !== 'Global' && parsed.residue !== '—') {
    if (isResidueExcluded(parsed.residue, excludedResidues)) {
      return true;
    }
  }

  // Fallback: check if raw parameter string contains NUC->{ex} or similar
  const upperParam = paramName.toUpperCase();
  for (const ex of excludedResidues) {
    if (!ex) continue;
    const exUpper = String(ex).trim().toUpperCase();
    if (!exUpper) continue;

    if (upperParam.includes(`NUC->${exUpper}`) || upperParam.includes(`, ${exUpper}`) || upperParam.includes(`,${exUpper}`)) {
      return true;
    }

    // If numeric part exists
    const exDigits = exUpper.match(/\d+/)?.[0];
    if (exDigits && (upperParam.includes(`NUC->${exDigits}`) || upperParam.includes(`, ${exDigits}`) || upperParam.includes(`,${exDigits}`))) {
      return true;
    }
  }

  return false;
}

/**
 * Filters a correlation matrix by removing parameters associated with excluded residues.
 */
export function filterCorrelations(
  correlations?: { parameters: string[]; matrix: number[][] },
  excludedResidues?: string[]
): { parameters: string[]; matrix: number[][] } | undefined {
  if (!correlations || !Array.isArray(correlations.parameters) || !Array.isArray(correlations.matrix)) {
    return correlations;
  }
  if (!excludedResidues || excludedResidues.length === 0) {
    return correlations;
  }

  const keepIndices: number[] = [];
  const filteredParams: string[] = [];

  correlations.parameters.forEach((param, idx) => {
    if (!isParameterExcluded(param, excludedResidues)) {
      keepIndices.push(idx);
      filteredParams.push(param);
    }
  });

  if (keepIndices.length === correlations.parameters.length) {
    return correlations;
  }

  const filteredMatrix: number[][] = keepIndices.map(rowIdx =>
    keepIndices.map(colIdx => correlations.matrix[rowIdx]?.[colIdx] ?? 0)
  );

  return {
    parameters: filteredParams,
    matrix: filteredMatrix,
  };
}
