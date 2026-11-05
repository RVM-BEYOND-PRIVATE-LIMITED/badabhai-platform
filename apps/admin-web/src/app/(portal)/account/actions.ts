"use server";

import { z } from "zod";
import { otpDigitsSchema } from "@badabhai/validators";
import { adminFetch } from "../../../lib/admin-http";
import { adminSessionTokenSchema } from "../../../lib/auth/session-token";
import { writeAdminToken } from "../../../lib/auth/session-cookie";
import { describeSelfServiceError } from "../../../lib/self-service-error";
import {
  PASSWORD_POLICY_ERROR,
  newPasswordSchema,
  presentedPasswordSchema,
} from "../../../lib/password-policy";
import type { AdminActionOutcome } from "../../../lib/admin-action-result";
import {
  CODE_SHAPE_ERROR,
  WRONG_AUTHENTICATOR_CODE,
  WRONG_CURRENT_PASSWORD,
} from "./messages";

/**
 * The signed-in admin's OWN sign-in settings (ADR-0060 A2/A5). Every route here is
 * `AdminAuthGuard` only — no capability — and acts on the SESSION's admin: no admin id is ever
 * sent, so there is nothing in a request body that could point one of these at someone else.
 */

const totpSchema = otpDigitsSchema(6);

// ── password ────────────────────────────────────────────────────────────────────────────────

/**
 * Set (first time) or change your password — `POST /admin/me/password`.
 *
 * The change signs out every session issued before it, THIS one included, and the API answers
 * with a FRESH session for the caller. Writing it into the cookie here is what keeps the operator
 * signed in on this page; without it their next navigation would bounce to /login. The token goes
 * response → httpOnly cookie and is never returned to the caller.
 *
 * `currentPassword` is sent only when given: the server requires it when a password is already
 * set and ignores it when none is.
 */
export async function setOwnPasswordAction(input: {
  currentPassword?: string;
  newPassword: string;
}): Promise<AdminActionOutcome> {
  const next = newPasswordSchema.safeParse(input.newPassword);
  if (!next.success) return { ok: false, error: PASSWORD_POLICY_ERROR };

  let current: string | undefined;
  if (input.currentPassword !== undefined && input.currentPassword !== "") {
    const parsed = presentedPasswordSchema.safeParse(input.currentPassword);
    if (!parsed.success) return { ok: false, error: WRONG_CURRENT_PASSWORD };
    current = parsed.data;
  }

  try {
    const res = await adminFetch("/admin/me/password", {
      method: "POST",
      body: {
        new_password: next.data,
        ...(current !== undefined ? { current_password: current } : {}),
      },
      schema: adminSessionTokenSchema,
    });
    await writeAdminToken(res.access_token, res.expires_in_seconds);
    return {
      ok: true,
      changed: true,
      message:
        "Password saved. You stay signed in here; every other session on your account has been signed out.",
    };
  } catch (err) {
    return { ok: false, error: await describeSelfServiceError(err, WRONG_CURRENT_PASSWORD) };
  }
}

// ── two-step verification (MFA) ─────────────────────────────────────────────────────────────

const enrollmentSchema = z.object({
  enrollment: z.object({
    secret: z.string().min(1),
    otpauth_uri: z.string().min(1),
  }),
});

export type EnableMfaResult =
  | { ok: true; enrollment: { secret: string; otpauthUri: string } }
  | { ok: false; error: string };

/**
 * Start turning two-step verification ON — `POST /admin/me/mfa/enable`. Mints a fresh
 * authenticator secret; nothing is switched on until {@link confirmMfaAction} proves the
 * operator's app holds it.
 *
 * The secret is returned to the caller ONCE so it can be drawn as a QR code — unavoidable, as at
 * sign-in. It is never persisted or logged, and dies with the component that shows it.
 */
export async function enableMfaAction(): Promise<EnableMfaResult> {
  try {
    const res = await adminFetch("/admin/me/mfa/enable", {
      method: "POST",
      body: {},
      schema: enrollmentSchema,
    });
    return {
      ok: true,
      enrollment: { secret: res.enrollment.secret, otpauthUri: res.enrollment.otpauth_uri },
    };
  } catch (err) {
    // A 409 ("already on") carries the server's own reason; the page refreshes to the truth.
    return { ok: false, error: await describeSelfServiceError(err, WRONG_AUTHENTICATOR_CODE) };
  }
}

/** Finish turning it on — `POST /admin/me/mfa/confirm` with a code from the new secret. */
export async function confirmMfaAction(input: { code: string }): Promise<AdminActionOutcome> {
  const code = totpSchema.safeParse(input.code);
  if (!code.success) return { ok: false, error: CODE_SHAPE_ERROR };

  try {
    await adminFetch("/admin/me/mfa/confirm", {
      method: "POST",
      body: { code: code.data },
      schema: z.object({ mfa_enabled: z.literal(true) }),
    });
    return {
      ok: true,
      changed: true,
      message:
        "Two-step verification is on. From your next sign-in you'll be asked for your password, then a code from your authenticator app.",
    };
  } catch (err) {
    return { ok: false, error: await describeSelfServiceError(err, WRONG_AUTHENTICATOR_CODE) };
  }
}

/**
 * Turn it OFF — `POST /admin/me/mfa/disable`, which needs a valid CURRENT code (proof the
 * operator still holds the authenticator, not just an unattended session). The server drops the
 * secret, so turning it back on later shows a new QR code, and every trusted device stops
 * counting.
 */
export async function disableMfaAction(input: { code: string }): Promise<AdminActionOutcome> {
  const code = totpSchema.safeParse(input.code);
  if (!code.success) return { ok: false, error: CODE_SHAPE_ERROR };

  try {
    await adminFetch("/admin/me/mfa/disable", {
      method: "POST",
      body: { code: code.data },
      schema: z.object({ mfa_enabled: z.literal(false) }),
    });
    return {
      ok: true,
      changed: true,
      message: "Two-step verification is off. You'll sign in with your email and password only.",
    };
  } catch (err) {
    return { ok: false, error: await describeSelfServiceError(err, WRONG_AUTHENTICATOR_CODE) };
  }
}
