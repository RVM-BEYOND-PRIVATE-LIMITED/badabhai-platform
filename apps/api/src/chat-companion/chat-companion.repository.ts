import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, sql } from "drizzle-orm";
import { applications, chatSessions, type Database } from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/**
 * The companion's own two reads (ADR-0044). DB access only — every decision is in the policy
 * and the service.
 *
 * WHY NOT ChatRepository / ApplicationsRepository. The companion must never be able to write a
 * chat row (chat_messages ARE the extraction transcript and the résumé's quote source), so it
 * does not import the chat module at all; and neither module exports a repository with these
 * exact reads. Two SELECTs here keep the companion's reach to exactly what it needs — the
 * `ResumeRepository.pendingChatUpdate` precedent of reading a table directly to avoid a module
 * edge. There is no insert, update or delete in this file, and a test pins that.
 */
@Injectable()
export class ChatCompanionRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * The worker's live (`status = 'active'`) chat session that `POST /chat/session` would REATTACH
   * to — the same row and the same order as `ChatRepository.findActiveSessionByWorker`
   * (`coalesce(last_message_at, started_at) DESC`) — as its two clocks, or null when none is live.
   *
   * WHY THE REATTACH ORDER. The server reattaches any live session before it mints (#1197), so
   * the policy must look at the row a `POST /chat/session` would actually return. Since #1744 an
   * early-finish session is closed when its profile is confirmed, so a redo mints a fresh row.
   *
   * The two columns are read as mapped timestamps (not a raw `coalesce(...)` projection) so the
   * driver hands back `Date`s; the policy takes the later of the two.
   */
  async latestActiveSession(
    workerId: string,
  ): Promise<{ readonly startedAt: Date; readonly lastMessageAt: Date | null } | null> {
    const rows = await this.db
      .select({ startedAt: chatSessions.startedAt, lastMessageAt: chatSessions.lastMessageAt })
      .from(chatSessions)
      .where(and(eq(chatSessions.workerId, workerId), eq(chatSessions.status, "active")))
      .orderBy(sql`coalesce(${chatSessions.lastMessageAt}, ${chatSessions.startedAt}) DESC`)
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * How many jobs the worker has applied to — every decision row with `action = 'applied'`,
   * legacy (`job_id`) and V1 (`job_posting_id`) alike, uncapped. The partial index
   * `applications_applied_idx (worker_id, job_id) WHERE action = 'applied'` serves it.
   */
  async countApplied(workerId: string): Promise<number> {
    const rows = await this.db
      .select({ n: count() })
      .from(applications)
      .where(and(eq(applications.workerId, workerId), eq(applications.action, "applied")));
    return Number(rows[0]?.n ?? 0);
  }
}
