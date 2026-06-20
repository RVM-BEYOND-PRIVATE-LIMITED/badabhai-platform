"use server";

import { z } from "zod";
import { payerAuth } from "../../lib/auth";

/**
 * Login Server Actions (ADR-0019 Decision B / XB-H) — TWO-STEP OTP.
 *
 * Runs SERVER-SIDE only. Step 1 requests a code (no-enumeration response). Step 2
 * verifies it and the seam sets an httpOnly session cookie — no secret or token ever
 * reaches the client. Verify returns ONE neutral error for any failure (bad code OR
 * unknown email OR service error) — no user-enumeration oracle. Nothing is logged.
 */

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const codeSchema = z.string().trim().regex(/^\d{4,8}$/);

export type RequestCodeActionResult =
  | { ok: true; resendInSeconds: number; devOtp?: string }
  | { ok: false; error: string };

export async function requestCodeAction(input: {
  email: string;
}): Promise<RequestCodeActionResult> {
  const parsed = emailSchema.safeParse(input.email);
  if (!parsed.success) return { ok: false, error: "Enter a valid email." };
  const res = await payerAuth().requestCode({ email: parsed.data });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, resendInSeconds: res.resendInSeconds, devOtp: res.devOtp };
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
    return { ok: false, error: "Invalid or expired code." };
  }
  const res = await payerAuth().verifyCode({ email: email.data, code: code.data });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true };
}
