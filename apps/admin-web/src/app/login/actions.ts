"use server";

import { z } from "zod";
import { emailSchema, otpDigitsSchema } from "@badabhai/validators";
import { adminFetch, AdminRequestError } from "../../lib/admin-http";
import { writeAdminToken } from "../../lib/auth/session-cookie";
import {
  NEUTRAL_CODE_ERROR,
  NEUTRAL_MFA_ERROR,
  NEUTRAL_REQUEST_ERROR,
  SERVICE_UNAVAILABLE_ERROR,
} from "./messages";

/**
 * Admin login Server Actions — the THREE-step chain (ADR-0025 / ADR-0038).
 *
 *   1. requestCodeAction  → email a one-time code
 *   2. verifyCodeAction   → exchange it for "MFA required" (NEVER a session)
 *   3. verifyMfaAction    → TOTP, and only now a session cookie
 *
 * All three run server-side. The one-time code is delivered to the admin's real mailbox
 * and is never returned to, pre-filled for, or displayed by the client — there is no dev
 * shortcut on this surface, deliberately, because the shortcut is what leaks in staging.
 *
 * Step 2 returning no token is the property that makes MFA meaningful: a stolen mailbox
 * gets an attacker to "mfa_required" and no further.
 */

const otpSchema = otpDigitsSchema({ min: 4, max: 8 });
const totpSchema = otpDigitsSchema(6);

const codeSentSchema = z.object({
  status: z.literal("code_sent"),
  resend_in_seconds: z.number().int().nonnegative(),
});

const mfaRequiredSchema = z.object({
  status: z.literal("mfa_required"),
  needs_enrollment: z.boolean(),
  enrollment: z
    .object({
      secret: z.string().min(1),
      otpauth_uri: z.string().min(1),
    })
    .optional(),
});

const sessionSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.literal("Bearer"),
  expires_in_seconds: z.number().int().positive(),
  admin_id: z.string().min(1),
  role: z.string().min(1),
});

/** Distinguish "the service is down" from "your input was wrong" — only these two. */
function failureMessage(err: unknown, neutral: string): string {
  // A transport failure (status 0) or a 5xx is not the operator's fault and telling them
  // to re-check their code would send them in circles. Everything else stays neutral.
  if (err instanceof AdminRequestError && (err.status === 0 || err.status >= 500)) {
    return SERVICE_UNAVAILABLE_ERROR;
  }
  return neutral;
}

export type RequestCodeResult =
  | { ok: true; resendInSeconds: number }
  | { ok: false; error: string };

export async function requestCodeAction(input: { email: string }): Promise<RequestCodeResult> {
  const email = emailSchema.safeParse(input.email);
  // Same neutral copy as a send failure — no enumeration through client-side validation.
  if (!email.success) return { ok: false, error: NEUTRAL_REQUEST_ERROR };

  try {
    const res = await adminFetch("/admin/login/request", {
      method: "POST",
      body: { email: email.data },
      schema: codeSentSchema,
      public: true,
    });
    return { ok: true, resendInSeconds: res.resend_in_seconds };
  } catch (err) {
    return { ok: false, error: failureMessage(err, NEUTRAL_REQUEST_ERROR) };
  }
}

export type VerifyCodeResult =
  | { ok: true; needsEnrollment: boolean; enrollment?: { secret: string; otpauthUri: string } }
  | { ok: false; error: string };

/**
 * Step 2. On success this returns MFA state and **no token** — by construction: the
 * backend does not mint a session here, and this action has no path that could set a
 * cookie even if one appeared.
 *
 * `enrollment` is present only on a first login and carries the TOTP secret ONCE. It is
 * passed to the client so the operator can scan it, which is unavoidable — but it is
 * never persisted, never logged, and disappears when the form unmounts.
 */
export async function verifyCodeAction(input: {
  email: string;
  code: string;
}): Promise<VerifyCodeResult> {
  const email = emailSchema.safeParse(input.email);
  const code = otpSchema.safeParse(input.code);
  if (!email.success || !code.success) return { ok: false, error: NEUTRAL_CODE_ERROR };

  try {
    const res = await adminFetch("/admin/login/verify", {
      method: "POST",
      body: { email: email.data, code: code.data },
      schema: mfaRequiredSchema,
      public: true,
    });
    return {
      ok: true,
      needsEnrollment: res.needs_enrollment,
      enrollment: res.enrollment
        ? { secret: res.enrollment.secret, otpauthUri: res.enrollment.otpauth_uri }
        : undefined,
    };
  } catch (err) {
    return { ok: false, error: failureMessage(err, NEUTRAL_CODE_ERROR) };
  }
}

export type VerifyMfaResult = { ok: true } | { ok: false; error: string };

/**
 * Step 3. The ONLY place an admin session cookie is written.
 *
 * The token goes straight from the API response into an httpOnly cookie without ever
 * being returned to the caller, so it cannot reach the client bundle even by accident.
 * The cookie's lifetime mirrors the token's own `expires_in_seconds` — a cookie that
 * outlived its token would leave the portal repeatedly attempting dead requests.
 */
export async function verifyMfaAction(input: {
  email: string;
  code: string;
}): Promise<VerifyMfaResult> {
  const email = emailSchema.safeParse(input.email);
  const code = totpSchema.safeParse(input.code);
  if (!email.success || !code.success) return { ok: false, error: NEUTRAL_MFA_ERROR };

  try {
    const res = await adminFetch("/admin/mfa/verify", {
      method: "POST",
      body: { email: email.data, code: code.data },
      schema: sessionSchema,
      public: true,
    });
    await writeAdminToken(res.access_token, res.expires_in_seconds);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: failureMessage(err, NEUTRAL_MFA_ERROR) };
  }
}
