import { describe, it, expect } from "vitest";
import {
  computeR2effProfile,
  computeRexAndFlatness,
  estimateDeltaOmegaFastExchange,
} from "./cpmgReduction";

describe("cpmgReduction utilities", () => {
  it("computes R2eff and errors correctly from intensity profile", () => {
    const ncycs = [0.0, 2.0, 4.0, 8.0, 16.0];
    const intensities = [1000.0, 800.0, 850.0, 900.0, 950.0];
    const uncertainties = [20.0, 16.0, 17.0, 18.0, 19.0];
    const time_t2 = 0.04;

    const res = computeR2effProfile(ncycs, intensities, uncertainties, time_t2);
    expect(res.valid).toBe(true);
    expect(res.nu_cpmg).toHaveLength(4);
    expect(res.nu_cpmg[0]).toBe(50.0);
    expect(res.nu_cpmg[3]).toBe(400.0);
    expect(res.r2eff[0]).toBeCloseTo(5.5786, 3);
    expect(res.r2eff_err).toHaveLength(4);
    expect(res.r2eff_err[0]).toBeGreaterThan(0);
  });

  it("handles missing reference plane by returning valid: false", () => {
    const ncycs = [2.0, 4.0, 8.0];
    const intensities = [800.0, 850.0, 900.0];
    const res = computeR2effProfile(ncycs, intensities, undefined, 0.04);
    expect(res.valid).toBe(false);
    expect(res.error).toContain("Missing reference plane");
  });

  it("computes Rex and chi2 flatness accurately", () => {
    const nu_cpmg = [50.0, 100.0, 200.0, 400.0];
    const r2eff = [15.0, 13.5, 11.2, 10.0];
    const r2eff_err = [0.2, 0.2, 0.2, 0.2];

    const res = computeRexAndFlatness(nu_cpmg, r2eff, r2eff_err);
    expect(res.rex).toBeCloseTo(5.0, 2);
    expect(res.is_flat).toBe(false);
    expect(res.chi2_red).toBeGreaterThan(2.0);

    // Flat dispersion test
    const r2eff_flat = [10.0, 10.05, 9.98, 10.02];
    const res_flat = computeRexAndFlatness(nu_cpmg, r2eff_flat, r2eff_err);
    expect(res_flat.rex).toBeCloseTo(0.0, 1);
    expect(res_flat.is_flat).toBe(true);
  });

  it("estimates delta omega from Rex in the fast exchange limit", () => {
    const dw = estimateDeltaOmegaFastExchange(5.0, 1000.0, 0.05, 600.0, 0.101329118);
    expect(dw).toBeCloseTo(0.849, 2);
  });
});
