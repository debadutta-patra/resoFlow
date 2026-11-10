/**
 * Data structures and types for structured, provenance-tracked ChemEx parameter configuration.
 */

export type SourceKind =
  | 'pick'
  | 'manual'
  | 'default'
  | 'imported'
  | 'inherited'
  | 'estimated_from_rex'
  | 'estimated_from_profile';

export type Source =
  | { kind: 'pick'; pickSetHash: string; at: string }
  | { kind: 'manual'; at?: string }
  | { kind: 'default' }
  | { kind: 'imported' }
  | { kind: 'inherited'; sourceRunId: string; sourceRunLabel: string; at: string }
  | { kind: 'estimated_from_rex'; at?: string }
  /** CS_A estimated from the residue's main (deepest) CEST dip. */
  | { kind: 'estimated_from_profile'; at?: string };

export interface ParamValue {
  value: number;
  err?: number | null;
  source: Source;
  /**
   * Explicit ChemEx bounds (`[init, lower, upper]`), in UI units. When either is set the
   * value is written as a list and replaces ChemEx's default bounds (also the MCMC prior).
   */
  lower?: number;
  upper?: number;
  /** Optional 4th list element (ChemEx brute-force step); round-tripped, not edited. */
  bruteStep?: number;
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

import { fallbackDefaults, type ParamDefaultsLookup } from './chemexDefaults';
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
 * Creates the initial parameter config: nothing is pre-filled, so every parameter starts
 * from ChemEx's own default (shown as a placeholder) until the user or a pick sets it.
 */
export function createDefaultParameterConfig(): ParameterConfig {
  return {
    globals: {},
    residues: {},
  };
}

/**
 * Configs saved before ChemEx defaults were adopted carry resoFlow-chosen globals with
 * `source: default` (PB 0.05, KEX_AB 500, TAUC_A 4, CPMG DW_AB 2.0) that no user set.
 * Drop them so ChemEx's defaults apply. Returns the dropped (upper-case) names.
 */
export function dropLegacyDefaultGlobals(config: ParameterConfig): { config: ParameterConfig; dropped: string[] } {
  const globals: Record<string, ParamValue> = {};
  const dropped: string[] = [];
  for (const [key, pv] of Object.entries(config.globals || {})) {
    const untouched = pv?.source?.kind === 'default' && pv.lower === undefined && pv.upper === undefined;
    if (untouched) dropped.push(key.toUpperCase());
    else if (pv) globals[key] = pv;
  }
  return dropped.length ? { config: { ...config, globals }, dropped } : { config, dropped };
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
      existingRes[paramSection] = withValue(existingRes[paramSection], val, { kind: 'manual', at: now });

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
      nextConfig.globals[gKey] = withValue(nextConfig.globals[gKey], val, { kind: 'manual', at: now });
      updatedCount++;
    }
  }

  return { nextConfig, updatedCount };
}


/**
 * Hash marker written by the old CPMG page for peak-fit seeded CS_A values. It never
 * matches a real pick hash, so it must not be reported as "stale".
 */
export const LEGACY_PEAK_FIT_HASH = 'peak_fit';

/** True when a value seeded from a pick no longer matches the current pick. */
export function isPickSourceStale(source: Source | undefined, pick: PickSetData | null | undefined): boolean {
  if (!source || source.kind !== 'pick') return false;
  const stored = source.pickSetHash;
  if (!stored || stored === LEGACY_PEAK_FIT_HASH) return false;
  return stored !== computePickHash(pick);
}

/** Residues whose CS_A or DW_AB were seeded from a pick that has since moved. */
export function staleResidueKeys(config: ParameterConfig, picks: Record<string, PickSetData>): string[] {
  return Object.entries(config.residues || {})
    .filter(([res, p]) => isPickSourceStale(p?.cs_a?.source, picks[res]) || isPickSourceStale(p?.dw_ab?.source, picks[res]))
    .map(([res]) => res);
}

/**
 * Starting values shown in the Methods tab, taken from every [GLOBAL] parameter
 * (lower- and upper-case keys), with ChemEx's own defaults as fallback.
 */
