import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  type Database,
  payerJobPostingChatSessions,
  payerJobPostingChatMessages,
  type PayerJobPostingChatSession,
  type PayerJobPostingChatMessage,
  type PayerJobPostingChatStatus,
  type NewPayerJobPostingChatMessage,
} from "@badabhai/db";
import { DATABASE } from "../../database/database.module";

/**
 * Safety bound on the per-session transcript read. Well above any realistic
 * job-posting interview (the bank is nine topics), so a normal session is returned in
 * full; it only caps a pathological session so the hydration read can never load an
 * unbounded result set. When capped, the MOST RECENT messages are kept and still
 * returned chronologically.
 */
export const JOB_POSTING_CHAT_HISTORY_MAX = 200;

/** Safety bound on the cross-device "resume this" list. */
export const JOB_POSTING_CHAT_SESSION_LIST_MAX = 50;

/**
 * Drizzle data access for the AI job-posting chat (ADR-0035).
 *
 * DATA ACCESS ONLY — no business logic, no events, no ownership DECISIONS. The
 * payer-scoping predicates are here because they belong in the WHERE clause (a
 * post-filter in the service would still fetch another payer's row), but the
 * "unknown and not-yours look identical" ruling is the service's, made by turning an
 * empty result into a neutral 404.
 */
