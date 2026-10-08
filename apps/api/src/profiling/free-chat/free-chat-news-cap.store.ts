import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";

import { RESUME_RENDER_QUEUE } from "../../queue/queue.constants";
import { withinRedisDeadline } from "../../queue/redis-deadline";

/** News answers one worker may get in one IST day (ADR-0054 R5). */
export const FREE_CHAT_NEWS_DAILY_CAP = 5;

/**
 * How long a day's counter outlives the day. An hour past IST midnight, so a request reserved at
 * 23:59 and handed back after midnight still DECRs the key it INCRed — the release always rebuilds
 * the key from the SAME clock the reservation read, never a later one.
 */
export const FREE_CHAT_NEWS_CAP_GRACE_SECONDS = 3_600;

/** India Standard Time is UTC+05:30 all year (no daylight saving), so the day is pure arithmetic. */
const IST_OFFSET_MS = 330 * 60 * 1_000;
const DAY_MS = 86_400_000;

/**
 * Minimal typed view of the Redis commands the cap needs — the narrowing every borrowed-connection
 * store uses (ioredis at runtime; BullMQ's interface declares less).
 */
interface RedisCounter {
  incr(key: string): Promise<number>;
  decr(key: string): Promise<number>;
  expireat(key: string, unixSeconds: number): Promise<number>;
}

/**
 * One reservation: `ok` with the worker's count INCLUDING this request, or — over the cap — not ok
 * with the count of slots already held (the INCR has been handed back).
 */
export interface FreeChatNewsReservation {
  readonly ok: boolean;
  readonly count: number;
}

/** The IST calendar day `now` falls in, as `yyyy-mm-dd`. 18:30 UTC is IST midnight. */
export function istDayOf(now: Date): string {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** When the counter for `now`'s IST day expires: the end of that day plus the grace, in Unix seconds. */
export function newsCapExpiryOf(now: Date): number {
  const istMidnight = Math.floor((now.getTime() + IST_OFFSET_MS) / DAY_MS) * DAY_MS;
  const dayEndUtc = istMidnight + DAY_MS - IST_OFFSET_MS;
  return dayEndUtc / 1_000 + FREE_CHAT_NEWS_CAP_GRACE_SECONDS;
}

/** The worker's counter for `now`'s IST day. Ids and a date only — never text. */
export function newsCapKey(workerId: string, now: Date): string {
  return `free_chat:news:${workerId}:${istDayOf(now)}`;
}

/**
 * THE LIVE-NEWS DAILY CAP (ADR-0054 R5, §3.4) — `INCR` on `free_chat:news:{workerId}:{IST day}`, on
 * BullMQ's existing connection (never a second client): the `ResumeRateLimit` pattern, with a DECR
 * release, keyed by the IST day rather than the UTC one.
 *
 * RESERVED BEFORE THE CALL, HANDED BACK UNLESS ANSWERED. A request that does not end `answered`
 * releases its slot, so a failure, a refusal or the unarmed mock costs the worker nothing. The
 * caller memoises the reservation per `takeTurn`, so a lost CAS never counts twice.
 *
 * FAILS CLOSED, the opposite of the companion's fail-open stores: "the cap could not be read" is
 * "no call", never "unlimited calls" — `reserve` returns null and the worker reads the unavailable
 * line. Every call runs under `withinRedisDeadline`, so a downed Redis (whose commands never reject
 * on the shared connection) costs 150 ms, never a hang. A timed-out INCR may still land late; it
 * then holds one slot until the day ends, which is the fail-closed direction.
 *
 * EVERY HIT RE-ASSERTS THE EXPIRY (`EXPIREAT`, idempotent): a process that dies between the INCR and
 * the EXPIREAT leaves a TTL-less key only until the worker's next request that day.
 */
@Injectable()
export class FreeChatNewsCap {
  private readonly logger = new Logger(FreeChatNewsCap.name);

  constructor(
    // Borrow BullMQ's existing Redis connection — nothing enqueues here.
    @InjectQueue(RESUME_RENDER_QUEUE) private readonly queue: Queue,
  ) {}

  private async client(): Promise<RedisCounter> {
    return (await this.queue.client) as unknown as RedisCounter;
  }

  /**
   * Take one of today's slots: `{ok: true, count}` under the cap; `{ok: false, count}` over it (the
   * INCR handed straight back, `count` the slots already held); null when the store cannot be read
   * — the caller makes no call. Never throws.
   */
  async reserve(workerId: string, now: Date): Promise<FreeChatNewsReservation | null> {
    const key = newsCapKey(workerId, now);
    const expireAt = newsCapExpiryOf(now);
    try {
      return await withinRedisDeadline(async () => {
        const redis = await this.client();
        const count = await redis.incr(key);
        await redis.expireat(key, expireAt);
        if (count <= FREE_CHAT_NEWS_DAILY_CAP) return { ok: true, count };
        await redis.decr(key);
        return { ok: false, count: count - 1 };
      });
    } catch (err) {
      this.logger.warn(
        `free-chat news cap unreadable worker=${workerId}; no news call is made (${
          err instanceof Error ? err.name : "UnknownError"
        })`,
      );
      return null;
    }
  }

  /**
   * Hand back the slot a reservation at `now` took — `now` is the reservation's own clock, so the
   * key is the one it INCRed. Best effort: a failed release costs the worker one slot until the day
   * ends (the fail-closed direction). Never throws.
   */
  async release(workerId: string, now: Date): Promise<void> {
    const key = newsCapKey(workerId, now);
    const expireAt = newsCapExpiryOf(now);
    try {
      await withinRedisDeadline(async () => {
        const redis = await this.client();
        await redis.decr(key);
        await redis.expireat(key, expireAt);
      });
    } catch (err) {
      this.logger.warn(
        `free-chat news cap slot not released worker=${workerId}; it is held until the day ends (${
          err instanceof Error ? err.name : "UnknownError"
        })`,
      );
    }
  }
}
