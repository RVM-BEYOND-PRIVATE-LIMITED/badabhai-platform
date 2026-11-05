import { HttpException, HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { randomInt, timingSafeEqual } from "node:crypto";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { PiiCryptoService } from "../common/pii-crypto.service";
import {
  EmailNotificationService,
  type EmailPurpose,
} from "../notifications/email-notification.service";
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
 * WHY a code exists (migration 0144). Each purpose owns a DISJOINT Redis namespace, so a login
 * code can never redeem a password reset and a reset code can never sign anyone in — the code,
 * its attempt counter, its resend cooldown and its hourly cap are all per purpose.
 */
export type AdminOtpPurpose = "login" | "password_reset";

interface AdminOtpPurposeSpec {
  /** Redis key prefix. `login` keeps the pre-0144 `admin_otp` keys byte-for-byte. */
  readonly namespace: string;
  /** The log-line noun — closed vocabulary, never PII. */
  readonly logLabel: string;
  readonly emailPurpose: EmailPurpose;
  readonly compose: (code: string) => { subject: string; html: string; text: string };
}

const ADMIN_OTP_PURPOSES: Readonly<Record<AdminOtpPurpose, AdminOtpPurposeSpec>> = {
  login: {
    namespace: "admin_otp",
    logLabel: "admin login code",
    emailPurpose: "login_code",
    compose: (code) => ({
      subject: "Your BadaBhai admin login code",
      html: [
        "<p>Your BadaBhai <strong>admin</strong> login code is:</p>",
        `<p style="font-size:24px;font-weight:bold;letter-spacing:3px;">${code}</p>`,
        "<p>It expires shortly. If you did not request it, tell your security contact —",
        " someone has your admin address.</p>",
      ].join(""),
      text:
        `Your BadaBhai admin login code is ${code}. It expires shortly. ` +
        `If you did not request it, tell your security contact.`,
    }),
  },
  password_reset: {
    // `admin_otp_pwreset:*`, never `admin_otp:*` — the first segment differs, so no login key
    // (`admin_otp:code:<hash>`) can ever be read or written by the reset path.
    namespace: "admin_otp_pwreset",
    logLabel: "admin password reset code",
    emailPurpose: "password_reset",
    compose: (code) => ({
      subject: "Reset your BadaBhai admin password",
      html: [
        "<p>Your BadaBhai <strong>admin</strong> password reset code is:</p>",
        `<p style="font-size:24px;font-weight:bold;letter-spacing:3px;">${code}</p>`,
        "<p>It expires shortly. If you did not ask to reset your password, ignore this email —",
        " your password has not changed — and tell your security contact.</p>",
      ].join(""),
      text:
        `Your BadaBhai admin password reset code is ${code}. It expires shortly. ` +
        `If you did not ask to reset your password, ignore this email and tell your security contact.`,
    }),
  },
};

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
 * Migration 0144 adds a second PURPOSE, `password_reset`, under its own `admin_otp_pwreset:*`
 * namespace (see {@link AdminOtpPurpose}); every method defaults to `login`, whose keys, email
 * copy and log lines are unchanged.
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
    // ADR-0038 — the shared outbound pipeline. Admin was the one principal with no sender.
    private readonly email: EmailNotificationService,
  ) {}

  /**
   * Reserve a code for an EXISTING admin account (stores its HMAC keyed by `emailHash`) and
   * DELIVER it. Throws 429 (cooldown / hourly cap) or 503 (Redis down — fail closed).
   *
   * ADR-0038 — delivery is REAL now. Until this, the method reserved the code and logged
   * "delivery deferred": the code was never returned to the client (correctly — real-only,
   * no echo) and never sent, so it reached no human and NO ADMIN COULD EVER LOG IN. The
   * entire ADMIN-3a surface was complete and unreachable behind that one stub.
   *
   * ROLLBACK ON A FAILED SEND, mirroring the payer channel: a reserved code that was never
   * delivered is worse than no code — it is unusable to the admin (they never saw it) while
   * still occupying the cooldown, so a retry is refused for the cooldown window. Deleting it
   * lets them retry immediately.
   */
  async issueAndSend(
    emailHash: string,
    email: string,
    purpose: AdminOtpPurpose = "login",
  ): Promise<AdminOtpIssued> {
    const spec = ADMIN_OTP_PURPOSES[purpose];
    const hashPrefix = emailHash.slice(0, 8);
    const redis = await this.client();
    try {
      const code = await this.reserve(spec, emailHash, redis);
      try {
        await this.email.send({
          to: email,
          ...spec.compose(code),
          principal: "admin",
          purpose: spec.emailPurpose,
        });
      } catch (sendErr) {
        await redis.del(AdminOtpService.key(spec, "code", emailHash)).catch(() => undefined);
        // NEVER log the email or the code — the hash prefix + a reason class only.
        this.logger.error(`${spec.logLabel} delivery failed email_hash=${hashPrefix}`);
        throw sendErr;
      }
      this.logger.log(`${spec.logLabel} issued + sent email_hash=${hashPrefix}`);
      return this.issued();
    } catch (err) {
      throw this.mapFailClosed(err, hashPrefix);
    }
  }

  /**
   * Reserve a code for an EXISTING account and hand it to the mailer WITHOUT waiting for the
   * provider (security review SHOULD-FIX — the forgot-password door).
   *
   * {@link issueAndSend} awaits the provider round-trip, which only a REAL account ever pays, so
   * its latency told a prober which emails are admins. Here the response waits for exactly what
   * the unknown-account path ({@link issueWithoutDelivery}) waits for — the reserve, with the same
   * 429s and 503s — and delivery is scheduled for the NEXT macrotask, after the response has been
   * written. A failed send is logged (hash prefix only) and the code STAYS reserved: the admin
   * asks again once the resend cooldown passes.
   */
  async issueAndDispatch(
    emailHash: string,
    email: string,
    purpose: AdminOtpPurpose,
  ): Promise<AdminOtpIssued> {
    const spec = ADMIN_OTP_PURPOSES[purpose];
    const hashPrefix = emailHash.slice(0, 8);
    const redis = await this.client();
    let code: string;
    try {
      code = await this.reserve(spec, emailHash, redis);
    } catch (err) {
      throw this.mapFailClosed(err, hashPrefix);
    }
    setImmediate(() => this.deliverInBackground(spec, email, code, hashPrefix));
    return this.issued();
  }

  /** The detached half of {@link issueAndDispatch}. Never rejects; logs the outcome PII-free. */
  private deliverInBackground(
    spec: AdminOtpPurposeSpec,
    email: string,
    code: string,
    hashPrefix: string,
  ): void {
    Promise.resolve()
      .then(() =>
        this.email.send({
          to: email,
          ...spec.compose(code),
          principal: "admin",
          purpose: spec.emailPurpose,
        }),
      )
      .then(
        () => this.logger.log(`${spec.logLabel} issued + sent email_hash=${hashPrefix}`),
        () =>
          this.logger.error(
            `${spec.logLabel} delivery failed email_hash=${hashPrefix} (code stays reserved)`,
          ),
      )
      .catch(() => undefined);
  }

  /**
   * Reserve a code WITHOUT delivering it — used ONLY for a non-existent account so the
   * cooldown/hourly-cap/store path (and thus the observable timing + 429 behavior) is
   * IDENTICAL to an existing account (no enumeration oracle, XB-H). The reserved code is
   * never sent and can only resolve to "incorrect or expired" on verify (no account → no
   * session). Throws 429 / 503 exactly as the existing-account path does.
   */
  async issueWithoutDelivery(
    emailHash: string,
    purpose: AdminOtpPurpose = "login",
  ): Promise<AdminOtpIssued> {
    const hashPrefix = emailHash.slice(0, 8);
    const redis = await this.client();
    try {
      await this.reserve(ADMIN_OTP_PURPOSES[purpose], emailHash, redis);
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
  async verify(
    emailHash: string,
    code: string,
    purpose: AdminOtpPurpose = "login",
  ): Promise<void> {
    const spec = ADMIN_OTP_PURPOSES[purpose];
    const hashPrefix = emailHash.slice(0, 8);
    const redis = await this.client();

    const codeKey = AdminOtpService.key(spec, "code", emailHash);
    const attemptsKey = AdminOtpService.key(spec, "attempts", emailHash);
    const cooldownKey = AdminOtpService.key(spec, "cooldown", emailHash);

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
      this.logger.log(`${spec.logLabel} verified email_hash=${hashPrefix} status=ok`);
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
  private async reserve(
    spec: AdminOtpPurposeSpec,
    emailHash: string,
    redis: RedisOtpClient,
  ): Promise<string> {
    const codeKey = AdminOtpService.key(spec, "code", emailHash);
    const attemptsKey = AdminOtpService.key(spec, "attempts", emailHash);
    const cooldownKey = AdminOtpService.key(spec, "cooldown", emailHash);

    if ((await redis.exists(cooldownKey)) > 0) {
      throw new HttpException(
        "Please wait before requesting another code",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const hour = AdminOtpService.utcHourStamp();
    const sendCountKey = AdminOtpService.key(spec, "sendcount", `${emailHash}:${hour}`);
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

  /**
   * `<namespace>:<kind>:<suffix>`. For `login` this is exactly the pre-0144 key set
   * (`admin_otp:code:<hash>`, `…:attempts:`, `…:cooldown:`, `…:sendcount:<hash>:<hour>`).
   */
  private static key(
    spec: AdminOtpPurposeSpec,
    kind: "code" | "attempts" | "cooldown" | "sendcount",
    suffix: string,
  ): string {
    return `${spec.namespace}:${kind}:${suffix}`;
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
