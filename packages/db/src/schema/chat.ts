/**
 * Worker chat domain — the profiling conversation: sessions, voice notes, messages.
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  doublePrecision,
  timestamp,
  jsonb,
  index,
  check,
} from "drizzle-orm/pg-core";
import type {
  ChatSessionStatus,
  MessageDirection,
  MessageType,
  VoiceRetentionPolicy,
  StorageClass,
} from "@badabhai/types";
import { jsonObject } from "./internal/sql-defaults";
import { workers } from "./worker";

// ---------------------------------------------------------------------------
// chat_sessions
// ---------------------------------------------------------------------------
export const chatSessions = pgTable(
  "chat_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    status: text("status").$type<ChatSessionStatus>().notNull().default("active"),
    // Interview progress carried across turns: the AI service's ConversationState
    // (role_family, turn_count, answered_topics, asked_question_ids, collected).
    // Profile signals only — never identity PII; never copied into `events`.
    // Loose JSONB by design (flexible state); apps/api casts to the ai-contracts
    // ConversationState at the boundary.
    conversationState: jsonb("conversation_state").$type<Record<string, unknown>>(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    /**
     * @deprecated DEAD COLUMN — always NULL. Retired 2026-08-14; do not write it.
     *
     * It was the reference half of ADR-0003's archival tier: an opaque object key into
     * a private `worker-conversations` bucket holding each finished interview as JSON.
     * The column and migration `0002` shipped; the write never did, and the bucket was
     * never provisioned. **ADR-0003 is now Withdrawn**, so nothing will ever write it.
     *
     * WHY IT IS STILL HERE. CLAUDE.md §3/§10 — production columns are not removed. It is
     * nullable, unread, unindexed, and costs one NULL bitmap bit per row, which is a
     * smaller price than a `DROP COLUMN` against a live `chat_sessions`.
     *
     * WHY THE FEATURE WAS RETIRED RATHER THAN FINISHED. `chat_messages` already holds the
     * complete verbatim transcript of every finished interview (the Redis buffer flushes
     * once, transactionally, at completion). A bucket copy would have been a SECOND copy
     * of the same raw PII behind an object ACL that can drift — which is exactly what risk
     * R10 was raised about — for no query the relational rows cannot already serve. See
     * ADR-0003's Withdrawal section and R10 (Closed) in the risks register.
     *
     * Reviving archival requires a NEW ADR, not this column.
     */
    conversationStoragePath: text("conversation_storage_path"),
    // ---- Question-pack pin (migration 0071) --------------------------------
    // WHICH interview this session is running. Nullable: the v1 model-driven chat pins nothing,
    // and every session that predates the voice form has neither.
    //
    // WHY POSTGRES AND NOT JUST REDIS. The orchestrator envelope lives only in the Redis key, with
    // a 24h TTL, and the pack pin is the one thing `profiling_voice_answer` rows cannot carry for
    // it: an eviction BEFORE the first clip would re-run retrieval on resume and could pin a
    // DIFFERENT pack, silently changing the questions mid-interview. Everything else about a
    // session is reconstructible from those rows; this is not.
    //
    // Cost is one extra UPDATE at pin time — not per turn.
    packId: text("pack_id"),
    packVersion: integer("pack_version"),
  },
  (t) => [
    index("chat_sessions_worker_id_idx").on(t.workerId),
    // THE ADMIN JOURNEY'S SESSION LIST (migration 0079). `GET /admin/workers/:id/chat-sessions`
    // is keyset-paginated as `WHERE worker_id = $1 ORDER BY started_at DESC, id DESC` — the
    // plain worker index above serves the FILTER and leaves the sort, exactly the shape
    // `chat_messages_session_created_idx` was added to remove one table over.
    //
    // `.desc().nullsFirst()` IS LOAD-BEARING, for the reason that index's comment spells out:
    // Postgres reads a bare `ORDER BY started_at DESC` as DESC NULLS FIRST, pathkeys compare
    // `nulls_first` STRICTLY, and drizzle's `.desc()` alone emits NULLS LAST — which does not
    // satisfy the ordering, so the planner keeps the Sort and the index buys only the filter.
    // Both columns are NOT NULL, so this changes no result, only the plan.
    //
    // A worker has few sessions, so this is cheap insurance rather than a hot-path rescue —
    // but "few" is a property of today's product, not of the schema, and a resumable voice
    // form is exactly the feature that makes it stop being true.
    index("chat_sessions_worker_started_idx").on(
      t.workerId,
      t.startedAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    // Pinned together or not at all. Half a pin names an interview nobody can reproduce.
    check(
      "chat_sessions_pack_pin_chk",
      sql`(${t.packId} IS NULL AND ${t.packVersion} IS NULL) OR (${t.packId} IS NOT NULL AND ${t.packVersion} IS NOT NULL AND ${t.packVersion} >= 1)`,
    ),
  ],
).enableRLS(); // RLS tracked in the model; carried by the migration (BL-26 parity fix)

