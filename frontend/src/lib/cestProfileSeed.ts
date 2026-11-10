/**
 * CS_A estimate from a CEST profile: the offset of the main (deepest) dip.
 *
 * Offsets are in Hz from the carrier; offsets below −10 kHz are reference points (I0),
 * as in ProfileThumbnail. The dip position is taken per B1 experiment on a 3-point
 * smoothed I/I0 trace, and the median across experiments is returned. Profiles with no
 * clear dip (minimum above 90 % of the median intensity) give null.
 */

export interface CestExperimentLike {
  b0?: number;
  carrier?: number;
  offsets?: number[];
  intensities?: number[];
  error?: string;
}

export interface CestProfileLike {
  experiments?: CestExperimentLike[];
}

const REFERENCE_OFFSET_HZ = -10000;

/** Hz offset → ppm for a nucleus with gyromagnetic ratio `xi` relative to ¹H. */
export function offsetHzToPpm(hz: number, b0MHz: number, carrierPpm: number, xi: number): number {
  return hz / (b0MHz * xi) + carrierPpm;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function dipOfExperiment(exp: CestExperimentLike, xi: number): number | null {
  const offsets = exp.offsets ?? [];
  const intensities = exp.intensities ?? [];
  if (exp.error || offsets.length === 0 || offsets.length !== intensities.length) return null;
  const refIdx = offsets.findIndex(o => o < REFERENCE_OFFSET_HZ);
  const i0 = refIdx !== -1 && intensities[refIdx] !== 0 ? intensities[refIdx] : 1;
  const pts = offsets
    .map((o, i) => ({ o, y: intensities[i] / i0 }))
    .filter(p => p.o >= REFERENCE_OFFSET_HZ && Number.isFinite(p.y))
    .sort((a, b) => a.o - b.o);
  if (pts.length < 5) return null;
  const smooth = pts.map((_p, i) => {
    const w = pts.slice(Math.max(0, i - 1), i + 2);
    return w.reduce((s, q) => s + q.y, 0) / w.length;
  });
  let k = 0;
  for (let i = 1; i < smooth.length; i++) if (smooth[i] < smooth[k]) k = i;
  if (smooth[k] > 0.9 * median(smooth)) return null;
  return offsetHzToPpm(pts[k].o, exp.b0 || 600, exp.carrier || 0, xi);
}

export function mainDipPpm(profile: CestProfileLike | undefined | null, xi: number): number | null {
  const dips = (profile?.experiments ?? []).map(e => dipOfExperiment(e, xi)).filter((v): v is number => v !== null);
  return dips.length ? median(dips) : null;
}
