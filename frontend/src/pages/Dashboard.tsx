import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useUserRuns } from '../context/RunsContext';
import api from '../services/api';
import CreateProjectModal from '../components/CreateProjectModal';
import ImportProjectModal from '../components/ImportProjectModal';
import DeleteConfirmationModal from '../components/DeleteConfirmationModal';
import RunsPanel from '../components/dashboard/RunsPanel';
import RecentAnalyses, { type RecentAnalysisItem } from '../components/dashboard/RecentAnalyses';
import ProjectGrid, { type EnrichedProject } from '../components/dashboard/ProjectGrid';
import { 
  Plus, 
  FolderPlus,
  RefreshCw
} from 'lucide-react';


interface DashboardStats {
  total_projects: number;
  total_spectra: number;
  total_jobs: number;
  active_runs: number;
  queued_runs: number;
  failed_runs: number;
  completed_runs: number;
}

interface DashboardData {
  stats: DashboardStats;
  runs: any[];
  recent_analyses: RecentAnalysisItem[];
  projects: EnrichedProject[];
}

const Dashboard: React.FC = () => {
  const { user } = useAuth();
  const { setRunsFromDashboard } = useUserRuns();
  const [data, setData] = useState<DashboardData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [deleteModal, setDeleteModal] = useState<{ isOpen: boolean; project: EnrichedProject | null }>({
    isOpen: false,
    project: null,
  });

  const fetchDashboardData = useCallback(async (showRefreshingSpinner: boolean = false) => {
    if (showRefreshingSpinner) setIsRefreshing(true);
    try {
      const response = await api.get('/api/users/me/dashboard');
      setData(response.data);
      if (response.data.runs) {
        setRunsFromDashboard(response.data.runs);
      }
      setError('');
    } catch (err) {
      setError('Failed to load dashboard data.');
      console.error('Error loading dashboard:', err);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [setRunsFromDashboard]);

  useEffect(() => {
    fetchDashboardData();
  }, [fetchDashboardData]);

  const handleProjectCreated = () => {
    setIsModalOpen(false);
    setIsImportModalOpen(false);
    fetchDashboardData(true);
  };

  const handleDeleteProject = async (deleteFiles?: boolean) => {
    if (!deleteModal.project) return;
    try {
      await api.delete(`/api/projects/${deleteModal.project.project_uuid}`, {
        params: { delete_files: !!deleteFiles }
      });
      setDeleteModal({ isOpen: false, project: null });
      fetchDashboardData(true);
    } catch (err) {
      console.error('Failed to delete project:', err);
      alert('Failed to delete project');
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-900 flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600 dark:border-indigo-500 mx-auto"></div>
          <p className="text-xs text-slate-500 dark:text-slate-400">Loading workspace dashboard...</p>
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-900 flex items-center justify-center p-4">
        <div className="bg-white dark:bg-slate-800 p-6 rounded-xl shadow-sm border border-red-100 dark:border-red-900/50 text-center max-w-md w-full">
          <div className="text-red-500 mb-2">
            <svg className="w-12 h-12 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-slate-900 dark:text-white mb-2">Error Loading Dashboard</h3>
          <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">{error}</p>
          <button 
            onClick={() => fetchDashboardData(true)}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg shadow-sm transition"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 transition-colors duration-200">
      <main className="mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8 max-w-7xl">
        
        {/* Header Section */}
        <div className="flex sm:flex-row flex-col sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center space-x-2">
              <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Workspace Dashboard</h1>
              {isRefreshing && (
                <RefreshCw className="w-4 h-4 text-blue-500 animate-spin" />
              )}
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
              Active fitting runs, error diagnostics, and recent relaxation analyses for <span className="font-semibold text-slate-700 dark:text-slate-300">{user?.full_name || user?.email}</span>.
            </p>
          </div>

          <div className="flex gap-3">
            <button
              onClick={() => setIsImportModalOpen(true)}
              className="inline-flex items-center px-3.5 py-2 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-medium rounded-lg shadow-sm transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 whitespace-nowrap"
            >
              <FolderPlus className="w-4 h-4 mr-2 text-slate-500" />
              Import Project
            </button>
            <button
              onClick={() => setIsModalOpen(true)}
              className="inline-flex items-center px-3.5 py-2 bg-blue-600 dark:bg-indigo-600 hover:bg-blue-700 dark:hover:bg-indigo-700 text-white text-xs font-semibold rounded-lg shadow-sm transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 whitespace-nowrap"
            >
              <Plus className="w-4 h-4 mr-1.5" />
              New Project
            </button>
          </div>
        </div>

        {/* 1. RUNS PANEL (Replaces the Active Jobs card) */}
        <RunsPanel isFlyout={false} />

        {/* 2. MAIN WORKSPACE GRID: PROJECTS & RECENT ANALYSES */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-start">
          
          {/* Left Column (2/3 width): Projects Grid */}
          <div className="lg:col-span-2 space-y-6">
            <ProjectGrid
              projects={data?.projects || []}
              onNewProject={() => setIsModalOpen(true)}
              onImportProject={() => setIsImportModalOpen(true)}
              onDeleteProject={(project) => setDeleteModal({ isOpen: true, project })}
              onRefresh={() => fetchDashboardData(false)}
            />
          </div>

          {/* Right Column (1/3 width): Recent Analyses (Replaces login activity feed) */}
          <div className="lg:col-span-1 space-y-6">
            <RecentAnalyses analyses={data?.recent_analyses || []} />
          </div>

        </div>
      </main>

      {/* Modals */}
      <CreateProjectModal 
        isOpen={isModalOpen} 
        onClose={() => setIsModalOpen(false)} 
        onSuccess={handleProjectCreated}
      />

      <ImportProjectModal
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        onSuccess={handleProjectCreated}
      />

      <DeleteConfirmationModal
        isOpen={deleteModal.isOpen}
        onClose={() => setDeleteModal({ isOpen: false, project: null })}
        onConfirm={handleDeleteProject}
        title="Delete Project"
        message="Are you sure you want to delete this project? This will remove the database records."
        itemName={deleteModal.project?.name}
        showDeleteFilesOption={true}
      />
    </div>
  );
};

export default Dashboard;
