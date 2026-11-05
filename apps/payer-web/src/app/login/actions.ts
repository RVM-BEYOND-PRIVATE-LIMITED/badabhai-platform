"use server";

import { z } from "zod";
import { e164PhoneSchema, emailSchema, otpDigitsSchema } from "@badabhai/validators";
import { payerAuth } from "../../lib/auth";
import type { PayerRole } from "../../lib/auth";
import type { PasswordLoginResult } from "../../lib/auth/types";
import {
  ACCOUNT_SUSPENDED,
  NEUTRAL_SEND_ERROR,
  NEUTRAL_VERIFY_ERROR,
  NEW_PASSWORD_UNAVAILABLE,
  PASSWORD_RATE_LIMITED,
  PASSWORD_SIGNIN_ERROR,
  PASSWORD_SIGNIN_UNAVAILABLE,
  TEMPORARY_PASSWORD_REQUIRED,
} from "./messages";
import { normalizeLoginIdentifier } from "./identifier";
import { NEW_PASSWORD_ERRORS, newPasswordRefusal } from "./password-rules";

/**
 * Login Server Actions (ADR-0019 Decision B / XB-H) — TWO-STEP OTP.
 *
 * Runs SERVER-SIDE only. Step 1 requests a code (no-enumeration response) and NEVER
 * returns the code to the client — the payer reads it from their real email. Step 2
 * verifies it and the seam sets an httpOnly session cookie — no secret or token ever
 * reaches the client. Both steps return ONE neutral error for any failure (bad/expired
 * code OR unknown email OR send failure/limit) — no user-enumeration oracle. Nothing is
 * logged.
 *
 * Password sign-in (#2587) sits beside it: `passwordSignInAction`, and `setNewPasswordAction` for
 * the forced first change of a temporary password (#2628). Same seam, same session cookie; no
 * password is ever logged, stored or returned to the client.
 */

const codeSchema = otpDigitsSchema({ min: 4, max: 8 });
const roleSchema = z.enum(["employer", "agent"]);
// org_name: trimmed 1..200 — matches the backend `PayerSignupSchema` exactly.
const orgNameSchema = z.string().trim().min(1).max(200);
// phone: OPTIONAL E.164 — reuse the shared validator (parity with the backend).
const phoneSchema = e164PhoneSchema;
// Password sign-in (#2587) — the backend `PayerPasswordLoginSchema` bounds. The identifier is
// normalized first (identifier.ts); a PRESENTED password is bounded but never trimmed and never
// policy-checked (no policy oracle on the sign-in door — the API burns the same work either way).
const identifierSchema = z.string().min(1).max(320);
const presentedPasswordSchema = z.string().min(1).max(128);
// A Server Action is a public endpoint: the arguments are parsed, never trusted to be strings.
const passwordSignInInputSchema = z.object({ identifier: z.string(), password: z.string() });
const setNewPasswordInputSchema = z.object({
  identifier: z.string(),
  temporaryPassword: z.string(),
  newPassword: z.string(),
});

export type RequestCodeActionResult =
  | { ok: true; resendInSeconds: number }
  | { ok: false; error: string };

export async function requestCodeAction(input: {
  email: string;
}): Promise<RequestCodeActionResult> {
  const parsed = emailSchema.safeParse(input.email);
  // Same neutral copy as a send/limit failure — no enumeration via validation.
  if (!parsed.success) return { ok: false, error: NEUTRAL_SEND_ERROR };
  const res = await payerAuth().requestCode({ email: parsed.data });
  if (!res.ok) return { ok: false, error: NEUTRAL_SEND_ERROR };
  // The code is NEVER returned to the client — the payer reads it from their real email.
  return { ok: true, resendInSeconds: res.resendInSeconds };
}

export type SignupActionResult =
  | { ok: true; resendInSeconds: number }
  | { ok: false; error: string };

/**
 * Self-serve signup (AUTH-1). Mirrors {@link requestCodeAction}: validates server-side, calls
 * the seam, and funnels into the SAME shared OTP `code` step (verifyCodeAction) — no second OTP
 * mechanism. The `role` is set HERE, at signup; it is the account's stored role thereafter, so
 * LOGIN STAYS ROLE-AGNOSTIC (it never branches on which tab signed in).
 *
 * NO-ENUMERATION (XB-H): ANY validation OR seam failure collapses to the SAME neutral
 * {@link NEUTRAL_SEND_ERROR} used by the send step — signup behaves identically whether the
 * email is new or already registered (never "email already exists"). Nothing is logged. The OTP
 * is emailed and is NEVER returned to the client.
 */
export async function signupAction(input: {
  role: PayerRole;
  orgName: string;
  email: string;
  phone?: string;
}): Promise<SignupActionResult> {
  const role = roleSchema.safeParse(input.role);
  const orgName = orgNameSchema.safeParse(input.orgName);
  const email = emailSchema.safeParse(input.email);
  // Phone is optional: validate it only when a non-empty value was supplied.
  const rawPhone = input.phone?.trim();
  const phone = rawPhone ? phoneSchema.safeParse(rawPhone) : null;

  if (!role.success || !orgName.success || !email.success || (phone && !phone.success)) {
    // Same neutral copy as a create/send failure — no enumeration via validation.
    return { ok: false, error: NEUTRAL_SEND_ERROR };
  }

  const res = await payerAuth().signup({
    role: role.data,
    orgName: orgName.data,
    email: email.data,
    ...(phone?.success ? { phone: phone.data } : {}),
  });
  if (!res.ok) return { ok: false, error: NEUTRAL_SEND_ERROR };
  // The code is NEVER returned to the client — the payer reads it from their real email.
  return { ok: true, resendInSeconds: res.resendInSeconds };
}

