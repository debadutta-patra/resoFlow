/**
 * Rough rotational correlation time for a globular protein (Stokes–Einstein–Debye):
 * τc ∝ η·V/T with V ∝ MW. Calibrated at ≈ 1 ns per 2.6 kDa in water at 300 K, then scaled by
 * the solvent viscosity relative to water and by temperature:
 *
 *   τc(ns) = MW(kDa)/2.6 · η_rel · η_w(T)/η_w(300 K) · 300 K / T
 *
 * η_w(T) is water's viscosity from the Vogel equation (A·exp(B/(T − C)), T in K). This is
 * a starting value only: ChemEx keeps TAUC_A fixed by default and uses it to seed relaxation
 * estimates (model-free / R1·R2 initialisation).
 */

export const KDA_PER_NS_AT_300K = 2.6;

/** Water viscosity (mPa·s) at absolute temperature `tK` (Vogel fit, valid ~273–373 K). */
export function waterViscosity(tK: number): number {
  return 0.02939 * Math.exp(507.88 / (tK - 149.3));
}

export interface TaucInputs {
  mwKDa: number;
  temperatureC: number;
  /** Solvent viscosity relative to water at the same temperature (default 1). */
  viscosityRel?: number;
}

/** Estimated τc in ns, or null for non-physical inputs. */
export function estimateTaucNs({ mwKDa, temperatureC, viscosityRel = 1 }: TaucInputs): number | null {
  const tK = temperatureC + 273.15;
  if (!(mwKDa > 0) || !(viscosityRel > 0) || !(tK > 250) || !(tK < 400)) return null;
  const tau = (mwKDa / KDA_PER_NS_AT_300K) * viscosityRel * (waterViscosity(tK) / waterViscosity(300)) * (300 / tK);
  return Number.isFinite(tau) ? tau : null;
}

/** Celsius from an analysis temperature that may be stored in K or °C. */
export const toCelsius = (t: number | null | undefined): number => (t === null || t === undefined ? 25 : t > 200 ? t - 273.15 : t);
