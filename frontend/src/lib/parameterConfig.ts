/**
 * Data structures and types for structured, provenance-tracked ChemEx parameter configuration.
 */

export type SourceKind = 'pick' | 'manual' | 'default' | 'imported' | 'inherited' | 'estimated_from_rex';

export type Source =
  | { kind: 'pick'; pickSetHash: string; at: string }
  | { kind: 'manual'; at?: string }
  | { kind: 'default' }
  | { kind: 'imported' }
  | { kind: 'inherited'; sourceRunId: string; sourceRunLabel: string; at: string }
  | { kind: 'estimated_from_rex'; at?: string };

export interface ParamValue {
  value: number;
  err?: number | null;
  source: Source;
}

export interface ResidueParams {
  cs_a?: ParamValue;
  dw_ab?: ParamValue;
  dw_ac?: ParamValue;
  dw_ad?: ParamValue;
  dw_ae?: ParamValue;
  dw_af?: ParamValue;
  r1_a?: ParamValue;
  r2_a?: ParamValue;
  r1_b?: ParamValue;
  r2_b?: ParamValue;
  [key: string]: ParamValue | undefined;
}

export interface ParameterConfig {
  globals: Record<string, ParamValue>;
  residues: Record<string, ResidueParams>;
  excludedResidues?: string[];
  rawOverride?: string;
  inheritedFrom?: {
    sourceRunId: string;
    sourceRunLabel: string;
    at: string;
  };
}

export interface ParseResult {
  config: ParameterConfig;
  unparsed: string[];
}

export interface PickSetData {
  cs_a: number | null;
  cs_b: number | null;
  cs_c?: number | null;
  cs_d?: number | null;
  cs_e?: number | null;
  cs_f?: number | null;
}

import {
  normalizeResidueKey,
  extractResidueNumber,
  parseSpinKey,
  sortSpinKeys,
  deduplicateSpinKeys,
  SpinSystemKey,
} from './spinSystem';

export {
  normalizeResidueKey,
  extractResidueNumber,
  parseSpinKey,
  sortSpinKeys,
  deduplicateSpinKeys,
  SpinSystemKey,
};

/**
 * Computes a deterministic hash string for a set of picks for a residue.
 */
export function computePickHash(pick: PickSetData | null | undefined): string {
  if (!pick) return 'none';
  const a = pick.cs_a != null && !isNaN(pick.cs_a) ? pick.cs_a.toFixed(4) : 'null';
  const b = pick.cs_b != null && !isNaN(pick.cs_b) ? pick.cs_b.toFixed(4) : 'null';
  const c = pick.cs_c != null && !isNaN(pick.cs_c) ? pick.cs_c.toFixed(4) : 'null';
  const d = pick.cs_d != null && !isNaN(pick.cs_d) ? pick.cs_d.toFixed(4) : 'null';
  const e = pick.cs_e != null && !isNaN(pick.cs_e) ? pick.cs_e.toFixed(4) : 'null';
  const f = pick.cs_f != null && !isNaN(pick.cs_f) ? pick.cs_f.toFixed(4) : 'null';
  return `a:${a}|b:${b}|c:${c}|d:${d}|e:${e}|f:${f}`;
}

/**
 * Creates default initial parameter config.
 * Uses 4 ns for TAUC_A instead of 4e-9 s.
 */
export function createDefaultParameterConfig(): ParameterConfig {
  return {
    globals: {
      pb: { value: 0.05, source: { kind: 'default' } },
      kex_ab: { value: 500.0, source: { kind: 'default' } },
      tauc_a: { value: 4.0, source: { kind: 'default' } },
    },
    residues: {},
  };
}

export interface ProfileRef {
  residue: string;
  full_residue?: string;
}

/**
 * Resolves a residue key to its canonical identifier based on available profiles and standard naming rules.
 * E.g. 'LYS3N', 'K3N', '3N' all map to the canonical profile key (or normalized 1-letter code).
 */