@Injectable()
export class JobPostingChatRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async createSession(payerId: string): Promise<PayerJobPostingChatSession> {
    const [row] = await this.db
      .insert(payerJobPostingChatSessions)
      .values({ payerId, status: "active" })
      .returning();
    if (!row) throw new Error("Failed to create job-posting chat session");
    return row;
  }

  /**
   * Fetch a session BY ID AND OWNER in one predicate. Returns `undefined` for both
   * "no such session" and "belongs to another payer" — the caller cannot tell them
   * apart, which is exactly what the no-oracle 404 needs (and why this does not
   * expose a plain `findById`: an owner-less read would be a footgun for the next
   * caller).
   */
  async findOwnedSession(
    sessionId: string,
    payerId: string,
  ): Promise<PayerJobPostingChatSession | undefined> {
    const [row] = await this.db
      .select()
      .from(payerJobPostingChatSessions)
      .where(
        and(
          eq(payerJobPostingChatSessions.id, sessionId),
          eq(payerJobPostingChatSessions.payerId, payerId),
        ),
      )
      .limit(1);
    return row;
  }

  /**
   * This payer's sessions, most recently active first. `last_message_at` is NULL on a
   * session that was opened and never answered, so ordering falls back to
   * `started_at` — a brand-new session must not sort below month-old ones.
   */
  async listSessions(
    payerId: string,
    limit = JOB_POSTING_CHAT_SESSION_LIST_MAX,
  ): Promise<PayerJobPostingChatSession[]> {
    return this.db
      .select()
      .from(payerJobPostingChatSessions)
      .where(eq(payerJobPostingChatSessions.payerId, payerId))
      .orderBy(
        desc(
          sql`coalesce(${payerJobPostingChatSessions.lastMessageAt}, ${payerJobPostingChatSessions.startedAt})`,
        ),
      )
      .limit(limit);
  }

  async insertMessage(input: NewPayerJobPostingChatMessage): Promise<PayerJobPostingChatMessage> {
    const [row] = await this.db.insert(payerJobPostingChatMessages).values(input).returning();
    if (!row) throw new Error("Failed to insert job-posting chat message");
    return row;
  }

  /**
   * One session's transcript, oldest first. Bounded like the worker chat's read: take
   * the newest N, then reverse. The caller must NOT re-sort.
   */
  async listMessages(
    sessionId: string,
    limit = JOB_POSTING_CHAT_HISTORY_MAX,
  ): Promise<PayerJobPostingChatMessage[]> {
    const rows = await this.db
      .select()
      .from(payerJobPostingChatMessages)
      .where(eq(payerJobPostingChatMessages.sessionId, sessionId))
      .orderBy(desc(payerJobPostingChatMessages.createdAt))
      .limit(limit);
    return rows.reverse();
  }

  /**
   * Persist one turn's outcome: interview state, draft snapshot, status, and the
   * activity timestamp, in a single owner-scoped write.
   *
   * Last-write-wins, deliberately and with the same caveat the worker chat carries: a
   * session has ONE author typing sequentially. Cross-DEVICE resume does not change
   * that — a payer can resume the same conversation anywhere, but they are still one
   * person taking one turn at a time. Two devices posting into the same session at the
   * same instant would need optimistic concurrency; that is a real (if unlikely)
   * follow-up, not a silent assumption.
   */
  async saveTurn(
    sessionId: string,
    payerId: string,
    patch: {
      conversationState?: Record<string, unknown>;
      draft?: Record<string, unknown>;
      status?: PayerJobPostingChatStatus;
      lastMessageAt: Date;
    },
  ): Promise<void> {
    await this.db
      .update(payerJobPostingChatSessions)
      .set({
        ...(patch.conversationState !== undefined
          ? { conversationState: patch.conversationState }
          : {}),
        ...(patch.draft !== undefined ? { draft: patch.draft } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        lastMessageAt: patch.lastMessageAt,
      })
      .where(
        and(
          eq(payerJobPostingChatSessions.id, sessionId),
          eq(payerJobPostingChatSessions.payerId, payerId),
        ),
      );
  }

  /**
   * CLAIM a session for publishing — the concurrency guard, and it runs BEFORE the
   * posting is created, not after.
   *
   * WHY THE ORDER MATTERS. A payer double-clicking "publish" fires two requests that
   * both pass the service's read-then-check on status. If the status flip came after
   * `createForPayer`, both would have created a posting and only the second would have
   * lost the write — two live vacancies from one conversation, each with its own
   * `job_posting.created` on the spine. Claiming first makes that structurally
   * impossible: the `status <> 'published'` predicate is evaluated by Postgres under
   * row lock, so exactly one caller matches and the loser gets `undefined` → 409
   * having created nothing.
   *
   * The claim is released by {@link releasePublishClaim} if the create then fails.
   */
  async claimForPublish(
    sessionId: string,
    payerId: string,
    at: Date,
  ): Promise<PayerJobPostingChatSession | undefined> {
    const [row] = await this.db
      .update(payerJobPostingChatSessions)
      .set({ status: "published", endedAt: at })
      .where(
        and(
          eq(payerJobPostingChatSessions.id, sessionId),
          eq(payerJobPostingChatSessions.payerId, payerId),
          sql`${payerJobPostingChatSessions.status} <> 'published'`,
        ),
      )
      .returning();
    return row;
  }

  /** Bind the claimed session to the posting it produced. */
  async bindPublishedPosting(
    sessionId: string,
    payerId: string,
    jobPostingId: string,
  ): Promise<void> {
    await this.db
      .update(payerJobPostingChatSessions)
      .set({ publishedJobPostingId: jobPostingId })
      .where(
        and(
          eq(payerJobPostingChatSessions.id, sessionId),
          eq(payerJobPostingChatSessions.payerId, payerId),
        ),
      );
  }

  /**
   * Release a claim whose posting was never created (validation rejected the draft,
   * or `createForPayer` threw), so the payer can fix the draft and publish again.
   *
   * Guarded on `published_job_posting_id IS NULL` so it can only ever revert a claim
   * that produced nothing — it can never un-publish a session that really did create a
   * posting, even if called by mistake.
   */
  async releasePublishClaim(
    sessionId: string,
    payerId: string,
    to: PayerJobPostingChatStatus,
  ): Promise<void> {
    await this.db
      .update(payerJobPostingChatSessions)
      .set({ status: to, endedAt: null })
      .where(
        and(
          eq(payerJobPostingChatSessions.id, sessionId),
          eq(payerJobPostingChatSessions.payerId, payerId),
          isNull(payerJobPostingChatSessions.publishedJobPostingId),
        ),
      );
  }
}
