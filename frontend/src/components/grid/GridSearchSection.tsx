import React, { useState, useEffect, useMemo } from 'react';
import {
  Grid as GridIcon,
  ChevronDown,
  ChevronUp,
  FileText,
  Download,
  Target,
  Sparkles,
  Activity,
  AlertTriangle,
} from 'lucide-react';
import api from '../../services/api';
import Plot from '../Plot';
import { useTheme } from '../../context/ThemeContext';

interface GridGroupInfo {
  raw_key: string;
  residue: string;
  display_name: string;
  file_path?: string;
}

interface GridMeta {
  analysis_uuid: string;
  step_name: string;
  has_grid: boolean;
  parameters: string[];
  specs: Record<string, any>;
  groups: GridGroupInfo[];
  has_1d_pdf: boolean;
  has_2d_pdf: boolean;
  min_point?: {
    chisqr: number;
    coordinates: Record<string, number>;
  } | null;
  fitted_point?: Record<string, number> | null;
}

interface Surface2DData {
  x_param: string;
  y_param: string;
  x: number[];
  y: number[];
  z_chisqr: number[][];
  z_delta: number[][];
  min_point: { x: number; y: number; chisqr: number };
  fitted_point?: { x: number | null; y: number | null };
  group?: string;
  available_parameters: string[];
}

interface Profile1D {
  parameter: string;
  x: number[];
  chisqr: number[];
  delta_chisqr: number[];
  min_x?: number;
  min_val?: number;
  min_chisqr: number;
  fitted_val?: number | null;
}

interface Profiles1DData {
  step_name: string;
  group?: string;
  parameters: string[];
  profiles: Profile1D[];
  min_point?: {
    chisqr: number;
    coordinates: Record<string, number>;
  } | null;
}

interface GridSearchSectionProps {
  projectUuid: string;
  analysisUuid: string;
  stepName: string;
  onApplyStartingParameters?: (params: Record<string, number>) => void;
}

const formatParamDisplayName = (p: string) => {
  if (!p) return '';
  if (p.includes('NUC->')) {
    const [base, nuc] = p.split('NUC->');
    const cleanBase = base.replace(/[\[\],]/g, '').trim();
    const cleanNuc = nuc.replace(/[\[\]]/g, '').trim();
    return `${cleanBase} (${cleanNuc})`;
  }
  return p.replace(/[\[\]]/g, '').trim();
};

