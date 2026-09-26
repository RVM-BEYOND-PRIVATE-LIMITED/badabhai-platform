import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq } from "drizzle-orm";
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
   * When the worker's NEWEST live (`status = 'active'`) chat session started, or null when none
   * is live. The policy compares it with the profile's confirmation time: a session started
   * AFTER confirmation is a deliberate new interview ("Chat se resume banayein"); one started
   * before it is the early-finish leftover the abandonment sweep will close.
   *
   * Served by `chat_sessions_worker_started_idx (worker_id, started_at DESC, id DESC)`.
   */
  async latestActiveSessionStartedAt(workerId: string): Promise<Date | null> {
    const rows = await this.db
      .select({ startedAt: chatSessions.startedAt })
      .from(chatSessions)
      .where(and(eq(chatSessions.workerId, workerId), eq(chatSessions.status, "active")))
      .orderBy(desc(chatSessions.startedAt))
      .limit(1);
    return rows[0]?.startedAt ?? null;
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
