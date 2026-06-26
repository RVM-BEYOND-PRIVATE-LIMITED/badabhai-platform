import { HttpException, HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { randomInt, timingSafeEqual } from "node:crypto";
import type { ServerConfig } from "@badabhai/config";
import { isRealOtpSmsActive } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { PiiCryptoService } from "../common/pii-crypto.service";
import {
  OtpSendCapExceededException,
  secondsUntilEndOfUtcDay,
  utcDayStamp,
} from "../common/otp-send-cap";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";
import { SMS_PROVIDER, type SmsProvider } from "../sms/sms.provider";

/**
 * Minimal typed view of the raw Redis commands the OTP flow needs. BullMQ's
 * IRedisClient doesn't declare these, but the runtime client is ioredis which
 * does (same idiom as IpRateLimit's RedisCounter).
 */
interface RedisOtpClient {
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  exists(key: string): Promise<number>;
}

/**
 * Issues + verifies one-time login codes.
 *
 * SECURITY INVARIANTS:
 *   - The OTP code is NEVER logged and NEVER stored in plaintext — only its keyed
 *     HMAC (PiiCryptoService.hmac, same server pepper) lives in Redis.
 *   - Verification is constant-time (timingSafeEqual over equal-length buffers).
 *   - Single-use: a successful verify deletes the code + attempt counter.
 *   - FAIL CLOSED: any Redis error rejects (503) rather than allowing a login.
 *   - Per-phone resend cooldown + hourly send cap throttle abuse (the per-IP cap
 *     is enforced separately by IpRateLimit in the controller).
 *
 * Redis keys (all namespaced under `otp:`):
 *   otp:code:<phoneHash>      HMAC of the code         TTL = OTP_TTL_SECONDS
 *   otp:attempts:<phoneHash>  verify-attempt counter   TTL = OTP_TTL_SECONDS
 *   otp:cooldown:<phoneHash>  resend cooldown marker    TTL = OTP_RESEND_COOLDOWN_SECONDS
 *   otp:sendcount:<phoneHash>:<utcHour>  hourly sends   TTL = to end of UTC hour
 *   otp:global_sendcount:<utcDay>  global daily REAL sends  TTL = to end of UTC day
 *
 * OTP-5 GLOBAL DAILY SEND CIRCUIT-BREAKER (the spend ceiling): in addition to the
 * per-phone cooldown/cap above, a platform-wide daily ceiling on REAL Fast2SMS sends
 * (OTP_GLOBAL_MAX_SENDS_PER_DAY) bounds total spend so a distributed abuser rotating
 * phones/IPs still cannot run up the bill. It is enforced ONLY when the SMS provider is
 * REAL (fast2sms) — in console/mock mode it is a no-op (no spend). Fail-closed (a Redis
 * error on the global counter rejects). A cap of 0 = PAUSED = the worker-SMS kill-switch
 * (instant halt + a PII-free worker.otp_send_cap_exceeded breach event, no redeploy).
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly pii: PiiCryptoService,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
    // Reuse BullMQ's existing Redis connection — do NOT add a second client.
    @InjectQueue(RESUME_RENDER_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Generate a fresh code, store its HMAC, and send it. Returns the cooldown the
   * client must wait before requesting another. Throws 429 (cooldown / hourly
   * cap), 502 (send failed), or 503 (Redis down — fail closed).
   */
  async issueAndSend(
    phoneE164: string,
  ): Promise<{ resendInSeconds: number; devCode?: string }> {
    const phoneHash = this.pii.hashPhone(phoneE164);
    const hashPrefix = phoneHash.slice(0, 8);
    const redis = await this.client();

    const codeKey = OtpService.codeKey(phoneHash);
    const attemptsKey = OtpService.attemptsKey(phoneHash);
    const cooldownKey = OtpService.cooldownKey(phoneHash);

    try {
      // 2. Resend cooldown.
      if ((await redis.exists(cooldownKey)) > 0) {
        throw new HttpException(
          "Please wait before requesting another code",
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      // 3. Hourly send cap (per phone). INCR + (re-)set TTL to end of UTC hour.
      const hour = OtpService.utcHourStamp();
      const sendCountKey = OtpService.sendCountKey(phoneHash, hour);
      const sends = await redis.incr(sendCountKey);
      await redis.expire(sendCountKey, OtpService.secondsUntilEndOfUtcHour());
      if (sends > this.config.OTP_MAX_SENDS_PER_HOUR) {
        throw new HttpException(
          "Too many codes requested; please try again later",
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      // 4. Generate a cryptographically-random numeric code (no modulo bias).
      const code = OtpService.generateCode(this.config.OTP_LENGTH);

      // 5. Store the HMAC (never plaintext), reset attempts, arm the cooldown.
      await redis.set(codeKey, this.pii.hmac(code), "EX", this.config.OTP_TTL_SECONDS);
      await redis.del(attemptsKey);
      await redis.set(cooldownKey, "1", "EX", this.config.OTP_RESEND_COOLDOWN_SECONDS);

      // 5b. GLOBAL DAILY SEND CIRCUIT-BREAKER (OTP-5 spend ceiling). REAL provider ONLY —
      // count REAL sends, at the point a real send is about to occur. On breach (count
      // reaches the cap, which includes the cap=0 paused/kill-switch case) do NOT send,
      // roll back the reserved code, and throw the SAME neutral 429 the throttle uses
      // (no new oracle) — tagged so the caller emits the PII-free breach event once.
      if (isRealOtpSmsActive(this.config)) {
        await this.assertWithinGlobalDailyCap(redis, codeKey);
      }

      // 6. Send. On failure, delete the code so a failed send leaves no dangling code.
      try {
        await this.sms.sendOtp({ phoneE164, code });
      } catch (sendErr) {
        await redis.del(codeKey).catch(() => undefined);
        this.logger.error(
          `OTP send failed phone_hash=${hashPrefix} reason=${
            sendErr instanceof Error ? sendErr.message : String(sendErr)
          }`,
        );
        throw new HttpException(
          "Could not send the code, please retry",
          HttpStatus.BAD_GATEWAY,
        );
      }

      this.logger.log(`OTP requested phone_hash=${hashPrefix} status=sent`);
      // DEV/TEST ONLY: echo the code back to the caller when the console provider is
      // active. assertAuthConfig forbids SMS_PROVIDER=console outside development/test
      // (boot fails otherwise), so this can never leak in staging/prod — and in console
      // mode the code is already printed to the log by ConsoleSmsProvider, so this adds
      // no new exposure. Lets the e2e harness complete login without log-scraping.
      const devCode =
        this.config.SMS_PROVIDER === "console" ? { devCode: code } : undefined;
      return { resendInSeconds: this.config.OTP_RESEND_COOLDOWN_SECONDS, ...devCode };
    } catch (err) {
      // Re-raise explicit HTTP decisions (cooldown/cap/send-failure).
      if (err instanceof HttpException) throw err;
      // Anything else is a Redis/transport failure → FAIL CLOSED.
      this.logger.error(
        `OTP issue Redis error phone_hash=${hashPrefix}; failing closed (reason: ${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      throw new HttpException(
        "This is temporarily unavailable; please retry shortly",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  /**
   * Verify a submitted code. Resolves on success (and deletes the code, making it
   * single-use); throws 401 (wrong/expired), 429 (too many attempts), or 503
   * (Redis down — fail closed). Comparison is constant-time.
   */
  async verify(phoneE164: string, code: string): Promise<void> {
    const phoneHash = this.pii.hashPhone(phoneE164);
    const hashPrefix = phoneHash.slice(0, 8);
    const redis = await this.client();

    const codeKey = OtpService.codeKey(phoneHash);
    const attemptsKey = OtpService.attemptsKey(phoneHash);
    const cooldownKey = OtpService.cooldownKey(phoneHash);

    // ONE rejection message for both "no code on file" and "wrong code" so a caller
    // cannot use the response to tell whether a code was ever requested for a number
    // (enumeration oracle). "Too many attempts" stays distinct (it only fires after
    // repeated guesses against an existing code — already rate-limit behavior).
    const INVALID = "Incorrect or expired code";

    try {
      const storedHmac = await redis.get(codeKey);
      if (!storedHmac) {
        // Do an equivalent HMAC + constant-time compare on a dummy so the no-code
        // path costs roughly the same as the wrong-code path (flatten timing).
        const dummy = Buffer.from(this.pii.hmac(code), "utf8");
        timingSafeEqual(dummy, dummy);
        throw new HttpException(INVALID, HttpStatus.UNAUTHORIZED);
      }

      // Count this attempt; mirror the code TTL so the counter expires with it.
      const attempts = await redis.incr(attemptsKey);
      await redis.expire(attemptsKey, this.config.OTP_TTL_SECONDS);
      if (attempts > this.config.OTP_MAX_ATTEMPTS) {
        await redis.del(codeKey, attemptsKey);
        throw new HttpException(
          "Too many attempts, request a new code",
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      // Constant-time compare. Equal-length guard FIRST so timingSafeEqual never
      // throws on a length mismatch (which would itself be a timing signal).
      const submitted = Buffer.from(this.pii.hmac(code), "utf8");
      const stored = Buffer.from(storedHmac, "utf8");
      const ok = submitted.length === stored.length && timingSafeEqual(submitted, stored);
      if (!ok) {
        throw new HttpException(INVALID, HttpStatus.UNAUTHORIZED);
      }

      // Success → single-use: delete code, attempts, and the resend cooldown.
      await redis.del(codeKey, attemptsKey, cooldownKey);
      this.logger.log(`OTP verified phone_hash=${hashPrefix} status=ok`);
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.error(
        `OTP verify Redis error phone_hash=${hashPrefix}; failing closed (reason: ${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      throw new HttpException(
        "This is temporarily unavailable; please retry shortly",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  /**
   * GLOBAL daily send circuit-breaker (OTP-5). INCR the platform-wide daily counter
   * (re-asserting its TTL to the end of the UTC day on every hit) and, when it reaches
   * OTP_GLOBAL_MAX_SENDS_PER_DAY, refuse the real send: roll back the just-reserved code
   * and throw an {@link OtpSendCapExceededException} (the neutral 429). A Redis error
   * propagates to the outer fail-closed handler (503) — it NEVER uncaps. `count >= cap`
   * (not `>`) so a cap of 0 blocks the FIRST send (the kill-switch).
   */
  private async assertWithinGlobalDailyCap(redis: RedisOtpClient, codeKey: string): Promise<void> {
    const day = utcDayStamp();
    const key = OtpService.globalSendCountKey(day);
    const count = await redis.incr(key);
    await redis.expire(key, secondsUntilEndOfUtcDay());
    if (count >= this.config.OTP_GLOBAL_MAX_SENDS_PER_DAY) {
      // Refuse the send → leave no dangling reserved code (mirrors the send-failure cleanup).
      await redis.del(codeKey).catch(() => undefined);
      this.logger.warn(
        `OTP global daily send cap reached (worker_sms) limit=${this.config.OTP_GLOBAL_MAX_SENDS_PER_DAY} day=${day}; refusing real send`,
      );
      throw new OtpSendCapExceededException({
        channel: "worker_sms",
        limit: this.config.OTP_GLOBAL_MAX_SENDS_PER_DAY,
        window: day,
      });
    }
  }

  private async client(): Promise<RedisOtpClient> {
    return (await this.queue.client) as unknown as RedisOtpClient;
  }

  /** Cryptographically-random zero-padded numeric code, no modulo bias. */
  private static generateCode(length: number): string {
    let code = "";
    for (let i = 0; i < length; i += 1) {
      code += String(randomInt(0, 10)); // [0,10) — uniform per digit
    }
    return code;
  }

  private static codeKey(phoneHash: string): string {
    return `otp:code:${phoneHash}`;
  }
  private static attemptsKey(phoneHash: string): string {
    return `otp:attempts:${phoneHash}`;
  }
  private static cooldownKey(phoneHash: string): string {
    return `otp:cooldown:${phoneHash}`;
  }
  private static sendCountKey(phoneHash: string, hour: string): string {
    return `otp:sendcount:${phoneHash}:${hour}`;
  }
  /** Global daily REAL-send counter (OTP-5 spend ceiling) — NOT keyed by phone. */
  private static globalSendCountKey(day: string): string {
    return `otp:global_sendcount:${day}`;
  }

  /** UTC hour stamp `YYYYMMDDHH` (key namespace + rolling window). */
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
