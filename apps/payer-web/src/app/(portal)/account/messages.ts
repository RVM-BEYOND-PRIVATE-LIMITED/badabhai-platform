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

/* ---- Confirm-your-number (#2754 item 3). One message per API refusal, never a code/number. ---- */

/** The idle prompt: no code has been sent yet. */
export const PHONE_PROOF_PROMPT =
  "Confirm this number to sign in with an SMS code. We’ll text a code to the number on your account.";

/** The code step's helper — SMS only reaches a number this account has confirmed. */
export const PHONE_PROOF_CODE_HELPER =
  "Enter the code we texted to the number on your account.";

/** Shown once a number is proven (the caller supplies the masked last-4 beside it). */
export const PHONE_PROOF_CONFIRMED = "This number can sign you in with an SMS code.";

/** Inline client-validation message for the confirmation code (4–8 digits). */
export const PHONE_PROOF_CODE_ERROR = "Enter the 4–8 digit code.";

/** `409 no_phone_on_account` — there is nothing to text yet. */
export const PHONE_PROOF_NO_PHONE =
  "There’s no phone number on this account. Add one below first, then confirm it.";

/** `409 phone_not_provable` — only an Indian mobile can be proved by SMS. */
export const PHONE_PROOF_NOT_PROVABLE =
  "Only an Indian mobile number (+91) can be confirmed by SMS. Change the number first.";

/** `401` on verify — one message for a wrong and an expired code. */
export const PHONE_PROOF_WRONG_CODE =
  "That code is wrong or has expired. Request a new code and try again.";

/** `409 phone_changed` — the number moved after the code was sent. */
export const PHONE_PROOF_PHONE_CHANGED =
  "The phone number on your account changed. Request a new code for the new number.";

/** `409 phone_linked_to_another_account` — only support can move a proven number. */
export const PHONE_PROOF_LINKED_ELSEWHERE =
  "This phone number is linked to another BadaBhai account. Contact support to move it to this account.";

/** `409 in_flight` — this same attempt is still running. */
export const PHONE_PROOF_IN_FLIGHT =
  "This confirmation is already being processed. Wait a moment, then try again.";

/** `429` — the send/attempt cap. */
export const PHONE_PROOF_RATE_LIMITED = "Too many attempts. Please wait a minute and try again.";

/** `502` — the SMS provider could not send the message. */
export const PHONE_PROOF_SMS_FAILED = "We couldn’t send the text message. Please try again.";

/** `503`, a network failure, or any other answer. */
export const PHONE_PROOF_UNAVAILABLE =
  "Couldn’t confirm your number right now. Please try again in a moment.";

/** After a successful verify. */
export const PHONE_PROOF_VERIFIED = "Number confirmed.";
