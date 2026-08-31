import type {
  ParameterConfig,
  ProfileRef,
} from './parameterConfig';
import {
  isResidueExcluded,
  sortSpinKeys,
} from './parameterConfig';
import { getUnitDef } from './unitRegistry';

/**
 * Serializes a structured ParameterConfig into a deterministic ChemEx parameters.toml string.
 */
export function configToToml(config: ParameterConfig): string {
  if (config.rawOverride !== undefined && config.rawOverride.trim() !== '') {
    return config.rawOverride;
  }

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
        const valStr = chemexVal.toString();
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
        const valStr = unitDef.precision !== undefined
          ? chemexVal.toFixed(unitDef.precision)
          : chemexVal.toString();
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

    // Section header: [SECTION]
    const secMatch = effectiveLine.match(/^\[([A-Za-z0-9_,-]+)\]$/);
    if (secMatch) {
      currentSection = secMatch[1].trim().toUpperCase();
      continue;
    }

    // Key-value pair: KEY = VALUE
    const kvMatch = effectiveLine.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!kvMatch) {
      unparsed.push(line);
      continue;
    }

    const key = kvMatch[1].trim();
    const rawValStr = kvMatch[2].trim();

    // Parse value: float or array [val, min, max, ...]
    let numericValue: number | null = null;

    if (rawValStr.startsWith('[') && rawValStr.endsWith(']')) {
      const inside = rawValStr.slice(1, -1).trim();
      const firstPart = inside.split(',')[0].trim();
      const parsed = parseFloat(firstPart);
      if (!isNaN(parsed)) {
        numericValue = parsed;
      }
    } else {
      const parsed = parseFloat(rawValStr);
      if (!isNaN(parsed)) {
        numericValue = parsed;
      }
    }

    if (numericValue === null) {
      unparsed.push(line);
      continue;
    }

    if (!currentSection || currentSection === 'GLOBAL') {
      // Global parameter
      const globalKey = key.toLowerCase();
      const unitDef = getUnitDef(key);
      const uiVal = unitDef.fromChemEx(numericValue);
      config.globals[globalKey] = {
        value: uiVal,
        source: { kind: 'imported' },
      };
    } else {
      // Per-residue parameter section (e.g. [CS_A], [DW_AB], [R1_A])
      const sectionParamKey = currentSection.toLowerCase();
      const resKey = key; // residue name e.g. 13N
      const unitDef = getUnitDef(sectionParamKey);
      const uiVal = unitDef.fromChemEx(numericValue);

      if (!config.residues[resKey]) {
        config.residues[resKey] = {};
      }
      config.residues[resKey][sectionParamKey] = {
        value: uiVal,
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
