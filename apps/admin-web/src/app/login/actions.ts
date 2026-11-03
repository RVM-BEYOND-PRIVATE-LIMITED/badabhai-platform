"use server";

import { z } from "zod";
import { emailSchema, otpDigitsSchema } from "@badabhai/validators";
import { adminFetch, AdminRequestError } from "../../lib/admin-http";
import {
  isDeviceTokenShape,
  readAdminDeviceToken,
  writeAdminDeviceToken,
  writeAdminToken,
} from "../../lib/auth/session-cookie";
import { adminSessionTokenSchema } from "../../lib/auth/session-token";
import {
  PASSWORD_POLICY_ERROR,
  newPasswordSchema,
  presentedPasswordSchema,
} from "../../lib/password-policy";
import { failureMessage } from "./failure";
import {
  NEUTRAL_CODE_ERROR,
  NEUTRAL_MFA_ERROR,
  NEUTRAL_PASSWORD_ERROR,
  NEUTRAL_REQUEST_ERROR,
  NEW_PASSWORD_REJECTED_ERROR,
} from "./messages";

/**
 * Admin sign-in Server Actions (ADR-0025 / ADR-0038, amended by ADR-0060).
 *
 * TWO first factors, ONE optional second factor:
 *
 *   passwordLoginAction  → email + password (the default door). May ask for a new password
 *                          first when the current one is temporary.
 *   requestCodeAction +
 *   verifyCodeAction     → email + emailed code (kept for admins with no password yet).
 *   verifyMfaAction      → the authenticator code, only for an admin who turned two-step
 *                          verification on and is not on a trusted device.
 *
 * Either first factor can now end in a SESSION directly — the default, since two-step
 * verification starts off (ADR-0060 A2) — or in "MFA required". The SERVER decides which, per
 * admin; this file only follows the answer. Every cookie write happens here, server-side: the
 * session token and the trusted-device token go straight from the API response into httpOnly
 * cookies and are never returned to the caller, so neither can reach the client bundle.
 *
 * Every one-time code is delivered to the admin's real mailbox and is never returned to,
 * pre-filled for, or displayed by the client — there is no dev shortcut on this surface,
 * deliberately, because the shortcut is what leaks in staging.
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

const sessionSchema = adminSessionTokenSchema;

const passwordChangeRequiredSchema = z.object({ status: z.literal("password_change_required") });

/**
 * ORDER IS LOAD-BEARING. A union returns its FIRST matching member, so the `status`-tagged
 * shapes come before the session: a response that says `mfa_required` and ALSO carries a stray
 * `access_token` (a backend regression) parses as MFA-required, the token is stripped, and no
 * cookie is written — MFA is never skipped because a field leaked.
 */
const firstFactorSchema = z.union([mfaRequiredSchema, sessionSchema]);
const passwordLoginSchema = z.union([
  passwordChangeRequiredSchema,
  mfaRequiredSchema,
  sessionSchema,
]);

/** The MFA step's session, which may carry a trusted-device token when one was asked for. */
const mfaSessionSchema = sessionSchema.extend({
  device_token: z.string().optional(),
  device_expires_in_seconds: z.number().int().positive().optional(),
});

export type Enrollment = { secret: string; otpauthUri: string };

/** Where a first factor leads. `signed_in` means the session cookie is ALREADY written. */
export type FirstFactorResult =
  | { ok: true; next: "signed_in" }
  | { ok: true; next: "mfa"; needsEnrollment: boolean; enrollment?: Enrollment }
  | { ok: false; error: string };

export type PasswordLoginResult = FirstFactorResult | { ok: true; next: "change_password" };

/**
 * Follow the server's answer to a first factor. The ONLY place a first factor writes a cookie,
 * and only for the session member of the union.
 *
 * `enrollment` is present only when an admin who turned two-step verification on has not set up
 * the authenticator yet, and carries the TOTP secret ONCE. It is passed to the client so the
 * operator can scan it, which is unavoidable — but it is never persisted, never logged, and
 * disappears when the form unmounts.
 */
async function followFirstFactor(
  res: z.infer<typeof firstFactorSchema>,
): Promise<Exclude<FirstFactorResult, { ok: false }>> {
  if ("status" in res) {
    return {
      ok: true,
      next: "mfa",
      needsEnrollment: res.needs_enrollment,
      enrollment: res.enrollment
        ? { secret: res.enrollment.secret, otpauthUri: res.enrollment.otpauth_uri }
        : undefined,
    };
  }
  // The cookie's lifetime mirrors the token's own: a cookie that outlived its token would leave
  // the portal repeatedly attempting dead requests.
  await writeAdminToken(res.access_token, res.expires_in_seconds);
  return { ok: true, next: "signed_in" };
}

/**
 * The trusted-device token for this browser, when it has a well-formed one, as a body fragment.
 * Absent ⇒ nothing is sent and the server simply asks for the authenticator code.
 */
async function deviceFragment(): Promise<{ device_token?: string }> {
  const token = await readAdminDeviceToken();
  return token ? { device_token: token } : {};
}

// ── email + password (the default) ──────────────────────────────────────────────────────────

