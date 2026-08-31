import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { 
  Clock, 
  AlertCircle, 
  CheckCircle2, 
  XCircle, 
  StopCircle, 
  ChevronDown, 
  ChevronUp, 
  Layers,
  FileText,
  Activity,
  X
} from 'lucide-react';

import { useUserRuns, type RunItem } from '../../context/RunsContext';

interface RunsPanelProps {
  isFlyout?: boolean;
  onClose?: () => void;
}

export const RunsPanel: React.FC<RunsPanelProps> = ({ isFlyout = false, onClose }) => {
  const { runs, cancelRun, refreshRuns } = useUserRuns();
  const [cancellingUuids, setCancellingUuids] = useState<Set<string>>(new Set());
  const [isQueuedExpanded, setIsQueuedExpanded] = useState(false);
  const [confirmCancelUuid, setConfirmCancelUuid] = useState<string | null>(null);
  const [, setNow] = useState(Date.now());

  // Live timer tick for running jobs
  useEffect(() => {
    const hasActive = runs.some((r) => r.status === 'RUNNING');
    if (!hasActive) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [runs]);

  const runningRuns = runs.filter((r) => r.status === 'RUNNING');
  const queuedRuns = runs.filter((r) => r.status === 'PENDING');
  const failedRuns = runs.filter((r) => r.status === 'FAILED');
  const completedRuns = runs.filter((r) => r.status === 'COMPLETED');

  const formatElapsed = (createdStr: string, completedStr?: string | null, elapsedSec?: number | null) => {
    if (elapsedSec !== null && elapsedSec !== undefined && completedStr) {
      const mins = Math.floor(elapsedSec / 60);
      const secs = Math.floor(elapsedSec % 60);
      return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    }
    const start = new Date(createdStr).getTime();
    const end = completedStr ? new Date(completedStr).getTime() : Date.now();
    const totalSecs = Math.max(0, Math.floor((end - start) / 1000));
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    const hours = Math.floor(mins / 60);
    if (hours > 0) {
      return `${hours}h ${mins % 60}m ${secs}s`;
    }
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  };

  const handleCancelClick = async (uuid: string) => {
    setCancellingUuids((prev) => new Set(prev).add(uuid));
    setConfirmCancelUuid(null);
    await cancelRun(uuid);
    setCancellingUuids((prev) => {
      const next = new Set(prev);
      next.delete(uuid);
      return next;
    });
    refreshRuns();
  };

  const getRunLink = (run: RunItem) => {
    if (run.kind === 'analysis') {
      return `/projects/${run.project_uuid}/analysis/${run.uuid}`;
    }
    return `/projects/${run.project_uuid}`;
  };

  const hasRuns = runs.length > 0;

  return (
    <div className={`bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden transition-colors ${isFlyout ? 'p-4' : 'p-6'}`}>
      {/* Header */}
      <div className="flex items-center justify-between pb-4 border-b border-slate-100 dark:border-slate-700/60">
        <div className="flex items-center space-x-3">
          <div className="p-2 rounded-lg bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400">
            <Activity className="w-5 h-5" />
          </div>
          <div>
            <h3 className="font-semibold text-slate-900 dark:text-white flex items-center gap-2">
              Run Queue & Active Jobs
              {runningRuns.length > 0 && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-900/60 text-blue-700 dark:text-blue-300">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse mr-1.5" />
                  {runningRuns.length} Running
                </span>
              )}
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Live status, cancellation, and log-extracted error diagnosis
            </p>
          </div>
        </div>

        {isFlyout && onClose && (
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 rounded-md"
            title="Close"
          >
            <X className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Body */}
      <div className="space-y-6 pt-4">
        {!hasRuns && (
          <div className="text-center py-10 px-4">
            <CheckCircle2 className="w-10 h-10 text-emerald-500 dark:text-emerald-400 mx-auto mb-2 opacity-80" />
            <h4 className="text-sm font-medium text-slate-900 dark:text-white">All quiet</h4>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-sm mx-auto">
              No active, queued, or recently failed fitting runs. Start an analysis inside any project to monitor execution here.
            </p>
          </div>
        )}

        {/* 1. RUNNING RUNS */}
        {runningRuns.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-blue-500 animate-ping" />
                Active Runs ({runningRuns.length})
              </span>
            </div>

            <div className="divide-y divide-slate-100 dark:divide-slate-700/50 border border-blue-200 dark:border-blue-900/50 rounded-lg overflow-hidden bg-blue-50/20 dark:bg-blue-950/10">
              {runningRuns.map((run) => {
                const isCancelling = cancellingUuids.has(run.uuid);
                const isConfirming = confirmCancelUuid === run.uuid;

                return (
                  <div key={run.uuid} className="p-4 hover:bg-blue-50/40 dark:hover:bg-blue-900/20 transition-colors">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Link
                            to={getRunLink(run)}
                            className="font-medium text-sm text-slate-900 dark:text-white hover:text-blue-600 dark:hover:text-blue-400 truncate"
                          >
                            {run.name}
                          </Link>
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300">
                            {run.analysis_type || 'Fitting'}
                          </span>
                          {run.fit_mode && (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
                              {run.fit_mode}
                            </span>
                          )}
                        </div>

                        <div className="mt-1 flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400 flex-wrap">
                          <span className="flex items-center">
                            <Layers className="w-3.5 h-3.5 mr-1 text-slate-400" />
                            {run.project_name}
                          </span>
                          <span className="flex items-center text-blue-600 dark:text-blue-400 font-medium">
                            <Clock className="w-3.5 h-3.5 mr-1" />
                            Elapsed: {formatElapsed(run.created_at, null, run.elapsed_seconds)}
                          </span>
                          {run.current_step && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
                              {run.current_step}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Cancel button */}
                      <div className="shrink-0 flex items-center gap-2">
                        {isConfirming ? (
                          <div className="flex items-center gap-1.5 bg-red-50 dark:bg-red-950/40 p-1 rounded border border-red-200 dark:border-red-800">
                            <span className="text-[11px] text-red-700 dark:text-red-300 font-medium px-1">Stop run?</span>
                            <button
                              onClick={() => handleCancelClick(run.uuid)}
                              disabled={isCancelling}
                              className="px-2 py-0.5 bg-red-600 hover:bg-red-700 text-white rounded text-xs font-semibold shadow-sm transition"
                            >
                              {isCancelling ? 'Stopping...' : 'Yes, Stop'}
                            </button>
                            <button
                              onClick={() => setConfirmCancelUuid(null)}
                              className="px-1.5 py-0.5 text-slate-500 hover:text-slate-700 dark:text-slate-400 text-xs"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setConfirmCancelUuid(run.uuid)}
                            disabled={isCancelling}
                            className="inline-flex items-center px-2.5 py-1 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 border border-red-200 dark:border-red-900/50 rounded-lg transition-colors"
                            title="Terminate run process"
                          >
                            <StopCircle className="w-3.5 h-3.5 mr-1" />
                            Stop
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 2. FAILED RUNS WITH REASON */}
        {failedRuns.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-red-600 dark:text-red-400">
              <span className="flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5" />
                Failed Runs ({failedRuns.length})
              </span>
            </div>

            <div className="divide-y divide-slate-100 dark:divide-slate-700/50 border border-red-200 dark:border-red-900/50 rounded-lg overflow-hidden bg-red-50/10 dark:bg-red-950/10">
              {failedRuns.map((run) => (
                <div key={run.uuid} className="p-4 hover:bg-red-50/20 dark:hover:bg-red-900/10 transition-colors">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Link
                          to={getRunLink(run)}
                          className="font-medium text-sm text-slate-900 dark:text-white hover:text-red-600 dark:hover:text-red-400 truncate"
                        >
                          {run.name}
                        </Link>
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-300">
                          <XCircle className="w-3 h-3 mr-1" />
                          Failed
                        </span>
                        <span className="text-xs text-slate-400">
                          in {run.project_name}
                        </span>
                      </div>

                      {/* Log-extracted failure reason banner */}
                      <div className="mt-2 p-2.5 rounded bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/60 text-xs text-red-900 dark:text-red-200">
                        <div className="font-semibold flex items-center gap-1.5 mb-0.5 text-red-800 dark:text-red-300">
                          <AlertCircle className="w-3.5 h-3.5 text-red-600 dark:text-red-400 shrink-0" />
                          Failure Reason:
                        </div>
                        <p className="font-mono text-[11px] break-words whitespace-pre-wrap">
                          {run.error_reason || 'Process failed during execution (check logs for details).'}
                        </p>
                      </div>

                      <div className="mt-2 flex items-center gap-4 text-xs text-slate-500 dark:text-slate-400">
                        <span>Ran for: {formatElapsed(run.created_at, run.completed_at, run.elapsed_seconds)}</span>
                        <Link
                          to={getRunLink(run)}
                          className="inline-flex items-center text-blue-600 dark:text-blue-400 hover:underline"
                        >
                          <FileText className="w-3.5 h-3.5 mr-1" />
                          View Full Logs
                        </Link>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 3. QUEUED RUNS */}
        {queuedRuns.length > 0 && (
          <div className="space-y-2">
            <button
              onClick={() => setIsQueuedExpanded((prev) => !prev)}
              className="w-full flex items-center justify-between p-3 rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50/40 dark:bg-amber-950/20 text-amber-800 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/40 transition-colors text-xs font-medium"
            >
              <span className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                <span>{queuedRuns.length} Queued Run{queuedRuns.length > 1 ? 's' : ''} in Shared Worker Backlog</span>
              </span>
              <span className="flex items-center gap-1 text-[11px]">
                {isQueuedExpanded ? 'Collapse' : 'View Queue'}
                {isQueuedExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </span>
            </button>

            {isQueuedExpanded && (
              <div className="divide-y divide-slate-100 dark:divide-slate-700/50 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden bg-white dark:bg-slate-900/40">
                {queuedRuns.map((run, idx) => (
                  <div key={run.uuid} className="p-3 text-xs flex items-center justify-between">
                    <div>
                      <span className="font-semibold text-slate-900 dark:text-white mr-2">#{idx + 1}</span>
                      <Link to={getRunLink(run)} className="text-blue-600 dark:text-blue-400 hover:underline">
                        {run.name}
                      </Link>
                      <span className="text-slate-400 ml-2">({run.project_name})</span>
                    </div>
                    <span className="text-slate-500 dark:text-slate-400">Waiting for worker</span>
                  </div>
                ))}
              </div>
            )}

            <p className="text-[11px] text-slate-400 dark:text-slate-500 italic px-1">
              Note: Workers process jobs in FIFO order across all system users.
            </p>
          </div>
        )}

        {/* 4. RECENTLY COMPLETED RUNS */}
        {completedRuns.length > 0 && (
          <div className="space-y-2 pt-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
              Recently Completed
            </div>
            <div className="divide-y divide-slate-100 dark:divide-slate-700/40 border border-slate-100 dark:border-slate-800 rounded-lg bg-slate-50/50 dark:bg-slate-900/30">
              {completedRuns.slice(0, 3).map((run) => (
                <div key={run.uuid} className="p-3 flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2 truncate pr-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                    <Link to={getRunLink(run)} className="text-slate-800 dark:text-slate-200 hover:text-blue-600 truncate font-medium">
                      {run.name}
                    </Link>
                    <span className="text-slate-400 text-[11px] truncate">({run.project_name})</span>
                  </div>
                  <span className="text-slate-400 text-[11px] shrink-0 font-mono">
                    {formatElapsed(run.created_at, run.completed_at, run.elapsed_seconds)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default RunsPanel;
