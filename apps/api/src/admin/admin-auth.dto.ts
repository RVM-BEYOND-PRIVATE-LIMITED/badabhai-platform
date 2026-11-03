import { z } from "zod";
import type { AdminRole } from "@badabhai/db";
import { PasswordPolicySchema, PresentedPasswordSchema } from "../common/password-policy";
import type { AdminCapability } from "./admin-capabilities";

/**
 * Admin auth DTOs (ADR-0025 ADMIN-1). The login identifier is the admin's work EMAIL (the
 * keyed-hash lookup key in `admin_users`). The email is ADMIN-class PII: accepted here,
 * encrypted at rest, and NEVER echoed into an event, a log, or any response body.
 */

/** The login identifier — normalized here, hashed for lookup, never echoed or logged. */
const AdminEmailSchema = z.string().trim().toLowerCase().email().max(254);

/** An emailed one-time code: 4-8 digits to match the configurable OTP_LENGTH (default 6). */
const AdminEmailedCodeSchema = z.string().regex(/^\d{4,8}$/, "Code must be 4-8 digits");

/** A 6-digit code from the authenticator app. */
const AdminTotpCodeSchema = z.string().regex(/^\d{6}$/, "TOTP code must be 6 digits");

/**
 * A "trust this device" token presented back at sign-in (migration 0142). Bounded so an
 * oversized value is rejected before it reaches a hash: the mint is 43 base64url chars.
 */
const AdminDeviceTokenSchema = z.string().trim().min(20).max(128);

export const AdminLoginRequestSchema = z
  .object({
    email: AdminEmailSchema,
  })
  .strict();
export type AdminLoginRequestDto = z.infer<typeof AdminLoginRequestSchema>;

export const AdminLoginVerifySchema = z
  .object({
    email: AdminEmailSchema,
    code: AdminEmailedCodeSchema,
    // 0142 — optional: a trusted browser skips the TOTP step (never the emailed code).
    device_token: AdminDeviceTokenSchema.optional(),
  })
  .strict();
export type AdminLoginVerifyDto = z.infer<typeof AdminLoginVerifySchema>;

/** Verify a TOTP second factor against an in-progress (MFA-pending) login. */
export const AdminMfaVerifySchema = z
  .object({
    email: AdminEmailSchema,
    // The 6-digit TOTP code from the authenticator app.
    code: AdminTotpCodeSchema,
    // 0142 — "trust this device": when true (and ADMIN_TRUSTED_DEVICE_DAYS > 0) the session
    // response also carries a device token the browser presents on later sign-ins.
    trust_device: z.boolean().optional(),
  })
  .strict();
export type AdminMfaVerifyDto = z.infer<typeof AdminMfaVerifySchema>;

/**
 * POST /admin/login/password (migration 0142). `password` is bounded but NOT policy-checked —
 * every well-formed attempt burns one KDF, so a weak guess is indistinguishable from a wrong one.
 * `new_password` IS policy-checked: it is only consumed on the must-change step (temporary
 * password → own password) and is ignored otherwise.
 */
export const AdminPasswordLoginSchema = z
  .object({
    email: AdminEmailSchema,
    password: PresentedPasswordSchema,
    new_password: PasswordPolicySchema.optional(),
    device_token: AdminDeviceTokenSchema.optional(),
  })
  .strict();
export type AdminPasswordLoginDto = z.infer<typeof AdminPasswordLoginSchema>;

/** POST /admin/password/forgot — the email only; the response never depends on it. */
export const AdminPasswordForgotSchema = z.object({ email: AdminEmailSchema }).strict();
export type AdminPasswordForgotDto = z.infer<typeof AdminPasswordForgotSchema>;

/** POST /admin/password/reset — the emailed reset code + the new password (policy-checked). */
export const AdminPasswordResetSchema = z
  .object({
    email: AdminEmailSchema,
    code: AdminEmailedCodeSchema,
    new_password: PasswordPolicySchema,
  })
  .strict();
export type AdminPasswordResetDto = z.infer<typeof AdminPasswordResetSchema>;

/**
 * POST /admin/me/password. `current_password` is required by the SERVICE when the admin already
 * has one (it depends on the row, so it cannot be a schema rule) and ignored when they do not.
 */
export const AdminChangePasswordSchema = z
  .object({
    current_password: PresentedPasswordSchema.optional(),
    new_password: PasswordPolicySchema,
  })
  .strict();
export type AdminChangePasswordDto = z.infer<typeof AdminChangePasswordSchema>;

/** POST /admin/me/mfa/confirm and /admin/me/mfa/disable — one authenticator code. */
export const AdminMfaCodeSchema = z.object({ code: AdminTotpCodeSchema }).strict();
export type AdminMfaCodeDto = z.infer<typeof AdminMfaCodeSchema>;

