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
