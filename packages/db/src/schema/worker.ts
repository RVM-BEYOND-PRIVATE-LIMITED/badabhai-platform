/**
 * Worker identity domain — the PII root (`workers`) and the per-worker identity
 * satellites: DPDP consents, trusted devices, and the device-unlock credential.
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import type {
  WorkerStatus,
  ConsentPurpose,
  LanguageCode,
} from "@badabhai/types";

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
    // full_name is raw PII, and — like phone_e164 — this column holds AES-256-GCM
    // CIPHERTEXT (an `encryptPii` token), never a readable name. The column name is
    // kept for migration safety.
    //
    // WRITE SITE (exactly one): WorkersService.setFullName encrypts via
    // PiiCryptoService.encrypt and hands the token to WorkersRepository.updateFullName;
    // the plaintext never reaches the DB and never enters `worker.name_recorded`, which
    // carries only `worker_id`. The seeds encrypt too (`seed-reach-pool.ts`).
    //
    // READ SITES all decrypt at a boundary and DEGRADE to a null name on failure —
    // resume render/fields, the disclosure masker (initials only), the chat greeting,
    // the profiling redactor, and the admin console's `AdminIdentityRepository`
    // (capability + egress cap + audit-before-decrypt; owner ruling 2026-08-18).
    // Nullable: a worker who has never been asked for a name is the common state.
    fullName: text("full_name"),
    preferredLanguage: text("preferred_language").$type<LanguageCode>(),
    // Worker-controlled resume display prefs (the "Aap control karte hain" edit
    // screen's safe fields). NON-PII booleans — worker-scoped so they persist
    // across profile regeneration, and safe to carry in events. `show_photo`
    // gates the (deferred) profile-photo on the worker's own resume/app avatar;
    // `night_shift_ready` is the worker-asserted availability flag.
    resumeShowPhoto: boolean("resume_show_photo").notNull().default(true),
    resumeNightShiftReady: boolean("resume_night_shift_ready").notNull().default(false),
    // Worker-controlled push preference (#643). NON-PII boolean. Default TRUE so every
    // existing row keeps today's behaviour — the column is additive and back-compat.
    // READ BY THE SEND PATH: PushService.deliver gates the fan-out on it (ADR-0034), so
    // the toggle actually silences pushes rather than only decorating the UI. SECURITY
    // alerts are deliberately EXEMPT from the gate — see the note in push.service.ts.
    notificationsEnabled: boolean("notifications_enabled").notNull().default(true),
    // The Alerts read watermark (#643): every event at or before this instant is `read`.
    // A single timestamp rather than per-notification rows because the feed is a
    // PROJECTION over `events` (notifications.repository.ts) — there is no notification
    // row to carry a flag on, and "mark all read" is the only gesture the app offers.
    // NULL = nothing read yet (a fresh worker), which is why it is nullable rather than
    // defaulted: epoch-defaulting would be indistinguishable from "read everything".
    // Advanced MONOTONICALLY — the UPDATE's WHERE matches only when this column is
    // NULL or STRICTLY OLDER than the new stamp (see advanceNotificationsReadAt), so a
    // retried or clock-skewed request can never un-read an alert the worker already saw.
    notificationsReadAt: timestamp("notifications_read_at", { withTimezone: true }),
    // ADR-0032 — opaque Storage object key of the worker's profile photo in the
    // private WORKER_PHOTOS_BUCKET (`photos/{workerId}/{uuid}.jpg`, server-chosen).
    // A POINTER only: never a URL, never photo bytes; the photo itself is PII at
    // rest in Storage. NULL until the worker uploads one. Erased (column + object)
    // on photo delete and on account deletion (prefix sweep).
    photoStorageKey: text("photo_storage_key"),
    // The worker's own COARSE home location, captured on the first onboarding screen beside
    // the name (#1428). City + state only — never an address, never a coordinate, never a
    // pincode. NULL until the worker gives one; both halves are independently nullable
    // because a manual entry can supply one without the other.
    //
    // NOT PII, AND THAT IS AN OWNER RULING, NOT A JUDGEMENT CALL HERE (2026-07-31, the Master
    // Context DEAD LIST): "cities as PII (-> a 20-point matching input; never redact)". A city
    // identifies nobody and is the strongest matching signal this product has; a state is
    // coarser still. So unlike `full_name` and `phone_e164` two fields up, these columns hold
    // PLAINTEXT — encrypting them would destroy the only thing they are for, and would be
    // encrypting something the platform has already ruled is not identity.
    //
    // WHY IT IS A COLUMN HERE AND NOT THE JSONB TWO TABLES OVER. `worker_profiles`
    // `.location_preference.current_city` exists and is written ONLY by the extraction
    // processor — and the trade form deliberately runs no extraction, so for a trade-form
    // worker it is never written at all (PARKED.md P-018). This is the FIRST-PARTY answer:
    // the worker typed it, or accepted a device reverse-geocode, on day one.
    //
    // WHICH ONE WINS: THIS ONE (owner ruling 2026-09-05, #1428). A chat-extracted city is a
    // derived guess; this is the worker's own assertion, and "AI never owns business
    // decisions" applies to overwriting it too. Nothing in the extraction path writes here.
    currentCity: text("current_city"),
    currentState: text("current_state"),
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
).enableRLS(); // RLS tracked in the model; carried by the migration (BL-26 parity fix)

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

