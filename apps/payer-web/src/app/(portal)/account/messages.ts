/**
 * Account-edit copy constants (PROF-4). Kept OUT of the `"use server"` action module so a
 * non-async export is legal, and shared as the SINGLE source of truth — the action, the
 * form, and the tests all read these.
 */

/**
 * The SINGLE neutral save-failure message. Surfaced for EVERY non-success — invalid input,
 * a 400 from `PATCH /payer/me`, a 401, a network/parse error — so the UI never reveals which
 * field or which check failed (no enumeration oracle, XB-H).
 */
export const ACCOUNT_SAVE_ERROR = "Couldn’t save your changes. Please try again.";

/** Inline client-validation message for the org-name field (2–120 characters). */
export const ORG_NAME_ERROR = "Organisation name must be 2–120 characters.";

/** Inline client-validation message for the new-phone field (E.164). */
export const PHONE_ERROR = "Enter a valid phone number, e.g. +919876543210.";

/** Confirmation shown in the aria-live region after a successful save. */
export const SAVED_CONFIRMATION = "Saved.";

/** Helper under the read-only email field. */
export const EMAIL_SUPPORT_HELPER = "To change your login email, contact support.";
