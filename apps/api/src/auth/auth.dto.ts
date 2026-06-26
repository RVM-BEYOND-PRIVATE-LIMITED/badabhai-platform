import { z } from "zod";
import { e164PhoneSchema } from "@badabhai/validators";

export const OtpRequestSchema = z.object({
  phone: e164PhoneSchema,
});
export type OtpRequestDto = z.infer<typeof OtpRequestSchema>;

export const OtpVerifySchema = z.object({
  phone: e164PhoneSchema,
  // Accept 4-8 digits to match the configurable OTP_LENGTH (default 6).
  otp: z.string().regex(/^\d{4,8}$/, "OTP must be 4-8 digits"),
});
export type OtpVerifyDto = z.infer<typeof OtpVerifySchema>;

/** Response of POST /auth/otp/request. The code is delivered ONLY to the worker's
 * phone via the real SMS provider — it is never returned here (real-only). */
export interface OtpRequestResponse {
  success: true;
  channel: string;
  resend_in_seconds: number;
}

/** Login payload returned by POST /auth/otp/verify. */
export interface LoginResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in_seconds: number;
  worker_id: string;
  is_new_worker: boolean;
  status: string;
}

/** Response of POST /auth/refresh. */
export interface RefreshResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in_seconds: number;
}

/** Response of GET /auth/me. */
export interface MeResponse {
  worker_id: string;
  status: string;
}
