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
 * A per-SUBJECT cap over a FIXED UTC CALENDAR HOUR, where the subject is an already-authenticated
 * principal id (a worker, a payer) rather than an IP.
 *
 * FIXED BUCKET, NOT A SLIDING WINDOW, and the docs used to say "rolling" — which is a different
 * and stricter thing. The key carries a `YYYYMMDDHH` stamp, so the counter resets at the top of
 * the hour and a caller can legitimately spend the full cap at :59 and the full cap again at :00.
 * That is the accepted cost of one INCRBY per request; the cap is an abuse backstop on writes into
 * the audit spine, not a metering primitive, and a true sliding window needs a sorted set per
 * subject. Anyone reading this to size a cap should size it for 2× over an hour boundary.
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
   *
   * RESERVE, THEN RELEASE ON REJECTION. The charge lands before the check, which is what makes a
   * single oversized batch reject instead of writing its rows and starving the next caller. But
   * KEEPING that charge on a rejected request quietly lowers the cap: a worker at 450/500 who
   * sends a 100-batch is refused and left at 550, so the 40-item flush that would have fit is
   * refused too, and every retry inside the hour pushes it further out. Nothing was written, so
   * nothing should stay spent. The refund is best-effort — if it fails the counter is merely
   * conservative, which is the safe direction — and a concurrent request can observe the
   * pre-refund value, which can only ever reject something it would otherwise have allowed.
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
    let redis: RedisCounter;
    try {
      redis = (await this.queue.client) as unknown as RedisCounter;
      count = await redis.incrby(key, cost);
      // Re-assert the TTL on EVERY hit, not only the first. A `if (count === cost)` guard leaves a
      // TTL-less key whenever the process dies between INCRBY and EXPIRE — and because the key is
      // stamped with the hour, that does NOT cap the subject forever (the next hour is a different
      // key); it leaks a key that never expires, one per subject per affected hour, in a Redis this
      // also runs BullMQ on. EXPIRE is idempotent and cheap, so re-asserting is the whole fix.
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
      try {
        await redis.incrby(key, -cost);
      } catch (err) {
        this.logger.warn(
          `subject rate-limit refund failed scope=${scope} subject=${subjectId.slice(0, 8)}…; ` +
            `the counter stays conservative until the hour rolls ` +
            `(reason: ${err instanceof Error ? err.message : String(err)})`,
        );
      }
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
