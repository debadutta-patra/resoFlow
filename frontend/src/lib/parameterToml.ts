import type {
  ParameterConfig,
  ProfileRef,
} from './parameterConfig';
import {
  isResidueExcluded,
  sortSpinKeys,
} from './parameterConfig';
import type { ParamValue } from './parameterConfig';
import { getUnitDef, type ParamUnitDef } from './unitRegistry';
import { fallbackDefaults, type ParamDefaultsLookup } from './chemexDefaults';

export interface TomlWriteOptions {
  /** ChemEx default bounds, used to fill the side the user left unset (default: static table). */
  defaults?: ParamDefaultsLookup;
}

/** One TOML float token (`1_000.5`, `1e-3`, `inf`, `-inf`, `nan`), or null if not a number. */
export function parseTomlFloat(token: string): number | null {
  const t = token.trim().replace(/(?<=\d)_(?=\d)/g, '');
  if (/^[+-]?inf$/.test(t)) return t.startsWith('-') ? -Infinity : Infinity;
  if (/^[+-]?nan$/.test(t)) return NaN;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null;
  return Number(t);
}

export interface ChemexValue {
  value: number;
  lower?: number;
  upper?: number;
  bruteStep?: number;
}

/**
 * Parse a ChemEx parameter value: a scalar, or `[init]`, `[init, lower]`,
 * `[init, lower, upper]`, `[init, lower, upper, brute_step]` (ChemEx `DefaultSetting`).
 * `-inf`/`inf` bounds mean "unset" (as written by run_info/parameters_used.toml).
 * Returns null for anything ChemEx would reject or that is not representable.
 */
export function parseChemexValue(raw: string): ChemexValue | null {
  const s = raw.replace(/\s+#.*$/, '').trim();
  let parts: string[];
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) return null;
    const inside = s.slice(1, -1).trim().replace(/,\s*$/, '');
    if (!inside) return null;
    parts = inside.split(',');
  } else {
    parts = [s];
  }
  if (parts.length < 1 || parts.length > 4) return null;
  const nums = parts.map(parseTomlFloat);
  if (nums.some(n => n === null || Number.isNaN(n))) return null;
  const [value, lo, hi, step] = nums as number[];
  if (!Number.isFinite(value)) return null;
  if (lo !== undefined && lo === Infinity) return null;
  if (hi !== undefined && hi === -Infinity) return null;
  const out: ChemexValue = { value };
  if (lo !== undefined && Number.isFinite(lo)) out.lower = lo;
  if (hi !== undefined && Number.isFinite(hi)) out.upper = hi;
  if (step !== undefined) {
    if (!Number.isFinite(step)) return null;
    out.bruteStep = step;
  }
  if (out.lower !== undefined && out.upper !== undefined && out.lower >= out.upper) return null;
  return out;
}

/** UI-unit value + optional bounds from a parsed ChemEx-unit value. */
function fromChemexValue(v: ChemexValue, unitDef: ParamUnitDef): Pick<ParamValue, 'value' | 'lower' | 'upper' | 'bruteStep'> {
  const out: Pick<ParamValue, 'value' | 'lower' | 'upper' | 'bruteStep'> = { value: unitDef.fromChemEx(v.value) };
  if (v.lower !== undefined) out.lower = unitDef.fromChemEx(v.lower);
  if (v.upper !== undefined) out.upper = unitDef.fromChemEx(v.upper);
  if (v.bruteStep !== undefined) out.bruteStep = unitDef.fromChemEx(v.bruteStep);
  return out;
}

const fmtBound = (x: number): string => (Number.isFinite(x) ? String(x) : x > 0 ? 'inf' : '-inf');

/**
 * Render a value for parameters.toml. A list is written only when a bound (or brute step)
 * is set; the unset side is filled from ChemEx's default bound so the file is explicit
 * (ChemEx would otherwise keep its default on that side). TREF never carries bounds.
 */
export function formatChemexValue(
  key: string,
  param: ParamValue,
  unitDef: ParamUnitDef,
  valueStr: string,
  defaults: ParamDefaultsLookup = fallbackDefaults
): string {
  const upperKey = key.toUpperCase();
  const hasBounds = param.lower !== undefined || param.upper !== undefined || param.bruteStep !== undefined;
  if (!hasBounds || upperKey === 'TREF') return valueStr;
  const def = defaults(upperKey);
  const lowerUi = param.lower ?? (def?.lower ?? -Infinity);
  const upperUi = param.upper ?? (def?.upper ?? Infinity);
  const lower = Number.isFinite(lowerUi) ? unitDef.toChemEx(lowerUi) : lowerUi;
  const upper = Number.isFinite(upperUi) ? unitDef.toChemEx(upperUi) : upperUi;
  const items = [valueStr, fmtBound(lower), fmtBound(upper)];
  if (param.bruteStep !== undefined) items.push(String(unitDef.toChemEx(param.bruteStep)));
  return `[${items.join(', ')}]`;
}

