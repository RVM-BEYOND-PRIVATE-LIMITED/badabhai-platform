/**
 * What the phone reveal says (A7, #2577) — its own module because a `"use server"` file may export
 * only async functions, and the tests and the drawer read the same sentences.
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
