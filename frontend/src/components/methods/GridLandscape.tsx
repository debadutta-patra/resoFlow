/**
 * χ² landscape of a GRID step's last completed run, under the axis editor: the 2D Δχ²
 * surface for two axes (pair selector for more), the 1D profile for one axis. The currently
 * configured ranges are drawn on top (dashed rectangle / lines), so range edits can be judged
 * against the old landscape, and the committed minimum is marked.
 */

import React, { useEffect, useMemo, useState } from 'react';
import Plot from '../Plot';
import type { SearchAxis } from '../../lib/methodConfig';
import { fmtValue, type GridSurface, type OverviewGrid } from '../../lib/runOverview';

export interface GridLandscapeProps {
  stepName: string;
  grid: OverviewGrid;
  /** The step's current axes (ranges shown over the old landscape). */
  axes: SearchAxis[];
  loadSurface: (step: string, x: string, y: string) => Promise<GridSurface | null>;
  /** The method changed since the run. */
  previousMethod?: boolean;
}

const isDarkMode = () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

function axisType(grid: OverviewGrid, param: string): 'log' | 'linear' {
  return grid.axes.find(a => a.param === param)?.fn === 'log' ? 'log' : 'linear';
}

export const GridLandscape: React.FC<GridLandscapeProps> = ({ stepName, grid, axes, loadSurface, previousMethod }) => {
  const pairs = grid.pairs;
  const [pairIdx, setPairIdx] = useState(0);
  const pair = pairs[Math.min(pairIdx, pairs.length - 1)];
  const [surface, setSurface] = useState<{ key: string; data: GridSurface | null }>({ key: '', data: null });
  const pairKey = pair ? `${stepName}|${pair[0]}|${pair[1]}` : '';

  useEffect(() => {
    if (!pair) return;
    let cancelled = false;
    loadSurface(stepName, pair[0], pair[1]).then(data => {
      if (!cancelled) setSurface({ key: pairKey, data });
    });
    return () => {
      cancelled = true;
    };
  }, [stepName, pair, pairKey, loadSurface]);

  const dark = isDarkMode();
  const ink = dark ? '#cdd6f4' : '#334155';
  const gridLine = dark ? '#45475a' : '#e2e8f0';
  const current = (param: string) => axes.find(a => a.param.toUpperCase() === param.toUpperCase());

  const plot = useMemo(() => {
    const baseLayout = {
      autosize: true,
      height: 300,
      margin: { l: 70, r: 20, b: 50, t: 10 },
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      font: { family: 'Inter, sans-serif', size: 12, color: ink },
      showlegend: false,
    };
    if (pair && surface.key === pairKey && surface.data) {
      const s = surface.data;
      const cx = current(s.x_param);
      const cy = current(s.y_param);
      const shapes =
        cx && cy && cx.fn !== 'values' && cy.fn !== 'values'
          ? [
              {
                type: 'rect',
                xref: 'x',
                yref: 'y',
                x0: cx.low,
                x1: cx.high,
                y0: cy.low,
                y1: cy.high,
                line: { color: dark ? '#f9e2af' : '#b45309', width: 2, dash: 'dash' },
                fillcolor: 'rgba(0,0,0,0)',
              },
            ]
          : [];
      const data: unknown[] = [
        {
          type: 'heatmap',
          x: s.x,
          y: s.y,
          z: s.z_delta,
          colorscale: 'Viridis',
          colorbar: { title: { text: 'Δχ²' }, len: 0.9, tickfont: { color: ink } },
          hovertemplate: `${s.x_param}: %{x:.4g}<br>${s.y_param}: %{y:.4g}<br>Δχ²: %{z:.2f}<extra></extra>`,
        },
      ];
      if (s.min_point.x !== null && s.min_point.y !== null) {
        data.push({
          type: 'scatter',
          mode: 'markers',
          x: [s.min_point.x],
          y: [s.min_point.y],
          marker: { symbol: 'star', size: 16, color: '#ef4444', line: { color: '#ffffff', width: 1.5 } },
          hovertemplate: `Committed minimum<br>${s.x_param}: %{x:.4g}<br>${s.y_param}: %{y:.4g}<extra></extra>`,
        });
      }
      return {
        data,
        layout: {
          ...baseLayout,
          shapes,
          xaxis: { title: { text: s.x_param }, type: axisType(grid, s.x_param), gridcolor: gridLine, zeroline: false },
          yaxis: { title: { text: s.y_param }, type: axisType(grid, s.y_param), gridcolor: gridLine, zeroline: false },
        },
      };
    }
    if (!pair && grid.axes.length === 1) {
      const a = grid.axes[0];
      const prof = grid.profiles_1d[a.param];
      if (!prof) return null;
      const minChi = Math.min(...prof.chisqr);
      const cur = current(a.param);
      const shapes =
        cur && cur.fn !== 'values'
          ? [cur.low, cur.high].map(x => ({ type: 'line', xref: 'x', yref: 'paper', x0: x, x1: x, y0: 0, y1: 1, line: { color: dark ? '#f9e2af' : '#b45309', width: 2, dash: 'dash' } }))
          : [];
      return {
        data: [
          { type: 'scatter', mode: 'lines+markers', x: prof.x, y: prof.chisqr.map(c => c - minChi), line: { color: '#6366f1' }, hovertemplate: `${a.param}: %{x:.4g}<br>Δχ²: %{y:.2f}<extra></extra>` },
          ...(a.best !== null
            ? [{ type: 'scatter', mode: 'markers', x: [a.best], y: [0], marker: { symbol: 'star', size: 14, color: '#ef4444' }, hovertemplate: 'Committed minimum<extra></extra>' }]
            : []),
        ],
        layout: {
          ...baseLayout,
          shapes,
          xaxis: { title: { text: a.param }, type: axisType(grid, a.param), gridcolor: gridLine, zeroline: false },
          yaxis: { title: { text: 'Δχ²' }, gridcolor: gridLine, zeroline: false },
        },
      };
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface, pairKey, pair, grid, axes, dark, ink, gridLine]);

  return (
    <section aria-label="Last run χ² landscape" className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
        <span className="font-bold">Last run χ² landscape · {stepName}</span>
        {grid.chisqr !== null && <span className="font-mono">χ²min {fmtValue(grid.chisqr)}</span>}
        {previousMethod && <span className="text-slate-600 dark:text-slate-400">(previous method)</span>}
        {pairs.length > 1 && (
          <label className="ml-auto flex items-center gap-1">
            Pair
            <select
              aria-label="Axis pair"
              value={pairIdx}
              onChange={e => setPairIdx(Number(e.target.value))}
              className="text-xs rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-1.5 py-0.5"
            >
              {pairs.map((p, i) => (
                <option key={`${p[0]}-${p[1]}`} value={i}>
                  {p[0]} × {p[1]}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {plot ? (
        <Plot data={plot.data as never[]} layout={plot.layout} config={{ displayModeBar: false, responsive: true }} useResizeHandler style={{ width: '100%' }} />
      ) : (
        <p className="text-xs text-slate-600 dark:text-slate-400">{pair ? 'Loading surface…' : 'No χ² profile stored for this step.'}</p>
      )}
      <p className="text-xs text-slate-600 dark:text-slate-400">
        <span className="text-red-600 dark:text-red-500">★</span> committed minimum
        {grid.axes.map(a => (a.best !== null ? ` · ${a.param} = ${fmtValue(a.best)}` : '')).join('')} ·{' '}
        <span className="text-amber-800 dark:text-amber-700">dashed</span>: ranges configured now
      </p>
    </section>
  );
};

export default GridLandscape;
