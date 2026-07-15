import { z } from "zod";
import { e164PhoneSchema } from "@badabhai/validators";
import { DeviceInfoSchema } from "./devices.dto";

export const OtpRequestSchema = z.object({
  phone: e164PhoneSchema,
});
export type OtpRequestDto = z.infer<typeof OtpRequestSchema>;

export const OtpVerifySchema = z.object({
  phone: e164PhoneSchema,
  // Accept 4-8 digits to match the configurable OTP_LENGTH (default 6).
  otp: z.string().regex(/^\d{4,8}$/, "OTP must be 4-8 digits"),
  // ADR-0026 Phase 2 — OPTIONAL trusted-device binding. Omitted by clients that don't
  // bind a device → login behaves exactly as before (additive, back-compat §8).
  device_info: DeviceInfoSchema.optional(),
});
export type OtpVerifyDto = z.infer<typeof OtpVerifySchema>;

/** Response of POST /auth/otp/request. The code is delivered ONLY to the worker's
 * phone via the real SMS provider — it is never returned here (real-only). */
export interface OtpRequestResponse {
  success: true;
  channel: string;
  resend_in_seconds: number;
}

/** Session introspection (tier/expiry) embedded in mint responses (ADR-0026). */
export interface SessionInfo {
  tier: number;
  /** ISO-8601 of the current session record's idle expiry. */
  expires_at: string;
  /** ISO-8601 of the absolute cap when tiers are enabled, else null. */
  requires_otp_after: string | null;
}

/**
 * Login payload returned by POST /auth/otp/verify.
 *
 * BACK-COMPAT (§8): every field shipped before is unchanged. ADR-0026 ADDS the optional
 * opaque rotating `refresh_token` (+ its TTL) and the `session` introspection block — all
 * additive, never removed/renamed. The refresh token is the long-lived credential.
 */
export interface LoginResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in_seconds: number;
  worker_id: string;
  is_new_worker: boolean;
  status: string;
  // ADR-0026 Phase 4 — does this worker already have a device-unlock PIN, so the app routes enter-PIN vs set-PIN
  pin_set: boolean;
  refresh_token: string;
  refresh_expires_in_seconds: number;
  session: SessionInfo;
  // TD62 — ADDITIVE + OPTIONAL: does this worker hold an ACTIVE (non-revoked) DPDP
  // consent? The app's router gates the shell on a definitive `false` (→ /consent);
  // it is a boolean derived from worker_consents, never PII, and no event changes
  // with it. OPTIONAL (review F1): the compose runs AFTER the OTP is consumed + the
  // session minted, so a consent-read blip must not 500 a login that server-side
  // succeeded (the worker would burn another OTP against the TD60 daily cap) — the
  // controller OMITS the field on a read failure, and the app's tri-state treats
  // absent as unknown/pass-through (ConsentGuard stays authoritative server-side).
  consent_accepted?: boolean;
}

/** Response of POST /auth/refresh (legacy rolling-token refresh — unchanged). */
export interface RefreshResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in_seconds: number;
}

/** Body of POST /auth/token/refresh — the opaque rotating refresh token (ADR-0026). */
export const TokenRefreshSchema = z.object({
  refresh_token: z.string().min(1, "refresh_token is required"),
});
export type TokenRefreshDto = z.infer<typeof TokenRefreshSchema>;

/** Body of POST /auth/account/delete/confirm — the step-up OTP code (ADR-0026 Phase 5).
 * Mirrors OtpVerifySchema's otp (4-8 digits, the configurable OTP_LENGTH). Identity is the
 * guard's worker.id — the body carries ONLY the OTP, never a worker id. */
export const AccountDeleteConfirmSchema = z.object({
  otp: z.string().regex(/^\d{4,8}$/, "OTP must be 4-8 digits"),
});
export type AccountDeleteConfirmDto = z.infer<typeof AccountDeleteConfirmSchema>;

/** Response of POST /auth/account/delete/request — the resend cooldown (no PII, no code). */
export interface AccountDeleteRequestResponse {
  success: true;
  resend_in_seconds: number;
}

/** Response of POST /auth/token/refresh — fresh access + rotated refresh + session. */
export interface TokenRefreshResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in_seconds: number;
  refresh_token: string;
  refresh_expires_in_seconds: number;
  session: SessionInfo;
}

/** Response of GET /auth/session — tier + expiry introspection (ADR-0026). */
export interface SessionResponse {
  tier: number;
  expires_at: string;
  requires_otp_after: string | null;
}

// NOTE: POST /auth/logout-all returns 204 No Content (no body). The count of sessions
// revoked is recorded in the PII-free `worker.logged_out_all` event, never in a response
// body — so there is intentionally NO LogoutAllResponse type.

/** Response of GET /auth/me. */
export interface MeResponse {
  worker_id: string;
  status: string;
}
