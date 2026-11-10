/**
 * Unsaved-changes tracking for an analysis page: compares the current save payload with a
 * baseline captured after the saved config is loaded and after each successful save.
 *
 * The baseline is captured a moment after `markClean()` so that follow-up effects of a
 * restore (normalisation, derived experiments) settle first and don't read as edits.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export const BASELINE_SETTLE_MS = 400;

export function useUnsavedChanges(payload: unknown): { dirty: boolean; markClean: () => void } {
  const serialized = JSON.stringify(payload ?? null);
  const latest = useRef(serialized);
  useEffect(() => {
    latest.current = serialized;
  });
  const [baseline, setBaseline] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const markClean = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setBaseline(latest.current), BASELINE_SETTLE_MS);
  }, []);
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    []
  );
  return { dirty: baseline !== null && serialized !== baseline, markClean };
}
