import { Injectable } from "@nestjs/common";
import { NotificationsRepository, type NotificationEventRow } from "./notifications.repository";
import { NOTIFICATION_TEMPLATES, type WorkerNotification } from "./notifications.dto";

/** How many recent notifications to project (bounded — newest first). */
const FEED_LIMIT = 50;

/**
 * How many of the newest SECURITY events are RESERVED, on top of the main feed (TD82).
 *
 * The main feed is newest-first and capped, so a burst of high-frequency events could
 * evict a security alert. `application.submitted` (2026-07-17) is the first
 * high-frequency, per-worker-unbounded event in the feed and rides a swipe surface built
 * for rapid tapping (ADR-0009) — so a worker applying to enough jobs in one session could
 * push an account-takeover tripwire out of the window. Silently: there is no pagination
 * and no server-side read state, so an evicted alert is never seen, never badged, and
 * unreachable — a degraded security channel is indistinguishable from a quiet one.
 *
 * A small fixed reserve is enough because these events are naturally rare (per device
 * registration, per logout-all). Fixed rather than unbounded so the response stays
 * predictable even if device registrations are ever spammed.
 */
const SECURITY_SLOTS = 10;

/**
 * Projects the worker's OWN recent events into faceless notification rows. The copy
 * comes from the static {@link NOTIFICATION_TEMPLATES} (keyed by event name) — the
 * event payload is NEVER read into the response, so the projection is PII-FREE by
 * construction (no employer, no pay, no name/phone/worker_id).
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly repo: NotificationsRepository) {}

  /**
   * The worker's Alerts feed, newest first. DELIBERATELY NO EVENT: a read-only
   * projection is not a material state change (CLAUDE.md §1).
   */
  async getForWorker(workerId: string): Promise<WorkerNotification[]> {
    // TWO LEGS (TD82): the main capped feed, plus a reserved read of the newest security
    // events so they can never be evicted by a burst of applies. Both are scoped to the
    // CALLER's id and share the same no-payload projection.
    const [feed, security] = await Promise.all([
      this.repo.findForWorker(workerId, FEED_LIMIT),
      this.repo.findSecurityForWorker(workerId, SECURITY_SLOTS),
    ]);

    // Dedupe by event id — a security event inside the newest 50 appears in BOTH legs.
    const byId = new Map<string, NotificationEventRow>();
    for (const row of [...feed, ...security]) byId.set(row.id, row);

    // Re-sort the merged set newest-first, replicating the repository's tiebreak
    // (occurred_at DESC, id DESC) so ordering stays stable and identical to one leg.
    const merged = [...byId.values()].sort((a, b) => {
      const delta = b.occurredAt.getTime() - a.occurredAt.getTime();
      return delta !== 0 ? delta : (b.id > a.id ? 1 : b.id < a.id ? -1 : 0);
    });

    const out: WorkerNotification[] = [];
    for (const row of merged) {
      const template = NOTIFICATION_TEMPLATES[row.eventName];
      // Defensive: only allowlisted (templated) events can surface. The repository
      // already filters to these names; a miss here would be a config drift, so skip.
      if (!template) continue;
      out.push({
        id: row.id,
        type: template.type,
        title: template.title,
        body: template.body,
        created_at: row.occurredAt.toISOString(),
      });
    }
    return out;
  }
}
