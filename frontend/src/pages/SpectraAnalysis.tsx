import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../services/api';
import FileBrowserModal from '../components/FileBrowserModal';
import Plot, { PLOT_COLORS } from '../components/Plot';
import { useTheme } from '../context/ThemeContext';
import nmrSpectraDark from '../assets/nmr_spectra_dark.jpg';
import nmrSpectraLight from '../assets/nmr_spectra_light.jpg';
import atomSpinDark from '../assets/atom_spin_dark.jpg';
import atomSpinLight from '../assets/atom_spin_light.jpg';
import peakFittingDark from '../assets/peak_fitting_dark.jpg';
import peakFittingLight from '../assets/peak_fitting_light.jpg';
import terminalLogsDark from '../assets/terminal_logs_dark.jpg';
import terminalLogsLight from '../assets/terminal_logs_light.jpg';
import { 
  ArrowLeft, 
  Save, 
  Activity,
  Search,
  Play,
  Download,
  ChevronDown,
  ChevronUp,
  Loader2,
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';

interface SpectrumData {
  xs_pos: (number | null)[];
  ys_pos: (number | null)[];
  xs_neg: (number | null)[];
  ys_neg: (number | null)[];
  xlabel: string;
  ylabel: string;
  estimated_noise: number;
}

interface FitResultRow {
  assignment?: string;
  amp?: number;
  amp_err?: number;
  center_x_ppm?: number;
  center_y_ppm?: number;
  fwhm_x_hz?: number;
  fwhm_y_hz?: number;
  height?: number;
  height_err?: number;
  clustid?: number;
  memcnt?: number;
  plane?: number;
  lineshape?: string;
  chisqr?: number;
  redchi?: number;
  residual_sum?: number;
  aic?: number;
  x_radius?: number;
  y_radius?: number;
  x_linewidth_hz?: number;
  y_linewidth_hz?: number;
  prefix?: string;
  intensity?: number;
  [key: string]: any;
}

interface FittingSummary {
  total_peaks_fitted: number;
  total_clusters: number;
  total_planes: number;
  avg_chisqr: number;
  avg_redchi?: number;
  redchi_plane0?: number;
  lineshape_used: string;
  fit_method_used: string;
}

const SpectraAnalysis: React.FC = () => {
  const { projectUuid, spectrumUuid } = useParams<{ projectUuid: string, spectrumUuid: string }>();
  const navigate = useNavigate();
  useAuth();
  const { theme } = useTheme();
  const isDarkTheme = theme === 'dark';
  const nmrSpectraIcon = isDarkTheme ? nmrSpectraDark : nmrSpectraLight;
  const atomSpinIcon = isDarkTheme ? atomSpinDark : atomSpinLight;
  const peakFittingIcon = isDarkTheme ? peakFittingDark : peakFittingLight;
  const terminalLogsIcon = isDarkTheme ? terminalLogsDark : terminalLogsLight;
  
  const [spectrum, setSpectrum] = useState<any>(null);
  const [spectrumData, setSpectrumData] = useState<SpectrumData | null>(null);
  
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  
  const [isFileBrowserOpen, setIsFileBrowserOpen] = useState(false);
  const [activeBrowserField, setActiveBrowserField] = useState<'peaklist' | 'vclist' | 'vdlist' | 'f3list'>('peaklist');
  
  const [activeTab, setActiveTab] = useState<'general' | 'viewer' | 'fitting' | 'logs'>('general');
  
  // Contour parameters (Plotly interactive)
  const [baseLevel, setBaseLevel] = useState<number>(0);
  const [multiplier, setMultiplier] = useState<number>(1.4);
  const [numContours, setNumContours] = useState<number>(20);
  
  const [formData, setFormData] = useState({
    experiment_type: '',
    peaklist_path: '',
    vclist_path: '',
    vdlist_path: '',
    f3list_path: '',
    delay: null as number | string | null,
    t_relax: null as number | string | null,
    b1: null as number | string | null,
    b0: null as number | string | null,
    temperature: null as number | string | null,
    carrier: null as number | string | null,
    hetnoe_mode: ''
  });
  const [showRerunWarning, setShowRerunWarning] = useState(false);

  // Peak Fitting state
  const [fitConfig, setFitConfig] = useState({
    peaklist_format: 'csv',
    x_radius_ppm: 0.04,
    y_radius_ppm: 0.4,
    lineshape: 'PV',
    fit_method: 'leastsq',
    clustering_method: 'auto',
    struc_el: 'disk',
    struc_size: [3],
    noise: null as number | null,
    max_cluster_size: null as number | null,
    to_fix: ['fraction', 'sigma', 'center'],
    processors: 4,
    use_persistent_peaktable: false,
  });
  const [isFitting, setIsFitting] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => localStorage.getItem('resoFlow_sidebar_collapsed') === 'true');
  const [activeJob, setActiveJob] = useState<any>(null);
  const [jobLogs, setJobLogs] = useState<string>('');
  const [fitResults, setFitResults] = useState<FitResultRow[]>([]);
  const [fitSummary, setFitSummary] = useState<FittingSummary | null>(null);
  const [fitLog, setFitLog] = useState('');
  const [fitError, setFitError] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [sortCol, setSortCol] = useState<string>('assignment');
  const [sortAsc, setSortAsc] = useState(true);

  // Peak positions for plot overlay
  const [peakPositions, setPeakPositions] = useState<any[]>([]);
  const [selectedPeakIndices, setSelectedPeakIndices] = useState<number[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Plot zooming state
  const [plotXRange, setPlotXRange] = useState<[number, number] | null>(null);
  const [plotYRange, setPlotYRange] = useState<[number, number] | null>(null);
  const [dragMode, setDragMode] = useState<any>('zoom');
  const lastSelectionTime = useRef(0);

  // Memoize plot data and layout for stability
  const isDark = document.documentElement.classList.contains('dark');
  const selectedPeakIndicesSet = useMemo(() => new Set(selectedPeakIndices), [selectedPeakIndices]);

  const plotTraces = useMemo(() => {
    if (!spectrumData) return [];
    const traces: any[] = [
      {
        x: spectrumData.xs_pos, y: spectrumData.ys_pos,
        mode: 'lines', type: 'scattergl',
        line: { width: 0.6, color: PLOT_COLORS.primary },
        name: 'Positive', hoverinfo: 'skip' as any,
      },
      {
        x: spectrumData.xs_neg, y: spectrumData.ys_neg,
        mode: 'lines', type: 'scattergl',
        line: { width: 0.6, color: PLOT_COLORS.secondary },
        name: 'Negative', hoverinfo: 'skip' as any,
      },
    ];

    if (peakPositions.length > 0) {
      const peakXs = peakPositions.map(p => p.X_PPM);
      const peakYs = peakPositions.map(p => p.Y_PPM);
      const peakLabels = peakPositions.map(p => p.ASS || '');
      traces.push({
        x: peakXs, y: peakYs,
        mode: 'markers+text',
        type: 'scatter',
        marker: { 
          color: PLOT_COLORS.success, 
          size: 6, 
          symbol: 'cross', 
          line: { width: 1, color: isDark ? '#10b981' : '#065f46' } 
        },
        selected: {
          marker: { color: PLOT_COLORS.warning, size: 10 }
        },
        unselected: {
          marker: { opacity: 0.6 }
        },
        text: peakLabels,
        textposition: 'top center',
        textfont: { 
          size: 11, 
          color: isDark ? '#f1f5f9' : '#374151', 
          weight: 'bold' 
        },
        name: 'Peaks',
        selectedpoints: selectedPeakIndices,
        hovertemplate: '%{text}<br>X: %{x:.4f} ppm<br>Y: %{y:.4f} ppm<extra></extra>',
      });
    }
    return traces;
  }, [spectrumData, peakPositions, selectedPeakIndices, isDark]);

  const plotLayout = useMemo(() => ({
    margin: { l: 60, r: 30, t: 30, b: 60 },
    xaxis: {
      title: { text: spectrumData?.xlabel || '' },
      range: plotXRange || undefined,
      autorange: plotXRange ? (false as any) : ('reversed' as any),
      showgrid: false,
    },
    yaxis: {
      title: { text: spectrumData?.ylabel || '' },
      range: plotYRange || undefined,
      autorange: plotYRange ? (false as any) : ('reversed' as any),
      showgrid: false,
    },
    dragmode: dragMode,
    shapes: peakPositions.map((p, i) => ({
      type: 'circle' as const,
      xref: 'x' as const, yref: 'y' as const,
      x0: (p.X_PPM || 0) - (p.X_RADIUS_PPM || (fitConfig?.x_radius_ppm || 0.02)),
      x1: (p.X_PPM || 0) + (p.X_RADIUS_PPM || (fitConfig?.x_radius_ppm || 0.02)),
      y0: (p.Y_PPM || 0) - (p.Y_RADIUS_PPM || (fitConfig?.y_radius_ppm || 0.2)),
      y1: (p.Y_PPM || 0) + (p.Y_RADIUS_PPM || (fitConfig?.y_radius_ppm || 0.2)),
      line: { 
        color: selectedPeakIndicesSet.has(i) ? `${PLOT_COLORS.warning}b3` : `${PLOT_COLORS.success}59`, 
        width: 1, 
        dash: 'dot' as const 
      },
      fillcolor: selectedPeakIndicesSet.has(i) ? `${PLOT_COLORS.warning}33` : `${PLOT_COLORS.success}26`,
    })),
    uirevision: 'constant',
  }), [spectrumData, plotXRange, plotYRange, dragMode, peakPositions, selectedPeakIndicesSet, fitConfig]);

  // Cluster fit inspection (3D plots)
  const [clusterFitData, setClusterFitData] = useState<any>(null);
  const [isFittingCluster, setIsFittingCluster] = useState(false);
  const [clusterFitError, setClusterFitError] = useState('');

  // Helper to render the 3-plot contour view
  const renderContourComparison = (data: any) => {
    if (!data) return null;

    // Flatten data to find global min/max for color scale synchronization
    const allValues: number[] = [];
    [data.experimental, data.model, data.residuals].forEach(grid => {
      if (grid) {
        grid.forEach((row: (number | null)[]) => {
          row.forEach(val => {
            if (val !== null && !isNaN(val)) allValues.push(val);
          });
        });
      }
    });

    let zmin = 0;
    let zmax = 1;
    if (allValues.length > 0) {
      zmin = allValues[0];
      zmax = allValues[0];
      for (let i = 1; i < allValues.length; i++) {
        const v = allValues[i];
        if (v < zmin) zmin = v;
        if (v > zmax) zmax = v;
      }
    }

    const plotTypes = [
      { key: 'experimental', title: 'Experimental' },
      { key: 'model', title: 'Model' },
      { key: 'residuals', title: 'Residuals' }
    ];

    return (
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 p-4 bg-slate-50 dark:bg-slate-900/50">
        {plotTypes.map((pt, idx) => (
          <div key={pt.key} className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-2">
            <h5 className="text-xs font-bold text-center mb-2 text-slate-700 dark:text-slate-300 uppercase tracking-wider">{pt.title}</h5>
            <Plot
              data={[{
                z: data[pt.key],
                x: data.x_ppm,
                y: data.y_ppm,
                type: 'contour',
                contours: { coloring: 'fill' },
                colorscale: pt.key === 'residuals' ? 'RdBu' : 'Viridis',
                reversescale: pt.key === 'residuals',
                zmin: zmin,
                zmax: zmax,
                showscale: idx === 2, // Only show colorbar on the last one
                colorbar: idx === 2 ? {
                  thickness: 15,
                  len: 0.8,
                  tickfont: { size: 8 }
                } : undefined
              },
              // Add peak markers ('x') and labels for Experimental and Model plots
              ...(idx < 2 && data.peak_annotations ? [{
                x: data.peak_annotations.map((p: any) => p.x_ppm),
                y: data.peak_annotations.map((p: any) => p.y_ppm),
                text: data.peak_annotations.map((p: any) => p.label),
                mode: 'markers+text',
                type: 'scatter',
                textposition: 'top right',
                textfont: {
                  family: 'Inter, sans-serif',
                  size: 10,
                  color: 'white'
                },
                marker: { 
                  symbol: 'x', 
                  color: 'white', 
                  size: 8,
                  line: { width: 1, color: 'black' }
                },
                hoverinfo: 'text',
                showlegend: false
              }] : [])
              ] as any}
              layout={{
                margin: { l: 40, r: 20, t: 40, b: 40 },
                xaxis: { title: { text: 'HN (ppm)', font: { size: 10 } }, autorange: 'reversed' as const, tickfont: { size: 9 } },
                yaxis: { title: { text: '15N (ppm)', font: { size: 10 } }, autorange: 'reversed' as const, tickfont: { size: 9 } },
              }}
              style={{ width: '100%', height: '350px' }}
            />
          </div>
        ))}
      </div>
    );
  };


  useEffect(() => {
    fetchSpectrumInfo();
  }, [projectUuid, spectrumUuid]);

  useEffect(() => {
    if (activeTab === 'viewer') {
      fetchSpectrumData();
    }
  }, [activeTab]);

  useEffect(() => {
    let interval: any;
    if (activeJob && (activeJob.status === 'RUNNING' || activeJob.status === 'PENDING')) {
      interval = setInterval(async () => {
        try {
          const response = await api.get(`/api/projects/${projectUuid}/spectra/${spectrumUuid}/fitting/jobs/${activeJob.id}`);
          setActiveJob(response.data);
          
          // Also fetch logs
          const logResponse = await api.get(`/api/projects/${projectUuid}/spectra/${spectrumUuid}/fitting/jobs/${activeJob.id}/logs`);
          if (logResponse.data && logResponse.data.logs) {
            setJobLogs(logResponse.data.logs);
          }
          
          if (response.data.status === 'COMPLETED') {
            clearInterval(interval);
            fetchFittingResults();
          } else if (response.data.status === 'FAILED') {
            clearInterval(interval);
            setFitError('Background job failed. Check logs for details.');
          }
        } catch (err) {
          console.error("Error polling job status", err);
        }
      }, 3000);
    }
    return () => clearInterval(interval);
  }, [activeJob?.id, activeJob?.status, projectUuid, spectrumUuid]);

  const flattenFittingResults = (results: any[]) => {
    if (!results || results.length === 0) return [];
    
    // Check if it's already flat (V1 format)
    if (!results[0].planes) return results;

    // Flatten V2 format (nested)
    const flattened: FitResultRow[] = [];
    results.forEach(peak => {
      if (peak.planes && Array.isArray(peak.planes)) {
        const { planes, ...staticData } = peak;
        planes.forEach((planeData: any) => {
          flattened.push({ ...staticData, ...planeData } as FitResultRow);
        });
      } else {
        flattened.push(peak as FitResultRow);
      }
    });
    return flattened;
  };

  const fetchFittingResults = async () => {
    try {
      setIsFitting(true);
      console.log(`Fetching results for project ${projectUuid}, spectrum ${spectrumUuid}`);
      const response = await api.get(`/api/projects/${projectUuid}/spectra/${spectrumUuid}/fitting/results`);
      console.log("Results response:", response.data);
      const flattened = flattenFittingResults(response.data.results || []);
      setFitResults(flattened);
      setFitSummary(response.data.summary || null);
      setFitLog(response.data.log || '');
      
      if (flattened.length > 0) {
        setActiveTab('fitting');
      }
    } catch (err: any) {
      console.error("Failed to load existing fitting results", err);
      setError(err.response?.data?.detail || "Failed to load fitting results.");
    } finally {
      setIsFitting(false);
    }
  };

  const fetchLatestJob = async () => {
    try {
      console.log(`Fetching latest job for project ${projectUuid}, spectrum ${spectrumUuid}`);
      const response = await api.get(`/api/projects/${projectUuid}/spectra/${spectrumUuid}/fitting/latest-job`);
      console.log("Latest job response:", response.data);
      setActiveJob(response.data);
      
      // If the job is ongoing or completed, we might want to see logs
      const logResponse = await api.get(`/api/projects/${projectUuid}/spectra/${spectrumUuid}/fitting/jobs/${response.data.id}/logs`);
      if (logResponse.data && logResponse.data.logs) {
        setJobLogs(logResponse.data.logs);
      }

      // If finished, also load results
      if (response.data.status === 'COMPLETED') {
        fetchFittingResults();
      }
    } catch (err: any) {
      // 404 is expected if no jobs exist, others are errors
      if (err.response?.status !== 404) {
        console.error("Failed to fetch latest job", err);
        setError(err.response?.data?.detail || "Failed to recover latest job status.");
      } else {
        console.log("No previous jobs found for this spectrum");
      }
    }
  };

  const fetchSpectrumInfo = async () => {
    try {
      setIsLoading(true);
      // Fetch project instead of single spectrum since we don't have a GET /spectra/{id} yet
      const response = await api.get(`/api/projects/${projectUuid}`);
      const spec = response.data.spectra.find((s: any) => s.spectrum_uuid === spectrumUuid);
      if (!spec) {
        throw new Error("Spectrum not found");
      }
      setSpectrum(spec);
      setFormData({
        experiment_type: spec.experiment_type || '',
        peaklist_path: spec.peaklist_path || '',
        vclist_path: spec.vclist_path || '',
        vdlist_path: spec.vdlist_path || '',
        f3list_path: spec.f3list_path || '',
        delay: spec.delay ?? null,
        t_relax: spec.t_relax ?? null,
        b1: spec.b1 ?? null,
        b0: spec.b0 ?? null,
        temperature: spec.temperature ?? null,
        carrier: spec.carrier ?? null,
        hetnoe_mode: spec.hetnoe_mode || ''
      });

      if (spec.is_fitted) {
        await fetchFittingResults();
      }
      
      // Always try to fetch latest job to show status/logs
      await fetchLatestJob();
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Failed to load spectrum info.');
    } finally {
      setIsLoading(false);
    }
  };

  const fetchSpectrumData = async () => {
    try {
      setError('');
      setIsLoading(true);
      const url = `/api/projects/${projectUuid}/spectra/${spectrumUuid}/data?base_level=${baseLevel}&multiplier=${multiplier}&number_contours=${numContours}`;
      const response = await api.get(url);
      const data = response.data;
      setSpectrumData(data);
      
      // Sync baseLevel if it was 0 (auto-thresholded by backend)
      if (baseLevel === 0 && data.base_level) {
        setBaseLevel(data.base_level);
      }
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Failed to load spectrum data. Note: The database file_path might be invalid or nmrglue failed to parse it.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleNumericInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
    
    // Simple validation: allow empty, "-", ".", and valid numbers
    if (value && value !== '-' && value !== '.' && value !== '-.' && isNaN(Number(value))) {
      setFieldErrors(prev => ({ ...prev, [name]: 'Must be a valid number' }));
    } else {
      setFieldErrors(prev => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
    }
  };

  const handleSaveInfo = async () => {
    try {
      if (Object.keys(fieldErrors).length > 0) {
        setError('Please fix the formatting errors before saving.');
        return;
      }

      // Validation
      if (formData.experiment_type === 'T1' && !formData.vdlist_path) {
        setError('VD List Path is required for T1 experiment type.');
        return;
      }
      if (formData.experiment_type === 'T2') {
        if (!formData.vclist_path) {
          setError('VC List Path is required for T2 experiment type.');
          return;
        }
        if (formData.delay === null || formData.delay === '') {
          setError('Delay parameter is required for T2 experiment type.');
          return;
        }
      }
      if (formData.experiment_type === 'hetNOE' && !formData.hetnoe_mode) {
        setError('hetNOE sequence mode is required.');
        return;
      }
      if (formData.experiment_type === 'CPMG-RD') {
        if (!formData.vclist_path && !formData.vdlist_path) {
          setError('Either VC List Path (cycle counts) or VD List Path (frequencies/delays) is required for CPMG-RD.');
          return;
        }
        if (formData.t_relax === null || formData.t_relax === '') {
          setError('T-Relax parameter is required for CPMG-RD.');
          return;
        }
      }

      if (formData.experiment_type === 'CEST') {
        if (!formData.f3list_path) {
          setError('F3 List Path is required for CEST.');
          return;
        }
        if (formData.b1 === null || formData.b1 === '') {
          setError('B1 parameter is required for CEST.');
          return;
        }
      }

      setIsSaving(true);
      setError('');
      setSuccessMsg('');

      const payload = {
        ...formData,
        delay: formData.delay !== null && formData.delay !== '' ? parseFloat(String(formData.delay)) : null,
        t_relax: formData.t_relax !== null && formData.t_relax !== '' ? parseFloat(String(formData.t_relax)) : null,
        b1: formData.b1 !== null && formData.b1 !== '' ? parseFloat(String(formData.b1)) : null,
        b0: formData.b0 !== null && formData.b0 !== '' ? parseFloat(String(formData.b0)) : null,
        temperature: formData.temperature !== null && formData.temperature !== '' ? parseFloat(String(formData.temperature)) : null,
        carrier: formData.carrier !== null && formData.carrier !== '' ? parseFloat(String(formData.carrier)) : null,
      };

      const response = await api.put(`/api/projects/${projectUuid}/spectra/${spectrumUuid}`, payload);
      setSpectrum(response.data);
      setSuccessMsg('Spectrum information updated!');
      setTimeout(() => setSuccessMsg(''), 3000);
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Failed to save spectrum info.');
    } finally {
      setIsSaving(false);
    }
  };
  
  const openFileBrowser = (field: 'peaklist' | 'vclist' | 'vdlist' | 'f3list') => {
    setActiveBrowserField(field);
    setIsFileBrowserOpen(true);
  };

  const handleFileSelect = (path: string) => {
    if (activeBrowserField === 'peaklist') {
      setFormData(prev => ({ ...prev, peaklist_path: path }));
    } else if (activeBrowserField === 'vclist') {
      setFormData(prev => ({ ...prev, vclist_path: path }));
    } else if (activeBrowserField === 'vdlist') {
      setFormData(prev => ({ ...prev, vdlist_path: path }));
    } else if (activeBrowserField === 'f3list') {
      setFormData(prev => ({ ...prev, f3list_path: path }));
    }
    setIsFileBrowserOpen(false);
  };

  const loadPeaks = async () => {
    try {
      const payload = {
        peaklist_format: fitConfig.peaklist_format,
        x_radius_ppm: fitConfig.x_radius_ppm,
        y_radius_ppm: fitConfig.y_radius_ppm,
        clustering_method: fitConfig.clustering_method,
        struc_el: fitConfig.struc_el,
        struc_size: fitConfig.struc_size,
        use_persistent_peaktable: fitConfig.use_persistent_peaktable,
      };
      const response = await api.post(
        `/api/projects/${projectUuid}/spectra/${spectrumUuid}/fitting/preview-clusters`,
        payload
      );
      setPeakPositions(response.data.peaks || []);
      setSelectedPeakIndices([]);
      setFitError('');
    } catch (err: any) {
      console.warn('Could not load peaks:', err.response?.data?.detail || err.message);
      setFitError(err.response?.data?.detail || 'Could not load peaks from file. Make sure the peaklist path is correct.');
    }
  };

  const reclusterPeaks = async () => {
    try {
      // Send the currently customized peak positions and radii
      const payload = {
        peaks: peakPositions,
        peaklist_format: fitConfig.peaklist_format,
        dims: [0, 1, 2],
        clustering_method: fitConfig.clustering_method,
        struc_el: fitConfig.struc_el,
        struc_size: fitConfig.struc_size,
        use_persistent_peaktable: fitConfig.use_persistent_peaktable,
      };
      const response = await api.post(
        `/api/projects/${projectUuid}/spectra/${spectrumUuid}/fitting/recluster`,
        payload
      );
      setPeakPositions(response.data.peaks || []);
      setSelectedPeakIndices([]);
      setFitError('');
    } catch (err: any) {
      console.warn('Could not recluster peaks:', err.response?.data?.detail || err.message);
      setFitError(err.response?.data?.detail || 'Could not recluster peaks.');
    }
  };

  const renderPlot = () => {
    // If we have no data or data is effectively empty (filled with nulls), don't crash
    const hasValidData = spectrumData?.xs_pos && spectrumData.xs_pos.some((x: any) => x !== null);
    if (!spectrumData || !hasValidData) {
      return (
        <div className="flex flex-col items-center justify-center p-12 bg-slate-50 dark:bg-slate-900/50 rounded-2xl border-2 border-dashed border-slate-200 dark:border-slate-800">
           <Activity className="w-12 h-12 text-slate-300 dark:text-slate-700 mb-4" />
           <p className="text-slate-500 dark:text-slate-400 text-sm font-medium">No contours found at the current threshold.</p>
           <button onClick={() => setBaseLevel(prev => prev / 2)} className="mt-4 text-blue-600 dark:text-blue-400 text-xs font-bold hover:underline">
             Lower Threshold
           </button>
        </div>
      );
    }

    const inputClass = "w-full text-sm px-3 py-1.5 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-md focus:ring-1 focus:ring-blue-500 focus:border-blue-500 text-slate-800 dark:text-slate-200";
    const labelClass = "block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1";
    const sectionClass = "bg-slate-50 dark:bg-slate-800/50 p-4 rounded-xl border border-slate-200 dark:border-slate-700";

    const selectedPeaks = peakPositions.filter((_, i) => selectedPeakIndicesSet.has(i));
    const selectedPeak = selectedPeaks.length > 0 ? selectedPeaks[0] : null;

    return (
      <div className="flex flex-col gap-4">
        {/* Top row: sidebar + plot */}
        <div className="flex flex-col lg:flex-row gap-4">
          {/* Unified Sidebar — all controls in one scroll */}
          <div className="lg:w-[320px] space-y-3 flex-shrink-0 overflow-y-auto max-h-[calc(100vh-200px)]">
            {/* Plot Controls */}
            <div className={sectionClass}>
              <h4 className="text-sm font-semibold mb-2 text-slate-800 dark:text-slate-200">Plot Controls</h4>
              <div className="space-y-2">
                <div>
                  <div className="flex justify-between items-center mb-1">
                    <label className={labelClass}>Base Level Threshold</label>
                    {spectrumData?.estimated_noise && (
                      <button 
                        onClick={() => setBaseLevel(spectrumData.estimated_noise * 6.0)}
                        className="text-[10px] text-blue-600 hover:underline"
                      >
                        Auto (6σ)
                      </button>
                    )}
                  </div>
                  <input type="number" value={baseLevel} onChange={e => setBaseLevel(Number(e.target.value))} className={inputClass} />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className={labelClass}>Multiplier</label>
                    <input type="number" step="0.01" value={multiplier} onChange={e => setMultiplier(Number(e.target.value))} className={inputClass} />
                  </div>
                  <div>
                    <label className={labelClass}>Contours</label>
                    <input type="number" value={numContours} onChange={e => setNumContours(Number(e.target.value))} className={inputClass} />
                  </div>
                </div>
                <button onClick={fetchSpectrumData} disabled={isLoading}
                  className="w-full mt-1 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-xs font-medium py-1.5 px-3 rounded-md transition-colors">
                  {isLoading ? 'Updating...' : 'Update Plot'}
                </button>
              </div>
            </div>

            {/* Fitting Controls */}
            <div className={sectionClass}>
              <h4 className="text-sm font-semibold mb-2 text-slate-800 dark:text-slate-200">Peak Fitting</h4>
              <div className="space-y-2">
                <div>
                  <label className={labelClass}>
                    X Radius: {(selectedPeak ? (selectedPeak.X_RADIUS_PPM || fitConfig.x_radius_ppm) : fitConfig.x_radius_ppm).toFixed(3)} ppm 
                    {selectedPeakIndices.length > 1 && <span className="text-[10px] ml-1 opacity-70">({selectedPeakIndices.length} selected)</span>}
                  </label>
                  <input type="range" min="0.005" max="0.2" step="0.001" 
                    value={selectedPeak ? (selectedPeak.X_RADIUS_PPM || fitConfig.x_radius_ppm) : fitConfig.x_radius_ppm}
                    onChange={e => {
                      const val = parseFloat(e.target.value);
                      if (selectedPeakIndices.length > 0) {
                        setPeakPositions(prev => prev.map((p, i) => selectedPeakIndicesSet.has(i) ? { ...p, X_RADIUS_PPM: val } : p));
                      } else {
                        updateFitConfig('x_radius_ppm', val);
                      }
                    }}
                    className="w-full h-1.5 rounded-lg appearance-none cursor-pointer bg-slate-200 dark:bg-slate-700 accent-blue-600" />
                </div>
                <div>
                  <label className={labelClass}>
                    Y Radius: {(selectedPeak ? (selectedPeak.Y_RADIUS_PPM || fitConfig.y_radius_ppm) : fitConfig.y_radius_ppm).toFixed(2)} ppm
                    {selectedPeakIndices.length > 1 && <span className="text-[10px] ml-1 opacity-70">({selectedPeakIndices.length} selected)</span>}
                  </label>
                  <input type="range" min="0.05" max="2.0" step="0.01" 
                    value={selectedPeak ? (selectedPeak.Y_RADIUS_PPM || fitConfig.y_radius_ppm) : fitConfig.y_radius_ppm}
                    onChange={e => {
                      const val = parseFloat(e.target.value);
                      if (selectedPeakIndices.length > 0) {
                        setPeakPositions(prev => prev.map((p, i) => selectedPeakIndicesSet.has(i) ? { ...p, Y_RADIUS_PPM: val } : p));
                      } else {
                        updateFitConfig('y_radius_ppm', val);
                      }
                    }}
                    className="w-full h-1.5 rounded-lg appearance-none cursor-pointer bg-slate-200 dark:bg-slate-700 accent-blue-600" />
                </div>
                {peakPositions.length > 0 && (
                  <button onClick={() => {
                    const xRad = selectedPeak ? (selectedPeak.X_RADIUS_PPM || fitConfig.x_radius_ppm) : fitConfig.x_radius_ppm;
                    const yRad = selectedPeak ? (selectedPeak.Y_RADIUS_PPM || fitConfig.y_radius_ppm) : fitConfig.y_radius_ppm;
                    setPeakPositions(prev => prev.map(p => ({
                      ...p,
                      X_RADIUS_PPM: xRad,
                      Y_RADIUS_PPM: yRad,
                    })));
                    updateFitConfig('x_radius_ppm', xRad);
                    updateFitConfig('y_radius_ppm', yRad);
                  }} className="w-full text-xs py-1 bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 rounded-md transition-colors">
                    Apply to All Peaks
                  </button>
                )}

                <div className="pt-2 pb-2 border-b border-slate-200 dark:border-slate-700">
                  <label className="flex items-center gap-2 text-xs cursor-pointer text-slate-700 dark:text-slate-200 font-bold">
                    <input 
                      type="checkbox" 
                      checked={fitConfig.use_persistent_peaktable}
                      onChange={e => updateFitConfig('use_persistent_peaktable', e.target.checked)}
                      className="w-4 h-4 accent-indigo-600 rounded" 
                    />
                    Use persistent peaktable (JSON)
                  </label>
                  <p className="mt-1 text-[10px] text-slate-500 italic leading-tight">
                    If enabled, the app will load/save peaks from the JSON sidecar file instead of the source peaklist.
                    {spectrum?.peaktable_json_path && <span className="text-emerald-500 font-bold block mt-1">✓ Persistent file detected</span>}
                  </p>
                </div>

                <div><label className={labelClass}>Peaklist Format</label>
                  <select value={fitConfig.peaklist_format} onChange={e => updateFitConfig('peaklist_format', e.target.value)} className={inputClass}>
                    <option value="pipe">NMRPipe</option><option value="sparky">Sparky</option>
                    <option value="a2">Analysis v2</option><option value="a3">Analysis v3</option>
                    <option value="csv">CSV</option>
                  </select></div>
                <div className="grid grid-cols-2 gap-2">
                  <div><label className={labelClass}>Lineshape</label>
                    <select value={fitConfig.lineshape} onChange={e => updateFitConfig('lineshape', e.target.value)} className={inputClass}>
                      <option value="PV">Pseudo-Voigt</option><option value="G">Gaussian</option>
                      <option value="L">Lorentzian</option><option value="V">Voigt</option>
                      <option value="PV_PV">PV × PV</option>
                    </select></div>
                  <div><label className={labelClass}>Algorithm</label>
                    <select value={fitConfig.fit_method} onChange={e => updateFitConfig('fit_method', e.target.value)} className={inputClass}>
                      <option value="leastsq">L-M</option><option value="least_squares">Trust</option>
                      <option value="nelder">Nelder</option><option value="powell">Powell</option>
                    </select></div>
                </div>
                <div>
                  <label className={labelClass}>Clustering</label>
                  <div className="flex gap-3">
                    <label className="flex items-center gap-1 text-xs cursor-pointer text-slate-600 dark:text-slate-400">
                      <input type="radio" name="cluster_v" value="auto" checked={fitConfig.clustering_method === 'auto'}
                        onChange={() => updateFitConfig('clustering_method', 'auto')} className="accent-blue-600" /> Auto
                    </label>
                    <label className="flex items-center gap-1 text-xs cursor-pointer text-slate-600 dark:text-slate-400">
                      <input type="radio" name="cluster_v" value="mask" checked={fitConfig.clustering_method === 'mask'}
                        onChange={() => updateFitConfig('clustering_method', 'mask')} className="accent-blue-600" /> Mask
                    </label>
                  </div>
                  {fitConfig.clustering_method === 'auto' && (
                    <select value={fitConfig.struc_el} onChange={e => updateFitConfig('struc_el', e.target.value)} className={inputClass + ' mt-1'}>
                      <option value="disk">Disk</option><option value="square">Square</option><option value="rectangle">Rectangle</option>
                    </select>
                  )}
                </div>
              </div>
            </div>

            {/* Advanced (collapsible) */}
            <div className={sectionClass}>
              <button onClick={() => setShowAdvanced(!showAdvanced)}
                className="flex items-center justify-between w-full text-xs font-semibold text-slate-800 dark:text-slate-200">
                Advanced {showAdvanced ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </button>
              {showAdvanced && (
                <div className="mt-2 space-y-2">
                  <div><label className={labelClass}>Noise Level</label>
                    <input type="number" step="any" value={fitConfig.noise ?? ''}
                      onChange={e => updateFitConfig('noise', e.target.value ? parseFloat(e.target.value) : null)}
                      className={inputClass} placeholder="Auto" /></div>
                  <div><label className={labelClass}>Max Cluster Size</label>
                    <input type="number" value={fitConfig.max_cluster_size ?? ''}
                      onChange={e => updateFitConfig('max_cluster_size', e.target.value ? parseInt(e.target.value) : null)}
                      className={inputClass} placeholder="No limit" /></div>
                  <div><label className={labelClass}>Fix Params</label>
                    <div className="flex flex-wrap gap-2 mt-1">
                      {['fraction', 'sigma', 'center'].map(p => (
                        <label key={p} className="flex items-center gap-1 text-xs cursor-pointer text-slate-600 dark:text-slate-400">
                          <input type="checkbox" checked={fitConfig.to_fix.includes(p)}
                            onChange={() => toggleFixParam(p)} className="accent-blue-600 rounded" /> {p}
                        </label>
                      ))}
                    </div></div>
                  <div><label className={labelClass}>Processors (Celery Workers)</label>
                    <input type="number" min="1" max="32" value={fitConfig.processors}
                      onChange={e => updateFitConfig('processors', parseInt(e.target.value))}
                      className={inputClass} /></div>
                </div>
              )}
            </div>

            {/* Action Buttons */}
            <div className="flex gap-2">
              <button onClick={loadPeaks}
                className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium py-2 px-2 rounded-md transition-colors flex items-center justify-center gap-1.5">
                <Search className="w-3.5 h-3.5" /> Load Peaks
              </button>
              {peakPositions.length > 0 && (
                <button onClick={reclusterPeaks} disabled={isFitting}
                  className="flex-1 bg-slate-500 hover:bg-slate-600 text-white text-xs font-medium py-2 px-2 rounded-md transition-colors flex items-center justify-center gap-1.5">
                  <Play className="w-3.5 h-3.5" /> Re-cluster
                </button>
              )}
            </div>
            
            <div className="pt-2 pb-2 border-b border-slate-200 dark:border-slate-700">
              {peakPositions.length > 0 && (
                <button
                  onClick={async () => {
                    try {
                      setIsSaving(true);
                      await api.post(`/api/projects/${projectUuid}/spectra/${spectrumUuid}/fitting/recluster`, {
                        peaks: peakPositions,
                        peaklist_format: fitConfig.peaklist_format,
                        dims: [0, 1, 2],
                        clustering_method: fitConfig.clustering_method,
                        struc_el: fitConfig.struc_el,
                        struc_size: fitConfig.struc_size,
                      });
                      setSuccessMsg('Peaks saved to persistent JSON!');
                      setTimeout(() => setSuccessMsg(''), 3000);
                    } catch (err: any) {
                      setFitError('Failed to save peaks: ' + (err.response?.data?.detail || err.message));
                    } finally {
                      setIsSaving(false);
                    }
                  }}
                  disabled={isSaving}
                  className="w-full bg-indigo-50 border border-indigo-200 hover:bg-indigo-100 text-indigo-700 text-xs font-semibold py-2 px-4 rounded-lg transition-all flex items-center justify-center gap-2 shadow-sm"
                >
                  {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                  Save Peaks to JSON Sidecar
                </button>
              )}
            </div>
            
            {spectrum?.has_backup && (
              <button onClick={handleRestoreFitting} disabled={isFitting || isLoading}
                className="w-full mt-2 bg-blue-50 hover:bg-blue-100 dark:bg-blue-900/20 dark:hover:bg-blue-900/30 text-blue-600 dark:text-blue-400 text-[10px] font-black uppercase tracking-widest py-2 rounded-lg transition-all flex items-center justify-center gap-2">
                <Activity className="w-3 h-3" /> Restore Backup Fitting
              </button>
            )}
            
            <button 
              onClick={() => {
                if (spectrum?.is_fitted) setShowRerunWarning(true);
                else runFitting();
              }} 
              disabled={isFitting || peakPositions.length === 0}
              className="w-full mt-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 disabled:from-blue-400 disabled:to-indigo-400 text-white text-xs font-semibold py-2 px-4 rounded-lg transition-all flex items-center justify-center gap-2 shadow-sm">
              {isFitting ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Fitting All...</> : <><Play className="w-3.5 h-3.5" /> {spectrum?.is_fitted ? 'Rerun Fitting' : 'Fit All Clusters'}</>}
            </button>
            
            {/* Contextual Fit Selected Cluster Button */}
            {selectedPeak && selectedPeak.CLUSTID != null && (
              <button
                onClick={() => fitCluster(selectedPeak.CLUSTID)}
                disabled={isFittingCluster}
                className="w-full mt-2 bg-violet-600 hover:bg-violet-700 disabled:bg-violet-400 text-white text-xs font-medium py-2 px-4 rounded-lg transition-all flex items-center justify-center gap-2 shadow-sm">
                {isFittingCluster ? <><Loader2 className="w-3 h-3 animate-spin" /> Fitting...</> : <><Activity className="w-3 h-3" /> Fit Cluster {selectedPeak.CLUSTID} ({selectedPeaks.length} selected)</>}
              </button>
            )}

            {fitError && (
              <div className="mt-2 p-2 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded text-red-700 dark:text-red-400 text-xs flex items-start gap-1">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /> {fitError}
              </div>
            )}
            
            {peakPositions.length > 0 && (
              <div className="text-xs text-slate-500 dark:text-slate-400 text-center py-1">
                {peakPositions.length} peaks loaded
              </div>
            )}
          </div>

          {/* Plot + Reset Zoom */}
          <div className="flex-1 flex flex-col">
            <div className="flex justify-end mb-1 gap-2">
              <button 
                onClick={() => {
                  setPlotXRange(null);
                  setPlotYRange(null);
                  setSelectedPeakIndices([]);
                }}
                className="text-xs px-2.5 py-1 bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 rounded-md transition-colors"
              >
                Reset Zoom & Selection
              </button>
            </div>
            <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-2 rounded-xl flex items-center justify-center min-h-[500px] overflow-hidden">
              <Plot
                data={plotTraces}
                layout={plotLayout}
                style={{ width: '100%', height: '950px' }}
                onRelayout={(event: any) => {
                  if (event['dragmode']) {
                    setDragMode(event['dragmode']);
                  }
                  if (event['xaxis.range[0]'] !== undefined) {
                    setPlotXRange([event['xaxis.range[0]'], event['xaxis.range[1]']]);
                  }
                  if (event['yaxis.range[0]'] !== undefined) {
                    setPlotYRange([event['yaxis.range[0]'], event['yaxis.range[1]']]);
                  }
                  if (event['xaxis.autorange'] === true) {
                    setPlotXRange(null);
                    setPlotYRange(null);
                    setSelectedPeakIndices([]);
                  }
                }}
                onSelected={(event: any) => {
                  lastSelectionTime.current = Date.now();
                  if (event && event.points) {
                    const indices = event.points
                      .filter((pt: any) => pt.curveNumber === 2)
                      .map((pt: any) => pt.pointIndex)
                      .filter((idx: any) => idx != null);
                    setSelectedPeakIndices(indices);
                  }
                }}
                onClick={(data: any) => {
                  if (Date.now() - lastSelectionTime.current < 300) return;
                  if (data.points && data.points.length > 0) {
                    const pt = data.points[0];
                    if (pt.curveNumber === 2 && pt.pointIndex != null) {
                      setSelectedPeakIndices([pt.pointIndex]);
                      return;
                    }
                  }
                  setSelectedPeakIndices([]);
                }}
              />
            </div>
          </div>
        </div>

        {/* Peak List Table — full width below the plot */}
        {peakPositions.length > 0 && (
          <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden">
            <div className="px-4 py-2 bg-slate-50 dark:bg-slate-800/80 border-b border-slate-200 dark:border-slate-700">
              <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                Loaded Peaks ({peakPositions.length})
              </span>
            </div>
            <div className="overflow-auto max-h-[250px]">
              <table className="w-full text-xs">
                <thead className="bg-slate-100 dark:bg-slate-800 sticky top-0 z-10">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold text-slate-700 dark:text-slate-300">#</th>
                    <th className="px-3 py-2 text-left font-semibold text-slate-700 dark:text-slate-300">Res #</th>
                    <th className="px-3 py-2 text-left font-semibold text-slate-700 dark:text-slate-300">Res Name</th>
                    <th className="px-3 py-2 text-left font-semibold text-slate-700 dark:text-slate-300">Assignment</th>
                    <th className="px-3 py-2 text-left font-semibold text-slate-700 dark:text-slate-300">X (ppm)</th>
                    <th className="px-3 py-2 text-left font-semibold text-slate-700 dark:text-slate-300">Y (ppm)</th>
                    <th className="px-3 py-2 text-left font-semibold text-slate-700 dark:text-slate-300">X Radius</th>
                    <th className="px-3 py-2 text-left font-semibold text-slate-700 dark:text-slate-300">Y Radius</th>
                    <th className="px-3 py-2 text-left font-semibold text-slate-700 dark:text-slate-300">Cluster</th>
                    <th className="px-3 py-2 text-left font-semibold text-slate-700 dark:text-slate-300">Peaks</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {peakPositions.map((p, i) => (
                    <tr
                      key={i}
                      className={`cursor-pointer transition-colors ${
                        selectedPeakIndicesSet.has(i)
                          ? 'bg-amber-50 dark:bg-amber-900/20'
                          : 'hover:bg-blue-50/50 dark:hover:bg-blue-900/10'
                      }`}
                      onClick={() => {
                        setSelectedPeakIndices([i]);
                        const xr = (p.X_RADIUS_PPM || fitConfig.x_radius_ppm) * 8;
                        const yr = (p.Y_RADIUS_PPM || fitConfig.y_radius_ppm) * 8;
                        setPlotXRange([p.X_PPM + xr, p.X_PPM - xr]);
                        setPlotYRange([p.Y_PPM + yr, p.Y_PPM - yr]);
                      }}
                    >
                      <td className="px-3 py-1.5 text-slate-500">{i + 1}</td>
                      <td className="px-3 py-1.5 text-slate-700 dark:text-slate-300">{p.RES_NUM ?? '—'}</td>
                      <td className="px-3 py-1.5 text-slate-700 dark:text-slate-300">{p.RES_NAME ?? '—'}</td>
                      <td className="px-3 py-1.5 text-slate-700 dark:text-slate-300 font-medium">{p.ASS || '—'}</td>
                      <td className="px-1 py-1 text-slate-700 dark:text-slate-300">
                        <input type="number" step="0.001" className="w-16 bg-transparent border-b border-transparent focus:border-blue-500 focus:outline-none" 
                               value={p.X_PPM != null ? p.X_PPM.toFixed(4) : ''} 
                               onChange={e => {
                                 const val = parseFloat(e.target.value);
                                 setPeakPositions(prev => prev.map((item, idx) => idx === i ? { ...item, X_PPM: val } : item));
                               }} onClick={e => e.stopPropagation()} />
                      </td>
                      <td className="px-1 py-1 text-slate-700 dark:text-slate-300">
                        <input type="number" step="0.001" className="w-16 bg-transparent border-b border-transparent focus:border-blue-500 focus:outline-none" 
                               value={p.Y_PPM != null ? p.Y_PPM.toFixed(4) : ''} 
                               onChange={e => {
                                 const val = parseFloat(e.target.value);
                                 setPeakPositions(prev => prev.map((item, idx) => idx === i ? { ...item, Y_PPM: val } : item));
                               }} onClick={e => e.stopPropagation()} />
                      </td>
                      <td className="px-1 py-1 text-slate-700 dark:text-slate-300">
                        <input type="number" step="0.001" className="w-16 bg-transparent border-b border-transparent focus:border-blue-500 focus:outline-none" 
                               value={p.X_RADIUS_PPM != null ? p.X_RADIUS_PPM : fitConfig.x_radius_ppm} 
                               onChange={e => {
                                 const val = parseFloat(e.target.value);
                                 const clustId = p.CLUSTID;
                                 setPeakPositions(prev => prev.map(item => 
                                  (clustId != null && item.CLUSTID === clustId) ? { ...item, X_RADIUS_PPM: val } : item
                                 ));
                               }} onClick={e => e.stopPropagation()} />
                      </td>
                      <td className="px-1 py-1 text-slate-700 dark:text-slate-300">
                        <input type="number" step="0.01" className="w-16 bg-transparent border-b border-transparent focus:border-blue-500 focus:outline-none" 
                               value={p.Y_RADIUS_PPM != null ? p.Y_RADIUS_PPM : fitConfig.y_radius_ppm} 
                               onChange={e => {
                                 const val = parseFloat(e.target.value);
                                 const clustId = p.CLUSTID;
                                 setPeakPositions(prev => prev.map(item => 
                                  (clustId != null && item.CLUSTID === clustId) ? { ...item, Y_RADIUS_PPM: val } : item
                                 ));
                               }} onClick={e => e.stopPropagation()} />
                      </td>
                      <td className="px-3 py-1.5 text-slate-500">{p.CLUSTID ?? '—'}</td>
                      <td className="px-3 py-1.5 text-slate-500">{p.MEMCNT ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Fit Inspection — Reference-style contour plots */}
        {clusterFitData && (
          <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden">
            <div className="px-4 py-2 bg-slate-50 dark:bg-slate-800/80 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
              <div className="flex flex-col">
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  Plane={clusterFitData.plane_idx ?? 0}, Cluster={clusterFitData.cluster_id} · {clusterFitData.peak_annotations?.[0]?.lineshape || clusterFitData.lineshape || 'PV'}
                </span>
                <span className="text-[10px] text-slate-500">
                  {clusterFitData.fit_stats && `χ²: ${clusterFitData.fit_stats.chisqr?.toExponential(2)} · Reduced χ²: ${clusterFitData.fit_stats.redchi?.toExponential(2)} · AIC: ${clusterFitData.fit_stats.aic?.toFixed(2)}`}
                </span>
              </div>
              <button onClick={() => setClusterFitData(null)}
                className="text-xs text-slate-500 hover:text-red-500 transition-colors">✕ Close</button>
            </div>
            {renderContourComparison(clusterFitData)}
            
            {clusterFitData.peak_annotations && clusterFitData.peak_annotations.length > 0 && (
              <div className="px-4 py-3 bg-slate-50/50 dark:bg-slate-800/50 border-t border-slate-100 dark:border-slate-700">
                <h6 className="text-[10px] font-bold text-slate-400 uppercase mb-2">Peak Parameters</h6>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
                  {clusterFitData.peak_annotations.map((a: any, idx: number) => (
                    <div key={idx} className="bg-white dark:bg-slate-900 p-2 rounded border border-slate-200 dark:border-slate-700 shadow-sm">
                      <div className="text-[10px] font-bold text-blue-600 dark:text-blue-400 truncate">{a.label}</div>
                      <div className="text-[9px] text-slate-500 mt-0.5">Vol: {a.volume != null ? Number(a.volume).toExponential(2) : '—'}</div>
                      <div className="text-[9px] text-slate-500">H: {a.height != null ? Number(a.height).toExponential(2) : '—'}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {clusterFitError && (
          <div className="p-2 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded text-red-700 dark:text-red-400 text-xs flex items-start gap-1">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /> {clusterFitError}
          </div>
        )}
      </div>
    );
  };
  // --- Peak Fitting handlers ---

  const runFitting = async () => {
    try {
      setIsFitting(true);
      setFitResults([]);
      setFitLog('');
      setFitError('');
      setJobLogs('Starting background job...');
      setShowRerunWarning(false);

      const response = await api.post(
        `/api/projects/${projectUuid}/spectra/${spectrumUuid}/fitting/run`,
        {
          ...fitConfig,
          peaks: peakPositions.map(p => ({
            ...p,
            X_RADIUS_PPM: p.X_RADIUS_PPM,
            Y_RADIUS_PPM: p.Y_RADIUS_PPM,
            CLUSTID: p.CLUSTID
          })),
          use_persistent_peaktable: fitConfig.use_persistent_peaktable,
        }
      );

      setActiveJob(response.data);
      setActiveTab('logs');
    } catch (error: any) {
      setFitError(
        error.response?.data?.detail || 'Peak fitting failed to start. Check your configuration and file paths.'
      );
      setIsFitting(false);
    }
  };

  const handleRestoreFitting = async () => {
    try {
      setIsLoading(true);
      const response = await api.post(`/api/projects/${projectUuid}/spectra/${spectrumUuid}/fitting/restore`);
      if (response.data.results) {
        setFitResults(response.data.results);
        setSpectrum((prev: any) => ({ ...prev, is_fitted: true }));
        setSuccessMsg('Successfully restored fitting from backup!');
        setTimeout(() => setSuccessMsg(''), 3000);
      }
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Failed to restore fitting');
    } finally {
      setIsLoading(false);
    }
  };

  const exportCSV = () => {
    if (!fitResults.length) return;
    const cols = ['assignment', 'amp', 'amp_err', 'center_x_ppm', 'center_y_ppm', 'fwhm_x_hz', 'fwhm_y_hz', 'height', 'height_err', 'lineshape', 'clustid', 'plane', 'sigma_x_ppm', 'sigma_y_ppm', 'chisqr'];
    const header = cols.join(',');
    const rows = fitResults.map(r => cols.map(c => r[c] ?? '').join(','));
    const csv = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fit_results_${spectrum?.name || 'spectrum'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };
  
  const exportPDF = async () => {
    try {
      setIsSaving(true);
      const payload = {
        ...fitConfig,
        results: fitResults,
      };
      const response = await api.post(
        `/api/projects/${projectUuid}/spectra/${spectrumUuid}/fitting/export-pdf`,
        payload,
        { responseType: 'blob' }
      );
      
      const url = URL.createObjectURL(new Blob([response.data], { type: 'application/pdf' }));
      const a = document.createElement('a');
      a.href = url;
      a.setAttribute('download', `peak_fitting_report_${spectrum?.name || 'spectrum'}.pdf`);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setError('Failed to export PDF report.');
    } finally {
      setIsSaving(false);
    }
  };

  const getSortedResults = () => {
    return [...fitResults].sort((a, b) => {
      const va = a[sortCol];
      const vb = b[sortCol];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === 'string' && typeof vb === 'string') return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
      return sortAsc ? (va as number) - (vb as number) : (vb as number) - (va as number);
    });
  };

  const handleSort = (col: string) => {
    if (sortCol === col) { setSortAsc(!sortAsc); }
    else { setSortCol(col); setSortAsc(true); }
  };

  const fmtNum = (v: any, digits = 4) => (v != null && typeof v === 'number') ? v.toFixed(digits) : '—';

  const updateFitConfig = (key: string, value: any) => {
    setFitConfig(prev => ({ ...prev, [key]: value }));
  };

  const toggleFixParam = (param: string) => {
    setFitConfig(prev => {
      const current = prev.to_fix;
      if (current.includes(param)) return { ...prev, to_fix: current.filter(p => p !== param) };
      else return { ...prev, to_fix: [...current, param] };
    });
  };

  const fitCluster = async (clusterId: number) => {
    try {
      setIsFittingCluster(true);
      setClusterFitError('');
      setClusterFitData(null);
      const payload = {
        cluster_id: clusterId,
        peaks: peakPositions,
        peaklist_format: fitConfig.peaklist_format,
        x_radius_ppm: fitConfig.x_radius_ppm,
        y_radius_ppm: fitConfig.y_radius_ppm,
        lineshape: fitConfig.lineshape,
        fit_method: fitConfig.fit_method,
        clustering_method: fitConfig.clustering_method,
        struc_el: fitConfig.struc_el,
        struc_size: fitConfig.struc_size,
        noise: fitConfig.noise || undefined,
        use_persistent_peaktable: fitConfig.use_persistent_peaktable,
        to_fix: fitConfig.to_fix,
      };
      const response = await api.post(
        `/api/projects/${projectUuid}/spectra/${spectrumUuid}/fitting/fit-cluster`,
        payload
      );
      setClusterFitData(response.data);
    } catch (err: any) {
      setClusterFitError(err.response?.data?.detail || 'Cluster fitting failed.');
    } finally {
      setIsFittingCluster(false);
    }
  };

  const handleInspectCluster = async (clusterId: number) => {
    try {
      setIsFittingCluster(true);
      setClusterFitError('');
      setClusterFitData(null);
      
      const clickedRow = fitResults.find(r => r.clustid === clusterId);
      const targetPlane = clickedRow?.plane ?? 0;
      
      const clusterRows = fitResults.filter(r => r.clustid === clusterId && r.plane === targetPlane);
      if (clusterRows.length === 0) {
        setClusterFitError(`Cluster ${clusterId} on plane ${targetPlane} not found in fitting results.`);
        setIsFittingCluster(false);
        return;
      }

      const payload = {
        cluster_id: clusterId,
        fitted_peaks: clusterRows,
        plane: targetPlane,
        peaklist_format: fitConfig.peaklist_format,
        dims: [0, 1, 2],
        lineshape: clusterRows[0]?.lineshape || fitConfig.lineshape,
        clustering_method: fitConfig.clustering_method,
        struc_el: fitConfig.struc_el,
        struc_size: fitConfig.struc_size,
      };

      const response = await api.post(
        `/api/projects/${projectUuid}/spectra/${spectrumUuid}/fitting/plot-fitted-cluster`,
        payload
      );
      setClusterFitData(response.data);
    } catch (err: any) {
      setClusterFitError(err.response?.data?.detail || 'Failed to plot fitted cluster.');
    } finally {
      setIsFittingCluster(false);
    }
  };

  const renderFittingTab = () => {
    const sortedResults = getSortedResults();
    const resultCols: { key: string; label: string; digits?: number }[] = [
      { key: 'res_num', label: 'Res #', digits: 0 },
      { key: 'res_name', label: 'Res Name' },
      { key: 'assignment', label: 'Assignment' },
      { key: 'amp', label: 'Amplitude', digits: 2 },
      { key: 'amp_err', label: 'Amp Err', digits: 2 },
      { key: 'center_x_ppm', label: 'X (ppm)', digits: 4 },
      { key: 'center_y_ppm', label: 'Y (ppm)', digits: 4 },
      { key: 'fwhm_x_hz', label: 'FWHM X (Hz)', digits: 2 },
      { key: 'fwhm_y_hz', label: 'FWHM Y (Hz)', digits: 2 },
      { key: 'height', label: 'Height', digits: 2 },
      { key: 'height_err', label: 'Height Err', digits: 2 },
      { key: 'chisqr', label: 'χ²', digits: 2 },
      { key: 'redchi', label: 'Red.χ²', digits: 2 },
      { key: 'clustid', label: 'Cluster', digits: 0 },
      { key: 'memcnt', label: 'Peaks', digits: 0 },
      { key: 'plane', label: 'Plane', digits: 0 },
      { key: 'lineshape', label: 'Shape' },
    ];

    return (
      <div>
        {/* Log warning */}
        {fitLog && (
          <div className="mb-4 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg text-amber-700 dark:text-amber-400 text-xs">
            {fitLog}
          </div>
        )}

        {/* Summary Stats */}
        {fitSummary && (
          <div className="mb-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-8 gap-3">
            {[
              { label: 'Peaks', value: fitSummary.total_peaks_fitted },
              { label: 'Clusters', value: fitSummary.total_clusters },
              { label: 'Planes', value: fitSummary.total_planes },
              { label: 'Avg χ²', value: fitSummary.avg_chisqr.toExponential(2) },
              { label: 'Avg Red.χ²', value: fitSummary.avg_redchi?.toExponential(2) || '—' },
              { label: 'Red.χ²(P0)', value: fitSummary.redchi_plane0?.toExponential(2) || '—' },
              { label: 'Lineshape', value: fitSummary.lineshape_used },
              { label: 'Method', value: fitSummary.fit_method_used },
            ].map(s => (
              <div key={s.label} className="bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-lg p-3 text-center">
                <div className="text-xs text-slate-500 dark:text-slate-400">{s.label}</div>
                <div className="text-sm font-semibold text-slate-800 dark:text-slate-200 mt-0.5">{s.value}</div>
              </div>
            ))}
          </div>
        )}

        {/* Results Table */}
        {fitResults.length > 0 ? (
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
                <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                {fitResults.length} result row{fitResults.length !== 1 ? 's' : ''}
              </div>
              <div className="flex gap-2">
              <button
                onClick={exportCSV}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 rounded-lg text-xs font-medium transition-colors border border-slate-200 dark:border-slate-700"
              >
                <Download className="w-3.5 h-3.5" />
                Export CSV
              </button>
              <button
                onClick={exportPDF}
                disabled={isSaving}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-50 dark:bg-blue-900/40 hover:bg-blue-100 dark:hover:bg-blue-900/60 text-blue-700 dark:text-blue-300 rounded-lg text-xs font-medium transition-colors border border-blue-100 dark:border-blue-800"
              >
                {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Activity className="w-3.5 h-3.5" />}
                Export PDF Report
              </button>
            </div>
            </div>
            <div className="overflow-auto rounded-lg border border-slate-200 dark:border-slate-700 max-h-[600px]">
              <table className="w-full text-xs">
                <thead className="bg-slate-100 dark:bg-slate-800 sticky top-0 z-10">
                  <tr>
                    {resultCols.map(col => (
                      <th key={col.key} onClick={() => handleSort(col.key)}
                        className="px-3 py-2.5 text-left font-semibold text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors whitespace-nowrap select-none">
                        <span className="flex items-center gap-1">
                          {col.label}
                          {sortCol === col.key && (sortAsc ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />)}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {sortedResults.map((row, i) => (
                    <tr key={i}
                      className="hover:bg-blue-50/50 dark:hover:bg-blue-900/10 transition-colors cursor-pointer"
                      onClick={() => { if (row.clustid != null) handleInspectCluster(row.clustid); }}
                    >
                      {resultCols.map(col => (
                        <td key={col.key} className="px-3 py-2 whitespace-nowrap text-slate-700 dark:text-slate-300">
                          {col.key === 'assignment' || col.key === 'lineshape' || col.key === 'res_name' ? (row[col.key] ?? '—')
                            : fmtNum(row[col.key], col.digits ?? 4)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="py-16 text-center text-slate-500">
            <Activity className="w-12 h-12 mx-auto mb-3 text-slate-300 dark:text-slate-600" />
            <h3 className="text-lg font-medium">No fitting results</h3>
            <p className="text-sm mt-1">Go to the <strong>Spectra Viewer</strong> tab, configure fitting parameters, and click <strong>Run Fitting</strong>.</p>
          </div>
        )}

        {/* Fit Inspection in Results Tab — Reference-style contour plots */}
        {clusterFitData && (
          <div className="mt-4 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden">
            <div className="px-4 py-2 bg-slate-50 dark:bg-slate-800/80 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
              <div className="flex flex-col">
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  Plane={clusterFitData.plane_idx ?? 0}, Cluster={clusterFitData.cluster_id} · {clusterFitData.peak_annotations?.[0]?.lineshape || clusterFitData.lineshape || 'PV'}
                </span>
                <span className="text-[10px] text-slate-500">
                  {clusterFitData.fit_stats && `χ²: ${clusterFitData.fit_stats.chisqr?.toExponential(2)} · Reduced χ²: ${clusterFitData.fit_stats.redchi?.toExponential(2)} · AIC: ${clusterFitData.fit_stats.aic?.toFixed(2)}`}
                </span>
              </div>
              <button onClick={() => setClusterFitData(null)}
                className="text-xs text-slate-500 hover:text-red-500 transition-colors">✕ Close</button>
            </div>
            {renderContourComparison(clusterFitData)}

            {clusterFitData.peak_annotations && clusterFitData.peak_annotations.length > 0 && (
              <div className="px-4 py-3 bg-slate-50/50 dark:bg-slate-800/50 border-t border-slate-100 dark:border-slate-700">
                <h6 className="text-[10px] font-bold text-slate-400 uppercase mb-2">Peak Parameters</h6>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
                  {clusterFitData.peak_annotations.map((a: any, idx: number) => (
                    <div key={idx} className="bg-white dark:bg-slate-900 p-2 rounded border border-slate-200 dark:border-slate-700 shadow-sm">
                      <div className="text-[10px] font-bold text-blue-600 dark:text-blue-400 truncate">{a.label}</div>
                      <div className="text-[9px] text-slate-500 mt-0.5">Vol: {a.volume != null ? Number(a.volume).toExponential(2) : '—'}</div>
                      <div className="text-[9px] text-slate-500">H: {a.height != null ? Number(a.height).toExponential(2) : '—'}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {clusterFitError && (
          <div className="mt-2 p-2 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded text-red-700 dark:text-red-400 text-xs flex items-start gap-1">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /> {clusterFitError}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center space-x-4">
                <button 
                  onClick={() => navigate(`/projects/${projectUuid}`)}
                  className="p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
                >
                  <ArrowLeft className="w-5 h-5" />
                </button>
                <div>
                  <h1 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center">
                    {spectrum?.name || 'Spectra Analysis'}
                    {spectrum?.is_fitted && (
                      <span className="ml-3 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800">
                        <CheckCircle2 className="w-3 h-3 mr-1" />
                        Fitting Data Available
                      </span>
                    )}
                  </h1>
                  <p className="text-slate-500 text-sm mt-1 border border-slate-200 dark:border-slate-700 px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 font-mono inline-block">
                    {spectrum?.file_path}
                  </p>
                </div>
            </div>
            
            <button
                onClick={handleSaveInfo}
                disabled={isSaving || activeTab !== 'general'}
                className={`inline-flex items-center px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg transition-all ${isSaving || activeTab !== 'general' ? 'opacity-50 cursor-not-allowed' : 'hover:bg-blue-700 shadow-sm'}`}
            >
                <Save className="w-4 h-4 mr-2" />
                Save Information
            </button>
        </div>

        {/* Alerts */}
        {error && (
            <div className="p-4 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-xl flex items-center text-red-700 dark:text-red-400 text-sm">
                <div className="w-2 h-2 bg-red-500 rounded-full mr-3"></div>
                {error}
            </div>
        )}
        {successMsg && (
            <div className="p-4 bg-emerald-50 dark:bg-emerald-900/30 border border-emerald-200 rounded-xl flex items-center text-emerald-700 text-sm">
                <div className="w-2 h-2 bg-emerald-500 rounded-full mr-3"></div>
                {successMsg}
            </div>
        )}

        {/* Tabs Widget */}
        <div className="bg-white dark:bg-slate-800 shadow-sm border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden flex flex-col md:flex-row min-h-[600px]">
            {/* Sidebar */}
            <div className={`${isSidebarCollapsed ? 'w-full md:w-20' : 'w-full md:w-64'} flex-shrink-0 border-b md:border-b-0 md:border-r border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-900/10 p-4 flex flex-row md:flex-col gap-2 overflow-x-auto md:overflow-x-visible transition-all duration-300`}>
                <button 
                  onClick={() => setActiveTab('general')}
                  className={`flex items-center px-4 py-3 rounded-xl transition-all duration-200 whitespace-nowrap gap-3 w-auto md:w-full ${isSidebarCollapsed ? 'md:justify-center' : 'md:justify-start'} ${activeTab === 'general' ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400 font-semibold text-base scale-[1.03] shadow-sm border border-blue-100/50 dark:border-blue-900/50' : 'text-sm text-slate-600 hover:text-slate-900 hover:bg-slate-50 dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800/50'}`}
                  title="General Information"
                >
                    <img src={atomSpinIcon} className="w-7 h-7 min-w-[28px] aspect-square object-cover rounded-lg flex-shrink-0 shadow-sm border border-slate-200 dark:border-slate-700" alt="" />
                    <span className={isSidebarCollapsed ? 'md:hidden' : 'md:inline'}>General Information</span>
                </button>
                <button 
                  onClick={() => setActiveTab('viewer')}
                  className={`flex items-center px-4 py-3 rounded-xl transition-all duration-200 whitespace-nowrap gap-3 w-auto md:w-full ${isSidebarCollapsed ? 'md:justify-center' : 'md:justify-start'} ${activeTab === 'viewer' ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400 font-semibold text-base scale-[1.03] shadow-sm border border-blue-100/50 dark:border-blue-900/50' : 'text-sm text-slate-600 hover:text-slate-900 hover:bg-slate-50 dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800/50'}`}
                  title="Spectra Viewer"
                >
                    <img src={nmrSpectraIcon} className="w-7 h-7 min-w-[28px] aspect-square object-cover rounded-lg flex-shrink-0 shadow-sm border border-slate-200 dark:border-slate-700" alt="" />
                    <span className={isSidebarCollapsed ? 'md:hidden' : 'md:inline'}>Spectra Viewer</span>
                </button>
                <button
                    onClick={() => setActiveTab('fitting')}
                    className={`flex items-center px-4 py-3 rounded-xl transition-all duration-200 whitespace-nowrap gap-3 w-auto md:w-full ${isSidebarCollapsed ? 'md:justify-center' : 'md:justify-start'} ${activeTab === 'fitting' ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400 font-semibold text-base scale-[1.03] shadow-sm border border-blue-100/50 dark:border-blue-900/50' : 'text-sm text-slate-600 hover:text-slate-900 hover:bg-slate-50 dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800/50'}`}
                    title="Peak Fitting Results"
                  >
                    <img src={peakFittingIcon} className="w-7 h-7 min-w-[28px] aspect-square object-cover rounded-lg flex-shrink-0 shadow-sm border border-slate-200 dark:border-slate-700" alt="" />
                    <span className={isSidebarCollapsed ? 'md:hidden' : 'md:inline'}>Peak Fitting Results</span>
                  </button>
                  <button
                    onClick={() => setActiveTab('logs')}
                    className={`flex items-center px-4 py-3 rounded-xl transition-all duration-200 whitespace-nowrap gap-3 w-auto md:w-full ${isSidebarCollapsed ? 'md:justify-center' : 'md:justify-start'} ${activeTab === 'logs' ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400 font-semibold text-base scale-[1.03] shadow-sm border border-blue-100/50 dark:border-blue-900/50' : 'text-sm text-slate-600 hover:text-slate-900 hover:bg-slate-50 dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800/50'}`}
                    title="Job Logs & Monitor"
                  >
                    <img src={terminalLogsIcon} className="w-7 h-7 min-w-[28px] aspect-square object-cover rounded-lg flex-shrink-0 shadow-sm border border-slate-200 dark:border-slate-700" alt="" />
                    <span className={isSidebarCollapsed ? 'md:hidden' : 'md:inline'}>Job Logs & Monitor</span>
                    {activeJob && (activeJob.status === 'RUNNING' || activeJob.status === 'PENDING') && (
                      <span className={`${isSidebarCollapsed ? 'md:absolute md:top-2 md:right-2' : 'ml-auto'} flex h-2 w-2 relative`}>
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
                      </span>
                    )}
                  </button>

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

            <div className="flex-1 p-6 md:p-8 overflow-x-hidden">
                {isLoading && (
                   <div className="py-12 flex justify-center items-center">
                     <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
                     <span className="ml-3 text-sm text-slate-500">Loading requested operations...</span>
                   </div>
                )}
                
                {!isLoading && activeTab === 'general' && (
                    <div className="space-y-6 max-w-2xl animate-in fade-in">
                        <div>
                            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Experiment Type</label>
                            <select
                                name="experiment_type"
                                value={formData.experiment_type}
                                onChange={handleInputChange}
                                className="w-full px-4 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-blue-500"
                            >
                                <option value="">Select type...</option>
                                <option value="T1">T1</option>
                                <option value="T2">T2</option>
                                <option value="hetNOE">hetNOE</option>
                                <option value="CPMG-RD">CPMG-RD</option>
                                <option value="CEST">CEST</option>
                            </select>
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">B0 (MHz)</label>
                                <input
                                    type="text"
                                    name="b0"
                                    value={formData.b0 ?? ''}
                                    onChange={handleNumericInputChange}
                                    placeholder="e.g. 600.13"
                                    className={`w-full px-4 py-2 bg-white dark:bg-slate-900 border ${fieldErrors.b0 ? 'border-red-500 focus:ring-red-500' : 'border-slate-300 dark:border-slate-600 focus:ring-blue-500'} rounded-lg focus:ring-2`}
                                />
                                {fieldErrors.b0 && <p className="mt-1 text-xs text-red-500">{fieldErrors.b0}</p>}
                                <p className="mt-1 text-[10px] text-slate-500 italic">Spectrometer frequency (auto-extracted from FT2 if available)</p>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Temperature (K)</label>
                                <input
                                    type="text"
                                    name="temperature"
                                    value={formData.temperature ?? ''}
                                    onChange={handleNumericInputChange}
                                    placeholder="e.g. 298.0"
                                    className={`w-full px-4 py-2 bg-white dark:bg-slate-900 border ${fieldErrors.temperature ? 'border-red-500 focus:ring-red-500' : 'border-slate-300 dark:border-slate-600 focus:ring-blue-500'} rounded-lg focus:ring-2`}
                                />
                                {fieldErrors.temperature && <p className="mt-1 text-xs text-red-500">{fieldErrors.temperature}</p>}
                            </div>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Peaklist Path</label>
                            <div className="flex gap-2">
                              <input
                                  type="text"
                                  name="peaklist_path"
                                  value={formData.peaklist_path}
                                  onChange={handleInputChange}
                                  className="flex-1 px-4 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg"
                              />
                              <button
                                type="button"
                                onClick={() => openFileBrowser('peaklist')}
                                className="px-3 py-2 bg-slate-100 dark:bg-slate-700 border border-slate-300 rounded-lg"
                              >
                                <Search className="w-4 h-4" />
                              </button>
                            </div>
                        </div>

                        {/* Conditional Fields based on Experiment Type */}
                        {formData.experiment_type === 'T2' && (
                          <div>
                              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">VC List Path</label>
                              <div className="flex gap-2">
                                <input
                                    type="text"
                                    name="vclist_path"
                                    value={formData.vclist_path}
                                    onChange={handleInputChange}
                                    className="flex-1 px-4 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg"
                                />
                                <button
                                  type="button"
                                  onClick={() => openFileBrowser('vclist')}
                                  className="px-3 py-2 bg-slate-100 dark:bg-slate-700 border border-slate-300 rounded-lg"
                                >
                                  <Search className="w-4 h-4" />
                                </button>
                              </div>
                          </div>
                        )}

                        {formData.experiment_type === 'CPMG-RD' && (
                          <div className="space-y-4">
                            <div>
                              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                                VC List Path <span className="text-xs text-slate-400 font-normal">(Number of CPMG cycles)</span>
                              </label>
                              <div className="flex gap-2">
                                <input
                                    type="text"
                                    name="vclist_path"
                                    value={formData.vclist_path}
                                    placeholder="e.g. vclist with 0, 2, 4, 8... (optional if VD List provided)"
                                    onChange={handleInputChange}
                                    className="flex-1 px-4 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg text-sm"
                                />
                                <button
                                  type="button"
                                  onClick={() => openFileBrowser('vclist')}
                                  className="px-3 py-2 bg-slate-100 dark:bg-slate-700 border border-slate-300 rounded-lg"
                                >
                                  <Search className="w-4 h-4" />
                                </button>
                              </div>
                            </div>
                            <div>
                              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                                VD List Path <span className="text-xs text-slate-400 font-normal">(Frequencies in Hz or delays in s)</span>
                              </label>
                              <div className="flex gap-2">
                                <input
                                    type="text"
                                    name="vdlist_path"
                                    value={formData.vdlist_path}
                                    placeholder="e.g. vdlist with 0, 50, 100, 200... (optional if VC List provided)"
                                    onChange={handleInputChange}
                                    className="flex-1 px-4 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg text-sm"
                                />
                                <button
                                  type="button"
                                  onClick={() => openFileBrowser('vdlist')}
                                  className="px-3 py-2 bg-slate-100 dark:bg-slate-700 border border-slate-300 rounded-lg"
                                >
                                  <Search className="w-4 h-4" />
                                </button>
                              </div>
                              <p className="text-xs text-slate-400 mt-1">
                                Provide either VC List (cycle counts) or VD List (frequencies/delays). If VD List is provided, cycle counts are automatically calculated as ncyc = round(ν_cpmg × t_relax).
                              </p>
                            </div>
                          </div>
                        )}

                        {formData.experiment_type === 'T1' && (
                          <div>
                              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">VD List Path</label>
                              <div className="flex gap-2">
                                <input
                                    type="text"
                                    name="vdlist_path"
                                    value={formData.vdlist_path}
                                    onChange={handleInputChange}
                                    className="flex-1 px-4 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg"
                                />
                                <button
                                  type="button"
                                  onClick={() => openFileBrowser('vdlist')}
                                  className="px-3 py-2 bg-slate-100 dark:bg-slate-700 border border-slate-300 rounded-lg"
                                >
                                  <Search className="w-4 h-4" />
                                </button>
                              </div>
                          </div>
                        )}


                        {formData.experiment_type === 'CEST' && (
                          <div>
                              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">F3 List Path</label>
                              <div className="flex gap-2">
                                <input
                                    type="text"
                                    name="f3list_path"
                                    value={formData.f3list_path}
                                    onChange={handleInputChange}
                                    className="flex-1 px-4 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg"
                                />
                                <button
                                  type="button"
                                  onClick={() => openFileBrowser('f3list')}
                                  className="px-3 py-2 bg-slate-100 dark:bg-slate-700 border border-slate-300 rounded-lg"
                                >
                                  <Search className="w-4 h-4" />
                                </button>
                              </div>
                          </div>
                        )}

                        {formData.experiment_type === 'T2' && (
                          <div>
                              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Delay (s)</label>
                              <input
                                  type="text"
                                  name="delay"
                                  value={formData.delay ?? ''}
                                  onChange={handleNumericInputChange}
                                  placeholder="e.g. 0.01"
                                  className={`w-full px-4 py-2 bg-white dark:bg-slate-900 border ${fieldErrors.delay ? 'border-red-500 focus:ring-red-500' : 'border-slate-300 dark:border-slate-600 focus:ring-blue-500'} rounded-lg focus:ring-2`}
                              />
                              {fieldErrors.delay && <p className="mt-1 text-xs text-red-500">{fieldErrors.delay}</p>}
                          </div>
                        )}

                        {formData.experiment_type === 'CPMG-RD' && (
                          <div>
                              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">T-Relax (s)</label>
                              <input
                                  type="text"
                                  name="t_relax"
                                  value={formData.t_relax ?? ''}
                                  onChange={handleNumericInputChange}
                                  placeholder="e.g. 0.4"
                                  className={`w-full px-4 py-2 bg-white dark:bg-slate-900 border ${fieldErrors.t_relax ? 'border-red-500 focus:ring-red-500' : 'border-slate-300 dark:border-slate-600 focus:ring-blue-500'} rounded-lg focus:ring-2`}
                              />
                              {fieldErrors.t_relax && <p className="mt-1 text-xs text-red-500">{fieldErrors.t_relax}</p>}
                          </div>
                        )}

                        {formData.experiment_type === 'CEST' && (
                          <div>
                              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">B1 (Hz)</label>
                              <input
                                  type="text"
                                  name="b1"
                                  value={formData.b1 ?? ''}
                                  onChange={handleNumericInputChange}
                                  placeholder="e.g. 25.0"
                                  className={`w-full px-4 py-2 bg-white dark:bg-slate-900 border ${fieldErrors.b1 ? 'border-red-500 focus:ring-red-500' : 'border-slate-300 dark:border-slate-600 focus:ring-blue-500'} rounded-lg focus:ring-2`}
                              />
                              {fieldErrors.b1 && <p className="mt-1 text-xs text-red-500">{fieldErrors.b1}</p>}
                          </div>
                        )}

                        {formData.experiment_type === 'CEST' && (
                          <div>
                              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">T-Relax (s)</label>
                              <input
                                  type="text"
                                  name="t_relax"
                                  value={formData.t_relax ?? ''}
                                  onChange={handleNumericInputChange}
                                  placeholder="e.g. 0.5"
                                  className={`w-full px-4 py-2 bg-white dark:bg-slate-900 border ${fieldErrors.t_relax ? 'border-red-500 focus:ring-red-500' : 'border-slate-300 dark:border-slate-600 focus:ring-blue-500'} rounded-lg focus:ring-2`}
                              />
                              {fieldErrors.t_relax && <p className="mt-1 text-xs text-red-500">{fieldErrors.t_relax}</p>}
                          </div>
                        )}

                        {formData.experiment_type === 'CEST' && (
                          <div>
                              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Carrier (ppm)</label>
                              <input
                                  type="text"
                                  name="carrier"
                                  value={formData.carrier ?? ''}
                                  onChange={handleNumericInputChange}
                                  placeholder="e.g. 118.0"
                                  className={`w-full px-4 py-2 bg-white dark:bg-slate-900 border ${fieldErrors.carrier ? 'border-red-500 focus:ring-red-500' : 'border-slate-300 dark:border-slate-600 focus:ring-blue-500'} rounded-lg focus:ring-2`}
                              />
                              {fieldErrors.carrier && <p className="mt-1 text-xs text-red-500">{fieldErrors.carrier}</p>}
                              <p className="mt-1 text-[10px] text-slate-500">15N carrier frequency used during CEST irradiation</p>
                          </div>
                        )}

                        {formData.experiment_type === 'hetNOE' && (
                          <div>
                              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">hetNOE Sequence</label>
                              <select
                                  name="hetnoe_mode"
                                  value={formData.hetnoe_mode}
                                  onChange={handleInputChange}
                                  className="w-full px-4 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg"
                              >
                                  <option value="">Select sequence...</option>
                                  <option value="0,1">0, 1 (No-Sat, Sat)</option>
                                  <option value="1,0">1, 0 (Sat, No-Sat)</option>
                              </select>
                          </div>
                        )}
                    </div>
                )}

                {!isLoading && activeTab === 'viewer' && renderPlot()}
                
                {!isLoading && activeTab === 'fitting' && renderFittingTab()}

                {!isLoading && activeTab === 'logs' && (
                  <div className="space-y-6 max-w-5xl mx-auto animate-in slide-in-from-bottom-2 duration-300">
                    {activeJob ? (
                      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-8 shadow-xl shadow-blue-500/5">
                        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
                          <div>
                            <div className="flex items-center gap-3 mb-1">
                              <h3 className="text-xl font-bold text-slate-900 dark:text-white">Fitting Job #{activeJob.id}</h3>
                              <span className={`px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider ${
                                activeJob.status === 'COMPLETED' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400' :
                                activeJob.status === 'FAILED' ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400' :
                                'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400 animate-pulse'
                              }`}>
                                {activeJob.status}
                              </span>
                            </div>
                            <p className="text-slate-500 dark:text-slate-400 text-sm flex items-center gap-2">
                              {activeJob.processors} processors allocated • Started {new Date(activeJob.created_at).toLocaleTimeString()}
                            </p>
                          </div>
                          
                          {activeJob.status === 'RUNNING' && (
                            <div className="flex items-center gap-2 text-blue-600 dark:text-blue-400 font-semibold animate-pulse">
                              <Loader2 className="w-5 h-5 animate-spin" />
                              <span>Fitting in progress...</span>
                            </div>
                          )}

                          {activeJob.status === 'COMPLETED' && (
                            <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 font-semibold">
                              <CheckCircle2 className="w-5 h-5" />
                              <span>Job Finished Successfully</span>
                            </div>
                          )}
                        </div>

                        <div className="space-y-4">
                          <div className="flex justify-between text-sm font-medium">
                            <span className="text-slate-600 dark:text-slate-400">
                              Clusters Processed: <span className="text-slate-900 dark:text-white">{activeJob.status === 'COMPLETED' ? `${activeJob.total_clusters} / ${activeJob.total_clusters}` : `${activeJob.completed_clusters} / ${activeJob.total_clusters}`}</span>
                            </span>
                            <span className="text-blue-600 dark:text-blue-400">
                              {activeJob.status === 'COMPLETED' ? 100 : Math.round((activeJob.completed_clusters / activeJob.total_clusters) * 100)}%
                            </span>
                          </div>
                          <div className="w-full bg-slate-100 dark:bg-slate-700/50 rounded-full h-4 overflow-hidden shadow-inner p-1">
                            <div 
                              className={`h-full rounded-full transition-all duration-700 ease-out shadow-lg ${
                                activeJob.status === 'FAILED' ? 'bg-red-500' : 
                                activeJob.status === 'COMPLETED' ? 'bg-emerald-500' : 'bg-gradient-to-r from-blue-500 to-indigo-600'
                              }`}
                              style={{ width: `${activeJob.status === 'COMPLETED' ? 100 : (activeJob.completed_clusters / activeJob.total_clusters) * 100}%` }}
                            ></div>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="bg-slate-50 dark:bg-slate-800/30 rounded-2xl border-2 border-dashed border-slate-200 dark:border-slate-700 p-12 text-center">
                        <Activity className="w-12 h-12 text-slate-300 dark:text-slate-600 mx-auto mb-4" />
                        <h3 className="text-lg font-semibold text-slate-700 dark:text-slate-300">No Active Job</h3>
                        <p className="text-slate-500 dark:text-slate-400 mt-2">Start a new fitting run from the Viewer tab to monitor progress here.</p>
                      </div>
                    )}

                    <div className="bg-slate-950 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
                      <div className="px-6 py-4 border-b border-slate-800 bg-slate-900/50 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="flex gap-1.5">
                            <div className="w-3 h-3 rounded-full bg-rose-500/80"></div>
                            <div className="w-3 h-3 rounded-full bg-amber-500/80"></div>
                            <div className="w-3 h-3 rounded-full bg-emerald-500/80"></div>
                          </div>
                          <span className="text-xs font-bold text-slate-500 uppercase tracking-[0.2em] ml-2">Job Run Terminal</span>
                        </div>
                        <button 
                          onClick={() => {
                            const el = document.getElementById('logs-container');
                            if (el) el.scrollTop = el.scrollHeight;
                          }}
                          className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors uppercase font-bold tracking-wider"
                        >
                          Scroll to Bottom
                        </button>
                      </div>
                      <div 
                        id="logs-container"
                        className="p-6 font-mono text-sm leading-relaxed text-blue-100 h-[600px] overflow-auto scroll-smooth custom-scrollbar bg-slate-950/50"
                      >
                        {jobLogs ? (
                          jobLogs.split('\n').map((line, i) => {
                            let colorClass = 'text-slate-300';
                            if (line.includes('ERROR')) colorClass = 'text-rose-400 font-bold';
                            if (line.includes('WARNING')) colorClass = 'text-amber-400';
                            if (line.includes('COMPLETED')) colorClass = 'text-emerald-400 font-bold';
                            if (line.includes('Starting')) colorClass = 'text-blue-400';
                            
                            return (
                              <div key={i} className={`mb-1 ${colorClass}`}>
                                <span className="opacity-30 mr-4 select-none">{(i + 1).toString().padStart(4, '0')}</span>
                                {line}
                              </div>
                            );
                          })
                        ) : (
                          <div className="flex flex-col items-center justify-center h-full text-slate-600 italic">
                            <Loader2 className="w-6 h-6 animate-spin mb-3 opacity-20" />
                            Waiting for output streams...
                          </div>
                        )}
                        <div id="logs-end"></div>
                      </div>
                    </div>
                  </div>
                )}
            </div>
        </div>



      <FileBrowserModal
        isOpen={isFileBrowserOpen}
        onClose={() => setIsFileBrowserOpen(false)}
        selectType="file"
        onSelect={handleFileSelect}
      />

      {showRerunWarning && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-300">
          <div className="bg-white dark:bg-slate-800 rounded-3xl p-8 max-w-md w-full shadow-2xl border border-slate-200 dark:border-slate-700 animate-in zoom-in-95 duration-300">
            <div className="flex items-center space-x-4 mb-6">
              <div className="p-3 bg-amber-50 dark:bg-amber-900/20 rounded-2xl text-amber-600">
                <AlertCircle className="w-8 h-8" />
              </div>
              <h3 className="text-xl font-bold text-slate-900 dark:text-white">Rerun Fitting?</h3>
            </div>
            <p className="text-slate-600 dark:text-slate-400 mb-8 leading-relaxed">
              This will overwrite the current fitting results. A backup of the current results will be created, but any older backups will be permanently deleted.
            </p>
            <div className="flex items-center space-x-4">
              <button
                onClick={() => setShowRerunWarning(false)}
                className="flex-1 px-6 py-3 font-bold text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700/50 rounded-xl transition-all"
              >
                Cancel
              </button>
              <button
                onClick={runFitting}
                className="flex-1 px-6 py-3 bg-amber-600 hover:bg-amber-700 text-white font-bold rounded-xl shadow-lg shadow-amber-600/20 transition-all"
              >
                Start Rerun
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SpectraAnalysis;
