/**
 * What the phone reveal says (A7, #2577) — one module for the route that reveals
 * (`[id]/phone/route.ts`), the drawer that shows its answer (`phone-reveal-model.ts`) and their
 * tests, which read the same sentences. The route answers with these and nothing else — never the
 * API's own text — and the drawer shows only these.
 */

/** The outcome of a reveal, as the drawer receives it. The phone exists only in `phone`. */
export type RevealPhoneOutcome = { ok: true; phone: string } | { ok: false; error: string };

/**
 * One sentence for EVERY neutral 404. The API answers the same 404 for a switched-off reveal, an
 * unknown worker, a spent cap and a fail-closed deny, so nothing here guesses which it was.
 */
export const REVEAL_UNAVAILABLE =
  "Nothing was revealed. Revealing contact may be switched off, your reveal limit may be used up, or there is no phone to show — the server does not say which.";

/** The API refused the explanation: too long, or carrying contact details. */
export const REVEAL_NOTE_REFUSED =
  "The explanation was refused. Keep it under 280 characters, with no phone number, email address or long number in it.";

/** Any other refusal of the request itself. */
export const REVEAL_REFUSED =
  "The reveal request was refused. Choose one of the listed reasons and try again.";

export const REVEAL_SIGNED_OUT = "Your session has ended. Reload the page and sign in again.";
export const REVEAL_FORBIDDEN = "Your role cannot reveal contact details.";
export const REVEAL_FAILED = "The admin API is unreachable or returned an error. Try again.";
export const REVEAL_BAD_ID = "That is not a worker id, so nothing was revealed.";
export const REVEAL_NO_REASON = "Choose a reason before revealing.";

/**
 * The route refused a request that did not come from a page of this portal (another site, or an
 * address it cannot confirm as its own). The drawer never makes one; an operator who sees it is
 * behind something that rewrites the request — say so, rather than blame their role or reason.
 */
export const REVEAL_NOT_SAME_ORIGIN =
  "Nothing was revealed: the request did not reach the portal from one of its own pages.";

/** Every sentence a refused reveal can carry. The drawer shows one of these, or REVEAL_FAILED. */
export const REVEAL_ERRORS: ReadonlySet<string> = new Set([
  REVEAL_UNAVAILABLE,
  REVEAL_NOTE_REFUSED,
  REVEAL_REFUSED,
  REVEAL_SIGNED_OUT,
  REVEAL_FORBIDDEN,
  REVEAL_FAILED,
  REVEAL_BAD_ID,
  REVEAL_NO_REASON,
  REVEAL_NOT_SAME_ORIGIN,
]);
