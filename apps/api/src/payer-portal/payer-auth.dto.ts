import { z } from "zod";
import { e164PhoneSchema } from "@badabhai/validators";
import type { PayerRole } from "@badabhai/db";

/**
 * Payer auth DTOs (ADR-0019 Decision B). The login identifier is an EMAIL (the keyed-hash
 * lookup key in `payers`); `role` mirrors `db.PayerRole` (`employer | agent` — the product
 * "Company / Agency" labels map onto these). Contact PII (email/phone/org-name) is the
 * B-R2 class: accepted here, encrypted at rest in `payers`, and NEVER echoed into an event.
 */

/** Account role at signup — mirrors the shipped `payers.role` enum. */
export const PayerRoleSchema = z.enum(["employer", "agent"]);

export const PayerSignupSchema = z.object({
  role: PayerRoleSchema,
  email: z.string().trim().toLowerCase().email().max(254),
  org_name: z.string().trim().min(1).max(200),
  // Optional at signup; REQUIRED to later log in via the `whatsapp` channel.
  phone: e164PhoneSchema.optional(),
});
export type PayerSignupDto = z.infer<typeof PayerSignupSchema>;

export const PayerLoginRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
});
export type PayerLoginRequestDto = z.infer<typeof PayerLoginRequestSchema>;

export const PayerLoginVerifySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  // 4-8 digits to match the configurable OTP_LENGTH (default 6).
  code: z.string().regex(/^\d{4,8}$/, "Code must be 4-8 digits"),
});
export type PayerLoginVerifyDto = z.infer<typeof PayerLoginVerifySchema>;

/**
 * Response of POST /payer/signup and POST /payer/login/request. DELIBERATELY identical and
 * account-state-INDEPENDENT (XB-H no-enumeration): a caller cannot tell from this whether
 * the email is new, already registered, or never seen. The code is delivered ONLY to the
 * payer's email via the real provider — it is NEVER returned here (real-only).
 */
export interface PayerAuthCodeResponse {
  status: "code_sent";
  resend_in_seconds: number;
}

/** Login payload returned by POST /payer/login/verify. */
export interface PayerSessionResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in_seconds: number;
  payer_id: string;
  role: PayerRole;
  is_new_payer: boolean;
}

/** Response of POST /payer/refresh. */
export interface PayerRefreshResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in_seconds: number;
}