/**
 * Redeem an invite accept link (POST /admin/invites/accept).
 *
 * The token alone — deliberately no email field. Asking for the address would add nothing
 * (the token already identifies exactly one pending row) while turning the endpoint into an
 * email-enumeration oracle and giving a phisher a reason to collect one. The bound is 128 so
 * an oversized body is rejected before it reaches a hash: the mint is 43 base64url chars, and
 * the range leaves room to widen TOKEN_BYTES without a DTO change.
 */
export const AdminInviteAcceptSchema = z
  .object({
    token: z.string().trim().min(20).max(128),
  })
  .strict();
export type AdminInviteAcceptDto = z.infer<typeof AdminInviteAcceptSchema>;

/**
 * Response of POST /admin/login/request and POST /admin/login/verify when MFA is still
 * pending. DELIBERATELY account-state-INDEPENDENT for `login/request` (XB-H no-enumeration):
 * a caller cannot tell a known from an unknown email. The code is delivered ONLY out-of-band
 * — never returned here.
 */
export interface AdminAuthCodeResponse {
  status: "code_sent";
  resend_in_seconds: number;
}

/**
 * Returned when OTP verified but the admin must still pass / set up MFA before a session is
 * minted (must-fix #1 — NO full session until MFA is satisfied). `enrollment` is present only
 * when the admin has not yet enrolled a TOTP secret; it carries the otpauth URI/secret to set
 * up the authenticator (shown once). NO session token is present in this response.
 */
export interface AdminMfaRequiredResponse {
  status: "mfa_required";
  /** True when this admin has no enrolled second factor yet → must enroll before logging in. */
  needs_enrollment: boolean;
  /** Present ONLY when needs_enrollment is true. The TOTP provisioning material (once-only). */
  enrollment?: {
    secret: string;
    otpauth_uri: string;
  };
}

/** A minted admin session (returned only after the first factor + the MFA gate both pass). */
export interface AdminSessionResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in_seconds: number;
  admin_id: string;
  role: AdminRole;
  /**
   * 0142 — present ONLY on POST /admin/mfa/verify with `trust_device: true` while
   * ADMIN_TRUSTED_DEVICE_DAYS > 0. Shown once; the browser stores it and presents it as
   * `device_token` on later sign-ins to skip the TOTP step.
   */
  device_token?: string;
  device_expires_in_seconds?: number;
}

/**
 * 0142 — POST /admin/login/password when the account carries a TEMPORARY password and the
 * request had no `new_password`: the client must ask for one and resend. No session, no token.
 */
export interface AdminPasswordChangeRequiredResponse {
  status: "password_change_required";
}

/**
 * 0142 — POST /admin/password/reset. NO SESSION, by design: a reset proves mailbox control and
 * sets a password; the admin then signs in through the ordinary door (two-step included).
 */
export interface AdminPasswordResetResponse {
  status: "password_reset";
  next: "sign_in";
}

/** 0142 — POST /admin/me/mfa/enable: the fresh authenticator material, shown once. */
export interface AdminMfaEnrollmentResponse {
  enrollment: {
    secret: string;
    otpauth_uri: string;
  };
}

/** 0142 — POST /admin/me/mfa/confirm and /disable: the admin's two-step switch after the call. */
export interface AdminMfaStateResponse {
  mfa_enabled: boolean;
}

/**
 * Response of POST /admin/invites/accept. PII-FREE: the opaque admin id and role only.
 *
 * NO SESSION IS RETURNED, by design. Accepting proves mailbox control and makes the account
 * real; it does not bypass the second factor. `next: "sign_in"` tells the client to send the
 * now-active admin to the ordinary login, where TOTP enrolment happens exactly as it does for
 * every other admin — one way into a session, not two.
 */
export interface AdminInviteAcceptedResponse {
  admin_id: string;
  role: AdminRole;
  status: "active";
  next: "sign_in";
}

/** Response of POST /admin/refresh. */
export interface AdminRefreshResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in_seconds: number;
}

/**
 * The authenticated admin's own identity view (GET /admin/me). PII-FREE: id, role, the
 * server-resolved capability list and three account booleans — no name, no email, nothing
 * derived from one.
 *
 * `capabilities` is what the Admin Portal renders against so it never carries its own copy of
 * `ADMIN_CAPABILITY_MATRIX` (see `capabilitiesFor`). It is advisory to the client and
 * authoritative nowhere: every route still enforces `@RequireAdminRole` independently.
 */
export interface AdminMeResponse {
  admin_id: string;
  role: AdminRole;
  capabilities: AdminCapability[];
  /** 0142 — true once the admin has a password (else the Account page offers "set"). */
  has_password: boolean;
  /** 0142 — true while the admin still holds a super_admin-issued temporary password. */
  must_change_password: boolean;
  /** 0142 (Amendment 1) — the admin's own two-step switch. */
  mfa_enabled: boolean;
}

/** 0142 — the per-admin account flags `GET /admin/me` adds (read from the live row). */
export type AdminAccountFlags = Pick<
  AdminMeResponse,
  "has_password" | "must_change_password" | "mfa_enabled"
>;
