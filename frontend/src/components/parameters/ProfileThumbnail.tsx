import React from 'react';

interface CestExperiment {
  b1: string;
  b1_actual: number;
  b0: number;
  carrier: number;
  offsets: number[];
  intensities: number[];
  uncertainties?: number[];
  error?: string;
}

export interface CestProfile {
  residue: string;
  full_residue?: string;
  experiments: CestExperiment[];
}

interface ProfileThumbnailProps {
  profile?: CestProfile;
  csA?: number | null;
  csB?: number | null;
  width?: number;
  height?: number;
  className?: string;
}

export const ProfileThumbnail: React.FC<ProfileThumbnailProps> = ({
  profile,
  csA,
  csB,
  width = 160,
  height = 50,
  className = '',
}) => {
  if (!profile || !profile.experiments || profile.experiments.length === 0) {
    return (
      <div
        className={`flex items-center justify-center bg-slate-100 dark:bg-slate-800 text-[10px] text-slate-400 rounded ${className}`}
        style={{ width, height }}
      >
        No profile
      </div>
    );
  }

  // Convert raw offsets & intensities into ppm points for the first valid experiment
  const exp = profile.experiments.find(e => !e.error && e.offsets && e.offsets.length > 0) || profile.experiments[0];
  if (!exp || !exp.offsets || exp.offsets.length === 0) {
    return (
      <div
        className={`flex items-center justify-center bg-slate-100 dark:bg-slate-800 text-[10px] text-slate-400 rounded ${className}`}
        style={{ width, height }}
      >
        No data
      </div>
    );
  }

  const toPpm = (hz: number) => hz / ((exp.b0 || 600.0) * 0.10136) + (exp.carrier || 0.0);
  
  // Find reference intensity
  const refIdx = exp.offsets.findIndex(o => o < -10000);
  const i0 = refIdx !== -1 && exp.intensities[refIdx] > 0 ? exp.intensities[refIdx] : 1.0;

  const validPoints: { ppm: number; normI: number }[] = [];
  for (let i = 0; i < exp.offsets.length; i++) {
    if (exp.offsets[i] > -10000) {
      validPoints.push({
        ppm: toPpm(exp.offsets[i]),
        normI: Math.max(0, exp.intensities[i] / i0),
      });
    }
  }

  if (validPoints.length === 0) {
    return (
      <div
        className={`flex items-center justify-center bg-slate-100 dark:bg-slate-800 text-[10px] text-slate-400 rounded ${className}`}
        style={{ width, height }}
      >
        No points
      </div>
    );
  }

  // Sort points by ppm
  validPoints.sort((a, b) => a.ppm - b.ppm);

  // Compute bounding box (NMR ppm is reversed: right-to-left or left-to-right)
  const allPpms = validPoints.map(p => p.ppm);
  if (csA != null) allPpms.push(csA);
  if (csB != null) allPpms.push(csB);

  const minPpm = Math.min(...allPpms) - 0.5;
  const maxPpm = Math.max(...allPpms) + 0.5;
  const ppmRange = Math.max(0.1, maxPpm - minPpm);

  const maxI = Math.max(...validPoints.map(p => p.normI), 1.05);

  const padL = 4;
  const padR = 4;
  const padT = 4;
  const padB = 4;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  // NMR axis is traditionally downfield on left (maxPpm on left, minPpm on right)
  const scaleX = (ppm: number) => padL + ((maxPpm - ppm) / ppmRange) * plotW;
  const scaleY = (normI: number) => padT + (1 - normI / maxI) * plotH;

  const pathD = validPoints
    .map((pt, idx) => `${idx === 0 ? 'M' : 'L'} ${scaleX(pt.ppm).toFixed(1)} ${scaleY(pt.normI).toFixed(1)}`)
    .join(' ');

  const xA = csA != null ? scaleX(csA) : null;
  const xB = csB != null ? scaleX(csB) : null;

  return (
    <div
      className={`relative inline-block overflow-hidden rounded bg-slate-900 border border-slate-700/80 shadow-2xs group cursor-pointer ${className}`}
      style={{ width, height }}
      title={`CEST Profile for ${profile.full_residue || profile.residue} (B1: ${exp.b1 || 'ref'})`}
    >
      <svg width={width} height={height} className="block">
        {/* Profile curve */}
        <path
          d={pathD}
          fill="none"
          stroke="#3b82f6"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* CS_A vertical line (Ground state - cyan/blue) */}
        {xA !== null && (
          <line
            x1={xA}
            y1={padT}
            x2={xA}
            y2={height - padB}
            stroke="#38bdf8"
            strokeWidth="1.5"
            strokeDasharray="2 1"
          />
        )}

        {/* CS_B vertical line (Excited state - red/coral) */}
        {xB !== null && (
          <line
            x1={xB}
            y1={padT}
            x2={xB}
            y2={height - padB}
            stroke="#f87171"
            strokeWidth="1.5"
            strokeDasharray="2 1"
          />
        )}
      </svg>

      {/* Mini state markers */}
      {xA !== null && (
        <span
          className="absolute top-0.5 text-[8px] font-black text-sky-300 pointer-events-none transform -translate-x-1/2"
          style={{ left: `${xA}px` }}
        >
          A
        </span>
      )}
      {xB !== null && (
        <span
          className="absolute top-0.5 text-[8px] font-black text-red-300 pointer-events-none transform -translate-x-1/2"
          style={{ left: `${xB}px` }}
        >
          B
        </span>
      )}
    </div>
  );
};
