/**
 * Login copy constants (OTP-4 / XB-H). Kept OUT of the `"use server"` action module so a
 * non-async export is legal, and shared as the SINGLE source of truth for the no-oracle
 * messages — the action, the form, and the tests all read these.
 */

/**
 * The SINGLE neutral "send" outcome message. Surfaced for EVERY non-success of step 1 —
 * invalid email, send failure, rate-limit/cap (429), and the unknown-account path alike —
 * so the UI never reveals whether the email exists or which limit was hit. The code itself
 * is NEVER returned to the client: the payer reads it from their real email.
 */
export const NEUTRAL_SEND_ERROR =
  "Couldn’t send a code right now — please try again shortly.";

/**
 * The SINGLE neutral verify error — identical whether the email is unknown, the code is
 * wrong, or the code has expired (no enumeration oracle).
 */
export const NEUTRAL_VERIFY_ERROR = "Invalid or expired code.";

/** Account-state-independent confirmation after step 1. NEVER contains the code. */
export const SEND_CONFIRMATION =
  "If that email is registered, a login code is on its way. Enter it below.";
