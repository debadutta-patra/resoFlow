/** method.toml used by the analysis's last completed run (for the "diff vs last run" view). */

import { useEffect, useState } from 'react';
import api from '../services/api';

export interface LastRunMethod {
  toml: string | null;
  completedAt: string | null;
}

const NONE: LastRunMethod = { toml: null, completedAt: null };

export function useLastRunMethod(projectUuid: string, analysisUuid: string, refreshKey: string): LastRunMethod {
  const key = `${analysisUuid}|${refreshKey}`;
  const [state, setState] = useState<{ key: string } & LastRunMethod>({ key: '', ...NONE });
  useEffect(() => {
    if (!projectUuid || !analysisUuid) return;
    let cancelled = false;
    Promise.resolve()
      .then(() => api.get(`/api/projects/${projectUuid}/analysis/${analysisUuid}/chemex/last-run-method`))
      .then(res => {
        if (!cancelled) setState({ key, toml: res?.data?.method_toml ?? null, completedAt: res?.data?.completed_at ?? null });
      })
      .catch(() => {
        if (!cancelled) setState({ key, ...NONE });
      });
    return () => {
      cancelled = true;
    };
  }, [projectUuid, analysisUuid, key]);
  return state.key === key ? { toml: state.toml, completedAt: state.completedAt } : NONE;
}
