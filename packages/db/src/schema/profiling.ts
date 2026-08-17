/**
 * The voice profiling form's durable spine (migration 0071).
 *
 * TWO TABLES, AND THEY ANSWER TWO DIFFERENT QUESTIONS.
 *
 *   worker_attributes        WHAT the worker told us. The settled value. Matchable.
 *   profiling_voice_answer   HOW we learned it. One row per recorded clip. The audit.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY `worker_attributes` EXISTS AT ALL
 *
 * 359 of the 466 authored pack items — 77% — are `target_kind: "attribute"`, and until this
 * migration they had **nowhere to land**. `answer-map-projector.ts` projects only `rfs` fields,
 * through `FIELD_CROSSWALK`; its own comment says so ("No entry = not an RFS field... Both write
 * nothing"). There was no `worker_attributes` table, and nothing outside `apps/api/src/profiling/`
 * read the answer map. A worker answered `workplace_type`, `tools_owned`, `safety_training` and the
 * value was captured, normalized, carried through the interview — and dropped at projection.
 *
 * That was survivable while the engine was dark. It is not survivable in a VOICE form: those are
 * the questions a worker speaks aloud in a noisy yard, each one a paid provider call, and 8-9 of a
 * ~13-question session are attribute-kind. Discarding them costs money, costs the worker's time,
 * and throws away exactly the signals CLAUDE.md §2 says to rank on — `workplace_type` (100 items),
 * `tools_owned` (59), `safety_training` (17), `shift_work` (14).
 *
 * `tools_owned` WAS 99 AND IS NOW 59, deliberately. Phase 6 (#615) stamped one shared four-question
 * block onto every cluster it could not differentiate, so a cashier, a ward attendant and a bus
 * driver were all asked "Kya aapke paas apne auzaar hain?" — a question with no referent in their
 * work. Forty packs were cut to v2 with the item removed; it stays in the 59 skilled trades where a
 * worker really does arrive with a kit and contractors really do choose on it. Counting a signal
 * that 40 packs could not produce honestly is what made it look stronger than it was.
 *
 * WHY A TABLE RATHER THAN JSONB ON `worker_profiles`. The 80 distinct attribute keys are matching
 * inputs, not display fields. A row per (worker, attribute) is what lets the matcher filter on
 * `attribute_key = 'forklift' AND value_bool` with a plain index, carries per-value provenance and
 * timing, and survives a re-interview by UPDATE rather than by rewriting a blob. A JSONB column
 * would have made every one of those a GIN-scan or an application-side filter.
 *
 * ---------------------------------------------------------------------------------------------
 * PRIVACY
 *
 * Neither table holds identity PII. `worker_attributes` holds trade facts (the same class as
 * `worker_profiles`); `profiling_voice_answer` holds opaque ids, a question key, and status — never
 * a transcript. The transcript stays on `voice_notes.transcript_text`, which is the one row the
 * DSAR erase leg already knows how to reach. Both tables are locked by the platform posture
 * (ENABLE + FORCE + REVOKE ALL, zero policies) — see migration 0071's tail.
 */
import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  pgTable,
  uuid,
  text,
  integer,
  smallint,
  boolean,
  numeric,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import type {
  AttributeValueKind,
  ProfileValueSource,
  VoiceCaptureStatus,
  VoiceTranscriptStatus,
} from "@badabhai/types";

import { workers } from "./worker";
import { chatSessions, voiceNotes } from "./chat";

// ===========================================================================
// worker_attributes — the settled value of an `attribute`-kind answer
// ===========================================================================

