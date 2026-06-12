import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  doublePrecision,
  boolean,
  timestamp,
  date,
  jsonb,
  vector,
  index,
  uniqueIndex,
  check,
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
    // The extraction job that produced this profile (logical ref to ai_jobs.id;
    // no FK, kept lean like the rest of the spine). The UNIQUE index below makes
    // profile creation idempotent per job (TD14): a partial-success retry (the
    // profile row committed, then markCompleted failed → BullMQ redelivers) finds
    // the key already taken and re-creates NOTHING, instead of orphaning a second
    // profile. Nullable — legacy/non-extraction profiles have none, and Postgres
    // treats NULLs as DISTINCT so they never collide.
    aiJobId: uuid("ai_job_id"),
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
    // Idempotent extraction (TD14): at most one profile per ai_job. Many NULLs
    // allowed (NULLS DISTINCT — Postgres default). See `aiJobId` above.
    uniqueIndex("worker_profiles_ai_job_id_uq").on(t.aiJobId),
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
    // Delivery-dedup token (TD18). A stable, producer-supplied key for the
    // logical event (e.g. "profile.extraction_completed:<ai_job_id>"). The unique
    // index below makes inserts idempotent under at-least-once retry: re-emitting
    // the same logical event is a no-op (INSERT ... ON CONFLICT DO NOTHING).
    // NULLABLE on purpose — events with no natural dedup key (legitimately
    // repeatable: otp_requested resends, action.recorded) leave it null, and
    // Postgres treats NULLs as DISTINCT, so unkeyed events never collide. This is
    // a storage-layer concern, deliberately NOT part of the validated event
    // envelope (the immutable "fact"); it travels on the row, not in the contract.
    idempotencyKey: text("idempotency_key"),
    payload: jsonb("payload").notNull().default(jsonObject),
    metadata: jsonb("metadata").notNull().default(jsonObject),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("events_event_name_idx").on(t.eventName),
    index("events_occurred_at_idx").on(t.occurredAt),
    index("events_correlation_id_idx").on(t.correlationId),
    index("events_subject_idx").on(t.subjectType, t.subjectId),
    // Idempotent emission: non-null keys are unique; many NULLs are allowed
    // (NULLS DISTINCT — Postgres default). See `idempotencyKey` above.
    uniqueIndex("events_idempotency_key_uq").on(t.idempotencyKey),
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
    // --- Operational AI usage/cost metadata (from the AI router's ai_metadata) ---
    // Populated on completion for observability ("what did this job cost?"). All
    // nullable: mock/AI-down runs and pre-existing rows carry none. PII-free by
    // construction — only these typed scalars, never prompts/completions/PII.
    modelName: text("model_name"),
    realCall: boolean("real_call"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    totalTokens: integer("total_tokens"),
    costInr: doublePrecision("cost_inr"),
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
// Profiling questionnaire (ADR-0005, first slice) — metadata-driven profiles.
//
// In scope here: profiles + questions + profile_questions + worker_answers.
// DEFERRED to later slices (per ADR-0005): `profile_versions` (questionnaire
// versioning) and `question_options` (single/multi-select choices). Until
// `question_options` exists, only text/number/date answers are wired — select-type
// questions can be authored but not yet answered (no `answer_option_id` column yet).
// ---------------------------------------------------------------------------

// profiles — one questionnaire per worker trade/role (Driver, VMC Operator, …).
export const profiles = pgTable(
  "profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(), // stable key (e.g. "vmc_operator")
    name: text("name").notNull(), // display name (English — localized on the frontend)
    status: text("status").$type<"draft" | "active" | "archived">().notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("profiles_slug_uq").on(t.slug)],
);

// questions — reusable question catalog, shared across profiles.
export const questions = pgTable(
  "questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    questionKey: text("question_key").notNull(), // stable id (e.g. "years_experience")
    questionText: text("question_text").notNull(), // English; localized on the frontend
    answerType: text("answer_type")
      .$type<"text" | "number" | "date" | "single_select" | "multi_select">()
      .notNull(),
    // Maps the answer to a canonical match signal for the worker_profiles projection
    // (e.g. "experience.total_years"). Nullable until wired.
    extractionTopic: text("extraction_topic"),
    // Light validation kept with the question (required / min / max / date-range).
    validation: jsonb("validation").notNull().default(jsonObject),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("questions_question_key_uq").on(t.questionKey)],
);

// profile_questions — which questions belong to a profile, and in what order.
// (No profile_version_id yet — versioning is a later slice; maps the profile directly.)
export const profileQuestions = pgTable(
  "profile_questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    questionId: uuid("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    displayOrder: integer("display_order").notNull().default(0),
    // Per-profile requiredness drives interview readiness — NOT match filtering
    // (ADR-0005 sort-never-block invariant).
    isRequired: boolean("is_required").notNull().default(false),
  },
  (t) => [
    // A question appears at most once per profile.
    uniqueIndex("profile_questions_profile_question_uq").on(t.profileId, t.questionId),
    // Load a profile's questions in order.
    index("profile_questions_profile_id_idx").on(t.profileId),
  ],
);

// worker_answers — a worker's answers (PII-minimized; typed columns).
//
// Cardinality-1 today (text/number/date): one row per (worker, question), replaced
// in place on re-answer. An answer is a property of the WORKER (e.g. years_experience
// is the same regardless of which profile surfaced it); `profile_id` is provenance.
// Multi-select (one row per option) lands with `question_options`.
export const workerAnswers = pgTable(
  "worker_answers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    // Which questionnaire surfaced this answer (provenance; questions are shared).
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    questionId: uuid("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    // Exactly one of these is set (see the CHECK below). `answer_option_id` arrives
    // with `question_options`. PRIVACY: `answer_text` is free input → it must be
    // pseudonymized on the chat capture path before persist (ADR-0005) and is never
    // emitted into events; events/analytics read the typed columns only.
    answerText: text("answer_text"),
    answerNumber: doublePrecision("answer_number"),
    answerDate: date("answer_date"),
    source: text("source").$type<"chat" | "form" | "import">().notNull().default("chat"),
    answeredAt: timestamp("answered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Cardinality-1: one answer per (worker, question); ON CONFLICT … DO UPDATE replaces.
    uniqueIndex("worker_answers_worker_question_uq").on(t.workerId, t.questionId),
    index("worker_answers_profile_id_idx").on(t.profileId),
    // Exactly one typed answer column is populated.
    check(
      "worker_answers_one_value_chk",
      sql`(
        (${t.answerText} IS NOT NULL)::int +
        (${t.answerNumber} IS NOT NULL)::int +
        (${t.answerDate} IS NOT NULL)::int
      ) = 1`,
    ),
  ],
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
export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;
export type Question = typeof questions.$inferSelect;
export type NewQuestion = typeof questions.$inferInsert;
export type ProfileQuestion = typeof profileQuestions.$inferSelect;
export type NewProfileQuestion = typeof profileQuestions.$inferInsert;
export type WorkerAnswer = typeof workerAnswers.$inferSelect;
export type NewWorkerAnswer = typeof workerAnswers.$inferInsert;

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
  profiles,
  questions,
  profileQuestions,
  workerAnswers,
};
