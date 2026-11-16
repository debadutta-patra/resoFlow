/**
 * Interface for an automatic minor-dip seeder (candidate CS_B positions per residue).
 *
 * No seeder ships with resoFlow yet. The Pick CEST UI shows candidates only when a seeder is
 * registered AND the feature flag is on (env VITE_CEST_SEEDER=1, or localStorage
 * "resoFlow_cest_seeder" = "1"), so a seeder can be developed behind the flag without
 * touching the page.
 */

export interface SeedCandidate {
  /** Candidate minor-state shift (ppm). */
  cs_ppm: number;
  /** 0–1 confidence. */
  confidence: number;
}

export interface SeederProfile {
  residue: string;
  experiments: { b1: string; b1_actual?: number | null; b0: number; carrier: number; offsets: number[]; intensities: number[]; uncertainties?: number[] }[];
}

export interface CestSeeder {
  name: string;
  candidates(profile: SeederProfile, ctx: { xi: number; csA?: number | null }): SeedCandidate[] | Promise<SeedCandidate[]>;
}

let registered: CestSeeder | null = null;

export function registerCestSeeder(seeder: CestSeeder | null): void {
  registered = seeder;
}

export function seederFlagOn(): boolean {
  try {
    if ((import.meta as { env?: Record<string, string> }).env?.VITE_CEST_SEEDER === '1') return true;
  } catch {
    /* no env */
  }
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('resoFlow_cest_seeder') === '1';
  } catch {
    return false;
  }
}

/** The active seeder, or null when none is registered or the flag is off. */
export function activeCestSeeder(): CestSeeder | null {
  return registered && seederFlagOn() ? registered : null;
}

/** Candidates at or above `threshold`, best first. */
export function candidatesAbove(cands: SeedCandidate[], threshold: number): SeedCandidate[] {
  return cands.filter(c => c.confidence >= threshold).sort((a, b) => b.confidence - a.confidence);
}
