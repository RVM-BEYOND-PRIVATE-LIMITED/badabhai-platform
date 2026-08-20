import { Logger } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";

/**
 * Minimal typed view of the raw Redis commands a per-admin cap needs (BullMQ's IRedisClient
 * doesn't declare INCRBY/EXPIRE, but the runtime client is ioredis which has them).
 */
interface RedisCounter {
  incrby(key: string, increment: number): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

/** Which window an over-cap denial breached — mirrors the breach events' payload enum. */
export type AdminEgressCapWindow = "hour" | "day";

/**
 * The outcome of a cap check. `ok` ⇒ within both caps (the disclosure may proceed). When NOT
 * ok, `window` names which cap was exceeded (for the PII-free breach event). It is NEVER a
 * success with a value — an over-cap (or a Redis error) returns `{ ok:false }` so the caller
 * discloses nothing.
 */
export type AdminEgressCapResult = { ok: true } | { ok: false; window: AdminEgressCapWindow };

/**
 * The `ServerConfig` keys that hold a number — the only kind a cap limit may be named by. A
 * mistyped or non-numeric key is a COMPILE error here rather than a `NaN` comparison at
 * runtime, and `count > NaN` is always false, which would silently UNCAP the budget.
 */
type NumericServerConfigKey = {
  // `-?` strips optionality: without it every OPTIONAL config key contributes `undefined` to the
  // union, which then cannot be used as an index type at all.
  [K in keyof ServerConfig]-?: ServerConfig[K] extends number ? K : never;
}[keyof ServerConfig];

/**
 * PER-ADMIN EGRESS CAP — an hour + day velocity backstop on a privileged disclosure, keyed on
 * the session admin id (never an IP). Adapts the
 * {@link import("../common/rate-limit/ip-rate-limit.service").IpRateLimit} pattern to a
 * per-admin key.
 *
 * ── WHY IT IS GENERAL RATHER THAN ONE SERVICE PER SURFACE ────────────────────────────────
 * It started as `AdminPiiRevealCapService` — one admin, one hour/day budget, one reveal. The
 * identity read needs the SAME control with a different budget and, critically, a different
 * INCREMENT: a reveal is one disclosure, but a page of fifty names is fifty. Forking the class
 * would mean two copies of the fail-closed ordering, the UTC window arithmetic and the TTL
 * re-assertion — and the copies would drift on the day one of them learned something.
 *
 * A SUBCLASS PER CAP, not a shared singleton with a namespace argument at the call site: the
 * namespace, the two config keys and therefore the budget are properties of the CAP, not of the
 * request, and passing them per-call is how one caller ends up charging another's budget.
 *
 * FAIL CLOSED (the central invariant): if Redis is unavailable the check DENIES rather than
 * allowing — an outage can never uncap a disclosure. The denial window on a Redis error is
 * reported as `hour` (the tighter window) so the breach event is honest that a refusal happened.
 *
 * INCREMENT-BY-DISCLOSURES: `consume(adminId, n)` charges `n`, so a bulk read costs what it
 * discloses. Without that a cap on a single-subject route is bypassed by paging a list — one
 * `?limit=100` request would hand over ten times an hourly budget while spending one unit of it.
 *
 * PII-FREE: the only identity in the Redis key + logs is the opaque `admin_id` (logged as a
 * PREFIX only); no worker/payer id, no name, no value ever touches this service.
 */
export class AdminEgressCapService {
  protected readonly logger = new Logger(this.constructor.name);

  /**
   * @param namespace  Redis key prefix, e.g. `admin_pii_reveal` → `admin_pii_reveal:hour:<id>:<stamp>`.
   *                   Distinct per cap: two caps sharing a namespace share a budget by accident.
   * @param perHourKey `ServerConfig` key holding the hourly limit.
   * @param perDayKey  `ServerConfig` key holding the daily limit.
   */
  constructor(
    private readonly config: ServerConfig,
    private readonly queue: Queue,
    private readonly namespace: string,
    private readonly perHourKey: NumericServerConfigKey,
    private readonly perDayKey: NumericServerConfigKey,
  ) {}

  /**
   * Consume `increment` units against the admin's hour + day caps. Returns `{ ok:true }` only
   * when BOTH caps still have headroom AFTER this charge; otherwise `{ ok:false, window }`. A
   * Redis error DENIES (fail closed). Both counters are incremented atomically-enough (INCRBY
   * then EXPIRE) so a crash between the two cannot leave a TTL-less key (EXPIRE is re-asserted
   * on every hit).
   *
   * The HOUR cap is checked/incremented first; if it trips we return without touching the day
   * counter (the hour breach is the answer, and the request discloses nothing regardless).
   *
   * The counter advances even when the check then DENIES — deliberate, and inherited from the
   * reveal cap: this is a VELOCITY backstop, so an admin hammering past their budget must not
   * get free retries by virtue of being refused.
   *
   * `increment` must be a non-negative integer. A negative or fractional one is a caller bug
   * that would REFUND budget (or corrupt the counter), so it is refused fail-closed rather than
   * clamped — clamping would let the bug ship silently.
   */
  async consume(adminId: string, increment = 1): Promise<AdminEgressCapResult> {
    const idPrefix = adminId.slice(0, 8);
    if (!Number.isInteger(increment) || increment < 0) {
      this.logger.error(
        `${this.namespace} cap called with a non-integer/negative increment admin_id=${idPrefix}…; failing closed`,
      );
      return { ok: false, window: "hour" };
    }

    let redis: RedisCounter;
    try {
      redis = (await this.queue.client) as unknown as RedisCounter;
    } catch (err) {
      return this.denyOnRedisError(err, idPrefix, "hour");
    }

    // HOUR window.
    const hourStamp = AdminEgressCapService.utcHourStamp();
    const hourKey = `${this.namespace}:hour:${adminId}:${hourStamp}`;
    let hourCount: number;
    try {
      hourCount = await redis.incrby(hourKey, increment);
      await redis.expire(hourKey, AdminEgressCapService.secondsUntilEndOfUtcHour());
    } catch (err) {
      return this.denyOnRedisError(err, idPrefix, "hour");
    }
    if (hourCount > this.config[this.perHourKey]) {
      return { ok: false, window: "hour" };
    }

    // DAY window.
    const dayStamp = AdminEgressCapService.utcDayStamp();
    const dayKey = `${this.namespace}:day:${adminId}:${dayStamp}`;
    let dayCount: number;
    try {
      dayCount = await redis.incrby(dayKey, increment);
      await redis.expire(dayKey, AdminEgressCapService.secondsUntilEndOfUtcDay());
    } catch (err) {
      return this.denyOnRedisError(err, idPrefix, "day");
    }
    if (dayCount > this.config[this.perDayKey]) {
      return { ok: false, window: "day" };
    }

    return { ok: true };
  }

  /** Fail-closed denial on a Redis error. Logs the reason + the admin-id PREFIX only (no PII). */
  private denyOnRedisError(
    err: unknown,
    idPrefix: string,
    window: AdminEgressCapWindow,
  ): AdminEgressCapResult {
    this.logger.error(
      `admin ${this.namespace} cap Redis unavailable admin_id=${idPrefix}…; failing closed (reason: ${
        err instanceof Error ? err.message : String(err)
      })`,
    );
    return { ok: false, window };
  }

  /** UTC hour stamp `YYYYMMDDHH` (key namespace + rolling window). */
  private static utcHourStamp(now: Date = new Date()): string {
    return `${AdminEgressCapService.utcDayStamp(now)}${String(now.getUTCHours()).padStart(2, "0")}`;
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
