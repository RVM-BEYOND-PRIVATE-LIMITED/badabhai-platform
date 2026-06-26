"use server";

import { z } from "zod";
import { payerAuth } from "../../lib/auth";
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

export type RequestCodeActionResult =
  | { ok: true; resendInSeconds: number; devCode?: string }
  | { ok: false; error: string };

export async function requestCodeAction(input: {
  email: string;
}): Promise<RequestCodeActionResult> {
  const parsed = emailSchema.safeParse(input.email);
  // Same neutral copy as a send/limit failure — no enumeration via validation.
  if (!parsed.success) return { ok: false, error: NEUTRAL_SEND_ERROR };
  const res = await payerAuth().requestCode({ email: parsed.data });
  if (!res.ok) return { ok: false, error: NEUTRAL_SEND_ERROR };
  // DEV-ONLY convenience. The seam echoes `devOtp` ONLY for the mock/console channel
  // (PAYER_AUTH_MODE=mock, or the backend mock email channel in dev/test) — a REAL email
  // provider NEVER returns it, so this is structurally absent in staging/production.
  // Double-gate on NODE_ENV so the code can never reach a production build even if a
  // devOtp somehow leaked. This lets a developer complete login locally without a real
  // inbox; with a real provider the payer reads the code from their email (no devCode).
  if (process.env.NODE_ENV !== "production" && res.devOtp) {
    return { ok: true, resendInSeconds: res.resendInSeconds, devCode: res.devOtp };
  }
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
