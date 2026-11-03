import { z } from "zod";
import { e164PhoneSchema } from "@badabhai/validators";
import type { PayerRole } from "@badabhai/db";
import { PasswordPolicySchema } from "../common/password-policy";

/**
 * Payer auth DTOs (ADR-0019 Decision B). The login identifier is an EMAIL (the keyed-hash
 * lookup key in `payers`); `role` mirrors `db.PayerRole` (`employer | agent` — the product
 * "Company / Agency" labels map onto these). Contact PII (email/phone/org-name) is the
 * B-R2 class: accepted here, encrypted at rest in `payers`, and NEVER echoed into an event.
 */

/** Account role at signup — mirrors the shipped `payers.role` enum. */
export const PayerRoleSchema = z.enum(["employer", "agent"]);

export const PayerSignupSchema = z
  .object({
    role: PayerRoleSchema,
    // #2497 — email OR phone (at least one, enforced below): phone-only signup has
    // no email. The stored login key is whichever contact is supplied.
    email: z.string().trim().toLowerCase().email().max(254).optional(),
    org_name: z.string().trim().min(1).max(200),
    // Optional at signup; REQUIRED to later log in via the `whatsapp` channel.
    phone: e164PhoneSchema.optional(),
  })
  .refine((v) => v.email !== undefined || v.phone !== undefined, {
    message: "At least one of email/phone is required",
  });
export type PayerSignupDto = z.infer<typeof PayerSignupSchema>;

/**
 * #2497 — the OTP contact for login request/verify: the SAME email-or-phone shape as
 * signup (at least one). The OTP reserve/store key is the keyed hash of whichever
 * contact is supplied, so request and verify MUST carry the same contact.
 */
const PayerLoginContactSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254).optional(),
    phone: e164PhoneSchema.optional(),
  })
  .refine((v) => v.email !== undefined || v.phone !== undefined, {
    message: "At least one of email/phone is required",
  });

export const PayerLoginRequestSchema = PayerLoginContactSchema;
export type PayerLoginRequestDto = z.infer<typeof PayerLoginRequestSchema>;

export const PayerLoginVerifySchema = PayerLoginContactSchema.extend({
  // 4-8 digits to match the configurable OTP_LENGTH (default 6).
  code: z.string().regex(/^\d{4,8}$/, "Code must be 4-8 digits"),
});
export type PayerLoginVerifyDto = z.infer<typeof PayerLoginVerifySchema>;

/**
 * #2497 — `POST /payer/password/set` body. The SERVER is the policy authority (the
 * client mirrors): 8–128 chars with at least one letter and one digit — the ONE shared
 * {@link PasswordPolicySchema} (also the admin password door's, migration 0142).
 */
export const PayerPasswordSetSchema = z.object({
  password: PasswordPolicySchema,
});
export type PayerPasswordSetDto = z.infer<typeof PayerPasswordSetSchema>;

/**
 * #2497 — `POST /payer/login/password` body. `identifier` is, in order: a normalized
 * email, an E.164 phone, or the payer's exact org display name (trimmed,
 * case-insensitive). 320 chars covers the longest of the three with headroom;
 * `password` is bounded (never an unbounded KDF input) but NOT policy-checked here —
 * EVERY well-formed attempt burns one KDF verify (no short-password oracle).
 */
export const PayerPasswordLoginSchema = z.object({
  identifier: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(128),
});
export type PayerPasswordLoginDto = z.infer<typeof PayerPasswordLoginSchema>;

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

/**
 * Body for the test-login seam (Phase 2.1). Only an email — no code, no role, no org name: the
 * seam is not a signup API and must not become one. `.strict()` so an unexpected field is a 400
 * rather than a silently ignored attempt to influence the minted account.
 */
export const PayerTestLoginSchema = z
  .object({ email: z.string().email().max(320) })
  .strict();
export type PayerTestLoginDto = z.infer<typeof PayerTestLoginSchema>;
