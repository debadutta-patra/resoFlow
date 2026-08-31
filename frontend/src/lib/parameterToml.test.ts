import { describe, it, expect } from 'vitest';
import { configToToml, tomlToConfig, applyExclusionsToExperimentToml } from './parameterToml';
import {
  computePickHash,
  normalizeResidueKey,
  getCanonicalResidueKey,
  canonicalizeParameterConfig,
  toggleExcludeResidue,
  isResidueExcluded,
  applyGridCoordinatesToConfig,
  type ParameterConfig,
} from './parameterConfig';
import { getUnitDef, formatParamValue } from './unitRegistry';

describe('parameterToml Serializer & Parser', () => {
  const sampleToml = `# Auto-generated ChemEx parameter file

[GLOBAL]
PB = 0.01
KEX_AB = 100
TAUC_A = 5

[CS_A]
13N = 112.444
14N = 113.589
15N = 117.762
`;

  it('round-trips the exact prompt file fragment', () => {
    const parseResult = tomlToConfig(sampleToml);
    expect(parseResult.unparsed).toEqual([]);
    const config = parseResult.config;

    // Verify globals
    expect(config.globals.pb?.value).toBe(0.01);
    expect(config.globals.pb?.source).toEqual({ kind: 'imported' });
    expect(config.globals.kex_ab?.value).toBe(100);
    expect(config.globals.tauc_a?.value).toBe(5);

    // Verify residues
    expect(config.residues['13N']?.cs_a?.value).toBe(112.444);
    expect(config.residues['13N']?.cs_a?.source).toEqual({ kind: 'imported' });
    expect(config.residues['14N']?.cs_a?.value).toBe(113.589);
    expect(config.residues['15N']?.cs_a?.value).toBe(117.762);

    // Serialize back and compare
    const regenerated = configToToml(config);
    expect(regenerated.trim()).toBe(sampleToml.trim());
  });

  it('serializes multi-section configs with deterministic ordering and numerical residue sorting', () => {
    const config: ParameterConfig = {
      globals: {
        tauc_a: { value: 4.5, source: { kind: 'default' } },
        pb: { value: 0.035, source: { kind: 'manual', at: '2026-08-18' } },
        kex_ab: { value: 250, source: { kind: 'default' } },
      },
      residues: {
        '102N': {
          cs_a: { value: 120.123, source: { kind: 'pick', pickSetHash: 'h1', at: '2026-08-18' } },
          dw_ab: { value: -2.15, source: { kind: 'pick', pickSetHash: 'h1', at: '2026-08-18' } },
        },
        '14N': {
          cs_a: { value: 114.5, source: { kind: 'pick', pickSetHash: 'h2', at: '2026-08-18' } },
          dw_ab: { value: 1.2, source: { kind: 'pick', pickSetHash: 'h2', at: '2026-08-18' } },
          r1_a: { value: 1.45, source: { kind: 'imported' } },
        },
        '13N': {
          cs_a: { value: 112.0, source: { kind: 'pick', pickSetHash: 'h3', at: '2026-08-18' } },
          dw_ab: { value: 0.5, source: { kind: 'pick', pickSetHash: 'h3', at: '2026-08-18' } },
          r1_a: { value: 1.2, source: { kind: 'imported' } },
        },
      },
    };

    const toml = configToToml(config);

    // [GLOBAL] should list PB, KEX_AB, TAUC_A in standard order
    const globalSectionIdx = toml.indexOf('[GLOBAL]');
    const csASectionIdx = toml.indexOf('[CS_A]');
    const dwABSectionIdx = toml.indexOf('[DW_AB]');
    const r1ASectionIdx = toml.indexOf('[R1_A]');

    expect(globalSectionIdx).toBeLessThan(csASectionIdx);
    expect(csASectionIdx).toBeLessThan(dwABSectionIdx);
    expect(dwABSectionIdx).toBeLessThan(r1ASectionIdx);

    // Residue order in [CS_A] should be 13N, 14N, 102N (numerical)
    const csA13 = toml.indexOf('13N = 112.000');
    const csA14 = toml.indexOf('14N = 114.500');
    const csA102 = toml.indexOf('102N = 120.123');

    expect(csA13).toBeLessThan(csA14);
    expect(csA14).toBeLessThan(csA102);
  });

  it('respects rawOverride when present', () => {
    const rawContent = `# Custom ChemEx parameter file
[GLOBAL]
PB = 0.08
`;
    const config: ParameterConfig = {
      globals: { pb: { value: 0.01, source: { kind: 'default' } } },
      residues: {},
      rawOverride: rawContent,
    };

    expect(configToToml(config)).toBe(rawContent);
  });

  it('correctly handles list syntax from ChemEx parameter files', () => {
    const tomlWithLists = `
[GLOBAL]
PB = [0.02, 0.0, 0.5]
KEX_AB = [150.0, 10.0, 2000.0]
`;
    const result = tomlToConfig(tomlWithLists);
    expect(result.config.globals.pb?.value).toBe(0.02);
    expect(result.config.globals.kex_ab?.value).toBe(150.0);
  });

  it('preserves unparsed comments or invalid lines into unparsed array', () => {
    const tomlWithCustom = `
# Important user note about sample conditions
[GLOBAL]
PB = 0.05
UNKNOWN_SPECIAL_FLAG = true
`;
    const result = tomlToConfig(tomlWithCustom);
    expect(result.config.globals.pb?.value).toBe(0.05);
    expect(result.unparsed.some(l => l.includes('Important user note'))).toBe(true);
    expect(result.unparsed.some(l => l.includes('UNKNOWN_SPECIAL_FLAG'))).toBe(true);
  });
});

