import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import {
  type Database,
  relayMessages,
  unlocks,
  type NewRelayMessage,
  type RelayMessage,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/** A worker's thread summary, derived in SQL — no counterparty identity is selectable. */
export interface RelayThreadRow {
  unlock_id: string;
  last_message_at: Date;
  unread_count: number;
}

/**
 * Data access for `relay_messages` (E0 item 2/3). PURE data access — no business logic, no
 * event emission, no consent checks (those live in {@link RelayService} and
 * `UnlockService`'s resolution ladder).
 *
 * PII-FREE BY CONSTRUCTION: every method here reads or writes the unlock join, a direction,
 * a two-shaped body and timestamps. There is no phone, name, employer or email column to
 * select, and no method accepts one.
 */
@Injectable()
export class RelayRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async insert(input: NewRelayMessage): Promise<RelayMessage> {
    const rows = await this.db.insert(relayMessages).values(input).returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to create relay message");
    return row;
  }

  /** A thread, oldest-first (append-only ordering; `id` breaks same-instant ties). */
  async listByUnlock(unlockId: string): Promise<RelayMessage[]> {
    return this.db
      .select()
      .from(relayMessages)
      .where(eq(relayMessages.unlockId, unlockId))
      .orderBy(asc(relayMessages.createdAt), asc(relayMessages.id));
  }

  /**
   * Has the WORKER replied in this thread yet? The one fact that decides whether the payer
   * may send free text (§B: (c) for the opening message, (a) once the worker has replied).
   */
  async hasWorkerReply(unlockId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: relayMessages.id })
      .from(relayMessages)
      .where(
        and(
          eq(relayMessages.unlockId, unlockId),
          eq(relayMessages.direction, "worker_to_payer"),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Mark every unread INBOUND message in the thread read; returns how many moved.
   *
   * Inbound only, deliberately: a worker's own outbound rows are never "read by" him, and a
   * count that included them would misreport the read event.
   */
  async markInboundRead(unlockId: string): Promise<number> {
    const rows = await this.db
      .update(relayMessages)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(relayMessages.unlockId, unlockId),
          eq(relayMessages.direction, "payer_to_worker"),
          isNull(relayMessages.readAt),
        ),
      )
      .returning({ id: relayMessages.id });
    return rows.length;
  }

  /**
   * The caller's threads, newest activity first. Scoped by `unlocks.worker_id` in SQL, so
   * the caller's id is the only id that can reach the rows (never a path/body value).
   */
  async listThreadsForWorker(workerId: string): Promise<RelayThreadRow[]> {
    const lastMessageAt = sql<Date>`max(${relayMessages.createdAt})`;
    const unreadCount = sql<number>`(count(*) filter (where ${relayMessages.direction} = 'payer_to_worker' and ${relayMessages.readAt} is null))::int`;
    return this.db
      .select({
        unlock_id: relayMessages.unlockId,
        last_message_at: lastMessageAt,
        unread_count: unreadCount,
      })
      .from(relayMessages)
      .innerJoin(unlocks, eq(unlocks.id, relayMessages.unlockId))
      .where(eq(unlocks.workerId, workerId))
      .groupBy(relayMessages.unlockId)
      .orderBy(desc(lastMessageAt));
  }
}
