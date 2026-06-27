import { HttpException, HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { randomInt, timingSafeEqual } from "node:crypto";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";

/** Minimal typed view of the raw Redis commands the OTP flow needs. */
interface RedisOtpClient {
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  exists(key: string): Promise<number>;
}

export interface AdminOtpIssued {
  resendInSeconds: number;
}

/**
 * Issues + verifies one-time ADMIN login codes (ADR-0025 ADMIN-1) — the admin analogue of
 * {@link import("../payers/payer-otp.service").PayerOtpService}, with the SAME security
 * invariants (XB-H auth hardening):
 *   - the code is NEVER logged / stored in plaintext — only its keyed HMAC lives in Redis;
 *   - verification is constant-time (timingSafeEqual over equal-length buffers);
 *   - single-use: a successful verify deletes the code + attempt counter;
 *   - FAIL CLOSED: any Redis error rejects (503) rather than allowing a login;
 *   - per-account resend cooldown + hourly send cap (reusing the OTP_* knobs);
 *   - NO user-enumeration oracle: verify returns ONE message for both "no code on file" and
 *     "wrong code", AND {@link issueWithoutDelivery} runs the IDENTICAL reserve path for a
 *     NON-existent account so its timing/response matches an existing one.
 *
 * Keyed on the email's keyed HMAC (`emailHash`) — never the raw email. Redis namespace is
 * `admin_otp:*`, DISTINCT from `payer_otp:*`/worker `otp:*`, so the principals never collide.
 *
 * ADMIN-1 NOTE: email DELIVERY is a deferred stream (no real admin-email provider is wired
 * here). The code is reserved + stored (so verify works in dev/staging via the audit/seed
 * path) but the delivery side-effect is a no-op stub — the code is NEVER returned to the
 * client (real-only, no echo). Wiring a real admin email channel is a follow-up.
 */
@Injectable()
export class AdminOtpService {
  private readonly logger = new Logger(AdminOtpService.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly pii: PiiCryptoService,
    @InjectQueue(RESUME_RENDER_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Reserve a code for an EXISTING admin account (stores its HMAC keyed by `emailHash`).
   * In ADMIN-1 delivery is a stubbed no-op (deferred); the code is never returned. Throws
   * 429 (cooldown / hourly cap) or 503 (Redis down — fail closed).
   */
  async issueAndSend(emailHash: string): Promise<AdminOtpIssued> {
    const hashPrefix = emailHash.slice(0, 8);
    const redis = await this.client();
    try {
      await this.reserve(emailHash, redis);
      // Delivery is a deferred stream — never log/return the code. Record only the fact.
      this.logger.log(`admin login code issued email_hash=${hashPrefix} (delivery deferred)`);
      return this.issued();
    } catch (err) {
      throw this.mapFailClosed(err, hashPrefix);
    }
  }

  /**
   * Reserve a code WITHOUT delivering it — used ONLY for a non-existent account so the
   * cooldown/hourly-cap/store path (and thus the observable timing + 429 behavior) is
   * IDENTICAL to an existing account (no enumeration oracle, XB-H). The reserved code is
   * never sent and can only resolve to "incorrect or expired" on verify (no account → no
   * session). Throws 429 / 503 exactly as the existing-account path does.
   */
  async issueWithoutDelivery(emailHash: string): Promise<AdminOtpIssued> {
    const hashPrefix = emailHash.slice(0, 8);
    const redis = await this.client();
    try {
      await this.reserve(emailHash, redis);
      return this.issued();
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

    const codeKey = AdminOtpService.codeKey(emailHash);
    const attemptsKey = AdminOtpService.attemptsKey(emailHash);
    const cooldownKey = AdminOtpService.cooldownKey(emailHash);

    // ONE rejection message for "no code on file" AND "wrong code" (no enumeration oracle).
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
      this.logger.log(`admin login code verified email_hash=${hashPrefix} status=ok`);
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.error(
        `admin OTP verify Redis error email_hash=${hashPrefix}; failing closed (reason: ${
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
    const codeKey = AdminOtpService.codeKey(emailHash);
    const attemptsKey = AdminOtpService.attemptsKey(emailHash);
    const cooldownKey = AdminOtpService.cooldownKey(emailHash);

    if ((await redis.exists(cooldownKey)) > 0) {
      throw new HttpException(
        "Please wait before requesting another code",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const hour = AdminOtpService.utcHourStamp();
    const sendCountKey = AdminOtpService.sendCountKey(emailHash, hour);
    const sends = await redis.incr(sendCountKey);
    await redis.expire(sendCountKey, AdminOtpService.secondsUntilEndOfUtcHour());
    if (sends > this.config.OTP_MAX_SENDS_PER_HOUR) {
      throw new HttpException(
        "Too many codes requested; please try again later",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const code = AdminOtpService.generateCode(this.config.OTP_LENGTH);
    await redis.set(codeKey, this.pii.hmac(code), "EX", this.config.OTP_TTL_SECONDS);
    await redis.del(attemptsKey);
    await redis.set(cooldownKey, "1", "EX", this.config.OTP_RESEND_COOLDOWN_SECONDS);
    return code;
  }

  /** Shape the success return. The code is never returned (real-only, no echo). */
  private issued(): AdminOtpIssued {
    return { resendInSeconds: this.config.OTP_RESEND_COOLDOWN_SECONDS };
  }

  /** Re-raise explicit HTTP decisions; map anything else (Redis/transport) to 503 (fail closed). */
  private mapFailClosed(err: unknown, hashPrefix: string): HttpException {
    if (err instanceof HttpException) return err;
    this.logger.error(
      `admin OTP issue Redis error email_hash=${hashPrefix}; failing closed (reason: ${
        err instanceof Error ? err.message : String(err)
      })`,
    );
    return new HttpException(
      "This is temporarily unavailable; please retry shortly",
      HttpStatus.SERVICE_UNAVAILABLE,
    );
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
    return `admin_otp:code:${emailHash}`;
  }
  private static attemptsKey(emailHash: string): string {
    return `admin_otp:attempts:${emailHash}`;
  }
  private static cooldownKey(emailHash: string): string {
    return `admin_otp:cooldown:${emailHash}`;
  }
  private static sendCountKey(emailHash: string, hour: string): string {
    return `admin_otp:sendcount:${emailHash}:${hour}`;
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
