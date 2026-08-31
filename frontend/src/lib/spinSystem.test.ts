import { describe, it, expect } from "vitest";
import {
  parseSpinKey,
  normalizeResidueKey,
  extractResidueNumber,
  sortSpinKeys,
  deduplicateSpinKeys,
  resolveNumericRange,
  matchSpinKeySets,
} from "./spinSystem";

describe("SpinSystemKey parsing and formatting", () => {
  it("parses single-spin 15N and 13C keys", () => {
    const k1 = parseSpinKey("G2N");
    expect(k1.resNum).toBe(2);
    expect(k1.symbol).toBe("G");
    expect(k1.spins).toEqual(["N"]);
    expect(k1.canonical).toBe("G2N");
    expect(k1.short).toBe("2N");
    expect(normalizeResidueKey("GLY2N")).toBe("G2N");
    expect(extractResidueNumber("G2N")).toBe(2);

    const k2 = parseSpinKey("14N");
    expect(k2.resNum).toBe(14);
    expect(k2.symbol).toBe("");
    expect(k2.spins).toEqual(["N"]);
    expect(k2.canonical).toBe("14N");
    expect(k2.short).toBe("14N");

    const k3 = parseSpinKey("GLY14N");
    expect(k3.resNum).toBe(14);
    expect(k3.symbol).toBe("G");
    expect(k3.canonical).toBe("G14N");

    const k4 = parseSpinKey("40ASN");
    expect(k4.resNum).toBe(40);
    expect(k4.symbol).toBe("N");
    expect(k4.short).toBe("40N");
    expect(k4.canonical).toBe("N40N");

    const k5 = parseSpinKey("71LYS");
    expect(k5.resNum).toBe(71);
    expect(k5.symbol).toBe("K");
    expect(k5.short).toBe("71N");
    expect(k5.canonical).toBe("K71N");
  });

  it("parses two-spin 15N-1H TROSY and 1H-15N keys", () => {
    const k1 = parseSpinKey("G2N-HN");
    expect(k1.resNum).toBe(2);
    expect(k1.symbol).toBe("G");
    expect(k1.spins).toEqual(["N", "HN"]);
    expect(k1.canonical).toBe("G2N-HN");
    expect(k1.short).toBe("2N-HN");

    const k2 = parseSpinKey("G2HN-N");
    expect(k2.resNum).toBe(2);
    expect(k2.symbol).toBe("G");
    expect(k2.spins).toEqual(["HN", "N"]);
    expect(k2.canonical).toBe("G2HN-N");
    expect(k2.short).toBe("2HN-N");
  });

  it("parses methyl MQ and 1H keys", () => {
    const k1 = parseSpinKey("L3CD1-HD1");
    expect(k1.resNum).toBe(3);
    expect(k1.symbol).toBe("L");
    expect(k1.spins).toEqual(["CD1", "HD1"]);
    expect(k1.canonical).toBe("L3CD1-HD1");
    expect(k1.short).toBe("3CD1-HD1");

    const k2 = parseSpinKey("LEU3CD1-HD1");
    expect(k2.resNum).toBe(3);
    expect(k2.symbol).toBe("L");
    expect(k2.canonical).toBe("L3CD1-HD1");
  });
});

describe("SpinSystemKey sorting and ranges", () => {
  it("sorts keys numerically by residue number", () => {
    const raw = ["G14N", "G2N", "L3CD1-HD1", "102N", "25N-HN"];
    const sorted = sortSpinKeys(raw);
    expect(sorted).toEqual(["G2N", "L3CD1-HD1", "G14N", "25N-HN", "102N"]);
  });

  it("resolves numeric range expressions across formats", () => {
    const available = ["G2N", "L3CD1-HD1", "G14N", "15N", "25N-HN", "40N", "42N", "44N", "50N"];
    const { matched, unmatched } = resolveNumericRange("2, 14-15, 40-44", available);
    expect(matched).toEqual(["G2N", "G14N", "15N", "40N", "42N", "44N"]);
    expect(unmatched).toEqual([]);
  });

  it("matches cross-format key sets for inheritance", () => {
    const source = ["G2N", "L3N", "14N", "G25N"];
    const target = ["2N-HN", "L3CD1-HD1", "GLY14N-HN", "99N"];
    const res = matchSpinKeySets(source, target);
    expect(res.matched.length).toBe(3);
    expect(res.unmatchedSource).toEqual(["G25N"]);
    expect(res.unmatchedTarget).toEqual(["99N"]);
  });

  it("deduplicates spin keys representing the same spin entity", () => {
    const raw = ["32N", "32N-H", "55N", "55N-H", "65N", "65N-H", "14N", "14N-HN", "14CD1", "14CD1-HD1"];
    const deduped = deduplicateSpinKeys(raw);
    expect(deduped).toEqual(["14CD1", "14N", "32N", "55N", "65N"]);
  });
});

import { configToCpmgToml, cpmgTomlToConfig } from "./cpmgConfig";

describe("CPMG TOML serialization & deduplication", () => {
  it("deduplicates raw residue aliases like 3LYS vs 3N into canonical 3N only", () => {
    const config = {
      globals: {
        pb: { value: 0.05, source: { kind: "default" as const } },
        kex_ab: { value: 500, source: { kind: "default" as const } },
        dw_ab: { value: 2.0, source: { kind: "default" as const } },
        tauc_a: { value: 4.0, source: { kind: "default" as const } },
      },
      residues: {
        "3LYS": { cs_a: { value: 120.185, source: { kind: "default" as const } } },
        "3N": { cs_a: { value: 120.185, source: { kind: "default" as const } } },
        "4ASN": { cs_a: { value: 118.554, source: { kind: "default" as const } } },
        "71LYS": { cs_a: { value: 121.863, source: { kind: "default" as const } } },
      },
      excludedResidues: ["4N"],
    };

    const toml = configToCpmgToml(config);
    expect(toml).toContain("[CS_A]");
    expect(toml).toContain("3N = 120.185");
    expect(toml).not.toContain("3LYS");
    expect(toml).toContain("# 4N = 118.554");
    expect(toml).not.toContain("4ASN");
    expect(toml).toContain("71N = 121.863");
    expect(toml).not.toContain("71LYS");
  });

  it("normalizes imported TOML with raw residue aliases to canonical keys", () => {
    const rawToml = `
[GLOBAL]
PB = 0.05
KEX_AB = 500.0

[CS_A]
3LYS = 120.185
# 4ASN = 118.554
`;
    const { config } = cpmgTomlToConfig(rawToml);
    expect(config.residues["3N"]).toBeDefined();
    expect(config.residues["3N"].cs_a?.value).toBe(120.185);
    expect(config.residues["3LYS"]).toBeUndefined();
    expect(config.excludedResidues).toContain("4N");
  });
});
