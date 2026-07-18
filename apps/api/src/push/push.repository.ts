import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { type Database, pushDeliveries, workerDevices, type WorkerDevice } from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/**
 * Drizzle data access for the push fan-out (ADR-0034). No business logic, no events —
 * PushService owns those.
 */
@Injectable()
export class PushRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * The devices this fan-out may deliver to, resolved from the PRODUCER's explicit id
   * list. Only rows that still hold a token are returned — a token cleared between
   * enqueue and delivery (invalidation, or another worker claiming the handset) means
   * there is nothing to deliver to, and that is the correct outcome, not an error.
   *
   * NOTE: revoked rows are NOT filtered here. `worker.logged_out_all` deliberately
   * targets devices it JUST revoked — warning them is the point — and the producer is
   * the only layer that knows that intent.
   */
  async devicesForDelivery(deviceIds: string[]): Promise<WorkerDevice[]> {
    if (deviceIds.length === 0) return [];
    return this.db
      .select()
      .from(workerDevices)
      .where(
        and(
          inArray(workerDevices.id, deviceIds),
          // A row with no token cannot be pushed to.
          isNotNull(workerDevices.pushToken),
        ),
      );
  }

  /**
   * Claim (event, device) for delivery. Returns false when a row already exists — the
   * dedupe: a re-queued or duplicated job must not push twice. Insert-first (before the
   * send) so a crash mid-send cannot produce a double delivery on retry; the row's
   * status is updated once the provider answers.
   */
  async claim(eventId: string, deviceId: string): Promise<string | null> {
    const inserted = await this.db
      .insert(pushDeliveries)
      .values({ eventId, deviceId, status: "sent" })
      .onConflictDoNothing({
        target: [pushDeliveries.eventId, pushDeliveries.deviceId],
      })
      .returning({ id: pushDeliveries.id });
    return inserted[0]?.id ?? null;
  }

  /** Record the provider's verdict. `failureReason` is a closed enum, never a body. */
  async settle(
    deliveryId: string,
    status: "sent" | "failed",
    failureReason?: string,
  ): Promise<void> {
    await this.db
      .update(pushDeliveries)
      .set({ status, failureReason: failureReason ?? null })
      .where(eq(pushDeliveries.id, deliveryId));
  }
}
