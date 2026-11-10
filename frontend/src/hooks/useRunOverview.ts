/**
 * Last completed run's overview (GET …/chemex/run-overview), served from the results bundle.
 * Refetched when `refreshKey` changes (e.g. a run starts or ends); absent while a run is active.
 */

import { useCallback, useEffect, useState } from 'react';
import api from '../services/api';
import type { GridSurface, RunOverview } from '../lib/runOverview';

export interface RunOverviewState {
  overview: RunOverview | null;
  completedAt: string | null;
  loadSurface: (step: string, x: string, y: string) => Promise<GridSurface | null>;
}

export function useRunOverview(projectUuid: string, analysisUuid: string, refreshKey: string): RunOverviewState {
  const key = `${analysisUuid}|${refreshKey}`;
  const [state, setState] = useState<{ key: string; overview: RunOverview | null; completedAt: string | null }>({ key: '', overview: null, completedAt: null });
  const base = `/api/projects/${projectUuid}/analysis/${analysisUuid}/chemex`;
  useEffect(() => {
    if (!projectUuid || !analysisUuid) return;
    let cancelled = false;
    Promise.resolve()
      .then(() => api.get(`${base}/run-overview`))
      .then(res => {
        if (cancelled) return;
        const ok = res?.data?.available && res.data.overview && Array.isArray(res.data.overview.steps);
        setState({ key, overview: ok ? res.data.overview : null, completedAt: ok ? res.data.completed_at ?? null : null });
      })
      .catch(() => {
        if (!cancelled) setState({ key, overview: null, completedAt: null });
      });
    return () => {
      cancelled = true;
    };
  }, [projectUuid, analysisUuid, key, base]);
  const loadSurface = useCallback(
    async (step: string, x: string, y: string) => {
      try {
        const res = await api.get(`${base}/steps/${encodeURIComponent(step)}/grid-surface`, { params: { x, y } });
        return (res?.data as GridSurface) ?? null;
      } catch {
        return null;
      }
    },
    [base]
  );
  const current = state.key === key;
  return { overview: current ? state.overview : null, completedAt: current ? state.completedAt : null, loadSurface };
}
