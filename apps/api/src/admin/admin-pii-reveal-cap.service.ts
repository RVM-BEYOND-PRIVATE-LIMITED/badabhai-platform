import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";

/**
 * Minimal typed view of the raw Redis commands the per-admin cap needs (BullMQ's IRedisClient
 * doesn't declare INCR/EXPIRE, but the runtime client is ioredis which has them).
 */
interface RedisCounter {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

/** Which window an over-cap denial breached — mirrors the event payload enum. */
export type AdminPiiRevealCapWindow = "hour" | "day";

/**
 * The outcome of the cap check. `ok` ⇒ within both caps (the reveal may proceed). When NOT ok,
 * `window` names which cap was exceeded (for the PII-free breach event). It is NEVER a success
 * with a value — an over-cap (or a Redis error) returns `{ ok:false }` so the caller reveals
 * nothing.
 */
export type AdminPiiRevealCapResult = { ok: true } | { ok: false; window: AdminPiiRevealCapWindow };

/**
 * PER-ADMIN worker-PII reveal cap (ADR-0025 ADMIN-3b must-fix #8) — an hour + day velocity
 * backstop on the single most sensitive route in the system. A reason-gated reveal must still be
 * RATE-bounded so a compromised/abusive admin cannot bulk-deanonymize workers. Adapts the
 * {@link import("../common/rate-limit/ip-rate-limit.service").IpRateLimit} pattern to a PER-ADMIN
 * key (the actor is the session admin id, never an IP).
 *
 * FAIL CLOSED (the central invariant): if Redis is unavailable the check DENIES (returns
 * `{ ok:false }`) rather than allowing — an outage can never uncap the reveal. The denial window
 * on a Redis error is reported as `hour` (the tighter window) so the breach event is honest about
 * a refusal having happened.
 *
 * ORDER: this is checked BEFORE the decrypt (an over-cap request reveals NOTHING). The counter is
 * INCREMENTED on the authorized path (the reveal is the costly action), so a denied/flag-failed
 * request earlier in the pipeline does not consume the budget.
 *
 * PII-FREE: the only identity in the Redis key + logs is the opaque `admin_id`; no worker id, no
 * phone, no reason note ever touches this service.
 */
@Injectable()
export class AdminPiiRevealCapService {
  private readonly logger = new Logger(AdminPiiRevealCapService.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    // Reuse the existing BullMQ Redis connection — do NOT add a second client.
    @InjectQueue(RESUME_RENDER_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Consume one reveal against the admin's hour + day caps. Returns `{ ok:true }` only when BOTH
   * caps still have headroom AFTER this reveal; otherwise `{ ok:false, window }`. A Redis error
   * DENIES (fail closed). Both counters are incremented atomically-enough (INCR then EXPIRE) so a
   * crash between the two cannot leave a TTL-less key (EXPIRE is re-asserted on every hit).
   *
   * The HOUR cap is checked/incremented first; if it trips we still return without touching the
   * day counter (the hour breach is the answer, and the request reveals nothing regardless).
   */
  async consume(adminId: string): Promise<AdminPiiRevealCapResult> {
    const idPrefix = adminId.slice(0, 8);
    let redis: RedisCounter;
    try {
      redis = (await this.queue.client) as unknown as RedisCounter;
    } catch (err) {
      return this.denyOnRedisError(err, idPrefix, "hour");
    }

    // HOUR window.
    const hourStamp = AdminPiiRevealCapService.utcHourStamp();
    const hourKey = `admin_pii_reveal:hour:${adminId}:${hourStamp}`;
    let hourCount: number;
    try {
      hourCount = await redis.incr(hourKey);
      await redis.expire(hourKey, AdminPiiRevealCapService.secondsUntilEndOfUtcHour());
    } catch (err) {
      return this.denyOnRedisError(err, idPrefix, "hour");
    }
    if (hourCount > this.config.ADMIN_PII_REVEAL_MAX_PER_HOUR) {
      return { ok: false, window: "hour" };
    }

    // DAY window.
    const dayStamp = AdminPiiRevealCapService.utcDayStamp();
    const dayKey = `admin_pii_reveal:day:${adminId}:${dayStamp}`;
    let dayCount: number;
    try {
      dayCount = await redis.incr(dayKey);
      await redis.expire(dayKey, AdminPiiRevealCapService.secondsUntilEndOfUtcDay());
    } catch (err) {
      return this.denyOnRedisError(err, idPrefix, "day");
    }
    if (dayCount > this.config.ADMIN_PII_REVEAL_MAX_PER_DAY) {
      return { ok: false, window: "day" };
    }

    return { ok: true };
  }

  /** Fail-closed denial on a Redis error. Logs the reason + the admin-id PREFIX only (no PII). */
  private denyOnRedisError(
    err: unknown,
    idPrefix: string,
    window: AdminPiiRevealCapWindow,
  ): AdminPiiRevealCapResult {
    this.logger.error(
      `admin PII-reveal cap Redis unavailable admin_id=${idPrefix}…; failing closed (reason: ${
        err instanceof Error ? err.message : String(err)
      })`,
    );
    return { ok: false, window };
  }

  /** UTC hour stamp `YYYYMMDDHH` (key namespace + rolling window). */
  private static utcHourStamp(now: Date = new Date()): string {
    return `${AdminPiiRevealCapService.utcDayStamp(now)}${String(now.getUTCHours()).padStart(2, "0")}`;
  }

  /** UTC day stamp `YYYYMMDD`. */
  private static utcDayStamp(now: Date = new Date()): string {
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, "0");
    const d = String(now.getUTCDate()).padStart(2, "0");
    return `${y}${m}${d}`;
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
