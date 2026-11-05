/**
 * Forgot-password copy (ADR-0060 A4). The same rule as `login/messages.ts`: ONE neutral message
 * per step for every failure of that step, as constants, so a future `catch` cannot invent a
 * more "helpful" one.
 *
 * `POST /admin/password/forgot` answers identically for an unknown, pending, suspended and real
 * address, and `POST /admin/password/reset` fuses wrong, expired and unknown into one 401. The
 * page must not hand back the oracle the API removed — so the "code sent" screen is phrased as a
 * conditional ("if this address belongs to…"), never as a confirmation that it does.
 */

/** Step 1 — requesting a reset code. Never reveals whether the address is known. */
export const NEUTRAL_RESET_REQUEST_ERROR =
  "We couldn't send a code right now. Check the address and try again in a moment.";

/** Step 2 — the code (wrong, expired, or for an address that is not an active admin). */
export const NEUTRAL_RESET_ERROR =
  "That code isn't valid or has expired. Request a new one and try again.";
