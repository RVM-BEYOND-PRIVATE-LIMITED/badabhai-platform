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
 * Timing-normalization of the neutral path is live behind UNLOCK_LATENCY_TARGET_MS
 * (R21 / LC-7, fixed 2026-07-25): every neutral branch pads to the target via
 * padToTarget() in unlock.service.ts. Set 0 to disable (trusted-shared-secret alpha).
 * The BODY + STATUS oracle — the one a payer could read directly — is closed here.
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
  /** Still a date string — the shipped apps parse it. Open for good: a far-future date (#2747). */
  readonly expires_at: string;
  /** #2747 — when the contact stops being open; `null` = no end (`contact_rules` on). */
  readonly open_until: string | null;
  /**
   * #2750 — credits this open took from the wallet: the cost on the button for a new open, 0 for a
   * contact the company already held. Present ONLY while the credit rules are on for the company,
   * so a company outside the pilot gets exactly the body it parses today.
   */
  readonly credits_charged?: number;
}

/**
 * #2750 item 3 (ADR-0066) — the SECOND distinguishable answer, for a company under the credit
 * rules only: it does not hold enough credits for this contact. Nothing was debited, opened or
 * recorded against the worker. It reveals nothing the company did not already know: the cost is
 * the one on the button (priced from facts on the card only), and the balance is its own. Every
 * other refusal, consent included, stays the one neutral body.
 */
export interface InsufficientCreditsResponse {
  readonly status: "insufficient_credits";
  /** What this contact costs (the number on the button). */
  readonly credits_needed: number;
  /** The company's spendable credits now. */
  readonly credits_available: number;
}

/**
 * #2750 item 6 (ADR-0066 §2.7) — a company under the credit rules may not open this worker this
 * week: he was opened the weekly number of times (`workerWeeklyOpenLimit`, rolling 7 days, by all
 * companies) and this company is not one he applied to. Nothing was debited, opened or charged.
 * The brief's chosen answer (#2750 question 2): it says he is in demand, and nothing else.
 */
export interface WorkerUnavailableThisWeekResponse {
  readonly status: "worker_unavailable_this_week";
}

/**
 * #2750 item 6 (ADR-0066 §2.7) — an agency account under the credit rules has opened its daily
 * number of new contacts (`agencyDailyOpenLimit`, the IST calendar day). Decided from the
 * company's own count before anything about the worker is read. Nothing was debited or opened.
 */
export interface DailyLimitReachedResponse {
  readonly status: "daily_limit_reached";
  /** The limit in force: new contacts per IST day. */
  readonly daily_limit: number;
}

/**
 * #2747 item 5 (ADR-0064 §3.3) — `GET /payer/unlocks/:unlockId/contact`: what a credit opens, on
 * screen. Sent with `Cache-Control: no-store`; the body is never logged.
 */
export interface ContactReadResponse {
  readonly ok: true;
  /** The full name as he gave it; null when he never gave one. */
  readonly full_name: string | null;
  /** E.164, e.g. "+919876543210". */
  readonly phone: string;
  /** When this company first opened him (the grant). */
  readonly opened_at: string | null;
}

/** The reveal success body — an opaque, non-reversible, expiring relay handle ONLY. */
export interface ContactRevealedResponse {
  readonly relay_handle: string;
  readonly channel: "in_app_relay" | "proxy_number";
  readonly expires_at: string;
}

/**
 * #2750 item 3 — `POST /payer/unlocks/quotes`: what opening each worker on a page costs this
 * company, from the facts on his card only (never consent or a limit). The same cost rule prices
 * the open, so the number on the button is the number debited (unless his card changes between
 * the quote and the tap). A contact the company already holds quotes 0.
 */
export interface ContactQuotesResponse {
  readonly quotes: readonly {
    readonly worker_id: string;
    readonly credits: number;
    /**
     * #2750 item 5 — present (true) only when a placement-team waiver makes this contact free (an
     * RVM student who applied to a waived job or company). Additive: absent means not waived.
     */
    readonly waived?: true;
  }[];
  /** The company's spendable credits now, so the button can say when a contact is out of reach. */
  readonly credits_available: number;
}
