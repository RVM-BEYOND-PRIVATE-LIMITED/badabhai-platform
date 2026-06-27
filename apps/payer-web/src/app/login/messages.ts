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

/**
 * Brief success affordance shown the instant a code verifies, just before the redirect to the
 * dashboard. Account-state-independent and contains NO code, token, or PII — purely a "you're in"
 * cue so the transition doesn't feel abrupt.
 */
export const VERIFIED_CONFIRMATION = "Code verified — taking you to your dashboard…";

/**
 * Inline field error for an invalid organisation name (signup entry). Mirrors the backend
 * (`org_name` 1..200 on the trimmed value) and the server action's Zod — never reveals account
 * state. A field-level error only; the no-enumeration send/create outcome stays {@link
 * NEUTRAL_SEND_ERROR}.
 */
export const INVALID_ORG_NAME = "Enter your organisation name.";

/**
 * Inline field error for an invalid phone (signup entry, optional field). Mirrors the
 * `@badabhai/validators` E.164 schema. Field-level only — not an enumeration signal.
 */
export const INVALID_PHONE = "Enter a valid phone number, e.g. +919876543210.";
