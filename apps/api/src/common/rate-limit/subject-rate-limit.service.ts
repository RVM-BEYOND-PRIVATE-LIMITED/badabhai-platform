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
 * One fixed calendar bucket: the key stamp that namespaces the counter, and how long the key
 * should outlive the request that created it. The two are computed together because they must
 * agree — a `YYYYMMDDHH` stamp with a to-end-of-MINUTE ttl would drop an hour's counter sixty
 * seconds in, which is a silently uncapped hour rather than a visible failure.
 */
interface CalendarBucket {
  /** The stamp appended to the Redis key — different stamp, different bucket. */
  stamp: string;
  /** Seconds until this bucket ends, so the key expires with the window it counts. */
  ttlSeconds: number;
}

/**
 * A per-SUBJECT cap over a FIXED UTC CALENDAR WINDOW, where the subject is an already-authenticated
 * principal id (a worker, a payer) rather than an IP. Two windows are offered — an HOUR
 * ({@link assertWithinHourlyCap}) and a MINUTE ({@link assertWithinMinuteCap}) — over one shared
 * counter implementation.
 *
 * FIXED BUCKET, NOT A SLIDING WINDOW, and the docs used to say "rolling" — which is a different
 * and stricter thing. The key carries a `YYYYMMDDHH` (or `YYYYMMDDHHmm`) stamp, so the counter
 * resets at the top of the window and a caller can legitimately spend the full cap at :59 and the
 * full cap again at :00. That is the accepted cost of one INCRBY per request; the cap is an abuse
 * backstop on writes into the audit spine, not a metering primitive, and a true sliding window
 * needs a sorted set per subject. Anyone reading this to size a cap should size it for 2x over a
 * window boundary.
 *
 * WHY BOTH WINDOWS EXIST, rather than one with a bigger number. They are not interchangeable
 * BECAUSE the bucket is fixed: "3 per minute" restated as 180/hour permits all 180 inside ten
 * seconds, and "20 per hour" cannot stop a burst of 20 in one second. A route that wants a
 * human-pace rule AND an abuse backstop applies both, minute first (#997) — so a burst refused
 * by the minute cap never inflates the hourly counter it was refused by.
 *
 * WHY IT IS NOT `IpRateLimit`. That one HMAC-hashes its input because an IP is PII; a subject id
 * is an opaque internal uuid the caller has already proved they are, so hashing it would buy
 * nothing and make the key unreadable in an incident. Same counter, different privacy posture,
 * so they are different services rather than one with a flag.
 *
 * WHY IT COUNTS UNITS AND NOT REQUESTS. Both public methods take a `cost`, because the routes
 * that need this accept BATCHES: capping calls alone lets one caller send a hundred
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
    return this.assertWithinCalendarCap(
      scope,
      subjectId,
      cap,
      cost,
      SubjectRateLimit.utcHourBucket(),
    );
  }

  /**
   * Throw 429 if `subjectId` has spent more than `cap` units on `scope` this UTC MINUTE.
   *
   * WHY A SECOND BUCKET (#997). The hour bucket above is an abuse backstop, and sizing it to
   * express "a few per minute" is not possible: 3/min written as an hourly number is 180, which
   * a fixed bucket happily permits inside ten seconds. A per-minute rule therefore needs a
   * per-minute KEY. Semantics are otherwise identical — fixed calendar bucket (not sliding),
   * charge-then-refund-on-rejection, fail closed on a Redis outage — so a cap here should still
   * be sized for 2x over a minute boundary.
   *
   * SEPARATE KEYSPACE, not a shared one: the stamp is `YYYYMMDDHHmm`, twelve digits against the
   * hourly key's ten, so the same `scope` + `subjectId` counts independently in each window and
   * applying both caps is meaningful rather than double-charging one counter.
   */
  async assertWithinMinuteCap(
    scope: string,
    subjectId: string,
    cap: number,
    cost = 1,
  ): Promise<void> {
    return this.assertWithinCalendarCap(
      scope,
      subjectId,
      cap,
      cost,
      SubjectRateLimit.utcMinuteBucket(),
    );
  }

  /**
   * The one counter both public methods are. Everything that makes this service correct — the
   * charge-before-check, the TTL re-assertion, the refund, the fail-closed posture — lives here
   * exactly once, so the two windows cannot drift into two different safety postures. The only
   * thing a caller varies is the {@link CalendarBucket} it counts in.
   */
  private async assertWithinCalendarCap(
    scope: string,
    subjectId: string,
    cap: number,
    cost: number,
    bucket: CalendarBucket,
  ): Promise<void> {
    const key = `ratelimit:subject:${scope}:${subjectId}:${bucket.stamp}`;

    let count: number;
    let redis: RedisCounter;
    try {
      redis = (await this.queue.client) as unknown as RedisCounter;
      count = await redis.incrby(key, cost);
      // Re-assert the TTL on EVERY hit, not only the first. A `if (count === cost)` guard leaves a
      // TTL-less key whenever the process dies between INCRBY and EXPIRE — and because the key is
      // stamped with the window, that does NOT cap the subject forever (the next window is a
      // different key); it leaks a key that never expires, one per subject per affected window, in
      // a Redis this also runs BullMQ on. EXPIRE is idempotent and cheap, so re-asserting is the
      // whole fix.
      await redis.expire(key, bucket.ttlSeconds);
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
            `the counter stays conservative until the window rolls ` +
            `(reason: ${err instanceof Error ? err.message : String(err)})`,
        );
      }
      throw new HttpException(
        "Too many requests; please retry later",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * The current fixed UTC hour: `YYYYMMDDHH` stamp + seconds left in it.
   *
   * `Date.UTC` normalises the overflow, so "hour + 1" at 23:xx is midnight tomorrow rather than
   * an invalid 24 — the reason the end-of-window instant is computed rather than added in ms.
   */
  private static utcHourBucket(now: Date = new Date()): CalendarBucket {
    const endOfHour = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours() + 1,
      0,
      0,
      0,
    );
    return {
      stamp: `${SubjectRateLimit.utcDayStamp(now)}${pad2(now.getUTCHours())}`,
      ttlSeconds: SubjectRateLimit.secondsUntil(endOfHour, now),
    };
  }

  /** The current fixed UTC minute: `YYYYMMDDHHmm` stamp + seconds left in it. */
  private static utcMinuteBucket(now: Date = new Date()): CalendarBucket {
    const endOfMinute = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
      now.getUTCMinutes() + 1,
      0,
      0,
    );
    return {
      stamp: `${SubjectRateLimit.utcDayStamp(now)}${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}`,
      ttlSeconds: SubjectRateLimit.secondsUntil(endOfMinute, now),
    };
  }

  /** `YYYYMMDD` — the shared head of both stamps. */
  private static utcDayStamp(now: Date): string {
    return `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}`;
  }

  /** Seconds remaining until `endMs` (+1 to round up, floored at 1 so EXPIRE is never a no-op). */
  private static secondsUntil(endMs: number, now: Date): number {
    return Math.max(1, Math.ceil((endMs - now.getTime()) / 1000));
  }
}

/** Two-digit zero-padded — the one formatting rule every stamp component shares. */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
