import { HttpException, HttpStatus } from "@nestjs/common";
import type { OtpSendFailureReason } from "@badabhai/event-schema";

/**
 * A REAL Fast2SMS send failed at the provider boundary (F4, #168) — the worker-OTP
 * path's only send path. Mirrors the {@link import("./otp-send-cap").OtpSendCapExceededException}
 * pattern: OtpService throws this tagged exception in place of the plain 502 so the
 * orchestrating AuthService can emit the PII-free `worker.otp_send_failed` monitoring
 * event ONCE, then let the SAME neutral 502 the send-failure path already returned
 * reach the client — no new oracle, no response change.
 *
 * RESPONSE PARITY: same status + copy as the previous plain send-failure 502.
 * The carried {@link failure} metadata is AGGREGATE / PII-FREE (the provider literal +
 * the failure-kind enum ONLY — never a phone, hash, code, HTTP status, or free text).
 * A provider-misconfig error is deliberately NOT tagged (it stays the plain 502): that
 * is a boot/deploy defect, not a delivery anomaly the event-spine watch should count.
 */
export interface OtpSendFailure {
  /** The only worker-SMS provider (pinned literal in the event payload schema). */
  readonly provider: "fast2sms";
  /** How the send failed: transport | http_error | provider_rejected. */
  readonly reason: OtpSendFailureReason;
}

/** The neutral message a failed send surfaces (unchanged from the plain 502 path). */
export const OTP_SEND_FAILED_MESSAGE = "Could not send the code, please retry";

export class OtpSendFailedException extends HttpException {
  constructor(public readonly failure: OtpSendFailure) {
    super(OTP_SEND_FAILED_MESSAGE, HttpStatus.BAD_GATEWAY);
  }
}
