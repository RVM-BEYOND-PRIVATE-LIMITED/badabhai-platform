import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, gt, sql } from "drizzle-orm";
import { applications, chatSessions, generatedResumes, type Database } from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/**
 * The companion's own reads (ADR-0044). DB access only — every decision is in the policy
 * and the service.
 *
 * WHY NOT ChatRepository / ApplicationsRepository. The companion must never be able to write a
 * chat row (chat_messages ARE the extraction transcript and the résumé's quote source), so it
 * does not import the chat module at all; and neither module exports a repository with these
 * exact reads. A few SELECTs here keep the companion's reach to exactly what it needs — the
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
   * WHY THE REATTACH ORDER. The server reattaches any live session before it mints (#1197), so the
   * policy must look at the row a `POST /chat/session` would actually return. (Since #1744 that
   * POST, when it is an explicit redo, supersedes an early-finish leftover that already became the
   * confirmed profile, so the redo mints a fresh row.)
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
   * #1775 — the session the TRADE FORM would be served from: the worker's newest session in
   * `ChatRepository.findLatestSessionByWorker`'s order (`last_message_at DESC NULLS LAST,
   * started_at DESC`), which is exactly the read `TradeFormService.contextFor` resolves the form
   * from. Its status, close time and `form_kind`, or null.
   *
   * THE SAME ROW, NOT "THE NEWEST HANDOVER". A later session with a message (a second redo the
   * sweep then abandoned) becomes the form API's session too, and it carries no `form_kind`, so
   * `GET /profiling/form` stops serving the form. Rule 4 must not hold the companion back for a
   * form the server no longer serves.
   *
   * NEVER THE WHOLE `conversation_state`. It carries the interview's captured answers — the
   * worker's own words — and the policy needs one scalar of it, read as text.
   */
  async latestSessionFormKind(workerId: string): Promise<{
    readonly status: string;
    readonly endedAt: Date | null;
    readonly formKind: string | null;
  } | null> {
    const rows = await this.db
      .select({
        status: chatSessions.status,
        endedAt: chatSessions.endedAt,
        formKind: sql<string | null>`${chatSessions.conversationState} ->> 'form_kind'`,
      })
      .from(chatSessions)
      .where(eq(chatSessions.workerId, workerId))
      .orderBy(sql`${chatSessions.lastMessageAt} DESC NULLS LAST`, desc(chatSessions.startedAt))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * #1775 — the session the GENERAL FORM would be served from (ADR-0045): the worker's newest
   * session whose durable stamp says `general_road.handed_over = true`, newest by `started_at` —
   * exactly `ChatRepository.findLatestGeneralHandoverSession`, the read
   * `GeneralFormService.contextFor` uses, so a later chat never hides that form. Its status, close
   * time and the form's completion mark (text), or null.
   */
  async latestGeneralHandover(workerId: string): Promise<{
    readonly status: string;
    readonly endedAt: Date | null;
    readonly generalFormCompletedAt: string | null;
  } | null> {
    const rows = await this.db
      .select({
        status: chatSessions.status,
        endedAt: chatSessions.endedAt,
        generalFormCompletedAt: sql<
          string | null
        >`${chatSessions.conversationState} ->> 'general_form_completed_at'`,
      })
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.workerId, workerId),
          sql`${chatSessions.conversationState} -> 'general_road' ->> 'handed_over' = 'true'`,
        ),
      )
      .orderBy(desc(chatSessions.startedAt))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * #1775 — has the worker had a résumé GENERATED after `after`?
   *
   * The server-visible end of every form walk: the trade form's last step sends the app to the
   * building screen, which POSTs `/resume/generate`, and the general form's brief leads to extract
   * → confirm → generate. `generated_at` moves only on a generate — a re-render (the trade form's
   * safety-net refresh) leaves it alone — so a row newer than the handover means the worker came
   * out of a form. `generated_resumes_worker_generated_idx` serves it.
   */
  async resumeGeneratedAfter(workerId: string, after: Date): Promise<boolean> {
    const rows = await this.db
      .select({ id: generatedResumes.id })
      .from(generatedResumes)
      .where(and(eq(generatedResumes.workerId, workerId), gt(generatedResumes.generatedAt, after)))
      .limit(1);
    return rows.length > 0;
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
