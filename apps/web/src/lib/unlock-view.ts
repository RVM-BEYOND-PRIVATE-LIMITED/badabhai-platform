import {
  isUnlockGranted,
  isRevealHandle,
  type UnlockResult,
  type RevealResult,
} from "./api";

/**
 * PURE response → view-state mapping for the contact unlock + reveal UI
 * (ADR-0010, Stream A). No I/O, no React, no secrets — just the deterministic
 * translation from an API response to what the screen renders. This is the
 * security-load-bearing module: it is where the NO-ORACLE guarantee is enforced,
 * and it is unit-tested in `unlock-view.test.ts`.
 *
 * NO-ORACLE (F-1/F-3): `POST /unlocks` deliberately collapses no-consent /
 * capped / unknown-worker / already-unlocked-by-another / insufficient-credits
 * into ONE byte-identical `{ status: "unavailable" }`. This mapper therefore has
 * NO branch that can distinguish those causes — every neutral response maps to
 * the SAME `NEUTRAL_UNAVAILABLE` view. Adding a cause-specific branch here would
 * reverse the security guarantee and is a defect.
 */

/**
 * The single honest neutral message. Identical for EVERY "unavailable" cause —
 * the system intentionally does not disclose which one. Do not split this into
 * per-cause variants.
 */
export const NEUTRAL_UNAVAILABLE_MESSAGE =
  "Unavailable — this candidate can't be unlocked right now. The system intentionally does not disclose the reason (no-consent, capped, and already-unlocked all look identical).";

/** The single honest neutral message for a reveal that cannot be served. */
export const NEUTRAL_REVEAL_UNAVAILABLE_MESSAGE =
  "Unavailable — this contact can't be revealed right now. The system intentionally does not disclose the reason.";

/** View state produced from a `POST /unlocks` response. */
export type UnlockView =
  | {
      kind: "granted";
      unlockId: string;
      expiresAt: string;
    }
  | {
      kind: "unavailable";
      /** The one neutral, no-oracle message. Cause is never disclosed. */
      message: string;
    };

/** View state produced from a `POST /unlocks/:id/reveal` response. */
export type RevealView =
  | {
      kind: "handle";
      /** Opaque ROUTED RELAY HANDLE — never a phone number. */
      relayHandle: string;
      channel: "in_app_relay" | "proxy_number";
      expiresAt: string;
    }
  | {
      kind: "unavailable";
      message: string;
    };

/**
 * Map a `POST /unlocks` response to its view state.
 *
 * Granted → the granted view. EVERY other (neutral) response → the SAME
 * `unavailable` view with the SAME message — capped, consent-absent,
 * insufficient-credits, unknown-worker, already-unlocked are indistinguishable
 * by construction (the input carries no cause to branch on).
 */
export function mapUnlockResult(result: UnlockResult): UnlockView {
  if (isUnlockGranted(result)) {
    return {
      kind: "granted",
      unlockId: result.unlock_id,
      expiresAt: result.expires_at,
    };
  }
  return { kind: "unavailable", message: NEUTRAL_UNAVAILABLE_MESSAGE };
}

/**
 * Map a `POST /unlocks/:id/reveal` response to its view state.
 *
 * Handle → the routed-handle view (relay handle / channel / expiry only — no
 * phone). Neutral → the single neutral message.
 */
export function mapRevealResult(result: RevealResult): RevealView {
  if (isRevealHandle(result)) {
    return {
      kind: "handle",
      relayHandle: result.relay_handle,
      channel: result.channel,
      expiresAt: result.expires_at,
    };
  }
  return { kind: "unavailable", message: NEUTRAL_REVEAL_UNAVAILABLE_MESSAGE };
}

/** A v4-shaped UUID. The ops actor supplies an opaque `payer_id` they act for. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** True if `s` is a syntactically valid UUID (client-side guard before submit). */
export function isUuid(s: string): boolean {
  return UUID_RE.test(s.trim());
}
