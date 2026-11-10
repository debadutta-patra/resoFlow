/**
 * CPMG specifics on top of the shared ChemEx parameter model.
 *
 * CPMG analyses use the same `ParameterConfig` and the same parameters.toml codec as
 * CEST and EXCHANGE (`parameterToml.ts`). What remains here is genuinely CPMG-specific:
 * default globals (universal DW_AB), canonical single-spin residue keys (`3LYS` → `3N`),
 * migration of configs saved by the old CPMG-only model, and grid-search application.
 */

import type { ParameterConfig, ParamValue, PickSetData, ResidueParams } from "./parameterConfig";
import { computePickHash, withValue } from "./parameterConfig";
import { configToToml, tomlToConfig, type TomlParseResult, type TomlWriteOptions } from "./parameterToml";
import { SpinSystemKey } from "./spinSystem";

/** @deprecated CPMG uses the shared model; kept as an alias for existing imports. */
export type CpmgParameterConfig = ParameterConfig;
/** @deprecated CPMG uses the shared model; kept as an alias for existing imports. */
export type CpmgResidueParams = ResidueParams;
export type CpmgParseResult = TomlParseResult;

export function createDefaultCpmgParameterConfig(): ParameterConfig {
  return {
    globals: {
      pb: { value: 0.05, source: { kind: "default" } },
      kex_ab: { value: 500.0, source: { kind: "default" } },
      dw_ab: { value: 2.0, source: { kind: "default" } },
      tauc_a: { value: 4.0, source: { kind: "default" } },
    },
    residues: {},
    excludedResidues: [],
  };
}

/** Canonical CPMG residue key: single-spin keys collapse to `<num>N` (e.g. `3LYS` → `3N`). */
export function canonicalCpmgResidueKey(rawKey: string): string {
  const parsed = SpinSystemKey.parse(rawKey);
  return parsed.resNum > 0 && parsed.spins.length <= 1 ? `${parsed.resNum}N` : parsed.short || rawKey;
}

/**
 * Merge residue aliases onto canonical keys, parameter by parameter; for a parameter
 * present under several aliases, the entry already on the canonical key wins.
 */
export function canonicalizeCpmgResidues(config: ParameterConfig): ParameterConfig {
  const residues: Record<string, ResidueParams> = {};
  for (const [rawKey, params] of Object.entries(config.residues || {})) {
    const key = canonicalCpmgResidueKey(rawKey);
    residues[key] = rawKey === key ? { ...residues[key], ...params } : { ...params, ...residues[key] };
  }
  const excluded = Array.from(new Set((config.excludedResidues || []).map(canonicalCpmgResidueKey)));
  return { ...config, residues, excludedResidues: excluded };
}

const isParamValue = (v: unknown): v is ParamValue =>
  !!v && typeof v === "object" && typeof (v as ParamValue).value === "number" && "source" in (v as object);

/**
 * Convert a parameter config saved by the old CPMG-only model into the shared model:
 * - default globals are filled in,
 * - residue keys are canonicalized,
 * - legacy per-field records (`r2_a: { "600": {...} }`) are dropped (they were never
 *   written to parameters.toml, so dropping them keeps the emitted TOML unchanged),
 * - `inheritedFrom` is converted to the shared `{ sourceRunId, sourceRunLabel, at }` shape.
 */
export function migrateLegacyCpmgParameterConfig(raw: any): ParameterConfig {
  const defaults = createDefaultCpmgParameterConfig();
  if (!raw || typeof raw !== "object") return defaults;

  const residues: Record<string, ResidueParams> = {};
  for (const [key, params] of Object.entries<any>(raw.residues || {})) {
    const clean: ResidueParams = {};
    for (const [pKey, pVal] of Object.entries<any>(params || {})) {
      if (isParamValue(pVal)) clean[pKey] = pVal;
    }
    residues[key] = clean;
  }

  const inh = raw.inheritedFrom;
  const inheritedFrom = inh
    ? {
        sourceRunId: inh.sourceRunId ?? inh.analysisUuid ?? "",
        sourceRunLabel: inh.sourceRunLabel ?? inh.analysisName ?? "",
        at: inh.at ?? inh.timestamp ?? "",
      }
    : undefined;

  return canonicalizeCpmgResidues({
    ...raw,
    globals: { ...defaults.globals, ...(raw.globals || {}) },
    residues,
    excludedResidues: Array.isArray(raw.excludedResidues) ? raw.excludedResidues : [],
    ...(inheritedFrom ? { inheritedFrom } : {}),
  });
}

/** Minimal profile shape needed to seed CS_A from peak fitting. */
export interface PeakFitProfileRef {
  residue: string;
  full_residue?: string;
  cs_a?: number | null;
}

/**
 * CPMG's equivalent of CEST picks: the ground-state shift measured by peak fitting.
 * There is no B-state pick, so `cs_b` is always null.
 */
export function peakFitPicks(profiles: PeakFitProfileRef[]): Record<string, PickSetData> {
  const out: Record<string, PickSetData> = {};
  for (const p of profiles) {
    if (p?.residue && typeof p.cs_a === "number" && !Number.isNaN(p.cs_a)) {
      out[p.residue] = { cs_a: p.cs_a, cs_b: null };
    }
  }
  return out;
}

