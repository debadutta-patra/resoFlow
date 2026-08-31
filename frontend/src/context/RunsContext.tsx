import React, { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import api from '../services/api';
import { useAuth } from './AuthContext';

export interface RunItem {
  id: number;
  uuid: string;
  name: string;
  kind: 'analysis' | 'peak_fitting';
  analysis_type: string | null;
  status: 'RUNNING' | 'PENDING' | 'COMPLETED' | 'FAILED';
  project_id: number;
  project_uuid: string;
  project_name: string;
  created_at: string;
  completed_at: string | null;
  elapsed_seconds: number | null;
  error_reason: string | null;
  current_step: string | null;
  log_path: string | null;
  fit_mode: string | null;
}

interface RunsContextType {
  runs: RunItem[];
  activeCount: number;
  queuedCount: number;
  isPanelOpen: boolean;
  setIsPanelOpen: (open: boolean) => void;
  togglePanel: () => void;
  refreshRuns: () => Promise<void>;
  cancelRun: (uuid: string) => Promise<boolean>;
  setRunsFromDashboard: (runs: RunItem[]) => void;
}

const RunsContext = createContext<RunsContextType | undefined>(undefined);

export const RunsProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { isAuthenticated } = useAuth();
  const [runs, setRuns] = useState<RunItem[]>([]);
  const [isPanelOpen, setIsPanelOpen] = useState(false);

  const activeCount = runs.filter((r) => r.status === 'RUNNING').length;
  const queuedCount = runs.filter((r) => r.status === 'PENDING').length;

  const refreshRuns = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      const response = await api.get('/api/users/me/runs/active');
      const activeRuns: RunItem[] = response.data.runs || [];
      
      setRuns((prev) => {
        // Keep recent terminal runs that might have been on the dashboard, update or merge active runs
        const activeUuids = new Set(activeRuns.map((r) => r.uuid));
        const keptTerminal = prev.filter((r) => !activeUuids.has(r.uuid) && (r.status === 'COMPLETED' || r.status === 'FAILED'));
        return [...activeRuns, ...keptTerminal.slice(0, 10)];
      });
    } catch (err) {
      console.error('Failed to poll active runs:', err);
    }
  }, [isAuthenticated]);

  const setRunsFromDashboard = useCallback((newRuns: RunItem[]) => {
    setRuns(newRuns);
  }, []);

  const cancelRun = useCallback(async (uuid: string): Promise<boolean> => {
    try {
      await api.post(`/api/users/me/runs/${uuid}/cancel`);
      // Optimistic update
      setRuns((prev) =>
        prev.map((r) =>
          r.uuid === uuid
            ? { ...r, status: 'FAILED', error_reason: 'Cancelled by user', completed_at: new Date().toISOString() }
            : r
        )
      );
      return true;
    } catch (err) {
      console.error('Failed to cancel run:', err);
      return false;
    }
  }, []);

  const togglePanel = useCallback(() => {
    setIsPanelOpen((prev) => !prev);
  }, []);

  // Adaptive polling with visibility backoff
  useEffect(() => {
    if (!isAuthenticated) return;

    // Initial fetch
    refreshRuns();

    let intervalId: ReturnType<typeof setInterval> | null = null;

    const setupInterval = () => {
      if (intervalId) clearInterval(intervalId);

      // Do not poll when tab is hidden
      if (document.visibilityState === 'hidden') {
        return;
      }

      // Fast interval (3s) when active/queued runs exist, slow backoff (20s) when idle
      const intervalMs = (activeCount > 0 || queuedCount > 0) ? 3000 : 20000;

      intervalId = setInterval(() => {
        refreshRuns();
      }, intervalMs);
    };

    setupInterval();

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refreshRuns();
        setupInterval();
      } else {
        if (intervalId) clearInterval(intervalId);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      if (intervalId) clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isAuthenticated, activeCount, queuedCount, refreshRuns]);

  return (
    <RunsContext.Provider
      value={{
        runs,
        activeCount,
        queuedCount,
        isPanelOpen,
        setIsPanelOpen,
        togglePanel,
        refreshRuns,
        cancelRun,
        setRunsFromDashboard,
      }}
    >
      {children}
    </RunsContext.Provider>
  );
};

export const useUserRuns = () => {
  const context = useContext(RunsContext);
  if (context === undefined) {
    throw new Error('useUserRuns must be used within a RunsProvider');
  }
  return context;
};