export const GridSearchSection: React.FC<GridSearchSectionProps> = ({
  projectUuid,
  analysisUuid,
  stepName,
  onApplyStartingParameters,
}) => {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const effectiveStep = stepName || 'STEP1';

  const [isExpanded, setIsExpanded] = useState<boolean>(true);
  const [loadingMeta, setLoadingMeta] = useState<boolean>(true);
  const [meta, setMeta] = useState<GridMeta | null>(null);

  // Group selection (empty string = All Groups combined)
  const [selectedGroup, setSelectedGroup] = useState<string>('');

  // 2D Parameter pair selection
  const [xParam, setXParam] = useState<string>('');
  const [yParam, setYParam] = useState<string>('');
  const [plotType, setPlotType] = useState<'contour' | 'heatmap'>('contour');

  // Surface & Profiles state
  const [surfaceData, setSurfaceData] = useState<Surface2DData | null>(null);
  const [profilesData, setProfilesData] = useState<Profiles1DData | null>(null);
  const [loadingPlots, setLoadingPlots] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // PDF Preview Tab
  const [activePdfTab, setActivePdfTab] = useState<'none' | '1d' | '2d'>('none');

  // Compute available parameters from surface, profile, or meta
  const availableParams = useMemo(() => {
    if (surfaceData?.available_parameters && surfaceData.available_parameters.length > 0) {
      return surfaceData.available_parameters;
    }
    if (profilesData?.parameters && profilesData.parameters.length > 0) {
      return profilesData.parameters;
    }
    return meta?.parameters || [];
  }, [surfaceData, profilesData, meta]);

  // Keep xParam and yParam valid when availableParams change
  useEffect(() => {
    if (availableParams.length >= 2) {
      const defaultX = availableParams.includes('KEX_AB') ? 'KEX_AB' : availableParams[0];
      const defaultY = availableParams.includes('PB') && defaultX !== 'PB'
        ? 'PB'
        : (availableParams.find(p => p !== defaultX) || availableParams[1]);

      if (!xParam || !availableParams.includes(xParam)) {
        setXParam(defaultX);
      }
      if (!yParam || !availableParams.includes(yParam) || yParam === (xParam || defaultX)) {
        const nextY = (xParam && availableParams.includes('PB') && xParam !== 'PB')
          ? 'PB'
          : (availableParams.find(p => p !== (xParam || defaultX)) || defaultY);
        setYParam(nextY);
      }
    } else if (availableParams.length === 1) {
      setXParam(availableParams[0]);
      setYParam('');
    }
  }, [availableParams, xParam, yParam]);

  // 1. Fetch Step Grid Meta
  useEffect(() => {
    let isMounted = true;
    setLoadingMeta(true);
    setErrorMsg(null);

    api.get(`/api/projects/${projectUuid}/analysis/${analysisUuid}/steps/${effectiveStep}/grid`)
      .then((res) => {
        if (!isMounted) return;
        const data: GridMeta = res.data;
        setMeta(data);
        if (data.parameters && data.parameters.length >= 2) {
          const initX = data.parameters.includes('KEX_AB') ? 'KEX_AB' : data.parameters[0];
          const initY = data.parameters.includes('PB') && initX !== 'PB'
            ? 'PB'
            : (data.parameters.find(p => p !== initX) || data.parameters[1]);
          setXParam(initX);
          setYParam(initY);
        } else if (data.parameters && data.parameters.length === 1) {
          setXParam(data.parameters[0]);
        }
      })
      .catch((err) => {
        if (!isMounted) return;
        console.error('Failed to fetch grid metadata:', err);
        setErrorMsg('Failed to load grid search information.');
      })
      .finally(() => {
        if (isMounted) setLoadingMeta(false);
      });

    return () => {
      isMounted = false;
    };
  }, [projectUuid, analysisUuid, effectiveStep]);

  // 2. Fetch 2D Surface and 1D Profiles when selection changes
  useEffect(() => {
    if (!meta || !meta.has_grid) return;
    let isMounted = true;
    setLoadingPlots(true);

    const groupQuery = selectedGroup ? `&group=${encodeURIComponent(selectedGroup)}` : '';
    const groupParamQuery = selectedGroup ? `?group=${encodeURIComponent(selectedGroup)}` : '';

    const fetch2D = (xParam && yParam && xParam !== yParam)
      ? api.get(
          `/api/projects/${projectUuid}/analysis/${analysisUuid}/steps/${effectiveStep}/grid/2d?x=${encodeURIComponent(
            xParam
          )}&y=${encodeURIComponent(yParam)}${groupQuery}`
        ).then(r => r.data)
      : Promise.resolve(null);

    const fetch1D = api.get(
      `/api/projects/${projectUuid}/analysis/${analysisUuid}/steps/${effectiveStep}/grid/1d${groupParamQuery}`
    ).then(r => r.data);

    Promise.all([fetch2D, fetch1D])
      .then(([sData, pData]) => {
        if (!isMounted) return;
        setSurfaceData(sData);
        setProfilesData(pData);
      })
      .catch((err) => {
        if (!isMounted) return;
        console.error('Error fetching grid search plots:', err);
      })
      .finally(() => {
        if (isMounted) setLoadingPlots(false);
      });

    return () => {
      isMounted = false;
    };
  }, [projectUuid, analysisUuid, effectiveStep, meta?.has_grid, selectedGroup, xParam, yParam]);

  // 2D Contour / Heatmap Plotly Traces
  const surfaceTraces = useMemo(() => {
    if (!surfaceData || !surfaceData.x || !surfaceData.y || !surfaceData.z_delta) return [];

    const traces: any[] = [];

    // Main 2D contour or heatmap of Delta Chi-square
    if (plotType === 'contour') {
      traces.push({
        type: 'contour',
        x: surfaceData.x,
        y: surfaceData.y,
        z: surfaceData.z_delta,
        colorscale: 'Viridis',
        reversescale: false,
        autocontour: true,
        ncontours: 25,
        colorbar: {
          title: { text: 'Δχ²', font: { size: 12, color: isDark ? '#e2e8f0' : '#1e293b' } },
          tickfont: { size: 10, color: isDark ? '#94a3b8' : '#64748b' },
          len: 0.85,
        },
        hovertemplate: `${surfaceData.x_param}: %{x:.4g}<br>${surfaceData.y_param}: %{y:.4g}<br>Δχ²: %{z:.2f}<extra></extra>`,
      });
    } else {
      traces.push({
        type: 'heatmap',
        x: surfaceData.x,
        y: surfaceData.y,
        z: surfaceData.z_delta,
        colorscale: 'Viridis',
        colorbar: {
          title: { text: 'Δχ²', font: { size: 12, color: isDark ? '#e2e8f0' : '#1e293b' } },
          tickfont: { size: 10, color: isDark ? '#94a3b8' : '#64748b' },
          len: 0.85,
        },
        hovertemplate: `${surfaceData.x_param}: %{x:.4g}<br>${surfaceData.y_param}: %{y:.4g}<br>Δχ²: %{z:.2f}<extra></extra>`,
      });
    }

    // Grid Minimum point (Red Star)
    if (surfaceData.min_point && surfaceData.min_point.x != null && surfaceData.min_point.y != null) {
      traces.push({
        type: 'scatter',
        mode: 'markers+text',
        name: 'Grid Minimum (★)',
        x: [surfaceData.min_point.x],
        y: [surfaceData.min_point.y],
        text: ['Grid Min'],
        textposition: 'top right',
        textfont: { size: 11, color: '#ef4444', family: 'Inter, sans-serif' },
        marker: {
          symbol: 'star',
          size: 16,
          color: '#ef4444',
          line: { color: '#ffffff', width: 1.5 },
        },
        hovertemplate: `<b>Grid Minimum</b><br>${surfaceData.x_param}: %{x:.4g}<br>${surfaceData.y_param}: %{y:.4g}<br>χ²: ${surfaceData.min_point.chisqr?.toFixed(2)}<extra></extra>`,
      });
    }

    // Fitted Point (Emerald Diamond)
    if (surfaceData.fitted_point && surfaceData.fitted_point.x != null && surfaceData.fitted_point.y != null) {
      traces.push({
        type: 'scatter',
        mode: 'markers+text',
        name: 'Fitted (◆)',
        x: [surfaceData.fitted_point.x],
        y: [surfaceData.fitted_point.y],
        text: ['Fitted'],
        textposition: 'bottom right',
        textfont: { size: 11, color: '#10b981', family: 'Inter, sans-serif' },
        marker: {
          symbol: 'diamond',
          size: 14,
          color: '#10b981',
          line: { color: '#ffffff', width: 1.5 },
        },
        hovertemplate: `<b>Fitted Parameter</b><br>${surfaceData.x_param}: %{x:.4g}<br>${surfaceData.y_param}: %{y:.4g}<extra></extra>`,
      });
    }

    return traces;
  }, [surfaceData, plotType, isDark]);

  const surfaceLayout = useMemo(() => {
    return {
      autosize: true,
      height: 380,
      margin: { l: 65, r: 30, b: 50, t: 30 },
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      font: {
        family: 'Inter, sans-serif',
        size: 11,
        color: isDark ? '#e2e8f0' : '#334155',
      },
      xaxis: {
        title: { text: surfaceData?.x_param || 'X', font: { size: 12, weight: 600 } },
        gridcolor: isDark ? '#334155' : '#f1f5f9',
        zeroline: false,
        tickfont: { size: 10 },
      },
      yaxis: {
        title: { text: surfaceData?.y_param || 'Y', font: { size: 12, weight: 600 } },
        gridcolor: isDark ? '#334155' : '#f1f5f9',
        zeroline: false,
        tickfont: { size: 10 },
      },
      showlegend: true,
      legend: {
        orientation: 'h',
        yanchor: 'bottom',
        y: 1.02,
        xanchor: 'right',
        x: 1,
        font: { size: 10 },
      },
    };
  }, [surfaceData, isDark]);

  if (loadingMeta) {
    return (
      <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 animate-pulse text-xs text-slate-400">
        Loading Grid Search information...
      </div>
    );
  }

  if (!meta || !meta.has_grid) {
    return null;
  }

  const minCoords = profilesData?.min_point?.coordinates || meta?.min_point?.coordinates;
  const activeMinChi2 = profilesData?.min_point?.chisqr ?? surfaceData?.min_point?.chisqr ?? meta?.min_point?.chisqr;

  return (
    <div className="rounded-2xl border border-blue-200 dark:border-blue-900/40 bg-gradient-to-b from-white via-blue-50/20 to-white dark:from-slate-900 dark:via-slate-900/90 dark:to-slate-900 shadow-sm overflow-hidden transition-all">
      {/* Header Bar */}
      <div className="p-4 border-b border-blue-100 dark:border-blue-950/60 bg-blue-50/50 dark:bg-blue-950/20 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-blue-600 dark:bg-blue-500 flex items-center justify-center text-white shadow-xs">
            <GridIcon className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-bold text-slate-900 dark:text-white">
                Grid Search Analysis
              </h4>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
                grid ✓
              </span>
              <span className="text-xs text-slate-500 dark:text-slate-400 font-mono">
                [{stepName}]
              </span>
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Parameter space exploration & profile likelihood minimization
            </p>
          </div>
        </div>

        {/* Action Buttons & Expand Toggle */}
        <div className="flex items-center gap-2">
          {/* Use Grid Minimum as Starting Parameter Button */}
          {minCoords && onApplyStartingParameters && (
            <button
              type="button"
              onClick={() => onApplyStartingParameters(minCoords)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white text-xs font-bold rounded-lg shadow-xs shadow-amber-500/20 transition-all cursor-pointer"
              title="Copy grid minimum parameter coordinates to Starting Parameters in config"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>Use grid minimum as starting</span>
            </button>
          )}

          {/* Raw PDF Download Links */}
          {meta.has_1d_pdf && (
            <a
              href={`/api/projects/${projectUuid}/analysis/${analysisUuid}/steps/${effectiveStep}/grid/plots/grid_1d.pdf`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 px-2.5 py-1.5 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 transition-all"
              title="Download raw ChemEx 1D grid PDF"
            >
              <Download className="w-3 h-3 text-blue-500" />
              <span>1D PDF</span>
            </a>
          )}
          {meta.has_2d_pdf && (
            <a
              href={`/api/projects/${projectUuid}/analysis/${analysisUuid}/steps/${effectiveStep}/grid/plots/grid_2d.pdf`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 px-2.5 py-1.5 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 transition-all"
              title="Download raw ChemEx 2D grid PDF"
            >
              <Download className="w-3 h-3 text-blue-500" />
              <span>2D PDF</span>
            </a>
          )}

          {/* Expand/Collapse Button */}
          <button
            type="button"
            onClick={() => setIsExpanded(prev => !prev)}
            className="p-1.5 rounded-lg bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 transition-all"
            title={isExpanded ? 'Collapse section' : 'Expand section'}
          >
            {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {isExpanded && (
        <div className="p-4 space-y-4">
          {errorMsg && (
            <div className="p-3 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 rounded-xl text-xs text-red-700 dark:text-red-300 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-red-500 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Controls Bar: Group Selector, Parameter Selectors, Mode Toggle */}
          <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-xl bg-slate-50/80 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700/60">
            <div className="flex flex-wrap items-center gap-3">
              {/* Group Selector */}
              {meta.groups && meta.groups.length > 0 && (
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                    Group:
                  </span>
                  <select
                    value={selectedGroup}
                    onChange={(e) => setSelectedGroup(e.target.value)}
                    className="text-xs font-semibold bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 px-2.5 py-1 rounded-lg border border-slate-300 dark:border-slate-600 focus:ring-1 focus:ring-blue-500 cursor-pointer shadow-2xs"
                  >
                    <option value="">All Groups (Combined)</option>
                    {meta.groups.map(g => (
                      <option key={g.raw_key} value={g.raw_key}>
                        {g.display_name !== g.raw_key ? `${g.display_name} (${g.raw_key})` : g.display_name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* 2D Parameter Pair Selection (if >= 2 params) */}
              {availableParams.length >= 2 && (
                <div className="flex items-center gap-2 border-l border-slate-200 dark:border-slate-700 pl-3">
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase">X:</span>
                    <select
                      value={xParam}
                      onChange={(e) => setXParam(e.target.value)}
                      className="text-xs font-semibold bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 px-2 py-0.5 rounded border border-slate-300 dark:border-slate-600 cursor-pointer"
                    >
                      {availableParams.map(p => (
                        <option key={p} value={p}>{formatParamDisplayName(p)}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase">Y:</span>
                    <select
                      value={yParam}
                      onChange={(e) => setYParam(e.target.value)}
                      className="text-xs font-semibold bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 px-2 py-0.5 rounded border border-slate-300 dark:border-slate-600 cursor-pointer"
                    >
                      {availableParams.map(p => (
                        <option key={p} value={p}>{formatParamDisplayName(p)}</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
            </div>

            {/* Plot Type & PDF Tabs */}
            <div className="flex items-center gap-2">
              {meta.parameters && meta.parameters.length >= 2 && (
                <div className="flex items-center bg-slate-200 dark:bg-slate-700 p-0.5 rounded-lg">
                  <button
                    type="button"
                    onClick={() => setPlotType('contour')}
                    className={`px-2 py-0.5 rounded text-[10px] font-bold transition-all ${
                      plotType === 'contour'
                        ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-2xs'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
                    }`}
                  >
                    Contour
                  </button>
                  <button
                    type="button"
                    onClick={() => setPlotType('heatmap')}
                    className={`px-2 py-0.5 rounded text-[10px] font-bold transition-all ${
                      plotType === 'heatmap'
                        ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-2xs'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
                    }`}
                  >
                    Heatmap
                  </button>
                </div>
              )}

              {(meta.has_1d_pdf || meta.has_2d_pdf) && (
                <div className="flex items-center bg-slate-200 dark:bg-slate-700 p-0.5 rounded-lg">
                  <button
                    type="button"
                    onClick={() => setActivePdfTab(prev => prev === '1d' ? 'none' : '1d')}
                    className={`px-2 py-0.5 rounded text-[10px] font-bold flex items-center gap-1 transition-all ${
                      activePdfTab === '1d'
                        ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-2xs'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
                    }`}
                  >
                    <FileText className="w-3 h-3" />
                    <span>View 1D PDF</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setActivePdfTab(prev => prev === '2d' ? 'none' : '2d')}
                    className={`px-2 py-0.5 rounded text-[10px] font-bold flex items-center gap-1 transition-all ${
                      activePdfTab === '2d'
                        ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-2xs'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
                    }`}
                  >
                    <FileText className="w-3 h-3" />
                    <span>View 2D PDF</span>
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Embedded PDF Viewer Panel (if opened) */}
          {activePdfTab !== 'none' && (
            <div className="p-3 bg-slate-900 rounded-xl border border-slate-700 space-y-2">
              <div className="flex items-center justify-between text-xs text-slate-300">
                <span className="font-bold">
                  PDF Preview: {activePdfTab === '1d' ? 'grid_1d.pdf' : 'grid_2d.pdf'}
                </span>
                <button
                  type="button"
                  onClick={() => setActivePdfTab('none')}
                  className="text-slate-400 hover:text-white text-xs font-bold"
                >
                  Close Preview ✕
                </button>
              </div>
              <iframe
                src={`/api/projects/${projectUuid}/analysis/${analysisUuid}/steps/${effectiveStep}/grid/plots/${activePdfTab === '1d' ? 'grid_1d.pdf' : 'grid_2d.pdf'}`}
                className="w-full h-96 rounded-lg bg-white border border-slate-800"
                title="Grid PDF Preview"
              />
            </div>
          )}

          {/* Main Interactive Plots Layout */}
          {loadingPlots ? (
            <div className="h-64 flex items-center justify-center text-xs text-slate-400">
              <Activity className="w-4 h-4 mr-2 animate-spin text-blue-500" />
              Computing profile likelihood surfaces and 1D projections...
            </div>
          ) : (
            <div className="space-y-4">
              {/* Top Row: 2D Surface (if >= 2 parameters) and Key Metrics Card */}
              {meta.parameters && meta.parameters.length >= 2 && surfaceData && (
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                  {/* 2D Surface Plot (8 cols) */}
                  <div className="lg:col-span-8 p-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs">
                    <div className="flex items-center justify-between mb-2">
                      <h5 className="text-xs font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                        <span>2D Grid Surface (Δχ²)</span>
                        <span className="text-[10px] text-slate-400 font-normal">
                          {surfaceData.x_param} vs {surfaceData.y_param}
                        </span>
                      </h5>
                      <span className="text-[10px] text-slate-400">
                        Z = χ²(x, y) - χ²_min
                      </span>
                    </div>
                    <Plot
                      data={surfaceTraces}
                      layout={surfaceLayout}
                      useResizeHandler
                      style={{ width: '100%', height: '380px' }}
                      config={{ responsive: true, displayModeBar: true, displaylogo: false }}
                    />
                  </div>

                  {/* Grid Minimum & Optimization Summary Card (4 cols) */}
                  <div className="lg:col-span-4 p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs flex flex-col justify-between space-y-3">
                    <div>
                      <div className="flex items-center gap-1.5 text-xs font-bold text-slate-800 dark:text-slate-200 mb-3">
                        <Target className="w-4 h-4 text-red-500" />
                        <span>Grid Optimal Coordinates</span>
                      </div>

                      {/* Coordinates Table */}
                      <div className="space-y-2 border border-slate-100 dark:border-slate-800 rounded-lg p-2.5 bg-slate-50/50 dark:bg-slate-950/50">
                        {minCoords && Object.entries(minCoords).map(([pname, pval]) => {
                          const baseName = pname.split(',')[0].trim();
                          const fittedVal = meta.fitted_point?.[pname] ?? meta.fitted_point?.[baseName] ?? (
                            surfaceData?.fitted_point?.x != null && surfaceData.x_param === pname ? surfaceData.fitted_point.x :
                            surfaceData?.fitted_point?.y != null && surfaceData.y_param === pname ? surfaceData.fitted_point.y : undefined
                          );
                          return (
                            <div key={pname} className="flex items-center justify-between text-xs font-mono py-0.5 border-b border-slate-100 dark:border-slate-800/60 last:border-0">
                              <span className="text-slate-600 dark:text-slate-400 font-bold">{formatParamDisplayName(pname)}:</span>
                              <div className="text-right">
                                <span className="text-red-600 dark:text-red-400 font-extrabold">{pval.toFixed(4)}</span>
                                {fittedVal != null && (
                                  <span className="text-[10px] text-slate-400 ml-1.5 font-normal">
                                    (fit: {fittedVal.toFixed(4)})
                                  </span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                        {activeMinChi2 != null && (
                          <div className="flex items-center justify-between text-xs font-mono pt-1">
                            <span className="text-slate-500 dark:text-slate-400 font-semibold">Min χ²:</span>
                            <span className="text-slate-900 dark:text-white font-extrabold">
                              {activeMinChi2.toFixed(2)}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Method Grid Specs */}
                    {meta.specs && Object.keys(meta.specs).length > 0 && (
                      <div className="space-y-1.5">
                        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                          Sampling Specs
                        </span>
                        <div className="text-[11px] font-mono space-y-1 text-slate-600 dark:text-slate-400">
                          {Object.entries(meta.specs).map(([spk, spv]: [string, any]) => (
                            <div key={spk} className="flex items-center justify-between bg-slate-100/70 dark:bg-slate-800/60 px-2 py-0.5 rounded">
                              <span className="font-bold text-slate-700 dark:text-slate-300">{spk}:</span>
                              <span>{spv.scale}({spv.min_val}, {spv.max_val}, N={spv.num_points})</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Quick Button inside card */}
                    {minCoords && onApplyStartingParameters && (
                      <button
                        type="button"
                        onClick={() => onApplyStartingParameters(minCoords)}
                        className="w-full py-2 bg-blue-50 hover:bg-blue-100 dark:bg-blue-950/50 dark:hover:bg-blue-900/50 text-blue-700 dark:text-blue-300 text-xs font-bold rounded-lg border border-blue-200 dark:border-blue-800 transition-all flex items-center justify-center gap-1.5"
                      >
                        <Sparkles className="w-3.5 h-3.5" />
                        <span>Use As Starting Values</span>
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Bottom Row: 1D Profile Likelihood Curves */}
              {profilesData && profilesData.profiles && profilesData.profiles.length > 0 && (
                <div className="p-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs space-y-2">
                  <div className="flex items-center justify-between">
                    <h5 className="text-xs font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                      <Activity className="w-3.5 h-3.5 text-blue-500" />
                      <span>1D Profile Likelihood (Minimized Over Other Parameters)</span>
                    </h5>
                    <span className="text-[10px] text-slate-400 font-mono">
                      χ²_prof(P) = min_(other) χ²
                    </span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                    {profilesData.profiles.map((prof) => {
                      const trace: any[] = [
                        {
                          type: 'scatter',
                          mode: 'lines+markers',
                          name: 'Profile Δχ²',
                          x: prof.x,
                          y: prof.delta_chisqr,
                          line: { color: '#3b82f6', width: 2 },
                          marker: { size: 4, color: '#2563eb' },
                          hovertemplate: `${formatParamDisplayName(prof.parameter)}: %{x:.4g}<br>Δχ²: %{y:.2f}<extra></extra>`,
                        },
                      ];

                      // Marker for grid min
                      const minCoord = prof.min_x ?? prof.min_val;
                      if (minCoord != null) {
                        trace.push({
                          type: 'scatter',
                          mode: 'markers',
                          name: 'Min',
                          x: [minCoord],
                          y: [0],
                          marker: { symbol: 'star', size: 12, color: '#ef4444' },
                          hovertemplate: `<b>Grid Min</b><br>${formatParamDisplayName(prof.parameter)}: ${minCoord.toFixed(4)}<extra></extra>`,
                        });
                      }

                      // Marker for fitted value if available
                      if (prof.fitted_val != null) {
                        trace.push({
                          type: 'scatter',
                          mode: 'markers',
                          name: 'Fitted',
                          x: [prof.fitted_val],
                          y: [0],
                          marker: { symbol: 'diamond', size: 10, color: '#10b981' },
                          hovertemplate: `<b>Fitted Value</b><br>${formatParamDisplayName(prof.parameter)}: ${prof.fitted_val.toFixed(4)}<extra></extra>`,
                        });
                      }

                      const layout = {
                        autosize: true,
                        height: 200,
                        margin: { l: 45, r: 15, b: 35, t: 25 },
                        paper_bgcolor: 'rgba(0,0,0,0)',
                        plot_bgcolor: 'rgba(0,0,0,0)',
                        title: {
                          text: `Profile: ${formatParamDisplayName(prof.parameter)}`,
                          font: { size: 11, color: isDark ? '#e2e8f0' : '#334155', weight: 600 },
                        },
                        font: { size: 10, color: isDark ? '#cbd5e1' : '#475569' },
                        xaxis: {
                          gridcolor: isDark ? '#334155' : '#f1f5f9',
                          zeroline: false,
                          tickfont: { size: 9 },
                        },
                        yaxis: {
                          title: { text: 'Δχ²', font: { size: 10 } },
                          gridcolor: isDark ? '#334155' : '#f1f5f9',
                          zeroline: false,
                          tickfont: { size: 9 },
                        },
                        showlegend: false,
                      };

                      return (
                        <div key={prof.parameter} className="border border-slate-100 dark:border-slate-800 rounded-lg p-2 bg-slate-50/40 dark:bg-slate-950/40">
                          <Plot
                            data={trace}
                            layout={layout}
                            useResizeHandler
                            style={{ width: '100%', height: '200px' }}
                            config={{ responsive: true, displayModeBar: false }}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
