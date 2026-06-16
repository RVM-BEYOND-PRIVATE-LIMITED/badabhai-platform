/**
 * The SINGLE neutral-response constructor (ADR-0010 §D4 no-oracle rule; Phase-0
 * F-3). EVERY deny / neutral branch in the unlock + reveal flow returns the body
 * produced here, so the response is BYTE-IDENTICAL across:
 *   no_consent · capped · unknown_worker · already-unlocked-by-another-payer ·
 *   expired · over-attempt · revoked · (insufficient-credits collapsed as neutral)
 *
 * No branch may build its own deny body. The internal `deny_reason` enum NEVER
 * crosses the HTTP boundary — it lives only on the `unlocks` row + the internal
 * `unlock.denied` event. There is intentionally NO `reason` field on this type, so a
 * leak is a compile error, not a review miss.
 *
 * A payer can distinguish only two states:
 *   (i)  GRANTED / OWNED  — `{ ok: true, ... }` (UnlockGrantedResponse)
 *   (ii) UNAVAILABLE       — this constant body.
 * Everything else collapses to (ii). The HTTP status is a constant 200 so the
 * status code is not itself an oracle (a 404 vs 200 would classify the id).
 *
 * Timing-normalization of the neutral path is an alpha residual / launch gate
 * (RR-4 / LC-7): the alpha caller is the trusted shared-secret holder. The BODY +
 * STATUS oracle — the one a payer could read directly — is closed here.
 */

/** The byte-identical neutral body. Frozen so no caller can mutate the shared value. */
export const NEUTRAL_UNAVAILABLE_BODY = Object.freeze({
  status: "unavailable" as const,
});

/** The constant HTTP status for every neutral/deny branch (not a classifiable 404). */
export const NEUTRAL_UNAVAILABLE_STATUS = 200;

export interface NeutralUnavailableResponse {
  readonly status: "unavailable";
}

/** Return the one neutral response body. Use this for EVERY deny/neutral branch. */
export function neutralUnavailable(): NeutralUnavailableResponse {
  // Return a fresh shallow copy so a serializer that mutates cannot poison the shared
  // frozen constant; the SHAPE is identical for every caller (the no-oracle guarantee).
  return { status: NEUTRAL_UNAVAILABLE_BODY.status };
}

/** The ONE distinguishable success: the payer got / owns a grant. PII-free. */
export interface UnlockGrantedResponse {
  readonly ok: true;
  readonly unlock_id: string;
  readonly status: "granted";
  readonly expires_at: string;
}

/** The reveal success body — an opaque, non-reversible, expiring relay handle ONLY. */
export interface ContactRevealedResponse {
  readonly relay_handle: string;
  readonly channel: "in_app_relay" | "proxy_number";
  readonly expires_at: string;
}