export function getCanonicalResidueKey(
  rawKey: string,
  profiles?: ProfileRef[]
): string {
  if (!rawKey) return '';
  const trimmed = rawKey.trim();
  const normalized = normalizeResidueKey(trimmed);
  const num = extractResidueNumber(trimmed);

  if (profiles && profiles.length > 0) {
    // 1. Direct match on profile.residue (case-insensitive)
    const exactRes = profiles.find(p => p.residue.toLowerCase() === trimmed.toLowerCase());
    if (exactRes) return exactRes.residue;

    // 2. Direct match on profile.full_residue
    const exactFull = profiles.find(
      p => p.full_residue && p.full_residue.toLowerCase() === trimmed.toLowerCase()
    );
    if (exactFull) return exactFull.residue;

    // 3. Match normalized 1-letter representation (e.g. LYS3N -> K3N matches full_residue K3N)
    const normMatch = profiles.find(
      p =>
        normalizeResidueKey(p.residue).toLowerCase() === normalized.toLowerCase() ||
        (p.full_residue && normalizeResidueKey(p.full_residue).toLowerCase() === normalized.toLowerCase())
    );
    if (normMatch) return normMatch.residue;

    // 4. Match by residue number (e.g. 3 matches profile '3N' or 'K3N')
    if (num > 0) {
      const numMatch = profiles.find(p => extractResidueNumber(p.residue) === num);
      if (numMatch) return numMatch.residue;
    }
  }

  // Fallback: return normalized (1-letter code + number + atom, e.g. 'K3N' or '3N')
  return normalized;
}

/**
 * Normalizes and deduplicates a ParameterConfig by merging duplicate alias keys (e.g. '3N', 'K3N', 'LYS3N')
 * into their single canonical key.
 */
export function canonicalizeParameterConfig(
  config: ParameterConfig,
  profiles?: ProfileRef[]
): ParameterConfig {
  const mergedResidues: Record<string, ResidueParams> = {};

  for (const [rawKey, rParams] of Object.entries(config.residues || {})) {
    if (!rParams) continue;
    const canonical = getCanonicalResidueKey(rawKey, profiles);
    const existing = mergedResidues[canonical] || {};

    const merged: ResidueParams = { ...existing };
    for (const [pKey, pVal] of Object.entries(rParams)) {
      if (pVal && pVal.value !== undefined && !isNaN(pVal.value)) {
        // If not already present or if current value is manual/higher priority, update
        if (!merged[pKey] || pVal.source.kind === 'manual' || merged[pKey]?.source.kind === 'default') {
          merged[pKey] = pVal;
        }
      }
    }
    mergedResidues[canonical] = merged;
  }

  const canonicalExcluded = Array.from(
    new Set(
      (config.excludedResidues || [])
        .map(r => getCanonicalResidueKey(r, profiles))
        .filter(Boolean)
    )
  );

  return {
    ...config,
    residues: mergedResidues,
    excludedResidues: canonicalExcluded.length > 0 ? canonicalExcluded : undefined,
  };
}

/**
 * Checks if a residue is excluded in the ParameterConfig.
 */
export function isResidueExcluded(
  config: ParameterConfig,
  resKey: string,
  profiles?: ProfileRef[]
): boolean {
  if (!config.excludedResidues || config.excludedResidues.length === 0) return false;
  const canonical = getCanonicalResidueKey(resKey, profiles).toUpperCase();
  const num = extractResidueNumber(resKey);
  return config.excludedResidues.some(r => {
    const c = getCanonicalResidueKey(r, profiles).toUpperCase();
    if (c === canonical) return true;
    const rNum = extractResidueNumber(r);
    return num > 0 && rNum > 0 && num === rNum;
  });
}

/**
 * Toggles the exclusion state of a residue in the ParameterConfig.
 */
export function toggleExcludeResidue(
  config: ParameterConfig,
  resKey: string,
  profiles?: ProfileRef[]
): ParameterConfig {
  const canonical = getCanonicalResidueKey(resKey, profiles);
  const currentExcluded = new Set(
    (config.excludedResidues || []).map(r => getCanonicalResidueKey(r, profiles))
  );

  if (currentExcluded.has(canonical)) {
    currentExcluded.delete(canonical);
  } else {
    currentExcluded.add(canonical);
  }

  const nextList = Array.from(currentExcluded);
  return {
    ...config,
    excludedResidues: nextList.length > 0 ? nextList : undefined,
  };
}

/**
 * Applies grid search minimum coordinates to ParameterConfig.
 * - Global parameters (PB, KEX_AB, TAUC_A, etc.) update `config.globals`.
 * - Per-residue parameters (e.g. DW_AB, NUC->14N or DW_AB (14N)) update the respective
 *   residue in `config.residues` under `[DW_AB]` (and recalculate `cs_b` if `cs_a` exists).
 * - Ensures per-residue parameters are NEVER placed in `config.globals`.
 */
