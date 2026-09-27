import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import { applications, chatSessions, type Database } from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import type { CompletionReason } from "../profiling/next-question";

/** The two `completion_reason`s a form handover's flush writes (`next-question.ts`). */
const HANDOVER_COMPLETION_REASONS = [
  "form_handoff",
  "general_form_handoff",
] as const satisfies readonly CompletionReason[];

/**
 * The companion's own three reads (ADR-0044). DB access only — every decision is in the policy
 * and the service.
 *
 * WHY NOT ChatRepository / ApplicationsRepository. The companion must never be able to write a
 * chat row (chat_messages ARE the extraction transcript and the résumé's quote source), so it
 * does not import the chat module at all; and neither module exports a repository with these
 * exact reads. Three SELECTs here keep the companion's reach to exactly what it needs — the
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
   * #1775 — the worker's newest chat session that HANDED OVER TO A FORM and closed after `after`
   * (the current profile's confirmation), as the two facts the policy needs, or null.
   *
   * A HANDOVER is any of the markers its flush writes on `conversation_state`: a trade form's
   * `form_kind`; the general road's stamp `general_road.handed_over` (ADR-0045); or either
   * `completion_reason` — the general one is the fallback `durableGeneralFormOffer` itself uses
   * when the strict, versioned stamp cannot be parsed. Matching more of them can only widen the
   * policy's `interview` answer, never hide a chat.
   *
   * CLOSED, NOT ONLY `ended`. A handover flush ends the session; a status filter of `<> 'active'`
   * also keeps a handover the sweep closed, and an active session is rule 3's to judge.
   *
   * NEVER THE WHOLE `conversation_state`. It carries the interview's captured answers — the
   * worker's own words — and the companion needs two scalars: `form_kind` and the general form's
   * completion mark, both read as text. The newest by `ended_at`, one row, on the worker's
   * sessions only (`chat_sessions_worker_id_idx`).
   */
  async latestFormHandoverClosedAfter(
    workerId: string,
    after: Date,
  ): Promise<{
    readonly formKind: string | null;
    readonly generalFormCompletedAt: string | null;
  } | null> {
    const rows = await this.db
      .select({
        formKind: sql<string | null>`${chatSessions.conversationState} ->> 'form_kind'`,
        generalFormCompletedAt: sql<
          string | null
        >`${chatSessions.conversationState} ->> 'general_form_completed_at'`,
      })
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.workerId, workerId),
          ne(chatSessions.status, "active"),
          gt(chatSessions.endedAt, after),
          or(
            sql`${chatSessions.conversationState} ->> 'form_kind' is not null`,
            sql`${chatSessions.conversationState} -> 'general_road' ->> 'handed_over' = 'true'`,
            inArray(sql`${chatSessions.conversationState} ->> 'completion_reason'`, [
              ...HANDOVER_COMPLETION_REASONS,
            ]),
          ),
        ),
      )
      .orderBy(desc(chatSessions.endedAt))
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
