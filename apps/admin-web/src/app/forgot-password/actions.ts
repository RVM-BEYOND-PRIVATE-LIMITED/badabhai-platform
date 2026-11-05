"use server";

import { z } from "zod";
import { emailSchema, otpDigitsSchema } from "@badabhai/validators";
import { adminFetch, AdminRequestError } from "../../lib/admin-http";
import { PASSWORD_POLICY_ERROR, newPasswordSchema } from "../../lib/password-policy";
import { failureMessage } from "../login/failure";
import { NEUTRAL_RESET_ERROR, NEUTRAL_RESET_REQUEST_ERROR } from "./messages";

/**
 * Forgot password (ADR-0060 A4) — two PUBLIC calls, both IP-capped by the API:
 *
 *   requestResetCodeAction → `POST /admin/password/forgot`: email a 6-digit reset code
 *   resetPasswordAction    → `POST /admin/password/reset`: code + new password
 *
 * A RESET NEVER SIGNS ANYONE IN. Neither the API nor this file has a path from here to a session
 * cookie — this module does not even import the cookie helpers — and the API signs out every
 * existing session and trusted device when the password changes. The admin then signs in
 * normally, authenticator included if they turned it on. A stolen mailbox therefore buys a
 * password change and a sign-in, never a way around the authenticator.
 *
 * Reset codes live in their own namespace on the server: a sign-in code cannot reset a password
 * and a reset code cannot sign anyone in.
 */

const resetCodeSchema = otpDigitsSchema({ min: 4, max: 8 });

const codeSentSchema = z.object({
  status: z.literal("code_sent"),
  resend_in_seconds: z.number().int().nonnegative(),
});

const resetDoneSchema = z.object({
  status: z.literal("password_reset"),
  next: z.literal("sign_in"),
});

export type RequestResetCodeResult =
  | { ok: true; resendInSeconds: number }
  | { ok: false; error: string };

export async function requestResetCodeAction(input: {
  email: string;
}): Promise<RequestResetCodeResult> {
  const email = emailSchema.safeParse(input.email);
  // Same copy as a send failure — client-side validation is not an enumeration channel either.
  if (!email.success) return { ok: false, error: NEUTRAL_RESET_REQUEST_ERROR };

  try {
    const res = await adminFetch("/admin/password/forgot", {
      method: "POST",
      body: { email: email.data },
      schema: codeSentSchema,
      public: true,
    });
    return { ok: true, resendInSeconds: res.resend_in_seconds };
  } catch (err) {
    return { ok: false, error: failureMessage(err, NEUTRAL_RESET_REQUEST_ERROR) };
  }
}

export type ResetPasswordResult = { ok: true } | { ok: false; error: string };

export async function resetPasswordAction(input: {
  email: string;
  code: string;
  newPassword: string;
}): Promise<ResetPasswordResult> {
  const email = emailSchema.safeParse(input.email);
  const code = resetCodeSchema.safeParse(input.code);
  if (!email.success || !code.success) return { ok: false, error: NEUTRAL_RESET_ERROR };
  const newPassword = newPasswordSchema.safeParse(input.newPassword);
  // About the typed value only, never the account — safe to say plainly.
  if (!newPassword.success) return { ok: false, error: PASSWORD_POLICY_ERROR };

  try {
    await adminFetch("/admin/password/reset", {
      method: "POST",
      body: { email: email.data, code: code.data, new_password: newPassword.data },
      schema: resetDoneSchema,
      public: true,
    });
    return { ok: true };
  } catch (err) {
    // A 400 is body validation, which the API runs before it looks at any account. With the
    // code and email already checked here, what it can still refuse is the password.
    if (err instanceof AdminRequestError && err.status === 400) {
      return { ok: false, error: PASSWORD_POLICY_ERROR };
    }
    return { ok: false, error: failureMessage(err, NEUTRAL_RESET_ERROR) };
  }
}
