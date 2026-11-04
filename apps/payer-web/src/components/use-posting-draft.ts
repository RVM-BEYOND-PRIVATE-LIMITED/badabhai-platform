"use client";

import { useEffect, useRef, useState } from "react";
import { clearDraft, installLeaveGuard, loadDraft, saveDraft } from "../lib/posting-draft";

/**
 * W4 (#2584) — a posting form's local DRAFT and LEAVE GUARD (lib/posting-draft.ts holds the
 * rules; this wires them to the form's lifecycle).
 *
 *  - On mount, a draft stored from the same `base` is handed to `onRestore` once, and `restored`
 *    turns true (the form's "Restored unsaved changes from this device · Discard" line). A draft
 *    the form's `isDirty` finds unchanged is removed instead, and nothing is restored.
 *  - While `dirty`, the payload is saved a moment after the payer stops typing, and `saved` turns
 *    true for a short while (the form's "Draft saved" cue).
 *  - When the form is back to its seed (cleared or reverted by hand), the stored draft is removed:
 *    a change the payer undid must never come back on the next visit.
 *  - While `dirty`, an in-app link and a tab close / reload ask first.
 *  - `off` (a save succeeded and the page is leaving) stops all of it; `discard()` drops the draft.
 */

const SAVE_AFTER_MS = 600;
const SAVED_CUE_MS = 1600;

export interface PostingDraftOptions<T> {
  storageKey: string;
  /** What the form was seeded from — a draft taken from another base is never restored. */
  base: string;
  payload: T;
  dirty: boolean;
  /**
   * `dirty`'s own test, run on a STORED draft before it is restored. A draft it finds unchanged
   * (all it differs in is something no control shows or sends any more, such as a pick from a
   * picker since removed) is removed rather than restored: restored, it would put "Restored unsaved
   * changes" over an unchanged form for good (that form never turns dirty, so nothing clears it).
   * Optional: without it, every draft from the same `base` is restored, as before.
   */
  isDirty?: (payload: T) => boolean;
  off: boolean;
  onRestore: (payload: T) => void;
}

export interface PostingDraft {
  /** True briefly after each save — drives the "Draft saved" cue. */
  saved: boolean;
  /** True from a restore on mount until the form is discarded or back to its seed. */
  restored: boolean;
  /** Drop the stored draft (the posting was saved to the server, or the payer discarded it). */
  discard: () => void;
}

export function usePostingDraft<T>({
  storageKey,
  base,
  payload,
  dirty,
  isDirty,
  off,
  onRestore,
}: PostingDraftOptions<T>): PostingDraft {
  const [saved, setSaved] = useState(false);
  const [restored, setRestored] = useState(false);
  const guarding = useRef(false);
  guarding.current = dirty && !off;
  const restore = useRef(onRestore);
  restore.current = onRestore;
  const changesTheForm = useRef(isDirty);
  changesTheForm.current = isDirty;
  const loaded = useRef(false);
  // `dirty` as of the previous save pass. It starts false, so the mount pass — which runs before a
  // restored draft's state lands — never reads as "back to the seed" and wipes that draft.
  const wasDirty = useRef(false);
  // The save waiting out the typing pause, so a discard can stop it writing the draft back.
  const pendingSave = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const serialized = JSON.stringify(payload);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    const draft = loadDraft<T>(storageKey, base);
    if (draft === null) return;
    // A draft that changes nothing the form holds is no change to restore (see `isDirty`).
    if (changesTheForm.current?.(draft) === false) {
      clearDraft(storageKey);
      return;
    }
    restore.current(draft);
    setRestored(true);
  }, [storageKey, base]);

  useEffect(() => {
    const backToSeed = wasDirty.current && !dirty;
    wasDirty.current = dirty;
    if (off) return;
    if (backToSeed) {
      clearDraft(storageKey);
      setRestored(false);
      return;
    }
    if (!dirty) return;
    const timer = setTimeout(() => {
      pendingSave.current = undefined;
      if (saveDraft(storageKey, base, JSON.parse(serialized) as T)) setSaved(true);
    }, SAVE_AFTER_MS);
    pendingSave.current = timer;
    return () => {
      clearTimeout(timer);
      pendingSave.current = undefined;
    };
  }, [storageKey, base, serialized, dirty, off]);

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), SAVED_CUE_MS);
    return () => clearTimeout(timer);
  }, [saved, serialized]);

  useEffect(
    () =>
      installLeaveGuard(
        () => guarding.current,
        (message) => window.confirm(message),
      ),
    [],
  );

  return {
    saved,
    restored,
    discard: () => {
      clearTimeout(pendingSave.current);
      pendingSave.current = undefined;
      clearDraft(storageKey);
      setRestored(false);
    },
  };
}
