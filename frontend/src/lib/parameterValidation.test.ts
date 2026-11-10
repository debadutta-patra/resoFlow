import { describe, it, expect } from "vitest";
import { validateParameterConfig } from "./parameterValidation";
import type { ParameterConfig } from "./parameterConfig";

describe("validateParameterConfig nucleus-aware validation", () => {
  it("validates 15N parameters using default 15N range and threshold", () => {
    const config: ParameterConfig = {
      globals: {
        pb: { value: 0.05, source: { kind: "default" } },
        kex_ab: { value: 300, source: { kind: "default" } },
      },
      residues: {
        "2N": {
          cs_a: { value: 120.5, source: { kind: "default" } },
          dw_ab: { value: 3.0, source: { kind: "default" } },
        },
        "3N": {
          cs_a: { value: 140.0, source: { kind: "default" } }, // Out of 15N range (100-135)
          dw_ab: { value: 8.0, source: { kind: "default" } }, // Out of 15N dw warn (6.0)
        },
      },
    };

    const issues = validateParameterConfig(config, { selectedModule: "cest_15n" });
    const csaIssue = issues.find(i => i.id === "res-csa-range-3N");
    const dwIssue = issues.find(i => i.id === "res-dw-range-3N");

    expect(csaIssue).toBeDefined();
    expect(csaIssue?.message).toContain("outside normal range (100–135)");
    expect(dwIssue).toBeDefined();
    expect(dwIssue?.message).toContain("unusually large (> 6 ppm)");
  });

  it("validates 1H amide parameters without firing 15N range warnings", () => {
    const config: ParameterConfig = {
      globals: {},
      residues: {
        "2HN-N": {
          cs_a: { value: 8.3, source: { kind: "default" } }, // Valid 1HN (6.0-11.5)
          dw_ab: { value: 0.8, source: { kind: "default" } }, // Valid 1HN dw (<= 1.5)
        },
        "3HN-N": {
          cs_a: { value: 4.5, source: { kind: "default" } }, // Out of 1HN range
          dw_ab: { value: 2.2, source: { kind: "default" } }, // Exceeds 1HN dw threshold (1.5)
        },
      },
    };

    const issues = validateParameterConfig(config, { selectedModule: "cest_1hn_ip_ap" });
    expect(issues.find(i => i.id === "res-csa-range-2HN-N")).toBeUndefined();
    expect(issues.find(i => i.id === "res-dw-range-2HN-N")).toBeUndefined();

    const csaIssue = issues.find(i => i.id === "res-csa-range-3HN-N");
    const dwIssue = issues.find(i => i.id === "res-dw-range-3HN-N");
    expect(csaIssue).toBeDefined();
    expect(csaIssue?.message).toContain("outside normal range (6–11.5)");
    expect(dwIssue).toBeDefined();
    expect(dwIssue?.message).toContain("unusually large (> 1.5 ppm)");
  });

  it("validates 13C parameters without firing 15N range warnings", () => {
    const config: ParameterConfig = {
      globals: {},
      residues: {
        "2C": {
          cs_a: { value: 45.0, source: { kind: "default" } }, // Valid 13C aliphatic (0-220)
          dw_ab: { value: 4.0, source: { kind: "default" } }, // Valid 13C dw (<= 8.0)
        },
      },
    };

    const issues = validateParameterConfig(config, { selectedModule: "cest_13c" });
    expect(issues.filter(i => i.scope === "residue")).toHaveLength(0);
  });

  it("validates methyl 1H parameters without firing 15N range warnings", () => {
    const config: ParameterConfig = {
      globals: {},
      residues: {
        "3HD1-CD1": {
          cs_a: { value: 0.85, source: { kind: "default" } }, // Valid methyl 1H (-0.5 - 4.0)
          dw_ab: { value: 0.35, source: { kind: "default" } }, // Valid methyl dw (<= 1.5)
        },
      },
    };

    const issues = validateParameterConfig(config, { selectedModule: "cest_ch3_1h_ip_ap" });
    expect(issues.filter(i => i.scope === "residue")).toHaveLength(0);
  });
});