/**
 * `usePassword` (#2587): the code was right but the account holds a temporary password (#2628),
 * so no session exists — the form moves the payer to password sign-in with `error` as the
 * instruction. Absent on every other failure.
 */
export type VerifyCodeActionResult =
  | { ok: true; isNewPayer: boolean }
  | { ok: false; error: string; usePassword?: true };

export async function verifyCodeAction(input: {
  email: string;
  code: string;
}): Promise<VerifyCodeActionResult> {
  const email = emailSchema.safeParse(input.email);
  const code = codeSchema.safeParse(input.code);
  if (!email.success || !code.success) {
    // Same neutral copy as a code mismatch — no enumeration via validation.
    return { ok: false, error: NEUTRAL_VERIFY_ERROR };
  }
  const res = await payerAuth().verifyCode({ email: email.data, code: code.data });
  if (!res.ok) {
    if (res.reason === "password_change_required") {
      return { ok: false, error: TEMPORARY_PASSWORD_REQUIRED, usePassword: true };
    }
    return { ok: false, error: res.error };
  }
  return { ok: true, isNewPayer: res.isNewPayer };
}

/**
 * Password sign-in (#2587). `change_required`: the password was a TEMPORARY one (#2628) — it was
 * right, NO session exists, and the form must collect a new password before anything else.
 */
export type PasswordSignInActionResult =
  | { ok: true; isNewPayer: boolean }
  | { ok: false; outcome: "change_required" }
  | { ok: false; outcome: "refused"; error: string };

/**
 * Sign in with a login ID + password. On success the seam has set the SAME httpOnly session cookie
 * the code door sets; nothing else reaches the client. Any input the API's DTO would refuse gets
 * the neutral credential miss without a round trip. The password is never logged or returned.
 */
export async function passwordSignInAction(input: {
  identifier: string;
  password: string;
}): Promise<PasswordSignInActionResult> {
  const refused = { ok: false, outcome: "refused", error: PASSWORD_SIGNIN_ERROR } as const;
  const parsed = passwordSignInInputSchema.safeParse(input);
  if (!parsed.success) return refused;
  const identifier = identifierSchema.safeParse(normalizeLoginIdentifier(parsed.data.identifier));
  const password = presentedPasswordSchema.safeParse(parsed.data.password);
  if (!identifier.success || !password.success) return refused;

  const res = await payerAuth().loginWithPassword({
    identifier: identifier.data,
    password: password.data,
  });
  if (res.ok) return { ok: true, isNewPayer: res.isNewPayer };
  if (res.reason === "password_change_required") return { ok: false, outcome: "change_required" };
  return { ok: false, outcome: "refused", error: signInErrorFor(res) };
}

/**
 * The forced first change (#2587 / #2628). `new_password_rejected` → shown on the new-password
 * field; `temporary_password_rejected` → the temporary password no longer opens the account
 * (re-issued, revoked, locked out), so the form returns to sign-in with the neutral error;
 * `refused` → stays on the step.
 */
export type SetNewPasswordActionResult =
  | { ok: true; isNewPayer: boolean }
  | { ok: false; outcome: "new_password_rejected"; error: string }
  | { ok: false; outcome: "temporary_password_rejected"; error: string }
  | { ok: false; outcome: "refused"; error: string };

/**
 * Resend the temporary password with its replacement. Only a real session answer opens a session
 * (the seam sets the cookie then, and only then). The policy mirror runs first so a value the API
 * would refuse never makes the trip — the API re-checks it either way and is the authority.
 */
export async function setNewPasswordAction(input: {
  identifier: string;
  temporaryPassword: string;
  newPassword: string;
}): Promise<SetNewPasswordActionResult> {
  const restart = {
    ok: false,
    outcome: "temporary_password_rejected",
    error: PASSWORD_SIGNIN_ERROR,
  } as const;
  const parsed = setNewPasswordInputSchema.safeParse(input);
  if (!parsed.success) return restart;
  const identifier = identifierSchema.safeParse(normalizeLoginIdentifier(parsed.data.identifier));
  const temporary = presentedPasswordSchema.safeParse(parsed.data.temporaryPassword);
  if (!identifier.success || !temporary.success) return restart;
  const refusal = newPasswordRefusal(parsed.data.newPassword, temporary.data);
  if (refusal) {
    return { ok: false, outcome: "new_password_rejected", error: NEW_PASSWORD_ERRORS[refusal] };
  }

  const res = await payerAuth().loginWithPassword({
    identifier: identifier.data,
    password: temporary.data,
    newPassword: parsed.data.newPassword,
  });
  if (res.ok) return { ok: true, isNewPayer: res.isNewPayer };
  switch (res.reason) {
    case "new_password_rejected":
      return { ok: false, outcome: "new_password_rejected", error: NEW_PASSWORD_ERRORS[res.refusal] };
    case "invalid_credentials":
      return restart;
    case "suspended":
      return { ok: false, outcome: "refused", error: ACCOUNT_SUSPENDED };
    case "rate_limited":
      return { ok: false, outcome: "refused", error: PASSWORD_RATE_LIMITED };
    default:
      // An outage — or a second change request, which is still no session (fail closed).
      return { ok: false, outcome: "refused", error: NEW_PASSWORD_UNAVAILABLE };
  }
}

/** The copy for a refused first password attempt (status-derived; never the API's text). */
function signInErrorFor(res: Exclude<PasswordLoginResult, { ok: true }>): string {
  switch (res.reason) {
    case "invalid_credentials":
      return PASSWORD_SIGNIN_ERROR;
    case "suspended":
      return ACCOUNT_SUSPENDED;
    case "rate_limited":
      return PASSWORD_RATE_LIMITED;
    default:
      return PASSWORD_SIGNIN_UNAVAILABLE;
  }
}