/**
 * ONE LIVE ROW PER (worker, attribute_key). A re-interview UPDATEs; it does not accumulate.
 *
 * The history of *how* a value changed lives where history belongs — the answer map's own
 * `history[]` (superseded entries, newest first) and `profiling_voice_answer`. Duplicating it here
 * would give the matcher two rows for `forklift` and no rule for which one is true.
 *
 * FOUR VALUE COLUMNS, ONE POPULATED, AND A CHECK THAT SAYS WHICH. The alternative — a single
 * `value text` holding `"true"` / `"3"` / `"['a','b']"` — pushes parsing into every reader and makes
 * a range query on `hours_per_day` a cast. `value_kind` names the populated column, and
 * `wa_value_kind_chk` makes "populated exactly one, and the right one" a database fact rather than
 * a convention.
 *
 * `source` carries the projector's precedence outcome onto the row, so an audit can answer "did a
 * model write this, or did the worker?" without re-running the projection. The rule itself stays in
 * `projectProfile` — this is its record, not a second copy of it.
 */
export const workerAttributes = pgTable(
  "worker_attributes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    /**
     * The pack item's `target_field`. 80 distinct keys across the corpus today.
     *
     * Carries the SAME shape check as `question_pack_item.question_key`, because this key reaches
     * event payloads through the profiling events, and a key that fails the slug filter there does
     * not fail loudly — it makes the flush discard a completed interview.
     */
    attributeKey: text("attribute_key").notNull(),
    valueKind: text("value_kind").$type<AttributeValueKind>().notNull(),
    valueBool: boolean("value_bool"),
    /**
     * `numeric`, never `doublePrecision`. `ai_jobs.cost_inr` is the standing example of what float
     * accumulation does to a column somebody eventually SUMs.
     */
    valueNumber: numeric("value_number", { precision: 14, scale: 4 }),
    valueText: text("value_text"),
    /** `multi_select` answers. A JSONB array of strings; empty array is a legitimate answer. */
    valueTextList: jsonb("value_text_list").$type<string[]>(),
    source: text("source").$type<ProfileValueSource>().notNull().default("answer_map"),
    /**
     * Provenance of the QUESTION, not of the worker. Nullable because a value can also arrive from
     * a parse overlay that cites no single item.
     */
    questionKey: text("question_key"),
    packId: text("pack_id"),
    packVersion: integer("pack_version"),
    /** Which interview produced it. SET NULL: the attribute outlives the session record. */
    sessionId: uuid("session_id").references(() => chatSessions.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // THE CORE INVARIANT. One live value per attribute per worker; a re-interview upserts on this.
    uniqueIndex("wa_worker_key_uq").on(t.workerId, t.attributeKey),
    // The matcher's read is "which workers have attribute X with value Y", so the key leads.
    // `(worker_id, attribute_key)` above already serves the per-worker read as a leftmost prefix.
    index("wa_key_bool_idx").on(t.attributeKey, t.valueBool),
    check(
      "wa_attribute_key_chk",
      sql`${t.attributeKey} ~ '^[a-z_]+$' AND length(${t.attributeKey}) <= 40`,
    ),
    check(
      "wa_value_kind_chk",
      sql`${t.valueKind} IN ('boolean', 'number', 'text', 'text_list')`,
    ),
    check("wa_source_chk", sql`${t.source} IN ('answer_map', 'llm_parse')`),
    // Exactly one value column populated, and it must be the one `value_kind` names. Without the
    // second half a row could claim `value_kind = 'number'` while carrying only `value_text`, and
    // every reader that trusted the kind would read NULL.
    check(
      "wa_value_present_chk",
      sql`(
        (${t.valueKind} = 'boolean'   AND ${t.valueBool} IS NOT NULL AND ${t.valueNumber} IS NULL AND ${t.valueText} IS NULL AND ${t.valueTextList} IS NULL) OR
        (${t.valueKind} = 'number'    AND ${t.valueNumber} IS NOT NULL AND ${t.valueBool} IS NULL AND ${t.valueText} IS NULL AND ${t.valueTextList} IS NULL) OR
        (${t.valueKind} = 'text'      AND ${t.valueText} IS NOT NULL AND ${t.valueBool} IS NULL AND ${t.valueNumber} IS NULL AND ${t.valueTextList} IS NULL) OR
        (${t.valueKind} = 'text_list' AND ${t.valueTextList} IS NOT NULL AND ${t.valueBool} IS NULL AND ${t.valueNumber} IS NULL AND ${t.valueText} IS NULL)
      )`,
    ),
    check(
      "wa_value_text_list_shape_chk",
      sql`${t.valueTextList} IS NULL OR jsonb_typeof(${t.valueTextList}) = 'array'`,
    ),
    // Pinned together or not at all — half a pin cannot say which questions were asked.
    check(
      "wa_pack_pin_chk",
      sql`(${t.packId} IS NULL AND ${t.packVersion} IS NULL) OR (${t.packId} IS NOT NULL AND ${t.packVersion} IS NOT NULL AND ${t.packVersion} >= 1)`,
    ),
  ],
).enableRLS(); // RLS tracked in the model; carried by the migration (BL-26 parity fix)

