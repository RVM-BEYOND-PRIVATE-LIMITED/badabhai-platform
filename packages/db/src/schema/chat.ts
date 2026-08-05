/**
 * Worker chat domain — the profiling conversation: sessions, voice notes, messages.
 */
import {
  pgTable,
  uuid,
  text,
  integer,
  doublePrecision,
  timestamp,
  jsonb,
  index,
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
    // Opaque object key into the private worker-conversations Storage bucket for
    // the archived full-conversation JSON (transcript + final state snapshot).
    // Reference only — Postgres stays the queryable spine. Nullable until the
    // session is archived. Carries opaque UUIDs only, never PII. See ADR-0003 and
    // `conversationObjectKey` in @badabhai/validators. (The runtime archival write
    // lives in the chat-persistence wiring; this is the frozen reference contract.)
    conversationStoragePath: text("conversation_storage_path"),
  },
  (t) => [index("chat_sessions_worker_id_idx").on(t.workerId)],
);

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
  ],
);

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
    // index. Descending to match the query's own direction (migration 0067).
    index("chat_messages_session_created_idx").on(t.sessionId, t.createdAt.desc()),
  ],
);

