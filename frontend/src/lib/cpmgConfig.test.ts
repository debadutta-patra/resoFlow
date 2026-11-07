import { describe, it, expect } from 'vitest';
import {
  createDefaultCpmgParameterConfig,
  configToCpmgToml,
  applyGridCoordinatesToCpmgConfig,
} from './cpmgConfig';

describe('cpmgConfig', () => {
  it('creates default configuration and serializes to TOML', () => {
    const config = createDefaultCpmgParameterConfig();
    const toml = configToCpmgToml(config);
    expect(toml).toContain('[GLOBAL]');
    expect(toml).toContain('PB = 0.05');
    expect(toml).toContain('KEX_AB = 500');
  });

  it('correctly applies grid coordinates to globals and residues', () => {
    const initialConfig = createDefaultCpmgParameterConfig();
    initialConfig.residues = {
      '32N': { cs_a: { value: 116.721, source: { kind: 'manual' } } },
      '55N': { cs_a: { value: 116.802, source: { kind: 'manual' } } },
      '65N': { cs_a: { value: 116.672, source: { kind: 'manual' } } },
    };

    const gridCoords = {
      'DW_AB, NUC->32N': 4.0,
      'KEX_AB, NUC->32': 483.293,
      'PB, NUC->32': 0.00519,
      'DW_AB, NUC->55N': 5.0,
      'KEX_AB, NUC->55': 143.845,
      'PB, NUC->55': 0.0145,
      'DW_AB, NUC->65N': 4.0,
      'KEX_AB, NUC->65': 233.572,
      'PB, NUC->65': 0.0078,
    };

    const { nextConfig, updatedCount } = applyGridCoordinatesToCpmgConfig(initialConfig, gridCoords);
    expect(updatedCount).toBe(9);

    // Residue DW_AB updated
    expect(nextConfig.residues['32N']?.dw_ab?.value).toBe(4.0);
    expect(nextConfig.residues['55N']?.dw_ab?.value).toBe(5.0);
    expect(nextConfig.residues['65N']?.dw_ab?.value).toBe(4.0);

    // TOML serialization should include [DW_AB]
    const generatedToml = configToCpmgToml(nextConfig);
    expect(generatedToml).toContain('[DW_AB]');
    expect(generatedToml).toContain('32N = 4.000');
    expect(generatedToml).toContain('55N = 5.000');
    expect(generatedToml).toContain('65N = 4.000');
    expect(generatedToml).not.toContain('DW_AB, NUC->32N');
  });
});

import { migrateLegacyCpmgParameterConfig, cpmgTomlToConfig } from './cpmgConfig';
import { configToToml } from './parameterToml';

describe('CPMG on the shared parameter model', () => {
  const legacy = {
    globals: { pb: { value: 0.012, source: { kind: 'manual' } } },
    residues: {
      '3LYS': { cs_a: { value: 120.185, source: { kind: 'pick', pickSetHash: 'peak_fit', at: 't' } } },
      '3N': { dw_ab: { value: 1.5, source: { kind: 'manual' } } },
      '7N': { cs_a: { value: 117, source: { kind: 'pick' } }, r2_a: { '600': { value: 12, source: { kind: 'imported' } } } },
    },
    excludedResidues: ['4ASN'],
    inheritedFrom: { analysisUuid: 'src-1', analysisName: 'Run A', timestamp: '2026-01-01' },
  };

  it('migrates legacy CPMG configs into the shared ParameterConfig shape', () => {
    const cfg = migrateLegacyCpmgParameterConfig(legacy);
    expect(cfg.globals.pb.value).toBe(0.012);
    expect(cfg.globals.kex_ab.value).toBe(500); // defaults filled in
    expect(cfg.residues['3N'].cs_a?.value).toBe(120.185); // alias merged, not dropped
    expect(cfg.residues['3N'].dw_ab?.value).toBe(1.5);
    expect(cfg.residues['3LYS']).toBeUndefined();
    expect(cfg.residues['7N'].r2_a).toBeUndefined(); // per-field records were never emitted
    expect(cfg.excludedResidues).toEqual(['4N']);
    expect(cfg.inheritedFrom).toEqual({ sourceRunId: 'src-1', sourceRunLabel: 'Run A', at: '2026-01-01' });
  });

  it('emits the same TOML through the CPMG wrapper and the shared writer', () => {
    const cfg = migrateLegacyCpmgParameterConfig(legacy);
    expect(configToCpmgToml(cfg)).toBe(configToToml(cfg));
    const toml = configToToml(cfg);
    expect(toml).toContain('3N = 120.185');
    expect(toml).toContain('[DW_AB]\n3N = 1.500');
    expect(toml).not.toContain('R2_A');
  });

  it('imports TOML onto canonical keys without losing parameters and keeps |DW|', () => {
    const toml = '[GLOBAL]\nPB = 0.05\n\n[CS_A]\n3LYS = 120.185\n# 4ASN = 118.554\n\n[DW_AB]\n3N = -1.2\n';
    const { config } = cpmgTomlToConfig(toml);
    expect(config.residues['3N'].cs_a?.value).toBe(120.185);
    expect(config.residues['3N'].dw_ab?.value).toBe(1.2);
    expect(config.excludedResidues).toEqual(['4N']);
    expect(config.globals.tauc_a.value).toBe(4);
  });
});

import { peakFitPicks, seedCpmgResiduesFromProfiles } from './cpmgConfig';
import { staleResidueKeys, LEGACY_PEAK_FIT_HASH } from './parameterConfig';

describe('CPMG peak-fit seeding', () => {
  const profiles = [
    { residue: '3N', full_residue: 'K3N', cs_a: 120.1 },
    { residue: '4N', full_residue: 'A4N', cs_a: 118.2 },
  ];

  it('seeds CS_A with a real pick hash and keeps existing values', () => {
    const base = createDefaultCpmgParameterConfig();
    base.residues['4N'] = { cs_a: { value: 117.0, source: { kind: 'manual' } } };
    const seeded = seedCpmgResiduesFromProfiles(base, profiles, 't');
    expect(seeded.residues['3N'].cs_a?.source.kind).toBe('pick');
    expect(seeded.residues['4N'].cs_a?.value).toBe(117.0);
    expect(staleResidueKeys(seeded, peakFitPicks(profiles))).toEqual([]);
    // peak fit moves -> stale
    expect(staleResidueKeys(seeded, peakFitPicks([{ residue: '3N', cs_a: 121 }]))).toEqual(['3N']);
  });

  it('never reports legacy "peak_fit" seeds as stale', () => {
    const cfg = createDefaultCpmgParameterConfig();
    cfg.residues['3N'] = { cs_a: { value: 120.1, source: { kind: 'pick', pickSetHash: LEGACY_PEAK_FIT_HASH, at: 't' } } };
    expect(staleResidueKeys(cfg, peakFitPicks([{ residue: '3N', cs_a: 125 }]))).toEqual([]);
  });
});
