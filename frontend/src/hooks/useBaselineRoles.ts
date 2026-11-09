/**
 * Baseline parameter roles resolved by ChemEx (POST …/chemex/parameters/inspect),
 * cached per analysis + model + experiment inputs. Re-fetches only when one of
 * those changes; concurrent callers share one request.
 */

import { useEffect, useState } from 'react';
import api from '../services/api';
import { summarizeBaselineRoles, type BaselineRoleSummary, type InspectedParameter } from '../lib/baselineRoles';

export interface BaselineRolesState {
  roles: BaselineRoleSummary | null;
  /** Why the baseline could not be resolved (e.g. experiments not generated yet). */
  error: string | null;
  loading: boolean;
}

interface CacheEntry {
  roles: BaselineRoleSummary | null;
  error: string | null;
}

const cache = new Map<string, Promise<CacheEntry>>();

function fetchBaseline(projectUuid: string, analysisUuid: string, model: string, key: string): Promise<CacheEntry> {
  let entry = cache.get(key);
  if (!entry) {
    entry = Promise.resolve()
      .then(() => api.post(`/api/projects/${projectUuid}/analysis/${analysisUuid}/chemex/parameters/inspect`, { model }))
      .then(res => {
        const rows: InspectedParameter[] = res.data?.parameters || [];
        const error: string | null = res.data?.error || (rows.length === 0 ? 'ChemEx reported no parameters.' : null);
        return { roles: rows.length ? summarizeBaselineRoles(rows) : null, error };
      })
      .catch(err => {
        cache.delete(key); // transient failure: allow a retry on the next change
        return { roles: null, error: err instanceof Error ? err.message : String(err) };
      });
    cache.set(key, entry);
  }
  return entry;
}

export function useBaselineRoles(opts: {
  projectUuid: string;
  analysisUuid: string;
  model: string;
  /** Fingerprint of the experiment inputs; a change invalidates the cached baseline. */
  inputsKey: string;
}): BaselineRolesState {
  const { projectUuid, analysisUuid, model, inputsKey } = opts;
  const key = `${analysisUuid}|${model}|${inputsKey}`;
  const [state, setState] = useState<BaselineRolesState & { key: string }>({ key: '', roles: null, error: null, loading: false });

  useEffect(() => {
    if (!projectUuid || !analysisUuid) return;
    let cancelled = false;
    fetchBaseline(projectUuid, analysisUuid, model, key).then(entry => {
      if (!cancelled) setState({ key, ...entry, loading: false });
    });
    return () => {
      cancelled = true;
    };
  }, [projectUuid, analysisUuid, model, key]);

  // Until the fetch for the current key lands, report loading (and no stale roles).
  if (state.key !== key) return { roles: null, error: null, loading: true };
  return state;
}
