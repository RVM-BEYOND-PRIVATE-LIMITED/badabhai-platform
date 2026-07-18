import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { type Database, events } from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import { NOTIFICATION_EVENT_NAMES, SECURITY_EVENT_NAMES } from "./notifications.dto";

/** The projection reads ONLY these columns — the event `payload` is deliberately
 * NOT selected, so PII-bearing payload never even enters API memory (§2 defense
 * in depth). */
export interface NotificationEventRow {
  id: string;
  eventName: string;
  occurredAt: Date;
}

/**
 * SELECT-ONLY read over the `events` spine for the worker Alerts feed. The events
 * table is APPEND-ONLY (CLAUDE.md invariant #1) — this repository never writes it.
 *
 * WORKER SCOPING: the allowlisted events reference the worker three different ways —
 * as the SUBJECT (`worker.device_registered`), as the ACTOR (`profile.confirmed`),
 * or ONLY in `payload.worker_id` (`resume.generated`, whose actor is `system`). The
 * OR covers all three, so the feed captures every allowlisted event for this worker
 * regardless of shape.
 *
 * BOUNDED: `event_name IN (...)` is index-backed (`events_event_name_idx`) and bounds
 * the scan; the worker predicate + `LIMIT` keep the result small. (Scale note:
 * `payload->>'worker_id'` and `actor_id` are not indexed — fine at alpha volume; if
 * the events table grows large, add an expression index — see tech-debt register.)
 */
@Injectable()
export class NotificationsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** The worker's OWN allowlisted events, newest first, capped at `limit`. Selects
   * ONLY id/event_name/occurred_at — never the payload. */
  async findForWorker(workerId: string, limit: number): Promise<NotificationEventRow[]> {
    return this.findByNames(workerId, NOTIFICATION_EVENT_NAMES, limit);
  }

  /**
   * The worker's OWN SECURITY events only, newest first, capped at `limit` (TD82).
   *
   * Identical scoping + projection to {@link findForWorker} — same three-leg worker OR,
   * same no-payload SELECT — narrowed to {@link SECURITY_EVENT_NAMES}. The service
   * unions this with the main feed so a burst of high-frequency events (applies) can
   * never evict an account-takeover tripwire.
   */
  async findSecurityForWorker(workerId: string, limit: number): Promise<NotificationEventRow[]> {
    return this.findByNames(workerId, SECURITY_EVENT_NAMES, limit);
  }

  /**
   * Shared read for both legs. `names` is ALWAYS a compile-time-derived subset of the
   * allowlist (never caller input), and `workerId` is always the CALLER's id from the
   * bearer token — never a path/body/payload id.
   */
  private async findByNames(
    workerId: string,
    names: readonly string[],
    limit: number,
  ): Promise<NotificationEventRow[]> {
    // Defensive: `inArray(col, [])` is a degenerate predicate. An empty name list means
    // "nothing can match", so answer that directly rather than emit an odd query.
    if (names.length === 0) return [];

    // Worker is the subject, OR the actor, OR named in the payload — cover all three.
    const forWorker: SQL = or(
      and(eq(events.subjectType, "worker"), eq(events.subjectId, workerId))!,
      and(eq(events.actorType, "worker"), eq(events.actorId, workerId))!,
      sql`${events.payload}->>'worker_id' = ${workerId}`,
    )!;

    return this.db
      .select({
        id: events.id,
        eventName: events.eventName,
        occurredAt: events.occurredAt,
      })
      .from(events)
      .where(and(inArray(events.eventName, [...names]), forWorker))
      .orderBy(desc(events.occurredAt), desc(events.id))
      .limit(limit);
  }
}
