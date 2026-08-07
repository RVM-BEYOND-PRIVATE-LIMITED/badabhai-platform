import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { EventsService } from "../events/events.service";
import { WorkersRepository } from "../workers/workers.repository";
import type { RequestContext } from "../common/request-context";
import type { NotificationPrefs } from "./notifications.dto";

/**
 * The worker's notification STATE (#643) — the push preference and the Alerts read
 * watermark. Deliberately separate from {@link NotificationsService}, which stays a
 * pure read-only projection of the feed: this service owns the two writes, and is the
 * only place either column is mutated.
 *
 * Both values are worker-scoped NON-PII scalars on `workers`. Every method takes the
 * worker id from the CALLER's bearer token (the controller passes `@CurrentWorker`) —
 * never a path or body id, so there is no IDOR surface.
 */
@Injectable()
export class NotificationStateService {
  private readonly logger = new Logger(NotificationStateService.name);

  constructor(
    private readonly workers: WorkersRepository,
    private readonly events: EventsService,
  ) {}

  /**
   * The worker's push preference. Reads the non-PII projection, so no encrypted
   * phone or name is fetched to answer a one-boolean question.
   */
  async getPrefs(workerId: string): Promise<NotificationPrefs> {
    const state = await this.workers.findNotificationState(workerId);
    if (!state) throw new NotFoundException(`Worker ${workerId} not found`);
    return { notifications_enabled: state.notificationsEnabled };
  }

  /**
   * Flip the worker's push preference. Emits `worker.notification_prefs_updated`
   * (§1) — this IS a material state change, because the flag gates the ADR-0034 push
   * fan-out in {@link PushService.deliver}.
   *
   * Emitted on every successful write rather than only on an observed flip: the client
   * calls this from the toggle gesture and retries a previously-failed sync, so a
   * same-value write means "the worker's choice finally reached the server" — worth
   * recording. The payload carries the RESULTING value read back from the row, so the
   * event states what the database now holds, not what was asked for.
   */
  async updatePrefs(
    workerId: string,
    enabled: boolean,
    ctx: RequestContext,
  ): Promise<NotificationPrefs> {
    const updated = await this.workers.updateNotificationsEnabled(workerId, enabled);
    if (!updated) throw new NotFoundException(`Worker ${workerId} not found`);

    await this.events.emit({
      event_name: "worker.notification_prefs_updated",
      actor: { actor_type: "worker", actor_id: workerId },
      subject: { subject_type: "worker", subject_id: workerId },
      payload: {
        worker_id: workerId,
        notifications_enabled: updated.notificationsEnabled,
      },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    this.logger.log(
      `notification prefs updated for worker ${workerId} enabled=${updated.notificationsEnabled}`,
    );
    return { notifications_enabled: updated.notificationsEnabled };
  }

  /**
   * Advance the Alerts read watermark to now — POST /workers/me/notifications/read.
   *
   * NO EVENT, deliberately (§1). A read position is not a business action: it drives
   * no decision, and the Alerts feed is itself a projection OVER `events`, so writing
   * one here would grow the very table the feed scans on a purely cosmetic signal.
   * This matches the feed's own posture — `NotificationsController.list` emits nothing
   * for the same reason.
   *
   * IDEMPOTENT: the repository only ever moves the watermark FORWARD, so a repeat call
   * is a no-op that still succeeds. A `false` return means "already at least this far",
   * which is the desired end state, so it is not surfaced as an error.
   */
  async markRead(workerId: string): Promise<void> {
    // The APP clock, matching how `events.occurred_at` is stamped — the feed compares
    // the two directly when deriving `read` (see the repository method's note).
    await this.workers.advanceNotificationsReadAt(workerId, new Date());
  }
}
