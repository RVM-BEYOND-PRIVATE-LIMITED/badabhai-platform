import { HttpException, HttpStatus, Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { RESUME_RENDER_QUEUE } from "../../queue/queue.constants";
import { PiiCryptoService } from "../pii-crypto.service";
import type { Sender } from "./request-sender";

/**
 * Minimal typed view of the raw Redis commands we need (BullMQ's IRedisClient
 * doesn't declare INCR/EXPIRE, but the runtime client is ioredis which has them).
 */
interface RedisCounter {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

/**
 * Per-CALLER request cap over a rolling UTC hour — an abuse backstop for the public
 * download routes (resume PDF, interview kit) and the unauthenticated auth routes,
 * complementing the per-worker/global DAY caps (TD24).
 *
 * TWO KINDS OF CALLER, TWO NAMESPACES (#1035). {@link assertWithinHourlyIpCap} keys on the
 * address; {@link assertWithinHourlySenderCap} keys on whichever identifier the request
 * actually carried — the device where the client named one, the address otherwise. They
 * write `ratelimit:dev:…` and `ratelimit:ip:…` respectively, and the split is load-bearing
 * rather than cosmetic: both hashes are 32 hex chars, so a shared namespace would let a
 * device-id hash and an address hash land in one bucket with nothing in the key to say
 * which was which.
 *
 * PRIVACY: the caller identifier — address or device id alike — is HMAC-hashed (keyed,
 * peppered) BEFORE it is used in a Redis key, and the raw value is NEVER logged. Only the
 * hash prefix appears in the key namespace, consistent with the no-raw-PII invariant and
 * with `worker_devices.device_hash`, which already treats this same device id that way.
 *
 * FAIL CLOSED: if Redis is unavailable we REJECT (429) rather than allow, so an
 * outage can never uncap the download routes.
 *
 * NOTE (TD): behind a proxy/LB, `req.ip` is the proxy unless Express `trust proxy`
 * is set. Until that's configured the address cap is coarse (per-egress-IP); it is still a
 * useful backstop. Tightening it to the real client IP rides the deployment work. That
 * coarseness is precisely why the OTP send routes moved OFF it — see `request-sender.ts`.
 */
@Injectable()
export class IpRateLimit {
  private readonly logger = new Logger(IpRateLimit.name);

  constructor(
    private readonly pii: PiiCryptoService,
    // Reuse BullMQ's existing Redis connection — do NOT add a second client.
    @InjectQueue(RESUME_RENDER_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Throw 429 if `ip` has exceeded `cap` requests for `scope` in the current UTC
   * hour. `scope` is a short namespace, e.g. "resume_download" / "interview_kit".
   */
  async assertWithinHourlyIpCap(scope: string, ip: string, cap: number): Promise<void> {
    return this.assertWithinHourlySenderCap(scope, { kind: "ip", value: ip }, cap);
  }

  /**
   * Throw 429 if this SENDER has exceeded `cap` requests for `scope` in the current UTC hour
   * (#1035) — the same counter as {@link assertWithinHourlyIpCap}, keyed on whoever the
   * request actually identified rather than on the address it happened to arrive from.
   *
   * WHY A ROUTE WOULD WANT THIS. On the worker OTP routes the address is the NAT egress
   * address, so the bucket is a whole factory wifi or a whole carrier CGNAT pool; a device is
   * one handset. The full reasoning, and why falling back to the address for a caller that
   * sent no device id is the strict reading rather than a loophole, is in `request-sender.ts`.
   */
  async assertWithinHourlySenderCap(scope: string, sender: Sender, cap: number): Promise<void> {
    // Keyed HMAC, truncated to keep the Redis key bounded — and, for the device kind, to keep
    // an UNAUTHENTICATED caller from choosing the width of a key we write. A collision only
    // ever merges two callers into one slightly-stricter bucket, which is safe in both
    // directions: it can refuse a request, never grant one.
    //
    // `hashIp` for an address (unchanged, so live buckets keep counting across a deploy) and
    // the generic `hmac` for a device id. Both are the same keyed, peppered primitive; the
    // namespaces below are what keep the two hash spaces apart, not the choice of method.
    const hash =
      sender.kind === "device"
        ? this.pii.hmac(sender.value).slice(0, 32)
        : this.pii.hashIp(sender.value || "unknown").slice(0, 32);
    const hour = IpRateLimit.utcHourStamp();
    const key = `ratelimit:${sender.kind === "device" ? "dev" : "ip"}:${scope}:${hash}:${hour}`;
    const ttl = IpRateLimit.secondsUntilEndOfUtcHour();

    let count: number;
    try {
      const redis = (await this.queue.client) as unknown as RedisCounter;
      count = await redis.incr(key);
      // Re-assert TTL on EVERY hit (idempotent + cheap) so a crash between INCR and
      // EXPIRE can't leave a TTL-less key that blocks the caller for the rest of the hour.
      await redis.expire(key, ttl);
    } catch (err) {
      // FAIL CLOSED. Never log the raw address or the raw device id — only the hash prefix.
      // The label tracks the kind so an operator reading this line knows which bucket failed.
      const label = sender.kind === "device" ? "device_hash" : "ip_hash";
      this.logger.error(
        `IP rate-limit Redis unavailable for scope=${scope} ${label}=${hash.slice(0, 8)}…; failing closed (reason: ${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      throw new HttpException(
        "This is temporarily unavailable; please retry shortly",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (count > cap) {
      // LOGGED, because a silent cap is unanswerable from outside (#1019). This throws the same
      // neutral 429 as four throttles in `OtpService`, so without a line here "which limit did
      // this worker hit?" can only be answered by reading Redis on the box by hand. The kind and
      // the scope together say which bucket it was; the count says how far over.
      //
      // WARN, NOT ERROR: a cap firing is the limiter working, not the platform failing. The
      // `error` above is a different event — Redis was unreachable and we refused blind.
      this.logger.warn(
        `${sender.kind} rate-limit cap reached scope=${scope} ` +
          `hash=${hash.slice(0, 8)}… count=${count}/${cap}; refusing`,
      );
      // ONE WORDING FOR BOTH KINDS, deliberately. The message a worker sees must not reveal
      // which bucket they landed in — that would tell a prober whether their device id was
      // accepted, and it is the same neutral 429 every other OTP throttle answers with.
      throw new HttpException(
        "Too many requests from this network; please try again later",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * GLOBAL (IP-INDEPENDENT) daily cap — despite this class's name, this counter is
   * NOT keyed on the caller: it bounds the platform-wide count for `scope` over a
   * UTC day. It is the backstop ABOVE the per-IP hour cap, for routes where a
   * credential holder could otherwise rotate IPs for unlimited requests (D-3
   * test-login, review L1). Mirrors the OTP-5 global send breaker's idiom
   * (`OtpService.assertWithinGlobalDailyCap`): INCR + re-assert the end-of-UTC-day
   * TTL on every hit, and `count >= cap` (NOT `>`) so a cap of **0 = PAUSED** blocks
   * the FIRST request — an env-only kill-switch, no redeploy.
   *
   * FAIL CLOSED: a Redis error REJECTS (429), never uncaps. PII-free by construction
   * (the key carries only the scope + UTC day — no ip, no phone, no id).
   */
  async assertWithinGlobalDailyCap(scope: string, cap: number): Promise<void> {
    const day = IpRateLimit.utcDayStamp();
    const key = `ratelimit:global:${scope}:${day}`;
    const ttl = IpRateLimit.secondsUntilEndOfUtcDay();

    let count: number;
    try {
      const redis = (await this.queue.client) as unknown as RedisCounter;
      count = await redis.incr(key);
      await redis.expire(key, ttl);
    } catch (err) {
      this.logger.error(
        `Global daily rate-limit Redis unavailable for scope=${scope}; failing closed (reason: ${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      throw new HttpException(
        "This is temporarily unavailable; please retry shortly",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (count >= cap) {
      this.logger.warn(`Global daily cap reached scope=${scope} limit=${cap} day=${day}; refusing`);
      throw new HttpException(
        "Too many requests; please try again later",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** UTC day stamp `YYYYMMDD` (global-cap key namespace + rolling window). */
  private static utcDayStamp(now: Date = new Date()): string {
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, "0");
    const d = String(now.getUTCDate()).padStart(2, "0");
    return `${y}${m}${d}`;
  }

  /** Seconds remaining until the end of the current UTC day (+1 to round up). */
  private static secondsUntilEndOfUtcDay(now: Date = new Date()): number {
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
