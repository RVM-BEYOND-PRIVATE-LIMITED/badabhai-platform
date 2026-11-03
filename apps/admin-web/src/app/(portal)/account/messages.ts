/**
 * Account-page copy for a refused CREDENTIAL (ADR-0060 A2/A5). Constants, like the sign-in
 * messages, so the wording a refusal gets is decided once. Which one applies — refused credential
 * or ended session — is settled by `lib/self-service-error.ts`, never by the API's error text.
 */

/** `POST /admin/me/password` refused the current password. */
export const WRONG_CURRENT_PASSWORD =
  "Your current password isn't right. Check it and try again — repeated misses lock password sign-in for a while.";

/** `POST /admin/me/mfa/confirm` or `/disable` refused the authenticator code. */
export const WRONG_AUTHENTICATOR_CODE =
  "That code isn't valid. Check your authenticator app and try again.";

/** A malformed authenticator code (not 6 digits). */
export const CODE_SHAPE_ERROR = "Enter the 6-digit code from your authenticator app.";
