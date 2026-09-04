import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../services/api';
import { ArrowLeft, FileText } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import AnalysisManager from '../components/AnalysisManager';
import CestAnalysisManager from '../components/CestAnalysisManager';
import { CpmgAnalysisManager } from '../components/CpmgAnalysisManager';

const AnalysisDetails: React.FC = () => {
  const { projectUuid, analysisUuid } = useParams<{ projectUuid: string, analysisUuid: string }>();
  const navigate = useNavigate();
  useAuth();

  const [project, setProject] = useState<any>(null);
  const [selectedAnalysis, setSelectedAnalysis] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchProjectDetails();
  }, [projectUuid, analysisUuid]);

  const fetchProjectDetails = async () => {
    try {
      setIsLoading(true);
      const response = await api.get(`/api/projects/${projectUuid}`);
      setProject(response.data);
      const analysis = response.data.analyses.find((a: any) => a.analysis_uuid === analysisUuid);
      if (analysis) {
        setSelectedAnalysis(analysis);
      } else {
        setError('Analysis not found');
      }
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Failed to load analysis details');
    } finally {
      setIsLoading(false);
    }
  };

  const handleClose = () => {
    navigate(`/projects/${projectUuid}`);
  };

  if (isLoading) {
    return (
      <div className="flex justify-center items-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
      </div>
    );
  }

  if (error || !selectedAnalysis) {
    return (
      <div className="p-4 bg-rose-50 border border-rose-200 rounded-xl text-rose-700">
        {error || 'Analysis not found'}
      </div>
    );
  }

  return (
    <div className="space-y-6">
        <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
                <button 
                  onClick={handleClose}
                  className="p-2 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-white dark:hover:bg-slate-800 rounded-xl shadow-sm border border-transparent hover:border-slate-200 dark:hover:border-slate-700 transition-all"
                >
                  <ArrowLeft className="w-5 h-5" />
                </button>
                <div>
                  <h1 className="text-2xl font-bold text-slate-900 dark:text-white tracking-tight">
                    {selectedAnalysis.name}
                  </h1>
                </div>
            </div>
            {selectedAnalysis.status === 'COMPLETED' && (
              <button
                onClick={() => navigate(`/projects/${projectUuid}/analysis/${analysisUuid}/report`)}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/50 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 rounded-xl border border-indigo-200 dark:border-indigo-800 transition-all shadow-sm active:scale-[0.98]"
              >
                <FileText className="w-4 h-4" />
                View Interactive Report
              </button>
            )}
        </div>

        {selectedAnalysis.analysis_type === '15N-CEST' || selectedAnalysis.analysis_type === 'CEST' ? (
          <CestAnalysisManager
            analysis={selectedAnalysis}
            projectUuid={projectUuid!}
            availableSpectra={project?.spectra || []}
            allAnalyses={project?.analyses || []}
            onStatusChange={(status) => {
                setSelectedAnalysis({ ...selectedAnalysis, status });
            }}
            onClose={handleClose}
            onDelete={handleClose}
          />
        ) : selectedAnalysis.analysis_type === 'CPMG' ? (
          <CpmgAnalysisManager
            analysis={selectedAnalysis}
            projectUuid={projectUuid!}
            spectra={project?.spectra || []}
            onUpdate={fetchProjectDetails}
          />
        ) : (
          <AnalysisManager 
            analysis={selectedAnalysis} 
            projectUuid={projectUuid!} 
            availableSpectra={project?.spectra || []}
            onStatusChange={(status) => {
                setSelectedAnalysis({ ...selectedAnalysis, status });
            }}
            onClose={handleClose}
            onDelete={handleClose}
          />
        )}
    </div>
  );
};

export default AnalysisDetails;
