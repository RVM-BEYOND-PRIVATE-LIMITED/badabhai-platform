import { Injectable } from "@nestjs/common";
import { NotificationsRepository } from "./notifications.repository";
import { NOTIFICATION_TEMPLATES, type WorkerNotification } from "./notifications.dto";

/** How many recent notifications to project (bounded — newest first). */
const FEED_LIMIT = 50;

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
    const rows = await this.repo.findForWorker(workerId, FEED_LIMIT);

    const out: WorkerNotification[] = [];
    for (const row of rows) {
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
