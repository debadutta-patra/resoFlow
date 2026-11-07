import React from 'react';
import type { CpmgProfileItem } from './CpmgDispersionTab';

const FIELD_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

/** Compact R2,eff vs ν_CPMG sparkline (one line per field) for the residue parameter table. */
export const DispersionThumbnail: React.FC<{
  profile?: CpmgProfileItem;
  width?: number;
  height?: number;
  className?: string;
}> = ({ profile, width = 130, height = 34, className = '' }) => {
  const curves = (profile?.experiments || []).filter(e => e.nu_cpmg?.length && e.r2eff?.length);
  if (curves.length === 0) {
    return (
      <div
        style={{ width, height }}
        className={`rounded bg-slate-100 dark:bg-slate-800/50 flex items-center justify-center text-[9px] text-slate-400 ${className}`}
      >
        No dispersion
      </div>
    );
  }
  const xs = curves.flatMap(c => c.nu_cpmg);
  const ys = curves.flatMap(c => c.r2eff).filter(v => Number.isFinite(v));
  const [xMin, xMax] = [Math.min(...xs), Math.max(...xs)];
  const [yMin, yMax] = [Math.min(...ys), Math.max(...ys)];
  const pad = 3;
  const sx = (x: number) => pad + ((x - xMin) / (xMax - xMin || 1)) * (width - 2 * pad);
  const sy = (y: number) => height - pad - ((y - yMin) / (yMax - yMin || 1)) * (height - 2 * pad);

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={`rounded bg-slate-50 dark:bg-slate-900 ${className}`}
      role="img"
      aria-label={`Dispersion profile ${profile?.full_residue || profile?.residue || ''}`}
    >
      {curves.map((c, i) => {
        const pts = c.nu_cpmg
          .map((x, j) => [x, c.r2eff[j]] as const)
          .filter(([, y]) => Number.isFinite(y))
          .sort((a, b) => a[0] - b[0]);
        const color = FIELD_COLORS[i % FIELD_COLORS.length];
        return (
          <g key={`${c.b0}-${i}`}>
            <polyline
              fill="none"
              stroke={color}
              strokeWidth={1.2}
              points={pts.map(([x, y]) => `${sx(x)},${sy(y)}`).join(' ')}
            />
            {pts.map(([x, y], j) => (
              <circle key={j} cx={sx(x)} cy={sy(y)} r={1.3} fill={color} />
            ))}
          </g>
        );
      })}
    </svg>
  );
};

export default DispersionThumbnail;
