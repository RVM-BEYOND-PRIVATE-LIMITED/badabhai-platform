"use client";

import { useEffect, useRef, useState } from "react";
import { clearDraft, installLeaveGuard, loadDraft, saveDraft } from "../lib/posting-draft";

/**
 * W4 (#2584) — a posting form's local DRAFT and LEAVE GUARD (lib/posting-draft.ts holds the
 * rules; this wires them to the form's lifecycle).
 *
 *  - On mount, a draft stored from the same `base` is handed to `onRestore` once.
 *  - While `dirty`, the payload is saved a moment after the payer stops typing, and `saved` turns
 *    true for a short while (the form's "Draft saved" cue).
 *  - While `dirty`, an in-app link and a tab close / reload ask first.
 *  - `off` (a save succeeded and the page is leaving) stops both; `discard()` drops the draft.
 */

const SAVE_AFTER_MS = 600;
const SAVED_CUE_MS = 1600;

export interface PostingDraftOptions<T> {
  storageKey: string;
  /** What the form was seeded from — a draft taken from another base is never restored. */
  base: string;
  payload: T;
  dirty: boolean;
  off: boolean;
  onRestore: (payload: T) => void;
}

export interface PostingDraft {
  /** True briefly after each save — drives the "Draft saved" cue. */
  saved: boolean;
  /** Drop the stored draft (the posting was saved to the server). */
  discard: () => void;
}

export function usePostingDraft<T>({
  storageKey,
  base,
  payload,
  dirty,
  off,
  onRestore,
}: PostingDraftOptions<T>): PostingDraft {
  const [saved, setSaved] = useState(false);
  const guarding = useRef(false);
  guarding.current = dirty && !off;
  const restore = useRef(onRestore);
  restore.current = onRestore;
  const restored = useRef(false);
  const serialized = JSON.stringify(payload);

  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const draft = loadDraft<T>(storageKey, base);
    if (draft !== null) restore.current(draft);
  }, [storageKey, base]);

  useEffect(() => {
    if (off || !dirty) return;
    const timer = setTimeout(() => {
      if (saveDraft(storageKey, base, JSON.parse(serialized) as T)) setSaved(true);
    }, SAVE_AFTER_MS);
    return () => clearTimeout(timer);
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

  return { saved, discard: () => clearDraft(storageKey) };
}
