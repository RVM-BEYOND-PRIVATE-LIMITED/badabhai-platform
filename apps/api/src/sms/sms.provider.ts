import type { OtpSendFailureReason } from "@badabhai/event-schema";

/**
 * SMS delivery boundary for the OTP login flow.
 *
 * Implementations MUST NOT log the OTP code or the raw phone number — only a
 * short prefix of the phone HASH plus a status, consistent with the no-raw-PII
 * invariant used across the codebase.
 *
 * `sendOtp` THROWS on a delivery failure so the OTP service can roll back the
 * issued code (a failed send must leave no dangling code in Redis). Delivery
 * failures are thrown as {@link SmsSendError} so the orchestrating auth flow can
 * emit the PII-free `worker.otp_send_failed` monitoring event (F4, #168).
 */
export interface SmsProvider {
  sendOtp(input: { phoneE164: string; code: string }): Promise<void>;
}

/** DI token for the active {@link SmsProvider} implementation. */
export const SMS_PROVIDER = "SMS_PROVIDER_IMPL";

/**
 * A REAL provider send failed (F4, #168). Carries ONLY the failure-kind enum from
 * `@badabhai/event-schema` (`transport` | `http_error` | `provider_rejected`) — the
 * `message` follows the same PII rules as every provider log line (never the code,
 * never the raw number). The reason is what the auth flow puts into the PII-free
 * `worker.otp_send_failed` event; a config error (provider not fully configured) is
 * deliberately NOT an SmsSendError — that is a boot/deploy defect, not a delivery
 * anomaly to alert on.
 */
export class SmsSendError extends Error {
  constructor(
    public readonly reason: OtpSendFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "SmsSendError";
  }
}
