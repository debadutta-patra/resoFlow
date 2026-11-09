/**
 * Per-step durations of the analysis's last ChemEx run (GET …/chemex/step-timings),
 * refetched whenever `refreshKey` changes (e.g. when a run finishes).
 */

import { useEffect, useState } from 'react';
import api from '../services/api';
import type { StepTiming } from '../lib/searchEstimate';

export function useStepTimings(projectUuid: string, analysisUuid: string, refreshKey: string): StepTiming[] {
  const [timings, setTimings] = useState<{ key: string; steps: StepTiming[] }>({ key: '', steps: [] });
  const key = `${analysisUuid}|${refreshKey}`;
  useEffect(() => {
    if (!projectUuid || !analysisUuid) return;
    let cancelled = false;
    Promise.resolve()
      .then(() => api.get(`/api/projects/${projectUuid}/analysis/${analysisUuid}/chemex/step-timings`))
      .then(res => {
        const steps: StepTiming[] = Array.isArray(res?.data?.steps) ? res.data.steps : [];
        if (!cancelled) setTimings({ key, steps });
      })
      .catch(() => {
        if (!cancelled) setTimings({ key, steps: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [projectUuid, analysisUuid, key]);
  return timings.key === key ? timings.steps : [];
}