export function startingValuesFromGlobals(
  config: ParameterConfig,
  lookup: ParamDefaultsLookup = fallbackDefaults
): Record<string, number> {
  const out: Record<string, number> = {};
  const keys = new Set(['pb', 'kex_ab', 'tauc_a', ...Object.keys(config.globals || {})]);
  for (const key of keys) {
    const v = config.globals?.[key]?.value ?? lookup(key)?.value ?? undefined;
    if (v === undefined || Number.isNaN(v)) continue;
    out[key.toLowerCase()] = v;
    out[key.toUpperCase()] = v;
  }
  return out;
}

/** A [GLOBAL] field beyond the model catalogue, declared by an experiment plugin. */
export interface ExtraGlobalField {
  key: string;
  label: string;
  hint?: string;
  /** @deprecated Starting values come from ChemEx's defaults; kept so older plugins still type-check. */
  defaultValue?: number;
}

/** Where a parameter's step-1 starting value comes from, for the Methods tab. */
export interface StartingProvenance {
  /** Single value (global parameters only). */
  value?: number;
  /** Human-readable source, e.g. "Pick CEST", "manual", "Per residue · Pick CEST 10 · default 2". */
  source: string;
}

function sourceLabel(source: Source | undefined, pickLabel: string): string {
  switch (source?.kind) {
    case 'pick':
      return pickLabel;
    case 'manual':
      return 'manual';
    case 'imported':
      return 'imported';
    case 'inherited':
      return `run ${source.sourceRunLabel}`;
    case 'estimated_from_rex':
      return 'Rex estimate';
    case 'estimated_from_profile':
      return 'profile estimate';
    default:
      return 'default';
  }
}

/**
 * Step-1 starting-value provenance per parameter (upper-case names): globals carry
 * their value and source; residue parameters summarise their sources across residues.
 * `pickLabel` names the experiment's pick step (e.g. "Pick CEST").
 */
export function startingProvenance(config: ParameterConfig, pickLabel: string): Record<string, StartingProvenance> {
  const out: Record<string, StartingProvenance> = {};
  for (const [key, pv] of Object.entries(config.globals || {})) {
    if (!pv || Number.isNaN(pv.value)) continue;
    out[key.toUpperCase()] = { value: pv.value, source: sourceLabel(pv.source, pickLabel) };
  }
  const counts: Record<string, Map<string, number>> = {};
  for (const params of Object.values(config.residues || {})) {
    for (const [key, pv] of Object.entries(params || {})) {
      if (!pv) continue;
      const name = key.toUpperCase();
      const label = sourceLabel(pv.source, pickLabel);
      const m = (counts[name] ??= new Map());
      m.set(label, (m.get(label) ?? 0) + 1);
    }
  }
  for (const [name, m] of Object.entries(counts)) {
    if (out[name]) continue;
    const parts = [...m.entries()].sort((a, b) => b[1] - a[1]);
    const detail = parts.length === 1 ? parts[0][0] : parts.map(([label, n]) => `${label} ${n}`).join(' · ');
    out[name] = { source: `Per residue · ${detail}` };
  }
  return out;
}

/**
 * Set or clear one bound of a parameter. ChemEx needs an initial value next to bounds,
 * so a parameter without a value takes `fallbackValue` (the displayed / ChemEx default).
 * Returns undefined when nothing is left to write (no value was set and bounds are cleared).
 */
export function withBound(
  pv: ParamValue | undefined,
  side: 'lower' | 'upper',
  bound: number | undefined,
  fallbackValue: number | null | undefined,
  at: string = new Date().toISOString()
): ParamValue | undefined {
  if (!pv) {
    if (bound === undefined || fallbackValue === null || fallbackValue === undefined) return undefined;
    return { value: fallbackValue, source: { kind: 'manual', at }, [side]: bound };
  }
  const next: ParamValue = { ...pv };
  if (bound === undefined) delete next[side];
  else next[side] = bound;
  return next;
}

/**
 * A new value and provenance for a parameter, keeping its explicit bounds (and brute step).
 * Use this instead of building `{ value, source }` so an edit or re-sync never drops bounds.
 */
export function withValue(pv: ParamValue | undefined, value: number, source: Source): ParamValue {
  const next: ParamValue = { value, source };
  if (pv?.lower !== undefined) next.lower = pv.lower;
  if (pv?.upper !== undefined) next.upper = pv.upper;
  if (pv?.bruteStep !== undefined) next.bruteStep = pv.bruteStep;
  return next;
}

/** Starting value sources that a bulk estimate may replace (never picks or user/imported values). */
const REPLACEABLE: ReadonlySet<SourceKind> = new Set<SourceKind>(['default', 'estimated_from_profile']);

