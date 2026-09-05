import React, { useState, useEffect } from 'react';
import api from '../services/api';
import { jsPDF } from 'jspdf';
import Plotly from 'plotly.js';
import { useTheme } from '../context/ThemeContext';
import nmrSpectraDark from '../assets/nmr_spectra_dark.jpg';
import nmrSpectraLight from '../assets/nmr_spectra_light.jpg';
import atomSpinDark from '../assets/atom_spin_dark.jpg';
import atomSpinLight from '../assets/atom_spin_light.jpg';
import peakFittingDark from '../assets/peak_fitting_dark.jpg';
import peakFittingLight from '../assets/peak_fitting_light.jpg';
import fitParametersDark from '../assets/fit_parameters_dark.jpg';
import fitParametersLight from '../assets/fit_parameters_light.jpg';
import terminalLogsDark from '../assets/terminal_logs_dark.jpg';
import terminalLogsLight from '../assets/terminal_logs_light.jpg';
import { 
  ArrowRight, 
  Activity as ActivityIcon, 
  Database, 
  BarChart2, 
  Clock, 
  FileText, 
  Settings, 
  Play, 
  AlertCircle,
  Eye,
  EyeOff,
  Trash2,
  X,
  Users,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  Copy,
  Check
} from 'lucide-react';
import Plot, { PLOT_COLORS } from './Plot';

interface Spectrum {
  id: number;
  spectrum_uuid: string;
  name: string;
  experiment_type?: string;
  is_fitted?: boolean;
  vdlist_path?: string;
  vclist_path?: string;
  delay?: number | null;
}

interface PeakResult {
  assignment: string;
  res_num?: number;
  res_name?: string;
  rate: number;
  rate_err: number;
  amplitude: number;
  amplitude_err: number;
  chisqr: number;
  redchi: number;
  rmse?: number;
  times: number[];
  intensities: number[];
  intensities_err?: number[];
  fit_intensities: number[];
  fit_times_dense?: number[];
  fit_intensities_dense?: number[];
  fit_uncertainty_dense?: number[];
}

interface AnalysisResults {
  analysis_uuid: string;
  peak_results: PeakResult[];
}

interface Analysis {
  id: number;
  analysis_uuid: string;
  name: string;
  analysis_type: string;
  status: string;
  parameters?: string;
  spectra: Spectrum[];
  use_height: boolean;
  has_backup: boolean;
  error_message?: string;
}

interface AnalysisManagerProps {
  analysis: Analysis;
  projectUuid: string;
  availableSpectra: Spectrum[];
  onStatusChange?: (status: string) => void;
  onDelete?: () => void;
  onClose?: () => void; // Added for the X button in the provided snippet
}

