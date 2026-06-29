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
  VacancyBand,
  JobPostingStatus,
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
// payers — the account behind the opaque `payer_id` (ADR-0019 Decision B).
//
// Self-serve makes `payer_id` (today an opaque "faceless-rails" UUID on
// unlocks/payer_credits/posting_plans/resume_disclosures/payer_capacity, NO FK)
// a REAL authenticated account. This table is ADDITIVE: those columns stay opaque
// UUIDs (no FK retrofit here, backward-compatible); a `payers.id` is now a valid
// value for them. `payers` holds payer/employer **B2B contact PII — a NEW PII
// class** (ADR-0019 B-R2, the accepted invariant-#2 extension). Same at-rest
// discipline as `workers` (ADR-0004): contact fields are AES-256-GCM CIPHERTEXT
// (`encryptPii` tokens, key never in the DB); the login email also carries a keyed
// HMAC (`email_hash`) as the brute-force-resistant lookup/dedup key (the only
// email derivative allowed anywhere outside this table). Payer PII NEVER enters
// events/ai_jobs/audit_logs/logs/LLM input — `payer_id` stays the only token.
// RLS-enabled (REVOKE carried by the migration, like workers 0003/0004).
// ---------------------------------------------------------------------------
export type PayerRole = "employer" | "agent";
export type PayerStatus = "pending" | "active" | "suspended";

export const payers = pgTable(
  "payers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    role: text("role").$type<PayerRole>().notNull(),
    // Login email: AES ciphertext at rest + keyed HMAC for lookup/dedup (mirrors
    // workers.phone_e164 / phone_hash). The hash is the unique key.
    emailEnc: text("email_enc").notNull(), // AES-256-GCM ciphertext token
    emailHash: text("email_hash").notNull(), // keyed HMAC-SHA256 (lookup/dedup)
    // Optional contact phone, same two-column pattern (nullable).
    phoneEnc: text("phone_enc"), // AES ciphertext token
    phoneHash: text("phone_hash"), // keyed HMAC-SHA256
    // Business display name — B2B PII; ciphertext at rest (no lookup hash needed).
    orgNameEnc: text("org_name_enc").notNull(), // AES ciphertext token
    status: text("status").$type<PayerStatus>().notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("payers_email_hash_uq").on(t.emailHash)],
).enableRLS(); // RLS tracked in the model; REVOKE carried by the migration (ADR-0004 posture)

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
// worker_devices — durable trusted-device registry (ADR-0026 Phase 2, device
// binding; auth-spec §10). Holds NO raw PII: the client device id is stored ONLY
// as a keyed HMAC-SHA256 (`device_hash`, mirrors workers.phone_hash) — never the
// raw fingerprint (CEO-confirmed: HMAC over raw, 2026-06-29). platform/model/
// app_version are non-PII (not in CLAUDE.md §2). `push_token` is an opaque
// FCM/APNS token (stored raw — it must be real to send a push) that, like the
// device hash, NEVER enters events/ai_jobs/audit_logs/logs/LLM input.
// `attestation_verified` is the Play Integrity gate (R5/TD55): deferred, default
// false, never gated on yet. Durable so the device list + binding survive a Redis
// flush. RLS-enabled (FORCE + REVOKE carried by the migration, ADR-0004 spine
// posture); the WorkerAuthGuard is the app-layer access control. The platform
// union is pinned at the DB by CHECK (text-$type + CHECK convention, see header).
// ---------------------------------------------------------------------------
export type DevicePlatform = "android" | "ios" | "web" | "unknown";

