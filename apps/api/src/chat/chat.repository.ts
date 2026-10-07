import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import {
  type Database,
  aiJobs,
  chatSessions,
  chatMessages,
  workerPackAnswers,
  workerProfiles,
  type ChatSession,
  type ChatMessage,
  type NewChatMessage,
  type NewWorkerPackAnswer,
  type WorkerPackAnswer,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";
// TYPE-ONLY: the stored summary's shape is defined once, beside its readers. No runtime edge.
import type { FreeChatSummary } from "../profiling/free-chat/free-chat-summary";

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

  /**
   * The interview's answers, as ONE multi-row INSERT (OIE Phase 8).
   *
   * UPSERT ON `wpa_worker_question_uq`, which is what makes a re-flush safe. The buffer survives
   * a rolled-back transaction and the next POST re-drives the whole flush, so this statement runs
   * a second time with the same rows — `DO UPDATE` turns that into a no-op rewrite instead of a
   * unique violation that would fail the retry the first failure exists to enable.
   *
   * IT IS ALSO THE RE-INTERVIEW SEMANTIC, not merely a retry guard. The index deliberately omits
   * `pack_version`, so a worker re-interviewed under pack v2 REPLACES their v1 answer for the
   * same `question_key` rather than accumulating a second row every reader would then have to
   * rank. Every column is overwritten, including `pack_version` itself — the row must describe
   * the interview that produced the value it now holds.
   *
   * NO `.returning()`. Nothing needs the ids, and returning twelve rows across the transaction
   * boundary is bytes spent on the path where the worker is waiting for their closing reply.
   */
  /**
   * The settled answers for one session, in the order they were answered.
   *
   * THE REVIEW SCREEN'S SOURCE, and it has to be this one rather than the Redis envelope.
   * Measured live: the engine closing the interview triggers the flush, and the flush drops the
   * Redis key the moment its transaction commits — so by the time a worker reaches a review
   * screen that exists precisely to be shown AFTER the last question, the envelope is gone. The
   * first live run returned `rows: 0` against twelve rows sitting in this table.
   *
   * Session-scoped rather than worker-scoped: `wpa_worker_question_uq` means a re-interview
   * UPDATES the same row, so filtering by worker would show a worker their answers from a
   * previous session as if they had just given them.
   */
  async listPackAnswers(sessionId: string): Promise<WorkerPackAnswer[]> {
    return this.db
      .select()
      .from(workerPackAnswers)
      .where(eq(workerPackAnswers.chatSessionId, sessionId))
      .orderBy(workerPackAnswers.answeredAt);
  }

  async insertPackAnswers(tx: Tx, rows: NewWorkerPackAnswer[]): Promise<void> {
    if (rows.length === 0) return;
    await tx
      .insert(workerPackAnswers)
      .values(rows)
      .onConflictDoUpdate({
        target: [
          workerPackAnswers.workerId,
          workerPackAnswers.packId,
          workerPackAnswers.questionKey,
        ],
        set: {
          chatSessionId: sql`excluded.chat_session_id`,
          packVersion: sql`excluded.pack_version`,
          answerText: sql`excluded.answer_text`,
          answerNumber: sql`excluded.answer_number`,
          answerBool: sql`excluded.answer_bool`,
          answerOptionKeys: sql`excluded.answer_option_keys`,
          status: sql`excluded.status`,
          source: sql`excluded.source`,
          answeredAt: sql`excluded.answered_at`,
        },
      });
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

  /**
   * The worker's LIVE session — `status = 'active'`, most recently touched — or undefined
   * when everything they hold is ended.
   *
   * Backs the server-side reattach guard in `ChatService.startSession` (#1197), and is a
   * separate query rather than a status check over {@link findLatestSessionByWorker}
   * deliberately: that method's `last_message_at DESC NULLS LAST` ordering ranks an old
   * ENDED session with messages above a newer empty active one, the status test then fails,
   * and the exact duplicate-minting the guard exists to stop continues on every later open.
   * The `status` predicate has to be in the WHERE clause, not after the ORDER BY.
   *
   * Among several active rows (the pre-guard backlog made these common), the most recently
   * TOUCHED one wins — `coalesce(last_message_at, started_at) DESC`, the same
   * activity-first principle that method's docstring argues for; an all-empty field of
   * actives falls back to newest `started_at`.
   */
  async findActiveSessionByWorker(workerId: string): Promise<ChatSession | undefined> {
    const rows = await this.db
      .select()
      .from(chatSessions)
      .where(and(eq(chatSessions.workerId, workerId), eq(chatSessions.status, "active")))
      .orderBy(sql`coalesce(${chatSessions.lastMessageAt}, ${chatSessions.startedAt}) DESC`)
      .limit(1);
    return rows[0];
  }

  /**
   * The worker's LIVE sessions, most recently touched first, at most `limit` — the voice form's
   * reattach candidates (ADR-0051): the newest one it may continue wins, so it mints a new session
   * only when none qualifies, rather than leaving a second active row beside a continuable one.
   * The same predicate and ordering as {@link findActiveSessionByWorker}.
   */
  async listActiveSessionsByWorker(workerId: string, limit: number): Promise<ChatSession[]> {
    return this.db
      .select()
      .from(chatSessions)
      .where(and(eq(chatSessions.workerId, workerId), eq(chatSessions.status, "active")))
      .orderBy(sql`coalesce(${chatSessions.lastMessageAt}, ${chatSessions.startedAt}) DESC`)
      .limit(limit);
  }

  /**
   * #1744 — has this session already become a CONFIRMED profile for this worker?
   *
   * A profile carries no session id; the link is its extraction job:
   * `worker_profiles.ai_job_id` → `ai_jobs.input_ref->>'session_id'` — the same walk
   * `ResumeRepository.pendingChatUpdate` makes. Served by `ai_jobs_extraction_session_idx`
   * (session_id, worker_id WHERE job_type = 'profile_extraction'), then the unique
   * `worker_profiles_ai_job_id_uq`. Scoped to the worker on BOTH sides, so a foreign job or a
   * foreign profile can never answer for this session.
   */
  async sessionProducedConfirmedProfile(sessionId: string, workerId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: workerProfiles.id })
      .from(aiJobs)
      .innerJoin(workerProfiles, eq(workerProfiles.aiJobId, aiJobs.id))
      .where(
        and(
          eq(aiJobs.jobType, "profile_extraction"),
          sql`${aiJobs.inputRef}->>'session_id' = ${sessionId}`,
          sql`${aiJobs.inputRef}->>'worker_id' = ${workerId}`,
          eq(workerProfiles.workerId, workerId),
          eq(workerProfiles.profileStatus, "confirmed"),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Pin the question pack this session is running — WRITE-ONCE, enforced in SQL.
   *
   * THE COLUMNS SHIPPED IN MIGRATION 0071 AND NOTHING WROTE THEM. A live interview proved it:
   * the welding pack was served for thirteen turns and `chat_sessions.pack_id` read `NULL` the
   * whole time. The orchestrator envelope — the only place the pin existed — lives in a Redis key
   * with a 24h TTL, so a worker resuming after an eviction re-ran retrieval from scratch and
   * could be handed a DIFFERENT pack. Same worker, same conversation, silently different
   * questions, and every answer already given now recorded against a pack that never asked them.
   *
   * `WHERE pack_id IS NULL` is the whole concurrency story, and it belongs in the statement
   * rather than in a read-then-write: two turns racing on one session both pass a prior `SELECT`,
   * and only one can pass this. The boolean return is therefore "I won the pin", which is what
   * makes the `profile.pack_pinned` emit exactly-once without depending on the caller to have
   * checked first.
   *
   * NOT a re-pin path. A second pack for a session is not an update, it is a contradiction; the
   * caller logs and keeps the pin Postgres already holds.
   */
  async pinPack(sessionId: string, packId: string, packVersion: number): Promise<boolean> {
    const updated = await this.db
      .update(chatSessions)
      .set({ packId, packVersion })
      .where(and(eq(chatSessions.id, sessionId), isNull(chatSessions.packId)))
      .returning({ id: chatSessions.id });
    return updated.length > 0;
  }

  /**
   * The pack this session was pinned to, if any.
   *
   * Read on exactly one path: the orchestrator finding its Redis envelope gone. That is the case
   * {@link pinPack} exists for, and reading it anywhere else would put a query on the chat hot
   * path to learn something the envelope already knows.
   */
  async findPackPin(sessionId: string): Promise<{ packId: string; packVersion: number } | null> {
    const rows = await this.db
      .select({ packId: chatSessions.packId, packVersion: chatSessions.packVersion })
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId))
      .limit(1);
    const row = rows[0];
    // Half a pin is unreachable — `chat_sessions_pack_pin_chk` rejects it — but the columns are
    // independently nullable in the type, and narrowing here is what lets the caller treat the
    // result as a whole pin rather than two maybes.
    if (!row?.packId || row.packVersion === null) return null;
    return { packId: row.packId, packVersion: row.packVersion };
  }

  /**
   * Sessions still `active` that have been quiet since before `idleSince` — the
   * abandonment sweep's work list.
   *
   * `coalesce(last_message_at, started_at)` IS THE POINT. A session that never received a
   * message has `last_message_at` NULL, and there are a great many of them: every pre-fix
   * app open called `startSession`, which always inserts (see
   * {@link findLatestSessionByWorker}). Comparing the bare column would leave every one of
   * those `active` forever — the exact rows most obviously abandoned. Falling back to
   * `started_at` sweeps them too; they carry nothing to preserve, so closing them is pure
   * cleanup.
   *
   * BOUNDED, and the caller re-ticks. A backlog drains across sweeps rather than in one
   * unbounded run — same shape as `AccountDeletionSweepProcessor`'s batch limit.
   *
   * ORDERED OLDEST-FIRST so a persistent backlog drains FIFO and no session can be starved
   * behind newer arrivals forever.
   *
   * ⚠ NO SUPPORTING INDEX YET, deliberately. This predicate wants a partial index on
   * `coalesce(last_message_at, started_at) WHERE status = 'active'`, but adding one means
   * running `db:generate`, which currently also re-proposes an unrelated
   * `job_postings.state` ALTER (see #865 — `0075`'s snapshot was never reconciled). Landing
   * that here would bundle a migration that FAILS on any DB that ran `0075`. The scan is
   * hourly, capped at {@link SWEEP_BATCH_LIMIT} rows of output, and off every request path,
   * so it is affordable meanwhile. Add the index once #865 unblocks a clean generate.
   */
  async findIdleActiveSessions(idleSince: Date, limit: number): Promise<ChatSession[]> {
    return this.db
      .select()
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.status, "active"),
          sql`coalesce(${chatSessions.lastMessageAt}, ${chatSessions.startedAt}) < ${idleSince}`,
        ),
      )
      .orderBy(sql`coalesce(${chatSessions.lastMessageAt}, ${chatSessions.startedAt}) asc`)
      .limit(limit);
  }

  /**
   * Close one session as `abandoned`, preserving the state the sweep salvaged.
   *
   * CONDITIONAL ON STILL BEING `active`, and that is the whole race guard — not a nicety.
   * The sweep reads its batch and then works it row by row, so a worker can send a message
   * (or finish the interview outright) between the read and this write. Only one of the two
   * can pass `status = 'active'`, and the boolean return is "I won", which is what stops the
   * sweep emitting an abandonment event for an interview the worker just completed.
   *
   * Mirrors {@link endSession}, deliberately — same guard, same shape, different terminal
   * status — so the two cannot drift into disagreeing about what closing a session means.
   * One difference: this does not merge back the general form's completion mark the way
   * {@link endSession} does (TD145). A general handover with its buffer alive is re-driven through
   * the flush, never abandoned; with the buffer gone, `state` is the checkpoint the sweep read,
   * mark included.
   *
   * ⚠ DOES NOT TOUCH `last_message_at`, unlike {@link endSession}. That column means "when
   * the worker last spoke", and the sweep is not the worker. Stamping it here would (a)
   * destroy the only record of how long the session had actually been quiet — the input to
   * this sweep's own predicate — and (b) make {@link findLatestSessionByWorker} rank a
   * dead session above the live one the worker is currently typing into. `ended_at` is the
   * column for "when it closed", and it is the one that moves.
   */
  async abandonSession(
    tx: Tx,
    sessionId: string,
    state: Record<string, unknown>,
    at: Date,
  ): Promise<boolean> {
    const updated = await tx
      .update(chatSessions)
      .set({ conversationState: state, status: "abandoned", endedAt: at })
      .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.status, "active")))
      .returning({ id: chatSessions.id });
    return updated.length > 0;
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
   *
   * THE GENERAL FORM'S COMPLETION MARK IS CARRIED, NOT REPLACED (TD145). The flush owns the
   * interview's state and replaces it whole — except `general_form_completed_at`, which
   * {@link markGeneralFormCompleted} writes beside it and the flush's buffer never holds. A
   * general handover whose flush failed stays `active`, the worker can finish the form against
   * it, and the re-driven flush lands here afterwards; replacing the column would erase the
   * mark, and the companion's rule 4 would then read an unfinished handover that closed after
   * his confirmation and keep him in the interview. So the existing key is merged back over the
   * flush's state IN THIS STATEMENT: Postgres re-evaluates the SET against the row it locks, so a
   * mark committed while the flush waited is kept too — a read-then-write in the service would
   * lose it. `jsonb_strip_nulls` keeps the key ABSENT when there is no mark, never `null`: the
   * mark's own write-once guard tests `-> 'general_form_completed_at' IS NULL`, which a JSON
   * `null` value would fail forever.
   */
  async endSession(
    tx: Tx,
    sessionId: string,
    state: Record<string, unknown>,
    at: Date,
  ): Promise<boolean> {
    const updated = await tx
      .update(chatSessions)
      .set({
        conversationState: sql`${JSON.stringify(state)}::jsonb || jsonb_strip_nulls(jsonb_build_object('general_form_completed_at', ${chatSessions.conversationState} -> 'general_form_completed_at'))`,
        lastMessageAt: at,
        status: "ended",
        endedAt: at,
      })
      .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.status, "active")))
      .returning({ id: chatSessions.id });
    return updated.length > 0;
  }

  /**
   * The worker's newest session that HANDED OVER TO THE GENERAL FORM (ADR-0045 §3.3) — the one
   * whose durable stamp says `general_road.handed_over = true` — or undefined.
   *
   * NOT {@link findLatestSessionByWorker}, and the difference is the defect it avoids. That read
   * picks the session with the latest MESSAGE, and a worker handed the form can open the chat
   * again before he fills it in — a companion question, a redo. "Latest session" would then be
   * the new one, which carries no stamp, and the form he was handed would 404 in his hand. The
   * predicate is in the WHERE clause for the same reason `findActiveSessionByWorker`'s is: a
   * post-hoc check on the latest row fails exactly when it matters.
   *
   * THE JSONB PREDICATE READS THE STAMP'S OWN KEY. `->>` yields text, so the comparison is with
   * the string `'true'`; a stamp written by a later build with another shape simply does not
   * match, and the caller still parses what it gets with `readGeneralRoadStamp` (strict, v1).
   *
   * ORDER: `started_at DESC` — the NEWEST HANDOVER wins, ended or not. A handover whose flush
   * failed is still `active` with the stamp on record from its checkpoint (`ended_at` NULL); ranking
   * by `ended_at` would let an OLDER, ended handover outrank it, and the form would then write the
   * old session's provenance while the new session's card stays live. Not the activity clock
   * either: a later chat must not move which handover the form belongs to.
   *
   * NO NEW INDEX. `chat_sessions_worker_id_idx` narrows to one worker's sessions — a handful — and
   * the JSONB test runs over those rows only. It is read once per form fetch and once per answer,
   * never on the chat's turn path.
   */
  async findLatestGeneralHandoverSession(workerId: string): Promise<ChatSession | undefined> {
    const rows = await this.db
      .select()
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.workerId, workerId),
          sql`${chatSessions.conversationState} -> 'general_road' ->> 'handed_over' = 'true'`,
        ),
      )
      .orderBy(desc(chatSessions.startedAt))
      .limit(1);
    return rows[0];
  }

  /**
   * Record that the worker FINISHED the general form this session handed him (ADR-0045 §5 "open
   * before flag-ON") — a sibling key, `general_form_completed_at`, merged into `conversation_state`.
   *
   * WHAT READS IT. `ChatService`'s ended-session paths (a late `POST /chat/message` and
   * `GET /chat/.../messages`) re-serve the general-form card off the durable stamp. Without this
   * mark they would keep offering "the form" to a worker who has already filled it in; with it
   * they fall back to the résumé menu. Both paths already hold the session row, so the read costs
   * nothing (`readGeneralFormCompletedAt`).
   *
   * A SIBLING, NEVER INSIDE `general_road`. The stamp is `.strict()` and versioned (`v: 1`): a key
   * added inside it would make every reader that parses it — including an older build's — fail
   * the parse and fall back to the no-skills card.
   *
   * A JSONB MERGE (`||`), NOT A REPLACE. Every other writer of this column replaces it whole
   * (`saveConversationState`, `endSession`, `abandonSession`), which is right for them — they own
   * the interview's state — and wrong here, where one key is added beside state this method did
   * not read. {@link endSession} carries THIS key across its replace (TD145, below).
   *
   * `last_message_at` IS NOT TOUCHED, and that is deliberate rather than an omission:
   * {@link findLatestSessionByWorker} ranks sessions by it, and the worker did not speak in this
   * chat. Stamping it would make a finished handover outrank the chat he is actually using.
   *
   * CONDITIONAL, AND WRITE-ONCE. Scoped to the session AND its owner (defence in depth: the id
   * came from {@link findLatestGeneralHandoverSession} for the same worker), only while the stamp
   * says it handed over, and only while the key is ABSENT — so the FIRST completion time is kept
   * and a re-submitted brief is a no-op here. Returns whether it wrote.
   *
   * A FAILED FLUSH DOES NOT ERASE IT (TD145, fixed 2026-10-01). A handover whose flush FAILED is
   * still `active`, so the form can be completed — and this key written — before the re-driven
   * flush closes the session. {@link endSession} merges an existing mark back over the state it
   * replaces, in the same UPDATE, so the card does not return and the companion's rule 4 reads
   * the form as finished. Until then the re-drive erased the key and stamped an `ended_at` after
   * the worker's confirmation, which kept him in the interview.
   */
  async markGeneralFormCompleted(sessionId: string, workerId: string, at: Date): Promise<boolean> {
    const updated = await this.db
      .update(chatSessions)
      .set({
        conversationState: sql`coalesce(${chatSessions.conversationState}, '{}'::jsonb) || jsonb_build_object('general_form_completed_at', ${at.toISOString()}::text)`,
      })
      .where(
        and(
          eq(chatSessions.id, sessionId),
          eq(chatSessions.workerId, workerId),
          sql`${chatSessions.conversationState} -> 'general_road' ->> 'handed_over' = 'true'`,
          sql`${chatSessions.conversationState} -> 'general_form_completed_at' IS NULL`,
        ),
      )
      .returning({ id: chatSessions.id });
    return updated.length > 0;
  }

  /**
   * ADR-0051 — THE SESSION THAT DECIDES whether this worker is locked into résumé mode, or
   * undefined: the worker's NEWEST session (by `started_at`) that is `ended` OR carries the
   * `free_chat_lock` key. The worker is locked iff that row exists and is NOT ended.
   *
   * WHY THIS ONE QUERY IS THE WHOLE RULE. Entering résumé mode writes the lock key onto that
   * session's row (`mergeFreeChatLock`, and every replacing writer carries it); finishing the résumé
   * — the interview, the voice form, a trade-form or general-form handover — ends a session. So the
   * newest row that is either is the latest word: a lock nobody has finished since (an abandoned
   * résumé session keeps its key) holds; a completion since releases it. Sessions that are neither —
   * an empty mint, a free chat that never entered résumé mode, a pre-ADR abandonment — say nothing
   * and are skipped by the predicate, which is IN the WHERE clause for the reason
   * {@link findActiveSessionByWorker} gives: a post-hoc test on the latest row fails exactly when it
   * matters.
   *
   * PRESENCE, NOT PARSE: `-> 'free_chat_lock' IS NOT NULL` counts a row whose stamp a later build
   * shaped differently, which errs toward the lock — today's interview, the safe side.
   *
   * ONE INDEXED READ: `chat_sessions_worker_id_idx` narrows to one worker's handful of rows, and the
   * jsonb test runs over those only. Read at a new session's open and, lazily, at the identity
   * intake's handoff — never on an ordinary turn.
   */
  async findFreeChatLockDecider(
    workerId: string,
  ): Promise<{ id: string; status: string } | undefined> {
    const rows = await this.db
      .select({ id: chatSessions.id, status: chatSessions.status })
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.workerId, workerId),
          or(
            eq(chatSessions.status, "ended"),
            sql`${chatSessions.conversationState} -> 'free_chat_lock' IS NOT NULL`,
          ),
        ),
      )
      .orderBy(desc(chatSessions.startedAt))
      .limit(1);
    return rows[0];
  }

  /**
   * ADR-0051 — record that this session entered RÉSUMÉ MODE (the lock): a sibling key,
   * `free_chat_lock: {v: 1, locked_at}`, merged into `conversation_state`.
   *
   * THE {@link markGeneralFormCompleted} SHAPE, for its reasons: a JSONB MERGE (`||`) because the
   * column holds state this method did not read; `last_message_at` UNTOUCHED because nothing the
   * worker said is recorded here; CONDITIONAL and WRITE-ONCE — the session and its owner, still
   * `active`, and the key still ABSENT — so the FIRST lock time is kept and a retried turn is a
   * no-op. The three REPLACING writers (checkpoint, flush, abandon) spread the same key from the
   * envelope (`toFreeChatStatePatch`), so none of them can erase it.
   *
   * Returns whether it wrote.
   */
  async mergeFreeChatLock(sessionId: string, workerId: string, lockedAt: string): Promise<boolean> {
    const updated = await this.db
      .update(chatSessions)
      .set({
        conversationState: sql`coalesce(${chatSessions.conversationState}, '{}'::jsonb) || jsonb_build_object('free_chat_lock', jsonb_build_object('v', 1, 'locked_at', ${lockedAt}::text))`,
      })
      .where(
        and(
          eq(chatSessions.id, sessionId),
          eq(chatSessions.workerId, workerId),
          eq(chatSessions.status, "active"),
          sql`${chatSessions.conversationState} -> 'free_chat_lock' IS NULL`,
        ),
      )
      .returning({ id: chatSessions.id });
    return updated.length > 0;
  }

  /**
   * ADR-0051 §8 (Release 2) — the worker's NEWEST session (by `started_at`) whose state CARRIES a
   * rolling free-chat summary, as its id and the raw `free_chat_summary` value — or undefined. The
   * caller parses the value (`readFreeChatSummaryValue`, strict, fails soft).
   *
   * WHO READS IT: a new session copying the summary at its greeting, a reply whose own row carries
   * none yet, and a fold whose own row carries none yet. Newest-started wins because each new
   * session inherits the summary at open and folds onto its own row, so the newest carrier holds
   * the latest text. The summary is kept indefinitely (R23) — no age bound.
   *
   * PRESENCE IN THE WHERE CLAUSE, for {@link findFreeChatLockDecider}'s reason. ONE INDEXED READ:
   * `chat_sessions_worker_id_idx` narrows to one worker's handful of rows; the jsonb test runs over
   * those only.
   */
  async findLatestFreeChatSummary(
    workerId: string,
  ): Promise<{ id: string; summary: unknown } | undefined> {
    const rows = await this.db
      .select({
        id: chatSessions.id,
        summary: sql<unknown>`${chatSessions.conversationState} -> 'free_chat_summary'`,
      })
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.workerId, workerId),
          sql`${chatSessions.conversationState} -> 'free_chat_summary' IS NOT NULL`,
        ),
      )
      .orderBy(desc(chatSessions.startedAt))
      .limit(1);
    return rows[0];
  }

  /**
   * ADR-0051 §8 (Release 2) — write a rolling free-chat summary onto THIS session's row: a sibling
   * key, `free_chat_summary: {v: 1, text, updated_at, session_id, folded_lines}`, merged into
   * `conversation_state`.
   *
   * THE {@link mergeFreeChatLock} SHAPE: a JSONB MERGE (`||`) because the column holds state this
   * method did not read, `last_message_at` UNTOUCHED because the worker said nothing here, and
   * scoped to the session AND its owner. The three REPLACING writers (checkpoint, flush, abandon)
   * carry the key the row already holds (`storedFreeChatSummary`), so none of them erases it.
   *
   * MONOTONIC, IN THE STATEMENT. It writes only when the row holds no summary, holds one stamped
   * for ANOTHER session, or holds one for this session that covers FEWER lines — so a stale fold
   * (one that outlived its lock) can never overwrite a newer one, and a repeated copy at open (0
   * over 0) is a no-op. The test is in the WHERE clause rather than a read-then-write for
   * {@link pinPack}'s reason: two writers both pass a prior read; only one can pass this. A stored
   * count that is not a JSON number reads as lower — the unreadable summary is replaced.
   *
   * NOT CONDITIONAL ON `active`, unlike the lock: a fold that lands just after the session closed
   * still belongs to the worker's record (R23), and the lock means nothing on an ended row while
   * the summary does.
   *
   * Returns whether it wrote.
   */
  async mergeFreeChatSummary(
    sessionId: string,
    workerId: string,
    summary: FreeChatSummary,
  ): Promise<boolean> {
    const stored = sql`${chatSessions.conversationState} -> 'free_chat_summary'`;
    const updated = await this.db
      .update(chatSessions)
      .set({
        conversationState: sql`coalesce(${chatSessions.conversationState}, '{}'::jsonb) || jsonb_build_object('free_chat_summary', jsonb_build_object('v', 1, 'text', ${summary.text}::text, 'updated_at', ${summary.updated_at}::text, 'session_id', ${summary.session_id}::text, 'folded_lines', ${summary.folded_lines}::int))`,
      })
      .where(
        and(
          eq(chatSessions.id, sessionId),
          eq(chatSessions.workerId, workerId),
          sql`(${stored} IS NULL OR ${stored} ->> 'session_id' IS DISTINCT FROM ${summary.session_id}::text OR CASE WHEN jsonb_typeof(${stored} -> 'folded_lines') = 'number' THEN (${stored} ->> 'folded_lines')::numeric < ${summary.folded_lines}::int ELSE true END)`,
        ),
      )
      .returning({ id: chatSessions.id });
    return updated.length > 0;
  }
}
