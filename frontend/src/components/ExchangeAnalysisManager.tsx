import React, { useState, useEffect } from 'react';
import api from '../services/api';
import { Layers, Activity, Settings, Check, Play } from 'lucide-react';
import { useOptionalUserRuns } from '../context/RunsContext';

interface Spectrum {
  id: number;
  name: string;
  experiment_type: string;
  b0: number | null;
  b1: number | null;
  temperature: number | null;
}

interface ExchangeAnalysisManagerProps {
  projectUuid: string;
  analysis: any;
  spectra: Spectrum[];
  onUpdate: () => void;
}

export const ExchangeAnalysisManager: React.FC<ExchangeAnalysisManagerProps> = ({
  projectUuid,
  analysis,
  spectra,
  onUpdate,
}) => {
  const [selectedSpectrumIds, setSelectedSpectrumIds] = useState<number[]>([]);
  const [activeTab, setActiveTab] = useState<'setup' | 'preflight' | 'log'>('setup');
  const [model, setModel] = useState('2st');
  const [preflightData, setPreflightData] = useState<any>(null);
  const [isPreflighting, setIsPreflighting] = useState(false);
  const [isFitting, setIsFitting] = useState(false);
  const [logs, setLogs] = useState<string>('');
  
  const userRuns = useOptionalUserRuns();

  useEffect(() => {
    // Attempt to load previously selected spectra from analysis parameters if they exist
    try {
      if (analysis.parameters) {
        const params = JSON.parse(analysis.parameters);
        if (params.spectrum_ids) {
          setSelectedSpectrumIds(params.spectrum_ids);
        }
        if (params.exchange_model) {
          setModel(params.exchange_model);
        }
      }
    } catch (e) {}
  }, [analysis]);

  // Handle log polling if RUNNING
  useEffect(() => {
    let interval: number;
    if (analysis.status === 'RUNNING') {
      setActiveTab('log');
      const fetchLogs = async () => {
        try {
          const res = await api.get(`/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/logs`);
          setLogs(res.data.logs || '');
        } catch (error) {
          console.error('Error fetching logs', error);
        }
      };
      fetchLogs();
      interval = window.setInterval(fetchLogs, 2000);
    }
    return () => clearInterval(interval);
  }, [analysis.status, analysis.analysis_uuid, projectUuid]);

  const toggleSpectrum = (id: number) => {
    if (selectedSpectrumIds.includes(id)) {
      setSelectedSpectrumIds(selectedSpectrumIds.filter(s => s !== id));
    } else {
      setSelectedSpectrumIds([...selectedSpectrumIds, id]);
    }
  };

  const handlePreflight = async () => {
    if (selectedSpectrumIds.length === 0) return;
    setIsPreflighting(true);
    setPreflightData(null);
    try {
      const res = await api.post(`/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/exchange/preflight`, {
        spectrum_ids: selectedSpectrumIds,
        model: model
      });
      setPreflightData(res.data);
      setActiveTab('preflight');
    } catch (err) {
      console.error(err);
      alert("Preflight failed. See console.");
    } finally {
      setIsPreflighting(false);
    }
  };

  const handleStartFit = async () => {
    setIsFitting(true);
    try {
      await api.post(`/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/exchange/generate`, {
        spectrum_ids: selectedSpectrumIds,
        model: model
      });
      // Start the task
      await api.post(`/projects/${projectUuid}/analysis/${analysis.analysis_uuid}/tasks`, {
        task_name: 'exchange_analysis',
        params: { spectrum_ids: selectedSpectrumIds, model }
      });
      onUpdate();
      userRuns?.refreshRuns();
    } catch (err) {
      console.error(err);
      alert("Fit failed to start. See console.");
    } finally {
      setIsFitting(false);
    }
  };

  const cestSpectra = spectra.filter(s => s.experiment_type.toUpperCase() === 'CEST');
  const cpmgSpectra = spectra.filter(s => s.experiment_type.toUpperCase() === 'CPMG');

  return (
    <div className="bg-white dark:bg-slate-900 min-h-[600px] rounded-3xl border border-slate-200 dark:border-slate-800 p-6 flex flex-col">
      <div className="flex items-center space-x-6 border-b border-slate-200 dark:border-slate-800 pb-4 mb-6">
        <button
          onClick={() => setActiveTab('setup')}
          className={`flex items-center space-x-2 px-4 py-2 rounded-xl transition-colors ${activeTab === 'setup' ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 font-bold' : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}
        >
          <Settings className="w-4 h-4" />
          <span>Setup</span>
        </button>
        <button
          onClick={() => setActiveTab('preflight')}
          className={`flex items-center space-x-2 px-4 py-2 rounded-xl transition-colors ${activeTab === 'preflight' ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 font-bold' : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}
        >
          <Activity className="w-4 h-4" />
          <span>Preflight</span>
        </button>
        <button
          onClick={() => setActiveTab('log')}
          className={`flex items-center space-x-2 px-4 py-2 rounded-xl transition-colors ${activeTab === 'log' ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 font-bold' : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}
        >
          <Layers className="w-4 h-4" />
          <span>Log</span>
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        {activeTab === 'setup' && (
          <div className="space-y-8 animate-in fade-in duration-500">
            <div>
              <h3 className="text-lg font-bold mb-4">Select Spectra</h3>
              <div className="grid grid-cols-2 gap-8">
                <div className="bg-slate-50 dark:bg-slate-800/30 p-4 rounded-xl border border-slate-200 dark:border-slate-800">
                  <h4 className="font-bold mb-3 text-indigo-600 dark:text-indigo-400">CEST Spectra</h4>
                  <div className="space-y-2">
                    {cestSpectra.map(s => (
                      <label key={s.id} className="flex items-center space-x-3 p-2 hover:bg-white dark:hover:bg-slate-800 rounded-lg cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedSpectrumIds.includes(s.id)}
                          onChange={() => toggleSpectrum(s.id)}
                          className="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500"
                        />
                        <span className="text-sm">
                          <span className="font-bold">{s.name}</span>
                          <span className="text-slate-500 ml-2 text-xs">(B0: {s.b0 || '?'} MHz, B1: {s.b1 || '?'} Hz)</span>
                        </span>
                      </label>
                    ))}
                    {cestSpectra.length === 0 && <p className="text-sm text-slate-500 italic">No CEST spectra in this project.</p>}
                  </div>
                </div>

                <div className="bg-slate-50 dark:bg-slate-800/30 p-4 rounded-xl border border-slate-200 dark:border-slate-800">
                  <h4 className="font-bold mb-3 text-emerald-600 dark:text-emerald-400">CPMG Spectra</h4>
                  <div className="space-y-2">
                    {cpmgSpectra.map(s => (
                      <label key={s.id} className="flex items-center space-x-3 p-2 hover:bg-white dark:hover:bg-slate-800 rounded-lg cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedSpectrumIds.includes(s.id)}
                          onChange={() => toggleSpectrum(s.id)}
                          className="w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500"
                        />
                        <span className="text-sm">
                          <span className="font-bold">{s.name}</span>
                          <span className="text-slate-500 ml-2 text-xs">(B0: {s.b0 || '?'} MHz)</span>
                        </span>
                      </label>
                    ))}
                    {cpmgSpectra.length === 0 && <p className="text-sm text-slate-500 italic">No CPMG spectra in this project.</p>}
                  </div>
                </div>
              </div>
            </div>
            
            <div className="pt-6 border-t border-slate-200 dark:border-slate-800 flex justify-between items-center">
                <div>
                    <label className="text-sm font-bold mr-3">Exchange Model:</label>
                    <select
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                        className="bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-1.5 text-sm"
                    >
                        <option value="2st">2-State</option>
                        <option value="3st">3-State</option>
                    </select>
                </div>
              <button
                onClick={handlePreflight}
                disabled={selectedSpectrumIds.length === 0 || isPreflighting}
                className="px-6 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-bold text-sm transition-colors flex items-center space-x-2 disabled:opacity-50"
              >
                {isPreflighting ? <span>Running Preflight...</span> : <span>Run Preflight</span>}
              </button>
            </div>
          </div>
        )}

        {activeTab === 'preflight' && (
          <div className="animate-in fade-in duration-500 h-full flex flex-col">
            {preflightData ? (
              <>
                <div className="bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 p-4 rounded-xl mb-6 text-sm flex items-start space-x-3">
                  <Check className="w-5 h-5 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-bold">Preflight Successful</p>
                    <p className="mt-1">ChemEx parameter sharing map has been generated based on conditions across the selected experiments.</p>
                  </div>
                </div>
                
                <div className="flex-1 overflow-auto bg-slate-900 rounded-xl p-4 font-mono text-xs text-slate-300 relative border border-slate-800">
                  <pre className="whitespace-pre-wrap">{JSON.stringify(preflightData, null, 2)}</pre>
                </div>

                <div className="pt-6 mt-6 border-t border-slate-200 dark:border-slate-800 flex justify-end">
                  <button
                    onClick={handleStartFit}
                    disabled={isFitting || analysis.status === 'RUNNING'}
                    className="px-6 py-3 bg-amber-600 hover:bg-amber-700 text-white rounded-lg font-bold transition-colors flex items-center space-x-2 disabled:opacity-50 shadow-lg shadow-amber-600/20"
                  >
                    <Play className="w-4 h-4 fill-current" />
                    <span>{isFitting ? 'Starting...' : 'Start Combined Fit'}</span>
                  </button>
                </div>
              </>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-slate-500">
                <Activity className="w-12 h-12 mb-4 opacity-20" />
                <p>Run preflight from the Setup tab to see the parameter sharing map.</p>
              </div>
            )}
          </div>
        )}

        {activeTab === 'log' && (
          <div className="h-full bg-slate-900 rounded-xl p-6 font-mono text-xs overflow-hidden border border-slate-800 flex flex-col">
            <div className="flex justify-between items-center mb-4 border-b border-slate-800 pb-4">
                <span className="text-emerald-500/80 font-bold tracking-widest uppercase flex items-center">
                    <div className="w-2 h-2 bg-emerald-500 rounded-full mr-2 animate-pulse"></div>
                    {analysis.status}
                </span>
            </div>
            <div className="flex-1 overflow-y-auto custom-scrollbar-terminal pr-4">
              <pre className="text-slate-300 whitespace-pre-wrap leading-loose">
                {logs || "> Waiting for logs..."}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