export const workerDevices = pgTable(
  "worker_devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workerId: uuid("worker_id")
      .notNull()
      // DPDP actor-scoped erasure cascades from workers.
      .references(() => workers.id, { onDelete: "cascade" }),
    // Keyed HMAC-SHA256 of the client device id — the ONLY device-id derivative
    // stored; the raw client fingerprint is never persisted (mirrors phone_hash).
    deviceHash: text("device_hash").notNull(),
    platform: text("platform").$type<DevicePlatform>().notNull().default("unknown"),
    model: text("model"), // device model string (non-PII), nullable
    appVersion: text("app_version"),
    // Opaque push token (FCM/APNS) — stored raw (a hash can't be pushed to), kept
    // OUT of events/logs/LLM like the device hash. Nullable (set when the app opts in).
    pushToken: text("push_token"),
    // Play Integrity (R5/TD55): deferred — default false, never gated on yet.
    attestationVerified: boolean("attestation_verified").notNull().default(false),
    trustedAt: timestamp("trusted_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One row per (worker, device) — binding + idempotent re-registration.
    uniqueIndex("worker_devices_worker_device_uq").on(t.workerId, t.deviceHash),
    // Device-list lookups by worker.
    index("worker_devices_worker_id_idx").on(t.workerId),
    // Pin the platform union at the DB (mirrors admin_users_role_chk).
    check(
      "worker_devices_platform_chk",
      sql`${t.platform} IN ('android', 'ios', 'web', 'unknown')`,
    ),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by the migration (ADR-0004 posture)

// ---------------------------------------------------------------------------
// worker_credentials — the device-unlock PIN, one row per worker (ADR-0026 Phase 3,
// device-bound PIN; auth-spec §10). The PIN NEVER authenticates from scratch — a
// correct PIN only unlocks an already-device-bound session (see ADR-0026).
//
// `pin_hash` is a SLOW-KDF hash, never the raw PIN. Per ADR-0026 R3 (CEO-delegated
// 2026-06-29) the KDF is Node stdlib `crypto.scrypt` (memory-hard, no new native
// dependency — consistent with packages/db/crypto.ts) with a per-user salt + a
// server-side pepper (`PIN_PEPPER`, env/KMS — provisioned like `PII_HASH_PEPPER`,
// NEVER stored in this table or committed). The hash is a SELF-ENCODED token
// (`scrypt-v1.<salt>.<derived>`, mirrors the `v1.<iv>.<tag>.<ct>` encryptPii token)
// so the salt is embedded — hence NO separate `pin_salt` column. The column is
// algo-agnostic text, so an Argon2id upgrade later is a non-breaking swap (TD55).
// `failed_attempts`/`locked_until`/`lockout_cycles` back the server-side throttle
// (Phase 3): N fails → timed lockout → exponential backoff → after K cycles force
// OTP + PIN reset. The hash + throttle state NEVER enter events/ai_jobs/audit_logs/
// logs/LLM input (CLAUDE.md §2). RLS-enabled (FORCE + REVOKE in the migration);
// the throttle/verify is server-side only.
// ---------------------------------------------------------------------------
export const workerCredentials = pgTable(
  "worker_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workerId: uuid("worker_id")
      .notNull()
      // One PIN per worker; DPDP actor-scoped erasure cascades from workers.
      .references(() => workers.id, { onDelete: "cascade" }),
    // Slow-KDF self-encoded hash (scrypt-v1.<salt>.<derived>) — NEVER the raw PIN,
    // NEVER the pepper. Salt embedded → no separate pin_salt column. Algo-agnostic.
    pinHash: text("pin_hash").notNull(),
    // Server-side throttle state (Phase 3): never exposed, never in events/logs.
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lockoutCycles: integer("lockout_cycles").notNull().default(0),
    // Durable per-worker count of force-OTP escalations: when the per-(worker,device)
    // lockout escalation reaches the configured K cycles, this is bumped and the PIN is
    // invalidated until an OTP-gated reset. Lives in the DB (NOT Redis) so a Redis flush
    // cannot wipe the force-OTP state. Server-side only; never in events/ai_jobs/logs.
    otpCycleCount: integer("otp_cycle_count").notNull().default(0),
    // Which PIN_PEPPER version hashed this row's pin_hash — for future pepper rotation +
    // rehash-on-verify. Default 1 (the only version today). Never the pepper itself.
    pepperVersion: integer("pepper_version").notNull().default(1),
    pinUpdatedAt: timestamp("pin_updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One credential row per worker (UNIQUE — a single PIN per account).
    uniqueIndex("worker_credentials_worker_id_uq").on(t.workerId),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by the migration (ADR-0004 posture)

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
    index("worker_profiles_embedding_hnsw").using("hnsw", t.embedding.op("vector_cosine_ops")),
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
// job_postings (ADR-0012) — ops-created, vacancy-banded, stored-only postings.
//
// Phase 1 scope: this is a STORED-ONLY record an ops actor creates. It does NOT
// feed ranking/matching (Reach Engine is deferred) and has NO worker linkage.
//
// PRIVACY: org_label / role_title / location_label / description are NON-PII
// free text by contract — ops must not type a worker's phone/name/etc. into
// them. That boundary is enforced in the API/event layer; the table just stores
// the strings. `created_by` is an OPAQUE ops-actor id (no FK to anything).
// `id` is the subject_id for all job_posting.* events.
//
// `vacancy_band` is BANDED text (not an integer count) on purpose — distinct
// from any vacancy_count column. CHECK constraints pin both unions at the DB
// (mirrors VACANCY_BANDS / JOB_POSTING_STATUSES in @badabhai/types).
// ---------------------------------------------------------------------------
export const jobPostings = pgTable(
  "job_postings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Opaque ops-actor id — deliberately NO foreign key to any table.
    createdBy: uuid("created_by").notNull(),
    // Opaque OWNER payer ref (ADR-0019/ADR-0022 module 9 — payer self-serve posting).
    // NULLABLE + NO foreign key (the "faceless-rails" pattern, mirroring jobs.payer_id):
    // ops-created postings leave it NULL (the existing surface is unchanged); a payer-
    // created posting stamps the SESSION payer here, and the payer routes scope every
    // read/write by it (tenancy). Never enters an event payload — the event ACTOR
    // (actor_type:"payer", actor_id) carries the payer id, opaque, instead.
    payerId: uuid("payer_id"),
    orgLabel: text("org_label").notNull(),
    roleTitle: text("role_title").notNull(),
    locationLabel: text("location_label"),
    description: text("description"),
    vacancyBand: text("vacancy_band").$type<VacancyBand>().notNull(),
    status: text("status").$type<JobPostingStatus>().notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [
    // Backs the ops list endpoint: filter by `status`, order by `created_at desc`.
    index("job_postings_status_created_at_idx").on(t.status, t.createdAt),
    // Backs the payer self-serve list (own postings, newest first): WHERE payer_id, status.
    index("job_postings_payer_id_idx").on(t.payerId, t.createdAt),
    // Pin the banded vacancy to the 5 allowed values (mirrors VACANCY_BANDS).
    check(
      "job_postings_vacancy_band_chk",
      sql`${t.vacancyBand} IN ('1', '2-5', '6-10', '11-25', '25+')`,
    ),
    // Pin the lifecycle to the 3 allowed values (mirrors JOB_POSTING_STATUSES).
    check("job_postings_status_chk", sql`${t.status} IN ('draft', 'open', 'closed')`),
  ],
);

// Alpha swipe-to-apply (ADR-0009) — seeded jobs + apply/skip records.
//
// A scoped early activation that sits beside Phase 1: a worker sees a small set
// of seeded jobs and applies or skips, producing the PII-free `feed.shown` /
// `application.submitted` / `application.skipped` events defined in ADR-0006.
// Strictly additive, backward-compatible (CLAUDE.md §2 invariant 8).
//
// PRIVACY (ADR-0009 §2): both tables are PII-free. `jobs` carries ZERO PII — no
// employer name/id, no contact/phone, no exact address/geo, no pay/salary (those
// are deferred Phase-2 economics, ADR-0009 §6). The ONLY join back to identity is
// `applications.worker_id` → `workers` (where PII already lives, RLS-locked). This
// creates no new PII surface.
// ---------------------------------------------------------------------------

/**
 * The 15 alpha trade keys (ADR-0009 §2 / OQ-2). These are the SAME stable keys
 * as `REQUIRED_TRADE_KEYS` in apps/api (`src/resume/trade-content.ts`) and
 * `REQUIRED_KIT_TRADE_KEYS` (`src/interview-kit/interview-kit-content.ts`) — the
 * authoritative list. They are mirrored here (not imported) because `@badabhai/db`
 * must not depend upward on `apps/api`, and the placeholder `@badabhai/taxonomy`
 * only carries the 7 CNC/VMC role ids, not these 15 trade keys. Keep in sync if
 * the alpha trade list ever changes.
 *
 * HOSPITALITY (second vertical) — the 9 `hosp_*` keys below are the MIRROR half of
 * the PRD §6 "mirror-and-sync" wiring (sources of truth: `REQUIRED_HOSP_TRADE_KEYS`
 * in apps/api `src/resume/hospitality-trade-content.ts` + `REQUIRED_HOSP_KIT_TRADE_KEYS`
 * in `src/interview-kit/hospitality-interview-kit-content.ts`). Additive + backward-
 * compatible: manufacturing keys are unchanged. The content is **DRAFTED, pending RVM
 * — NOT live** (docs/registers/hospitality-trade-content-ratification.md); these keys
 * are typed so jobs CAN reference them once a trade is RVM-ratified, but no live
 * surface serves hospitality content yet. TD31 (shared taxonomy package) stays deferred.
 */
export type TradeKey =
  // --- Manufacturing (15, alpha; ADR-0009 §2 / OQ-2) ---
  | "cnc_operator"
  | "vmc_operator"
  | "cnc_vmc_setter"
  | "cnc_programmer"
  | "vmc_programmer"
  | "cad_designer"
  | "solidworks_designer"
  | "autocad_draftsman"
  | "quality_inspector"
  | "production_engineer"
  | "maintenance_technician"
  | "tool_room_technician"
  | "machine_operator"
  | "assembly_technician"
  | "fitter"
  // --- Hospitality (9, second vertical; DRAFTED, pending RVM — not live) ---
  | "hosp_steward_waiter"
  | "hosp_commis_cook"
  | "hosp_room_attendant"
  | "hosp_front_office"
  | "hosp_fnb_captain"
  | "hosp_bartender"
  | "hosp_kitchen_steward"
  | "hosp_banquet_server"
  | "hosp_barista";

/** Job lifecycle — a seed job can be retired without deleting the row. */
export type JobStatus = "open" | "closed";

/**
 * When the job needs someone — the demand-side availability signal the Reach RANK
 * core's `neededBy` consumes (ADR-0011; mirrors JobSpec.neededBy). Non-PII.
 */
export type JobNeededBy = "immediate" | "soon" | "flexible";

/** Apply/skip decision. Mirrors the `applications` event family. */
export type ApplicationAction = "applied" | "skipped";

/**
 * Coarse, non-PII skip reason (no free text). Mirrors the `application.skipped`
 * event payload enum in @badabhai/event-schema (payloads.ts). NULL for applies.
 */
export type SkipReason = "not_interested" | "too_far" | "low_pay" | "wrong_trade" | "other";

/**
 * Where the apply/skip originated. Mirrors the `application.submitted` event
 * payload `source_surface` enum in @badabhai/event-schema (payloads.ts).
 */
export type SourceSurface = "feed" | "search" | "share" | "other";

// jobs — seeded, coarse, NO employer PII. `id` is the opaque job_id in events.
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // One of the 15 alpha trade keys (taxonomy linkage, ADR-0009 OQ-2). Not a PII
    // employer reference — a generic trade classification.
    tradeKey: text("trade_key").$type<TradeKey>().notNull(),
    // Generic role title authored in the seed (e.g. "CNC Operator — Night Shift").
    // NEVER an employer name (ADR-0009 §2 privacy line).
    title: text("title").notNull(),
    // COARSE location — city only, non-PII (e.g. "Pune"). Never an address.
    city: text("city").notNull(),
    // COARSE locality bucket (e.g. "Pimpri-Chinchwad"), NOT an address. Nullable.
    area: text("area"),
    status: text("status").$type<JobStatus>().notNull().default("open"),
    // ADR-0010 §Decision 0 (evolve-not-replace): the opaque "faceless-rails" SELLER
    // id — the payer (employer OR agent) who posted this job. ADDITIVE, NULLABLE, NO
    // FK, NO `payers` identity table, and NEVER an employer name or any employer PII.
    // It only ties a job to a billable payer for the unlock spine (ADR-0010 §D6);
    // PR #42 introduces the same column on its richer jobs entity — whichever lands
    // first owns it, the other consumes it. NEVER resolved to identity in any event
    // or log.
    payerId: uuid("payer_id"),
    // Denormalized on-row counter of applies received for this job (ADR-0009
    // swipe-to-apply). Each apply still emits its own `application.submitted` event;
    // this is just an integer rollup for the feed/UI. PII-FREE (a count, never a name).
    // Mirrors posting_plans.applicantsViewedCount style.
    applicantsReceived: integer("applicants_received").notNull().default(0),
    // ── Demand-side ranking signals (ADR-0011 Reach-on-real-jobs) ──────────────
    // Feed the RANK core's Pay/Experience/Availability factors when Reach serves
    // this job. ALL NULLABLE + additive (the engine neutral-defaults a null — a
    // blank never drops or penalizes anyone). PII-FREE: pay bands / year counts /
    // a coarse timing enum — never an employer or a worker identity. Role (trade_key)
    // and Distance (city) are already present above, so no column is needed for them.
    // Monthly pay band offered (INR, whole rupees — never paise).
    payMin: integer("pay_min"),
    payMax: integer("pay_max"),
    // Experience window the job targets (years).
    minExperienceYears: integer("min_experience_years"),
    maxExperienceYears: integer("max_experience_years"),
    // When the job needs someone (coarse enum).
    neededBy: text("needed_by").$type<JobNeededBy>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Backs the worker feed + reach open-jobs queries: filter `status='open'`,
    // order by `created_at` (id tiebreak via the PK). Also serves the status filter.
    index("jobs_status_created_at_idx").on(t.status, t.createdAt),
    check("jobs_applicants_received_nonneg_chk", sql`${t.applicantsReceived} >= 0`),
    // Pay/experience are non-negative when present, and the max is not below the min.
    check(
      "jobs_pay_nonneg_chk",
      sql`(${t.payMin} IS NULL OR ${t.payMin} >= 0) AND (${t.payMax} IS NULL OR ${t.payMax} >= 0)`,
    ),
    check(
      "jobs_pay_order_chk",
      sql`${t.payMin} IS NULL OR ${t.payMax} IS NULL OR ${t.payMax} >= ${t.payMin}`,
    ),
    check(
      "jobs_experience_nonneg_chk",
      sql`(${t.minExperienceYears} IS NULL OR ${t.minExperienceYears} >= 0) AND (${t.maxExperienceYears} IS NULL OR ${t.maxExperienceYears} >= 0)`,
    ),
    check(
      "jobs_experience_order_chk",
      sql`${t.minExperienceYears} IS NULL OR ${t.maxExperienceYears} IS NULL OR ${t.maxExperienceYears} >= ${t.minExperienceYears}`,
    ),
    check(
      "jobs_needed_by_chk",
      sql`${t.neededBy} IS NULL OR ${t.neededBy} IN ('immediate', 'soon', 'flexible')`,
    ),
  ],
);

// applications — the apply/skip record, PII-free. One decision per (worker, job).
export const applications = pgTable(
  "applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    // The ONLY join back to identity; PII stays in `workers` (RLS-locked).
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    action: text("action").$type<ApplicationAction>().notNull(),
    // Populated ONLY when action='skipped' (enforced by the CHECK below); NULL for
    // applies. Coarse enum — no free text (PII-free).
    reason: text("reason").$type<SkipReason>(),
    sourceSurface: text("source_surface").$type<SourceSurface>().notNull().default("feed"),
    // The seed display position the action was taken from; nullable.
    rank: integer("rank"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Idempotency / natural key: at most one decision per (worker, job). Makes
    // apply/skip a safe upsert — last-write-wins via ON CONFLICT (worker_id,
    // job_id) DO UPDATE (ADR-0009 §2). Also serves worker_id-leading ops lookups
    // ("decisions per worker"), so no separate worker_id index is needed.
    uniqueIndex("applications_worker_job_uq").on(t.workerId, t.jobId),
    // Ops read: applicants per job.
    index("applications_job_id_idx").on(t.jobId),
    // `reason` is only valid on a skip (NULL otherwise).
    check("applications_reason_chk", sql`${t.reason} IS NULL OR ${t.action} = 'skipped'`),
  ],
);

// ---------------------------------------------------------------------------
// Contact Unlock + Reveal (ADR-0010, Stream A) — the routed-disclosure spine.
//
// All four tables are STRICTLY ADDITIVE and PII-FREE: ids + enums + counts +
// opaque tokens ONLY. The ONLY join back to identity is `unlocks.worker_id` →
// `workers` (where PII already lives, RLS-locked) — exactly like `applications`.
// `payer_id` is the opaque "faceless-rails" payer ref (NO FK, NO `payers` table,
// NO employer PII; ADR-0010 §Decision 0). The raw phone is read transiently from
// `workers` ONLY at reveal time and is NEVER written into ANY of these tables, any
// event payload, `ai_jobs`, `audit_logs`, or any log line (CLAUDE.md invariant 2;
// ADR-0010 §D2 / Phase-0 F-4/F-5). No table below has a phone/name/contact column.
//
// Alpha is MOCK CREDITS ONLY (no real money) and IN-APP RELAY ONLY (no telephony
// provider) — real payment/telephony keys remain hard human-gated escalations
// (ADR-0010 §EXPLICITLY OUT, CLAUDE.md §7). These tables join the RLS backlog
// (TD20) and are ENABLE+FORCE RLS + REVOKE-ALL locked in migration 0014, in the
// same migration that creates them (the proven 0012 pattern).
// ---------------------------------------------------------------------------

/**
 * Unlock lifecycle (ADR-0010 §D6.1). `requested` at entry → `granted` once
 * consent+caps+credit pass → `revealed` after a routed contact attempt → `expired`
 * when the 14-day window lapses → `denied` on any fail-closed gate. Default
 * `requested`.
 */
export type UnlockStatus = "requested" | "granted" | "revealed" | "expired" | "denied";

/**
 * INTERNAL-ONLY deny reason (ADR-0010 §D4 no-oracle rule). Recorded for the audit
 * spine; it is NEVER echoed to a payer (the payer only ever sees a neutral
 * "unavailable" / "payment_required"). Null unless `status='denied'`.
 */
export type UnlockDenyReason = "no_consent" | "capped" | "payment_required" | "unknown_worker";

/**
 * Append-only credit-ledger movement reason (ADR-0010 §D5). `pack_purchase` =
 * a payer bought a credit pack (mock in alpha, see credit-packs.ts); `unlock_debit`
 * = one credit spent to grant an unlock; `refund` = a credit returned; `grant` =
 * an ops/internal top-up (no real money). No currency/PAN/UPI is ever stored —
 * `payment_ref` is an OPAQUE external order id only, never card/PII data.
 */
export type CreditReason = "pack_purchase" | "unlock_debit" | "refund" | "grant";

/**
 * Routed-channel kind (ADR-0010 §D2). Alpha ships `in_app_relay` ONLY — it
 * discloses NO number and needs NO external provider. `proxy_number` is the
 * production routed channel and is human-gated (real telephony key + spend).
 */
export type RoutingChannel = "in_app_relay" | "proxy_number";

// unlocks — one routed-contact GRANT (per payer per candidate profile). PII-FREE.
// Natural key (payer_id, worker_id): per-profile granularity (§Sign-off resolutions)
// — one idempotent unlock per payer per candidate; a retried request converges on
// the same row (last-state-wins; per-attempt audit lives in events). `job_id` is
// OPTIONAL context (granularity is per-profile, not per-(worker, job)).
//
// DPDP erasure posture (ADR-0026 Phase 5, D3): `worker_id` is `onDelete: "set null"`
// + NULLABLE — a worker hard-delete (DSAR) PRESERVES this PII-free PAID grant and
// only nulls the identity join. Cascading here would DESTROY billing history; this
// mirrors the `agency_invites`/`invites.invited_worker_id` "keep INTENT history
// intact" posture. Existing rows keep their (non-null) worker_id; SET NULL fires
// only on a future worker DELETE.
export const unlocks = pgTable(
  "unlocks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Opaque payer ref (employer OR agent) — faceless rails, NO FK, NO PII.
    payerId: uuid("payer_id").notNull(),
    // The ONLY join back to identity; PII stays in `workers` (RLS-locked).
    // NULLABLE + onDelete:"set null" — DSAR erasure nulls the join, keeps the
    // PII-free paid-grant row (ADR-0026 Phase 5 D3).
    workerId: uuid("worker_id").references(() => workers.id, { onDelete: "set null" }),
    // Optional job context (per-profile granularity, so nullable). FK to jobs.
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    status: text("status").$type<UnlockStatus>().notNull().default("requested"),
    // INTERNAL audit only — NEVER returned to a payer (no-oracle, §D4). Null unless
    // status='denied' (enforced by the CHECK below).
    denyReason: text("deny_reason").$type<UnlockDenyReason>(),
    // Opaque pointer into `unlock_routing` (server-internal). NOT a contact, NOT a
    // phone. Null until granted. The token itself never leaves the server (F-4).
    routingTokenRef: uuid("routing_token_ref"),
    // Routed contact attempts used (cap enforced in the service chokepoint, §D4).
    revealCount: integer("reveal_count").notNull().default(0),
    grantedAt: timestamp("granted_at", { withTimezone: true }),
    // 14-day access window end (§Sign-off resolutions / §D1). Null until granted.
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Per-profile idempotency: at most one unlock per (payer, candidate).
    uniqueIndex("unlocks_payer_worker_uq").on(t.payerId, t.workerId),
    // Ops read: unlocks per worker (also feeds the per-worker cap reads).
    index("unlocks_worker_id_idx").on(t.workerId),
    // Ops/cap read: unlocks per payer.
    index("unlocks_payer_id_idx").on(t.payerId),
    // deny_reason is only valid on a deny (NULL otherwise).
    check("unlocks_deny_reason_chk", sql`${t.denyReason} IS NULL OR ${t.status} = 'denied'`),
  ],
);

// payer_credits — mock credit balance, one row per payer. Amounts + ids ONLY.
// NO real money in alpha (§D5). balance is a materialization of `credit_ledger`.
export const payerCredits = pgTable(
  "payer_credits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Opaque payer ref (no FK, no PII). One balance row per payer.
    payerId: uuid("payer_id").notNull(),
    // Unlock credits available. Phase-0 F-6: must never go negative.
    balance: integer("balance").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("payer_credits_payer_id_uq").on(t.payerId),
    // F-6: balance is never negative (a debit below zero must fail closed).
    check("payer_credits_balance_nonneg_chk", sql`${t.balance} >= 0`),
  ],
);