// ===========================================================================
// profiling_voice_answer — one row per recorded clip
// ===========================================================================

/**
 * THE EVIDENCE, not the value. `worker_attributes` (and the RFS crosswalk) hold what the worker
 * said; this holds that they said it, when, to which question, and what became of the audio.
 *
 * WHY IT HAS TO EXIST IN POSTGRES. The orchestrator envelope lives only in Redis, with a 24h TTL.
 * That trade was priced correctly when losing the key lost only buffered text. A voice form makes
 * the loss asymmetric: an eviction mid-session leaves durable `voice_notes` rows and real audio
 * objects in a bucket with **nothing in Postgres saying which question they answered**. These rows
 * are what make a session reconstructible after the envelope is gone.
 *
 * RE-RECORD IS SUPERSESSION, NEVER DELETION. "Phir se bolein" writes a new row and stamps the old
 * one; the partial unique index below is what makes "at most one live answer per question" a
 * database fact. Deleting the first attempt would erase the only evidence that a worker had to
 * repeat themselves — which is the single most useful signal for tuning the endpointer.
 */
export const profilingVoiceAnswers = pgTable(
  "profiling_voice_answer",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * DENORMALIZED ON PURPOSE. `voice_note_id` goes NULL when a clip is purged, and the row must
     * stay worker-scoped after that — for DSAR enumeration and for retention analytics. Postgres
     * does not auto-index FK columns, so `pva_worker_idx` below is mandatory: without it the
     * `workers` delete cascade sequentially scans this table.
     */
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    /** Session identity IS the `chat_sessions` row. There is deliberately no second session table. */
    sessionId: uuid("session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    /** SET NULL, mirroring `chat_messages.voice_note_id`: the capture fact outlives the clip. */
    voiceNoteId: uuid("voice_note_id").references(() => voiceNotes.id, { onDelete: "set null" }),
    /**
     * Pinned per row, with NO foreign key. `qpi_pack_fk` is CASCADE, and retiring a pack version
     * must not cascade into a worker's audit trail.
     */
    packId: text("pack_id").notNull(),
    packVersion: integer("pack_version").notNull(),
    questionKey: text("question_key").notNull(),
    /** The "Phir se bolein" counter. 1 for the first recording of this question. */
    attemptNo: smallint("attempt_no").notNull().default(1),
    /** Question position in the session. Repeats across attempts of the same question. */
    ordinal: smallint("ordinal").notNull(),
    captureStatus: text("capture_status").$type<VoiceCaptureStatus>().notNull().default("recorded"),
    transcriptStatus: text("transcript_status")
      .$type<VoiceTranscriptStatus>()
      .notNull()
      .default("pending"),
    /**
     * A CLOSED-SET failure code, never a provider message. Surfacing this is the fix for the defect
     * where a budget-blocked call was recorded as a successful transcription of silence.
     */
    transcriptErrorCode: text("transcript_error_code"),
    /**
     * Duplicated from `voice_notes` so retention and cost analytics survive the clip being purged.
     * Bounded by the CONTRACT limit (120s), not by the form's own 30s cap — the cap is a product
     * decision that may move, the contract limit is the schema's business.
     */
    durationSeconds: integer("duration_seconds"),
    superseded: timestamp("superseded_at", { withTimezone: true }),
    /**
     * Self-referencing: the attempt that replaced this one. A real FK, not a loose uuid — a
     * supersession chain that can point at a row that never existed is not an audit trail.
     */
    supersededById: uuid("superseded_by_id").references(
      (): AnyPgColumn => profilingVoiceAnswers.id,
      { onDelete: "set null" },
    ),
    /** Stamped only after the object AND the `voice_notes` row are gone. See the check. */
    purgedAt: timestamp("purged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Read a session's answers in order — the review screen's query.
    index("pva_session_order_idx").on(t.sessionId, t.ordinal, t.attemptNo),
    uniqueIndex("pva_session_question_attempt_uq").on(t.sessionId, t.questionKey, t.attemptNo),
    // THE CORE INVARIANT: at most one LIVE answer per question per session.
    uniqueIndex("pva_session_question_live_uq")
      .on(t.sessionId, t.questionKey)
      .where(sql`superseded_at IS NULL`),
    // One clip ↔ one row, and the purge job's lookup. Partial, because purged rows all carry NULL.
    uniqueIndex("pva_voice_note_uq")
      .on(t.voiceNoteId)
      .where(sql`voice_note_id IS NOT NULL`),
    // DSAR enumeration, and the `workers` cascade's index (see the column comment).
    index("pva_worker_idx").on(t.workerId),
    // The stuck-transcription sweep. Partial, so it stays the size of the backlog, not the table.
    index("pva_pending_idx")
      .on(t.createdAt)
      .where(sql`transcript_status IN ('pending', 'queued')`),
    check(
      "pva_question_key_chk",
      sql`${t.questionKey} ~ '^[a-z_]+$' AND length(${t.questionKey}) <= 40`,
    ),
    check("pva_pack_version_chk", sql`${t.packVersion} >= 1`),
    check("pva_attempt_no_chk", sql`${t.attemptNo} >= 1 AND ${t.attemptNo} <= 20`),
    check("pva_ordinal_chk", sql`${t.ordinal} >= 0`),
    check(
      "pva_capture_status_chk",
      sql`${t.captureStatus} IN ('recorded', 'uploaded', 'failed', 'abandoned')`,
    ),
    check(
      "pva_transcript_status_chk",
      sql`${t.transcriptStatus} IN ('pending', 'queued', 'succeeded', 'failed', 'skipped')`,
    ),
    check(
      "pva_duration_chk",
      sql`${t.durationSeconds} IS NULL OR (${t.durationSeconds} >= 0 AND ${t.durationSeconds} <= 120)`,
    ),
    // A superseding row is a different row. Without this, a self-reference reads as "replaced by
    // itself" and a supersession chain becomes a cycle no reader can walk.
    check("pva_superseded_by_self_chk", sql`${t.supersededById} IS NULL OR ${t.supersededById} <> ${t.id}`),
    // Supersession is a fact with a pointer, or neither. A stamp with no successor is unresolvable.
    check(
      "pva_superseded_pair_chk",
      sql`(${t.superseded} IS NULL AND ${t.supersededById} IS NULL) OR (${t.superseded} IS NOT NULL AND ${t.supersededById} IS NOT NULL)`,
    ),
    // PURGE ORDER, ENFORCED. Delete the object -> delete the `voice_notes` row (the FK nulls this
    // ref) -> only then stamp `purged_at`. A row stamped purged while still pointing at a live clip
    // is how a retention report comes to disagree with the bucket.
    check("pva_purged_ref_chk", sql`${t.purgedAt} IS NULL OR ${t.voiceNoteId} IS NULL`),
    // An error code without a failure is noise; a failure is allowed to have no code (a transport
    // drop mid-flight legitimately produces none).
    check(
      "pva_error_code_chk",
      sql`${t.transcriptErrorCode} IS NULL OR ${t.transcriptStatus} = 'failed'`,
    ),
  ],
).enableRLS(); // RLS tracked in the model; carried by the migration (BL-26 parity fix)
