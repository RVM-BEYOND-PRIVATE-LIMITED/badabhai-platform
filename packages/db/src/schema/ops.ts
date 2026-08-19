/**
 * Ops / platform domain — the event spine, AI job queue, audit logs, push delivery
 * records, PACE run state, and the admin surface (admin users, worker flags).
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  doublePrecision,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import type {
  AiJobType,
  AiJobStatus,
} from "@badabhai/types";
import { jsonObject } from "./internal/sql-defaults";
import { workerDevices, workers } from "./worker";
import { jobs } from "./job";

// ---------------------------------------------------------------------------
// push_deliveries — one row per (source event, device) push attempt (ADR-0034).
//
// PURPOSE: dedupe (a given event pushes to a given device at most once) + a delivery
// audit trail + the record that drives token invalidation. It is NOT the event spine:
// the spine records that a push was SENT (worker.push_sent); this records the
// per-device outcome.
//
// §2: stores `device_id` — NEVER the push token, never the rendered copy, never a
// name. The copy is static and server-rendered from NOTIFICATION_TEMPLATES, so it is
// reconstructible from `event_id` alone and does not need storing.
//
// ERASURE (ADR-0031): `device_id` cascades from worker_devices, which itself cascades
// from workers — so `workers → worker_devices → push_deliveries` erases in ONE delete
// with no new leg in AccountDeletionService. `event_id` deliberately does NOT cascade:
// the audit spine is PII-free and outlives the worker by design, so it is SET NULL.
// RLS-enabled (FORCE + REVOKE in the migration) like every sibling identity table.
// ---------------------------------------------------------------------------
export type PushDeliveryStatus = "pending" | "sent" | "failed";

export const pushDeliveries = pgTable(
  "push_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The event that triggered the push. SET NULL (not cascade) — see header.
    eventId: uuid("event_id").references(() => events.id, { onDelete: "set null" }),
    // The target device. Cascades so DPDP erasure needs no extra leg.
    deviceId: uuid("device_id")
      .notNull()
      .references(() => workerDevices.id, { onDelete: "cascade" }),
    status: text("status").$type<PushDeliveryStatus>().notNull(),
    // Closed enum, PII-free — never a provider response body (which echoes the token).
    failureReason: text("failure_reason"),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // THE dedupe key: one attempt per (event, device).
    uniqueIndex("push_deliveries_event_device_uq").on(t.eventId, t.deviceId),
    index("push_deliveries_device_id_idx").on(t.deviceId),
    check("push_deliveries_status_chk", sql`${t.status} IN ('pending', 'sent', 'failed')`),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by the migration (ADR-0004 posture)

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
    // ── The interview-kit attribution read (migration 0079) ──────────────────────────────
    //
    // `interview_kit.downloaded` carries its worker in the PAYLOAD, not in `subject_id`: the
    // subject is the KIT (per-trade, PII-free), and conditionally re-pointing the subject at
    // the worker whenever a token happened to be present would break every consumer that
    // filters `subject_type = 'interview_kit'`. So step 7 of the admin worker-journey funnel
    // has to ask a jsonb question — and `events` is the largest table in the system, with no
    // payload index of any kind, so unindexed that question is a sequential scan of it EVERY
    // TIME an operator opens one worker's journey page.
    //
    // PARTIAL on the event name, which is what keeps it small: the index holds only the
    // downloaded rows, not one entry per event in the spine. It is also what makes the index
    // MATCHABLE — the funnel query carries the identical `event_name = 'interview_kit.downloaded'`
    // predicate, so the planner can prove the partial covers it.
    //
    // §2: the indexed expression is an opaque internal UUID (or NULL for an anonymous
    // download). An index stores the indexed VALUES — this one therefore holds ids and
    // nothing else, which is the same standard `ai_jobs_extraction_session_idx` is held to.
    index("events_interview_kit_worker_idx")
      .on(sql`(${t.payload}->>'worker_id')`)
      .where(sql`${t.eventName} = 'interview_kit.downloaded'`),
    // Idempotent emission: non-null keys are unique; many NULLs are allowed
    // (NULLS DISTINCT — Postgres default). See `idempotencyKey` above.
    uniqueIndex("events_idempotency_key_uq").on(t.idempotencyKey),
  ],
).enableRLS(); // RLS tracked in the model; carried by the migration (BL-26 parity fix)

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
  (t) => [
    index("ai_jobs_status_idx").on(t.status),
    // Serves the #420 extraction dedupe lookup
    // (profiles/ai-jobs.repository.ts `findActiveExtractionForSession`), which filters
    // `job_type = 'profile_extraction'` AND `input_ref->>'session_id'` AND
    // `input_ref->>'worker_id'`, then takes `ORDER BY created_at DESC LIMIT 1`.
    //
    // Before this, NOTHING served that predicate: `ai_jobs_status_idx` above is the
    // table's only other index, and the lookup's status disjunction matches 3 of the 4
    // enum values (~75% selectivity), so the planner would reject it anyway. `ai_jobs`
    // accumulates every extraction/transcription/resume job with no retention policy,
    // so the scan cost grows monotonically while the result stays LIMIT 1.
    //
    // PARTIAL on job_type: extraction jobs are a fraction of the table, so the index
    // stays smaller and never has to store the column.
    //   MEASURED CAVEAT (throwaway PG 18.4, 1,000,000 rows): the saving is purely a
    //   function of the job_type MIX, not a property of the predicate. Same 1M rows,
    //   only the mix varied:
    //       33% extraction   partial  36 MB   twin  85 MB
    //       66% extraction   partial  72 MB   twin  96 MB
    //      100% extraction   partial 108 MB   twin 108 MB   <- EXACTLY ZERO saving
    //   Per-entry cost is NOT equal between them: the partial is ~113 B/entry, the
    //   twin ~89 B/entry, because the twin also indexes the non-extraction rows,
    //   whose session_id/worker_id are NULL and therefore index far more cheaply
    //   (677,460 of its entries had a NULL leading key at the 33% mix). So the twin
    //   is not "3x bigger per row" — it is bigger only because it holds more rows.
    //   Today's real mix is likely near 100% extraction (voice is dormant), so do NOT
    //   assume this predicate is buying space until a read-only
    //   `SELECT job_type, count(*) FROM ai_jobs GROUP BY 1` says so.
    //
    // Trailing `created_at DESC NULLS LAST` serves the sort ONLY IF the query orders
    // the same way. It must say `desc nulls last` explicitly — Postgres defaults DESC
    // to NULLS FIRST, and pathkeys compare `nulls_first` strictly, so a bare
    // `ORDER BY created_at DESC` does NOT match this index and the planner adds a Sort
    // that discards the LIMIT-1 early exit. `findExtractionDedupeCandidate`
    // (apps/api/src/profiles/ai-jobs.repository.ts) is written to match; keep them
    // in step, and change both together or neither.
    //
    // §2: both indexed expressions are opaque UUIDs (worker_id / session_id), never PII.
    // An index stores the indexed VALUES, so this is deliberate — no name, phone,
    // employer or free text is placed in an index here or anywhere else.
    index("ai_jobs_extraction_session_idx")
      .on(
        sql`(${t.inputRef}->>'session_id')`,
        sql`(${t.inputRef}->>'worker_id')`,
        t.createdAt.desc(),
      )
      .where(sql`${t.jobType} = 'profile_extraction'`),
  ],
).enableRLS(); // RLS tracked in the model; carried by the migration (BL-26 parity fix)

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
).enableRLS(); // RLS tracked in the model; carried by the migration (BL-26 parity fix)

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
    // Admin's display name. ADMIN-class PII, so it gets the SAME at-rest discipline as the
    // email (ADR-0004): AES-256-GCM ciphertext, never a plaintext column. NULLABLE, because
    // every admin created before this column existed has none and the invite flow does not
    // collect one — a NOT NULL would have needed a fabricated backfill value.
    //
    // Deliberately NOT hashed: unlike the email it is never a lookup key, so there is no
    // reason to make it searchable, and a hash would only invite someone to try.
    nameEnc: text("name_enc"),
    role: text("role").$type<AdminRole>().notNull(),
    // Invite-then-activate (ADR-0025 OQ-2): default 'pending'. Only 'active' may auth.
    status: text("status").$type<AdminStatus>().notNull().default("pending"),
    mfaEnrolled: boolean("mfa_enrolled").notNull().default(false),
    // The admin's TOTP secret, AES-256-GCM at rest (ADR-0038).
    //
    // MOVED HERE FROM REDIS, which is where `AdminMfaSecretStore` originally put it — its
    // own docstring records that as a deviation forced by "no migration in ADMIN-1 scope"
    // and asks for exactly this column. It is not cosmetic: the Redis key carried NO TTL and
    // no persistence guarantee, so a flush or an eviction permanently locked out every
    // enrolled admin, with no recovery path at all because the secret is shown once and
    // never returned again. Done now because zero admins are enrolled (none can log in yet),
    // so the move costs nothing; after the portal ships it would need a re-enrolment drill.
    //
    // NEVER logged, never evented, never returned by any read except the one-time
    // enrolment response. The short-lived `admin_mfa_pending:<id>` flag stays in Redis —
    // that one is genuinely ephemeral and TTL-bounded by design.
    mfaSecretEnc: text("mfa_secret_enc"),
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

