import type { ParamValue } from "./parameterConfig";
import { sortSpinKeys, SpinSystemKey } from "./spinSystem";

export interface CpmgResidueParams {
  cs_a?: ParamValue; // Ground state chemical shift in ppm (inherited from peak fitting)
  dw_ab?: ParamValue; // Optional override
  r2_a?: Record<string, ParamValue>;
  r2_b?: Record<string, ParamValue>;
}

export interface CpmgParameterConfig {
  globals: Record<string, ParamValue>;
  residues: Record<string, CpmgResidueParams>;
  excludedResidues?: string[];
  rawOverride?: string;
  inheritedFrom?: {
    analysisUuid: string;
    analysisName: string;
    timestamp: string;
  };
}

export function createDefaultCpmgParameterConfig(): CpmgParameterConfig {
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

export function configToCpmgToml(config?: CpmgParameterConfig, _fields: number[] = [600]): string {
  if (!config) {
    return "# Auto-generated ChemEx parameter file\n\n[GLOBAL]\nPB = 0.05\nKEX_AB = 500.0\nDW_AB = 2.0\nTAUC_A = 4.0\n";
  }
  if (config.rawOverride && config.rawOverride.trim() !== "") {
    return config.rawOverride;
  }

  const sections: string[] = ["# Auto-generated ChemEx parameter file"];

  // 1. [GLOBAL] section
  const globalLines: string[] = ["[GLOBAL]"];
  if (config.globals?.pb?.value !== undefined && !isNaN(config.globals.pb.value)) {
    globalLines.push(`PB = ${config.globals.pb.value}`);
  }
  if (config.globals?.kex_ab?.value !== undefined && !isNaN(config.globals.kex_ab.value)) {
    globalLines.push(`KEX_AB = ${config.globals.kex_ab.value}`);
  }
  if (config.globals?.dw_ab?.value !== undefined && !isNaN(config.globals.dw_ab.value)) {
    globalLines.push(`DW_AB = ${config.globals.dw_ab.value}`);
  }
  if (config.globals?.tauc_a?.value !== undefined && !isNaN(config.globals.tauc_a.value)) {
    globalLines.push(`TAUC_A = ${config.globals.tauc_a.value}`);
  }
  if (globalLines.length > 1) {
    sections.push(globalLines.join("\n"));
  }

  // 2. [CS_A] - per-residue ground state chemical shift sorted numerically
  const excluded = new Set((config.excludedResidues || []).map((r) => r.toUpperCase()));

  // Canonicalize and deduplicate residue entries to guarantee only standard keys (e.g. 3N, not 3LYS)
  const canonicalResidues: Record<string, CpmgResidueParams> = {};
  for (const [rawKey, rParams] of Object.entries(config.residues || {})) {
    const parsed = SpinSystemKey.parse(rawKey);
    const canonKey = (parsed.resNum > 0 && parsed.spins.length <= 1)
      ? `${parsed.resNum}N`
      : (parsed.short || rawKey);
    
    // Prefer exact canonKey or preserve if not yet set
    if (!canonicalResidues[canonKey] || rawKey === canonKey) {
      canonicalResidues[canonKey] = rParams;
    }
  }

  const residueKeys = sortSpinKeys(Object.keys(canonicalResidues));

  if (residueKeys.length > 0) {
    const csLines: string[] = ["[CS_A]"];
    for (const resKey of residueKeys) {
      const rParams = canonicalResidues[resKey];
      if (rParams?.cs_a?.value !== undefined && !isNaN(rParams.cs_a.value)) {
        const valStr = rParams.cs_a.value.toFixed(3);
        if (excluded.has(resKey.toUpperCase())) {
          csLines.push(`# ${resKey} = ${valStr}`);
        } else {
          csLines.push(`${resKey} = ${valStr}`);
        }
      }
    }
    if (csLines.length > 1) {
      sections.push(csLines.join("\n"));
    }

    // 3. [DW_AB] - per-residue chemical shift difference (if present)
    const dwLines: string[] = ["[DW_AB]"];
    for (const resKey of residueKeys) {
      const rParams = canonicalResidues[resKey];
      if (rParams?.dw_ab?.value !== undefined && !isNaN(rParams.dw_ab.value)) {
        const valStr = rParams.dw_ab.value.toFixed(3);
        if (excluded.has(resKey.toUpperCase())) {
          dwLines.push(`# ${resKey} = ${valStr}`);
        } else {
          dwLines.push(`${resKey} = ${valStr}`);
        }
      }
    }
    if (dwLines.length > 1) {
      sections.push(dwLines.join("\n"));
    }
  }

  return sections.join("\n\n") + "\n";
}

export interface CpmgParseResult {
  config: CpmgParameterConfig;
  unparsed: string[];
}

export function cpmgTomlToConfig(tomlText: string): CpmgParseResult {
  const config = createDefaultCpmgParameterConfig();
  const unparsed: string[] = [];
  const excludedSet = new Set<string>();

  const lines = tomlText.split("\n");
  let currentSection = "";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const secMatch = line.match(/^\[([^\]]+)\]$/);
    if (secMatch) {
      currentSection = secMatch[1].trim().toUpperCase();
      continue;
    }

    // Check if line is commented out (e.g. # 4N = 118.445)
    let isCommented = false;
    let effectiveLine = line;
    if (line.startsWith("#")) {
      const withoutHash = line.replace(/^#+\s*/, "");
      const commentedKv = withoutHash.match(/^["']?([^"'=\s]+)["']?\s*=\s*(.+)$/);
      if (commentedKv && (currentSection === "CS_A" || currentSection === "CS")) {
        isCommented = true;
        effectiveLine = withoutHash;
      } else {
        unparsed.push(rawLine);
        continue;
      }
    }

    const kvMatch = effectiveLine.match(/^["']?([^"'=\s]+)["']?\s*=\s*(.+)$/);
    if (!kvMatch) {
      unparsed.push(rawLine);
      continue;
    }

    const rawKey = kvMatch[1].trim();
    const parsedKey = SpinSystemKey.parse(rawKey);
    const key = (parsedKey.resNum > 0 && parsedKey.spins.length <= 1)
      ? `${parsedKey.resNum}N`
      : (parsedKey.short || rawKey);

    let valStr = kvMatch[2].trim();
    const commentIdx = valStr.indexOf("#");
    if (commentIdx !== -1) {
      valStr = valStr.substring(0, commentIdx).trim();
    }
    const numVal = parseFloat(valStr);

    if (currentSection === "GLOBAL") {
      const lowerKey = rawKey.toLowerCase();
      config.globals[lowerKey] = {
        value: isNaN(numVal) ? 0 : numVal,
        source: { kind: "imported" },
      };
    } else if (currentSection === "CS_A" || currentSection === "CS") {
      if (!config.residues[key]) {
        config.residues[key] = {};
      }
      config.residues[key].cs_a = {
        value: isNaN(numVal) ? 0.0 : numVal,
        source: { kind: "imported" },
      };
      if (isCommented) {
        excludedSet.add(key);
      }
    } else if (currentSection === "DW_AB" || currentSection.startsWith("DW")) {
      if (!config.residues[key]) {
        config.residues[key] = {};
      }
      config.residues[key].dw_ab = {
        value: isNaN(numVal) ? 1.0 : Math.abs(numVal),
        source: { kind: "imported" },
      };
    } else if (currentSection.startsWith("R2_A") || currentSection === "R2") {
      if (!config.residues[key]) {
        config.residues[key] = {};
      }
      if (!config.residues[key].r2_a) {
        config.residues[key].r2_a = {};
      }
      let fieldKey = "default";
      const mField = currentSection.match(/R2_A_(\d+(?:\.\d+)?)MHZ/i);
      if (mField) {
        fieldKey = String(parseFloat(mField[1]));
      }
      config.residues[key].r2_a![fieldKey] = {
        value: isNaN(numVal) ? 15.0 : numVal,
        source: { kind: "imported" },
      };
    } else {
      unparsed.push(rawLine);
    }
  }

  config.excludedResidues = Array.from(excludedSet);
  return { config, unparsed };
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
      let paramSection: keyof CpmgResidueParams | null = null;
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
        existingRes[paramSection] = {
          value: val,
          source: { kind: 'manual', at: now },
        };
        nextConfig.residues[targetResKey] = existingRes;
      }

      delete nextConfig.globals[kTrimmed.toLowerCase()];
      updatedCount++;
    } else {
      let gKey = kTrimmed.toLowerCase();
      if (kUpper.includes('PB')) gKey = 'pb';
      else if (kUpper.includes('KEX')) gKey = 'kex_ab';
      else if (kUpper.includes('TAUC')) gKey = 'tauc_a';

      nextConfig.globals[gKey] = {
        value: val,
        source: { kind: 'manual', at: now },
      };
      updatedCount++;
    }
  }

  return { nextConfig, updatedCount };
}