// credit_ledger — APPEND-ONLY credit movements (the source of truth; balance is a
// materialization of it). Amounts + ids ONLY. NO currency/PAN/UPI — `payment_ref`
// is an OPAQUE external payment/order id only, NEVER card/PII data (§D5).
export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    payerId: uuid("payer_id").notNull(),
    // +grant / -debit. Signed credit movement.
    delta: integer("delta").notNull(),
    reason: text("reason").$type<CreditReason>().notNull(),
    // Set for unlock_debit / refund (which unlock spent/returned the credit).
    unlockId: uuid("unlock_id").references(() => unlocks.id, { onDelete: "set null" }),
    // For pack_purchase: the pack code bought (e.g. 'pack_10' | 'pack_25'). Null otherwise.
    packCode: text("pack_code"),
    // OPAQUE external payment/order ref ONLY (e.g. a gateway order id) — NEVER card
    // number, UPI handle, or any PII. Null for ops grants / mock debits.
    paymentRef: text("payment_ref"),
    // EXACTLY-ONCE money guard (ADMIN-3a H2). An OPAQUE, caller-supplied stable key for a
    // logical credit movement (e.g. an admin grant). The partial unique index below makes the
    // ledger insert idempotent under at-least-once retry: a re-submit with the SAME key inserts
    // NO second row and changes NO balance. NULLABLE on purpose (NULLS DISTINCT) — movements with
    // no natural dedup key (legacy/mock debits) leave it null and never collide. Carries NO PII /
    // value — an opaque UUID only; the admin.action_performed event is keyed on the SAME value so
    // ledger + spine agree (no double-spend / no money-vs-spine divergence).
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("credit_ledger_payer_id_idx").on(t.payerId),
    // Exactly-once: non-null keys are unique; many NULLs allowed (Postgres NULLS DISTINCT).
    uniqueIndex("credit_ledger_idempotency_key_uq").on(t.idempotencyKey),
  ],
);

