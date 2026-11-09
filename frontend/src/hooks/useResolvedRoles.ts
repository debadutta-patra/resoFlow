/**
 * ChemEx validation of the method being edited, with per-step resolved roles
 * (POST …/methods/validate — the single validation path), debounced (~500 ms)
 * and cached by method text.
 *
 * The emitted method.toml (what a run would use) is sent rather than the
 * structured config, so ROLES action indices in the answer line up exactly with
 * what the editor emits. While a newer request is pending the previous report
 * stays visible and `stale` is true.
 */

import { useEffect, useRef, useState } from 'react';
import api from '../services/api';
import type { ResolveReport } from '../lib/resolvedRoles';

export interface ResolvedRolesState {
  report: ResolveReport | null;
  loading: boolean;
  /** The report shown belongs to an older version of the method. */
  stale: boolean;
  /** Transport failure (ChemEx validation problems are in report.errors). */
  error: string | null;
}

const MAX_CACHE = 30;
const cache = new Map<string, ResolveReport>();

function remember(key: string, report: ResolveReport) {
  cache.delete(key);
  cache.set(key, report);
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string);
}

export const RESOLVE_DEBOUNCE_MS = 500;

export function useResolvedRoles(opts: {
  projectUuid: string;
  analysisUuid: string;
  model: string;
  inputsKey: string;
  methodToml: string;
  parameterToml?: string;
  /** Skip requests (e.g. while the method text is not parseable or the tab is hidden). */
  enabled?: boolean;
}): ResolvedRolesState {
  const { projectUuid, analysisUuid, model, inputsKey, methodToml, enabled = true } = opts;
  const key = `${analysisUuid}|${model}|${inputsKey}|${methodToml}`;
  const active = enabled && !!projectUuid && !!analysisUuid && !!methodToml.trim();
  const paramsRef = useRef(opts.parameterToml);
  useEffect(() => {
    paramsRef.current = opts.parameterToml;
  });
  // Last answer received (for any key) and the last transport error.
  const [last, setLast] = useState<{ key: string; report: ResolveReport } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const cached = cache.get(key);

  useEffect(() => {
    if (!active || cache.has(key)) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const body: Record<string, unknown> = { model, method_toml: methodToml };
      if (paramsRef.current?.trim()) body.parameter_toml = paramsRef.current;
      Promise.resolve()
        .then(() => api.post(`/api/projects/${projectUuid}/analysis/${analysisUuid}/methods/validate`, body))
        .then(res => {
          const report = res?.data as ResolveReport | undefined;
          if (!report || !Array.isArray(report.steps)) throw new Error('Unexpected response from methods/validate');
          remember(key, report);
          if (!cancelled) setLast({ key, report });
        })
        .catch(err => {
          if (!cancelled) setFailure({ key, message: err instanceof Error ? err.message : String(err) });
        });
    }, RESOLVE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active, projectUuid, analysisUuid, model, key, methodToml]);

  const report = cached ?? last?.report ?? null;
  const failed = failure?.key === key;
  return {
    report,
    loading: active && !cached && !failed,
    stale: !cached && !!report,
    error: failed ? failure!.message : null,
  };
}
