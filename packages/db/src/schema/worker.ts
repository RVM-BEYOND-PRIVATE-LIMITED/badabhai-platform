// Worker identity domain: workers (the only raw-PII table), consents, trusted
// devices, push deliveries, the device-unlock credential, and the canonical
// worker_profiles row.

import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  pgTable,
  uuid,
  text,
  integer,
  doublePrecision,
  boolean,
  timestamp,
  jsonb,
  vector,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import type { WorkerStatus, ProfileStatus, ConsentPurpose, LanguageCode } from "@badabhai/types";
import { jsonObject, jsonArray } from "./_internal/json-defaults";
import { jobDomains } from "./occupation";
import type { JobDomainMatchStatus } from "./occupation";
import { events } from "./ops";

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
    // Worker-controlled resume display prefs (the "Aap control karte hain" edit
    // screen's safe fields). NON-PII booleans — worker-scoped so they persist
    // across profile regeneration, and safe to carry in events. `show_photo`
    // gates the (deferred) profile-photo on the worker's own resume/app avatar;
    // `night_shift_ready` is the worker-asserted availability flag.
    resumeShowPhoto: boolean("resume_show_photo").notNull().default(true),
    resumeNightShiftReady: boolean("resume_night_shift_ready").notNull().default(false),
    // ADR-0032 — opaque Storage object key of the worker's profile photo in the
    // private WORKER_PHOTOS_BUCKET (`photos/{workerId}/{uuid}.jpg`, server-chosen).
    // A POINTER only: never a URL, never photo bytes; the photo itself is PII at
    // rest in Storage. NULL until the worker uploads one. Erased (column + object)
    // on photo delete and on account deletion (prefix sweep).
    photoStorageKey: text("photo_storage_key"),
    status: text("status").$type<WorkerStatus>().notNull().default("pending"),
    // ADR-0031 — 7-day deletion grace window. The DUE time of the scheduled hard-
    // delete (requested_at + ACCOUNT_DELETION_GRACE_DAYS). NULL = active worker;
    // set = pending deletion (cancellable until the sweep erases). Single source
    // of truth for the grace state — deliberately NOT a second status value. The
    // erasure itself is still ADR-0026 Phase 5's hard-delete cascade, run by the
    // sweep once due; this is a schedule marker, not a soft-delete end-state.
    deletionScheduledAt: timestamp("deletion_scheduled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("workers_phone_hash_uq").on(t.phoneHash),
    // Partial index for the deletion sweep: only pending-deletion rows are indexed
    // (tiny), so `WHERE deletion_scheduled_at <= now()` stays cheap at any scale.
    index("workers_deletion_due_idx")
      .on(t.deletionScheduledAt)
      .where(sql`"deletion_scheduled_at" IS NOT NULL`),
    // BP-1 — the admin faceless-list keyset. `(created_at DESC, id DESC)` is the EXACT sort
    // the admin read orders by, so the page comes straight out of the index instead of
    // sorting the table. `id` last is what makes the ordering total: without it a page
    // boundary landing inside a bulk insert's shared timestamp silently skips or repeats.
    index("workers_admin_keyset_idx").on(t.createdAt.desc(), t.id.desc()),
  ],
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
    // ADR-0034 — opaque per-install nonce echoed in the push payload so the client can
    // DROP a message that is not for its live session. An FCM token addresses an app
    // INSTALL, not a person: on a shared/handed-down handset a token can move between
    // workers, and a payload carrying no identifier at all leaves the client unable to
    // tell. This is NOT a worker id and is not correlatable to a person — it is rotated
    // on every registration. Nullable until the device registers a push token.
    pushTarget: uuid("push_target"),
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
    // ADR-0034 — supports "steal-on-register": when a device registers a push token,
    // that SAME token is nulled on every OTHER row holding it (a token addresses one
    // install, so a second holder is by definition stale). Without this the shared-
    // handset case delivers worker A's SECURITY alerts to worker B's phone. Partial:
    // only non-null tokens are ever looked up, and most rows have none.
    index("worker_devices_push_token_idx")
      .on(t.pushToken)
      .where(sql`${t.pushToken} IS NOT NULL`),
    // Pin the platform union at the DB (mirrors admin_users_role_chk).
    check(
      "worker_devices_platform_chk",
      sql`${t.platform} IN ('android', 'ios', 'web', 'unknown')`,
    ),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by the migration (ADR-0004 posture)

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
    // B-6 (context-drift register 2026-07-16): the @badabhai/taxonomy
    // SKILL_TAXONOMY_VERSION in force when `skills` was last WRITTEN (extraction
    // create; offline TAX-9 retag). Stamped only where skills are (re)written —
    // never touched on read. NULLABLE by design, no backfill: NULL honestly means
    // "written before versioning existed". Text (not integer) so a future version
    // scheme (date-tagged / semver on re-embed) needs no lossy migration; equality
    // is the only operation, never ordering.
    taxonomyVersion: text("taxonomy_version"),
    machines: jsonb("machines").$type<string[]>().notNull().default(jsonArray),
    experience: jsonb("experience").notNull().default(jsonObject),
    salaryExpectation: jsonb("salary_expectation").notNull().default(jsonObject),
    locationPreference: jsonb("location_preference").notNull().default(jsonObject),
    availability: jsonb("availability").notNull().default(jsonObject),
    rawProfile: jsonb("raw_profile").notNull().default(jsonObject),
    // Issue #419 — the AI service's RICH WorkerProfileDraft (28 fields: controllers,
    // education, certifications, current vs expected salary, availability,
    // current_city/current_state, ...). The extraction response has always carried it
    // (ProfileExtractionOutputSchema.worker_profile_draft) and apps/api discarded it, so
    // everything the interview asked beyond the narrow legacy shape was thrown away.
    //
    // Stored as-is, additively, in its OWN column — `raw_profile` cannot be reused for it
    // because resume.service.ts parses that column with DraftProfileSchema, so widening it
    // would break resume generation (§8).
    //
    // NULLABLE with no default and no backfill: NULL honestly means "extracted before this
    // column existed", exactly like `taxonomy_version` above.
    //
    // §2: verified field-by-field against the schema — no employer name, worker name,
    // phone, address, or id-doc token. Location is city/state only, no finer than the
    // `location_preference` column beside it. It is written HERE and nowhere else: never
    // into events, ai_jobs, audit_logs, logs, or LLM input. The one field to watch on any
    // future widening is `clarification_questions`, the only free-text the model authors.
    //
    // Untyped jsonb like `experience`/`salary_expectation` beside it, so packages/db does
    // not take a dependency on @badabhai/ai-contracts; the API validates with the Zod
    // schema at the write site.
    richProfileDraft: jsonb("rich_profile_draft"),
    // Managed Vertex embedding (text-multilingual-embedding-002, 768-dim) for
    // semantic similarity. Nullable until the profile is embedded (plan G3).
    embedding: vector("embedding", { dimensions: 768 }),
    // ── Generalized profiling: the matched job domain (migration 0066) ────────
    //
    // A NEW, PARALLEL COLUMN — deliberately NOT a widening of `canonical_role_id`.
    // That distinction is load-bearing, and getting it wrong fails SILENTLY:
    // `canonical_role_id` feeds WorkerSkillsService.rebuildForWorker ->
    // deriveWorkerSkills -> ROLE_TO_MATCH_SKILL, a map that is exhaustive over the 13
    // taxonomy ROLES. An id outside that set returns `undefined`, the derived skill
    // set comes back EMPTY, the reach reconciler is handed an empty wanted-list, and
    // the worker is removed from every job_reach row. Nothing throws. Writing a `jd_*`
    // id into that column would quietly delete workers from every feed, so it never
    // happens: `canonical_role_id` keeps its 13-value meaning, and the domain lands
    // here, where nothing existing reads it.
    //
    // FK is the LAST line of defence against a hallucinated id. The model picks from a
    // shortlist we retrieved, the id is re-checked against the shortlist and then
    // against the DB — and even if both were bypassed, an invented id is physically
    // unwritable. ON DELETE SET NULL, never CASCADE: catalog rows are deprecated
    // rather than deleted (SG-5), but if one ever were, degrading to "unmatched" is
    // correct and deleting the worker's whole profile plainly is not.
    jobDomainId: text("job_domain_id").references(
      (): AnyPgColumn => jobDomains.jobDomainId,
      { onDelete: "set null" },
    ),
    // WHY the match ended where it did. Recorded on EVERY path including failure,
    // because "we could not place this worker" is exactly the metric the catalog's
    // coverage is judged on, and it is invisible if only successes are stored.
    jobDomainMatchStatus: text("job_domain_match_status").$type<JobDomainMatchStatus>(),
    // Cosine similarity of the winning candidate. Diagnostic + floor calibration only;
    // NEVER an input to ranking (invariant #4 — rank stays deterministic).
    jobDomainMatchScore: doublePrecision("job_domain_match_score"),
    jobDomainMatchedAt: timestamp("job_domain_matched_at", { withTimezone: true }),
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
    // "How many workers landed in domain X" — the coverage read, and the FK-referencing
    // column Postgres does not auto-index.
    index("worker_profiles_job_domain_id_idx").on(t.jobDomainId),
    check(
      "worker_profiles_job_domain_match_status_chk",
      sql`${t.jobDomainMatchStatus} IS NULL OR ${t.jobDomainMatchStatus} IN ('matched_auto', 'matched_llm', 'unmatched_below_floor', 'unmatched_llm_declined', 'unmatched_degraded')`,
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
export type WorkerDevice = typeof workerDevices.$inferSelect;
export type NewWorkerDevice = typeof workerDevices.$inferInsert;
export type PushDelivery = typeof pushDeliveries.$inferSelect;
export type NewPushDelivery = typeof pushDeliveries.$inferInsert;
export type WorkerCredential = typeof workerCredentials.$inferSelect;
export type NewWorkerCredential = typeof workerCredentials.$inferInsert;
export type WorkerProfile = typeof workerProfiles.$inferSelect;
export type NewWorkerProfile = typeof workerProfiles.$inferInsert;
