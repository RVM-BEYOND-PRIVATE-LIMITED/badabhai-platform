import { HttpException, HttpStatus } from "@nestjs/common";
import type { OtpSendCapChannel } from "@badabhai/event-schema";

/**
 * The OTP-5 global daily SEND circuit-breaker (the spend ceiling) tripped — a REAL-send
 * was refused because the platform-wide daily real-send count reached the configured cap
 * (which includes the `cap=0` PAUSED / kill-switch case). Shared by the worker SMS
 * ({@link import("../auth/otp.service").OtpService}) and payer email
 * ({@link import("../payers/payer-otp.service").PayerOtpService}) paths.
 *
 * RESPONSE PARITY: this extends {@link HttpException} with the SAME neutral 429 the OTP
 * throttle path already returns, so to any caller a breach is indistinguishable from an
 * ordinary cooldown/cap throttle — NO new oracle. The carried {@link breach} metadata is
 * AGGREGATE / PII-FREE (channel + cap + limit + UTC-day window only — never a phone,
 * email, IP, code, or any account id) and exists solely so the orchestrating
 * auth/payer-auth service can emit the `*.otp_send_cap_exceeded` breach event ONCE, then
 * map back to the neutral response. The breaker is the ONLY thing that throws this — an
 * ordinary per-account cooldown/cap throws a plain HttpException, so the event fires
 * exactly on the GLOBAL breach and never on routine throttles.
 */
export interface OtpSendCapBreach {
  /** Which real-send path tripped (worker_sms | payer_email). */
  readonly channel: OtpSendCapChannel;
  /** The configured daily limit the breach was measured against (0 = paused). */
  readonly limit: number;
  /** The UTC-day stamp `YYYYMMDD` the breach happened on (never a timestamp/PII). */
  readonly window: string;
}

/** The neutral message a global-breaker breach surfaces (reuses the throttle copy). */
export const OTP_SEND_CAP_THROTTLE_MESSAGE =
  "Too many codes requested; please try again later";

export class OtpSendCapExceededException extends HttpException {
  constructor(public readonly breach: OtpSendCapBreach) {
    // Same status + neutral copy as the per-account hourly-cap throttle (no new oracle).
    super(OTP_SEND_CAP_THROTTLE_MESSAGE, HttpStatus.TOO_MANY_REQUESTS);
  }
}

/** UTC-day stamp `YYYYMMDD` — the global breaker's window namespace + event `window`. */
export function utcDayStamp(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

/** Seconds remaining until the end of the current UTC day (+1 to round up). */
export function secondsUntilEndOfUtcDay(now: Date = new Date()): number {
  const endOfDay = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );
  return Math.max(1, Math.ceil((endOfDay - now.getTime()) / 1000));
}
