/**
 * State and actions behind the shared residue browser (Pick CEST, Inspect Dispersion):
 * selection synced to `?res=` in the URL, review statuses/notes/flags, keyboard shortcuts
 * and a single undo stack covering every browser action.
 *
 * Review state itself lives in the page (it is saved with the analysis config); this hook
 * only reads it and writes it through `setReview`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type BrowserRow,
  type ReviewState,
  type ReviewStatus,
  type StoredStatus,
  type ShortcutAction,
  type UndoEntry,
  isFlagged,
  noteOf,
  pushUndo,
  reviewProgress,
  rowForParam,
  setNote as setNoteIn,
  setStatus,
  shortcutFor,
  shortcutHelp,
  statusOf,
  storedStatusOf,
  stepRow,
  toggleFlag as toggleFlagIn,
} from '../lib/residueReview';

export const RESIDUE_URL_PARAM = 'res';

function readUrlParam(name: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}

function writeUrlParam(name: string, value: string | null) {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(window.location.href);
    if (value) url.searchParams.set(name, value);
    else url.searchParams.delete(name);
    if (url.href !== window.location.href) {
      // Keep the router's history state so back/forward still work.
      window.history.replaceState(window.history.state, '', url.toString());
    }
  } catch {
    /* non-browser environment */
  }
}

export interface UseResidueBrowserOptions {
  rows: BrowserRow[];
  review: ReviewState;
  setReview: (update: (prev: ReviewState) => ReviewState) => void;
  isExcluded: (id: string) => boolean;
  toggleExclude: (id: string) => void;
  /** Only the visible page listens to the keyboard and owns the URL parameter. */
  active: boolean;
  /** Pick CEST: A … F arm CS_A … CS_F picking. */
  onArm?: (mode: 'cs_a' | 'cs_b' | 'cs_c' | 'cs_d' | 'cs_e' | 'cs_f') => void;
  /**
   * Extra work when a residue is accepted (e.g. commit a suggested CS_A). May return an
   * undo function for that work.
   */
  onAccept?: (id: string) => (() => void) | void;
  /**
   * Page-specific status override, e.g. Pick CEST counts a picked residue as accepted
   * unless its status was explicitly set (`stored`).
   */
  statusOverride?: (id: string, status: ReviewStatus, stored: StoredStatus | undefined) => ReviewStatus;
}

