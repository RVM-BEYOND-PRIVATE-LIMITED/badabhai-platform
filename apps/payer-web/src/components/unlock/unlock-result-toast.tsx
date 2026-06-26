"use client";

/**
 * Shared unlock-RESULT Toast (DS1.5) — a transient confirmation of the SPEND outcome.
 *
 * Client primitive (wraps the DS Toast). NO-ORACLE (XB-C): the failure copy is ONE neutral
 * line with NO cause — IDENTICAL for capped / unknown / no-consent / already-unlocked. It reuses
 * `NEUTRAL_UNLOCK_MESSAGE` from lib/unlock-view (the single security-load-bearing message); this
 * module never invents a cause-bearing string. The success copy is a plain neutral "Contact
 * unlocked". FACELESS — neither line names a candidate. NO-LOG: nothing is logged here.
 */
import { NEUTRAL_UNLOCK_MESSAGE } from "../../lib/unlock-view";
import { Toast } from "../ds";

/** The unlock RESULT a screen surfaces in the toast — mirrors the mapped UnlockView kinds. */
export type UnlockResultKind = "granted" | "unavailable";

/** The single neutral success line (no candidate, no cause). */
export const UNLOCK_SUCCESS_TITLE = "Contact unlocked";

export interface UnlockResultToastProps {
  /** Which outcome to confirm. */
  kind: UnlockResultKind;
  /** Optional dismiss handler (shows a ✕). */
  onClose?: () => void;
}

export function UnlockResultToast({ kind, onClose }: UnlockResultToastProps) {
  if (kind === "granted") {
    return (
      <Toast tone="success" title={UNLOCK_SUCCESS_TITLE} onClose={onClose}>
        The routed relay is ready under this candidate&rsquo;s contact.
      </Toast>
    );
  }
  // NO-ORACLE: one neutral failure line, identical for every cause (reuses the mapper's message).
  return (
    <Toast tone="danger" title="Couldn't unlock" onClose={onClose}>
      {NEUTRAL_UNLOCK_MESSAGE}
    </Toast>
  );
}
