import { Inject, Injectable } from "@nestjs/common";
import { and, asc, count, countDistinct, desc, eq, inArray, lt, max, min, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { ChatSessionStatus } from "@badabhai/types";
import {
  CURRENT_PROFILE_ORDER,
  aiJobs,
  applications,
  chatMessages,
  chatSessions,
  events,
  generatedResumes,
  profilingFamilyBindings,
  profilingVoiceAnswers,
  questionPackItems,
  questionPacks,
  sessionAiCostTotals,
  workerPackAnswers,
  workerProfiles,
  workers,
  type Database,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import type { KeysetCursor } from "./admin-events.cursor";
import {
  ADMIN_JOURNEY_DETAIL_ROWS_MAX,
  ADMIN_JOURNEY_PACK_PAIRS_MAX,
  type AdminSessionAiCost,
  type AdminSessionAiJob,
  type AdminSessionAnswer,
  type AdminSessionVoiceAnswer,
} from "./admin-worker-journey.dto";
import {
  SETTLED_ANSWER_STATUSES,
  STUCK_ANSWER_STATUSES,
  type StuckAnswerStatus,
  type StuckQuestionItem,
} from "./admin-worker-journey.stuck";

/**
 * SELECT-ONLY data access for the ADMIN WORKER JOURNEY (Phase 6).
 *
 * ── THE PII BOUNDARY IS THE SELECT LIST, AGAIN — AND HERE IT IS SHARPER ─────────────────
 * `admin-entities.repository.ts` had to keep `phone_e164`/`full_name` out of a projection.
 * This module reads the profiling tables, where the sensitive columns are the worker's own
 * WORDS: `chat_messages.body_text`, `voice_notes.transcript_text`, the four
 * `worker_pack_answer.answer_*` value columns, and `conversation_state.answer_map[].value_raw`
 * ("the worker's words, verbatim"). None of them is projected anywhere in this file, and the
 * `chat_messages` / `voice_notes` tables are touched ONLY by a `count(*)` and never selected
 * from at all.
 *
 * TWO REDUCTIONS HAPPEN IN POSTGRES RATHER THAN IN JS, for exactly the reason
 * `photo_storage_key` does one table over — a value fetched into this process is one `...r`
 * spread away from a response:
 *   - `profiling_voice_answer.voice_note_id` → `has_clip` boolean. The id is a handle to the
 *     row holding `transcript_text`; returning it turns "there is a clip" into "here is where
 *     the transcript lives".
 *   - `ai_jobs.error_message` → `has_error` boolean. It is the one column on that table whose
 *     contents come from outside this codebase (same rule as `credit_ledger.payment_ref`).
 *
 * AND THE JSONB IS PROJECTED FIELD-BY-FIELD IN SQL. `conversation_state` is one blob holding
 * BOTH `ask_counts` (integers — safe, and the whole point) and `answer_map` (records carrying
 * `value_raw`). Selecting the column would pull the worker's verbatim answers into memory to
 * read two scalars off them. Instead the two scalars are extracted server-side: `ask_counts`
 * is taken as-is, and the answer map is aggregated down to `{question_key: status}` by a
 * lateral over `jsonb_array_elements`. `value_raw` never crosses the wire from Postgres.
 *
 * ── NO WRITES, EVER ─────────────────────────────────────────────────────────────────────
 * There is no insert/update/delete in this file and there must never be one.
 *
 * ── BOUNDED + INDEX-BACKED ──────────────────────────────────────────────────────────────
 * Every list is capped. The session list is keyset-paginated on `(started_at, id)` DESC over
 * `chat_sessions_worker_started_idx` (migration 0079). Per-session counts are ONE grouped
 * query for the whole page, never one query per row.
 */
@Injectable()
export class AdminWorkerJourneyRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * "Strictly older than the cursor" under DESC `(started_at, id)`.
   *
   * `lt`/`eq` on the COLUMN, never an interpolated `sql` template: the template hands the
   * value to the driver UNMAPPED, so a `Date` reaches postgres-js raw and every cursor-bearing
   * request 500s. That is not hypothetical — it is what `admin-keyset-params.test.ts` exists
   * for, and it renders identical SQL either way, so no shape test can catch it.
   */
  private static beforeSession(cursor: KeysetCursor): SQL {
    const at = new Date(cursor.occurredAt);
    return or(
      lt(chatSessions.startedAt, at),
      and(eq(chatSessions.startedAt, at), lt(chatSessions.id, cursor.id)),
    )!;
  }

  // =========================================================================
  // Funnel signals
  // =========================================================================

  /**
   * The worker's own row, reduced to what the funnel needs.
   *
   * `has_photo` is derived by an `IS NOT NULL` test IN POSTGRES — the storage key addresses a
   * face photo and is never fetched. Returns undefined for an unknown id, which the service
   * turns into a 404.
   */
  async findWorkerCore(
    id: string,
  ): Promise<{ id: string; hasPhoto: boolean; createdAt: Date } | undefined> {
    const rows = await this.db
      .select({
        id: workers.id,
        hasPhoto: sql<boolean>`${workers.photoStorageKey} IS NOT NULL`,
        createdAt: workers.createdAt,
      })
      .from(workers)
      .where(eq(workers.id, id))
      .limit(1);
    return rows[0];
  }

  /**
   * Counts + first/last for the worker-SUBJECT events the funnel reads, in one grouped pass.
   *
   * INDEX: `events_subject_idx` on `(subject_type, subject_id)`. All three of these events
   * are emitted with `subject: {subject_type: "worker", subject_id: <worker>}` — verified at
   * each emitter — which is precisely why `feed.shown` and `application.submitted` are NOT
   * here: their subject is the JOB, and the worker sits in the unindexed `actor_id`/payload.
   */
  async countWorkerSubjectEvents(
    workerId: string,
    eventNames: readonly string[],
  ): Promise<Array<{ eventName: string; n: number; firstAt: Date | null; lastAt: Date | null }>> {
    const rows = await this.db
      .select({
        eventName: events.eventName,
        n: count(),
        firstAt: min(events.occurredAt),
        lastAt: max(events.occurredAt),
      })
      .from(events)
      .where(
        and(
          eq(events.subjectType, "worker"),
          eq(events.subjectId, workerId),
          inArray(events.eventName, [...eventNames]),
        ),
      )
      .groupBy(events.eventName);

    return rows.map((r) => ({
      eventName: r.eventName,
      n: r.n,
      firstAt: r.firstAt ?? null,
      lastAt: r.lastAt ?? null,
    }));
  }

  /**
   * Attributed interview-kit downloads (journey step 7).
   *
   * The worker lives in the PAYLOAD, not in `subject_id` — the subject of that event is the
   * kit. Both halves of the WHERE are written to match `events_interview_kit_worker_idx`
   * (migration 0079) exactly: the same `event_name` literal the partial index is built on,
   * and the same `payload->>'worker_id'` expression it indexes. Change either and the query
   * silently falls back to a sequential scan of the largest table in the system.
   */
  async countInterviewKitDownloads(
    workerId: string,
  ): Promise<{ n: number; trades: number; firstAt: Date | null; lastAt: Date | null }> {
    const rows = await this.db
      .select({
        n: count(),
        // The trade slug is a reviewed, PII-free per-trade key (`^[a-z0-9_]+$`, enforced by
        // the event payload schema) — counted, never returned as a value.
        trades: sql<number>`count(distinct ${events.payload}->>'trade_key')`,
        firstAt: min(events.occurredAt),
        lastAt: max(events.occurredAt),
      })
      .from(events)
      .where(
        and(
          eq(events.eventName, "interview_kit.downloaded"),
          sql`${events.payload}->>'worker_id' = ${workerId}`,
        ),
      );

    const r = rows[0];
    return {
      n: r?.n ?? 0,
      trades: Number(r?.trades ?? 0),
      firstAt: r?.firstAt ?? null,
      lastAt: r?.lastAt ?? null,
    };
  }

  /**
   * The worker's pack answers, grouped by STATUS. The funnel numerator.
   *
   * INDEX: `wpa_worker_question_uq` on `(worker_id, pack_id, question_key)` — `worker_id`
   * leads it, so this is the same read path the table's own header names.
   */
  async packAnswerStatusCounts(
    workerId: string,
  ): Promise<Array<{ status: string; n: number; firstAt: Date | null; lastAt: Date | null }>> {
    const rows = await this.db
      .select({
        status: workerPackAnswers.status,
        n: count(),
        firstAt: min(workerPackAnswers.answeredAt),
        lastAt: max(workerPackAnswers.answeredAt),
      })
      .from(workerPackAnswers)
      .where(eq(workerPackAnswers.workerId, workerId))
      .groupBy(workerPackAnswers.status);

    return rows.map((r) => ({
      status: r.status,
      n: r.n,
      firstAt: r.firstAt ?? null,
      lastAt: r.lastAt ?? null,
    }));
  }

  /**
   * The `(pack_id, pack_version)` pairs THE WORKER'S OWN ANSWERS STAMP, with a count each.
   *
   * ⚠ THIS IS THE DENOMINATOR'S ONLY SOURCE, and the reason is in the DTO header: the
   * interview merges an occupation pack AND a universal pack, only the occupation one is
   * pinned on `chat_sessions`, and the universal one is resolved fresh from whatever is
   * `active`. Deriving the total from "the currently active pack" therefore moves a finished
   * worker's denominator whenever a pack is re-seeded. Every answer row stamps the pack
   * version that actually asked it; nothing else does.
   *
   * Ordered + capped so the fan-out below is bounded and deterministic.
   */
  async answeredPackVersions(
    workerId: string,
    limit = ADMIN_JOURNEY_PACK_PAIRS_MAX,
  ): Promise<Array<{ packId: string; packVersion: number; answerCount: number }>> {
    const rows = await this.db
      .select({
        packId: workerPackAnswers.packId,
        packVersion: workerPackAnswers.packVersion,
        answerCount: count(),
      })
      .from(workerPackAnswers)
      .where(eq(workerPackAnswers.workerId, workerId))
      .groupBy(workerPackAnswers.packId, workerPackAnswers.packVersion)
      .orderBy(asc(workerPackAnswers.packId), asc(workerPackAnswers.packVersion))
      .limit(limit);

    return rows.map((r) => ({
      packId: r.packId,
      packVersion: r.packVersion,
      answerCount: r.answerCount,
    }));
  }

  /**
   * `question_pack_item` counts for EXACTLY the given `(pack_id, pack_version)` pairs.
   *
   * A pair with no items comes back MISSING rather than as 0 — the caller reads that as "this
   * pack version was retired out from under the worker's answers" and raises a caveat, rather
   * than silently reporting a smaller denominator as fact.
   *
   * INDEX: `qpi_pack_idx` on `(pack_id, pack_version)`.
   */
  async countPackItems(
    pairs: ReadonlyArray<{ packId: string; packVersion: number }>,
  ): Promise<Array<{ packId: string; packVersion: number; itemCount: number }>> {
    if (pairs.length === 0) return [];
    const clauses = pairs
      .slice(0, ADMIN_JOURNEY_PACK_PAIRS_MAX)
      .map((p) =>
        and(
          eq(questionPackItems.packId, p.packId),
          eq(questionPackItems.packVersion, p.packVersion),
        ),
      )
      .filter((c): c is SQL => c !== undefined);

    const rows = await this.db
      .select({
        packId: questionPackItems.packId,
        packVersion: questionPackItems.packVersion,
        itemCount: count(),
      })
      .from(questionPackItems)
      .where(clauses.length === 1 ? clauses[0] : or(...clauses))
      .groupBy(questionPackItems.packId, questionPackItems.packVersion);

    return rows.map((r) => ({
      packId: r.packId,
      packVersion: r.packVersion,
      itemCount: r.itemCount,
    }));
  }

  /** How many interview sessions this worker has, whatever their status. */
  async countSessions(workerId: string): Promise<number> {
    const rows = await this.db
      .select({ n: count() })
      .from(chatSessions)
      .where(eq(chatSessions.workerId, workerId));
    return rows[0]?.n ?? 0;
  }

  /**
   * Resume stats. `has_resume` is `resume_count > 0` — the same signal
   * `AdminEntitiesRepository.findWorker` computes, taken from the same table and the same
   * `generated_resumes_worker_id_idx`, so the two admin surfaces cannot disagree about
   * whether a worker has a resume.
   */
  async resumeStats(
    workerId: string,
  ): Promise<{ n: number; rendered: number; firstAt: Date | null; lastAt: Date | null }> {
    const rows = await this.db
      .select({
        n: count(),
        // The PDF is rendered asynchronously after the text/json, so it can lag or fail on
        // its own — a resume that exists and a resume you can download are different facts.
        rendered: sql<number>`count(*) filter (where ${generatedResumes.renderStatus} = 'rendered')`,
        firstAt: min(generatedResumes.generatedAt),
        lastAt: max(generatedResumes.generatedAt),
      })
      .from(generatedResumes)
      .where(eq(generatedResumes.workerId, workerId));

    const r = rows[0];
    return {
      n: r?.n ?? 0,
      rendered: Number(r?.rendered ?? 0),
      firstAt: r?.firstAt ?? null,
      lastAt: r?.lastAt ?? null,
    };
  }

  /**
   * The worker's CURRENT profile row + how many rows they have.
   *
   * `CURRENT_PROFILE_ORDER`, never a hand-rolled `ORDER BY updated_at`: a worker has one row
   * per extraction, and recency alone hands back the empty placeholder written while the
   * ai-service was unreachable — so an admin would read a fully-profiled worker as unprofiled.
   * This is the same ordering `GET /workers/me/profile` resolves with, so the two agree.
   */
  async currentProfile(workerId: string): Promise<{
    status: string | null;
    confirmedAt: Date | null;
    createdAt: Date | null;
    updatedAt: Date | null;
    profileCount: number;
  }> {
    const [current, total] = await Promise.all([
      this.db
        .select({
          status: workerProfiles.profileStatus,
          confirmedAt: workerProfiles.confirmedAt,
          createdAt: workerProfiles.createdAt,
          updatedAt: workerProfiles.updatedAt,
        })
        .from(workerProfiles)
        .where(eq(workerProfiles.workerId, workerId))
        .orderBy(...CURRENT_PROFILE_ORDER)
        .limit(1),
      this.db
        .select({ n: count() })
        .from(workerProfiles)
        .where(eq(workerProfiles.workerId, workerId)),
    ]);

    const row = current[0];
    return {
      status: row?.status ?? null,
      confirmedAt: row?.confirmedAt ?? null,
      createdAt: row?.createdAt ?? null,
      updatedAt: row?.updatedAt ?? null,
      profileCount: total[0]?.n ?? 0,
    };
  }

  /**
   * Applications grouped by ACTION.
   *
   * The table, not `application.submitted` — that event's subject is the JOB, so a per-worker
   * count off it is unindexed. `applications` has `worker_id` as a real column.
   */
  async applicationActionCounts(
    workerId: string,
  ): Promise<Array<{ action: string; n: number; firstAt: Date | null; lastAt: Date | null }>> {
    const rows = await this.db
      .select({
        action: applications.action,
        n: count(),
        firstAt: min(applications.createdAt),
        lastAt: max(applications.createdAt),
      })
      .from(applications)
      .where(eq(applications.workerId, workerId))
      .groupBy(applications.action);

    return rows.map((r) => ({
      action: r.action,
      n: r.n,
      firstAt: r.firstAt ?? null,
      lastAt: r.lastAt ?? null,
    }));
  }

  // =========================================================================
  // Chat sessions
  // =========================================================================

  /**
   * One keyset page of a worker's sessions, newest first.
   *
   * `conversation_state` is NOT projected here — a list of sessions has no use for it, and it
   * is the column carrying the worker's verbatim answers.
   */
  async listSessions(
    workerId: string,
    // TYPED, not `string`: the column is `$type<ChatSessionStatus>()` and the DTO's
    // `z.enum(["active","ended","abandoned"])` already validates to exactly this set, so
    // `eq()` type-checks with no cast. The `as never` this replaced would have accepted any
    // string the DTO ever stopped constraining, silently.
    filter: { status?: ChatSessionStatus },
    cursor: KeysetCursor | null,
    limit: number,
  ): Promise<
    Array<{
      id: string;
      workerId: string;
      status: string;
      startedAt: Date;
      endedAt: Date | null;
      lastMessageAt: Date | null;
      packId: string | null;
      packVersion: number | null;
    }>
  > {
    const clauses: SQL[] = [eq(chatSessions.workerId, workerId)];
    if (filter.status) clauses.push(eq(chatSessions.status, filter.status));
    if (cursor) clauses.push(AdminWorkerJourneyRepository.beforeSession(cursor));

    return this.db
      .select({
        id: chatSessions.id,
        workerId: chatSessions.workerId,
        status: chatSessions.status,
        startedAt: chatSessions.startedAt,
        endedAt: chatSessions.endedAt,
        lastMessageAt: chatSessions.lastMessageAt,
        packId: chatSessions.packId,
        packVersion: chatSessions.packVersion,
      })
      .from(chatSessions)
      .where(and(...clauses))
      .orderBy(desc(chatSessions.startedAt), desc(chatSessions.id))
      .limit(limit);
  }

  /**
   * Message counts for a whole PAGE of sessions — one grouped query, never one per row.
   *
   * `count(*)` only. `chat_messages.body_text` is the raw, unmasked transcript and is not
   * selected here or anywhere else in this file.
   */
  async countMessagesBySession(sessionIds: readonly string[]): Promise<Map<string, number>> {
    if (sessionIds.length === 0) return new Map();
    const rows = await this.db
      .select({ sessionId: chatMessages.sessionId, n: count() })
      .from(chatMessages)
      .where(inArray(chatMessages.sessionId, [...sessionIds]))
      .groupBy(chatMessages.sessionId);
    return new Map(rows.map((r) => [r.sessionId, r.n]));
  }

  /**
   * SETTLED-answer counts for a whole page of sessions — one grouped query.
   *
   * ⚠ ONE DEFINITION OF `answer_count`, SHARED WITH THE DETAIL READ. This is
   * `count(distinct question_key) where status in (answered, declined)` — exactly what
   * {@link listSettledKeys} returns for a single session, so the number on the list row and the
   * number on the detail page are the same number by construction.
   *
   * It used to be a bare `count(*)`. The two agreed only because nothing writes an
   * `unanswered` row today (`packAnswerRowFor` returns null for one) and nothing writes two
   * rows for one question in a session — both properties of the current flush, neither
   * enforced by the schema, and `AdminJourneyProfilingStep.unanswered_count` exists precisely
   * because the first is expected to stop holding.
   */
  async countAnswersBySession(sessionIds: readonly string[]): Promise<Map<string, number>> {
    if (sessionIds.length === 0) return new Map();
    const rows = await this.db
      .select({
        sessionId: workerPackAnswers.chatSessionId,
        n: countDistinct(workerPackAnswers.questionKey),
      })
      .from(workerPackAnswers)
      .where(
        and(
          inArray(workerPackAnswers.chatSessionId, [...sessionIds]),
          inArray(workerPackAnswers.status, [...SETTLED_ANSWER_STATUSES]),
        ),
      )
      .groupBy(workerPackAnswers.chatSessionId);
    return new Map(
      rows.flatMap((r) => (r.sessionId === null ? [] : [[r.sessionId, r.n] as const])),
    );
  }

  /**
   * One session, WITH the two PII-free scalars extracted out of `conversation_state` in SQL.
   *
   * ⚠ `conversation_state` ITSELF IS NEVER PROJECTED. It holds `answer_map`, whose records
   * carry `value_raw` — "the worker's words, verbatim". What is taken instead:
   *
   *   ask_counts       the `question_key → times asked` map. Integers. This IS the field the
   *                    stuck-question derivation runs on, and it is in the persisted patch
   *                    (`toConversationStatePatch`) — unlike `servedQuestionKey`, which is not.
   *   answer_statuses  `answer_map` aggregated down to `{question_key: status}` by a lateral
   *                    over `jsonb_array_elements`. TWO scalar fields per record; the value
   *                    fields are never read.
   *
   * Both are guarded by a `jsonb_typeof` CASE, because `jsonb_array_elements` raises on a
   * non-array and `jsonb_object_agg` raises on a null key — and this column is loose JSONB
   * that older builds and the abandonment sweep both write.
   */
  async findSession(sessionId: string): Promise<
    | {
        id: string;
        workerId: string;
        status: string;
        startedAt: Date;
        endedAt: Date | null;
        lastMessageAt: Date | null;
        packId: string | null;
        packVersion: number | null;
        hasConversationState: boolean;
        askCounts: Record<string, number>;
        answerStatuses: Record<string, StuckAnswerStatus>;
      }
    | undefined
  > {
    const rows = await this.db
      .select({
        id: chatSessions.id,
        workerId: chatSessions.workerId,
        status: chatSessions.status,
        startedAt: chatSessions.startedAt,
        endedAt: chatSessions.endedAt,
        lastMessageAt: chatSessions.lastMessageAt,
        packId: chatSessions.packId,
        packVersion: chatSessions.packVersion,
        hasConversationState: sql<boolean>`${chatSessions.conversationState} IS NOT NULL`,
        askCounts: sql<Record<string, unknown>>`
          case when jsonb_typeof(${chatSessions.conversationState} -> 'ask_counts') = 'object'
            then ${chatSessions.conversationState} -> 'ask_counts'
            else '{}'::jsonb
          end`,
        answerStatuses: sql<Record<string, unknown>>`
          case when jsonb_typeof(${chatSessions.conversationState} -> 'answer_map') = 'array'
            then coalesce((
              select jsonb_object_agg(e ->> 'question_key', e ->> 'status')
              from jsonb_array_elements(${chatSessions.conversationState} -> 'answer_map') e
              where e ->> 'question_key' is not null and e ->> 'status' is not null
            ), '{}'::jsonb)
            else '{}'::jsonb
          end`,
      })
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId))
      .limit(1);

    const row = rows[0];
    if (!row) return undefined;

    return {
      id: row.id,
      workerId: row.workerId,
      status: row.status,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      lastMessageAt: row.lastMessageAt,
      packId: row.packId,
      packVersion: row.packVersion,
      hasConversationState: row.hasConversationState,
      askCounts: AdminWorkerJourneyRepository.narrowAskCounts(row.askCounts),
      answerStatuses: AdminWorkerJourneyRepository.narrowAnswerStatuses(row.answerStatuses),
    };
  }

  /**
   * The shape a `question_key` is allowed to have on the way OUT of this jsonb.
   *
   * ⚠ THE KEY IS AS UNTRUSTED AS THE VALUE, and it is the half that reaches the response.
   * These maps come out of `conversation_state`, which is loose jsonb written by the
   * orchestrator, by older builds and by the abandonment sweep — nothing in Postgres
   * constrains its object KEYS. They are then returned verbatim as `question_key` and as
   * `stuck.candidates[].question_key`, so a key is a value this surface publishes.
   *
   * This is the SAME filter every other reader of that column applies —
   * `AnswerRecordSchema.question_key` is `/^[a-z_]+$/` capped at 40, and
   * `qpi_question_key_chk` is the identical CHECK on the pack row the key names. A key that
   * fails it cannot be a real question, so dropping it loses nothing and keeps free text out
   * of an admin response by construction.
   */
  private static readonly QUESTION_KEY_RE = /^[a-z_]{1,40}$/;

  /**
   * jsonb → a `question_key → count` map, narrowed entry by entry.
   *
   * Clamped to a non-negative integer for the same reason the engine's `askCount` clamps: this
   * value round-trips through jsonb written by older builds, and a stored `-1` would produce a
   * negative ask pressure that ranks nonsensically.
   */
  private static narrowAskCounts(value: unknown): Record<string, number> {
    const out: Record<string, number> = {};
    if (typeof value !== "object" || value === null) return out;
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (!AdminWorkerJourneyRepository.QUESTION_KEY_RE.test(key)) continue;
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n)) continue;
      out[key] = Math.max(0, Math.trunc(n));
    }
    return out;
  }

  /** jsonb → `question_key → status`, dropping anything outside the closed key/status sets. */
  private static narrowAnswerStatuses(value: unknown): Record<string, StuckAnswerStatus> {
    const known: readonly string[] = STUCK_ANSWER_STATUSES;
    const out: Record<string, StuckAnswerStatus> = {};
    if (typeof value !== "object" || value === null) return out;
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (!AdminWorkerJourneyRepository.QUESTION_KEY_RE.test(key)) continue;
      if (typeof raw === "string" && known.includes(raw)) out[key] = raw as StuckAnswerStatus;
    }
    return out;
  }

  /**
   * A session's settled answers — KEYS AND STATUSES ONLY.
   *
   * The four `answer_*` value columns are deliberately absent from this projection and must
   * stay absent (see the DTO header). `status` already answers everything the journey asks:
   * whether the question was answered, refused, or never settled.
   */
  async listSessionAnswers(
    sessionId: string,
    limit = ADMIN_JOURNEY_DETAIL_ROWS_MAX,
  ): Promise<AdminSessionAnswer[]> {
    const rows = await this.db
      .select({
        questionKey: workerPackAnswers.questionKey,
        status: workerPackAnswers.status,
        source: workerPackAnswers.source,
        packId: workerPackAnswers.packId,
        packVersion: workerPackAnswers.packVersion,
        answeredAt: workerPackAnswers.answeredAt,
      })
      .from(workerPackAnswers)
      .where(eq(workerPackAnswers.chatSessionId, sessionId))
      // Deterministic and total, so a capped read returns a stable prefix.
      .orderBy(asc(workerPackAnswers.answeredAt), asc(workerPackAnswers.questionKey))
      .limit(limit);

    return rows.map((r) => ({
      question_key: r.questionKey,
      status: r.status,
      source: r.source,
      pack_id: r.packId,
      pack_version: r.packVersion,
      answered_at: r.answeredAt,
    }));
  }

  /**
   * A session's voice attempts, INCLUDING superseded ones.
   *
   * The supersession chain is the point: a re-record writes a new row and stamps the old one,
   * so hiding superseded rows would erase the only evidence that a worker had to repeat
   * themselves — which is the single most useful signal this table carries.
   *
   * INDEX: `pva_session_order_idx` on `(session_id, ordinal, attempt_no)` — the exact order
   * this reads in.
   */
  async listSessionVoiceAnswers(
    sessionId: string,
    limit = ADMIN_JOURNEY_DETAIL_ROWS_MAX,
  ): Promise<AdminSessionVoiceAnswer[]> {
    const rows = await this.db
      .select({
        id: profilingVoiceAnswers.id,
        questionKey: profilingVoiceAnswers.questionKey,
        attemptNo: profilingVoiceAnswers.attemptNo,
        ordinal: profilingVoiceAnswers.ordinal,
        captureStatus: profilingVoiceAnswers.captureStatus,
        transcriptStatus: profilingVoiceAnswers.transcriptStatus,
        transcriptErrorCode: profilingVoiceAnswers.transcriptErrorCode,
        durationSeconds: profilingVoiceAnswers.durationSeconds,
        supersededAt: profilingVoiceAnswers.superseded,
        supersededById: profilingVoiceAnswers.supersededById,
        purgedAt: profilingVoiceAnswers.purgedAt,
        // Reduced to a boolean IN POSTGRES. The id points at the `voice_notes` row holding
        // `transcript_text`; fetching it would put a handle to the raw transcript in this
        // process for no reason the journey has.
        hasClip: sql<boolean>`${profilingVoiceAnswers.voiceNoteId} IS NOT NULL`,
        packId: profilingVoiceAnswers.packId,
        packVersion: profilingVoiceAnswers.packVersion,
        createdAt: profilingVoiceAnswers.createdAt,
      })
      .from(profilingVoiceAnswers)
      .where(eq(profilingVoiceAnswers.sessionId, sessionId))
      .orderBy(
        asc(profilingVoiceAnswers.ordinal),
        asc(profilingVoiceAnswers.attemptNo),
        asc(profilingVoiceAnswers.id),
      )
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      question_key: r.questionKey,
      attempt_no: r.attemptNo,
      ordinal: r.ordinal,
      capture_status: r.captureStatus,
      transcript_status: r.transcriptStatus,
      transcript_error_code: r.transcriptErrorCode,
      duration_seconds: r.durationSeconds,
      superseded_at: r.supersededAt,
      superseded_by_id: r.supersededById,
      purged_at: r.purgedAt,
      has_clip: r.hasClip,
      pack_id: r.packId,
      pack_version: r.packVersion,
      created_at: r.createdAt,
    }));
  }

  /**
   * AI jobs correlated to a session.
   *
   * `job_type = 'profile_extraction'` is BOTH the index predicate
   * (`ai_jobs_extraction_session_idx` is PARTIAL on it and leads on
   * `input_ref->>'session_id'`) AND complete: it is the only job type that records a
   * `session_id` at all — transcription keys on `voice_note_id`. Dropping it would trade an
   * index scan for a sequential scan of a table with no retention policy and find nothing.
   *
   * ⚠ THE SORT IS NOT INDEX-SUPPLIED HERE, AND THAT IS FINE. `ai_jobs_extraction_session_idx`
   * is `((input_ref->>'session_id'), (input_ref->>'worker_id'), created_at DESC NULLS LAST)`.
   * This query constrains only the FIRST column, so the second is unconstrained and the index
   * cannot produce a `created_at` pathkey — the planner will scan the session's entries and
   * Sort them, whatever this ORDER BY says. The index still does the work that matters (it
   * turns a sequential scan of an unpruned table into a handful of entries), and a session's
   * extraction jobs are a handful of rows, so the Sort is free.
   *
   * `created_at desc nulls last` is spelled out anyway, for a DIFFERENT reason than the one
   * `findExtractionDedupeCandidate` has: THERE the extra `worker_id` predicate does make the
   * index ordering usable, so the `nulls_first` mismatch would cost a Sort. Here it is only so
   * the two reads of the same table order identically and neither drifts. `ai_jobs.created_at`
   * is NOT NULL today, so the null direction changes no row order in either.
   */
  async listSessionAiJobs(
    sessionId: string,
    limit = ADMIN_JOURNEY_DETAIL_ROWS_MAX,
  ): Promise<AdminSessionAiJob[]> {
    const rows = await this.db
      .select({
        id: aiJobs.id,
        jobType: aiJobs.jobType,
        status: aiJobs.status,
        modelName: aiJobs.modelName,
        realCall: aiJobs.realCall,
        inputTokens: aiJobs.inputTokens,
        outputTokens: aiJobs.outputTokens,
        totalTokens: aiJobs.totalTokens,
        costInr: aiJobs.costInr,
        // Reduced to a boolean IN POSTGRES: the message is the one column here whose contents
        // come from an external system, so it is the one whose PII-freeness cannot be vouched
        // for (the rule `credit_ledger.payment_ref` is held to).
        hasError: sql<boolean>`${aiJobs.errorMessage} IS NOT NULL`,
        createdAt: aiJobs.createdAt,
        updatedAt: aiJobs.updatedAt,
      })
      .from(aiJobs)
      .where(
        and(
          eq(aiJobs.jobType, "profile_extraction"),
          sql`${aiJobs.inputRef}->>'session_id' = ${sessionId}`,
        ),
      )
      .orderBy(sql`${aiJobs.createdAt} desc nulls last`, desc(aiJobs.id))
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      job_type: r.jobType,
      status: r.status,
      model_name: r.modelName,
      real_call: r.realCall,
      input_tokens: r.inputTokens,
      output_tokens: r.outputTokens,
      total_tokens: r.totalTokens,
      cost_inr: r.costInr,
      has_error: r.hasError,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
    }));
  }

  /**
   * This session's AI spend, or null when nothing was recorded.
   *
   * NULL, never a zeroed row: `session_ai_cost_totals` accrues only from migration 0077
   * forward with no backfill, so a missing row means "not measured", which is a different
   * fact from "cost nothing". `total_cost_inr` stays the numeric STRING drizzle returns —
   * the column is `numeric(16,6)` exactly so a running sum of fractional-paisa calls does not
   * drift, and coercing to a float at the last step would throw that away.
   */
  async sessionAiCost(sessionId: string): Promise<AdminSessionAiCost | null> {
    const rows = await this.db
      .select({
        totalCostInr: sessionAiCostTotals.totalCostInr,
        callCount: sessionAiCostTotals.callCount,
        realCallCount: sessionAiCostTotals.realCallCount,
        firstRecordedAt: sessionAiCostTotals.firstRecordedAt,
        updatedAt: sessionAiCostTotals.updatedAt,
      })
      .from(sessionAiCostTotals)
      .where(eq(sessionAiCostTotals.chatSessionId, sessionId))
      .limit(1);

    const r = rows[0];
    if (!r) return null;
    return {
      total_cost_inr: r.totalCostInr,
      call_count: r.callCount,
      real_call_count: r.realCallCount,
      first_recorded_at: r.firstRecordedAt,
      updated_at: r.updatedAt,
    };
  }

  /**
   * Every `(pack_id, pack_version)` this SESSION touched — from its settled answers AND from
   * its recorded voice attempts.
   *
   * BOTH, because they cover different questions. `worker_pack_answer` holds only what
   * SETTLED; `profiling_voice_answer` holds every question a clip was recorded against,
   * including the ones that never settled — which is exactly the population the stuck-question
   * derivation is about. Neither alone is the set of packs this interview ran.
   */
  async sessionPackVersions(
    sessionId: string,
    limit = ADMIN_JOURNEY_PACK_PAIRS_MAX,
  ): Promise<Array<{ packId: string; packVersion: number }>> {
    const [answered, voiced] = await Promise.all([
      this.db
        .select({ packId: workerPackAnswers.packId, packVersion: workerPackAnswers.packVersion })
        .from(workerPackAnswers)
        .where(eq(workerPackAnswers.chatSessionId, sessionId))
        .groupBy(workerPackAnswers.packId, workerPackAnswers.packVersion)
        .limit(limit),
      this.db
        .select({
          packId: profilingVoiceAnswers.packId,
          packVersion: profilingVoiceAnswers.packVersion,
        })
        .from(profilingVoiceAnswers)
        .where(eq(profilingVoiceAnswers.sessionId, sessionId))
        .groupBy(profilingVoiceAnswers.packId, profilingVoiceAnswers.packVersion)
        .limit(limit),
    ]);

    const seen = new Map<string, { packId: string; packVersion: number }>();
    for (const row of [...answered, ...voiced]) {
      seen.set(`${row.packId}:${row.packVersion}`, {
        packId: row.packId,
        packVersion: row.packVersion,
      });
    }
    return [...seen.values()].slice(0, limit);
  }

  /**
   * The ACTIVE universal pack head — the tail EVERY interview runs, whatever the trade.
   *
   * ⚠ WHY THIS QUERY HAS TO EXIST AT ALL. `chat_sessions.pack_id` pins only the OCCUPATION
   * pack; the universal pack is resolved fresh each turn and is never pinned. So the pack
   * pairs a session can be shown to have used — its settled answers, its voice attempts, its
   * own pin — cover the universal tail ONLY if something universal already settled or was
   * recorded. In a text-mode session abandoned in the universal block, NOTHING does: every
   * universal key in `ask_counts` then resolves to no item, and the stuck ranking is blind to
   * exactly the population it exists for.
   *
   * RESOLVED THE WAY THE ORCHESTRATOR RESOLVES IT: `PackRegistryService.loadUniversal` is
   * `resolveForOccupation(null, …)`, whose only matching binding is the `is_universal` one
   * (`pfb_universal_uq` permits exactly one row), and it then takes that family's ACTIVE pack
   * in the configured locale (`question_pack_active_uq` permits exactly one). This is the same
   * two-table question, asked directly — no registry, no Redis, no pack cache pulled into an
   * admin read path.
   *
   * ⚠ AND IT IS THE *CURRENT* ACTIVE VERSION, WHICH IS AN APPROXIMATION FOR AN OLD SESSION.
   * That is why it is used ONLY as a LAST resort — the caller puts the session's own stamped
   * pairs first, and `deriveStuckQuestion` takes the first item it sees for a key — and why
   * the result still reports `unresolved_count` for whatever this does not cover. It is
   * deliberately NOT used for the profiling DENOMINATOR, where the same substitution would
   * silently move a finished worker's progress bar on every reseed (see the DTO header).
   */
  async findActiveUniversalPack(
    locale: string,
  ): Promise<{ packId: string; packVersion: number } | null> {
    const rows = await this.db
      .select({ packId: questionPacks.packId, packVersion: questionPacks.version })
      .from(questionPacks)
      .innerJoin(
        profilingFamilyBindings,
        eq(profilingFamilyBindings.familyId, questionPacks.familyId),
      )
      .where(
        and(
          eq(profilingFamilyBindings.isUniversal, true),
          eq(questionPacks.locale, locale),
          eq(questionPacks.status, "active"),
        ),
      )
      .limit(1);

    const row = rows[0];
    return row ? { packId: row.packId, packVersion: row.packVersion } : null;
  }

  /**
   * The items of the given pack versions, reduced to what the stuck ranking needs:
   * `max_asks` (the ceiling), `display_order`, and the two flags that decide WHICH of
   * `selectItem`'s three passes serves an item — `is_mandatory` and `is_core`.
   *
   * `is_mandatory` is not optional detail: it is the difference between "one ask and the
   * engine can never serve this again" (606 of the corpus's 611 items) and "re-askable up to
   * the ceiling" (the other 5). Without it the ranking's second leg reads `max_asks` as if it
   * governed re-serves, which it does not.
   *
   * NO `prompt_text`, NO `why_text`, NO `retry_text` — the journey needs to name WHICH
   * question, not to reproduce the interview copy, and the keys are the stable identifier
   * across pack versions anyway.
   */
  async listPackItems(
    pairs: ReadonlyArray<{ packId: string; packVersion: number }>,
    limit = 1000,
  ): Promise<StuckQuestionItem[]> {
    if (pairs.length === 0) return [];
    const clauses = pairs
      .slice(0, ADMIN_JOURNEY_PACK_PAIRS_MAX)
      .map((p) =>
        and(
          eq(questionPackItems.packId, p.packId),
          eq(questionPackItems.packVersion, p.packVersion),
        ),
      )
      .filter((c): c is SQL => c !== undefined);

    const rows = await this.db
      .select({
        questionKey: questionPackItems.questionKey,
        packId: questionPackItems.packId,
        packVersion: questionPackItems.packVersion,
        displayOrder: questionPackItems.displayOrder,
        maxAsks: questionPackItems.maxAsks,
        isMandatory: questionPackItems.isMandatory,
        isCore: questionPackItems.isCore,
      })
      .from(questionPackItems)
      .where(clauses.length === 1 ? clauses[0] : or(...clauses))
      .orderBy(
        asc(questionPackItems.packId),
        asc(questionPackItems.packVersion),
        asc(questionPackItems.displayOrder),
      )
      .limit(limit);

    return rows.map((r) => ({
      questionKey: r.questionKey,
      packId: r.packId,
      packVersion: r.packVersion,
      displayOrder: r.displayOrder,
      maxAsks: r.maxAsks,
      isMandatory: r.isMandatory,
      isCore: r.isCore,
    }));
  }

  /** Distinct question keys with a TERMINAL answer row for this session (`isSettled`). */
  async listSettledKeys(sessionId: string, limit = ADMIN_JOURNEY_DETAIL_ROWS_MAX): Promise<string[]> {
    const rows = await this.db
      .select({ questionKey: workerPackAnswers.questionKey })
      .from(workerPackAnswers)
      .where(
        and(
          eq(workerPackAnswers.chatSessionId, sessionId),
          // `answered` OR `declined` — EXACTLY `isSettled`'s definition in `answer-map.ts`,
          // taken from the SHARED constant so the three readers of it cannot drift.
          // `unanswered` is deliberately excluded: it means the engine asked and moved on,
          // which is the opposite of settled.
          inArray(workerPackAnswers.status, [...SETTLED_ANSWER_STATUSES]),
        ),
      )
      .groupBy(workerPackAnswers.questionKey)
      .limit(limit);
    return rows.map((r) => r.questionKey);
  }
}
