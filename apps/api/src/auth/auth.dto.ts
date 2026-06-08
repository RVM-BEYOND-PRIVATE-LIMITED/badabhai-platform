import { z } from "zod";
import { e164PhoneSchema } from "@badabhai/validators";

export const OtpRequestSchema = z.object({
  phone: e164PhoneSchema,
});
export type OtpRequestDto = z.infer<typeof OtpRequestSchema>;

export const OtpVerifySchema = z.object({
  phone: e164PhoneSchema,
  otp: z.string().regex(/^\d{4,6}$/, "OTP must be 4-6 digits"),
});
export type OtpVerifyDto = z.infer<typeof OtpVerifySchema>;
