import React from 'react';

interface ParameterSparklineProps {
  counts?: number[];
  width?: number;
  height?: number;
  isSkewed?: boolean;
}

export const ParameterSparkline: React.FC<ParameterSparklineProps> = ({
  counts,
  width = 64,
  height = 20,
  isSkewed = false,
}) => {
  if (!counts || counts.length === 0) {
    return (
      <div className="w-16 h-5 rounded bg-slate-100 dark:bg-slate-800/50 flex items-center justify-center text-[9px] text-slate-400">
        —
      </div>
    );
  }

  const maxVal = Math.max(...counts, 1);
  const n = counts.length;
  const barWidth = Math.max(1, (width - (n - 1)) / n);

  return (
    <div className="inline-flex items-center gap-1">
      <svg
        width={width}
        height={height}
        className="overflow-hidden rounded-xs bg-slate-50/50 dark:bg-slate-900/40"
        aria-label="Parameter distribution sparkline"
      >
        {counts.map((c, i) => {
          const barHeight = Math.max(1.5, (c / maxVal) * (height - 2));
          const x = i * (barWidth + 1);
          const y = height - barHeight;
          const isTail = i < n * 0.05 || i > n * 0.95;
          let fillColor = isSkewed ? '#f59e0b' : '#8b5cf6';
          if (isTail) {
            fillColor = isSkewed ? '#fbbf24' : '#c4b5fd';
          }
          return (
            <rect
              key={i}
              x={x}
              y={y}
              width={barWidth}
              height={barHeight}
              fill={fillColor}
              opacity={isTail ? 0.45 : 0.85}
              rx={0.5}
            />
          );
        })}
      </svg>
      {isSkewed && (
        <span
          className="text-[9px] px-1 py-0.2 rounded font-bold font-mono bg-amber-100 text-amber-800 dark:bg-amber-950/70 dark:text-amber-300 border border-amber-200 dark:border-amber-800"
          title="Skewed distribution (|skew| > 0.45): asymmetric intervals provide more accurate coverage than symmetric ±σ."
        >
          skew
        </span>
      )}
    </div>
  );
};

export default ParameterSparkline;
