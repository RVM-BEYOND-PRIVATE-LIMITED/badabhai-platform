import { HttpException, HttpStatus, Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { RESUME_RENDER_QUEUE } from "../../queue/queue.constants";

/**
 * Minimal typed view of the raw Redis commands we need. BullMQ's `IRedisClient` only declares the
 * subset BullMQ itself uses (no INCRBY/EXPIRE), but the runtime client is ioredis, which has them.
 * Narrowed to this interface rather than `any` so the call sites stay type-checked.
 */
interface RedisCounter {
  incrby(key: string, increment: number): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

/**
 * A per-SUBJECT cap over a rolling UTC hour, where the subject is an already-authenticated
 * principal id (a worker, a payer) rather than an IP.
 *
 * WHY IT IS NOT `IpRateLimit`. That one HMAC-hashes its input because an IP is PII; a subject id
 * is an opaque internal uuid the caller has already proved they are, so hashing it would buy
 * nothing and make the key unreadable in an incident. Same counter, different privacy posture,
 * so they are different services rather than one with a flag.
 *
 * WHY IT COUNTS UNITS AND NOT REQUESTS. `assertWithinHourlyCap` takes a `cost`, because the
 * routes that need this accept BATCHES: capping calls alone lets one caller send a hundred
 * hundred-item batches and write ten thousand rows against a cap of a hundred. The cap is on the
 * work, not on the envelopes it arrives in.
 *
 * FAIL CLOSED: a Redis outage REJECTS rather than allows. The alternative is an uncapped write
 * path into the events table during exactly the incident least able to absorb it.
 *
 * @see IpRateLimit — the same INCR/EXPIRE shape for the anonymous, per-IP case.
 */
@Injectable()
export class SubjectRateLimit {
  private readonly logger = new Logger(SubjectRateLimit.name);

  constructor(
    // Reuse BullMQ's existing Redis connection — do NOT add a second client.
    @InjectQueue(RESUME_RENDER_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Throw 429 if `subjectId` has spent more than `cap` units on `scope` this UTC hour.
   *
   * `scope` is a short namespace, e.g. `"worker_actions"`. `cost` is how much this request
   * spends — the number of records it would write, not 1.
   */
  async assertWithinHourlyCap(
    scope: string,
    subjectId: string,
    cap: number,
    cost = 1,
  ): Promise<void> {
    const hour = SubjectRateLimit.utcHourStamp();
    const key = `ratelimit:subject:${scope}:${subjectId}:${hour}`;
    const ttl = SubjectRateLimit.secondsUntilEndOfUtcHour();

    let count: number;
    try {
      const redis = (await this.queue.client) as unknown as RedisCounter;
      count = await redis.incrby(key, cost);
      // Re-assert the TTL on EVERY hit, not only the first: a `if (count === cost)` guard would
      // leave a TTL-less key if the process died between INCRBY and EXPIRE, capping the subject
      // forever rather than for the hour. EXPIRE is idempotent and cheap.
      await redis.expire(key, ttl);
    } catch (err) {
      this.logger.error(
        `subject rate-limit Redis unavailable scope=${scope} subject=${subjectId.slice(0, 8)}…; ` +
          `failing closed (reason: ${err instanceof Error ? err.message : String(err)})`,
      );
      throw new HttpException(
        "This is temporarily unavailable; please retry shortly",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (count > cap) {
      throw new HttpException(
        "Too many requests; please retry later",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** UTC hour stamp `YYYYMMDDHH` (key namespace). */
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