describe("validateParameterConfig bounds", () => {
  const m = { kind: "manual" as const };
  const step = (over: Record<string, unknown> = {}) =>
    ({
      id: "s1",
      name: "STEP1",
      parameters: [
        { name: "PB", mode: "fit" },
        { name: "KEX_AB", mode: "fit" },
        { name: "DW_AB", mode: "default" },
        { name: "R2_A", mode: "default" },
      ],
      residueMode: "all",
      residues: [],
      ...over,
    }) as any;

  it("flags a start value outside explicit bounds and outside ChemEx default bounds", () => {
    const config: ParameterConfig = {
      globals: {
        pb: { value: 0.3, lower: 0, upper: 0.2, source: m },
        kex_ab: { value: 2e6, source: m }, // ChemEx default upper is 1e6
      },
      residues: { "13N": { dw_ab: { value: 120, source: m } } }, // ChemEx DW bounds ±100
    };
    const ids = validateParameterConfig(config).map(i => i.id);
    expect(ids).toContain("start-outside-bounds-PB");
    expect(ids).toContain("start-outside-bounds-KEX_AB");
    expect(ids).toContain("start-outside-bounds-DW_AB-13N");
  });

  it("flags inverted bounds", () => {
    const config: ParameterConfig = {
      globals: { kex_ab: { value: 200, lower: 500, upper: 100, source: m } },
      residues: { "13N": { cs_a: { value: 110, lower: 120, upper: 120, source: m } } },
    };
    const ids = validateParameterConfig(config).map(i => i.id);
    expect(ids).toContain("bounds-inverted-KEX_AB");
    expect(ids).toContain("bounds-inverted-CS_A-13N");
  });

  it("accepts negative DW_AB inside its bounds", () => {
    const config: ParameterConfig = {
      globals: {},
      residues: { "55N": { dw_ab: { value: -6.5, lower: -15, upper: 0, source: m } } },
    };
    expect(validateParameterConfig(config).filter(i => i.id.includes("bounds"))).toHaveLength(0);
  });

  it("uses a catalogue lookup over the static table", () => {
    const config: ParameterConfig = { globals: { pb: { value: 0.5, source: m } }, residues: {} };
    const lookup = (n: string) => (n === "PB" ? { name: "PB", value: 0.05, lower: 0, upper: 0.4 } : undefined);
    expect(validateParameterConfig(config, { defaults: lookup }).map(i => i.id)).toContain("start-outside-bounds-PB");
  });

  it("adds one info item per MCMC step listing sampled parameters still on default bounds", () => {
    const config: ParameterConfig = {
      globals: { pb: { value: 0.05, lower: 0, upper: 0.2, source: m }, kex_ab: { value: 200, source: m } },
      residues: {},
    };
    const methodConfig = {
      steps: [step({ statistics: { mcmc: { enabled: true, steps: 1000, burn: "auto" } } }), step({ id: "s2", name: "STEP2" })],
    } as any;
    const mcmc = validateParameterConfig(config, { methodConfig }).filter(i => i.id.startsWith("mcmc-default-bounds"));
    expect(mcmc).toHaveLength(1);
    expect(mcmc[0].severity).toBe("info");
    expect(mcmc[0].message).toContain("DW_AB, KEX_AB"); // PB has explicit bounds; R2_A is fixed by default
    expect(mcmc[0].message).not.toContain("PB,");
    expect(mcmc[0].message).not.toContain("R2_A");
  });

  it("warns that TREF bounds are not allowed", () => {
    const config: ParameterConfig = { globals: { tref: { value: 25, lower: 0, upper: 50, source: m } }, residues: {} };
    expect(validateParameterConfig(config).map(i => i.id)).toContain("bounds-tref-TREF");
  });
});
