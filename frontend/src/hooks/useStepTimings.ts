/**
 * Per-step durations (and resolved worker count) of the analysis's last ChemEx run (GET …/chemex/step-timings),
 * refetched whenever `refreshKey` changes (e.g. when a run finishes).
 */

import { useEffect, useState } from 'react';
import api from '../services/api';
import type { StepTiming } from '../lib/searchEstimate';

export interface RunTimings {
  steps: StepTiming[];
  /** Parallel workers the last run actually used (ChemEx-resolved), if recorded. */
  workers: number | null;
  /** Latest finished "Test on 1 residue" run (reduced method), used when no full run timing exists. */
  test: { residue: string; steps: StepTiming[] } | null;
}

const EMPTY: RunTimings = { steps: [], workers: null, test: null };

export function useStepTimings(projectUuid: string, analysisUuid: string, refreshKey: string): RunTimings {
  const [timings, setTimings] = useState<{ key: string } & RunTimings>({ key: '', ...EMPTY });
  const key = `${analysisUuid}|${refreshKey}`;
  useEffect(() => {
    if (!projectUuid || !analysisUuid) return;
    let cancelled = false;
    Promise.resolve()
      .then(() => api.get(`/api/projects/${projectUuid}/analysis/${analysisUuid}/chemex/step-timings`))
      .then(res => {
        const steps: StepTiming[] = Array.isArray(res?.data?.steps) ? res.data.steps : [];
        const workers = typeof res?.data?.workers === 'number' ? res.data.workers : null;
        const t = res?.data?.test;
        const test = t && Array.isArray(t.steps) ? { residue: String(t.residue ?? ''), steps: t.steps as StepTiming[] } : null;
        if (!cancelled) setTimings({ key, steps, workers, test });
      })
      .catch(() => {
        if (!cancelled) setTimings({ key, ...EMPTY });
      });
    return () => {
      cancelled = true;
    };
  }, [projectUuid, analysisUuid, key]);
  return timings.key === key ? { steps: timings.steps, workers: timings.workers, test: timings.test } : EMPTY;
}
