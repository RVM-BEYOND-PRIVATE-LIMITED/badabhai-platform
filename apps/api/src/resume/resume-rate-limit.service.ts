import { HttpException, HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { RESUME_RENDER_QUEUE, type ResumeRenderJobData } from "../queue/queue.constants";

/**
 * Minimal typed view of the raw Redis commands we need. BullMQ's `IRedisClient`
 * interface only declares the subset BullMQ itself uses (no INCR/EXPIRE), but the
 * runtime client is ioredis, which has them. We narrow to this interface instead
 * of `any` so the call sites stay type-checked.
 */
interface RedisCounter {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

/**
 * Per-day generation cap for the paid resume path.
 *
 * Two dimensions, both keyed by UTC day:
 *   - per-worker  (RESUME_DAILY_CAP)
 *   - global      (RESUME_GLOBAL_DAILY_CAP) — interim backstop.
 *
 * NOTE (deferred): a per-IP / global-per-account dimension is intentionally NOT
 * implemented yet. Until TD4 binds each request to an AUTHENTICATED worker, a
 * caller could rotate `worker_id` to dodge the per-worker cap; the global cap is
 * the interim backstop against that, and against runaway paid-path spend.
 *
 * FAIL CLOSED: if Redis is unavailable we REJECT (treat as over-cap) rather than
 * allow, so an outage can never uncork unlimited LLM/render spend.
 */
@Injectable()
export class ResumeRateLimit {
  private readonly logger = new Logger(ResumeRateLimit.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    // Reuse BullMQ's existing Redis connection — do NOT add a second client.
    @InjectQueue(RESUME_RENDER_QUEUE)
    private readonly renderQueue: Queue<ResumeRenderJobData>,
  ) {}

  /**
   * Throw 429 if `workerId` has hit its daily cap, or if the global daily cap is
   * exceeded. Atomic INCR + EXPIRE per key.
   *
   * `perWorker` defaults to true. The system-initiated auto-generate (on
   * profile.confirmed) passes `false`: that path is one-per-worker + idempotent, so
   * the per-worker abuse cap shouldn't starve it — but the GLOBAL spend backstop
   * still applies.
   */
  async assertWithinDailyCap(
    workerId: string,
    opts: { perWorker?: boolean } = {},
  ): Promise<void> {
    const perWorker = opts.perWorker ?? true;
    const day = ResumeRateLimit.utcDayStamp();
    const workerKey = `resume:gen:${workerId}:${day}`;
    const globalKey = `resume:gen:global:${day}`;
    const ttl = ResumeRateLimit.secondsUntilEndOfUtcDay();

    let workerCount = 0;
    let globalCount: number;
    try {
      const redis = (await this.renderQueue.client) as unknown as RedisCounter;
      if (perWorker) workerCount = await this.bumpCounter(redis, workerKey, ttl);
      globalCount = await this.bumpCounter(redis, globalKey, ttl);
    } catch (err) {
      // FAIL CLOSED: a Redis outage must not allow unlimited paid-path spend.
      this.logger.error(
        `resume rate-limit Redis unavailable; failing closed (reason: ${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      throw new HttpException(
        "Resume generation is temporarily unavailable; please retry shortly",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (perWorker && workerCount > this.config.RESUME_DAILY_CAP) {
      throw new HttpException(
        "Daily resume generation limit reached; please try again tomorrow",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (globalCount > this.config.RESUME_GLOBAL_DAILY_CAP) {
      throw new HttpException(
        "Resume generation is at capacity; please try again later",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * INCR the counter and (re)assert its TTL on EVERY hit — not just the first. A
   * one-time `if (value === 1)` guard would leave a TTL-less key if the process
   * died between INCR and EXPIRE, capping the worker for the rest of the UTC day.
   * EXPIRE is idempotent + cheap, so refreshing it each call is the robust choice.
   */
  private async bumpCounter(redis: RedisCounter, key: string, ttlSeconds: number): Promise<number> {
    const value = await redis.incr(key);
    await redis.expire(key, ttlSeconds);
    return value;
  }

  /** UTC day stamp `YYYYMMDD` (key namespace). */
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
}
