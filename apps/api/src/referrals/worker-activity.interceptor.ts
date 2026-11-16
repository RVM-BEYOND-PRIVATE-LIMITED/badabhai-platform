import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  Optional,
} from "@nestjs/common";
import type { Request } from "express";
import type { Observable } from "rxjs";
import { EventsService } from "../events/events.service";
import { istDayOf } from "../worker-activity/worker-activity";
import { WorkerActivityService } from "../worker-activity/worker-activity.service";

/**
 * §X.6 — the `worker.active` RETENTION producer. The referral chain previously went dark
 * the moment a worker installed: nothing on the spine said whether a referred worker ever
 * came back, so activation/retention (and therefore whether a paid referral was worth
 * anything) was unanswerable.
 *
 * WHY AN INTERCEPTOR, AND WHY HERE. The cheapest correct producer is "any authenticated
 * worker request": every worker session — chat, feed, resume, session refresh — passes
 * through `WorkerAuthGuard`, which attaches `req.worker`. Interceptors run AFTER guards, so
 * this sees exactly the authenticated requests and nothing else. Registered as an
 * `APP_INTERCEPTOR` provider (Nest applies such a provider GLOBALLY regardless of which
 * module declares it), so no controller, no guard, and no other module is modified.
 *
 * COST (must add no measurable latency):
 *  - Unauthenticated request → one property read, then straight through.
 *  - Authenticated, already seen today → one Map lookup, then straight through. NO DB.
 *  - Authenticated, first request of the UTC day → the emit is FIRE-AND-FORGET (never
 *    awaited), so the response is not delayed by it, and the handler runs regardless.
 *
 * CORRECTNESS (at most once per worker per UTC day):
 *  - The in-memory Map is a CACHE, not the guarantee — it is per-process and lost on
 *    restart. The guarantee is the events-table idempotency key
 *    (`worker.active:<worker_id>:<day>`), which is a UNIQUE column: a second insert for the
 *    same worker+day is an `ON CONFLICT DO NOTHING` no-op across every process and restart.
 *  - The cache is swept when the UTC day rolls over (the whole map is dropped — the keys are
 *    only ever valid for one day), so it cannot grow without bound across days. Within a
 *    day it holds one small entry per active worker, which is the intended working set.
 *
 * NEVER FAILS A REQUEST: the emit is not awaited and its rejection is swallowed. An events
 * outage degrades the retention signal — it must never degrade the worker's app.
 *
 * PII-FREE: only the opaque worker id + a `YYYY-MM-DD` bucket are recorded. Deliberately NO
 * route, session id, ip/ip_hash, or user-agent — with those this would be a per-worker
 * movement trace instead of a daily-active fact (the payload is `.strict()`, so the schema
 * enforces that rather than trusting this comment).
 *
 * #2753 — THE LAST-ACTIVE DAY, beside the event and independent of it. With
 * `WORKER_ACTIVITY_ENABLED` on, the same request also records the worker's IST day in
 * `worker_activity` (the one read of "last active" for companies and agencies). App use, an apply
 * and a reply to a company are all signed-in worker requests, so this one place covers all three.
 * Same rules as the event: fire-and-forget, never fails the request, skips the suspended token,
 * and a per-process cache keeps it to one write per worker per day. The cache is its OWN, keyed by
 * the IST day: the event's UTC-day cache, key and payload are exactly what they were, so the
 * retention signal cannot move when the switch does. Off, this half does nothing at all.
 */
@Injectable()
export class WorkerActivityInterceptor implements NestInterceptor {
  /** worker_id -> the UTC day already recorded IN THIS PROCESS (a cache, not the guarantee). */
  private readonly seen = new Map<string, string>();
  /** The UTC day the cache belongs to; a rollover drops the whole map. */
  private cacheDay = WorkerActivityInterceptor.utcDay();
  /** #2753 — worker_id -> the IST day already written to `worker_activity` IN THIS PROCESS. */
  private readonly seenIst = new Map<string, string>();
  /** The IST day `seenIst` belongs to; a rollover drops the whole map. */
  private istCacheDay = istDayOf(new Date());

  constructor(
    private readonly events: EventsService,
    // #2753 — optional only so a hand-built instance compiles; ReferralAttributionModule imports
    // WorkerActivityModule, so Nest always injects it (worker-activity.module.test.ts pins that).
    @Optional() private readonly activity?: WorkerActivityService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // Non-HTTP contexts (none today, but a queue/RPC context has no request) are skipped.
    if (context.getType() !== "http") return next.handle();

    const worker = context.switchToHttp().getRequest<Request>().worker;
    // #2701 — a restricted SUSPENDED DPDP token is not activity. It exists only to reach a
    // DPDP exit, so it must not emit `worker.active` (retention) or seed the daily cache.
    // #2753 — nor does it record a last-active day: it would clear his "not recently active" mark.
    if (worker?.id && worker.scope === undefined) {
      this.recordActive(worker.id);
      this.recordActiveDay(worker.id);
    }

    return next.handle();
  }

  /**
   * #2753 — fire-and-forget IST-day write, at most once per worker per IST day per process. The
   * switch is checked first, so with it off not even the cache is touched.
   */
  private recordActiveDay(workerId: string): void {
    if (this.activity?.enabled !== true) return;
    const day = istDayOf(new Date());
    if (day !== this.istCacheDay) {
      this.seenIst.clear();
      this.istCacheDay = day;
    }
    if (this.seenIst.get(workerId) === day) return;
    // Marked before the write, as the event is: a burst must not fire N inserts. A failed write
    // loses the day for this process only; the next process, or tomorrow, writes again.
    this.seenIst.set(workerId, day);
    this.activity.touch(workerId, day);
  }

  /** Fire-and-forget daily-active record. Synchronous cache check, async emit, never throws. */
  private recordActive(workerId: string): void {
    const day = WorkerActivityInterceptor.utcDay();
    if (day !== this.cacheDay) {
      // Day rolled over — every cached entry is stale by definition.
      this.seen.clear();
      this.cacheDay = day;
    }
    if (this.seen.get(workerId) === day) return; // already recorded this process/day

    // Mark BEFORE emitting: a burst of concurrent requests must not fire N emits. If the
    // emit then fails, the day's signal is lost for this process — an acceptable trade for
    // an observability side-signal that must never add load or latency to the hot path.
    this.seen.set(workerId, day);

    void this.events
      .emit({
        event_name: "worker.active",
        actor: { actor_type: "worker", actor_id: workerId },
        subject: { subject_type: "worker", subject_id: workerId },
        payload: { worker_id: workerId, day },
        // THE guarantee: unique per worker per UTC day, across processes and restarts.
        idempotencyKey: `worker.active:${workerId}:${day}`,
      })
      .catch(() => undefined);
  }

  /** UTC day bucket `YYYY-MM-DD` (matches the payload's schema). */
  private static utcDay(now: Date = new Date()): string {
    return now.toISOString().slice(0, 10);
  }
}
