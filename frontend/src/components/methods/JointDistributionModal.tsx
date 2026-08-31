import React, { useEffect, useState } from 'react';
import { X, Activity, GitCommit, Layers } from 'lucide-react';
import Plot from '../Plot';
import { useTheme } from '../../context/ThemeContext';
import { parseParameterLabel } from '../../lib/parameterSymbols';

import api from '../../lib/api';

interface JointDistributionModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectUuid: string;
  analysisUuid: string;
  methodName: string;
  stepName?: string;
  paramX: string;
  paramY: string;
}

interface JointData {
  param_x: string;
  param_y: string;
  sample_count: number;
  correlation_r: number;
  x_bins?: number[];
  y_bins?: number[];
  x_centers?: number[];
  y_centers?: number[];
  x_edges?: number[];
  y_edges?: number[];
  counts_2d: number[][];
  x_deterministic?: number;
  y_deterministic?: number;
}

export const JointDistributionModal: React.FC<JointDistributionModalProps> = ({
  isOpen,
  onClose,
  projectUuid,
  analysisUuid,
  methodName,
  stepName,
  paramX,
  paramY,
}) => {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const [data, setData] = useState<JointData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const labelX = parseParameterLabel(paramX);
  const labelY = parseParameterLabel(paramY);

  useEffect(() => {
    if (!isOpen || !paramX || !paramY) return;

    let isMounted = true;
    setLoading(true);
    setError(null);

    const stepParam = stepName ? `&step_name=${encodeURIComponent(stepName)}` : '';
    const url = `/api/projects/${projectUuid}/analysis/${analysisUuid}/statistics/joint-distribution?param_x=${encodeURIComponent(
      paramX
    )}&param_y=${encodeURIComponent(paramY)}&method_name=${encodeURIComponent(methodName)}${stepParam}`;

    api
      .get(url)
      .then(res => {
        if (isMounted) {
          setData(res.data);
          setLoading(false);
        }
      })
      .catch(err => {
        if (isMounted) {
          const msg = err.response?.data?.detail || err.message || 'Failed to load joint distribution';
          setError(msg);
          setLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen, projectUuid, analysisUuid, methodName, stepName, paramX, paramY]);

  if (!isOpen) return null;

  let plotData: any[] = [];
  let plotLayout: any = {};

  if (data && data.counts_2d && data.counts_2d.length > 0) {
    const xEdges = data.x_edges;
    const yEdges = data.y_edges;
    const xBins =
      data.x_bins ||
      data.x_centers ||
      (xEdges && xEdges.length > 1
        ? xEdges.slice(0, -1).map((e: number, i: number) => (e + xEdges[i + 1]) / 2.0)
        : []);
    const yBins =
      data.y_bins ||
      data.y_centers ||
      (yEdges && yEdges.length > 1
        ? yEdges.slice(0, -1).map((e: number, i: number) => (e + yEdges[i + 1]) / 2.0)
        : []);

    plotData = [
      {
        x: xBins,
        y: yBins,
        z: data.counts_2d,
        type: 'heatmap',
        colorscale: isDark
          ? [
              [0, '#0f172a'],
              [0.15, '#1e1b4b'],
              [0.4, '#3730a3'],
              [0.7, '#6366f1'],
              [1, '#fbbf24'],
            ]
          : [
              [0, '#f8fafc'],
              [0.15, '#e0e7ff'],
              [0.4, '#818cf8'],
              [0.7, '#4f46e5'],
              [1, '#d97706'],
            ],
        showscale: true,
        colorbar: {
          title: 'Density',
          titleside: 'right',
          tickfont: { size: 10, color: isDark ? '#94a3b8' : '#64748b' },
          len: 0.8,
        },
        hovertemplate: `${labelX.displaySymbol}: %{x:.4f}<br>${labelY.displaySymbol}: %{y:.4f}<br>Count: %{z}<extra></extra>`,
      },
    ];

    plotLayout = {
      title: false,
      autosize: true,
      height: 380,
      margin: { l: 60, r: 40, t: 20, b: 60 },
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      xaxis: {
        title: {
          text: `${labelX.displaySymbol} (${labelX.unit || ''})`,
          font: { size: 12, color: isDark ? '#94a3b8' : '#64748b', weight: 600 },
        },
        gridcolor: isDark ? '#1e293b' : '#f1f5f9',
        zeroline: false,
        tickfont: { color: isDark ? '#cbd5e1' : '#475569', size: 11 },
      },
      yaxis: {
        title: {
          text: `${labelY.displaySymbol} (${labelY.unit || ''})`,
          font: { size: 12, color: isDark ? '#94a3b8' : '#64748b', weight: 600 },
        },
        gridcolor: isDark ? '#1e293b' : '#f1f5f9',
        zeroline: false,
        tickfont: { color: isDark ? '#cbd5e1' : '#475569', size: 11 },
      },
      showlegend: false,
    };
  }

  const rVal = data?.correlation_r ?? 0;
  const absR = Math.abs(rVal);
  const isHighCorr = absR >= 0.7;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-in fade-in duration-200">
      <div className="relative w-full max-w-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 border border-indigo-100 dark:border-indigo-900">
              <Layers className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-bold text-slate-900 dark:text-white font-mono">
                  {labelX.displaySymbol} × {labelY.displaySymbol}
                </h3>
                <span
                  className={`px-2.5 py-0.5 text-xs font-bold rounded-md font-mono border ${
                    isHighCorr
                      ? 'bg-rose-100 text-rose-800 dark:bg-rose-950/70 dark:text-rose-300 border-rose-300 dark:border-rose-800'
                      : absR >= 0.4
                      ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/70 dark:text-amber-300 border-amber-300 dark:border-amber-800'
                      : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800'
                  }`}
                >
                  r = {rVal > 0 ? `+${rVal.toFixed(3)}` : rVal.toFixed(3)}
                  {isHighCorr && ' (High Correlation)'}
                </span>
              </div>
              <p className="text-xs text-slate-500 font-mono mt-0.5">
                {labelX.raw} vs {labelY.raw}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto space-y-4">
          {loading && (
            <div className="h-72 flex flex-col items-center justify-center gap-3 text-slate-400">
              <Activity className="w-6 h-6 animate-spin text-indigo-500" />
              <p className="text-sm font-medium">Computing 2D joint density matrix...</p>
            </div>
          )}

          {error && (
            <div className="p-4 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-700 dark:text-rose-300 text-sm">
              {error}
            </div>
          )}

          {!loading && !error && data && (
            <>
              {isHighCorr && (
                <div className="p-3 rounded-xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/60 text-xs text-rose-800 dark:text-rose-300 flex items-center gap-2">
                  <GitCommit className="w-4 h-4 shrink-0 text-rose-500" />
                  <span>
                    Strong linear dependence (|r| ≥ 0.70) detected. One parameter may not be independently identifiable with the current data set.
                  </span>
                </div>
              )}

              <div className="w-full h-96 rounded-xl bg-slate-50/50 dark:bg-slate-950/40 p-2 border border-slate-100 dark:border-slate-800/80">
                <Plot data={plotData} layout={plotLayout} />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default JointDistributionModal;