/**
 * Serializes a structured ParameterConfig into a deterministic ChemEx parameters.toml string.
 */
export function configToToml(config: ParameterConfig, opts: TomlWriteOptions = {}): string {
  if (config.rawOverride !== undefined && config.rawOverride.trim() !== '') {
    return config.rawOverride;
  }
  const defaults = opts.defaults ?? fallbackDefaults;

  const sections: string[] = ['# Auto-generated ChemEx parameter file'];

  // 1. [GLOBAL] section
  const globalEntries = Object.entries(config.globals || {});
  if (globalEntries.length > 0) {
    const globalLines: string[] = ['[GLOBAL]'];
    // Deterministic order: PB, KEX_AB, TAUC_A, then other keys alphabetically
    const preferredOrder = ['PB', 'KEX_AB', 'TAUC_A'];
    const sortedGlobals = [...globalEntries].sort(([a], [b]) => {
      const aUp = a.toUpperCase();
      const bUp = b.toUpperCase();
      const aIdx = preferredOrder.indexOf(aUp);
      const bIdx = preferredOrder.indexOf(bUp);
      if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
      if (aIdx !== -1) return -1;
      if (bIdx !== -1) return 1;
      return aUp.localeCompare(bUp);
    });

    for (const [key, param] of sortedGlobals) {
      if (param && param.value !== undefined && !isNaN(param.value)) {
        const unitDef = getUnitDef(key);
        const chemexVal = unitDef.toChemEx(param.value);
        const valStr = formatChemexValue(key, param, unitDef, chemexVal.toString(), defaults);
        globalLines.push(`${key.toUpperCase()} = ${valStr}`);
      }
    }
    if (globalLines.length > 1) {
      sections.push(globalLines.join('\n'));
    }
  }

  // 2. Per-residue parameter sections
  const sectionKeys = new Set<string>();
  for (const rParams of Object.values(config.residues || {})) {
    if (rParams) {
      for (const pKey of Object.keys(rParams)) {
        sectionKeys.add(pKey.toLowerCase());
      }
    }
  }

  // Standard section ordering: CS_A, CS_B, CS_C, DW_AB, DW_AC, R1_A, R2_A, R2_B, R2_C, etc.
  const PREFERRED_ORDER = [
    'cs_a', 'cs_b', 'cs_c', 'cs_d', 'cs_e', 'cs_f',
    'dw_ab', 'dw_ac', 'dw_ad', 'dw_ae', 'dw_af',
    'r1_a', 'r1_b', 'r1_c',
    'r2_a', 'r2_b', 'r2_c', 'r2_d', 'r2_e', 'r2_f',
    'r1rho_a', 'r1rho_b', 'r1rho_c',
  ];

  const sortedSections = Array.from(sectionKeys).sort((a, b) => {
    const idxA = PREFERRED_ORDER.indexOf(a);
    const idxB = PREFERRED_ORDER.indexOf(b);
    if (idxA !== -1 && idxB !== -1) return idxA - idxB;
    if (idxA !== -1) return -1;
    if (idxB !== -1) return 1;
    return a.localeCompare(b);
  });

  // Sort residue keys numerically (e.g. 13N, 14N, 102N, G13N, G2N-HN, L3CD1-HD1)
  const residueKeys = sortSpinKeys(Object.keys(config.residues || {}));

  for (const paramKey of sortedSections) {
    const sectionLines: string[] = [`[${paramKey.toUpperCase()}]`];
    const unitDef = getUnitDef(paramKey);
    const excludedSet = new Set((config.excludedResidues || []).map(r => r.toUpperCase()));

    for (const resKey of residueKeys) {
      const resParam = config.residues[resKey]?.[paramKey];
      if (resParam && resParam.value !== undefined && !isNaN(resParam.value)) {
        const chemexVal = unitDef.toChemEx(resParam.value);
        // Fixed precision only when it is exact, so imported values round-trip losslessly.
        const fixed = unitDef.precision !== undefined ? chemexVal.toFixed(unitDef.precision) : null;
        const scalarStr = fixed !== null && Number(fixed) === chemexVal ? fixed : chemexVal.toString();
        const valStr = formatChemexValue(paramKey, resParam, unitDef, scalarStr, defaults);
        if (excludedSet.has(resKey.toUpperCase())) {
          sectionLines.push(`# ${resKey} = ${valStr}`);
        } else {
          sectionLines.push(`${resKey} = ${valStr}`);
        }
      }
    }

    if (sectionLines.length > 1) {
      sections.push(sectionLines.join('\n'));
    }
  }

  return sections.join('\n\n') + '\n';
}

export interface TomlParseResult {
  config: ParameterConfig;
  unparsed: string[];
}

/**
 * Parses a parameters.toml content string into a ParameterConfig object.
 * Extracts values, converts from ChemEx internal units to UI display units,
 * and preserves provenance and excluded residues (from commented-out lines).
 */
