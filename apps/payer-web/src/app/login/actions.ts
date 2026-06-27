"use server";

import { z } from "zod";
import { e164PhoneSchema } from "@badabhai/validators";
import { payerAuth } from "../../lib/auth";
import type { PayerRole } from "../../lib/auth";
import { NEUTRAL_SEND_ERROR, NEUTRAL_VERIFY_ERROR } from "./messages";

/**
 * Login Server Actions (ADR-0019 Decision B / XB-H) — TWO-STEP OTP.
 *
 * Runs SERVER-SIDE only. Step 1 requests a code (no-enumeration response) and NEVER
 * returns the code to the client — the payer reads it from their real email. Step 2
 * verifies it and the seam sets an httpOnly session cookie — no secret or token ever
 * reaches the client. Both steps return ONE neutral error for any failure (bad/expired
 * code OR unknown email OR send failure/limit) — no user-enumeration oracle. Nothing is
 * logged.
 */

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const codeSchema = z.string().trim().regex(/^\d{4,8}$/);
const roleSchema = z.enum(["employer", "agent"]);
// org_name: trimmed 1..200 — matches the backend `PayerSignupSchema` exactly.
const orgNameSchema = z.string().trim().min(1).max(200);
// phone: OPTIONAL E.164 — reuse the shared validator (parity with the backend).
const phoneSchema = e164PhoneSchema;

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

export type VerifyCodeActionResult = { ok: true } | { ok: false; error: string };

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
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true };
}
