import { HttpException, HttpStatus, Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { RESUME_RENDER_QUEUE } from "../../queue/queue.constants";
import { PiiCryptoService } from "../pii-crypto.service";

/**
 * Minimal typed view of the raw Redis commands we need (BullMQ's IRedisClient
 * doesn't declare INCR/EXPIRE, but the runtime client is ioredis which has them).
 */
interface RedisCounter {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

/**
 * Per-IP request cap over a rolling UTC hour — an abuse backstop for the public
 * download routes (resume PDF, interview kit), complementing the per-worker/global
 * DAY caps (TD24).
 *
 * PRIVACY: the client IP is HMAC-hashed (keyed, peppered) BEFORE it is used in a
 * Redis key, and the raw IP is NEVER logged. Only the hash prefix appears in the
 * key namespace — consistent with the no-raw-PII invariant.
 *
 * FAIL CLOSED: if Redis is unavailable we REJECT (429) rather than allow, so an
 * outage can never uncap the download routes.
 *
 * NOTE (TD): behind a proxy/LB, `req.ip` is the proxy unless Express `trust proxy`
 * is set. Until that's configured the cap is coarse (per-egress-IP); it is still a
 * useful backstop. Tightening it to the real client IP rides the deployment work.
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
    // Hash the IP (keyed HMAC). Truncate to keep the Redis key bounded; collisions
    // here only ever merge two IPs into one slightly-stricter bucket (safe).
    const ipHash = this.pii.hashIp(ip || "unknown").slice(0, 32);
    const hour = IpRateLimit.utcHourStamp();
    const key = `ratelimit:ip:${scope}:${ipHash}:${hour}`;
    const ttl = IpRateLimit.secondsUntilEndOfUtcHour();

    let count: number;
    try {
      const redis = (await this.queue.client) as unknown as RedisCounter;
      count = await redis.incr(key);
      // Re-assert TTL on EVERY hit (idempotent + cheap) so a crash between INCR and
      // EXPIRE can't leave a TTL-less key that blocks the IP for the rest of the hour.
      await redis.expire(key, ttl);
    } catch (err) {
      // FAIL CLOSED. Never log the raw IP — only the hash prefix + reason.
      this.logger.error(
        `IP rate-limit Redis unavailable for scope=${scope} ip_hash=${ipHash.slice(0, 8)}…; failing closed (reason: ${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      throw new HttpException(
        "This is temporarily unavailable; please retry shortly",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (count > cap) {
      throw new HttpException(
        "Too many requests from this network; please try again later",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
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