/**
 * Seed CS_A from each profile's estimate for residues that have no pick and no
 * user/imported/inherited CS_A. Keeps bounds. Returns the residues that were seeded.
 */
export function seedCsAFromProfiles(
  config: ParameterConfig,
  profiles: ProfileRef[],
  picks: Record<string, PickSetData>,
  estimate: (profile: ProfileRef) => number | null,
  at: string = new Date().toISOString()
): { config: ParameterConfig; seeded: string[] } {
  const residues = { ...config.residues };
  const seeded: string[] = [];
  const hasPick = (key: string) => {
    const canonical = getCanonicalResidueKey(key, profiles);
    return Object.entries(picks || {}).some(
      ([k, p]) => p?.cs_a != null && !Number.isNaN(p.cs_a) && getCanonicalResidueKey(k, profiles) === canonical
    );
  };
  for (const profile of profiles) {
    const key = profile.residue;
    if (!key || hasPick(key) || isResidueExcluded(config, key, profiles)) continue;
    const current = residues[key]?.cs_a;
    if (current && !REPLACEABLE.has(current.source.kind)) continue;
    const ppm = estimate(profile);
    if (ppm === null || !Number.isFinite(ppm)) continue;
    residues[key] = {
      ...residues[key],
      cs_a: withValue(current, Number(ppm.toFixed(3)), { kind: 'estimated_from_profile', at }),
    };
    seeded.push(key);
  }
  return { config: seeded.length ? { ...config, residues } : config, seeded };
}

/**
 * Per-residue starting parameters that are not in parameters.toml for this residue, so
 * ChemEx starts them from its default. A [GLOBAL] value counts as set for every residue.
 */
export function unsetStartingParams(config: ParameterConfig, resKey: string, names: string[]): string[] {
  const params = config.residues?.[resKey] || {};
  return names.filter(n => {
    const key = n.toLowerCase();
    const pv = params[key] ?? config.globals?.[key];
    return !pv || Number.isNaN(pv.value);
  });
}

export type ResidueCell = 'cs_a' | 'cs_b' | 'dw_ab' | 'r1_a' | 'r2_a';

/**
 * Edit one residue cell. `undefined` clears it (ChemEx's default, or [GLOBAL], applies).
 * - CS_A: sets CS_A; if DW_AB is set, DW_AB follows so CS_B (= CS_A + DW_AB) stays put.
 * - DW_AB, R1_A, R2_A: set independently (never writes CS_A as a side effect).
 * - CS_B: derived in ChemEx, so it edits DW_AB = CS_B − CS_A; it needs CS_A to be set
 *   (returns the config unchanged otherwise). Clearing CS_B clears DW_AB.
 * Alias keys of the same residue are merged into `resKey`. Bounds are kept.
 */
export function editResidueValue(
  config: ParameterConfig,
  resKey: string,
  field: ResidueCell,
  value: number | undefined,
  profiles?: ProfileRef[],
  at: string = new Date().toISOString()
): ParameterConfig {
  const existing: ResidueParams = { ...(config.residues?.[resKey] || {}) };
  const manual: Source = { kind: 'manual', at };
  const round = (v: number) => parseFloat(v.toFixed(6));

  if (field === 'cs_b') {
    const csA = existing.cs_a?.value;
    if (value === undefined) delete existing.dw_ab;
    else if (csA === undefined || Number.isNaN(csA)) return config;
    else existing.dw_ab = withValue(existing.dw_ab, round(value - csA), manual);
  } else if (value === undefined) {
    delete existing[field];
  } else if (field === 'cs_a') {
    const oldCsA = existing.cs_a?.value;
    const dw = existing.dw_ab?.value;
    existing.cs_a = withValue(existing.cs_a, value, manual);
    if (dw !== undefined && oldCsA !== undefined && !Number.isNaN(oldCsA)) {
      existing.dw_ab = withValue(existing.dw_ab, round(oldCsA + dw - value), manual);
    }
  } else {
    existing[field] = withValue(existing[field], value, manual);
  }

  const residues = { ...config.residues };
  for (const key of Object.keys(residues)) {
    if (key !== resKey && getCanonicalResidueKey(key, profiles) === resKey) delete residues[key];
  }
  residues[resKey] = existing;
  return { ...config, residues };
}