// unlock_routing — SERVER-SIDE-ONLY routing mapping (ADR-0010 §D2 / Phase-0 F-4/F-5).
// PII-FREE BY CONSTRUCTION: it maps an opaque routing token → a channel + an
// expiring, NON-reversible payer-facing handle. There is ABSOLUTELY NO phone / name
// / contact / proxy-number column here. The raw phone is read transiently from
// `workers.phoneE164` (PiiCryptoService) ONLY inside the reveal handler, handed to
// the relay/provider, and DISCARDED — it is NEVER stored on this row. The
// `routing_token` is the 122-bit server-internal token and NEVER appears in any
// response, event payload, or log (F-4).
export const unlockRouting = pgTable(
  "unlock_routing",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    unlockId: uuid("unlock_id")
      .notNull()
      .references(() => unlocks.id, { onDelete: "cascade" }),
    // 122-bit server-internal token (UUIDv4). NEVER returned/evented (F-4).
    routingToken: uuid("routing_token").notNull(),
    channel: text("channel").$type<RoutingChannel>().notNull(),
    // The payer-facing, NON-reversible, expiring handle for the routed channel —
    // NOT a phone, NOT reversible to one. Alpha: an in-app relay handle.
    relayHandle: text("relay_handle").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The token is the server-internal lookup key; it must be unique.
    uniqueIndex("unlock_routing_routing_token_uq").on(t.routingToken),
    index("unlock_routing_unlock_id_idx").on(t.unlockId),
  ],
);

