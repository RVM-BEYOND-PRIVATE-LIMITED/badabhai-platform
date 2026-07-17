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

/**
 * D-3 (security review M1) — the RESERVED SYNTHETIC test-phone range the gated
 * test-login mint will serve: `+91` + `00000` + 5 free digits (`+9100000XXXXX`,
 * e.g. the smoke's default `+910000000000`). 100,000 addresses, all unassignable.
 *
 * WHY THIS RANGE IS SAFE: a real Indian mobile is `+91` followed by 10 digits
 * that begin **6–9**, so a subscriber part starting with five zeros can NEVER be
 * a real worker's number. That matters because staging runs REAL Fast2SMS, so
 * real workers CAN exist there: without this rule a token holder on an armed env
 * could mint a session for ANY existing worker (`mintLoginForPhone` find-or-creates
 * by phone_hash). Restricting the mint to an unassignable range means the seam can
 * only ever create/reach synthetic accounts — it cannot impersonate a real worker.
 *
 * HARD-CODED, deliberately NOT an env knob: a config-widenable allowlist is one
 * mis-set var away from serving real numbers. The runbook's ESC-1 option (C)
 * already prescribed "the phone is synthetic-reserved" — this is that leg.
 */
export const SYNTHETIC_TEST_PHONE_PATTERN = /^\+910{5}\d{5}$/;

/** True when `phone` is inside {@link SYNTHETIC_TEST_PHONE_PATTERN} (the ONLY
 *  range the D-3 test-login mint serves). Fail-closed on any non-string. */
export function isSyntheticTestPhone(phone: string): boolean {
  return typeof phone === "string" && SYNTHETIC_TEST_PHONE_PATTERN.test(phone);
}

/** Body of POST /auth/test-login (D-3 — the GATED test-login mint seam; staging
 * smoke / e2e only, prod-boot-blocked). Carries ONLY the synthetic test phone —
 * the gate secret rides the `x-test-login-token` header (TestLoginGuard), never
 * the body. The phone must additionally be in the reserved synthetic range
 * ({@link isSyntheticTestPhone}); that is enforced at the MINT CHOKEPOINT
 * (AuthService.testLogin) rather than here, so a real-looking number gets the
 * same NEUTRAL 404 as a disabled seam instead of a 400 that would confirm the
 * seam exists and is armed. The response is the SAME LoginResponse shape as
 * /auth/otp/verify. */
export const TestLoginSchema = z.object({
  phone: e164PhoneSchema,
});
export type TestLoginDto = z.infer<typeof TestLoginSchema>;

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
  // ADR-0031 — present ONLY while a deletion is pending: the PII-free ISO-8601 due time
  // of the scheduled erasure, so the app shows the grace banner + explicit cancel prompt
  // (never auto-cancel). Login itself works unchanged during grace.
  deletion_scheduled_for?: string;
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

/** Response of POST /auth/account/delete/confirm (ADR-0031 — confirm now SCHEDULES the
 * erasure, was 204). `scheduled_for` is the PII-free ISO-8601 due time of the hard-delete;
 * the worker can cancel anytime before it. */
export interface AccountDeleteConfirmResponse {
  success: true;
  scheduled_for: string;
}

/** Response of POST /auth/account/delete/cancel (ADR-0031). ALWAYS { success: true } —
 * cancel is idempotent, and a nothing-pending cancel is a clean 200 no-op (whether an
 * event fired is recorded by worker.deletion_cancelled, never the body). */
export interface AccountDeleteCancelResponse {
  success: true;
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

/**
 * Response of GET /auth/me.
 *
 * ADR-0031 — this is the ONE seam that carries the pending-deletion state to EVERY
 * authenticated entry path. The OTP-verify login response also carries
 * `deletion_scheduled_for`, but a cold start normally goes bootstrap → locked →
 * PIN-unlock (or a token refresh) and never touches OTP-verify, which left the app with
 * no pending state, hence no banner and no way to reach "cancel" for the rest of the
 * grace — unhonoring the shipped "kabhi bhi cancel kar sakte hain" copy and ruling (a)'s
 * persistent banner. /auth/me is reachable from every entry path (post-unlock,
 * post-refresh, resume-from-background, settings open) and is a RE-READ, so it also stays
 * correct when the state changes mid-session or on another device — which a login-time
 * snapshot cannot.
 */
export interface MeResponse {
  worker_id: string;
  status: string;
  /**
   * ISO-8601 UTC instant at which the scheduled hard-delete becomes due (ADR-0031).
   *
   * PRESENT ONLY while a deletion is pending; OMITTED entirely otherwise — never `null`,
   * so there is no null-vs-absent ambiguity for the client: `deletion_scheduled_for` in
   * the body ⇔ a deletion is pending. Never fabricated/defaulted — the value is exactly
   * `workers.deletion_scheduled_at`. PII-free: an instant, no phone/name/hash.
   */
  deletion_scheduled_for?: string;
}
