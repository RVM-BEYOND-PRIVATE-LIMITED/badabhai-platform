import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  doublePrecision,
  timestamp,
  jsonb,
  vector,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  WorkerStatus,
  ProfileStatus,
  ChatSessionStatus,
  MessageDirection,
  MessageType,
  ConsentPurpose,
  VoiceRetentionPolicy,
  StorageClass,
  AiJobType,
  AiJobStatus,
  LanguageCode,
} from "@badabhai/types";

/**
 * BadaBhai Drizzle schema (Supabase Postgres).
 *
 * Conventions:
 * - All ids are uuid (gen_random_uuid()).
 * - All timestamps are `timestamptz`.
 * - Status-like columns are `text` with a TS `$type<...>()` for type-safety
 *   (kept as text rather than pg enums to keep migrations simple for a lean team;
 *   add CHECK constraints later if needed — see infra/supabase/migration-plan.md).
 * - JSONB columns default to '{}' / '[]'.
 *
 * PRIVACY: PII (phone, name) lives ONLY in `workers`. It must never be copied
 * into `events`, `audit_logs`, `ai_jobs`, or sent to an LLM. RLS will lock these
 * tables down (see infra/supabase/rls-plan.md) — Phase 1 access is via the
 * backend service role only.
 */

const jsonObject = sql`'{}'::jsonb`;
const jsonArray = sql`'[]'::jsonb`;

// ---------------------------------------------------------------------------
// workers — identity (PII lives here only)
//
// Hardening (migration 0003): row-level security is enabled and the Supabase
// anon/authenticated roles are revoked — only the backend service role reads
// this table. The phone is stored two ways:
//   - phone_e164: AES-256-GCM CIPHERTEXT (an `encryptPii` token), NOT plaintext.
//     The key lives only in backend config, never in the DB. Column name kept
//     for migration safety; it no longer holds a readable number.
//   - phone_hash: a keyed HMAC-SHA256 (server pepper) — the stable lookup/dedup
//     key, and the only phone derivative allowed in events. Not brute-forceable.
// Because the ciphertext is non-deterministic, uniqueness lives on phone_hash.
// ---------------------------------------------------------------------------
export const workers = pgTable(
  "workers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    phoneE164: text("phone_e164").notNull(), // AES-256-GCM ciphertext token (see above)
    phoneHash: text("phone_hash").notNull(), // keyed HMAC-SHA256
    // NOTE: full_name is also raw PII. It has no write site yet (nullable, unused
    // in Phase 1). It MUST be encrypted with encryptPii (like phone_e164) before
    // any code writes a real name here — do not store a name in plaintext.
    fullName: text("full_name"),
    preferredLanguage: text("preferred_language").$type<LanguageCode>(),
    status: text("status").$type<WorkerStatus>().notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("workers_phone_hash_uq").on(t.phoneHash)],
).enableRLS(); // RLS tracked in the model so db:generate keeps it (migration 0003/0004 carry the SQL)

// ---------------------------------------------------------------------------
// worker_consents — DPDP consent records (append-only; revoke via revoked_at)
// ---------------------------------------------------------------------------
export const workerConsents = pgTable(
  "worker_consents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    consentVersion: text("consent_version").notNull(),
    purposes: jsonb("purposes").$type<ConsentPurpose[]>().notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull(),
    ipHash: text("ip_hash"),
    userAgent: text("user_agent"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("worker_consents_worker_id_idx").on(t.workerId)],
);

