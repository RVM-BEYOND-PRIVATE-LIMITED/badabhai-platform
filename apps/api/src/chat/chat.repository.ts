import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  type Database,
  chatSessions,
  chatMessages,
  type ChatSession,
  type ChatMessage,
  type NewChatMessage,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/**
 * Safety bound for the per-session message-history read (the chat loop +
 * extraction transcript). Well above any realistic interview length, so a normal
 * session is returned in full; it only caps a pathological/abusive session so the
 * hot-path read can never load an unbounded result set. When capped, the MOST
 * RECENT messages are kept (recency matters for LLM context), still returned in
 * chronological order.
 */
export const CHAT_HISTORY_MAX = 500;

/**
 * A transaction executor. Typed as `Database` and cast at the `withTransaction` seam,
 * matching `AdminActionsRepository` / `ResumeDisclosureRepository`: Drizzle's real
 * `PgTransaction` is structurally compatible for every query builder we use but lacks
 * `$client`, so the narrower true type would be rejected by `EventsService.emit(…, tx)`
 * — which is exactly what has to accept it for the flush to be atomic.
 */
export type Tx = Database;

@Injectable()
export class ChatRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Run `work` inside ONE Postgres transaction.
   *
   * The flush-at-end design turns the whole interview into a single atomic write: every
   * buffered message, the final conversation state, and every event land together or
   * not at all. Half a transcript is worse than none — extraction would run on a
   * truncated conversation and mint a profile from it — so there is no partial path.
   */
  async withTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(work as (tx: unknown) => Promise<T>);
  }

  /**
   * Insert the buffered transcript in ONE round trip, in the order given.
   *
   * `created_at` is passed EXPLICITLY rather than defaulted, because the rows are
   * written at flush time but happened over the preceding minutes: defaulting would
   * stamp a 30-turn interview as thirty simultaneous messages and destroy the ordering
   * that `listMessages` and the extraction transcript both depend on.
   */
  async insertMessages(tx: Tx, rows: NewChatMessage[]): Promise<ChatMessage[]> {
    if (rows.length === 0) return [];
    return tx.insert(chatMessages).values(rows).returning();
  }

  async createSession(workerId: string): Promise<ChatSession> {
    const inserted = await this.db
      .insert(chatSessions)
      .values({ workerId, status: "active" })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error("Failed to create chat session");
    return row;
  }

  async findSession(sessionId: string): Promise<ChatSession | undefined> {
    const rows = await this.db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId))
      .limit(1);
    return rows[0];
  }

  /**
   * The worker's session with the MOST RECENT ACTIVITY — their real transcript —
   * or undefined if they have never started one. Backs the "resume my chat" read;
   * the worker id comes from the bearer (no param) → no cross-worker leak.
   *
   * ORDER BY `last_message_at DESC NULLS LAST`, THEN `started_at DESC`, NOT plain
   * `started_at`: a worker accrues EMPTY sessions (every pre-fix app open called
   * `startSession`, which always inserts a new row), and those empties have the
   * NEWEST `started_at` but NO messages (`last_message_at` NULL). Ordering by
   * `started_at` alone resumed an empty session and the Bada Bhai tab showed a
   * blank thread even though the Q&A was one session back. `last_message_at` picks
   * the session the worker actually conversed in; NULLS LAST parks the empties;
   * `started_at` breaks ties (and covers the never-messaged brand-new case).
   */
  async findLatestSessionByWorker(workerId: string): Promise<ChatSession | undefined> {
    const rows = await this.db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.workerId, workerId))
      .orderBy(sql`${chatSessions.lastMessageAt} DESC NULLS LAST`, desc(chatSessions.startedAt))
      .limit(1);
    return rows[0];
  }

  async insertMessage(input: NewChatMessage): Promise<ChatMessage> {
    const inserted = await this.db.insert(chatMessages).values(input).returning();
    const row = inserted[0];
    if (!row) throw new Error("Failed to insert chat message");
    return row;
  }

  async listMessages(sessionId: string): Promise<ChatMessage[]> {
    // Bounded hot-path read: take the most recent CHAT_HISTORY_MAX, then return
    // them in chronological order. A realistic interview is well under the cap, so
    // this is byte-identical to the old unbounded `asc` read for normal sessions.
    const rows = await this.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId))
      .orderBy(desc(chatMessages.createdAt))
      .limit(CHAT_HISTORY_MAX);
    return rows.reverse();
  }

  async touchSession(sessionId: string, at: Date): Promise<void> {
    await this.db
      .update(chatSessions)
      .set({ lastMessageAt: at })
      .where(eq(chatSessions.id, sessionId));
  }

  /**
   * Persist the interview ConversationState for a session (and touch
   * lastMessageAt in the same write). Stored as loose JSONB; the caller owns the
   * shape (ai-contracts ConversationState). Profile signals only — never PII.
   */
  async saveConversationState(
    sessionId: string,
    state: Record<string, unknown>,
    at: Date,
    tx?: Tx,
  ): Promise<void> {
    await (tx ?? this.db)
      .update(chatSessions)
      .set({ conversationState: state, lastMessageAt: at })
      .where(eq(chatSessions.id, sessionId));
  }

  /**
   * Mark a session finished, in the SAME transaction as its transcript flush.
   *
   * `ended` (the existing CHAT_SESSION_STATUSES vocabulary — no new status value, so no
   * migration and no client change) is what makes the flush idempotent at the session
   * level: a retried finalization re-reads the row, sees the status, and returns instead
   * of writing the transcript twice. The events carry their own `idempotency_key` as the
   * DB-enforced backstop (TD18), but the status check is what stops duplicate
   * `chat_messages` rows, which have no unique key to dedupe on.
   *
   * The UPDATE is CONDITIONAL on the session still being active, and that is the actual
   * race guard: two concurrent flushes both pass a prior read, but only one wins the
   * write. `endSession` returns whether it won, and the loser aborts its transaction.
   */
  async endSession(
    tx: Tx,
    sessionId: string,
    state: Record<string, unknown>,
    at: Date,
  ): Promise<boolean> {
    const updated = await tx
      .update(chatSessions)
      .set({ conversationState: state, lastMessageAt: at, status: "ended", endedAt: at })
      .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.status, "active")))
      .returning({ id: chatSessions.id });
    return updated.length > 0;
  }
}
