/**
 * SMS delivery boundary for the OTP login flow.
 *
 * Implementations MUST NOT log the OTP code or the raw phone number — only a
 * short prefix of the phone HASH plus a status, consistent with the no-raw-PII
 * invariant used across the codebase.
 *
 * `sendOtp` THROWS on a delivery failure so the OTP service can roll back the
 * issued code (a failed send must leave no dangling code in Redis).
 */
export interface SmsProvider {
  sendOtp(input: { phoneE164: string; code: string }): Promise<void>;
}

/** DI token for the active {@link SmsProvider} implementation. */
export const SMS_PROVIDER = "SMS_PROVIDER_IMPL";