// ---------------------------------------------------------------------------
// worker_profiles — canonicalized profile (one current per worker in Phase 1)
// ---------------------------------------------------------------------------
export const workerProfiles = pgTable(
  "worker_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    profileStatus: text("profile_status").$type<ProfileStatus>().notNull().default("draft"),
    canonicalTradeId: text("canonical_trade_id"),
    canonicalRoleId: text("canonical_role_id"),
    skills: jsonb("skills").$type<string[]>().notNull().default(jsonArray),
    machines: jsonb("machines").$type<string[]>().notNull().default(jsonArray),
    experience: jsonb("experience").notNull().default(jsonObject),
    salaryExpectation: jsonb("salary_expectation").notNull().default(jsonObject),
    locationPreference: jsonb("location_preference").notNull().default(jsonObject),
    availability: jsonb("availability").notNull().default(jsonObject),
    rawProfile: jsonb("raw_profile").notNull().default(jsonObject),
    // Managed Vertex embedding (text-multilingual-embedding-002, 768-dim) for
    // semantic similarity. Nullable until the profile is embedded (plan G3).
    embedding: vector("embedding", { dimensions: 768 }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("worker_profiles_worker_id_idx").on(t.workerId),
    // HNSW index for cosine similarity search over the 768-dim embedding (plan G5).
    index("worker_profiles_embedding_hnsw").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops"),
    ),
  ],
);

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
  },
  (t) => [
    index("generated_resumes_worker_id_idx").on(t.workerId),
    index("generated_resumes_profile_id_idx").on(t.profileId),
  ],
);

// ---------------------------------------------------------------------------
// events — the event-first spine. Insert-only from backend services.
// ---------------------------------------------------------------------------
export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventName: text("event_name").notNull(),
    eventVersion: integer("event_version").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    actorType: text("actor_type").notNull(),
    actorId: uuid("actor_id"),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id"),
    correlationId: uuid("correlation_id").notNull(),
    causationId: uuid("causation_id"),
    payload: jsonb("payload").notNull().default(jsonObject),
    metadata: jsonb("metadata").notNull().default(jsonObject),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("events_event_name_idx").on(t.eventName),
    index("events_occurred_at_idx").on(t.occurredAt),
    index("events_correlation_id_idx").on(t.correlationId),
    index("events_subject_idx").on(t.subjectType, t.subjectId),
  ],
);

// ---------------------------------------------------------------------------
// ai_jobs — async AI work tracking (refs only, never raw PII)
// ---------------------------------------------------------------------------
export const aiJobs = pgTable(
  "ai_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobType: text("job_type").$type<AiJobType>().notNull(),
    status: text("status").$type<AiJobStatus>().notNull().default("queued"),
    inputRef: jsonb("input_ref").notNull().default(jsonObject),
    outputRef: jsonb("output_ref"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ai_jobs_status_idx").on(t.status)],
);

// ---------------------------------------------------------------------------
// audit_logs — who did what (no raw PII; reference ids only)
// ---------------------------------------------------------------------------
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorType: text("actor_type").notNull(),
    actorId: uuid("actor_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    metadata: jsonb("metadata").notNull().default(jsonObject),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_logs_entity_idx").on(t.entityType, t.entityId)],
);

// ---------------------------------------------------------------------------
// Inferred row types (select / insert) for use across services.
// ---------------------------------------------------------------------------
export type Worker = typeof workers.$inferSelect;
export type NewWorker = typeof workers.$inferInsert;
export type WorkerConsent = typeof workerConsents.$inferSelect;
export type NewWorkerConsent = typeof workerConsents.$inferInsert;
export type WorkerProfile = typeof workerProfiles.$inferSelect;
export type NewWorkerProfile = typeof workerProfiles.$inferInsert;
export type ChatSession = typeof chatSessions.$inferSelect;
export type NewChatSession = typeof chatSessions.$inferInsert;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type NewChatMessage = typeof chatMessages.$inferInsert;
export type VoiceNote = typeof voiceNotes.$inferSelect;
export type NewVoiceNote = typeof voiceNotes.$inferInsert;
export type GeneratedResume = typeof generatedResumes.$inferSelect;
export type NewGeneratedResume = typeof generatedResumes.$inferInsert;
export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;
export type AiJob = typeof aiJobs.$inferSelect;
export type NewAiJob = typeof aiJobs.$inferInsert;
export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;

/** All tables, handy for migrations/tests. */
export const schema = {
  workers,
  workerConsents,
  workerProfiles,
  chatSessions,
  voiceNotes,
  chatMessages,
  generatedResumes,
  events,
  aiJobs,
  auditLogs,
};
