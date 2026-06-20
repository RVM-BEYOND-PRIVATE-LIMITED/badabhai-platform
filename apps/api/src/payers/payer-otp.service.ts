import { HttpException, HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { randomInt, timingSafeEqual } from "node:crypto";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";
import { PAYER_LOGIN_CHANNEL, type PayerLoginChannel } from "./payer-login-channel";

/** Minimal typed view of the raw Redis commands the OTP flow needs (same as OtpService). */
interface RedisOtpClient {
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  exists(key: string): Promise<number>;
}

/** What an issue resolves to: the cooldown + (dev/test mock only) the echoed code. */
export interface PayerOtpIssued {
  resendInSeconds: number;
  /** DEV/TEST + MOCK-channel ONLY echo of the code (never in staging/prod / real channel). */
  devCode?: string;
}

/**
 * Issues + verifies one-time PAYER login codes — the payer analogue of the worker
 * {@link import("../auth/otp.service").OtpService}, with the SAME security invariants
 * (XB-H auth hardening):
 *   - the code is NEVER logged / stored in plaintext — only its keyed HMAC lives in Redis;
 *   - verification is constant-time (timingSafeEqual over equal-length buffers);
 *   - single-use: a successful verify deletes the code + attempt counter;
 *   - FAIL CLOSED: any Redis error rejects (503) rather than allowing a login;
 *   - per-account resend cooldown + hourly send cap (reusing the OTP_* knobs);
 *   - NO user-enumeration oracle: verify returns ONE message for both "no code on file"
 *     and "wrong code", AND {@link issueWithoutDelivery} lets the caller run the IDENTICAL
 *     reserve (cooldown/cap/store) path for a NON-existent account so its observable
 *     timing/response matches an existing one (the caller delivers only when the account
 *     exists and swallows a delivery failure to the same neutral response).
 *
 * Keyed on the email's keyed HMAC (`emailHash`) — never the raw email. Redis namespace is
 * `payer_otp:*`, DISTINCT from the worker `otp:*` namespace, so the two never collide.
 */
@Injectable()
export class PayerOtpService {
  private readonly logger = new Logger(PayerOtpService.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly pii: PiiCryptoService,
    @Inject(PAYER_LOGIN_CHANNEL) private readonly channel: PayerLoginChannel,
    @InjectQueue(RESUME_RENDER_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Reserve + deliver a code (an EXISTING account). Stores the code's HMAC keyed by
   * `emailHash`, then delivers via the active channel. Throws 429 (cooldown / hourly cap),
   * 502 (delivery failed), or 503 (Redis down — fail closed). The caller swallows the 502
   * to the neutral response so a delivery failure is not an existence oracle.
   */
  async issueAndSend(input: {
    emailHash: string;
    email: string;
    phone: string | null;
    payerId: string;
  }): Promise<PayerOtpIssued> {
    const { emailHash } = input;
    const hashPrefix = emailHash.slice(0, 8);
    const redis = await this.client();
    try {
      const code = await this.reserve(emailHash, redis);
      try {
        await this.channel.deliver({
          code,
          email: input.email,
          phone: input.phone,
          payerId: input.payerId,
        });
      } catch (sendErr) {
        await redis.del(PayerOtpService.codeKey(emailHash)).catch(() => undefined);
        // NEVER log the email/phone/code — only the email-hash prefix + reason class.
        this.logger.error(
          `payer login code delivery failed email_hash=${hashPrefix} method=${this.channel.method} reason=${
            sendErr instanceof Error ? sendErr.message : String(sendErr)
          }`,
        );
        throw new HttpException("Could not send the code, please retry", HttpStatus.BAD_GATEWAY);
      }
      this.logger.log(`payer login code issued email_hash=${hashPrefix} method=${this.channel.method}`);
      return this.issued(code);
    } catch (err) {
      throw this.mapFailClosed(err, hashPrefix);
    }
  }

  /**
   * Reserve a code WITHOUT delivering it — used ONLY for a non-existent account so the
   * cooldown/hourly-cap/store path (and thus the observable timing + 429 behavior + the
   * dev/test echo) is IDENTICAL to an existing account. The reserved code is never sent
   * and can only ever resolve to "incorrect or expired" on verify (no account → no
   * session). Throws 429 / 503 exactly as the existing-account path does (existence-
   * independent), so neither is an enumeration oracle.
   */
  async issueWithoutDelivery(emailHash: string): Promise<PayerOtpIssued> {
    const hashPrefix = emailHash.slice(0, 8);
    const redis = await this.client();
    try {
      const code = await this.reserve(emailHash, redis);
      return this.issued(code);
    } catch (err) {
      throw this.mapFailClosed(err, hashPrefix);
    }
  }

  /**
   * Verify a submitted code for `emailHash`. Resolves on success (and deletes the code,
   * single-use); throws 401 (wrong/expired/no-code-on-file — ONE message, no enumeration),
   * 429 (too many attempts), or 503 (Redis down — fail closed). Constant-time compare.
   */
  async verify(emailHash: string, code: string): Promise<void> {
    const hashPrefix = emailHash.slice(0, 8);
    const redis = await this.client();

    const codeKey = PayerOtpService.codeKey(emailHash);
    const attemptsKey = PayerOtpService.attemptsKey(emailHash);
    const cooldownKey = PayerOtpService.cooldownKey(emailHash);

    // ONE rejection message for "no code on file" AND "wrong code" so a caller cannot use
    // the response to tell whether an account/code exists (enumeration oracle; XB-H).
    const INVALID = "Incorrect or expired code";

    try {
      const storedHmac = await redis.get(codeKey);
      if (!storedHmac) {
        // Flatten timing: equivalent HMAC + constant-time compare on a dummy.
        const dummy = Buffer.from(this.pii.hmac(code), "utf8");
        timingSafeEqual(dummy, dummy);
        throw new HttpException(INVALID, HttpStatus.UNAUTHORIZED);
      }

      const attempts = await redis.incr(attemptsKey);
      await redis.expire(attemptsKey, this.config.OTP_TTL_SECONDS);
      if (attempts > this.config.OTP_MAX_ATTEMPTS) {
        await redis.del(codeKey, attemptsKey);
        throw new HttpException("Too many attempts, request a new code", HttpStatus.TOO_MANY_REQUESTS);
      }

      const submitted = Buffer.from(this.pii.hmac(code), "utf8");
      const stored = Buffer.from(storedHmac, "utf8");
      const ok = submitted.length === stored.length && timingSafeEqual(submitted, stored);
      if (!ok) throw new HttpException(INVALID, HttpStatus.UNAUTHORIZED);

      // Success → single-use: delete code, attempts, and the resend cooldown.
      await redis.del(codeKey, attemptsKey, cooldownKey);
      this.logger.log(`payer login code verified email_hash=${hashPrefix} status=ok`);
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.error(
        `payer OTP verify Redis error email_hash=${hashPrefix}; failing closed (reason: ${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      throw new HttpException(
        "This is temporarily unavailable; please retry shortly",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  // ---------------------------------------------------------------------------

  /**
   * The shared reserve: cooldown check → hourly cap → generate + store the code HMAC →
   * reset attempts → arm the resend cooldown. Returns the plaintext code. Throws 429 on
   * cooldown/cap; lets Redis errors propagate (the caller maps them to 503).
   */
  private async reserve(emailHash: string, redis: RedisOtpClient): Promise<string> {
    const codeKey = PayerOtpService.codeKey(emailHash);
    const attemptsKey = PayerOtpService.attemptsKey(emailHash);
    const cooldownKey = PayerOtpService.cooldownKey(emailHash);

    if ((await redis.exists(cooldownKey)) > 0) {
      throw new HttpException(
        "Please wait before requesting another code",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const hour = PayerOtpService.utcHourStamp();
    const sendCountKey = PayerOtpService.sendCountKey(emailHash, hour);
    const sends = await redis.incr(sendCountKey);
    await redis.expire(sendCountKey, PayerOtpService.secondsUntilEndOfUtcHour());
    if (sends > this.config.OTP_MAX_SENDS_PER_HOUR) {
      throw new HttpException(
        "Too many codes requested; please try again later",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const code = PayerOtpService.generateCode(this.config.OTP_LENGTH);
    await redis.set(codeKey, this.pii.hmac(code), "EX", this.config.OTP_TTL_SECONDS);
    await redis.del(attemptsKey);
    await redis.set(cooldownKey, "1", "EX", this.config.OTP_RESEND_COOLDOWN_SECONDS);
    return code;
  }

  /** Shape the success return + the DEV/TEST + MOCK-channel ONLY echo (mirrors OtpService). */
  private issued(code: string): PayerOtpIssued {
    const echo = this.channel.mock && this.isDevOrTest();
    return {
      resendInSeconds: this.config.OTP_RESEND_COOLDOWN_SECONDS,
      ...(echo ? { devCode: code } : {}),
    };
  }

  /** Re-raise explicit HTTP decisions; map anything else (Redis/transport) to 503 (fail closed). */
  private mapFailClosed(err: unknown, hashPrefix: string): HttpException {
    if (err instanceof HttpException) return err;
    this.logger.error(
      `payer OTP issue Redis error email_hash=${hashPrefix}; failing closed (reason: ${
        err instanceof Error ? err.message : String(err)
      })`,
    );
    return new HttpException(
      "This is temporarily unavailable; please retry shortly",
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  private isDevOrTest(): boolean {
    return this.config.NODE_ENV === "development" || this.config.NODE_ENV === "test";
  }

  private async client(): Promise<RedisOtpClient> {
    return (await this.queue.client) as unknown as RedisOtpClient;
  }

  /** Cryptographically-random zero-padded numeric code, no modulo bias. */
  private static generateCode(length: number): string {
    let code = "";
    for (let i = 0; i < length; i += 1) code += String(randomInt(0, 10));
    return code;
  }

  private static codeKey(emailHash: string): string {
    return `payer_otp:code:${emailHash}`;
  }
  private static attemptsKey(emailHash: string): string {
    return `payer_otp:attempts:${emailHash}`;
  }
  private static cooldownKey(emailHash: string): string {
    return `payer_otp:cooldown:${emailHash}`;
  }
  private static sendCountKey(emailHash: string, hour: string): string {
    return `payer_otp:sendcount:${emailHash}:${hour}`;
  }

  /** UTC hour stamp `YYYYMMDDHH`. */
  private static utcHourStamp(now: Date = new Date()): string {
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, "0");
    const d = String(now.getUTCDate()).padStart(2, "0");
    const h = String(now.getUTCHours()).padStart(2, "0");
    return `${y}${m}${d}${h}`;
  }

  /** Seconds remaining until the end of the current UTC hour (+1 to round up). */
  private static secondsUntilEndOfUtcHour(now: Date = new Date()): number {
    const endOfHour = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours() + 1,
      0,
      0,
      0,
    );
    return Math.max(1, Math.ceil((endOfHour - now.getTime()) / 1000));
  }
}
