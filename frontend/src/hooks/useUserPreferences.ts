/** The signed-in user's resoFlow preferences (GET/PATCH /api/users/me/preferences): personal method templates. */

import { useCallback, useEffect, useState } from 'react';
import api from '../services/api';
import type { StoredMethodTemplate } from './useProjectSettings';

export interface UserPreferences {
  method_templates: StoredMethodTemplate[];
}

export function useUserPreferences() {
  const [prefs, setPrefs] = useState<UserPreferences>({ method_templates: [] });
  useEffect(() => {
    let cancelled = false;
    api
      .get('/api/users/me/preferences')
      .then(res => {
        if (!cancelled && res?.data) setPrefs({ method_templates: res.data.method_templates ?? [] });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const update = useCallback(async (patch: Partial<UserPreferences>) => {
    try {
      const res = await api.patch('/api/users/me/preferences', patch);
      if (res?.data) setPrefs({ method_templates: res.data.method_templates ?? [] });
      return true;
    } catch {
      return false;
    }
  }, []);
  return { prefs, update };
}
