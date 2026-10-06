/**
 * How a write treats its caller-supplied job reference (#1899).
 *
 *  - `"normalise"` — the ops routes (InternalServiceGuard, `payer_id` from the body). The #1903 /
 *    #1898 behaviour, unchanged: an id the row's FK cannot hold is stored and evented as null.
 *  - `"payer_owned"` — the payer-session routes. The reference must be null or a job / posting
 *    the SESSION payer owns; anything else is refused with the surface's neutral body before
 *    anything is emitted or written.
 *
 * The parameter defaults to `"normalise"` for the ops callers; every payer-portal caller must pass
 * `"payer_owned"` explicitly — payer-portal/payer-job-ref-policy.static.test.ts pins that.
 */
export type JobRefPolicy = "normalise" | "payer_owned";