/**
 * Build the residue map for the current profiles, keeping existing per-residue values
 * and seeding missing CS_A from peak fitting (with a real pick hash for stale detection).
 */
export function seedCpmgResiduesFromProfiles(
  config: ParameterConfig,
  profiles: PeakFitProfileRef[],
  at: string = new Date().toISOString()
): ParameterConfig {
  const picks = peakFitPicks(profiles);
  const residues: Record<string, ResidueParams> = {};
  for (const p of profiles) {
    if (!p?.residue) continue;
    const existing = config.residues?.[p.residue] || (p.full_residue ? config.residues?.[p.full_residue] : undefined) || {};
    const pick = picks[p.residue];
    residues[p.residue] = {
      ...existing,
      cs_a:
        existing.cs_a ||
        (pick ? { value: pick.cs_a as number, source: { kind: "pick", pickSetHash: computePickHash(pick), at } } : undefined),
    };
  }
  return { ...config, residues };
}

/** CPMG parameters.toml writer: the shared writer over canonical CPMG residue keys. */
export function configToCpmgToml(config?: ParameterConfig, opts: TomlWriteOptions = {}): string {
  return configToToml(canonicalizeCpmgResidues(config ?? createDefaultCpmgParameterConfig()), opts);
}

/** CPMG parameters.toml reader: the shared reader, defaults filled in, keys canonicalized. */
export function cpmgTomlToConfig(tomlText: string): TomlParseResult {
  const parsed = tomlToConfig(tomlText);
  const defaults = createDefaultCpmgParameterConfig();
  // CPMG dispersion is insensitive to the sign of Δω; keep magnitudes as before.
  for (const params of Object.values(parsed.config.residues)) {
    for (const [pKey, pVal] of Object.entries(params)) {
      if (pKey.startsWith("dw_") && pVal) params[pKey] = { ...pVal, value: Math.abs(pVal.value) };
    }
  }
  return {
    config: canonicalizeCpmgResidues({
      ...parsed.config,
      globals: { ...defaults.globals, ...parsed.config.globals },
    }),
    unparsed: parsed.unparsed,
  };
}

/**
 * Applies grid search minimum coordinates to CpmgParameterConfig.
 * - Global parameters (PB, KEX_AB, TAUC_A, etc.) update `config.globals`.
 * - Per-residue parameters (e.g. DW_AB, NUC->32N or DW_AB (32N)) update the respective
 *   residue in `config.residues` under `dw_ab`.
 * - Ensures per-residue parameters are NEVER placed in `config.globals`.
 */
export function applyGridCoordinatesToCpmgConfig(
  currentConfig: CpmgParameterConfig,
  coords: Record<string, number | null | undefined>,
  activeGroup?: string
): { nextConfig: CpmgParameterConfig; updatedCount: number } {
  const now = new Date().toISOString();
  const nextConfig: CpmgParameterConfig = {
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

    // Check if this is a per-residue parameter (e.g. DW_AB, CS_A, R2_A)
    const isPerResidue = (kUpper.includes('DW') ||
      kUpper.includes('CS') ||
      kUpper.includes('R1') ||
      kUpper.includes('R2')) &&
      !['TAUC_A', 'TAUC'].includes(kUpper);

    if (isPerResidue) {
      let paramSection: "cs_a" | "dw_ab" | null = null;
      if (kUpper.includes('CS_A') || kUpper.startsWith('CS')) paramSection = 'cs_a';
      else if (kUpper.includes('DW_AB') || kUpper.includes('DW_') || kUpper.startsWith('DW')) paramSection = 'dw_ab';

      // Extract nucleus/residue tag e.g. "32N" from "DW_AB, NUC->32N", "DW_AB (32N)", "1_R2_A_32N_600.3MHZ"
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
        const numMatch = (tag || activeGroup || '').match(/\d+/)?.[0];
        targetResKey = numMatch ? `${numMatch}N` : (tag || (activeGroup ? activeGroup.replace(/^\d+_/, '') : 'UNKNOWN'));
      }

      if (!nextConfig.residues[targetResKey]) {
        nextConfig.residues[targetResKey] = {};
      }
      const existingRes = { ...nextConfig.residues[targetResKey] };

      if (paramSection === 'dw_ab' || paramSection === 'cs_a') {
        existingRes[paramSection] = withValue(existingRes[paramSection], val, { kind: 'manual', at: now });
        nextConfig.residues[targetResKey] = existingRes;
      }

      delete nextConfig.globals[kTrimmed.toLowerCase()];
      updatedCount++;
    } else {
      let gKey = kTrimmed.toLowerCase();
      if (kUpper.includes('PB')) gKey = 'pb';
      else if (kUpper.includes('KEX')) gKey = 'kex_ab';
      else if (kUpper.includes('TAUC')) gKey = 'tauc_a';

      nextConfig.globals[gKey] = withValue(nextConfig.globals[gKey], val, { kind: 'manual', at: now });
      updatedCount++;
    }
  }

  return { nextConfig, updatedCount };
}


