// Worker-side AI chat domain: chat sessions, voice notes, chat messages, and the
// generated resume produced from them.

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
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  ChatSessionStatus,
  MessageDirection,
  MessageType,
  VoiceRetentionPolicy,
  StorageClass,
} from "@badabhai/types";
import { jsonObject } from "./_internal/json-defaults";
import { workerProfiles, workers } from "./worker";

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
  ],
);

// ---------------------------------------------------------------------------
// generated_resumes
// ---------------------------------------------------------------------------
export const generatedResumes = pgTable(
  "generated_resumes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => workerProfiles.id, { onDelete: "cascade" }),
    resumeJson: jsonb("resume_json").notNull().default(jsonObject),
    resumeText: text("resume_text").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    version: integer("version").notNull().default(1),
    // TD5 layer 2 — versioned PDF render artifact (ADR resume-render).
    // The text/json above is generated synchronously; the PDF is rendered async by the
    // resume-render worker, which fills pdf_storage_key + flips render_status -> 'rendered'.
    templateId: text("template_id").notNull().default("fallback"),
    // Canonical (name-free) structured profile captured at generation time, so a future,
    // better renderer can re-render a richer PDF from the snapshot. Nullable for legacy rows.
    sourceProfileSnapshot: jsonb("source_profile_snapshot"),
    // Opaque object key in the private resumes bucket; null until the PDF is rendered.
    pdfStorageKey: text("pdf_storage_key"),
    // 'pending' -> 'rendered' | 'failed'. Plain text (matches ai_jobs.status), validated in code.
    renderStatus: text("render_status").notNull().default("pending"),
    renderedAt: timestamp("rendered_at", { withTimezone: true }),
  },
  (t) => [
    index("generated_resumes_worker_id_idx").on(t.workerId),
    index("generated_resumes_profile_id_idx").on(t.profileId),
    // At most ONE initial (version 1) resume per profile. Makes initial generation
    // idempotent/race-safe (ON CONFLICT): the auto-generate on profile.confirmed and
    // a manual POST /resume/generate converge on one row instead of double-creating.
    // Partial (version = 1) so regenerations (version > 1) are unconstrained.
    uniqueIndex("generated_resumes_initial_uq")
      .on(t.profileId)
      .where(sql`${t.version} = 1`),
  ],
);

// ---------------------------------------------------------------------------
// Inferred row types (select / insert) for use across services.
// ---------------------------------------------------------------------------
export type ChatSession = typeof chatSessions.$inferSelect;
export type NewChatSession = typeof chatSessions.$inferInsert;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type NewChatMessage = typeof chatMessages.$inferInsert;
export type VoiceNote = typeof voiceNotes.$inferSelect;
export type NewVoiceNote = typeof voiceNotes.$inferInsert;
export type GeneratedResume = typeof generatedResumes.$inferSelect;
export type NewGeneratedResume = typeof generatedResumes.$inferInsert;