describe('unitRegistry', () => {
  it('defines correct units for parameters', () => {
    const tauc = getUnitDef('TAUC_A');
    expect(tauc.chemexUnit).toBe('ns');
    expect(tauc.uiUnit).toBe('ns');

    const kex = getUnitDef('KEX_AB');
    expect(kex.chemexUnit).toBe('s⁻¹');

    const csa = getUnitDef('CS_A');
    expect(csa.chemexUnit).toBe('ppm');
  });

  it('formats values to standard precision', () => {
    expect(formatParamValue('CS_A', 115.44444)).toBe('115.444');
    expect(formatParamValue('DW_AB', -2.1)).toBe('-2.100');
    expect(formatParamValue('PB', 0.04567)).toBe('0.0457');
    expect(formatParamValue('KEX_AB', 123.456)).toBe('123.46');
  });
});

describe('parameterConfig Utilities', () => {
  it('normalizes residue keys properly', () => {
    expect(normalizeResidueKey('GLY13N')).toBe('G13N');
    expect(normalizeResidueKey('ALA14N')).toBe('A14N');
    expect(normalizeResidueKey('LYS3N')).toBe('K3N');
    expect(normalizeResidueKey('15N')).toBe('15N');
  });

  it('resolves canonical residue keys against experiment profiles', () => {
    const profiles = [
      { residue: '3N', full_residue: 'K3N' },
      { residue: '4N', full_residue: 'N4N' },
    ];

    expect(getCanonicalResidueKey('3N', profiles)).toBe('3N');
    expect(getCanonicalResidueKey('K3N', profiles)).toBe('3N');
    expect(getCanonicalResidueKey('LYS3N', profiles)).toBe('3N');
    expect(getCanonicalResidueKey('4N', profiles)).toBe('4N');
    expect(getCanonicalResidueKey('ASN4N', profiles)).toBe('4N');
  });

  it('deduplicates and merges multiple residue alias entries into single canonical entry', () => {
    const profiles = [
      { residue: '3N', full_residue: 'K3N' },
    ];

    const duplicateConfig: ParameterConfig = {
      globals: {},
      residues: {
        '3N': { cs_a: { value: 120.072, source: { kind: 'imported' } } },
        'K3N': { dw_ab: { value: 3.318, source: { kind: 'pick', pickSetHash: 'h1', at: '2026-08-18' } } },
        'LYS3N': { r1_a: { value: 1.45, source: { kind: 'manual', at: '2026-08-18' } } },
      },
    };

    const canonicalized = canonicalizeParameterConfig(duplicateConfig, profiles);
    const keys = Object.keys(canonicalized.residues);
    expect(keys).toEqual(['3N']);
    expect(canonicalized.residues['3N'].cs_a?.value).toBe(120.072);
    expect(canonicalized.residues['3N'].dw_ab?.value).toBe(3.318);
    expect(canonicalized.residues['3N'].r1_a?.value).toBe(1.45);
  });

  it('omits DW_AB section for residues with no B-pick', () => {
    const config: ParameterConfig = {
      globals: { pb: { value: 0.05, source: { kind: 'default' } } },
      residues: {
        '13N': { cs_a: { value: 118.5, source: { kind: 'pick', pickSetHash: 'h1', at: '2026-08-24' } } },
        '14N': {
          cs_a: { value: 120.1, source: { kind: 'pick', pickSetHash: 'h2', at: '2026-08-24' } },
          dw_ab: { value: 2.5, source: { kind: 'pick', pickSetHash: 'h2', at: '2026-08-24' } },
        },
      },
    };

    const toml = configToToml(config);
    expect(toml).toContain('[CS_A]\n13N = 118.500\n14N = 120.100');
    expect(toml).toContain('[DW_AB]\n14N = 2.500');
    expect(toml).not.toContain('13N = 0');
  });

  it('comments out excluded residues in generated TOML and parses them losslessly', () => {
    const config: ParameterConfig = {
      globals: { pb: { value: 0.05, source: { kind: 'default' } } },
      residues: {
        '13N': { cs_a: { value: 118.5, source: { kind: 'pick', pickSetHash: 'h1', at: '2026-08-24' } } },
        '14N': {
          cs_a: { value: 120.1, source: { kind: 'pick', pickSetHash: 'h2', at: '2026-08-24' } },
          dw_ab: { value: 2.5, source: { kind: 'pick', pickSetHash: 'h2', at: '2026-08-24' } },
        },
      },
      excludedResidues: ['13N'],
    };

    const toml = configToToml(config);
    expect(toml).toContain('# 13N = 118.500');
    expect(toml).toContain('14N = 120.100');

    // Parse it back
    const parsedResult = tomlToConfig(toml);
    expect(parsedResult.config.residues['13N']?.cs_a?.value).toBe(118.5);
    expect(parsedResult.config.excludedResidues).toEqual(['13N']);
  });

  it('toggles residue exclusion state correctly', () => {
    const config: ParameterConfig = {
      globals: {},
      residues: { '13N': { cs_a: { value: 118.5, source: { kind: 'default' } } } },
    };

    expect(isResidueExcluded(config, '13N')).toBe(false);

    const excludedConfig = toggleExcludeResidue(config, '13N');
    expect(isResidueExcluded(excludedConfig, '13N')).toBe(true);
    expect(excludedConfig.excludedResidues).toEqual(['13N']);

    const restoredConfig = toggleExcludeResidue(excludedConfig, '13N');
    expect(isResidueExcluded(restoredConfig, '13N')).toBe(false);
    expect(restoredConfig.excludedResidues).toBeUndefined();
  });

  it('computes stable hashes for pick sets and detects changes', () => {
    const pick1 = { cs_a: 112.444, cs_b: 115.123 };
    const pick2 = { cs_a: 112.444, cs_b: 115.123 };
    const pick3 = { cs_a: 112.444, cs_b: 116.000 };

    const hash1 = computePickHash(pick1);
    const hash2 = computePickHash(pick2);
    const hash3 = computePickHash(pick3);

    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);
  });

  it('correctly comments and uncomments residues under [data.profiles] in experiment TOML', () => {
    const sampleExpToml = `[experiment]
name = "cest_15n"
b1_frq = 25.0

[data]
path = "../data/25hz"
  [data.profiles]
13N = "13N-HN.out"
14N = "14N-HN.out"
15N = "15N-HN.out"
`;

    const configWith14Excluded: ParameterConfig = {
      globals: {},
      residues: {},
      excludedResidues: ['14N'],
    };

    const updatedToml = applyExclusionsToExperimentToml(sampleExpToml, configWith14Excluded);
    expect(updatedToml).toContain('13N = "13N-HN.out"');
    expect(updatedToml).toContain('# 14N = "14N-HN.out"');
    expect(updatedToml).toContain('15N = "15N-HN.out"');
    // Top-level sections should remain untouched
    expect(updatedToml).toContain('b1_frq = 25.0');

    // Now restore 14N
    const configRestored: ParameterConfig = {
      globals: {},
      residues: {},
    };
    const restoredToml = applyExclusionsToExperimentToml(updatedToml, configRestored);
    expect(restoredToml).toContain('14N = "14N-HN.out"');
    expect(restoredToml).not.toContain('# 14N');
  });

  it('correctly applies grid coordinates to globals and residues [DW_AB]', () => {
    const initialConfig: ParameterConfig = {
      globals: {
        tauc_a: { value: 8.2, source: { kind: 'default' } },
      },
      residues: {
        'C14N': {
          cs_a: { value: 113.589, source: { kind: 'imported' } },
        },
        'Q55N': {
          cs_a: { value: 120.500, source: { kind: 'imported' } },
        },
        'L65N': {
          cs_a: { value: 118.200, source: { kind: 'imported' } },
        },
      },
    };

    const gridCoords = {
      'PB': 0.00353,
      'KEX_AB': 483.293,
      'DW_AB, NUC->14N': 6.8421,
      'DW_AB, NUC->55N': 4.7368,
      'DW_AB, NUC->65N': 4.2105,
    };

    const { nextConfig, updatedCount } = applyGridCoordinatesToConfig(initialConfig, gridCoords);
    expect(updatedCount).toBe(5);

    // Globals should ONLY contain PB, KEX_AB, TAUC_A
    expect(nextConfig.globals.pb?.value).toBe(0.0035);
    expect(nextConfig.globals.kex_ab?.value).toBe(483.293);
    expect(nextConfig.globals.tauc_a?.value).toBe(8.2);
    expect(Object.keys(nextConfig.globals)).toEqual(['tauc_a', 'pb', 'kex_ab']);

    // Residues should have updated DW_AB and NO cs_b (so [CS_B] is not generated in TOML)
    expect(nextConfig.residues['C14N']?.dw_ab?.value).toBe(6.8421);
    expect(nextConfig.residues['C14N']?.cs_b).toBeUndefined();

    expect(nextConfig.residues['Q55N']?.dw_ab?.value).toBe(4.7368);
    expect(nextConfig.residues['Q55N']?.cs_b).toBeUndefined();

    expect(nextConfig.residues['L65N']?.dw_ab?.value).toBe(4.2105);
    expect(nextConfig.residues['L65N']?.cs_b).toBeUndefined();

    // Verify TOML serialization
    const generatedToml = configToToml(nextConfig);
    expect(generatedToml).toContain('[GLOBAL]\nPB = 0.0035\nKEX_AB = 483.293\nTAUC_A = 8.2');
    expect(generatedToml).toContain('[DW_AB]\nC14N = 6.842\nQ55N = 4.737\nL65N = 4.210');
    expect(generatedToml).not.toContain('[CS_B]');
    expect(generatedToml).not.toContain('DW_AB, NUC->14N');
  });
});