const AnalysisManager: React.FC<AnalysisManagerProps> = ({ 
  analysis, 
  projectUuid, 
  availableSpectra,
  onStatusChange,
  onDelete,
  onClose
}) => {
  const { theme } = useTheme();
  const isDarkTheme = theme === 'dark';
  const nmrSpectraIcon = isDarkTheme ? nmrSpectraDark : nmrSpectraLight;
  const atomSpinIcon = isDarkTheme ? atomSpinDark : atomSpinLight;
  const peakFittingIcon = isDarkTheme ? peakFittingDark : peakFittingLight;
  const fitParametersIcon = isDarkTheme ? fitParametersDark : fitParametersLight;
  const terminalLogsIcon = isDarkTheme ? terminalLogsDark : terminalLogsLight;

  const [activeTab, setActiveTab] = useState<'info' | 'params' | 'results' | 'log'>('info');
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => localStorage.getItem('resoFlow_sidebar_collapsed') === 'true');
  const [currentAnalysis, setCurrentAnalysis] = useState<Analysis>(analysis);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [results, setResults] = useState<AnalysisResults | null>(null);
  const [selectedPeak, setSelectedPeak] = useState<PeakResult | null>(null);
  const [workers, setWorkers] = useState(1);
  const [plotColor, setPlotColor] = useState('#f43f5e'); // Fit color (rose-500)
  const [observedColor, setObservedColor] = useState('#6366f1'); // Observed color (indigo-500)
  const [ratesColor, setRatesColor] = useState('#6366f1'); // Rates plot color (indigo-500)
  const [excludedResidues, setExcludedResidues] = useState<string[]>([]);
  const [logs, setLogs] = useState<string>('');
  const [copiedLogs, setCopiedLogs] = useState(false);
  const [showRerunWarning, setShowRerunWarning] = useState(false);

  const fetchLogs = async () => {
    try {
      const response = await api.get(`/api/projects/${projectUuid}/analysis/${currentAnalysis.analysis_uuid}/logs`);
      if (response.data) {
        if (response.data.logs !== undefined) {
          setLogs(response.data.logs);
        }
        if (response.data.error_message && response.data.error_message !== currentAnalysis.error_message) {
          setCurrentAnalysis(prev => ({ ...prev, error_message: response.data.error_message }));
        }
      }
    } catch (err) {
      console.error("Failed to fetch logs", err);
    }
  };

  const handleCopyLogs = () => {
    if (!logs) return;
    navigator.clipboard.writeText(logs);
    setCopiedLogs(true);
    setTimeout(() => setCopiedLogs(false), 2000);
  };

  useEffect(() => {
    const params = JSON.parse(currentAnalysis.parameters || '{}');
    setWorkers(params.workers || 1);
    setPlotColor(params.plotColor || '#f43f5e');
    setObservedColor(params.observedColor || '#6366f1');
    setRatesColor(params.ratesColor || '#6366f1');
    setExcludedResidues(params.excludedResidues || []);
  }, [currentAnalysis.parameters]);

  const handleToggleSpectrum = async (spectrumId: number) => {
    try {
        const isSelected = currentAnalysis.spectra.some(s => s.id === spectrumId);
        let newSpectra;
        if (isSelected) {
            newSpectra = currentAnalysis.spectra.filter(s => s.id !== spectrumId);
        } else {
            const matching = availableSpectra.find(s => s.id === spectrumId);
            if (matching) newSpectra = [...currentAnalysis.spectra, matching];
            else return;
        }

        await api.put(`/api/projects/${projectUuid}/analysis/${currentAnalysis.analysis_uuid}/spectra`, newSpectra.map(s => s.id));
        setCurrentAnalysis({ ...currentAnalysis, spectra: newSpectra });
    } catch (err) {
        setError('Failed to update spectra selection');
        console.error(err);
    }
  };

  const handleUpdateUseHeight = async (useHeight: boolean) => {
    try {
        await api.put(`/api/projects/${projectUuid}/analysis/${currentAnalysis.analysis_uuid}`, {
            use_height: useHeight
        });
        setCurrentAnalysis({ ...currentAnalysis, use_height: useHeight });
    } catch (err) {
        setError('Failed to update fitting preference');
        console.error(err);
    }
  };

  const handleUpdatePlotColor = async (color: string) => {
    try {
        const params = JSON.parse(currentAnalysis.parameters || '{}');
        params.plotColor = color;
        const paramsStr = JSON.stringify(params);
        
        await api.put(`/api/projects/${projectUuid}/analysis/${currentAnalysis.analysis_uuid}`, {
            parameters: paramsStr
        });
        setPlotColor(color);
        setCurrentAnalysis({ ...currentAnalysis, parameters: paramsStr });
    } catch (err) {
        console.error('Failed to update plot color:', err);
    }
  };

  const handleUpdateObservedColor = async (color: string) => {
    try {
        const params = JSON.parse(currentAnalysis.parameters || '{}');
        params.observedColor = color;
        const paramsStr = JSON.stringify(params);
        await api.put(`/api/projects/${projectUuid}/analysis/${currentAnalysis.analysis_uuid}`, { parameters: paramsStr });
        setObservedColor(color);
        setCurrentAnalysis({ ...currentAnalysis, parameters: paramsStr });
    } catch (err) { console.error(err); }
  };

  const handleUpdateRatesColor = async (color: string) => {
    try {
        const params = JSON.parse(currentAnalysis.parameters || '{}');
        params.ratesColor = color;
        const paramsStr = JSON.stringify(params);
        await api.put(`/api/projects/${projectUuid}/analysis/${currentAnalysis.analysis_uuid}`, { parameters: paramsStr });
        setRatesColor(color);
        setCurrentAnalysis({ ...currentAnalysis, parameters: paramsStr });
    } catch (err) { console.error(err); }
  };

  const handleToggleResidueExclusion = async (assignment: string) => {
    try {
        const params = JSON.parse(currentAnalysis.parameters || '{}');
        let newExclusions = [...(params.excludedResidues || [])];
        if (newExclusions.includes(assignment)) {
            newExclusions = newExclusions.filter(a => a !== assignment);
        } else {
            newExclusions.push(assignment);
        }
        params.excludedResidues = newExclusions;
        const paramsStr = JSON.stringify(params);
        await api.put(`/api/projects/${projectUuid}/analysis/${currentAnalysis.analysis_uuid}`, { parameters: paramsStr });
        setExcludedResidues(newExclusions);
        setCurrentAnalysis({ ...currentAnalysis, parameters: paramsStr });
    } catch (err) { console.error(err); }
  };

  useEffect(() => {
    setCurrentAnalysis(analysis);
  }, [analysis]);

  const handleRunAnalysis = async () => {
    try {
      setIsLoading(true);
      setError('');
      const spectrumIds = currentAnalysis.spectra.map(s => s.id);
      await api.post(`/api/projects/${projectUuid}/analysis/${currentAnalysis.analysis_uuid}/run`, {
        spectrum_ids: spectrumIds,
        workers: workers
      });
      setCurrentAnalysis({ ...currentAnalysis, status: 'RUNNING', error_message: undefined });
      setShowRerunWarning(false);
      setLogs('');
      if (onStatusChange) onStatusChange('RUNNING');
    } catch (err: any) {
      const msg = err.response?.data?.detail || 'Failed to start analysis';
      const formatted = typeof msg === 'string' ? msg : JSON.stringify(msg);
      setError(formatted);
      setCurrentAnalysis(prev => ({ ...prev, error_message: formatted }));
      console.error("Analysis start error:", err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRestoreAnalysis = async () => {
    try {
      setIsLoading(true);
      const response = await api.post(`/api/projects/${projectUuid}/analysis/${currentAnalysis.analysis_uuid}/restore`);
      setCurrentAnalysis(response.data);
      fetchResults();
    } catch (err) {
      setError('Failed to restore analysis');
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const fetchResults = async () => {
    try {
      const response = await api.get(`/api/projects/${projectUuid}/analysis/${currentAnalysis.analysis_uuid}/results`);
      if (response.data.results) {
        setResults(response.data.results);
        if (response.data.results.peak_results?.length > 0 && !selectedPeak) {
            // Sort by residue number if available
            const sorted = [...response.data.results.peak_results].sort((a, b) => (a.res_num || 0) - (b.res_num || 0));
            setSelectedPeak(sorted[0]);
        }
      }
    } catch (err) {
      console.error("Failed to fetch results", err);
    }
  };

  const exportToCSV = () => {
    if (!results || !results.peak_results) return;
    
    const headers = ['Res #', 'Res Name', 'Assignment', currentAnalysis.analysis_type === 'hetNOE' ? 'Ratio' : 'Rate (s-1)', 'Error', 'Amplitude', 'Amp Err', 'ChiSqr', 'Red ChiSqr'];
    const rows = results.peak_results.map(p => [
      p.res_num || '',
      p.res_name || '',
      p.assignment,
      p.rate.toFixed(4),
      p.rate_err.toFixed(4),
      p.amplitude.toFixed(2),
      p.amplitude_err.toFixed(2),
      p.chisqr.toFixed(4),
      p.redchi.toFixed(4)
    ]);
    
    const csvContent = [headers, ...rows].map(e => e.join(",")).join("\n");
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `${currentAnalysis.name}_results.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const exportToPDF = async () => {
    if (!results || !results.peak_results) return;

    const doc = new jsPDF();
    const title = `${currentAnalysis.name} - Relaxation Profiles`;
    
    // Header
    doc.setFontSize(22);
    doc.setTextColor(30, 41, 59); // slate-800
    doc.text(title, 20, 25);
    
    doc.setFontSize(10);
    doc.setTextColor(100, 116, 139); // slate-500
    doc.text(`Generated on: ${new Date().toLocaleString()}`, 20, 32);
    doc.text(`Project UUID: ${projectUuid}`, 20, 37);
    doc.text(`Analysis Type: ${currentAnalysis.analysis_type}`, 20, 42);
    
    let yPos = 55;
    const plotsPerPage = 2;
    let plotCount = 0;

    // Sort by residue number
    const sortedPeaks = [...results.peak_results].sort((a, b) => (a.res_num || 0) - (b.res_num || 0));

    for (const peak of sortedPeaks) {
        if (plotCount > 0 && plotCount % plotsPerPage === 0) {
            doc.addPage();
            yPos = 20;
        }

        // Add peak info
        doc.setFontSize(12);
        doc.setTextColor(30, 41, 59);
        doc.text(`${peak.assignment} (${currentAnalysis.analysis_type})`, 20, yPos);
        
        doc.setFontSize(9);
        doc.setTextColor(100, 116, 139);
        doc.text(`Rate: ${peak.rate.toFixed(4)} ± ${peak.rate_err.toFixed(4)} s⁻¹ | Red χ²: ${peak.redchi.toFixed(3)}`, 20, yPos + 5);

        // Figure configuration for static image export
        const figure = {
            data: [
                {
                    x: peak.times,
                    y: peak.intensities,
                    type: 'scatter',
                    mode: 'markers',
                    name: 'Observed',
                    marker: { color: '#6366f1', size: 10, line: { color: 'white', width: 1 } },
                },
                {
                    x: Array.from({length: 100}, (_, i) => Math.min(...peak.times) + i * (Math.max(...peak.times) - Math.min(...peak.times)) / 99),
                    y: Array.from({length: 100}, (_, i) => {
                        const t = Math.min(...peak.times) + i * (Math.max(...peak.times) - Math.min(...peak.times)) / 99;
                        return peak.amplitude * Math.exp(-peak.rate * t);
                    }),
                    type: 'scatter',
                    mode: 'lines',
                    name: 'Model Fit',
                    line: { color: '#f43f5e', width: 3, shape: 'spline' },
                }
            ],
            layout: {
                width: 700,
                height: 350,
                margin: { l: 60, r: 20, b: 60, t: 20 },
                xaxis: { title: 'Delay (ms)', gridcolor: '#f1f5f9' },
                yaxis: { title: 'Intensity', gridcolor: '#f1f5f9' },
                paper_bgcolor: 'white',
                plot_bgcolor: 'white',
            }
        };

        try {
            // @ts-ignore
            const imgData = await Plotly.toImage(figure, { format: 'png', width: 700, height: 350 });
            doc.addImage(imgData, 'PNG', 20, yPos + 8, 170, 65);
        } catch (err) {
            console.error("PDF Image generation failed", err);
        }
        yPos += 100;
        plotCount++;
    }

    // Add page numbers
    const totalPages = doc.getNumberOfPages();
    for (let i = 1; i <= totalPages; i++) {
        doc.setPage(i);
        doc.setFontSize(8);
        doc.setTextColor(148, 163, 184);
        doc.text(`Page ${i} of ${totalPages}`, 105, 285, { align: 'center' });
    }
    
    doc.save(`${currentAnalysis.name}_profiles.pdf`);
  };

  const pollStatus = async () => {
    try {
        const response = await api.get(`/api/projects/${projectUuid}/analysis`);
        const allAnalyses = response.data;
        const updated = allAnalyses.find((a: any) => a.analysis_uuid === currentAnalysis.analysis_uuid);
        if (updated && updated.status !== currentAnalysis.status) {
            setCurrentAnalysis(updated);
            if (onStatusChange) onStatusChange(updated.status);
            if (updated.status === 'COMPLETED') {
                fetchResults();
            } else if (updated.status === 'FAILED') {
                fetchLogs();
            }
        }
    } catch (err) {
        console.error("Polling failed", err);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm('Are you sure you want to delete this analysis? This action cannot be undone.')) {
      return;
    }
    try {
      await api.delete(`/api/projects/${projectUuid}/analysis/${currentAnalysis.analysis_uuid}`);
      if (onDelete) {
        onDelete();
      } else if (onClose) { // Fallback to onClose if onDelete is not provided
        onClose();
      }
    } catch (err) {
      console.error('Failed to delete analysis:', err);
      setError('Failed to delete analysis. Please try again.');
    }
  };

  useEffect(() => {
    let interval: any;
    if (currentAnalysis.status === 'RUNNING') {
        interval = setInterval(pollStatus, 3000);
    }
    return () => clearInterval(interval);
  }, [currentAnalysis.status]);

  useEffect(() => {
    if (currentAnalysis.status === 'COMPLETED' && activeTab === 'results') {
        fetchResults();
    }
  }, [currentAnalysis.status, activeTab]);

  useEffect(() => {
    if (activeTab === 'log' || currentAnalysis.status === 'RUNNING' || currentAnalysis.status === 'FAILED') {
      fetchLogs();
    }
  }, [activeTab, currentAnalysis.status]);

  useEffect(() => {
    let logInterval: any;
    if (currentAnalysis.status === 'RUNNING') {
      logInterval = setInterval(fetchLogs, 2000);
    }
    return () => clearInterval(logInterval);
  }, [currentAnalysis.status]);

  return (
    <div className="space-y-6 animate-in fade-in duration-300 pb-12">
      {/* Alert Error */}
      {error && (
        <div className="p-4 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-xl flex items-start justify-between text-red-700 dark:text-red-400 text-sm animate-in shake shadow-sm">
          <div className="flex items-start space-x-3 flex-1">
            <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
            <div className="font-medium leading-relaxed">{error}</div>
          </div>
          <button
            onClick={() => setError('')}
            className="p-1 -mr-1 -mt-1 text-red-400 hover:text-red-600 dark:hover:text-red-300 rounded-lg transition-colors"
            title="Dismiss error"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Analysis Status Header */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 border border-slate-200 dark:border-slate-700 shadow-sm flex items-center justify-between transition-colors">
        <div className="flex items-center space-x-5">
          <div className={`p-4 rounded-2xl ${currentAnalysis.status === 'COMPLETED' ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600' : 'bg-blue-50 dark:bg-indigo-900/20 text-blue-600'}`}>
            <ActivityIcon className="w-7 h-7" />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-slate-900 dark:text-white">{currentAnalysis.name}</h2>
            <div className="flex items-center space-x-3 mt-1.5">
              <span className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest bg-slate-100 dark:bg-slate-700/50 px-2 py-0.5 rounded-md">{currentAnalysis.analysis_type} Analysis</span>
              <span className="text-slate-300 dark:text-slate-600">/</span>
              <div className="flex items-center px-2 py-0.5 rounded-full border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900">
                {currentAnalysis.status === 'RUNNING' && <div className="animate-spin rounded-full h-2 w-2 border-b-2 border-blue-600 mr-2"></div>}
                <span className={`text-[10px] font-black uppercase tracking-tighter ${currentAnalysis.status === 'COMPLETED' ? 'text-emerald-500' : currentAnalysis.status === 'FAILED' ? 'text-red-500' : 'text-blue-500'}`}>
                    {currentAnalysis.status}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          {currentAnalysis.has_backup && (
            <button
                onClick={handleRestoreAnalysis}
                disabled={isLoading}
                className="flex items-center px-6 py-3 bg-blue-50 hover:bg-blue-100 dark:bg-blue-900/20 dark:hover:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded-xl text-xs font-black uppercase tracking-widest transition-all"
                title="Restore previous run from backup"
            >
                <ActivityIcon className="w-4 h-4 mr-2" />
                Restore Backup
            </button>
          )}

          {currentAnalysis.status === 'COMPLETED' || currentAnalysis.status === 'FAILED' ? (
            <button
              onClick={() => setShowRerunWarning(true)}
              disabled={isLoading || currentAnalysis.spectra.length === 0}
              className="flex items-center px-8 py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl shadow-lg shadow-indigo-600/20 text-xs font-black uppercase tracking-widest transition-all group active:scale-95"
            >
              <Play className="w-4 h-4 mr-2" />
              Rerun Analysis
            </button>
          ) : (
            <button
              onClick={handleRunAnalysis}
              disabled={isLoading || currentAnalysis.spectra.length === 0}
              className="flex items-center px-8 py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl shadow-lg shadow-indigo-600/20 text-xs font-black uppercase tracking-widest transition-all group active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {currentAnalysis.status === 'RUNNING' ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                  Running...
                </>
              ) : (
                <>
                  <Play className="w-4 h-4 mr-2" />
                  Run Analysis
                </>
              )}
            </button>
          )}
          
          {onClose && (
            <button 
                onClick={onClose}
                className="p-3 text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-700 rounded-xl transition-all"
            >
                <X className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="bg-white dark:bg-slate-800 rounded-3xl border border-slate-200 dark:border-slate-700 overflow-hidden shadow-xl transition-colors flex flex-col md:flex-row min-h-[600px]">
        {/* Sidebar */}
        <div className={`${isSidebarCollapsed ? 'w-full md:w-20' : 'w-full md:w-64'} flex-shrink-0 border-b md:border-b-0 md:border-r border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-900/10 p-4 flex flex-row md:flex-col gap-2 overflow-x-auto md:overflow-x-visible transition-all duration-300`}>
          {[
            { id: 'info', name: 'General Information', icon: atomSpinIcon },
            { id: 'params', name: 'Fit Parameters', icon: fitParametersIcon },
            { id: 'results', name: 'Results', icon: peakFittingIcon },
            { id: 'log', name: 'Analysis Log', icon: terminalLogsIcon },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`flex items-center px-4 py-3 rounded-xl transition-all duration-200 whitespace-nowrap gap-3 w-auto md:w-full ${
                isSidebarCollapsed ? 'md:justify-center' : 'md:justify-start'
              } ${
                activeTab === tab.id
                  ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400 font-semibold text-base scale-[1.03] shadow-sm border border-blue-100/50 dark:border-blue-900/50'
                  : 'text-sm text-slate-600 hover:text-slate-900 hover:bg-slate-50 dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800/50'
              }`}
              title={tab.name}
            >
              <img src={tab.icon} className="w-7 h-7 min-w-[28px] aspect-square object-cover rounded-lg flex-shrink-0 shadow-sm border border-slate-200 dark:border-slate-700" alt="" />
              <span className={isSidebarCollapsed ? 'md:hidden' : 'md:inline'}>{tab.name}</span>
            </button>
          ))}

          <div className="hidden md:flex flex-grow flex-col justify-end mt-4">
            <button
              onClick={() => {
                const newVal = !isSidebarCollapsed;
                setIsSidebarCollapsed(newVal);
                localStorage.setItem('resoFlow_sidebar_collapsed', String(newVal));
              }}
              className={`flex items-center px-4 py-3 text-sm font-medium text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-850 rounded-xl transition-all gap-3 ${isSidebarCollapsed ? 'justify-center' : 'justify-start'}`}
              title={isSidebarCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}
            >
              {isSidebarCollapsed ? <ChevronRight className="w-4 h-4 flex-shrink-0" /> : <ChevronLeft className="w-4 h-4 flex-shrink-0" />}
              <span className={isSidebarCollapsed ? 'hidden' : 'inline'}>Collapse Menu</span>
            </button>
          </div>
        </div>

        <div className="flex-1 p-6 md:p-10 overflow-x-hidden">
            {activeTab === 'info' && (
                <div className="space-y-10 animate-in slide-in-from-bottom-2 duration-500">
                    <section>
                        <div className="flex items-center justify-between mb-6">
                            <div className="flex items-center space-x-2">
                                <img src={nmrSpectraIcon} className="w-7 h-7 rounded-lg shadow-sm border border-slate-200 dark:border-slate-700" alt="" />
                                <h4 className="text-sm font-black text-slate-900 dark:text-white uppercase tracking-widest">Spectra Selection</h4>
                            </div>
                            <div className="flex items-center space-x-3">
                                {onDelete && (
                                    <button
                                        onClick={handleDelete}
                                        className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors border border-transparent hover:border-red-100 dark:hover:border-red-900/30"
                                        title="Delete Analysis"
                                    >
                                        <Trash2 className="w-5 h-5" />
                                    </button>
                                )}
                                {onClose && (
                                    <button 
                                        onClick={onClose}
                                        className="p-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
                                        title="Close Analysis"
                                    >
                                        <X className="w-6 h-6" />
                                    </button>
                                )}
                            </div>
                        </div>
                        {error && (
                            <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-xl flex items-start justify-between text-red-700 dark:text-red-400 text-sm animate-in shake shadow-sm">
                                <div className="flex items-start space-x-3 flex-1">
                                    <AlertCircle className="w-5 h-5 shrink-0 mt-0.5 text-red-500" />
                                    <div className="font-medium leading-relaxed">{error}</div>
                                </div>
                                <button
                                    onClick={() => setError('')}
                                    className="p-1 -mr-1 -mt-1 text-red-400 hover:text-red-600 dark:hover:text-red-300 rounded-lg transition-colors"
                                >
                                    <X className="w-4 h-4" />
                                </button>
                            </div>
                        )}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {availableSpectra.map(s => {
                                const isSelected = currentAnalysis.spectra.some(sp => sp.id === s.id);
                                return (
                                    <div 
                                        key={s.id} 
                                        onClick={() => handleToggleSpectrum(s.id)}
                                        className={`flex items-center p-4 rounded-2xl border-2 transition-all cursor-pointer ${isSelected ? 'border-blue-500 bg-blue-50/50 dark:bg-indigo-900/10' : 'border-slate-100 dark:border-slate-800 hover:border-slate-200 dark:hover:border-slate-700'}`}
                                    >
                                        <div className={`p-1.5 rounded-xl mr-4 ${isSelected ? 'bg-blue-100 text-blue-600' : 'bg-slate-100 dark:bg-slate-900 text-slate-400'}`}>
                                            <img src={nmrSpectraIcon} className="w-10 h-10 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700" alt="" />
                                        </div>
                                        <div className="flex-1">
                                            <p className="text-sm font-bold dark:text-white">{s.name}</p>
                                            <div className="flex items-center space-x-2 flex-wrap gap-y-1 mt-0.5">
                                                <p className="text-[10px] text-blue-500/70 font-black uppercase tracking-tighter">{s.experiment_type || 'Unknown Type'}</p>
                                                {s.is_fitted ? (
                                                    <span className="text-[9px] bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 px-1 rounded uppercase font-bold">Fitted</span>
                                                ) : (
                                                    <span className="text-[9px] bg-amber-100 dark:bg-amber-900/40 text-amber-600 px-1 rounded uppercase font-bold">Not Fitted</span>
                                                )}
                                                {['T1', 'R1'].includes((s.experiment_type || '').toUpperCase()) && (
                                                    s.vdlist_path ? (
                                                        <span className="text-[9px] bg-blue-100 dark:bg-blue-900/40 text-blue-600 px-1 rounded uppercase font-bold">VD List</span>
                                                    ) : (
                                                        <span className="text-[9px] bg-rose-100 dark:bg-rose-900/40 text-rose-600 px-1 rounded uppercase font-bold">No VD List</span>
                                                    )
                                                )}
                                                {['T2', 'R2'].includes((s.experiment_type || '').toUpperCase()) && (
                                                    (s.vclist_path || s.vdlist_path) ? (
                                                        <span className="text-[9px] bg-blue-100 dark:bg-blue-900/40 text-blue-600 px-1 rounded uppercase font-bold">
                                                            {s.vclist_path ? (s.delay && Number(s.delay) > 0 ? `VC List (d=${s.delay}s)` : 'VC List (No delay!)') : 'VD List'}
                                                        </span>
                                                    ) : (
                                                        <span className="text-[9px] bg-rose-100 dark:bg-rose-900/40 text-rose-600 px-1 rounded uppercase font-bold">No VC/VD List</span>
                                                    )
                                                )}
                                            </div>
                                        </div>
                                        <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all ${isSelected ? 'bg-blue-600 border-blue-600' : 'border-slate-200'}`}>
                                            {isSelected && <CheckCircle className="w-4 h-4 text-white" />}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </section>
                </div>
            )}

            {activeTab === 'params' && (
                <div className="space-y-12 max-w-2xl animate-in slide-in-from-bottom-2 duration-500">
                    <section>
                         <div className="flex items-center space-x-2 mb-8">
                            <Settings className="w-5 h-5 text-indigo-500" />
                            <h4 className="text-sm font-black text-slate-900 dark:text-white uppercase tracking-widest">Processing Configuration</h4>
                        </div>
                        <div className="bg-slate-50 dark:bg-slate-900/50 rounded-3xl p-8 border border-slate-100 dark:border-slate-800">
                            <div className="space-y-8">
                                <div>
                                    <div className="flex items-center justify-between mb-4">
                                        <div className="flex items-center">
                                            <Users className="w-4 h-4 mr-3 text-indigo-500" />
                                            <span className="text-sm font-bold text-slate-900 dark:text-white">Celery Workers</span>
                                        </div>
                                        <span className="bg-indigo-600 text-white text-[10px] font-black px-3 py-1 rounded-full uppercase tracking-widest">{workers} Active</span>
                                    </div>
                                    <input 
                                        type="range" min="1" max="8" step="1"
                                        value={workers}
                                        onChange={(e) => setWorkers(parseInt(e.target.value))}
                                        className="w-full h-3 bg-slate-200 dark:bg-slate-800 rounded-xl appearance-none cursor-pointer accent-indigo-600"
                                    />
                                    <p className="text-xs text-slate-400 mt-4 leading-relaxed italic">
                                        Configure the degree of parallelism. Analysis jobs are distributed across the Celery worker pool for efficient fitting of multiple peaks.
                                    </p>
                                </div>

                                <div className="pt-6 border-t border-slate-100 dark:border-slate-800">
                                    <div className="flex items-center space-x-3 p-4 bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm">
                                        <input
                                            type="checkbox"
                                            id="useHeightManager"
                                            checked={currentAnalysis.use_height}
                                            onChange={(e) => handleUpdateUseHeight(e.target.checked)}
                                            className="w-5 h-5 text-indigo-600 dark:text-indigo-500 border-slate-300 dark:border-slate-600 rounded focus:ring-indigo-500 bg-white dark:bg-slate-900 cursor-pointer"
                                        />
                                        <label htmlFor="useHeightManager" className="text-sm font-bold text-slate-700 dark:text-slate-200 cursor-pointer select-none">
                                            Use Peak Height instead of Amplitude
                                        </label>
                                    </div>
                                    <p className="text-xs text-slate-400 mt-4 leading-relaxed italic">
                                        Choose whether to use the peak height or the integrated peak amplitude for the relaxation fitting. Peak height can sometimes be more robust for overlapping peaks.
                                    </p>
                                </div>
                            </div>
                        </div>
                    </section>
                </div>
            )}

            {activeTab === 'results' && (
                <div className="space-y-10 animate-in slide-in-from-bottom-2 duration-500">
                    {error && (
                        <div className="p-4 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-xl flex items-start justify-between text-red-700 dark:text-red-400 text-sm animate-in shake shadow-sm">
                            <div className="flex items-start space-x-3 flex-1">
                                <AlertCircle className="w-5 h-5 shrink-0 mt-0.5 text-red-500" />
                                <div className="font-medium leading-relaxed">{error}</div>
                            </div>
                            <button
                                onClick={() => setError('')}
                                className="p-1 -mr-1 -mt-1 text-red-400 hover:text-red-600 dark:hover:text-red-300 rounded-lg transition-colors"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>
                    )}
                    {currentAnalysis.status === 'COMPLETED' && results ? (
                        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10">
                           {/* Results Table and Map */}
                            <div className="lg:col-span-12 xl:col-span-4 space-y-6">
                                <section>
                                    <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-100 dark:border-slate-800 overflow-hidden shadow-inner">
                                        <div className="max-h-[600px] overflow-y-auto custom-scrollbar">
                                            <table className="w-full text-left text-sm border-collapse">
                                                <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800 border-b border-slate-100 dark:border-slate-700 z-10">
                                                    <tr>
                                                        <th className="px-6 py-4 font-black uppercase tracking-tighter text-[10px] text-slate-400 w-12 text-center"></th>
                                                        <th className="px-6 py-4 font-black uppercase tracking-tighter text-[10px] text-slate-400">Res #</th>
                                                        <th className="px-6 py-4 font-black uppercase tracking-tighter text-[10px] text-slate-400">Assignment</th>
                                                        <th className="px-6 py-4 font-black uppercase tracking-tighter text-[10px] text-slate-400">{currentAnalysis.analysis_type === 'hetNOE' ? 'Ratio' : 'Rate (s⁻¹)'}</th>
                                                        <th className="px-6 py-4 font-black uppercase tracking-tighter text-[10px] text-slate-400 text-right">Error</th>
                                                    </tr>
                                                </thead>
                                                <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
                                                    {[...results.peak_results].sort((a, b) => (a.res_num || 0) - (b.res_num || 0)).map((peak) => (
                                                        <tr 
                                                            key={peak.assignment}
                                                            className={`cursor-pointer transition-all ${selectedPeak?.assignment === peak.assignment ? 'bg-emerald-50/50 dark:bg-emerald-900/10 border-l-4 border-emerald-500' : 'hover:bg-slate-50/50 dark:hover:bg-slate-800/40 border-l-4 border-transparent'} ${excludedResidues.includes(peak.assignment) ? 'opacity-40' : ''}`}
                                                        >
                                                            <td className="px-6 py-4" onClick={(e) => { e.stopPropagation(); handleToggleResidueExclusion(peak.assignment); }}>
                                                                {excludedResidues.includes(peak.assignment) ? 
                                                                    <EyeOff className="w-4 h-4 text-slate-400" /> : 
                                                                    <Eye className="w-4 h-4 text-emerald-500" />
                                                                }
                                                            </td>
                                                            <td className="px-6 py-4 font-bold text-slate-500 dark:text-slate-400" onClick={() => setSelectedPeak(peak)}>{peak.res_num ?? '—'}</td>
                                                            <td className="px-6 py-4 font-bold text-slate-900 dark:text-slate-200" onClick={() => setSelectedPeak(peak)}>{peak.assignment}</td>
                                                            <td className="px-6 py-4 font-mono text-emerald-600 dark:text-emerald-400 font-bold" onClick={() => setSelectedPeak(peak)}>{peak.rate.toFixed(3)}</td>
                                                            <td className="px-6 py-4 font-mono text-slate-400 text-right text-xs" onClick={() => setSelectedPeak(peak)}>±{peak.rate_err.toFixed(4)}</td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    </div>
                                </section>
                           </div>

                           {/* Decay Plot and Metadata */}
                           <div className="lg:col-span-12 xl:col-span-8 space-y-6">
                                <section className="h-full">
                                    <div className="flex items-center justify-between mb-6">
                                        <div className="flex items-center space-x-2">
                                            <ArrowRight className="w-5 h-5 text-blue-500" />
                                            <h4 className="text-sm font-black text-slate-900 dark:text-white uppercase tracking-widest">
                                                {currentAnalysis.analysis_type === 'hetNOE' ? 'Analysis Results' : `${selectedPeak?.assignment || 'Peak'} ${currentAnalysis.analysis_type} Profile`}
                                            </h4>
                                        </div>
                                        <div className="flex items-center space-x-3">
                                            <button 
                                                onClick={exportToCSV}
                                                className="flex items-center px-4 py-2 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all"
                                            >
                                                <Database className="w-3 h-3 mr-2" />
                                                CSV Results
                                            </button>
                                            <button 
                                                onClick={exportToPDF}
                                                className="flex items-center px-4 py-2 bg-emerald-100 hover:bg-emerald-200 dark:bg-emerald-900/30 dark:hover:bg-emerald-900/50 text-emerald-600 dark:text-emerald-400 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all"
                                            >
                                                <FileText className="w-3 h-3 mr-2" />
                                                Export PDF
                                            </button>
                                                                             <div className="flex items-center space-x-4 pl-4 border-l border-slate-200 dark:border-slate-700 h-8">
                                                {currentAnalysis.analysis_type !== 'hetNOE' && (
                                                    <>
                                                        {/* Fit Color */}
                                                        <div className="flex items-center space-x-1 relative group" title="Model Fit Color">
                                                            <div className="w-4 h-4 rounded-full border border-slate-200 dark:border-slate-700 pointer-events-none" style={{ backgroundColor: plotColor }}></div>
                                                            <input type="color" value={plotColor} onChange={(e) => handleUpdatePlotColor(e.target.value)} className="w-4 h-4 opacity-0 absolute inset-0 cursor-pointer" />
                                                            <span className="text-[10px] font-bold text-slate-400 uppercase">Fit</span>
                                                        </div>
                                                        {/* Observed Color */}
                                                        <div className="flex items-center space-x-1 relative group" title="Observed Data Color">
                                                            <div className="w-4 h-4 rounded-full border border-slate-200 dark:border-slate-700 pointer-events-none" style={{ backgroundColor: observedColor }}></div>
                                                            <input type="color" value={observedColor} onChange={(e) => handleUpdateObservedColor(e.target.value)} className="w-4 h-4 opacity-0 absolute inset-0 cursor-pointer" />
                                                            <span className="text-[10px] font-bold text-slate-400 uppercase">Obs.</span>
                                                        </div>
                                                    </>
                                                )}
                                                {/* Rates Color */}
                                                <div className="flex items-center space-x-1 relative group" title="Rates Plot Color">
                                                    <div className="w-4 h-4 rounded-full border border-slate-200 dark:border-slate-700 pointer-events-none" style={{ backgroundColor: ratesColor }}></div>
                                                    <input type="color" value={ratesColor} onChange={(e) => handleUpdateRatesColor(e.target.value)} className="w-4 h-4 opacity-0 absolute inset-0 cursor-pointer" />
                                                    <span className="text-[10px] font-bold text-slate-400 uppercase">{currentAnalysis.analysis_type === 'hetNOE' ? 'Ratio' : 'Rates'}</span>
                                                </div>
                                            </div>
                                            {selectedPeak && currentAnalysis.analysis_type !== 'hetNOE' && (
                                                <div className="flex items-center space-x-6 border-l border-slate-200 dark:border-slate-700 pl-4">
                                                    <div className="text-right">
                                                        <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest leading-none">Reduced χ²</p>
                                                        <p className="text-xs font-mono font-bold dark:text-white mt-1">{selectedPeak.redchi.toFixed(3)}</p>
                                                    </div>
                                                    {selectedPeak.rmse !== undefined && (
                                                        <div className="text-right pl-4 border-l border-slate-100 dark:border-slate-800">
                                                            <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest leading-none">RMSE</p>
                                                            <p className="text-xs font-mono font-bold text-emerald-600 dark:text-emerald-400 mt-1">{selectedPeak.rmse.toExponential(2)}</p>
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                {currentAnalysis.analysis_type !== 'hetNOE' && (
                                    <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-100 dark:border-slate-800 p-8 flex flex-col justify-center min-h-[500px] shadow-sm relative overflow-hidden">
                                        <div className="absolute top-0 right-0 p-4 opacity-5 pointer-events-none">
                                            <ActivityIcon className="w-64 h-64 text-slate-900 dark:text-white" />
                                        </div>
                                        {selectedPeak ? (
                                             <Plot
                                                data={[
                                                    {
                                                        x: selectedPeak.times,
                                                        y: selectedPeak.intensities,
                                                        type: 'scatter',
                                                        mode: 'markers' as 'markers',
                                                         name: 'Observed',
                                                         marker: { color: observedColor, size: 12, line: { color: 'white', width: 2 } },
                                                         error_y: {
                                                            type: 'data' as 'data',
                                                            array: selectedPeak.intensities_err || [],
                                                            visible: true,
                                                            color: observedColor,
                                                            thickness: 1,
                                                            width: 3
                                                         }
                                                     },
                                                    // Shaded Uncertainty Region
                                                    ...(selectedPeak.fit_times_dense && selectedPeak.fit_uncertainty_dense ? [
                                                        {
                                                            x: [...selectedPeak.fit_times_dense, ...[...selectedPeak.fit_times_dense].reverse()],
                                                            y: [
                                                                ...selectedPeak.fit_intensities_dense!.map((v, i) => v + selectedPeak.fit_uncertainty_dense![i]),
                                                                ...[...selectedPeak.fit_intensities_dense!.map((v, i) => v - selectedPeak.fit_uncertainty_dense![i])].reverse()
                                                            ],
                                                            fill: 'toself',
                                                            fillcolor: `${plotColor}33`, // Add alpha for shading
                                                            line: { color: 'transparent' },
                                                            name: 'Confidence Interval',
                                                            showlegend: false,
                                                            type: 'scatter' as 'scatter'
                                                        }
                                                     ] : []),
                                                     {
                                                         x: selectedPeak.fit_times_dense || Array.from({length: 100}, (_, i) => Math.min(...selectedPeak.times) + i * (Math.max(...selectedPeak.times) - Math.min(...selectedPeak.times)) / 99),
                                                         y: selectedPeak.fit_intensities_dense || Array.from({length: 100}, (_, i) => {
                                                             const t = Math.min(...selectedPeak.times) + i * (Math.max(...selectedPeak.times) - Math.min(...selectedPeak.times)) / 99;
                                                             return selectedPeak.amplitude * Math.exp(-selectedPeak.rate * t);
                                                         }),
                                                         type: 'scatter' as 'scatter',
                                                         mode: 'lines' as 'lines',
                                                         name: 'Model Fit',
                                                         line: { color: plotColor, width: 4, shape: 'spline' as 'spline' },
                                                     }
                                                 ] as any[]}
                                                layout={{
                                                    margin: { l: 80, r: 40, b: 80, t: 40 },
                                                    xaxis: { 
                                                        title: { text: 'Relaxation Delay (ms)', font: { size: 12, weight: 900, family: 'Inter, sans-serif' }, standoff: 20 },
                                                        gridcolor: PLOT_COLORS.gridDark,
                                                    },
                                                    yaxis: { 
                                                        title: { text: 'Peak Intensity', font: { size: 12, weight: 900, family: 'Inter, sans-serif' }, standoff: 20 },
                                                        gridcolor: PLOT_COLORS.gridDark,
                                                    },
                                                    legend: { 
                                                        x: 0.95, 
                                                        y: 0.95, 
                                                        xanchor: 'right', 
                                                        bgcolor: 'rgba(255,255,255,0.8)',
                                                        font: { weight: 600 }
                                                    },
                                                    hovermode: 'closest'
                                                }}
                                                style={{ width: "100%", height: "450px" }}
                                            />
                                        ) : (
                                            <div className="text-center space-y-4">
                                                <div className="w-16 h-16 bg-slate-50 dark:bg-slate-800 rounded-full flex items-center justify-center mx-auto">
                                                    <ActivityIcon className="w-8 h-8 text-slate-300" />
                                                </div>
                                                <p className="text-slate-400 font-bold text-sm tracking-widest uppercase">Select peak to view fit</p>
                                            </div>
                                        )}
                                    </div>
                                )}

                                    {/* New Rate vs Residue Plot below Profile */}
                                    <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-100 dark:border-slate-800 p-8 shadow-sm relative overflow-hidden">
                                         <div className="flex items-center space-x-2 mb-6">
                                            <BarChart2 className="w-5 h-5 text-indigo-500" />
                                            <h4 className="text-sm font-black text-slate-900 dark:text-white uppercase tracking-widest">{currentAnalysis.analysis_type === 'hetNOE' ? 'hetNOE Ratio' : currentAnalysis.analysis_type + ' Rates'} vs. Residue sequence</h4>
                                        </div>
                                        <Plot
                                            data={[{
                                                x: results.peak_results.filter(p => p.res_num != null && !excludedResidues.includes(p.assignment)).map(p => p.res_num as number),
                                                y: results.peak_results.filter(p => p.res_num != null && !excludedResidues.includes(p.assignment)).map(p => p.rate),
                                                error_y: {
                                                    type: 'data' as 'data',
                                                    array: results.peak_results.filter(p => p.res_num != null && !excludedResidues.includes(p.assignment)).map(p => p.rate_err),
                                                    visible: true,
                                                    color: ratesColor
                                                },
                                                type: 'scatter' as 'scatter',
                                                mode: 'markers' as 'markers',
                                                text: results.peak_results.filter(p => p.res_num != null && !excludedResidues.includes(p.assignment)).map(p => p.assignment),
                                                marker: { 
                                                    color: ratesColor, 
                                                    size: 10, 
                                                    line: { color: 'white', width: 2 } 
                                                },
                                            }] as any[]}
                                            layout={{
                                                margin: { l: 60, r: 20, b: 60, t: 20 },
                                                xaxis: { 
                                                    title: { text: 'Residue Number', font: { size: 10, weight: 800 } }, 
                                                    tickfont: { size: 9 }
                                                },
                                                yaxis: {                                                     title: { text: currentAnalysis.analysis_type === 'hetNOE' ? 'Ratio' : `Rate (s⁻¹)`, font: { size: 10, weight: 800 } }, 
                                                    tickfont: { size: 9 }
                                                },
                                                hovermode: 'closest'
                                            }}
                                            style={{ width: "100%", height: "350px" }}
                                        />
                                    </div>
                                </section>
                           </div>
                        </div>
                    ) : currentAnalysis.status === 'FAILED' ? (
                        <div className="text-center py-16 px-6 bg-rose-50/50 dark:bg-rose-950/20 rounded-[3rem] border-2 border-dashed border-rose-200 dark:border-rose-900/50 max-w-2xl mx-auto shadow-sm animate-in fade-in">
                            <div className="w-20 h-20 bg-rose-100 dark:bg-rose-900/40 rounded-full flex items-center justify-center mx-auto mb-6 shadow-inner text-rose-600 dark:text-rose-400">
                                <AlertCircle className="w-10 h-10" />
                            </div>
                            <h3 className="text-2xl font-black text-slate-900 dark:text-white mb-2">Analysis Execution Failed</h3>
                            <p className="text-rose-600 dark:text-rose-400 font-semibold text-sm max-w-lg mx-auto leading-relaxed bg-white dark:bg-slate-900 px-4 py-3 rounded-xl border border-rose-200 dark:border-rose-800 shadow-sm mt-3">
                                {currentAnalysis.error_message || "The fitting engine encountered an error while processing relaxation data."}
                            </p>

                            <div className="mt-6 text-left max-w-md mx-auto bg-slate-100/70 dark:bg-slate-800/60 p-4 rounded-xl text-xs text-slate-600 dark:text-slate-300 space-y-1.5 border border-slate-200/60 dark:border-slate-700/60">
                                <p className="font-bold text-slate-800 dark:text-slate-200 mb-1">Troubleshooting suggestions:</p>
                                <p>• Ensure the reference spectrum has completed peak-fitting with valid assignments.</p>
                                <p>• For R1/T1: Ensure a valid VD List (variable delays) is configured in Spectra settings.</p>
                                <p>• For R2/T2: Ensure VC List (loop counts) and Delay are configured in Spectra settings.</p>
                                <p>• Verify that delay count matches the number of planes in pseudo-3D spectra.</p>
                            </div>

                            <div className="mt-8 flex items-center justify-center gap-4">
                                <button
                                    onClick={() => setActiveTab('log')}
                                    className="px-6 py-2.5 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-750 text-slate-700 dark:text-slate-200 rounded-xl text-xs font-bold border border-slate-200 dark:border-slate-700 shadow-sm transition-all"
                                >
                                    View Analysis Log
                                </button>
                                <button
                                    onClick={() => setShowRerunWarning(true)}
                                    className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold shadow-md shadow-indigo-600/20 transition-all active:scale-95"
                                >
                                    Rerun Analysis
                                </button>
                            </div>
                        </div>
                    ) : currentAnalysis.status === 'RUNNING' ? (
                        <div className="text-center py-24 bg-slate-50 dark:bg-slate-900/50 rounded-[4rem] border-4 border-dashed border-slate-200 dark:border-slate-800">
                            <div className="w-24 h-24 bg-white dark:bg-slate-800 rounded-full flex items-center justify-center mx-auto mb-8 shadow-xl">
                                <Clock className="w-12 h-12 text-blue-500 animate-pulse" />
                            </div>
                            <h3 className="text-2xl font-black text-slate-900 dark:text-white mb-4">Fitting Engine Active</h3>
                            <p className="text-slate-500 text-sm max-w-sm mx-auto leading-relaxed">
                                The high-performance calculation engine is currently processing your relaxation data. 
                                <br/><span className="mt-2 block font-bold text-blue-600 dark:text-indigo-400 uppercase tracking-widest text-[10px]">Parallel Workers: {workers}</span>
                            </p>
                            <div className="mt-10 flex justify-center space-x-2">
                                <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce [animation-delay:-0.3s]"></div>
                                <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce [animation-delay:-0.15s]"></div>
                                <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce"></div>
                            </div>
                        </div>
                    ) : (
                        <div className="text-center py-24 bg-slate-50 dark:bg-slate-900/50 rounded-[4rem] border-4 border-dashed border-slate-200 dark:border-slate-800">
                            <div className="w-24 h-24 bg-white dark:bg-slate-800 rounded-full flex items-center justify-center mx-auto mb-8 shadow-xl text-indigo-500">
                                <ActivityIcon className="w-12 h-12" />
                            </div>
                            <h3 className="text-2xl font-black text-slate-900 dark:text-white mb-3">Analysis Ready</h3>
                            <p className="text-slate-500 text-sm max-w-sm mx-auto leading-relaxed mb-8">
                                Spectra are selected. Click "Run Analysis" to start the relaxation fitting job.
                            </p>
                            <button
                                onClick={handleRunAnalysis}
                                disabled={isLoading || currentAnalysis.spectra.length === 0}
                                className="px-8 py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl shadow-lg shadow-indigo-600/20 text-xs font-black uppercase tracking-widest transition-all"
                            >
                                Run Analysis
                            </button>
                        </div>
                    )}
                </div>
            )}

            {activeTab === 'log' && (
                <div className="animate-in slide-in-from-bottom-2 duration-500">
                    <div className="bg-slate-900 rounded-[2.5rem] p-10 font-mono text-sm overflow-hidden border border-slate-800 shadow-2xl relative">
                        <div className="flex items-center justify-between mb-8 border-b border-slate-800 pb-6">
                            <div className="flex items-center space-x-4">
                                <div className={`w-3 h-3 rounded-full ${currentAnalysis.status === 'RUNNING' ? 'bg-amber-500 animate-pulse' : currentAnalysis.status === 'FAILED' ? 'bg-rose-500' : 'bg-emerald-500'}`}></div>
                                <span className="text-slate-400 text-xs font-bold uppercase tracking-wider">
                                    {currentAnalysis.analysis_type} Relaxation Log
                                </span>
                                <span className={`text-[10px] font-black uppercase px-2 py-0.5 rounded ${currentAnalysis.status === 'COMPLETED' ? 'bg-emerald-900/50 text-emerald-400' : currentAnalysis.status === 'FAILED' ? 'bg-rose-900/50 text-rose-400' : 'bg-blue-900/50 text-blue-400'}`}>
                                    {currentAnalysis.status}
                                </span>
                            </div>
                            <div className="flex items-center space-x-3">
                                {logs && (
                                    <button
                                        onClick={handleCopyLogs}
                                        className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs flex items-center gap-1.5 transition-colors"
                                    >
                                        {copiedLogs ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                                        <span>{copiedLogs ? 'Copied' : 'Copy Log'}</span>
                                    </button>
                                )}
                                <span className="text-emerald-500/40 text-[10px] font-black tracking-[0.2em] flex items-center">
                                    <div className="w-1 h-1 bg-emerald-500 rounded-full mr-3 animate-ping"></div>
                                    STREAMING_STDOUT
                                </span>
                            </div>
                        </div>

                        {currentAnalysis.error_message && (
                            <div className="mb-6 p-4 bg-rose-950/40 border border-rose-800/60 rounded-xl text-rose-300 text-xs font-mono">
                                <span className="font-bold text-rose-400">Error: </span>
                                {currentAnalysis.error_message}
                            </div>
                        )}

                        <div className="max-h-[500px] overflow-y-auto custom-scrollbar-terminal pr-6">
                            <pre className="text-emerald-500/80 leading-loose whitespace-pre-wrap">
                                {logs || (currentAnalysis.status === 'PENDING' ? "> Machine ready.\n> Waiting for user analysis execution... " : `> Job: ${currentAnalysis.analysis_uuid}\n> Waiting for log output...`)}
                            </pre>
                            {currentAnalysis.status === 'RUNNING' && (
                                <div className="mt-6 flex items-center text-slate-500 font-bold italic">
                                    <span className="animate-pulse mr-3 text-emerald-500">_</span>
                                    <span className="text-xs uppercase tracking-widest">Fitting peaks in parallel via Celery worker...</span>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
      </div>

      {showRerunWarning && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-300">
          <div className="bg-white dark:bg-slate-800 rounded-3xl p-8 max-w-md w-full shadow-2xl border border-slate-200 dark:border-slate-700 animate-in zoom-in-95 duration-300 relative">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center space-x-4">
                <div className="p-3 bg-amber-50 dark:bg-amber-900/20 rounded-2xl text-amber-600">
                  <AlertCircle className="w-8 h-8" />
                </div>
                <h3 className="text-xl font-bold text-slate-900 dark:text-white">Rerun Analysis?</h3>
              </div>
              <button
                onClick={() => setShowRerunWarning(false)}
                className="p-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700/50 rounded-xl transition-colors"
                title="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {error && (
              <div className="mb-6 p-4 bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-900 rounded-xl flex items-start space-x-3 text-red-700 dark:text-red-300 text-sm animate-in shake shadow-sm">
                <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                <div className="flex-1 font-medium leading-relaxed">{error}</div>
              </div>
            )}

            <p className="text-slate-600 dark:text-slate-400 mb-8 leading-relaxed">
              This will overwrite your current results with a new run. A backup of the current results will be created, but any older backups will be permanently deleted.
            </p>
            <div className="flex items-center space-x-4">
              <button
                onClick={() => setShowRerunWarning(false)}
                className="flex-1 px-6 py-3 font-bold text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700/50 rounded-xl transition-all"
              >
                Cancel
              </button>
              <button
                onClick={handleRunAnalysis}
                disabled={isLoading}
                className="flex-1 px-6 py-3 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white font-bold rounded-xl shadow-lg shadow-amber-600/20 transition-all flex items-center justify-center space-x-2"
              >
                {isLoading && <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-1"></div>}
                <span>{isLoading ? 'Starting...' : 'Start Rerun'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AnalysisManager;