// ---------------------------------------------------------------------------
// Monetization + Pricing Engine (ADR-0013) — additive, PII-FREE. The pricing
// catalog VALUES live here (ops-editable, Zod-validated on load by
// @badabhai/pricing, fail-closed). Entitlement tables record paid posting plans /
// boosters and (FREE) resume disclosures. NO raw PII: payer_id is opaque
// faceless-rails (no FK), and the only identity join is *_disclosures.worker_id →
// workers (RLS-locked). Resume bytes / names / download links never live here.
// ---------------------------------------------------------------------------

/** Paid posting plan tier (mirrors @badabhai/pricing PostingTier; kept local to avoid an upward dep). */
export type PostingPlanTier = "standard" | "pro";
/**
 * Posting plan lifecycle (orthogonal to the ADR-0012 job_posting content lifecycle).
 * 'paused' (ADR-0016 D3): a plan whose payer is over their active-vacancy capacity —
 * it is NOT counted as an active vacancy and does NOT serve. Additive enum-widening:
 * the prior three values stay valid (backward-compatible, CLAUDE.md §2 #8 / ADR-0014).
 */
export type PostingPlanStatus = "draft" | "active" | "expired" | "paused";
/** Booster tier (single tier today; extensible via the catalog). */
export type BoostTier = "all_candidates";
/** Booster lifecycle. */
export type BoostStatus = "active" | "expired";
/** Resume-disclosure lifecycle (ADR-0013 C.3). Resume download is FREE — no payment state. */
export type DisclosureStatus = "requested" | "granted" | "disclosed" | "denied" | "expired";
/** INTERNAL-only deny reason (never returned — no-oracle, ADR-0010 F-3). No "payment_required" (free). */
export type DisclosureDenyReason = "no_consent" | "capped" | "unknown_worker";

// pricing_catalog — the config-builder store (ADR-0013 Decision A). One ACTIVE row
// holds the whole validated catalog as JSON; prior rows are kept as history. The
// engine loads the active row and Zod-validates it (fail-closed to the typed
// default). PII-FREE: codes + integer ₹ amounts + percentages only.
export const pricingCatalog = pgTable(
  "pricing_catalog",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The full catalog payload (products/offers/coupons). Validated by
    // @badabhai/pricing `safeParseCatalog` on load — never trusted unvalidated.
    catalog: jsonb("catalog").notNull(),
    // Monotonic catalog revision (bumped on each ops edit).
    revision: integer("revision").notNull().default(1),
    // Exactly one active row (partial unique index below).
    isActive: boolean("is_active").notNull().default(true),
    // Opaque ops actor who wrote this revision (no PII). Mirrors job_postings.created_by.
    updatedBy: uuid("updated_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // At most one active catalog row at a time.
    uniqueIndex("pricing_catalog_active_uq")
      .on(t.isActive)
      .where(sql`${t.isActive}`),
  ],
);

// posting_plans — a paid plan attached to a job_posting (ADR-0013 B.2). Price/quota/
// window are STAMPED from the catalog at purchase (the row is the receipt). PII-FREE.
export const postingPlans = pgTable(
  "posting_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobPostingId: uuid("job_posting_id")
      .notNull()
      .references(() => jobPostings.id, { onDelete: "cascade" }),
    // Opaque payer (employer OR agent) — faceless rails, NO FK, NO PII.
    payerId: uuid("payer_id").notNull(),
    tier: text("tier").$type<PostingPlanTier>().notNull(),
    // Stamped from the catalog at purchase (10 / 30); the cap on applicant views.
    applicantVisibilityQuota: integer("applicant_visibility_quota").notNull(),
    // Atomic check-and-increment at the single view chokepoint (ADR-0010 F-2 discipline).
    applicantsViewedCount: integer("applicants_viewed_count").notNull().default(0),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    status: text("status").$type<PostingPlanStatus>().notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("posting_plans_job_posting_id_idx").on(t.jobPostingId),
    index("posting_plans_payer_id_idx").on(t.payerId),
    check("posting_plans_tier_chk", sql`${t.tier} IN ('standard', 'pro')`),
    check("posting_plans_status_chk", sql`${t.status} IN ('draft', 'active', 'expired', 'paused')`),
    check("posting_plans_viewed_nonneg_chk", sql`${t.applicantsViewedCount} >= 0`),
  ],
);

// posting_boosts — a booster on a job_posting (ADR-0013 B.2). PII-FREE.
export const postingBoosts = pgTable(
  "posting_boosts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobPostingId: uuid("job_posting_id")
      .notNull()
      .references(() => jobPostings.id, { onDelete: "cascade" }),
    payerId: uuid("payer_id").notNull(),
    tier: text("tier").$type<BoostTier>().notNull().default("all_candidates"),
    boostStartsAt: timestamp("boost_starts_at", { withTimezone: true }),
    boostEndsAt: timestamp("boost_ends_at", { withTimezone: true }),
    status: text("status").$type<BoostStatus>().notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("posting_boosts_job_posting_id_idx").on(t.jobPostingId),
    index("posting_boosts_payer_id_idx").on(t.payerId),
    check("posting_boosts_tier_chk", sql`${t.tier} IN ('all_candidates')`),
    check("posting_boosts_status_chk", sql`${t.status} IN ('active', 'expired')`),
  ],
);

