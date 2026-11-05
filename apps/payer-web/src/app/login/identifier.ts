/**
 * The password sign-in login ID (#2587) — an email, a phone or the exact company/agency name,
 * as the API reads it (`POST /payer/login/password` tries email → E.164 phone → org name).
 *
 * Mirrors the payer app's `normalizeIdentifier` (auth_form_support.dart) so one login ID works
 * the same in both: an email is trimmed and sent as typed; a phone typed the Indian way
 * (`98765 43210`, `098765-43210`, `+91 98765 43210`) is sent as E.164 (`+919876543210`), the only
 * phone form the API matches; anything else — a company name, or a full international number —
 * passes through trimmed. Input formatting only: the API decides what matches.
 *
 * One deliberate difference from the app: a value is read as a phone only when it is phone
 * characters alone (digits, spaces, `+ - . ( )`), so a company name that happens to contain ten
 * digits ("Unit 1234567890 Tools") stays a name.
 */

/** Digits in an Indian national mobile number. */
const NATIONAL_DIGITS = 10;
/** Only phone characters — what a typed or pasted phone number is made of. */
const PHONE_CHARS = /^[\d\s+().-]+$/;

/** The login ID to send: trimmed, with an Indian mobile normalized to E.164. */
export function normalizeLoginIdentifier(raw: string): string {
  const value = raw.trim();
  if (value.includes("@") || !PHONE_CHARS.test(value)) return value;
  let digits = value.replace(/\D/g, "");
  // Shed a pasted country code or trunk zero so it is not counted as part of the number.
  if (digits.length === NATIONAL_DIGITS + 2 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === NATIONAL_DIGITS + 1 && digits.startsWith("0")) digits = digits.slice(1);
  return digits.length === NATIONAL_DIGITS ? `+91${digits}` : value;
}
