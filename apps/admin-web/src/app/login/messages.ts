/**
 * ONE neutral message per step, for EVERY failure of that step.
 *
 * The backend already refuses to distinguish a known email from an unknown one on
 * `POST /admin/login/request` (XB-H: identical body, identical rate-limit behaviour). If
 * the UI then said "no such admin" for one and "code sent" for the other, it would hand
 * back the enumeration oracle the backend just spent effort removing.
 *
 * So a bad address, an unknown address, a suspended admin, a tripped rate limit and a
 * mail outage all read the same here. That is deliberate, and it is why these are
 * constants rather than messages composed at the call site — a future `catch` block can't
 * accidentally invent a more "helpful" one.
 */

/** Step 1 — requesting a code. Never reveals whether the address is known. */
export const NEUTRAL_REQUEST_ERROR =
  "We couldn't send a code right now. Check the address and try again in a moment.";

/** Step 2 — verifying the emailed code. Same text for wrong, expired, and unknown. */
export const NEUTRAL_CODE_ERROR = "That code isn't valid. Request a new one and try again.";

/** Step 3 — verifying TOTP. Same text for wrong code, drifted clock, and expired login. */
export const NEUTRAL_MFA_ERROR =
  "That authentication code isn't valid. Check your authenticator app and try again.";

/** Shown when the API itself is unreachable — honest, because it reveals nothing. */
export const SERVICE_UNAVAILABLE_ERROR =
  "The admin service is unreachable. Try again shortly, or contact platform support.";

// ── Password sign-in, ADR-0060 ─────────────────────────────────────────────────────────────

/**
 * Email + password — the SAME text for an unknown email, a wrong password, an account with no
 * password yet, a locked account, a pending one and a suspended one. The API fuses all six into
 * one 401 (with a dummy KDF on every miss path) so neither the text nor the timing says which.
 */
export const NEUTRAL_PASSWORD_ERROR =
  "That email and password didn't work. Check both and try again, or reset your password.";

/**
 * The server refused a policy-valid new password at the "set a new password" step. The client
 * already enforces the policy, so what is left is re-using the temporary password itself.
 */
export const NEW_PASSWORD_REJECTED_ERROR =
  "That password can't be used here. Choose a different one — not the temporary password you were given.";
