/**
 * Project-level resoFlow metadata for the Methods page (GET/PATCH /api/projects/{uuid}/settings)
 * plus the project's protein sequence. Shared by every viewer of the project (stored in the
 * database and project.json), unlike localStorage.
 */

import { useCallback, useEffect, useState } from 'react';
import api from '../services/api';

export interface ScientificCheckSetting {
  enabled: boolean;
  threshold?: number | null;
}

export interface NamedSelection {
  id: string;
  name: string;
  residues: string[];
  created_at?: string | null;
}

export interface StoredMethodTemplate {
  id: string;
  name: string;
  description: string;
  family?: string | null;
  config: Record<string, unknown>;
  created_at?: string | null;
}

export interface ProjectSettings {
  sequence_offset: number;
  scientific_checks: Record<string, ScientificCheckSetting>;
  named_selections: NamedSelection[];
  method_templates: StoredMethodTemplate[];
}

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  sequence_offset: 0,
  scientific_checks: {},
  named_selections: [],
  method_templates: [],
};

export interface ProjectSettingsState {
  settings: ProjectSettings;
  /** One-letter protein sequence ('' when none). */
  sequence: string;
  loaded: boolean;
  error: string | null;
  /** Partial update; each top-level key replaces only that key on the server. */
  update: (patch: Partial<ProjectSettings>) => Promise<boolean>;
  saveSequence: (sequence: string, offset: number) => Promise<boolean>;
}

export function useProjectSettings(projectUuid: string | undefined): ProjectSettingsState {
  const [settings, setSettings] = useState<ProjectSettings>(DEFAULT_PROJECT_SETTINGS);
  const [sequence, setSequence] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectUuid) return;
    let cancelled = false;
    Promise.all([
      api.get(`/api/projects/${projectUuid}/settings`).catch(() => null),
      api.get(`/api/projects/${projectUuid}`).catch(() => null),
    ]).then(([s, p]) => {
      if (cancelled) return;
      if (s?.data) setSettings({ ...DEFAULT_PROJECT_SETTINGS, ...s.data });
      const seq = typeof p?.data?.protein_sequence === 'string' ? p.data.protein_sequence.replace(/[^A-Za-z]/g, '').toUpperCase() : '';
      setSequence(seq);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [projectUuid]);

  const update = useCallback(
    async (patch: Partial<ProjectSettings>) => {
      if (!projectUuid) return false;
      try {
        const res = await api.patch(`/api/projects/${projectUuid}/settings`, patch);
        if (res?.data) setSettings({ ...DEFAULT_PROJECT_SETTINGS, ...res.data });
        setError(null);
        return true;
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to save project settings');
        return false;
      }
    },
    [projectUuid]
  );

  const saveSequence = useCallback(
    async (seq: string, offset: number) => {
      if (!projectUuid) return false;
      try {
        await api.put(`/api/projects/${projectUuid}`, { protein_sequence: seq });
        setSequence(seq);
        return await update({ sequence_offset: offset });
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to save the sequence');
        return false;
      }
    },
    [projectUuid, update]
  );

  return { settings, sequence, loaded, error, update, saveSequence };
}
