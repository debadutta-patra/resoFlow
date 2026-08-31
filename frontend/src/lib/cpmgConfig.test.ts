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
