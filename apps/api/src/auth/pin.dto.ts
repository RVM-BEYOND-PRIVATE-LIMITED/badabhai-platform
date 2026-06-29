import { z } from "zod";
import { e164PhoneSchema } from "@badabhai/validators";

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

/** Body of POST /auth/pin/reset/confirm — verify the OTP and set the new PIN. */
export const PinResetConfirmSchema = z.object({
  phone: e164PhoneSchema,
  otp: z.string().regex(/^\d{4,8}$/, "OTP must be 4-8 digits"),
  pin: pinSchema,
});
export type PinResetConfirmDto = z.infer<typeof PinResetConfirmSchema>;

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
}
