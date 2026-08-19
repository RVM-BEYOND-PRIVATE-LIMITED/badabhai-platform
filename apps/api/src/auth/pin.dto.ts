import { z } from "zod";
import { e164PhoneSchema } from "@badabhai/validators";
import { DeviceInfoSchema } from "./devices.dto";
import type { LoginResponse } from "./auth.dto";

/**
 * Zod DTOs for the device-bound PIN endpoints (ADR-0026 Phase 3).
 *
 * The `pin` regex accepts a 4-8 digit RANGE at the boundary; the SERVICE enforces the
 * EXACT configured PIN_LENGTH plus the weak-PIN denylist (so length policy lives in one
 * place — config — not split between the wire schema and the service). `refresh_token` is
 * the device-bound credential for /verify (NO worker_auth guard there — the token in the
 * body IS the credential, exactly like POST /auth/token/refresh). `phone` reuses the shared
 * e164 schema; the OTP regex mirrors the existing OtpVerifySchema (4-8 digits).
 *
 * PRIVACY: identity for /verify is ALWAYS derived from the refresh token server-side; there
 * is deliberately NO worker_id field anywhere here (CLAUDE.md §2 — never trust a body id for
 * authz). The PIN never enters an event/log.
 */

/** 4-8 digits at the wire; the service pins the exact PIN_LENGTH + runs the denylist. */
const pinSchema = z.string().regex(/^\d{4,8}$/, "PIN must be 4-8 digits");

/** Body of POST /auth/pin/set — set/replace the PIN for the authenticated worker. */
export const PinSetSchema = z.object({
  pin: pinSchema,
});
export type PinSetDto = z.infer<typeof PinSetSchema>;

/**
 * Body of POST /auth/pin/verify — the device-bound refresh token (the credential) + the
 * PIN. `device_id` is OPTIONAL and advisory only: identity + the trusted device are both
 * resolved from the refresh token server-side, never from this field (defense-in-depth).
 */
export const PinVerifySchema = z.object({
  refresh_token: z.string().min(1, "refresh_token is required"),
  pin: pinSchema,
  device_id: z.string().min(1).optional(),
});
export type PinVerifyDto = z.infer<typeof PinVerifySchema>;

/** Body of POST /auth/pin/reset/request — send an OTP to the phone to start a PIN reset. */
export const PinResetRequestSchema = z.object({
  phone: e164PhoneSchema,
});
export type PinResetRequestDto = z.infer<typeof PinResetRequestSchema>;

/**
 * Body of POST /auth/pin/reset/confirm — verify the OTP and set the new PIN.
 *
 * `device_info` is ADDITIVE + OPTIONAL (#994) and mirrors {@link OtpVerifySchema}'s field
 * exactly. It is NOT cosmetic: the reset now mints a session, and PIN unlock is
 * DEVICE-BOUND — `PinService.verifyPin` refuses any refresh token that resolves without a
 * `deviceId`. A reset that minted an UNBOUND session would hand the worker a session they
 * could not later unlock with the PIN they just set, i.e. the same loop this endpoint is
 * being fixed to break, one cold start later. A client that omits it still resets fine and
 * still gets a session — it just has to OTP again on the next cold start, exactly as
 * omitting `device_info` on /auth/otp/verify already behaves.
 */
export const PinResetConfirmSchema = z.object({
  phone: e164PhoneSchema,
  otp: z.string().regex(/^\d{4,8}$/, "OTP must be 4-8 digits"),
  pin: pinSchema,
  device_info: DeviceInfoSchema.optional(),
});
export type PinResetConfirmDto = z.infer<typeof PinResetConfirmSchema>;

/**
 * Response of POST /auth/pin/reset/confirm (#994 — the route was 204 No Content).
 *
 * DELIBERATELY the byte-identical {@link LoginResponse} that POST /auth/otp/verify returns,
 * not a near-miss of it: the client can feed this to the SAME session parser/persist path it
 * already runs after an OTP login, and a reset therefore recovers a worker whose stored
 * refresh token is dead. `pin_set` is true (this request just wrote it) and `is_new_worker`
 * is false (the worker was resolved by phone hash before the write).
 *
 * BACK-COMPAT (§10): purely ADDITIVE at the wire. 204→200 keeps the response 2xx, and the
 * shipped client checks only 2xx-ness on this route (`auth_api.dart: _check`) — an old build
 * ignores the new body, a new build consumes it.
 */
export type PinResetConfirmResponse = LoginResponse;

/**
 * Response of POST /auth/pin/verify on SUCCESS — the SAME login-shape session the OTP path
 * returns (access + rotating refresh + session block). On any failure the controller throws
 * a neutral 401 with no body (no oracle). Mirrors LoginResponse minus the OTP-only fields
 * (is_new_worker / status are not meaningful for a PIN unlock of an existing worker).
 */
export interface PinVerifyResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in_seconds: number;
  worker_id: string;
  refresh_token: string;
  refresh_expires_in_seconds: number;
  session: {
    tier: number;
    expires_at: string;
    requires_otp_after: string | null;
  };
  // TD62 — ADDITIVE + OPTIONAL: does this worker hold an ACTIVE (non-revoked) DPDP
  // consent? Mirrors LoginResponse.consent_accepted so a PIN unlock routes the
  // never-onboarded worker to /consent, not the shell. Derived from the consent row
  // the A5 gate already fetched on the success path — no extra query, never PII.
  // OPTIONAL for contract symmetry with LoginResponse (review F1). NOTE the PIN path
  // has no post-commit failure mode: the A5 consent read runs BEFORE the session is
  // minted (a blip fails the unlock before anything is consumed — the PIN is freely
  // retryable, no OTP is burned), and this field reuses that already-fetched row, so
  // the service always sets it on success.
  consent_accepted?: boolean;
}
