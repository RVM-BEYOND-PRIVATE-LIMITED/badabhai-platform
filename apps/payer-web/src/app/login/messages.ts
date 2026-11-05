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

/* ---- Password sign-in (#2587). The same words as the payer app where it has them. ---- */

/** Inline: the login ID field is empty. */
export const IDENTIFIER_REQUIRED = "Enter your email, phone or company name.";

/** Inline: the password field is empty. */
export const PASSWORD_REQUIRED = "Enter your password.";

/**
 * The ONE neutral refusal for a password sign-in (401) — identical for an unknown login, a wrong
 * or revoked password, an account with no password and a lockout, exactly as the API makes them
 * indistinguishable (XB-H). It names the parts of a sign-in, never which one was wrong.
 */
export const PASSWORD_SIGNIN_ERROR = "Wrong email, phone or company name, or password.";

/** 429 — the shared auth cap. Says what to do; never which limit was hit. */
export const PASSWORD_RATE_LIMITED = "Too many attempts. Please wait a minute and try again.";

/**
 * 403 — a PROVEN credential on a suspended account. The API answers this only after the password
 * matched, so it reveals nothing the payer did not just prove.
 */
export const ACCOUNT_SUSPENDED = "This account is suspended, so it can’t sign in.";

/** 5xx, a network failure, or an answer that is not a session: worth retrying. */
export const PASSWORD_SIGNIN_UNAVAILABLE = "Couldn’t sign in right now. Please try again in a moment.";

/** The forced change failed for a reason other than the new password itself. */
export const NEW_PASSWORD_UNAVAILABLE =
  "Couldn’t set your password right now. Please try again in a moment.";

/**
 * The email code was right, but the account holds a TEMPORARY password (the API's 409, #2628): no
 * session until the payer signs in with it and sets their own. The mailbox is already proven, so
 * this is not an enumeration signal.
 */
export const TEMPORARY_PASSWORD_REQUIRED =
  "This account has a temporary password. Sign in with the temporary password you were given, then set a new one.";
