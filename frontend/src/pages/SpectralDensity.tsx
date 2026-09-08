import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import api from '../services/api';
import SdmAnalysisManager from '../components/SdmAnalysisManager';
import type { SourceAnalysisOption } from '../lib/spectralDensity';

/**
 * Reduced spectral density mapping, structurally parallel to the relaxation
 * analysis page: fetch the project, hand its analyses to the manager.
 */
const SpectralDensity: React.FC = () => {
  const { projectUuid } = useParams<{ projectUuid: string }>();
  const navigate = useNavigate();

  const [project, setProject] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchProject = React.useCallback(async () => {
    try {
      setIsLoading(true);
      const response = await api.get(`/api/projects/${projectUuid}`);
      setProject(response.data);
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Failed to load project');
    } finally {
      setIsLoading(false);
    }
  }, [projectUuid]);

  useEffect(() => {
    fetchProject();
  }, [fetchProject]);

  if (isLoading) {
    return (
      <div className="flex justify-center items-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 bg-rose-50 border border-rose-200 rounded-xl text-rose-700">{error}</div>
    );
  }

  // The manager needs each source's static field, which lives on the linked
  // spectra rather than on the analysis itself.
  const analyses: SourceAnalysisOption[] = (project?.analyses ?? []).map((a: any) => ({
    analysis_uuid: a.analysis_uuid,
    name: a.name,
    analysis_type: a.analysis_type,
    status: a.status,
    b0: (a.spectra ?? []).map((s: any) => s.b0).find((b: any) => b != null) ?? null,
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center space-x-4">
        <button
          onClick={() => navigate(`/projects/${projectUuid}`)}
          className="p-2 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-white dark:hover:bg-slate-800 rounded-xl shadow-sm border border-transparent hover:border-slate-200 dark:hover:border-slate-700 transition-all"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white tracking-tight">
            Spectral Density Mapping
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            J(0), J(ω<sub>N</sub>) and J(0.87ω<sub>H</sub>) from R₁, R₂ and hetNOE at one field
          </p>
        </div>
      </div>

      <SdmAnalysisManager
        projectUuid={projectUuid!}
        analyses={analyses}
        onCreated={fetchProject}
      />
    </div>
  );
};

export default SpectralDensity;
