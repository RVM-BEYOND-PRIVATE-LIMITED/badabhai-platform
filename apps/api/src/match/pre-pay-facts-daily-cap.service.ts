import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import type { PayloadInputOf } from "@badabhai/event-schema";
import { SERVER_CONFIG } from "../config/config.module";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import type { TenantKey } from "../payers/payer-tenant-scope";
import { REACH_WIDEN_EXPIRY_QUEUE } from "../queue/queue.constants";

/** India Standard Time is UTC+5:30 all year (no daylight saving). */
const IST_OFFSET_MS = 330 * 60 * 1000;

/** The IST calendar day `YYYY-MM-DD` that `now` falls in. The cap resets at IST midnight. */
export function istDayOf(now: Date): string {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Seconds the day's keys live: to the next IST midnight, plus an hour so a request that straddles
 * midnight never finds its own day's set already gone. The NEXT day uses new keys, so the extra
 * hour never extends a cap into the following day.
 */
export function secondsToKeepIstDay(now: Date): number {
  const shifted = now.getTime() + IST_OFFSET_MS;
  const nextMidnightShifted = (Math.floor(shifted / 86_400_000) + 1) * 86_400_000;
  return Math.ceil((nextMidnightShifted - shifted) / 1000) + 3600;
}

/**
 * ONE atomic step per search page (#2838). Atomic so two pages of the same company running at
 * once cannot both read "299 seen" and both admit a new worker past the cap.
 *
 * KEYS[1] the day's set of distinct workers shown with facts, KEYS[2] the day's page counter,
 * KEYS[3] / KEYS[4] the "half" / "cap" alert markers. ARGV[1] the cap, ARGV[2] the TTL in seconds,
 * ARGV[3..] the page's workers whose facts would be shown, in page order.
 *
 * A worker already in the set is admitted again (re-reading the same person costs nothing); a new
 * one is admitted only while the set is below the cap. Each marker is set at most once a day, so
 * each alert fires at most once per company per day. Returns
 * `{distinct, pages, halfAlert, capAlert, {admitted ids}}`.
 */
export const DAILY_FACTS_CAP_SCRIPT = `
local cap = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local pages = redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], ttl)
local n = redis.call('SCARD', KEYS[1])
local admitted = {}
for i = 3, #ARGV do
  local id = ARGV[i]
  if redis.call('SISMEMBER', KEYS[1], id) == 1 then
    admitted[#admitted + 1] = id
  elseif n < cap then
    redis.call('SADD', KEYS[1], id)
    n = n + 1
    admitted[#admitted + 1] = id
  end
end
if n > 0 then
  redis.call('EXPIRE', KEYS[1], ttl)
end
local half = 0
local full = 0
if n * 2 >= cap and redis.call('SET', KEYS[3], '1', 'NX', 'EX', ttl) then
  half = 1
end
if n >= cap and redis.call('SET', KEYS[4], '1', 'NX', 'EX', ttl) then
  full = 1
end
return {n, pages, half, full, admitted}
`;

/** Minimal typed view of the raw Redis command we need (BullMQ → ioredis). */
interface RedisEval {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/** What one page's step returned, parsed and checked. */
export interface DailyFactsCapStep {
  readonly distinct: number;
  readonly pages: number;
  readonly halfAlert: boolean;
  readonly capAlert: boolean;
  readonly admitted: ReadonlySet<string>;
}

/** Who searched, for the alert event's actor and correlation. */
export interface SearchCapCaller {
  readonly actorPayerId: string;
  readonly ctx: RequestContext;
}

/**
 * #2838 (ADR-0064 §4) — the per-company DAILY cap on how many DISTINCT workers the all-candidates
 * search shows pre-pay facts for (first name, trade, area, expected salary, …), and the alert on
 * a company's search volume. The condition for `APPLICANT_FACTS_ROLLOUT=on`.
 *
 *  - PER COMPANY: keyed on the tenant key (the org anchor), so every login of one company shares
 *    one count. The per-login hourly page cap still applies on top.
 *  - DISTINCT WORKERS, PER IST DAY: a worker shown once today costs nothing to show again today;
 *    the count resets at IST midnight.
 *  - SEARCH ONLY (owner ruling, 19 Nov 2026): the applicant lists are not capped — those workers
 *    applied to this company.
 *  - OVER THE CAP the row stays and the facts read "not given": the cap limits what is SHOWN,
 *    never who is listed.
 *  - FAIL CLOSED: a Redis error, a malformed reply or a missing client admits NOBODY new or old —
 *    every fact on the page reads "not given" — and the search itself still answers.
 *  - ALERTS (owner ruling, 19 Nov 2026): `payer.candidate_search_volume_alert` once per company
 *    per IST day when the distinct count reaches half the cap, and once when it reaches the cap.
 *    Best-effort: a failed emit is logged and never changes what the page shows. The event is
 *    PII-free (the company's anchor id, counts and the day).
 *
 * Worker ids are opaque uuids, stored lower-cased in a set that expires with the day; nothing
 * else about a worker is written.
 */
@Injectable()
export class PrePayFactsDailyCapService {
  private readonly logger = new Logger(PrePayFactsDailyCapService.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    // Any registered queue's client is the app's one Redis connection; MatchModule registers this one.
    @InjectQueue(REACH_WIDEN_EXPIRY_QUEUE) private readonly queue: Queue,
    private readonly events: EventsService,
  ) {}

  /**
   * Count this page against the company's day and return the workers (lower-cased ids) whose facts
   * may be shown. `workerIds` are the page's workers that WOULD get facts, in page order. Never
   * throws: any failure returns the empty set (every fact "not given").
   */
  async admit(
    tenantKey: TenantKey,
    workerIds: readonly string[],
    caller: SearchCapCaller,
    now: Date = new Date(),
  ): Promise<ReadonlySet<string>> {
    const cap = this.config.APPLICANT_FACTS_SEARCH_DAILY_DISTINCT_CAP;
    const day = istDayOf(now);
    let step: DailyFactsCapStep;
    try {
      step = await this.step(tenantKey, day, cap, workerIds, now);
    } catch (err) {
      this.logger.error(
        `pre-pay facts daily cap unavailable for tenant=${tenantKey.slice(0, 8)}…; facts not given on this page (reason: ${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      return new Set();
    }
    if (step.halfAlert) await this.alert("half", tenantKey, day, cap, step, caller);
    if (step.capAlert) await this.alert("cap", tenantKey, day, cap, step, caller);
    return step.admitted;
  }

  private async step(
    tenantKey: TenantKey,
    day: string,
    cap: number,
    workerIds: readonly string[],
    now: Date,
  ): Promise<DailyFactsCapStep> {
    const ids = [...new Set(workerIds.map((id) => id.toLowerCase()))];
    const base = `prepay_facts:${tenantKey}:${day}`;
    const redis = (await this.queue.client) as unknown as RedisEval;
    const reply = await redis.eval(
      DAILY_FACTS_CAP_SCRIPT,
      4,
      `${base}:workers`,
      `${base}:pages`,
      `${base}:alert:half`,
      `${base}:alert:cap`,
      String(cap),
      String(secondsToKeepIstDay(now)),
      ...ids,
    );
    return parseStep(reply, ids);
  }

  private async alert(
    level: "half" | "cap",
    tenantKey: TenantKey,
    day: string,
    cap: number,
    step: DailyFactsCapStep,
    caller: SearchCapCaller,
  ): Promise<void> {
    try {
      await this.events.emit({
        event_name: "payer.candidate_search_volume_alert",
        actor: { actor_type: "payer", actor_id: caller.actorPayerId },
        subject: { subject_type: "payer", subject_id: tenantKey },
        payload: {
          payer_id: tenantKey,
          level,
          day,
          cap,
          distinct_workers: step.distinct,
          pages: step.pages,
        } satisfies PayloadInputOf<"payer.candidate_search_volume_alert">,
        correlationId: caller.ctx.correlationId,
        requestId: caller.ctx.requestId,
        idempotencyKey: `payer.candidate_search_volume_alert:${tenantKey}:${day}:${level}`,
      });
    } catch (err) {
      this.logger.error(
        `could not record payer.candidate_search_volume_alert level=${level} tenant=${tenantKey.slice(0, 8)}… (reason: ${
          err instanceof Error ? err.name : "unknown"
        })`,
      );
    }
  }
}

/**
 * Parse the script's reply. Anything unexpected throws, which the caller turns into "admit
 * nobody". An admitted id the page did not send is dropped: the reply can only narrow.
 */
export function parseStep(reply: unknown, sent: readonly string[]): DailyFactsCapStep {
  if (!Array.isArray(reply) || reply.length !== 5) throw new Error("malformed cap reply");
  const [distinct, pages, half, full, admitted] = reply as unknown[];
  const ints = [distinct, pages, half, full];
  if (!ints.every((v) => typeof v === "number" && Number.isInteger(v) && v >= 0)) {
    throw new Error("malformed cap reply");
  }
  if (!Array.isArray(admitted) || !admitted.every((v) => typeof v === "string")) {
    throw new Error("malformed cap reply");
  }
  const allowed = new Set(sent);
  return {
    distinct: distinct as number,
    pages: pages as number,
    halfAlert: half === 1,
    capAlert: full === 1,
    admitted: new Set((admitted as string[]).filter((id) => allowed.has(id))),
  };
}
