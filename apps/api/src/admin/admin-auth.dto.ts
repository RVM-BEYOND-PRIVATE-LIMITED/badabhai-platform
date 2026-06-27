import { z } from "zod";
import type { AdminRole } from "@badabhai/db";

/**
 * Admin auth DTOs (ADR-0025 ADMIN-1). The login identifier is the admin's work EMAIL (the
 * keyed-hash lookup key in `admin_users`). The email is ADMIN-class PII: accepted here,
 * encrypted at rest, and NEVER echoed into an event, a log, or any response body.
 */

export const AdminLoginRequestSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
  })
  .strict();
export type AdminLoginRequestDto = z.infer<typeof AdminLoginRequestSchema>;

export const AdminLoginVerifySchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    // 4-8 digits to match the configurable OTP_LENGTH (default 6).
    code: z.string().regex(/^\d{4,8}$/, "Code must be 4-8 digits"),
  })
  .strict();
export type AdminLoginVerifyDto = z.infer<typeof AdminLoginVerifySchema>;

/** Verify a TOTP second factor against an in-progress (MFA-pending) login. */
export const AdminMfaVerifySchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    // The 6-digit TOTP code from the authenticator app.
    code: z.string().regex(/^\d{6}$/, "TOTP code must be 6 digits"),
  })
  .strict();
export type AdminMfaVerifyDto = z.infer<typeof AdminMfaVerifySchema>;

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

/** A minted admin session (returned only after OTP + the MFA gate both pass). */
export interface AdminSessionResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in_seconds: number;
  admin_id: string;
  role: AdminRole;
}

/** Response of POST /admin/refresh. */
export interface AdminRefreshResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in_seconds: number;
}

/** The authenticated admin's own identity view (GET /admin/me). PII-FREE: id + role only. */
export interface AdminMeResponse {
  admin_id: string;
  role: AdminRole;
}
