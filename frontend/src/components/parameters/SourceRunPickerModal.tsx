import React, { useState, useEffect, useMemo } from 'react';
import {
  X,
  History,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Search,
  Filter,
  Loader2,
  Calendar,
  Thermometer,
  Radio,
  ArrowRight,
} from 'lucide-react';
import api from '../../services/api';
import type { SourceRunSummary, TargetAnalysisMeta } from '../../lib/compatibility';

interface SourceRunPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectUuid: string;
  targetAnalysis: TargetAnalysisMeta;
  onSelectRun: (source: SourceRunSummary) => void;
}

export const SourceRunPickerModal: React.FC<SourceRunPickerModalProps> = ({
  isOpen,
  onClose,
  projectUuid,
  targetAnalysis,
  onSelectRun,
}) => {
  const [sources, setSources] = useState<SourceRunSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [filterCompatibleOnly, setFilterCompatibleOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    if (!isOpen) return;

    const fetchSources = async () => {
      setIsLoading(true);
      setError('');
      try {
        let endpoint = `/api/projects/${projectUuid}/analysis/compatible-sources`;
        const params: Record<string, any> = {
          model: targetAnalysis.model || '2st',
          nucleus: targetAnalysis.nucleus || '15N',
          temperature: targetAnalysis.temperature || 298.15,
          static_field: targetAnalysis.static_field || 600.0,
        };

        if (targetAnalysis.analysis_uuid) {
          endpoint = `/api/projects/${projectUuid}/analysis/${targetAnalysis.analysis_uuid}/cest/compatible-sources`;
        }

        const res = await api.get(endpoint, { params });
        setSources(res.data?.sources || []);
      } catch (err: any) {
        console.error('Failed to fetch source runs:', err);
        setError(err.response?.data?.detail || 'Failed to load completed runs.');
      } finally {
        setIsLoading(false);
      }
    };

    fetchSources();
  }, [isOpen, projectUuid, targetAnalysis]);

  const filteredSources = useMemo(() => {
    return sources
      .filter((s) => {
        if (filterCompatibleOnly && !s.is_compatible) return false;
        if (searchQuery.trim()) {
          const q = searchQuery.toLowerCase();
          return (
            s.name.toLowerCase().includes(q) ||
            s.analysis_type.toLowerCase().includes(q) ||
            s.model.toLowerCase().includes(q) ||
            s.fit_mode.toLowerCase().includes(q)
          );
        }
        return true;
      })
      .sort((a, b) => {
        const dateA = new Date(a.completed_at || a.created_at).getTime();
        const dateB = new Date(b.completed_at || b.created_at).getTime();
        return dateB - dateA;
      });
  }, [sources, filterCompatibleOnly, searchQuery]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:block sm:p-0">
        <div className="fixed inset-0 transition-opacity" onClick={onClose}>
          <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-xs"></div>
        </div>
        <span className="hidden sm:inline-block sm:align-middle sm:h-screen">&#8203;</span>

        <div className="inline-block align-bottom bg-white dark:bg-slate-900 rounded-2xl text-left overflow-hidden shadow-2xl transform transition-all sm:my-8 sm:align-middle sm:max-w-4xl sm:w-full border border-slate-200 dark:border-slate-800">
          {/* Header */}
          <div className="px-6 py-5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800/60">
                <History className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-slate-900 dark:text-white">
                  Inherit Parameters from Completed Run
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Select an earlier run to seed starting values (kex_ab, pb, cs_a, dw_ab) into this analysis.
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Search & Filter Toolbar */}
          <div className="px-6 py-3 bg-slate-50 dark:bg-slate-900/50 border-b border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-3">
            <div className="relative w-full sm:w-72">
              <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
              <input
                type="text"
                placeholder="Search runs by name, mode..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-3 py-1.5 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-xs text-slate-900 dark:text-white placeholder-slate-400 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
              />
            </div>

            <label className="flex items-center gap-2 text-xs font-semibold text-slate-700 dark:text-slate-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={filterCompatibleOnly}
                onChange={(e) => setFilterCompatibleOnly(e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-4 h-4"
              />
              <Filter className="w-3.5 h-3.5 text-slate-400" />
              <span>Show compatible runs only</span>
            </label>
          </div>

          {/* Target Analysis Context Bar */}
          <div className="px-6 py-2 bg-indigo-50/50 dark:bg-indigo-950/20 border-b border-indigo-100 dark:border-indigo-900/40 text-[11px] text-indigo-900 dark:text-indigo-300 flex flex-wrap items-center gap-4">
            <span className="font-bold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">Target Settings:</span>
            <span>Model: <strong>{targetAnalysis.model?.toUpperCase() || '2ST'}</strong></span>
            <span>Nucleus: <strong>{targetAnalysis.nucleus || '15N'}</strong></span>
            <span>Field: <strong>{targetAnalysis.static_field || 600} MHz</strong></span>
            <span>Temp: <strong>{targetAnalysis.temperature ? `${targetAnalysis.temperature.toFixed(1)} K` : '298.2 K'}</strong></span>
          </div>

          {/* Body Content */}
          <div className="p-6 max-h-[60vh] overflow-y-auto">
            {isLoading ? (
              <div className="py-16 text-center">
                <Loader2 className="w-8 h-8 animate-spin mx-auto text-indigo-600 dark:text-indigo-400 mb-3" />
                <p className="text-sm font-medium text-slate-600 dark:text-slate-400">
                  Scanning for completed analyses...
                </p>
              </div>
            ) : error ? (
              <div className="p-4 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-300">
                {error}
              </div>
            ) : filteredSources.length === 0 ? (
              <div className="py-12 text-center border-2 border-dashed border-slate-200 dark:border-slate-800 rounded-xl">
                <History className="w-10 h-10 mx-auto text-slate-300 dark:text-slate-600 mb-3" />
                <h4 className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">
                  No completed runs found
                </h4>
                <p className="text-xs text-slate-500 dark:text-slate-400 max-w-sm mx-auto">
                  {filterCompatibleOnly
                    ? 'No completed runs match the compatibility criteria for this analysis.'
                    : 'This project has no completed CEST analyses to inherit from.'}
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {filteredSources.map((source) => {
                  const isBlocked = !source.is_compatible;
                  const hasWarnings = source.warning_reasons && source.warning_reasons.length > 0;
                  const completedDate = source.completed_at || source.created_at;

                  return (
                    <div
                      key={source.analysis_uuid}
                      onClick={() => {
                        if (!isBlocked) {
                          onSelectRun(source);
                        }
                      }}
                      className={`p-4 rounded-xl border transition-all ${
                        isBlocked
                          ? 'bg-slate-50 dark:bg-slate-900/40 border-slate-200 dark:border-slate-800 opacity-60 cursor-not-allowed'
                          : 'bg-white dark:bg-slate-800/80 border-slate-200 dark:border-slate-700 hover:border-indigo-500 hover:shadow-md cursor-pointer group'
                      }`}
                    >
                      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                        {/* Title & Metadata */}
                        <div className="space-y-1.5 flex-1 min-w-0">
                          <div className="flex items-center gap-2.5">
                            <h4 className="text-sm font-bold text-slate-900 dark:text-white group-hover:text-indigo-600 dark:group-hover:text-indigo-400 truncate">
                              {source.name}
                            </h4>
                            <span className="px-2 py-0.5 rounded-md text-[10px] font-extrabold uppercase tracking-wide bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
                              {source.fit_mode}
                            </span>
                            <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
                              {source.model.toUpperCase()}
                            </span>
                          </div>

                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                            <span className="flex items-center gap-1">
                              <Calendar className="w-3.5 h-3.5 text-slate-400" />
                              {completedDate ? new Date(completedDate).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—'}
                            </span>
                            <span className="flex items-center gap-1">
                              <Radio className="w-3.5 h-3.5 text-slate-400" />
                              {source.static_field ? `${source.static_field.toFixed(0)} MHz` : '—'}
                            </span>
                            <span className="flex items-center gap-1">
                              <Thermometer className="w-3.5 h-3.5 text-slate-400" />
                              {source.temperature ? `${source.temperature.toFixed(1)} K` : '—'}
                            </span>
                            {source.chi2_red !== undefined && source.chi2_red !== null && (
                              <span>
                                Reduced χ²: <strong className="text-slate-700 dark:text-slate-300">{source.chi2_red.toFixed(2)}</strong>
                              </span>
                            )}
                            {source.total_residues > 0 && (
                              <span>
                                {source.total_residues} residue{source.total_residues === 1 ? '' : 's'}
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Compatibility Status & Action */}
                        <div className="flex items-center gap-3 shrink-0">
                          {isBlocked ? (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300 border border-rose-200 dark:border-rose-800">
                              <XCircle className="w-3.5 h-3.5 text-rose-500 shrink-0" />
                              <span>Incompatible</span>
                            </span>
                          ) : hasWarnings ? (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
                              <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                              <span>Warning</span>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
                              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                              <span>Compatible</span>
                            </span>
                          )}

                          {!isBlocked && (
                            <button
                              type="button"
                              onClick={() => onSelectRun(source)}
                              className="px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-lg shadow-xs transition-all flex items-center gap-1.5 group-hover:scale-102"
                            >
                              <span>Select</span>
                              <ArrowRight className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Inline Reasons for Blocked or Warned Rows */}
                      {isBlocked && source.block_reasons.length > 0 && (
                        <div className="mt-3 pt-2.5 border-t border-rose-100 dark:border-rose-900/40 text-xs text-rose-700 dark:text-rose-300 flex items-start gap-2">
                          <XCircle className="w-3.5 h-3.5 text-rose-500 shrink-0 mt-0.5" />
                          <div>
                            <span className="font-semibold">Reason blocked:</span>{' '}
                            {source.block_reasons.join(', ')}
                          </div>
                        </div>
                      )}

                      {!isBlocked && hasWarnings && (
                        <div className="mt-3 pt-2.5 border-t border-amber-100 dark:border-amber-900/40 text-xs text-amber-800 dark:text-amber-300 flex items-start gap-2">
                          <AlertTriangle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                          <div>
                            <span className="font-semibold">Notice:</span>{' '}
                            {source.warning_reasons.join(', ')}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-6 py-4 bg-slate-50 dark:bg-slate-900/80 border-t border-slate-200 dark:border-slate-800 flex justify-between items-center text-xs text-slate-500 dark:text-slate-400">
            <span>
              Showing {filteredSources.length} of {sources.length} completed run{sources.length === 1 ? '' : 's'}
            </span>
            <button
              onClick={onClose}
              className="px-4 py-2 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-slate-700 rounded-lg font-medium hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