// ---------------------------------------------------------------------------
// voice_notes — declared before chat_messages (FK target)
// ---------------------------------------------------------------------------
export const voiceNotes = pgTable(
  "voice_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    storagePath: text("storage_path").notNull(),
    durationSeconds: integer("duration_seconds").notNull(),
    transcriptText: text("transcript_text"),
    transcriptConfidence: doublePrecision("transcript_confidence"),
    // Derived English translation of transcript_text (Sarvam /translate). Same PII
    // class as transcript_text — lives only on this row, NEVER in events/ai_jobs/logs.
    // Nullable: null until translated, or when translation is skipped/failed.
    transcriptEnglish: text("transcript_english"),
    retentionPolicy: text("retention_policy")
      .$type<VoiceRetentionPolicy>()
      .notNull()
      .default("retain_indefinitely"),
    storageClass: text("storage_class").$type<StorageClass>().notNull().default("hot"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("voice_notes_worker_id_idx").on(t.workerId),
    index("voice_notes_session_id_idx").on(t.sessionId),
    // THE RETENTION SWEEP'S INDEX (migration 0071). Every purge job that will ever run over this
    // table asks the same question — "which clips are older than N days" — and until now nothing
    // served it, so the sweep would sequentially scan the largest raw-PII table in the system.
    //
    // Taken NOW, while the table is empty (`VOICE_NOTES_BUCKET` is unset, so the surface is
    // dormant). Drizzle wraps each migration in a transaction and `CREATE INDEX CONCURRENTLY`
    // cannot run inside one, so this is the cheapest this index will ever be.
    index("voice_notes_created_at_idx").on(t.createdAt),
  ],
).enableRLS(); // RLS tracked in the model; carried by the migration (BL-26 parity fix)

// ---------------------------------------------------------------------------
// chat_messages
// ---------------------------------------------------------------------------
export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    direction: text("direction").$type<MessageDirection>().notNull(),
    messageType: text("message_type").$type<MessageType>().notNull().default("text"),
    bodyText: text("body_text"),
    voiceNoteId: uuid("voice_note_id").references(() => voiceNotes.id, { onDelete: "set null" }),
    metadata: jsonb("metadata").notNull().default(jsonObject),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("chat_messages_session_id_idx").on(t.sessionId),
    index("chat_messages_worker_id_idx").on(t.workerId),
    // The hot-path read is `WHERE session_id = $1 ORDER BY created_at DESC LIMIT n`
    // (`chat.repository.ts` listMessages). `chat_messages_session_id_idx` alone gets the
    // filter but leaves the sort, so every turn of every interview re-sorts the session's
    // whole history to take the tail. This composite serves filter+sort+limit from the
    // index (migration 0067).
    //
    // `.nullsFirst()` IS LOAD-BEARING — do not "simplify" it away. Postgres reads a bare
    // `ORDER BY created_at DESC` as DESC NULLS FIRST, and an index built DESC NULLS LAST
    // does not satisfy that ordering. Drizzle's `.desc()` alone emits NULLS LAST, which
    // measured as: Bitmap Index Scan + a separate top-N Sort (1.32 ms over 200k rows) —
    // the index served the FILTER and the sort still happened, which is the entire thing
    // this index exists to remove. With NULLS FIRST it is a plain Index Scan, no Sort,
    // 0.17 ms. The column is NOT NULL, so this changes no result — only the plan.
    index("chat_messages_session_created_idx").on(t.sessionId, t.createdAt.desc().nullsFirst()),
  ],
).enableRLS(); // RLS tracked in the model; carried by the migration (BL-26 parity fix)

