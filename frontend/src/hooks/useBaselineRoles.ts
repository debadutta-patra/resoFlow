/**
 * Baseline parameter roles and the selector catalog, resolved by ChemEx
 * (POST …/chemex/parameters/inspect), cached per analysis + model + experiment
 * inputs. Concurrent callers share one request.
 *
 * The unsaved parameters TOML is sent (a never-run analysis may have no
 * parameters file on disk yet) but is not part of the cache key: baseline roles
 * and the parameter catalog do not depend on parameter values.
 */

import { useEffect, useRef, useState } from 'react';
import api from '../services/api';
import {
  buildParameterCatalog,
  summarizeBaselineRoles,
  type BaselineRoleSummary,
  type InspectedParameter,
  type ParameterCatalog,
} from '../lib/baselineRoles';

export interface BaselineRolesState {
  roles: BaselineRoleSummary | null;
  /** Per-name selectable qualifier values and protection flags. */
  catalog: ParameterCatalog | null;
  /** Why the baseline could not be resolved (e.g. experiments not generated yet). */
  error: string | null;
  loading: boolean;
}

interface CacheEntry {
  roles: BaselineRoleSummary | null;
  catalog: ParameterCatalog | null;
  error: string | null;
}

const cache = new Map<string, Promise<CacheEntry>>();

function fetchBaseline(url: string, body: Record<string, unknown>, key: string): Promise<CacheEntry> {
  let entry = cache.get(key);
  if (!entry) {
    entry = Promise.resolve()
      .then(() => api.post(url, body))
      .then(res => {
        const rows: InspectedParameter[] = res?.data?.parameters || [];
        const error: string | null = res?.data?.error || (rows.length === 0 ? 'ChemEx reported no parameters.' : null);
        return rows.length
          ? { roles: summarizeBaselineRoles(rows), catalog: buildParameterCatalog(rows), error }
          : { roles: null, catalog: null, error };
      })
      .catch(err => {
        cache.delete(key); // transient failure: allow a retry on the next change
        return { roles: null, catalog: null, error: err instanceof Error ? err.message : String(err) };
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
  /** Current (possibly unsaved) parameters.toml; read at fetch time only. */
  parameterToml?: string;
}): BaselineRolesState {
  const { projectUuid, analysisUuid, model, inputsKey } = opts;
  const key = `${analysisUuid}|${model}|${inputsKey}`;
  const paramsRef = useRef(opts.parameterToml);
  useEffect(() => {
    paramsRef.current = opts.parameterToml;
  });
  const [state, setState] = useState<BaselineRolesState & { key: string }>({ key: '', roles: null, catalog: null, error: null, loading: false });

  useEffect(() => {
    if (!projectUuid || !analysisUuid) return;
    let cancelled = false;
    const url = `/api/projects/${projectUuid}/analysis/${analysisUuid}/chemex/parameters/inspect`;
    const body: Record<string, unknown> = { model };
    if (paramsRef.current?.trim()) body.parameter_toml = paramsRef.current;
    fetchBaseline(url, body, key).then(entry => {
      if (!cancelled) setState({ key, ...entry, loading: false });
    });
    return () => {
      cancelled = true;
    };
  }, [projectUuid, analysisUuid, model, key]);

  // Until the fetch for the current key lands, report loading (and no stale roles).
  if (state.key !== key) return { roles: null, catalog: null, error: null, loading: true };
  return state;
}
