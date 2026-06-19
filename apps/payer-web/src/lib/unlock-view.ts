import type { MaskedResumeResult, UnlockResult } from "./contracts";

/**
 * PURE response → view-state mapping for the unlock + masked-reveal UI (mirrors
 * apps/web's unlock-view.ts). This is the security-load-bearing module where the
 * NO-ORACLE guarantee is enforced (XB-C): every "unavailable" cause maps to the
 * SAME view with the SAME message. Adding a cause-specific branch here would
 * reverse the guarantee and is a defect. No I/O, no React, no secrets — unit-tested.
 */

/** The single neutral unlock message — identical for EVERY deny cause (XB-C). */
export const NEUTRAL_UNLOCK_MESSAGE =
  "Unavailable — this candidate can't be unlocked right now. The reason is intentionally not disclosed (no consent, capped, no credits, and already-unlocked all look identical).";

/** The single neutral masked-reveal message. */
export const NEUTRAL_REVEAL_MESSAGE =
  "Unavailable — this candidate's masked resume can't be shown right now. The reason is intentionally not disclosed.";

export type UnlockView =
  | { kind: "granted"; unlockId: string; expiresAt: string }
  | { kind: "unavailable"; message: string };

export type RevealView =
  | {
      kind: "masked";
      disclosureId: string;
      /** Masked initials only — e.g. "R***** K." NEVER a full name (XB-E). */
      displayInitials: string;
      /** Short-TTL signed URL to the MASKED PDF. No phone in the artifact. */
      resumeUrl: string;
      expiresAt: string;
    }
  | { kind: "unavailable"; message: string };

/** Granted → granted view; EVERY neutral response → the SAME unavailable view. */
export function mapUnlockResult(result: UnlockResult): UnlockView {
  if ("ok" in result && result.ok === true) {
    return { kind: "granted", unlockId: result.unlockId, expiresAt: result.expiresAt };
  }
  return { kind: "unavailable", message: NEUTRAL_UNLOCK_MESSAGE };
}

/** Disclosed → masked view (initials + masked PDF link, NO phone); else neutral. */
export function mapRevealResult(result: MaskedResumeResult): RevealView {
  if ("ok" in result && result.ok === true) {
    return {
      kind: "masked",
      disclosureId: result.disclosureId,
      displayInitials: result.displayInitials,
      resumeUrl: result.resumeUrl,
      expiresAt: result.expiresAt,
    };
  }
  return { kind: "unavailable", message: NEUTRAL_REVEAL_MESSAGE };
}
