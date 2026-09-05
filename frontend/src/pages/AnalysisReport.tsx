import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../services/api';
import {
  ArrowLeft,
  Download,
  FileText,
  Printer,
  Code,
  AlertCircle,
  Loader2,
  Copy,
  Check,
  Palette,
  FolderArchive,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';

interface PaletteOption {
  id: string;
  name: string;
  description: string;
  primary: string;
  colors: string[];
}

const DEFAULT_PALETTES: PaletteOption[] = [
  {
    id: 'okabe_ito',
    name: 'Colorblind-Safe',
    description: 'Accessible colorblind-safe palette (Nature Methods standard)',
    primary: '#0072B2',
    colors: ['#0072B2', '#D55E00', '#009E73', '#E69F00', '#56B4E9', '#CC79A7', '#F0E442', '#000000'],
  },
  {
    id: 'classic_blue',
    name: 'Classic Navy',
    description: 'Traditional royal and navy blues with contrasting accents',
    primary: '#1E40AF',
    colors: ['#1E40AF', '#0284C7', '#0D9488', '#4F46E5', '#D97706', '#DC2626', '#64748B', '#1E293B'],
  },
  {
    id: 'emerald_green',
    name: 'Emerald Green',
    description: 'Botanical viridian and forest greens',
    primary: '#047857',
    colors: ['#047857', '#059669', '#0D9488', '#10B981', '#D97706', '#DC2626', '#475569', '#1E293B'],
  },
  {
    id: 'crimson_rose',
    name: 'Crimson Rose',
    description: 'Deep crimson, ruby red, and warm accents',
    primary: '#BE123C',
    colors: ['#BE123C', '#E11D48', '#EA580C', '#7C3AED', '#4338CA', '#059669', '#475569', '#1E293B'],
  },
  {
    id: 'amber_sunset',
    name: 'Amber Sunset',
    description: 'Warm sunset amber, burnt orange, and violet accents',
    primary: '#C2410C',
    colors: ['#C2410C', '#D97706', '#F59E0B', '#7C3AED', '#2563EB', '#059669', '#4B5563', '#1F2937'],
  },
  {
    id: 'deep_violet',
    name: 'Deep Violet',
    description: 'Rich violet, purple, and royal blue accents',
    primary: '#6D28D9',
    colors: ['#6D28D9', '#7C3AED', '#2563EB', '#059669', '#D97706', '#DC2626', '#475569', '#1E293B'],
  },
  {
    id: 'monochrome',
    name: 'Charcoal Monochrome',
    description: 'High-contrast slate and grayscale tones',
    primary: '#18181B',
    colors: ['#18181B', '#3F3F46', '#71717A', '#A1A1AA', '#27272A', '#52525B', '#09090B', '#52525B'],
  },
];

const AnalysisReport: React.FC = () => {
  const { projectUuid, analysisUuid } = useParams<{ projectUuid: string; analysisUuid: string }>();
  const navigate = useNavigate();
  useAuth();

  const [analysis, setAnalysis] = useState<any>(null);
  const [htmlContent, setHtmlContent] = useState<string>('');
  const [jsonContent, setJsonContent] = useState<any>(null);
  const [activeView, setActiveView] = useState<'html' | 'json'>('html');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string>('');

  // Palette selection states
  const [selectedPalette, setSelectedPalette] = useState<string>('okabe_ito');
  const [palettes, setPalettes] = useState<PaletteOption[]>(DEFAULT_PALETTES);
  const [showPaletteMenu, setShowPaletteMenu] = useState(false);
  const [customColor, setCustomColor] = useState('#0072B2');
  const [isReloadingReport, setIsReloadingReport] = useState(false);

  // Async PDF generation states
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [exportMessage, setExportMessage] = useState<string>('');
  const [copiedJson, setCopiedJson] = useState(false);

  // Async Plots export states
  const [isExportingPlots, setIsExportingPlots] = useState(false);
  const [exportPlotsMessage, setExportPlotsMessage] = useState<string>('');

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const paletteMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchReportData();
  }, [projectUuid, analysisUuid]);

  // Fetch palette metadata options
  useEffect(() => {
    if (projectUuid) {
      api
        .get(`/api/projects/${projectUuid}/analysis/report/palettes`)
        .then((res) => {
          if (Array.isArray(res.data) && res.data.length > 0) {
            setPalettes(res.data);
          }
        })
        .catch(() => {
          // Keep DEFAULT_PALETTES fallback on network/server error
        });
    }
  }, [projectUuid]);

  // Close palette dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (paletteMenuRef.current && !paletteMenuRef.current.contains(event.target as Node)) {
        setShowPaletteMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const fetchReportData = async () => {
    try {
      setIsLoading(true);
      setError('');

      // 1. Fetch analysis metadata
      const projRes = await api.get(`/api/projects/${projectUuid}`);
      const a = projRes.data.analyses?.find((x: any) => x.analysis_uuid === analysisUuid);
      if (!a) {
        setError('Analysis not found in this project');
        setIsLoading(false);
        return;
      }
      setAnalysis(a);

      // 2. Fetch HTML report content with default palette
      const htmlRes = await api.get(
        `/api/projects/${projectUuid}/analysis/${analysisUuid}/report.html?style=screen&palette=${encodeURIComponent(selectedPalette)}`,
        { responseType: 'text' }
      );
      setHtmlContent(htmlRes.data);

      // 3. Fetch JSON report model
      try {
        const jsonRes = await api.get(
          `/api/projects/${projectUuid}/analysis/${analysisUuid}/report.json`
        );
        setJsonContent(jsonRes.data);
      } catch (jErr) {
        console.warn('Could not fetch report.json:', jErr);
      }
    } catch (err: any) {
      console.error('Failed to load report:', err);
      setError(
        err.response?.data?.detail ||
          'Failed to load report. Ensure the analysis is completed and results exist.'
      );
    } finally {
      setIsLoading(false);
    }
  };

  const reloadHtmlReport = async (paletteToUse: string) => {
    setIsReloadingReport(true);
    try {
      const htmlRes = await api.get(
        `/api/projects/${projectUuid}/analysis/${analysisUuid}/report.html?style=screen&palette=${encodeURIComponent(paletteToUse)}`,
        { responseType: 'text' }
      );
      setHtmlContent(htmlRes.data);
    } catch (err: any) {
      console.error('Failed to reload report with palette:', err);
    } finally {
      setIsReloadingReport(false);
    }
  };

  const handleSelectPalette = (paletteId: string) => {
    setSelectedPalette(paletteId);
    setShowPaletteMenu(false);
    reloadHtmlReport(paletteId);
  };

  const handleApplyCustomColor = () => {
    const hex = customColor.trim();
    if (/^#?[0-9a-fA-F]{3,6}$/.test(hex)) {
      const formattedHex = hex.startsWith('#') ? hex : `#${hex}`;
      setSelectedPalette(formattedHex);
      setShowPaletteMenu(false);
      reloadHtmlReport(formattedHex);
    }
  };

  const currentPreset = palettes.find((p) => p.id === selectedPalette);
  const activePrimaryColor = currentPreset ? currentPreset.primary : selectedPalette;
  const activePaletteName = currentPreset ? currentPreset.name : `Custom (${selectedPalette})`;

  const handleDownloadPdf = async () => {
    try {
      setIsExportingPdf(true);
      setExportMessage('Starting PDF export job...');

      // 1. Dispatch asynchronous Celery task on stats queue with selected palette
      const asyncRes = await api.post(
        `/api/projects/${projectUuid}/analysis/${analysisUuid}/report/async`,
        { style: 'publication', palette: selectedPalette }
      );

      const { task_id, download_url } = asyncRes.data;
      setExportMessage('Generating publication PDF in background...');

      // 2. Poll task status
      let ready = false;
      let attempts = 0;
      const maxAttempts = 60; // 2 minutes timeout at 2s intervals

      while (!ready && attempts < maxAttempts) {
        await new Promise((r) => setTimeout(r, 2000));
        attempts += 1;

        try {
          const statusRes = await api.get(
            `/api/projects/${projectUuid}/analysis/${analysisUuid}/report/status/${task_id}`
          );

          if (statusRes.data.status === 'SUCCESS' || statusRes.data.ready) {
            ready = true;
            setExportMessage('PDF ready! Downloading...');

            // 3. Trigger download via signed token URL
            const fileRes = await api.get(download_url, { responseType: 'blob' });
            const blob = new Blob([fileRes.data], { type: 'application/pdf' });
            const link = document.createElement('a');
            link.href = window.URL.createObjectURL(blob);
            link.download = `${analysis?.name || 'analysis'}_${analysisUuid?.slice(0, 8)}_report.pdf`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            window.URL.revokeObjectURL(link.href);

            setExportMessage('Download complete!');
            setTimeout(() => {
              setExportMessage('');
              setIsExportingPdf(false);
            }, 3000);
            return;
          } else if (statusRes.data.status === 'FAILURE') {
            throw new Error(statusRes.data.error || 'PDF generation failed on worker');
          }
        } catch (pollErr: any) {
          if (pollErr.response?.status === 404) {
            continue;
          }
          throw pollErr;
        }
      }

      if (!ready) {
        throw new Error('PDF export timed out. Please try again.');
      }
    } catch (err: any) {
      console.error('Async PDF export failed:', err);
      // Fallback: Attempt direct synchronous download with selected palette
      try {
        setExportMessage('Attempting direct download fallback...');
        const directRes = await api.get(
          `/api/projects/${projectUuid}/analysis/${analysisUuid}/report.pdf?style=publication&palette=${encodeURIComponent(selectedPalette)}`,
          { responseType: 'blob' }
        );
        const blob = new Blob([directRes.data], { type: 'application/pdf' });
        const link = document.createElement('a');
        link.href = window.URL.createObjectURL(blob);
        link.download = `${analysis?.name || 'analysis'}_report.pdf`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.URL.revokeObjectURL(link.href);
        setExportMessage('Direct download complete!');
        setTimeout(() => {
          setExportMessage('');
          setIsExportingPdf(false);
        }, 3000);
      } catch (fallbackErr: any) {
        alert(
          err.response?.data?.detail ||
            err.message ||
            'Failed to generate or download report PDF.'
        );
        setIsExportingPdf(false);
        setExportMessage('');
      }
    }
  };

  const handleExportPlots = async () => {
    try {
      setIsExportingPlots(true);
      setExportPlotsMessage('Starting plot export job...');

      // 1. Dispatch asynchronous Celery task on stats queue with selected palette
      const asyncRes = await api.post(
        `/api/projects/${projectUuid}/analysis/${analysisUuid}/export/plots/async`,
        { style: 'publication', palette: selectedPalette }
      );

      const { task_id, download_url } = asyncRes.data;
      setExportPlotsMessage('Generating 300 DPI PNGs & PDFs in background...');

      // 2. Poll task status
      let ready = false;
      let attempts = 0;
      const maxAttempts = 60; // 2 minutes timeout at 2s intervals

      while (!ready && attempts < maxAttempts) {
        await new Promise((r) => setTimeout(r, 2000));
        attempts += 1;

        try {
          const statusRes = await api.get(
            `/api/projects/${projectUuid}/analysis/${analysisUuid}/export/plots/status/${task_id}`
          );

          if (statusRes.data.status === 'SUCCESS' || statusRes.data.ready) {
            ready = true;
            setExportPlotsMessage('Plots ready! Downloading archive...');

            // 3. Trigger download via signed token URL
            const fileRes = await api.get(download_url, { responseType: 'blob' });
            const blob = new Blob([fileRes.data], { type: 'application/zip' });
            const link = document.createElement('a');
            link.href = window.URL.createObjectURL(blob);
            link.download = `${analysis?.name || 'analysis'}_plots_${selectedPalette}.zip`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            window.URL.revokeObjectURL(link.href);

            setExportPlotsMessage('Plots download complete!');
            setTimeout(() => {
              setExportPlotsMessage('');
              setIsExportingPlots(false);
            }, 3000);
            return;
          } else if (statusRes.data.status === 'FAILURE') {
            throw new Error(statusRes.data.error || 'Plot export failed on worker');
          }
        } catch (pollErr: any) {
          if (pollErr.response?.status === 404) {
            continue;
          }
          throw pollErr;
        }
      }

      if (!ready) {
        throw new Error('Plot export timed out. Please try again.');
      }
    } catch (err: any) {
      console.error('Async plots export failed:', err);
      // Fallback: Attempt direct synchronous download with selected palette
      try {
        setExportPlotsMessage('Attempting direct download fallback...');
        const directRes = await api.get(
          `/api/projects/${projectUuid}/analysis/${analysisUuid}/export/plots?style=publication&palette=${encodeURIComponent(selectedPalette)}`,
          { responseType: 'blob' }
        );
        const blob = new Blob([directRes.data], { type: 'application/zip' });
        const link = document.createElement('a');
        link.href = window.URL.createObjectURL(blob);
        link.download = `${analysis?.name || 'analysis'}_plots_${selectedPalette}.zip`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.URL.revokeObjectURL(link.href);
        setExportPlotsMessage('Plots download complete!');
        setTimeout(() => {
          setExportPlotsMessage('');
          setIsExportingPlots(false);
        }, 3000);
      } catch (fallbackErr: any) {
        alert(
          err.response?.data?.detail ||
            err.message ||
            'Failed to export and download plots archive.'
        );
        setIsExportingPlots(false);
        setExportPlotsMessage('');
      }
    }
  };

  const handlePrint = () => {
    if (iframeRef.current && iframeRef.current.contentWindow) {
      iframeRef.current.contentWindow.focus();
      iframeRef.current.contentWindow.print();
    } else {
      window.print();
    }
  };

  const handleCopyJson = () => {
    if (jsonContent) {
      navigator.clipboard.writeText(JSON.stringify(jsonContent, null, 2));
      setCopiedJson(true);
      setTimeout(() => setCopiedJson(false), 2000);
    }
  };

  if (isLoading) {
    return (
      <div className="flex flex-col justify-center items-center min-h-[600px] gap-3 text-slate-500">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-600" />
        <p className="text-sm font-medium">Loading report document...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-4xl mx-auto p-6 space-y-4">
        <button
          onClick={() => navigate(`/projects/${projectUuid}/analysis/${analysisUuid}`)}
          className="inline-flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Analysis
        </button>
        <div className="p-5 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 rounded-xl text-rose-700 dark:text-rose-400 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 mt-0.5 flex-shrink-0" />
          <div>
            <h3 className="font-semibold text-sm">Report Unavailable</h3>
            <p className="text-sm mt-1">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-slate-100 dark:bg-slate-900 overflow-hidden">
      {/* Top Navigation / Actions Toolbar */}
      <header className="flex-none bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 px-6 py-3 flex items-center justify-between shadow-sm z-20">
        <div className="flex items-center space-x-4">
          <button
            onClick={() => navigate(`/projects/${projectUuid}/analysis/${analysisUuid}`)}
            className="p-2 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-all"
            title="Back to Analysis"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold text-slate-900 dark:text-white tracking-tight">
                {analysis?.name || 'Analysis Report'}
              </h1>
              <span className="px-2 py-0.5 text-xs font-semibold rounded bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
                {analysis?.analysis_type}
              </span>
              <span className="px-2 py-0.5 text-xs font-semibold rounded bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800">
                {analysis?.status}
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Interactive Report Viewer • WeasyPrint / Paged Media Engine
            </p>
          </div>
        </div>

        {/* View Switcher, Palette Selector, and Actions */}
        <div className="flex items-center space-x-3">
          {/* View Toggle */}
          <div className="flex bg-slate-100 dark:bg-slate-700 p-0.5 rounded-lg text-xs font-medium text-slate-600 dark:text-slate-300">
            <button
              onClick={() => setActiveView('html')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-all ${
                activeView === 'html'
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm font-semibold'
                  : 'hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <FileText className="w-3.5 h-3.5" />
              HTML Report
            </button>
            <button
              onClick={() => setActiveView('json')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-all ${
                activeView === 'json'
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm font-semibold'
                  : 'hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <Code className="w-3.5 h-3.5" />
              Data Model (JSON)
            </button>
          </div>

          <div className="h-6 w-px bg-slate-200 dark:bg-slate-700 mx-1" />

          {/* Palette Selector Dropdown */}
          <div className="relative" ref={paletteMenuRef}>
            <button
              onClick={() => setShowPaletteMenu(!showPaletteMenu)}
              className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 rounded-lg shadow-sm transition-colors"
              title="Select Plot Color Theme"
            >
              <Palette className="w-3.5 h-3.5 text-slate-500" />
              <span
                className="w-3 h-3 rounded-full border border-slate-300 dark:border-slate-600 flex-shrink-0"
                style={{ backgroundColor: activePrimaryColor }}
              />
              <span className="hidden sm:inline">{activePaletteName}</span>
              {isReloadingReport && <Loader2 className="w-3 h-3 animate-spin text-indigo-500 ml-0.5" />}
            </button>

            {showPaletteMenu && (
              <div className="absolute right-0 mt-2 w-72 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl z-50 p-2 space-y-1.5 text-xs">
                <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  Plot Color Themes
                </div>
                <div className="max-h-60 overflow-y-auto space-y-1 pr-1">
                  {palettes.map((p) => {
                    const isSelected = selectedPalette === p.id;
                    return (
                      <button
                        key={p.id}
                        onClick={() => handleSelectPalette(p.id)}
                        className={`w-full flex items-center justify-between p-2 rounded-lg text-left transition-colors ${
                          isSelected
                            ? 'bg-indigo-50 dark:bg-indigo-950/50 text-indigo-900 dark:text-indigo-200 font-semibold'
                            : 'hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200'
                        }`}
                      >
                        <div className="flex items-center gap-2.5">
                          <span
                            className="w-4 h-4 rounded-full border border-slate-300 dark:border-slate-600 flex-shrink-0 shadow-xs"
                            style={{ backgroundColor: p.primary }}
                          />
                          <div>
                            <div className="text-xs">{p.name}</div>
                            <div className="flex gap-1 mt-1">
                              {p.colors.slice(0, 5).map((c, ci) => (
                                <span
                                  key={ci}
                                  className="w-2 h-2 rounded-full"
                                  style={{ backgroundColor: c }}
                                />
                              ))}
                            </div>
                          </div>
                        </div>
                        {isSelected && <Check className="w-4 h-4 text-indigo-600 dark:text-indigo-400 flex-shrink-0" />}
                      </button>
                    );
                  })}
                </div>

                <div className="border-t border-slate-100 dark:border-slate-700 pt-2 pb-1 px-2">
                  <div className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 mb-1.5">
                    Custom Primary Color
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={customColor}
                      onChange={(e) => setCustomColor(e.target.value)}
                      className="w-7 h-7 rounded border border-slate-300 dark:border-slate-600 cursor-pointer bg-transparent p-0 flex-shrink-0"
                      title="Choose custom color"
                    />
                    <input
                      type="text"
                      value={customColor}
                      onChange={(e) => setCustomColor(e.target.value)}
                      placeholder="#0072B2"
                      maxLength={7}
                      className="w-24 px-2 py-1 text-xs font-mono border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200"
                    />
                    <button
                      onClick={handleApplyCustomColor}
                      className="flex-1 px-2.5 py-1 text-xs font-medium rounded bg-indigo-600 hover:bg-indigo-700 text-white transition-colors"
                    >
                      Apply
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Print Button */}
          {activeView === 'html' && (
            <button
              onClick={handlePrint}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 rounded-lg shadow-sm transition-colors"
              title="Print document"
            >
              <Printer className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Print</span>
            </button>
          )}

          {/* Export All Plots Button (300 DPI PNG & Vector PDF ZIP) */}
          <button
            onClick={handleExportPlots}
            disabled={isExportingPlots}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 shadow-sm transition-all ${
              isExportingPlots ? 'cursor-not-allowed opacity-80' : 'active:scale-[0.98]'
            }`}
            title="Export all publication plots in 300 DPI PNG and vector PDF format with the selected color scheme"
          >
            {isExportingPlots ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-600" />
                <span>{exportPlotsMessage || 'Exporting Plots...'}</span>
              </>
            ) : (
              <>
                <FolderArchive className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
                <span className="hidden sm:inline">Export All Plots</span>
              </>
            )}
          </button>

          {/* PDF Export Button (Async Celery Task on stats queue) */}
          <button
            onClick={handleDownloadPdf}
            disabled={isExportingPdf}
            className={`inline-flex items-center gap-2 px-3.5 py-1.5 text-xs font-medium rounded-lg text-white shadow-sm transition-all ${
              isExportingPdf
                ? 'bg-indigo-400 cursor-not-allowed'
                : 'bg-indigo-600 hover:bg-indigo-700 active:scale-[0.98]'
            }`}
            title="Generate publication PDF asynchronously via Celery worker"
          >
            {isExportingPdf ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>{exportMessage || 'Generating PDF...'}</span>
              </>
            ) : (
              <>
                <Download className="w-3.5 h-3.5" />
                <span>Download PDF</span>
              </>
            )}
          </button>
        </div>
      </header>

      {/* Main View Area */}
      <main className="flex-1 relative overflow-hidden">
        {activeView === 'html' ? (
          <iframe
            ref={iframeRef}
            srcDoc={htmlContent}
            title={`${analysis?.name || 'Analysis'} HTML Report`}
            className="w-full h-full border-0 bg-white"
            sandbox="allow-same-origin allow-scripts allow-popups"
          />
        ) : (
          <div className="w-full h-full overflow-auto p-6 bg-slate-900 text-slate-100 font-mono text-xs">
            <div className="max-w-5xl mx-auto space-y-3">
              <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                <span className="text-slate-400 font-sans text-xs">
                  Canonical ReportModel serialized via <code className="text-indigo-400">to_dict()</code> (WeasyPrint Spec §9)
                </span>
                <button
                  onClick={handleCopyJson}
                  className="inline-flex items-center gap-1.5 px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-xs transition-colors"
                >
                  {copiedJson ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="text-emerald-400">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy JSON</span>
                    </>
                  )}
                </button>
              </div>
              <pre className="p-4 bg-slate-950 rounded-xl overflow-x-auto border border-slate-800 leading-relaxed">
                {jsonContent ? JSON.stringify(jsonContent, null, 2) : 'No JSON data available'}
              </pre>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default AnalysisReport;
