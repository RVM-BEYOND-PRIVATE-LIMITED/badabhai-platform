import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from "@nestjs/common";
import type { Request } from "express";
import type { Observable } from "rxjs";
import { EventsService } from "../events/events.service";

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
 */
@Injectable()
export class WorkerActivityInterceptor implements NestInterceptor {
  /** worker_id -> the UTC day already recorded IN THIS PROCESS (a cache, not the guarantee). */
  private readonly seen = new Map<string, string>();
  /** The UTC day the cache belongs to; a rollover drops the whole map. */
  private cacheDay = WorkerActivityInterceptor.utcDay();

  constructor(private readonly events: EventsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // Non-HTTP contexts (none today, but a queue/RPC context has no request) are skipped.
    if (context.getType() !== "http") return next.handle();

    const workerId = context.switchToHttp().getRequest<Request>().worker?.id;
    if (workerId) this.recordActive(workerId);

    return next.handle();
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