/**
 * Sign in with email + password. When the API answers `password_change_required` (a temporary
 * password an admin was created with), the form asks for a new one and calls this again with
 * `newPassword`; the server sets it and continues to the MFA gate in the same request.
 */
export async function passwordLoginAction(input: {
  email: string;
  password: string;
  newPassword?: string;
}): Promise<PasswordLoginResult> {
  const email = emailSchema.safeParse(input.email);
  const password = presentedPasswordSchema.safeParse(input.password);
  // A malformed address or an empty password reads exactly like a refused one.
  if (!email.success || !password.success) return { ok: false, error: NEUTRAL_PASSWORD_ERROR };

  const changing = input.newPassword !== undefined;
  let newPassword: string | undefined;
  if (changing) {
    const parsed = newPasswordSchema.safeParse(input.newPassword);
    // Not an oracle: a policy failure is about the typed value, never about the account.
    if (!parsed.success) return { ok: false, error: PASSWORD_POLICY_ERROR };
    newPassword = parsed.data;
  }

  try {
    const res = await adminFetch("/admin/login/password", {
      method: "POST",
      body: {
        email: email.data,
        password: password.data,
        ...(newPassword !== undefined ? { new_password: newPassword } : {}),
        ...(await deviceFragment()),
      },
      schema: passwordLoginSchema,
      public: true,
    });
    if ("status" in res && res.status === "password_change_required") {
      // Asked again AFTER a new password was supplied would mean the server did not take it;
      // never loop the operator back to the same screen with no explanation.
      if (changing) return { ok: false, error: NEW_PASSWORD_REJECTED_ERROR };
      return { ok: true, next: "change_password" };
    }
    return await followFirstFactor(res);
  } catch (err) {
    // A 400 is body validation. The client already enforces the policy, so on the change step
    // it means the new password was refused (re-using the temporary one). It cannot be an
    // enumeration signal: the API validates the body before it looks up any account.
    if (changing && err instanceof AdminRequestError && err.status === 400) {
      return { ok: false, error: NEW_PASSWORD_REJECTED_ERROR };
    }
    return { ok: false, error: failureMessage(err, NEUTRAL_PASSWORD_ERROR) };
  }
}

// ── email + emailed code (kept for admins with no password) ─────────────────────────────────

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

/**
 * The emailed code. Leads to the authenticator step for an admin with two-step verification on
 * (unless this browser is a trusted device), and straight to a session otherwise — ADR-0060
 * made `mfa_required | session` the response here, as on the password door.
 */
export async function verifyCodeAction(input: {
  email: string;
  code: string;
}): Promise<FirstFactorResult> {
  const email = emailSchema.safeParse(input.email);
  const code = otpSchema.safeParse(input.code);
  if (!email.success || !code.success) return { ok: false, error: NEUTRAL_CODE_ERROR };

  try {
    const res = await adminFetch("/admin/login/verify", {
      method: "POST",
      body: { email: email.data, code: code.data, ...(await deviceFragment()) },
      schema: firstFactorSchema,
      public: true,
    });
    return await followFirstFactor(res);
  } catch (err) {
    // 409 is the one non-neutral answer here (ADR-0060): the code was right, but the account is
    // still on a temporary password and must use the password door. The caller has just proven
    // mailbox control, so the server's own copy is safe to show.
    if (err instanceof AdminRequestError && err.status === 409) {
      return { ok: false, error: err.message };
    }
    return { ok: false, error: failureMessage(err, NEUTRAL_CODE_ERROR) };
  }
}

// ── the authenticator code ──────────────────────────────────────────────────────────────────

export type VerifyMfaResult = { ok: true } | { ok: false; error: string };

/**
 * The authenticator code, and — when the operator ticked "Trust this device" — the device
 * cookie.
 *
 * Both tokens go straight from the API response into httpOnly cookies without ever being
 * returned to the caller. The device token is stored only when it was ASKED for (a token the
 * operator did not request is not kept) and only when it has the shape the API accepts back.
 */
export async function verifyMfaAction(input: {
  email: string;
  code: string;
  trustDevice?: boolean;
}): Promise<VerifyMfaResult> {
  const email = emailSchema.safeParse(input.email);
  const code = totpSchema.safeParse(input.code);
  if (!email.success || !code.success) return { ok: false, error: NEUTRAL_MFA_ERROR };
  const trustDevice = input.trustDevice === true;

  try {
    const res = await adminFetch("/admin/mfa/verify", {
      method: "POST",
      // `trust_device` is optional on the API (default false); it is sent only when true so an
      // operator who did not tick the box makes exactly the request they always made.
      body: { email: email.data, code: code.data, ...(trustDevice ? { trust_device: true } : {}) },
      schema: mfaSessionSchema,
      public: true,
    });
    await writeAdminToken(res.access_token, res.expires_in_seconds);
    if (
      trustDevice &&
      res.device_token !== undefined &&
      res.device_expires_in_seconds !== undefined &&
      isDeviceTokenShape(res.device_token)
    ) {
      await writeAdminDeviceToken(res.device_token, res.device_expires_in_seconds);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: failureMessage(err, NEUTRAL_MFA_ERROR) };
  }
}