export function tomlToConfig(tomlContent: string): TomlParseResult {
  const config: ParameterConfig = {
    globals: {},
    residues: {},
    excludedResidues: [],
  };
  const unparsed: string[] = [];

  if (!tomlContent) {
    return { config, unparsed };
  }

  const rawLines = tomlContent.split(/\r?\n/);
  let currentSection = '';

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const trimmed = line.trim();

    // Skip empty lines
    if (!trimmed) continue;

    let isCommented = false;
    let effectiveLine = trimmed;

    // Check if line is commented out
    if (trimmed.startsWith('#')) {
      const commentKvMatch = trimmed.match(/^#\s*([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
      if (commentKvMatch && currentSection && currentSection !== 'GLOBAL') {
        isCommented = true;
        effectiveLine = `${commentKvMatch[1].trim()} = ${commentKvMatch[2].trim()}`;
      } else {
        if (!trimmed.toLowerCase().includes('auto-generated chemex parameter file')) {
          unparsed.push(line);
        }
        continue;
      }
    }

    // Section header: [CS_A] or quoted ["CS_A"] (as written by ChemEx run_info files)
    const secMatch = effectiveLine.match(/^\[\s*(?:"([^"]+)"|([A-Za-z0-9_,-]+))\s*\]$/);
    if (secMatch) {
      currentSection = (secMatch[1] ?? secMatch[2]).trim().toUpperCase();
      continue;
    }

    // Key-value pair: KEY = VALUE
    const kvMatch = effectiveLine.match(/^("[^"]+"|[A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!kvMatch) {
      unparsed.push(line);
      continue;
    }

    const key = kvMatch[1].trim().replace(/^"(.*)"$/, '$1');
    const rawValStr = kvMatch[2].trim();

    // Parse value: scalar or [init, lower, upper(, brute_step)]
    const parsedValue = parseChemexValue(rawValStr);
    if (parsedValue === null) {
      unparsed.push(line);
      continue;
    }

    if (!currentSection || currentSection === 'GLOBAL') {
      // Global parameter
      const globalKey = key.toLowerCase();
      const unitDef = getUnitDef(key);
      config.globals[globalKey] = {
        ...fromChemexValue(parsedValue, unitDef),
        source: { kind: 'imported' },
      };
    } else {
      // Per-residue parameter section (e.g. [CS_A], [DW_AB], [R1_A])
      const sectionParamKey = currentSection.toLowerCase();
      const resKey = key; // residue name e.g. 13N
      const unitDef = getUnitDef(sectionParamKey);

      if (!config.residues[resKey]) {
        config.residues[resKey] = {};
      }
      config.residues[resKey][sectionParamKey] = {
        ...fromChemexValue(parsedValue, unitDef),
        source: { kind: 'imported' },
      };

      if (isCommented) {
        if (!config.excludedResidues) config.excludedResidues = [];
        if (!config.excludedResidues.includes(resKey)) {
          config.excludedResidues.push(resKey);
        }
      }
    }
  }

  return { config, unparsed };
}

/**
 * Updates an experiment TOML content string so that residues under [data.profiles]
 * matching excluded residues are commented out (`# 13N = "13N-HN.out"`), and active
 * residues are uncommented (`13N = "13N-HN.out"`).
 */
export function applyExclusionsToExperimentToml(
  tomlContent: string,
  config: ParameterConfig,
  profiles?: ProfileRef[]
): string {
  if (!tomlContent) return '';
  const lines = tomlContent.split(/\r?\n/);
  let inDataProfiles = false;
  const outLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Check section header
    const secMatch = trimmed.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (secMatch) {
      const secName = secMatch[1].trim().toLowerCase();
      inDataProfiles = (secName === 'data.profiles');
      outLines.push(line);
      continue;
    }

    if (inDataProfiles) {
      // Check for active or commented key-value line: e.g. `13N = "13N-HN.out"`, `G2N-HN = "2N-HN.out"`
      const kvMatch = trimmed.match(/^(#\s*)?([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
      if (kvMatch) {
        const resKey = kvMatch[2].trim();
        const valuePart = kvMatch[3].trim();
        const excluded = isResidueExcluded(config, resKey, profiles);

        if (excluded) {
          outLines.push(`# ${resKey} = ${valuePart}`);
        } else {
          outLines.push(`${resKey} = ${valuePart}`);
        }
        continue;
      }
    }

    outLines.push(line);
  }

  return outLines.join('\n');
}

/** parameters.toml reader/writer pair; experiments may wrap the default codec. */
export interface ParameterCodec {
  toToml: (config: ParameterConfig, opts?: TomlWriteOptions) => string;
  fromToml: (toml: string) => TomlParseResult;
  /** Convert a config saved by an older version of a page (optional). */
  migrate?: (raw: unknown) => ParameterConfig;
}

export const DEFAULT_PARAMETER_CODEC: ParameterCodec = { toToml: configToToml, fromToml: tomlToConfig };