// resume_disclosures — one resume-download GRANT (ADR-0013 C.3). Resume download is
// FREE but is a PII DISCLOSURE — it rides the ADR-0010 consent+caps spine. PII-FREE
// by construction: the resume bytes / name / download link are NEVER here. `resume_ref`
// is an opaque pointer into generated_resumes; worker_id is the only identity join.
//
// DPDP erasure posture (ADR-0026 Phase 5, D3): `worker_id` is `onDelete: "set null"`
// + NULLABLE — a worker hard-delete (DSAR) PRESERVES this PII-free disclosure record
// and only nulls the identity join. Cascading here would DESTROY disclosure history;
// this mirrors the `agency_invites`/`invites.invited_worker_id` "keep INTENT history
// intact" posture. Existing rows keep their (non-null) worker_id; SET NULL fires
// only on a future worker DELETE.
export const resumeDisclosures = pgTable(
  "resume_disclosures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    payerId: uuid("payer_id").notNull(),
    // NULLABLE + onDelete:"set null" — DSAR erasure nulls the join, keeps the
    // PII-free disclosure row (ADR-0026 Phase 5 D3).
    workerId: uuid("worker_id").references(() => workers.id, { onDelete: "set null" }),
    // Scope to a posting if downloaded from a candidates page; null for pure search.
    jobPostingId: uuid("job_posting_id").references(() => jobPostings.id, { onDelete: "set null" }),
    // Which resume artifact was disclosed (a pointer, NOT the bytes).
    resumeRef: uuid("resume_ref").references(() => generatedResumes.id, { onDelete: "set null" }),
    status: text("status").$type<DisclosureStatus>().notNull().default("requested"),
    // INTERNAL only — NEVER returned (no-oracle). Null unless status='denied'.
    denyReason: text("deny_reason").$type<DisclosureDenyReason>(),
    disclosedAt: timestamp("disclosed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Idempotent grant per (payer, worker, posting) — mirrors `unlocks` (NULLS DISTINCT
    // means pure-search disclosures with a null posting never collide).
    uniqueIndex("resume_disclosures_payer_worker_posting_uq").on(
      t.payerId,
      t.workerId,
      t.jobPostingId,
    ),
    index("resume_disclosures_worker_id_idx").on(t.workerId),
    index("resume_disclosures_payer_id_idx").on(t.payerId),
    check(
      "resume_disclosures_deny_reason_chk",
      sql`${t.denyReason} IS NULL OR ${t.status} = 'denied'`,
    ),
  ],
);