export function applyGridCoordinatesToConfig(
  currentConfig: ParameterConfig,
  coords: Record<string, number | null | undefined>,
  activeGroup?: string
): { nextConfig: ParameterConfig; updatedCount: number } {
  const now = new Date().toISOString();
  const nextConfig: ParameterConfig = {
    ...currentConfig,
    globals: { ...currentConfig.globals },
    residues: { ...currentConfig.residues },
  };

  // Clean any erroneous residue keys from globals if they previously existed
  for (const gKey of Object.keys(nextConfig.globals)) {
    if (gKey.includes('dw_ab') || gKey.includes('nuc->') || gKey.includes(',') || gKey.includes('(')) {
      delete nextConfig.globals[gKey];
    }
  }

  let updatedCount = 0;
  const existingResKeys = Object.keys(nextConfig.residues);

  for (const [rawKey, rawVal] of Object.entries(coords)) {
    if (rawVal === null || rawVal === undefined || isNaN(Number(rawVal))) {
      continue;
    }
    const val = typeof rawVal === 'number' ? parseFloat(rawVal.toFixed(4)) : (Number(rawVal) || 0);
    const kTrimmed = rawKey.trim().replace(/[\[\]]/g, '');
    const kUpper = kTrimmed.toUpperCase();

    // Check if this is a per-residue parameter
    const isPerResidue = kUpper.includes('DW_') ||
      kUpper.includes('CS_') ||
      kUpper.includes('R1_') ||
      kUpper.includes('R2_') ||
      kUpper.includes('NUC->') ||
      (Boolean(activeGroup) && !['PB', 'KEX_AB', 'TAUC_A', 'KAB', 'KBA'].includes(kUpper));

    if (isPerResidue) {
      let paramSection = 'dw_ab';
      if (kUpper.includes('CS_A')) paramSection = 'cs_a';
      else if (kUpper.includes('CS_B')) paramSection = 'cs_b';
      else if (kUpper.includes('DW_AC')) paramSection = 'dw_ac';
      else if (kUpper.includes('DW_AB') || kUpper.startsWith('DW')) paramSection = 'dw_ab';
      else if (kUpper.includes('R2_A')) paramSection = 'r2_a';
      else if (kUpper.includes('R2_B')) paramSection = 'r2_b';
      else if (kUpper.includes('R1_A')) paramSection = 'r1_a';

      // Extract nucleus/residue tag e.g. "14N" from "DW_AB, NUC->14N", "DW_AB (14N)", "1_14N"
      let tag = '';
      if (kTrimmed.includes('NUC->')) {
        tag = kTrimmed.split('NUC->')[1]?.trim().replace(/[\[\]]/g, '') || '';
      } else if (kTrimmed.includes('(') && kTrimmed.includes(')')) {
        tag = kTrimmed.split('(')[1]?.split(')')[0]?.trim() || '';
      } else if (activeGroup) {
        tag = activeGroup.replace(/^\d+_/, '').trim();
      }

      if (!tag && kTrimmed.includes(',')) {
        tag = kTrimmed.split(',')[1]?.trim() || '';
      }

      // Match tag to a residue key in nextConfig.residues
      let targetResKey: string | null = null;
      if (tag) {
        targetResKey = existingResKeys.find(r => r.toUpperCase() === tag.toUpperCase()) || null;
        if (!targetResKey) {
          targetResKey = existingResKeys.find(r => r.toUpperCase().endsWith(tag.toUpperCase())) || null;
        }
        if (!targetResKey) {
          const tagNum = tag.match(/\d+/)?.[0];
          if (tagNum) {
            targetResKey = existingResKeys.find(r => r.match(/\d+/)?.[0] === tagNum) || null;
          }
        }
      }

      if (!targetResKey) {
        targetResKey = tag || (activeGroup ? activeGroup.replace(/^\d+_/, '') : 'UNKNOWN');
      }

      if (!nextConfig.residues[targetResKey]) {
        nextConfig.residues[targetResKey] = {};
      }
      const existingRes = { ...nextConfig.residues[targetResKey] };
      existingRes[paramSection] = {
        value: val,
        source: { kind: 'manual', at: now },
      };

      // Do not add [CS_B] to parameterConfig/TOML - ensure cs_b is omitted so only [DW_AB] is generated
      if (paramSection === 'dw_ab') {
        delete existingRes.cs_b;
      }

      nextConfig.residues[targetResKey] = existingRes;
      // Guarantee it does not exist in globals
      delete nextConfig.globals[kTrimmed.toLowerCase()];
      updatedCount++;
    } else {
      // Global parameter
      const gKey = kTrimmed.toLowerCase();
      nextConfig.globals[gKey] = {
        value: val,
        source: { kind: 'manual', at: now },
      };
      updatedCount++;
    }
  }

  return { nextConfig, updatedCount };
}