export function useResidueBrowser(opts: UseResidueBrowserOptions) {
  const { rows, review, setReview, isExcluded, toggleExclude, active, onArm, onAccept, statusOverride } = opts;
  const presentIds = useMemo(() => rows.filter(r => r.present).map(r => r.id), [rows]);

  const [selected, setSelected] = useState<string | null>(() => rowForParam(rows, readUrlParam(RESIDUE_URL_PARAM)) ?? null);
  // The stack lives in a ref (undo has side effects, so it must not run inside a state updater);
  // the counter only triggers re-renders.
  const undoStack = useRef<UndoEntry[]>([]);
  const [undoTop, setUndoTop] = useState<{ count: number; label?: string }>({ count: 0 });
  const syncUndo = () => {
    const st = undoStack.current;
    setUndoTop({ count: st.length, label: st[st.length - 1]?.label });
  };

  // Latest values for callbacks fired from the keyboard listener.
  const reviewRef = useRef(review);
  useEffect(() => {
    reviewRef.current = review;
  }, [review]);

  // URL → selection when this page becomes active or the rows arrive.
  const lastActive = useRef(false);
  useEffect(() => {
    if (active && !lastActive.current) {
      const fromUrl = rowForParam(rows, readUrlParam(RESIDUE_URL_PARAM));
      if (fromUrl) setSelected(fromUrl);
    }
    lastActive.current = active;
  }, [active, rows]);
  useEffect(() => {
    if (!active || selected) return;
    const fromUrl = rowForParam(rows, readUrlParam(RESIDUE_URL_PARAM));
    if (fromUrl) setSelected(fromUrl);
  }, [rows, active, selected]);

  const selectedId = selected && presentIds.includes(selected) ? selected : presentIds[0] ?? null;

  // Selection → URL.
  useEffect(() => {
    if (active && selectedId) writeUrlParam(RESIDUE_URL_PARAM, selectedId);
  }, [active, selectedId]);

  const status = useCallback(
    (id: string): ReviewStatus => {
      const s = statusOf(review, id, isExcluded(id));
      return statusOverride ? statusOverride(id, s, storedStatusOf(review, id)) : s;
    },
    [review, isExcluded, statusOverride]
  );

  const record = useCallback((label: string, undo: () => void) => {
    undoStack.current = pushUndo(undoStack.current, { label, undo });
    syncUndo();
  }, []);

  /** Apply a review change and record its inverse. */
  const changeReview = useCallback(
    (label: string, update: (r: ReviewState) => ReviewState, extraUndo?: () => void) => {
      const before = reviewRef.current;
      setReview(update);
      record(label, () => {
        setReview(() => before);
        extraUndo?.();
      });
    },
    [setReview, record]
  );

  const select = useCallback((id: string) => setSelected(id), []);
  const prev = useCallback(() => setSelected(stepRow(rows, selectedId, -1)), [rows, selectedId]);
  const next = useCallback(() => setSelected(stepRow(rows, selectedId, 1)), [rows, selectedId]);

  const acceptAndNext = useCallback(() => {
    if (!selectedId) return;
    const id = selectedId;
    const extra = onAccept?.(id) || undefined;
    changeReview(`Accept ${id}`, r => setStatus(r, id, 'accepted'), () => {
      extra?.();
      setSelected(id);
    });
    setSelected(stepRow(rows, id, 1));
  }, [selectedId, onAccept, changeReview, rows]);

  const markNoExcited = useCallback(
    (advance = true) => {
      if (!selectedId) return;
      const id = selectedId;
      const already = statusOf(reviewRef.current, id, false) === 'no_excited_state';
      changeReview(`No excited state ${id}`, r => setStatus(r, id, already ? undefined : 'no_excited_state'), () => setSelected(id));
      if (advance && !already) setSelected(stepRow(rows, id, 1));
    },
    [selectedId, changeReview, rows]
  );

  /** Set the selected (or given) residue's status; 'unreviewed' resets it. Undoable. */
  const setReviewStatus = useCallback(
    (status: StoredStatus, id?: string) => {
      const target = id ?? selectedId;
      if (!target) return;
      changeReview(`Set ${target} ${status}`, r => setStatus(r, target, status));
    },
    [selectedId, changeReview]
  );

  const toggleExclusion = useCallback(
    (id?: string) => {
      const target = id ?? selectedId;
      if (!target) return;
      toggleExclude(target);
      record(`Toggle exclusion ${target}`, () => toggleExclude(target));
    },
    [selectedId, toggleExclude, record]
  );

  const toggleFlag = useCallback(
    (id?: string) => {
      const target = id ?? selectedId;
      if (target) changeReview(`Flag ${target}`, r => toggleFlagIn(r, target));
    },
    [selectedId, changeReview]
  );

  const setNote = useCallback(
    (text: string, id?: string) => {
      const target = id ?? selectedId;
      if (target) setReview(r => setNoteIn(r, target, text));
    },
    [selectedId, setReview]
  );

  const undo = useCallback(() => {
    const last = undoStack.current[undoStack.current.length - 1];
    if (!last) return;
    undoStack.current = undoStack.current.slice(0, -1);
    syncUndo();
    last.undo();
  }, []);

  // Keyboard shortcuts.
  const handlers = useRef<Record<ShortcutAction, () => void>>({} as Record<ShortcutAction, () => void>);
  useEffect(() => {
    handlers.current = {
      prev,
      next,
      accept: acceptAndNext,
      exclude: () => toggleExclusion(),
      no_excited: () => markNoExcited(),
      clear_status: () => setReviewStatus('unreviewed'),
      arm_a: () => onArm?.('cs_a'),
      arm_b: () => onArm?.('cs_b'),
      arm_c: () => onArm?.('cs_c'),
      arm_d: () => onArm?.('cs_d'),
      arm_e: () => onArm?.('cs_e'),
      arm_f: () => onArm?.('cs_f'),
      undo,
    };
  });
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const action = shortcutFor(e, { armKeys: !!onArm });
      if (!action) return;
      // Buttons handle their own Enter; don't double-fire.
      if (action === 'accept' && (e.target as HTMLElement | null)?.tagName === 'BUTTON') return;
      e.preventDefault();
      handlers.current[action]();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, onArm]);

  const progress = useMemo(() => reviewProgress(presentIds, status), [presentIds, status]);

  return {
    rows,
    selectedId,
    select,
    prev,
    next,
    acceptAndNext,
    markNoExcited,
    setReviewStatus,
    toggleExclusion,
    toggleFlag,
    setNote,
    undo,
    canUndo: undoTop.count > 0,
    lastUndoLabel: undoTop.label,
    /** Record an undo entry for a page action (a pick, a mask, ...). */
    recordUndo: record,
    status,
    progress,
    note: selectedId ? noteOf(review, selectedId) : '',
    flagged: selectedId ? isFlagged(review, selectedId) : false,
    noteFor: (id: string) => noteOf(review, id),
    flaggedFor: (id: string) => isFlagged(review, id),
    help: shortcutHelp(!!onArm),
  };
}

export type ResidueBrowserState = ReturnType<typeof useResidueBrowser>;
