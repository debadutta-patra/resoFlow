import React from 'react';
import { Link } from 'react-router-dom';
import { 
  FileSearch, 
  ArrowUpRight, 
  Clock, 
  Layers, 
  CheckCircle2, 
  XCircle, 
  Loader2,
  TrendingDown
} from 'lucide-react';

export interface RecentAnalysisItem {
  id: number;
  analysis_uuid: string;
  name: string;
  analysis_type: string;
  status: string;
  project_id: number;
  project_uuid: string;
  project_name: string;
  fit_mode?: string | null;
  reduced_chi2?: number | null;
  created_at: string;
  completed_at?: string | null;
}

interface RecentAnalysesProps {
  analyses: RecentAnalysisItem[];
}

export const RecentAnalyses: React.FC<RecentAnalysesProps> = ({ analyses }) => {
  const formatDate = (dateString?: string | null) => {
    if (!dateString) return 'Pending';
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
  };

  const getStatusBadge = (status: string) => {
    switch (status.toUpperCase()) {
      case 'COMPLETED':
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
            <CheckCircle2 className="w-3 h-3 mr-1 text-emerald-600 dark:text-emerald-400" />
            Done
          </span>
        );
      case 'RUNNING':
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
            <Loader2 className="w-3 h-3 mr-1 animate-spin text-blue-600 dark:text-blue-400" />
            Running
          </span>
        );
      case 'FAILED':
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800">
            <XCircle className="w-3 h-3 mr-1 text-red-600 dark:text-red-400" />
            Failed
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700">
            <Clock className="w-3 h-3 mr-1 text-slate-400" />
            Queued
          </span>
        );
    }
  };

  return (
    <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden transition-colors">
      <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700/60 flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <FileSearch className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
          <h3 className="font-semibold text-slate-900 dark:text-white">Recent Analyses</h3>
        </div>
        <span className="text-xs text-slate-400 dark:text-slate-500 font-medium">
          {analyses.length} Total
        </span>
      </div>

      {analyses.length === 0 ? (
        <div className="px-6 py-12 text-center">
          <FileSearch className="w-10 h-10 text-slate-300 dark:text-slate-600 mx-auto mb-2" />
          <h4 className="text-sm font-medium text-slate-800 dark:text-slate-200">No analyses created yet</h4>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-xs mx-auto">
            Create an NMR relaxation or ChemEx fit inside a project to inspect results and fit statistics here.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-slate-100 dark:divide-slate-700/50 overflow-x-auto">
          {analyses.map((analysis) => (
            <div
              key={analysis.analysis_uuid}
              className="px-6 py-3.5 hover:bg-slate-50 dark:hover:bg-slate-750/50 transition-colors flex items-center justify-between gap-4 group"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <Link
                    to={`/projects/${analysis.project_uuid}/analysis/${analysis.analysis_uuid}`}
                    className="font-medium text-sm text-slate-900 dark:text-white group-hover:text-blue-600 dark:group-hover:text-indigo-400 transition-colors truncate"
                  >
                    {analysis.name}
                  </Link>
                  {getStatusBadge(analysis.status)}
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-mono font-medium bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300">
                    {analysis.analysis_type}
                  </span>
                  {analysis.fit_mode && (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 border border-indigo-100 dark:border-indigo-800/40">
                      {analysis.fit_mode}
                    </span>
                  )}
                </div>

                <div className="mt-1 flex items-center gap-4 text-xs text-slate-500 dark:text-slate-400 flex-wrap">
                  <span className="flex items-center">
                    <Layers className="w-3.5 h-3.5 mr-1 text-slate-400" />
                    {analysis.project_name}
                  </span>

                  {analysis.reduced_chi2 !== null && analysis.reduced_chi2 !== undefined && (
                    <span className="inline-flex items-center font-mono text-[11px] text-emerald-700 dark:text-emerald-400 bg-emerald-50/70 dark:bg-emerald-950/30 px-1.5 py-0.5 rounded border border-emerald-100 dark:border-emerald-900/40" title="Reduced Chi-Squared Fit Metric">
                      <TrendingDown className="w-3 h-3 mr-1" />
                      &chi;&sup2;<sub>red</sub>: {analysis.reduced_chi2.toFixed(3)}
                    </span>
                  )}

                  <span className="flex items-center text-slate-400 dark:text-slate-500">
                    <Clock className="w-3 h-3 mr-1" />
                    {formatDate(analysis.completed_at || analysis.created_at)}
                  </span>
                </div>
              </div>

              <Link
                to={`/projects/${analysis.project_uuid}/analysis/${analysis.analysis_uuid}`}
                className="shrink-0 inline-flex items-center px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:border-blue-400 dark:hover:border-indigo-500 text-xs font-medium text-slate-700 dark:text-slate-300 hover:text-blue-600 dark:hover:text-indigo-400 bg-white dark:bg-slate-800 shadow-sm transition-all"
              >
                <span>Open</span>
                <ArrowUpRight className="w-3.5 h-3.5 ml-1" />
              </Link>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default RecentAnalyses;
