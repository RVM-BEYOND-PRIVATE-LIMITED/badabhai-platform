import { HttpException, HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";

/** Minimal typed view of the raw Redis commands we need (BullMQ → ioredis). */
interface RedisCounter {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

/**
 * XB-G (ADR-0019 external-disclosure addendum, §2 XT1): a per-PAYER cap on the
 * disclosure (unlock) endpoint over a rolling UTC hour, enforced against the REAL
 * `PayerAuthGuard` identity (`payer_id`) — the control that becomes enforceable now that
 * a payer has an account (it closes base RR-A "ops can act as any payer" for the external
 * surface). It is one of THREE layered caps on the disclosure path, each independent:
 *   - this per-PAYER hourly cap (throttles a single account's harvest velocity),
 *   - the per-WORKER shared cap (XB-B, payer-COUNT-INDEPENDENT — the account-farming
 *     backstop; lives in the UnlockService chokepoint), and
 *   - the per-IP cap (network-level backstop).
 *
 * `payer_id` is an opaque, non-PII UUID, so (unlike IpRateLimit) it is used in the Redis
 * key directly — no hashing needed. FAIL CLOSED: a Redis outage REJECTS (429) rather than
 * uncapping the disclosure path.
 */
@Injectable()
export class PayerDisclosureRateLimit {
  private readonly logger = new Logger(PayerDisclosureRateLimit.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    @InjectQueue(RESUME_RENDER_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Throw 429 if `payerId` has exceeded its hourly cap for `scope` in the current UTC
   * hour. Default scope is the disclosure (unlock) cap (`PAYER_DISCLOSURE_MAX_PER_HOUR`,
   * XB-G) — called BEFORE the UnlockService chokepoint so a throttled payer never reaches
   * the grant path. The payer-self REACH read (ADR-0019 R22 / PR2) passes
   * `{scope:"payer_reach", cap: PAYER_REACH_MAX_PER_HOUR}` to bound scraping on its own
   * bucket. Each `(scope, payer, hour)` is an independent counter; both fail closed.
   */
  async assertWithinHourlyCap(
    payerId: string,
    opts?: { scope?: string; cap?: number },
  ): Promise<void> {
    const scope = opts?.scope ?? "payer_disclosure";
    const cap = opts?.cap ?? this.config.PAYER_DISCLOSURE_MAX_PER_HOUR;
    const hour = PayerDisclosureRateLimit.utcHourStamp();
    const key = `ratelimit:${scope}:${payerId}:${hour}`;
    const ttl = PayerDisclosureRateLimit.secondsUntilEndOfUtcHour();

    let count: number;
    try {
      const redis = (await this.queue.client) as unknown as RedisCounter;
      count = await redis.incr(key);
      // Re-assert TTL on every hit (idempotent + cheap) so a crash between INCR and
      // EXPIRE can't leave a TTL-less key blocking the payer for the rest of the hour.
      await redis.expire(key, ttl);
    } catch (err) {
      // FAIL CLOSED. payer_id is opaque (non-PII); log only its prefix + reason.
      this.logger.error(
        `payer disclosure rate-limit Redis unavailable payer=${payerId.slice(0, 8)}…; failing closed (reason: ${
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
        "Too many requests; please try again later",
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
