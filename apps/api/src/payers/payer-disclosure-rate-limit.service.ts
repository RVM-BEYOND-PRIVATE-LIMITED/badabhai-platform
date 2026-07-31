import { HttpException, HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";

/**
 * ONE message for BOTH 429 causes — cap reached AND Redis unavailable.
 *
 * ADR-0022 Amendment 3, condition C6: distinguishing "you are out of budget" from "the
 * counter store is down" hands an abuser a probe for infrastructure state (and, for the
 * batch mint, a way to tell a rejected reservation from an outage). Both are the same
 * fail-closed refusal from the caller's point of view, so they are byte-identical: same
 * status, same body. The DIAGNOSTIC difference stays where it belongs — in the server log.
 */
const NEUTRAL_THROTTLE_MESSAGE = "Too many requests; please try again later";

/** Minimal typed view of the raw Redis commands we need (BullMQ → ioredis). */
interface RedisCounter {
  incr(key: string): Promise<number>;
  incrby(key: string, increment: number): Promise<number>;
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
   *
   * `amount` (default 1) is the number of UNITS this one request consumes — the BATCH
   * knob (ADR-0022 Amendment 3, agency invite batch mint, condition C1). A request that
   * performs N chargeable actions must reserve N units in ONE atomic op, ATOMICALLY and
   * UP-FRONT, before any row is written:
   *
   *  - WHY NOT a loop of N `assertWithinHourlyCap` calls: a mid-loop Redis failure would
   *    leave a PARTIALLY reserved counter next to a partially written batch, and a
   *    catch-and-continue would silently uncap. One INCRBY is all-or-nothing.
   *  - WHY NOT charging 1 unit per batch: that turns an N-item endpoint into an N× bypass
   *    of the cap (60/hour → 60·N/hour) and inflates live-invite-code density in the code
   *    space by N×. A batch of N and N single calls MUST be indistinguishable to the
   *    counter — otherwise an attacker just alternates between the two paths.
   *  - WHY a REJECTED batch still consumes its reservation (no refund/decrement): failing
   *    CLOSED means over-counting is the safe direction — we may deny a legitimate request
   *    but never allow an extra one. It also denies a cap-probing binary search: an
   *    attacker cannot free-roll rejected requests to locate the exact remaining budget,
   *    because every attempt costs what it asked for.
   *
   * `amount === 1` keeps the exact single `INCR` every pre-existing caller has always
   * issued — byte-identical semantics for the disclosure/reach/single-mint paths.
   */
  async assertWithinHourlyCap(
    payerId: string,
    opts?: { scope?: string; cap?: number; amount?: number },
  ): Promise<void> {
    const scope = opts?.scope ?? "payer_disclosure";
    const cap = opts?.cap ?? this.config.PAYER_DISCLOSURE_MAX_PER_HOUR;
    const amount = opts?.amount ?? 1;
    const hour = PayerDisclosureRateLimit.utcHourStamp();
    const key = `ratelimit:${scope}:${payerId}:${hour}`;
    const ttl = PayerDisclosureRateLimit.secondsUntilEndOfUtcHour();

    // `amount` is always server-derived (a validated, bounded DTO field), never raw input.
    // A non-positive / non-integer value would be a programming error that could UNCAP the
    // bucket, so treat it as the fail-closed case rather than normalizing it.
    if (!Number.isInteger(amount) || amount < 1) {
      this.logger.error(
        `rate-limit called with a non-positive amount scope=${scope} payer=${payerId.slice(0, 8)}…; failing closed`,
      );
      throw new HttpException(NEUTRAL_THROTTLE_MESSAGE, HttpStatus.TOO_MANY_REQUESTS);
    }

    let count: number;
    try {
      const redis = (await this.queue.client) as unknown as RedisCounter;
      count = amount === 1 ? await redis.incr(key) : await redis.incrby(key, amount);
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
      throw new HttpException(NEUTRAL_THROTTLE_MESSAGE, HttpStatus.TOO_MANY_REQUESTS);
    }

    if (count > cap) {
      throw new HttpException(NEUTRAL_THROTTLE_MESSAGE, HttpStatus.TOO_MANY_REQUESTS);
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