// payer_capacity — the per-payer ALLOWANCE of concurrently-active vacancies (ADR-0016
// D4, signed PHASE-0 2026-06-17). FACELESS & PII-FREE by construction: `payer_id` is
// the same OPAQUE rail as posting_plans.payer_id — NO FK, NO identity, NO "employer
// entity" (a dead decision). One row per payer caps how many posting_plans they may hold
// in status='active' at once; over-cap plans are 'paused' (ADR-0016 D3) and do not serve.
// The CURRENT active-vacancy count is NOT stored here — it is DERIVED by COUNT over
// posting_plans (status='active') grouped by payer_id (no drift-prone side counter,
// ADR-0010 F-2 discipline). This table holds only the allowance + its validity window.
export const payerCapacity = pgTable(
  "payer_capacity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Opaque payer (employer OR agent) — faceless rails, NO FK, NO PII.
    payerId: uuid("payer_id").notNull(),
    // How many posting_plans this payer may hold in status='active' concurrently.
    maxActiveVacancies: integer("max_active_vacancies").notNull(),
    // The capacity-catalog tier code that granted this allowance (a stable code, NOT
    // PII). Nullable: a manually-granted/seeded allowance need not cite a tier.
    sourceTier: text("source_tier"),
    // Optional validity window — null = no expiry.
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One capacity row per payer (this unique index also serves payer_id lookups —
    // no separate payer_id index needed).
    uniqueIndex("payer_capacity_payer_id_uq").on(t.payerId),
    check("payer_capacity_max_nonneg_chk", sql`${t.maxActiveVacancies} >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// invites — WhatsApp invite/referral funnel (ADR-0020). PII-FREE.
//
// An invite is a shareable deep-link (`/i/<code>`). The `code` is an opaque
// token; `inviter_worker_id` / `invited_worker_id` are opaque worker UUIDs — NO
// phone, NO name, NO message body ever lands here (the phone touches the WhatsApp
// provider only, at send time). This is the upstream attribution signal the
// deferred agency-referral payout will consume. RLS-enabled (REVOKE in the
// migration, spine posture). `invited_worker_id` is set on signup-acceptance.
//
// DPDP erasure posture (ADR-0026 Phase 5, D3): BOTH `inviter_worker_id` and
// `invited_worker_id` are `onDelete: "set null"` + NULLABLE — a worker hard-delete
// (DSAR) PRESERVES this PII-free referral-attribution row and only nulls the
// identity join(s). `inviter_worker_id` was changed cascade→set-null here so an
// inviter's erasure no longer DESTROYS referral history; it now matches the
// already-correct `invited_worker_id` "keep INTENT history intact" posture.
// Existing rows keep their (non-null) inviter_worker_id; SET NULL fires only on a
// future worker DELETE.
// ---------------------------------------------------------------------------
export type InviteChannel = "whatsapp";
export type InviteStatus = "created" | "clicked" | "accepted";

export const invites = pgTable(
  "invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The opaque deep-link token (the only thing shared). Unique.
    code: text("code").notNull(),
    // NULLABLE + onDelete:"set null" — DSAR erasure nulls the join, keeps the
    // PII-free referral-attribution row (ADR-0026 Phase 5 D3).
    inviterWorkerId: uuid("inviter_worker_id").references(() => workers.id, {
      onDelete: "set null",
    }),
    // Set when an invited person becomes a worker (attribution). Nullable until then.
    invitedWorkerId: uuid("invited_worker_id").references(() => workers.id, {
      onDelete: "set null",
    }),
    channel: text("channel").$type<InviteChannel>().notNull().default("whatsapp"),
    status: text("status").$type<InviteStatus>().notNull().default("created"),
    // Optional non-PII campaign tag (a stable code, never free-form PII).
    campaign: text("campaign"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("invites_code_uq").on(t.code),
    index("invites_inviter_worker_id_idx").on(t.inviterWorkerId),
  ],
).enableRLS(); // RLS tracked in the model; REVOKE carried by the migration (spine posture)

// ---------------------------------------------------------------------------
// agency_invites — AGENCY supply-attribution INTENT (ADR-0022). FACELESS, ids-only.
//
// The SIBLING of `invites` (the worker→worker funnel above). A distinct table — NOT
// a reuse — because `invites.inviter_worker_id` is `NOT NULL → workers`, while here
// the inviter is a PAYER (the agency, `payers.role = 'agent'`): a different principal
// on a different identity axis. Forcing both funnels through one table would have
// meant a nullable worker FK + a payer FK + a discriminator on every row — strictly
// worse than two purpose-built tables (ADR-0022, ACCEPTED).
//
// An agency invite is a shareable deep-link (`/i/<code>`). The `code` is an opaque
// token (the only thing shared); NO phone, NO name, NO email, NO message body ever
// lands here — the worker's contact touches the WhatsApp provider only, at send time.
// `invited_worker_id` is the attribution handle, set ONLY after the invited person
// becomes a worker with `consent.accepted` (DPDP gate, invariant #6).
//
// FACELESS / ids-only by construction: ABSOLUTELY NO KYC / bank / PAN / GST / payout /
// commission / money / amount column ever (the deferred agency-payout rails consume
// this as an upstream signal; they do NOT live here). The only references are opaque
// UUIDs (`inviter_payer_id`, `invited_worker_id`) + enums + a stable non-PII campaign
// tag — exactly the `invites` discipline.
//
// SECURITY (ADR-0022 Appendix C #3): `invited_worker_id` is a NEW payer-side handle
// onto a worker, so this table ships the full spine lock — ENABLE + FORCE ROW LEVEL
// SECURITY + REVOKE ALL from PUBLIC/anon/authenticated/service_role (carried by the
// migration). Phase-1 isolation is the APP-LAYER chokepoint (`assertPayerOwns` on
// `inviter_payer_id`); DB-enforced per-payer RLS is the open-GA launch gate, like the
// rest of the payer-owned spine (rls-plan.md).
// ---------------------------------------------------------------------------
export type AgencyInviteChannel = InviteChannel; // mirror the invite channel enum ('whatsapp')
export type AgencyInviteStatus = InviteStatus; // 'created' | 'clicked' | 'accepted'

export const agencyInvites = pgTable(
  "agency_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The agency that owns this invite (a `payers` row with role='agent'). FK to
    // payers(id): an INTERNAL tenant entity, NOT worker PII, so a real FK + cascade
    // is appropriate and keeps referential integrity. `payer_id` is the only token
    // for the agency — its B2B contact PII stays in `payers`, never copied here.
    inviterPayerId: uuid("inviter_payer_id")
      .notNull()
      .references(() => payers.id, { onDelete: "cascade" }),
    // The opaque deep-link token (the only thing shared). Unique.
    code: text("code").notNull(),
    // Attribution handle: set ONLY after the invited person becomes a worker with
    // consent.accepted (invariant #6). Nullable until then. FK to workers(id) with
    // ON DELETE SET NULL — mirrors `invites.invited_worker_id`: the FK preserves
    // referential integrity (no dangling worker id), and SET NULL keeps the
    // attribution row's INTENT history intact when a worker is hard-deleted (DSAR).
    // The table's FORCE-RLS + REVOKE lock is what keeps this payer→worker handle
    // app-layer-only, satisfying ADR-0022 Appendix C #3.
    invitedWorkerId: uuid("invited_worker_id").references(() => workers.id, {
      onDelete: "set null",
    }),
    channel: text("channel").$type<AgencyInviteChannel>().notNull().default("whatsapp"),
    status: text("status").$type<AgencyInviteStatus>().notNull().default("created"),
    // Optional non-PII campaign tag (a stable code, never free-form PII) — mirrors
    // the `invites.campaign` rule.
    campaign: text("campaign"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("agency_invites_code_uq").on(t.code),
    // Owner-scoped reads (the agency's own invites — the assertPayerOwns hot path).
    index("agency_invites_inviter_payer_id_idx").on(t.inviterPayerId),
    // Reverse lookup: which invite attributed a given worker (set-once, sparse).
    index("agency_invites_invited_worker_id_idx").on(t.invitedWorkerId),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by the migration (spine posture)

// ---------------------------------------------------------------------------
// pace_states — per-job PACE supply-widening run state (ADR-0021). PII-FREE.
//
// One row per job under PACE. Tracks the current widen stage + area band, when the
// run began (the clock for the 6–24h window; elapsed is derived), the last observed
// above-floor good-fit supply count, and whether the ops alert has fired (idempotency).
// FACELESS: the only reference is the opaque job_id (the faceless `jobs` row) — NO
// worker/employer/location ever lands here. The widen decision that mutates this is a
// PURE config-driven rule (no LLM, invariant 4). RLS-enabled (REVOKE carried by the
// migration, spine posture).
// ---------------------------------------------------------------------------
export type PaceStage = "base" | "area" | "adjacent_trade" | "ops_alert";

export const paceStates = pgTable(
  "pace_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The opaque job this PACE run widens (faceless `jobs` row; cascade on delete).
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    // Escalation stage: base → area → [adjacent_trade, gated] → ops_alert.
    stage: text("stage").$type<PaceStage>().notNull().default("base"),
    // Wave index (0 = base; increments each widen wave). Non-negative.
    wave: integer("wave").notNull().default(0),
    // Current AREA travel band (km) PACE has widened to; null until the first widen.
    currentAreaKm: integer("current_area_km"),
    // Last observed count of above-floor (on-trade) good-fit candidates. Non-negative.
    lastSupplyCount: integer("last_supply_count").notNull().default(0),
    // Whether the ops alert has been raised (idempotency — never raise twice).
    opsAlertRaised: boolean("ops_alert_raised").notNull().default(false),
    // When this PACE run began — the clock for the 6–24h window (elapsed derived).
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One PACE run per job (also serves job_id lookups — no separate index needed).
    uniqueIndex("pace_states_job_id_uq").on(t.jobId),
    check("pace_states_wave_nonneg_chk", sql`${t.wave} >= 0`),
    check("pace_states_supply_nonneg_chk", sql`${t.lastSupplyCount} >= 0`),
  ],
).enableRLS();

// ---------------------------------------------------------------------------
// admin_users — the 4th privileged principal (ADR-0025, ADMIN-1). DISTINCT from
// worker / payer / InternalService. Modeled on `payers` (same ADR-0004 at-rest
// discipline): the admin's OWN login email is AES-256-GCM CIPHERTEXT (`email_enc`,
// an encryptPii token — key never in the DB) + a keyed-HMAC lookup column
// (`email_hash`, the brute-force-resistant unique login/dedup key — the only email
// derivative allowed outside this row). This is ADMIN-CLASS PII, NOT a worker's or
// payer's: there is NO worker/payer PII here and NO FK to workers/payers.
//
// Onboarding is INVITE-THEN-ACTIVATE (ADR-0025 OQ-2, owner-decided): `status`
// defaults to 'pending' — a created-but-unactivated admin authenticates to NOTHING
// (the AdminAuthGuard mints no session for a non-'active' row). MFA is enforced
// server-side at session-mint (ADR-0025 OQ-1); `mfa_enrolled` is the gate flag.
//
// Like all PII, the admin email NEVER enters events / ai_jobs / audit_logs / logs /
// LLM input — `admin_users.id` is the only admin token that appears in events (the
// actor_id on admin.* events). Sessions are Redis-backed in their own namespace
// (ADR-0025 Decision 2.2 / OQ-5) — there is deliberately NO `admin_sessions` table.
// RLS-enabled (REVOKE/FORCE carried by the migration, ADR-0004 spine posture). Status/
// role unions are pinned at the DB by CHECK (matches the text-$type+CHECK convention
// used across this schema — see header; the repo deliberately uses no pg enums).
// ---------------------------------------------------------------------------
export type AdminRole = "super_admin" | "ops_admin" | "support" | "analyst";
export type AdminStatus = "pending" | "active" | "suspended";

export const adminUsers = pgTable(
  "admin_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Admin's OWN login email: AES-256-GCM ciphertext at rest + keyed HMAC for
    // lookup/dedup (mirrors payers.email_enc / email_hash). The hash is the unique
    // login key (login finds the row without decrypting).
    emailEnc: text("email_enc").notNull(), // AES-256-GCM ciphertext token
    emailHash: text("email_hash").notNull(), // keyed HMAC-SHA256 (login lookup/dedup)
    role: text("role").$type<AdminRole>().notNull(),
    // Invite-then-activate (ADR-0025 OQ-2): default 'pending'. Only 'active' may auth.
    status: text("status").$type<AdminStatus>().notNull().default("pending"),
    mfaEnrolled: boolean("mfa_enrolled").notNull().default(false),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Login lookup/dedup: email_hash is the unique key (mirrors payers_email_hash_uq).
    uniqueIndex("admin_users_email_hash_uq").on(t.emailHash),
    // Pin the role union at the DB (mirrors VACANCY_BANDS-style CHECKs in this schema).
    check(
      "admin_users_role_chk",
      sql`${t.role} IN ('super_admin', 'ops_admin', 'support', 'analyst')`,
    ),
    // Pin the status union; default 'pending' (invite-then-activate).
    check("admin_users_status_chk", sql`${t.status} IN ('pending', 'active', 'suspended')`),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by the migration (ADR-0004 posture)

// ---------------------------------------------------------------------------
// worker_flags — admin "flag / unflag worker for review" action (ADR-0025,
// ADMIN-3a entity actions). FACELESS METADATA ONLY — NOT a PII surface.
//
// A flag is an ops-admin marking a worker for review. It is a SEPARATE table (not
// columns on `workers`) on purpose: unflag = stamp `resolved_at` (the row STAYS),
// so flag → unflag → re-flag leaves a complete, append-style audit trail; NULLing
// columns on `workers` would erase the prior flag on every unflag. It also keeps
// admin-action metadata OFF the PII table (`workers` stays the encrypted, RLS-locked
// identity row) — mirroring how pace_states/agency_invites keep faceless-but-linkable
// state on their own tables.
//
// PII-FREE BY CONSTRUCTION: the ONLY columns are opaque UUIDs (`worker_id` → workers,
// `flagged_by_admin_id` = the opaque admin_users.id), a reason CODE (a short stable
// enum, NEVER free text / name / phone / note), and timestamps. There is ABSOLUTELY
// NO name / phone / address / free-text note column here. `worker_id` is the only join
// back to identity (PII stays in `workers`, RLS-locked) — exactly the `applications`
// discipline. `flag_reason_code` is pinned at the DB by CHECK (the text+$type+CHECK
// convention, see header — the repo uses no pg enums; mirrors admin_users_role_chk).
//
// The flag/unflag actions each emit their own admin.* event (the audit spine carries
// the actor admin id); this row is the queryable current/historical state. RLS-enabled
// (FORCE + REVOKE carried by the migration, ADR-0004 / TD20 spine posture).
// ---------------------------------------------------------------------------
export type WorkerFlagReasonCode = "quality_review" | "abuse_report" | "duplicate" | "other";

export const workerFlags = pgTable(
  "worker_flags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The flagged worker. FK to workers(id) with cascade — a worker hard-delete (DSAR)
    // takes its flags with it. This is the ONLY join back to identity; PII stays in
    // `workers` (RLS-locked), never copied here.
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    // Stable, non-PII reason CODE (NOT free text). Pinned by the CHECK below.
    flagReasonCode: text("flag_reason_code").$type<WorkerFlagReasonCode>().notNull(),
    // The admin who raised the flag — the OPAQUE admin_users.id (no FK kept lean, like
    // the rest of the opaque-actor refs in this schema, e.g. job_postings.created_by /
    // pricing_catalog.updated_by). Never an admin email/name; admin PII stays in
    // admin_users (RLS-locked).
    flaggedByAdminId: uuid("flagged_by_admin_id").notNull(),
    flaggedAt: timestamp("flagged_at", { withTimezone: true }).notNull().defaultNow(),
    // Unflag (resolve) stamp — NULL while the flag is OPEN; set when an admin unflags.
    // Keeping the row + stamping this is what makes flag → unflag → re-flag auditable.
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    // The admin who resolved (unflagged) — opaque admin id; NULL until resolved.
    resolvedByAdminId: uuid("resolved_by_admin_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Hot lookup: a worker's flags (current + history), and the per-worker cap reads.
    index("worker_flags_worker_id_idx").on(t.workerId),
    // At most ONE OPEN flag per worker (resolved_at IS NULL) — makes flag idempotent /
    // race-safe (ON CONFLICT) and lets re-flag after an unflag create a fresh row
    // (resolved rows are excluded from the partial index, so they never collide).
    uniqueIndex("worker_flags_open_uq")
      .on(t.workerId)
      .where(sql`${t.resolvedAt} IS NULL`),
    // Pin the reason union at the DB (mirrors admin_users_role_chk / the schema convention).
    check(
      "worker_flags_reason_code_chk",
      sql`${t.flagReasonCode} IN ('quality_review', 'abuse_report', 'duplicate', 'other')`,
    ),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by the migration (ADR-0004 / TD20 posture)

// ---------------------------------------------------------------------------
// Inferred row types (select / insert) for use across services.
// ---------------------------------------------------------------------------
export type Worker = typeof workers.$inferSelect;
export type NewWorker = typeof workers.$inferInsert;
export type Payer = typeof payers.$inferSelect;
export type NewPayer = typeof payers.$inferInsert;
export type Invite = typeof invites.$inferSelect;
export type NewInvite = typeof invites.$inferInsert;
export type WorkerConsent = typeof workerConsents.$inferSelect;
export type NewWorkerConsent = typeof workerConsents.$inferInsert;
export type WorkerDevice = typeof workerDevices.$inferSelect;
export type NewWorkerDevice = typeof workerDevices.$inferInsert;
export type WorkerCredential = typeof workerCredentials.$inferSelect;
export type NewWorkerCredential = typeof workerCredentials.$inferInsert;
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
export type JobPosting = typeof jobPostings.$inferSelect;
export type NewJobPosting = typeof jobPostings.$inferInsert;
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type Application = typeof applications.$inferSelect;
export type NewApplication = typeof applications.$inferInsert;
export type Unlock = typeof unlocks.$inferSelect;
export type NewUnlock = typeof unlocks.$inferInsert;
export type PayerCredit = typeof payerCredits.$inferSelect;
export type NewPayerCredit = typeof payerCredits.$inferInsert;
export type CreditLedger = typeof creditLedger.$inferSelect;
export type NewCreditLedger = typeof creditLedger.$inferInsert;
export type UnlockRouting = typeof unlockRouting.$inferSelect;
export type NewUnlockRouting = typeof unlockRouting.$inferInsert;
export type PricingCatalogRow = typeof pricingCatalog.$inferSelect;
export type NewPricingCatalogRow = typeof pricingCatalog.$inferInsert;
export type PostingPlan = typeof postingPlans.$inferSelect;
export type NewPostingPlan = typeof postingPlans.$inferInsert;
export type PostingBoost = typeof postingBoosts.$inferSelect;
export type NewPostingBoost = typeof postingBoosts.$inferInsert;
export type ResumeDisclosure = typeof resumeDisclosures.$inferSelect;
export type NewResumeDisclosure = typeof resumeDisclosures.$inferInsert;
export type PayerCapacity = typeof payerCapacity.$inferSelect;
export type NewPayerCapacity = typeof payerCapacity.$inferInsert;
export type PaceState = typeof paceStates.$inferSelect;
export type NewPaceState = typeof paceStates.$inferInsert;
export type AgencyInvite = typeof agencyInvites.$inferSelect;
export type NewAgencyInvite = typeof agencyInvites.$inferInsert;
export type AdminUser = typeof adminUsers.$inferSelect;
export type NewAdminUser = typeof adminUsers.$inferInsert;
export type WorkerFlag = typeof workerFlags.$inferSelect;
export type NewWorkerFlag = typeof workerFlags.$inferInsert;

/** All tables, handy for migrations/tests. */
export const schema = {
  workers,
  workerConsents,
  payers,
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
  jobPostings,
  jobs,
  applications,
  unlocks,
  payerCredits,
  creditLedger,
  unlockRouting,
  pricingCatalog,
  postingPlans,
  postingBoosts,
  resumeDisclosures,
  payerCapacity,
  invites,
  paceStates,
  agencyInvites,
  adminUsers,
  workerFlags,
  workerDevices,
  workerCredentials,
};
