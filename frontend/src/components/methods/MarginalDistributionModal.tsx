import React, { useEffect, useState } from 'react';
import { X, Activity, BarChart2 } from 'lucide-react';
import Plot from '../Plot';
import { useTheme } from '../../context/ThemeContext';
import { formatUncertainty } from '../../lib/uncertaintyFormatter';
import { parseParameterLabel, ppmToHz } from '../../lib/parameterSymbols';

import api from '../../lib/api';

interface MarginalDistributionModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectUuid: string;
  analysisUuid: string;
  methodName: string;
  stepName?: string;
  parameterName: string;
  paramSummary?: any;
}

interface HistogramData {
  parameter_name: string;
  sample_count: number;
  bin_edges: number[];
  bin_centers: number[];
  counts: number[];
  mean: number;
  median: number;
  standard_deviation: number;
  percentile_95_lower: number;
  percentile_95_upper: number;
  skewness: number;
  deterministic_value?: number;
}

export const MarginalDistributionModal: React.FC<MarginalDistributionModalProps> = ({
  isOpen,
  onClose,
  projectUuid,
  analysisUuid,
  methodName,
  stepName,
  parameterName,
  paramSummary,
}) => {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const [data, setData] = useState<HistogramData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unitModeHz, setUnitModeHz] = useState(false);

  const parsedLabel = parseParameterLabel(parameterName);
  const isChemicalShift = parsedLabel.category === 'chemical_shift';

  useEffect(() => {
    if (!isOpen || !parameterName) return;

    let isMounted = true;
    setLoading(true);
    setError(null);

    const stepParam = stepName ? `&step_name=${encodeURIComponent(stepName)}` : '';
    const url = `/api/projects/${projectUuid}/analysis/${analysisUuid}/statistics/histogram?parameter_name=${encodeURIComponent(
      parameterName
    )}&method_name=${encodeURIComponent(methodName)}${stepParam}`;

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
          const msg = err.response?.data?.detail || err.message || 'Failed to load distribution';
          setError(msg);
          setLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen, projectUuid, analysisUuid, methodName, stepName, parameterName]);

  if (!isOpen) return null;

  // Unit conversion factor
  const scale = unitModeHz && isChemicalShift ? ppmToHz(1.0, 600.0, '15N') : 1.0;
  const currentUnit = unitModeHz && isChemicalShift ? 'Hz' : parsedLabel.unit || '';

  let plotData: any[] = [];
  let plotLayout: any = {};

  if (data && data.bin_centers && data.bin_centers.length > 0) {
    const xCenters = data.bin_centers.map(v => v * scale);
    const yCounts = data.counts;
    const pLow = data.percentile_95_lower * scale;
    const pHigh = data.percentile_95_upper * scale;
    const medianVal = data.median * scale;
    const detVal = data.deterministic_value !== undefined ? data.deterministic_value * scale : undefined;

    // Color bars based on whether they fall within the 95% band
    const barColors = xCenters.map(x =>
      x >= pLow && x <= pHigh
        ? isDark ? '#818cf8' : '#6366f1'
        : isDark ? '#4338ca' : '#c7d2fe'
    );

    plotData = [
      {
        x: xCenters,
        y: yCounts,
        type: 'bar',
        marker: {
          color: barColors,
          line: {
            color: isDark ? '#312e81' : '#4f46e5',
            width: 1,
          },
        },
        name: 'Replicates',
        hovertemplate: `Value: %{x:.4f} ${currentUnit}<br>Counts: %{y}<extra></extra>`,
      },
    ];

    const shapes: any[] = [
      // 95% CI Shaded Background
      {
        type: 'rect',
        xref: 'x',
        yref: 'paper',
        x0: pLow,
        x1: pHigh,
        y0: 0,
        y1: 1,
        fillcolor: isDark ? 'rgba(99, 102, 241, 0.12)' : 'rgba(99, 102, 241, 0.08)',
        line: { width: 0 },
        layer: 'below',
      },
      // Median Line
      {
        type: 'line',
        xref: 'x',
        yref: 'paper',
        x0: medianVal,
        x1: medianVal,
        y0: 0,
        y1: 1,
        line: {
          color: '#10b981',
          width: 2.5,
          dash: 'solid',
        },
      },
    ];

    if (detVal !== undefined) {
      shapes.push({
        type: 'line',
        xref: 'x',
        yref: 'paper',
        x0: detVal,
        x1: detVal,
        y0: 0,
        y1: 1,
        line: {
          color: '#ef4444',
          width: 2,
          dash: 'dash',
        },
      });
    }

    plotLayout = {
      title: false,
      autosize: true,
      height: 320,
      margin: { l: 50, r: 25, t: 20, b: 50 },
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      shapes,
      xaxis: {
        title: {
          text: `${parsedLabel.displaySymbol} (${currentUnit})`,
          font: { size: 12, color: isDark ? '#94a3b8' : '#64748b', weight: 600 },
        },
        gridcolor: isDark ? '#1e293b' : '#f1f5f9',
        zeroline: false,
        tickfont: { color: isDark ? '#cbd5e1' : '#475569', size: 11 },
      },
      yaxis: {
        title: {
          text: 'Count',
          font: { size: 12, color: isDark ? '#94a3b8' : '#64748b', weight: 600 },
        },
        gridcolor: isDark ? '#1e293b' : '#f1f5f9',
        zeroline: false,
        tickfont: { color: isDark ? '#cbd5e1' : '#475569', size: 11 },
      },
      bargap: 0.1,
      showlegend: false,
    };
  }

  const stat = data || paramSummary;
  const isSkewed = stat?.skew !== undefined ? Math.abs(stat.skew) > 0.45 : (stat?.skewness !== undefined ? Math.abs(stat.skewness) > 0.45 : false);
  const skewVal = stat?.skew ?? stat?.skewness;
  const detVal = stat?.deterministic_value;
  const medianVal = stat?.median;
  const sdVal = stat?.standard_deviation ?? stat?.std_dev ?? stat?.std;
  const biasRatio = detVal !== undefined && medianVal !== undefined && sdVal > 0 ? (detVal - medianVal) / sdVal : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-in fade-in duration-200">
      <div className="relative w-full max-w-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 border border-indigo-100 dark:border-indigo-900">
              <BarChart2 className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-bold text-slate-900 dark:text-white font-mono">
                  {parsedLabel.displaySymbol}
                </h3>
                {parsedLabel.residue !== '—' && parsedLabel.residue !== 'Global' && (
                  <span className="px-2 py-0.5 text-xs font-semibold rounded-md bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                    {parsedLabel.residue}
                  </span>
                )}
                {parsedLabel.field !== '—' && parsedLabel.field !== 'Global' && (
                  <span className="px-2 py-0.5 text-xs font-semibold rounded-md bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                    {parsedLabel.field}
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-500 font-mono mt-0.5">{parsedLabel.raw}</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {isChemicalShift && (
              <button
                type="button"
                onClick={() => setUnitModeHz(!unitModeHz)}
                className={`px-2.5 py-1 text-xs font-semibold rounded-lg border transition-colors ${
                  unitModeHz
                    ? 'bg-indigo-600 text-white border-indigo-600'
                    : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700'
                }`}
              >
                {unitModeHz ? 'Units: Hz (600 MHz)' : 'Units: ppm'}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto space-y-5">
          {loading && (
            <div className="h-72 flex flex-col items-center justify-center gap-3 text-slate-400">
              <Activity className="w-6 h-6 animate-spin text-indigo-500" />
              <p className="text-sm font-medium">Loading marginal distribution & Freedman–Diaconis bins...</p>
            </div>
          )}

          {error && (
            <div className="p-4 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-700 dark:text-rose-300 text-sm">
              {error}
            </div>
          )}

          {!loading && !error && data && (
            <>
              {/* Legend Strip */}
              <div className="flex flex-wrap items-center justify-between gap-3 text-xs px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/70 dark:border-slate-700/60">
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-1.5">
                    <span className="w-3 h-3 rounded-xs bg-indigo-500"></span>
                    <span className="text-slate-600 dark:text-slate-300 font-medium">95% Interval Band</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="w-3.5 h-0.5 bg-emerald-500"></span>
                    <span className="text-slate-600 dark:text-slate-300 font-medium">Median</span>
                  </div>
                  {detVal !== undefined && (
                    <div className="flex items-center gap-1.5">
                      <span className="w-3.5 h-0.5 bg-rose-500 border-b border-dashed border-rose-500"></span>
                      <span className="text-slate-600 dark:text-slate-300 font-medium">Deterministic Fit</span>
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2 font-mono">
                  <span>N = {data.sample_count}</span>
                  {isSkewed && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800 dark:bg-amber-950/80 dark:text-amber-300 border border-amber-300 dark:border-amber-800">
                      Skewed (γ₁ = {skewVal?.toFixed(2)})
                    </span>
                  )}
                  {biasRatio !== null && Math.abs(biasRatio) > 0.25 && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-orange-100 text-orange-800 dark:bg-orange-950/80 dark:text-orange-300 border border-orange-300 dark:border-orange-800">
                      Bias: {(biasRatio * 100).toFixed(0)}% σ
                    </span>
                  )}
                </div>
              </div>

              {/* Plot */}
              <div className="w-full h-80 rounded-xl bg-slate-50/50 dark:bg-slate-950/40 p-2 border border-slate-100 dark:border-slate-800/80">
                <Plot data={plotData} layout={plotLayout} />
              </div>

              {/* Statistics Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200/60 dark:border-slate-700/50">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 block mb-1">
                    Median (50%)
                  </span>
                  <span className="text-sm font-semibold font-mono text-slate-900 dark:text-white">
                    {formatUncertainty(data.median * scale, null, { unit: currentUnit }).formatted}
                  </span>
                </div>

                <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200/60 dark:border-slate-700/50">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 block mb-1">
                    SD ({methodName})
                  </span>
                  <span className="text-sm font-semibold font-mono text-slate-900 dark:text-white">
                    {formatUncertainty(data.standard_deviation * scale, null, { unit: currentUnit }).formatted}
                  </span>
                </div>

                <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200/60 dark:border-slate-700/50">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 block mb-1">
                    95% Equal-Tailed
                  </span>
                  <span className="text-xs font-semibold font-mono text-indigo-600 dark:text-indigo-400">
                    [{formatUncertainty(data.percentile_95_lower * scale, null).formatted},{' '}
                    {formatUncertainty(data.percentile_95_upper * scale, null).formatted}]
                  </span>
                </div>

                <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200/60 dark:border-slate-700/50">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 block mb-1">
                    Deterministic Fit
                  </span>
                  <span className="text-sm font-semibold font-mono text-slate-900 dark:text-white">
                    {detVal !== undefined
                      ? formatUncertainty(detVal, null, { unit: currentUnit }).formatted
                      : '—'}
                  </span>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default MarginalDistributionModal;
