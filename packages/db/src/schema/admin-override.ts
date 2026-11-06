import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { workers } from "./worker";

/**
 * ADR-0062 §3.1 — the ADMIN CORRECTION LAYER (#2561).
 *
 * One row per admin correction of one editable fact. The EFFECTIVE value is the live row
 * (`superseded_at IS NULL`); a re-correction supersedes the live row and inserts its
 * replacement in the same transaction. `value_enc` is the `{corrected, previous}` envelope,
 * serialised and AES-encrypted with `PiiCryptoService.encrypt`: it can hold an employer name,
 * a licence number or a city, so it is B2B/worker PII and NEVER rides an event, a log or the
 * read table. `previous` is the last non-admin effective value captured at correction time,
 * which is what makes REVERT honest: a later interview does not update it.
 *
 * `superseded_by` points at the replacing row; NULL with `superseded_at` set means a REVERT
 * (or a worker self-edit, which supersedes under owner ruling A1). The partial unique index
 * is the "one live correction per (worker, fact)" invariant, enforced by the database.
 *
 * The `fact_key` CHECK and the API/event enums are the SAME closed §4 list. PR 1 exposes only
 * the location keys (`current_city`, `preferred_locations`); the remaining groups are opened
 * by #2561 PR 2 without a table change, which is why the full list is pinned here now.
 */
export const WORKER_ADMIN_OVERRIDE_FACT_KEYS = [
  // Location (§4) — PR 1.
  "current_city",
  "preferred_locations",
  // Trade + role.
  "trade",
  "role",
  "secondary_roles",
  // Skills.
  "skills",
  // Experience.
  "experience",
  // Work history.
  "work_history",
  // Education / certificates / training.
  "education",
  "certifications",
  "training",
  // Languages.
  "languages",
  // Salary.
  "salary_expected",
  "salary_period",
  // Availability / shift / preferences.
  "availability",
  "shift",
  "relocation",
  "accommodation",
  "job_type",
  "work_types",
  "commute_max_km",
  "willing_to_travel",
  "documents_ready",
] as const;
export type WorkerAdminOverrideFactKey = (typeof WORKER_ADMIN_OVERRIDE_FACT_KEYS)[number];

/** The §3.4 LOCKED fields: never editable through this layer (the API rejects them with 400). */
export const LOCKED_FIELD_KEYS = [
  "full_name",
  "phone_e164",
  "whatsapp_enc",
  "resume_show_photo",
] as const;

export const workerAdminOverrides = pgTable(
  "worker_admin_override",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** DPDP erasure removes the correction with the worker. */
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    factKey: text("fact_key").$type<WorkerAdminOverrideFactKey>().notNull(),
    /** `{corrected, previous}` envelope, serialised + AES-256-GCM. NEVER plaintext. */
    valueEnc: text("value_enc").notNull(),
    /** The acting admin, opaque; kept so the audit survives a role change (no FK). */
    adminId: uuid("admin_id").notNull(),
    reasonCode: text("reason_code").notNull(),
    reasonText: text("reason_text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    /** The replacing row. NULL + `superseded_at` set means a revert or a worker self-edit. */
    supersededById: uuid("superseded_by_id").references(
      (): AnyPgColumn => workerAdminOverrides.id,
      { onDelete: "set null" },
    ),
  },
  (t) => [
    // THE CORE INVARIANT: at most one LIVE correction per (worker, fact).
    uniqueIndex("worker_admin_override_live_uq")
      .on(t.workerId, t.factKey)
      .where(sql`superseded_at IS NULL`),
    // The resolver's read (live rows for one worker) and the history read.
    index("worker_admin_override_worker_idx").on(t.workerId, t.createdAt.desc()),
    check(
      "worker_admin_override_fact_key_chk",
      sql`${t.factKey} IN ('current_city', 'preferred_locations', 'trade', 'role', 'secondary_roles', 'skills', 'experience', 'work_history', 'education', 'certifications', 'training', 'languages', 'salary_expected', 'salary_period', 'availability', 'shift', 'relocation', 'accommodation', 'job_type', 'work_types', 'commute_max_km', 'willing_to_travel', 'documents_ready')`,
    ),
    // ADR §3.1: the written reason is 15–500 characters, the admin-write floor.
    check(
      "worker_admin_override_reason_chk",
      sql`char_length(${t.reasonText}) BETWEEN 15 AND 500`,
    ),
    // A supersession must be dated; the replacing id is optional (revert / worker edit).
    check(
      "worker_admin_override_superseded_pair_chk",
      sql`(${t.supersededAt} IS NULL AND ${t.supersededById} IS NULL) OR ${t.supersededAt} IS NOT NULL`,
    ),
    // The envelope is an AES token (`v1.…` / `v2.<kid>.…`), never JSON or plaintext.
    check(
      "worker_admin_override_value_enc_chk",
      sql`${t.valueEnc} ~ '^(v1\\.[A-Za-z0-9+/=]+\\.[A-Za-z0-9+/=]+\\.[A-Za-z0-9+/=]+|v2\\.[A-Za-z0-9_-]{1,32}\\.[A-Za-z0-9+/=]+\\.[A-Za-z0-9+/=]+\\.[A-Za-z0-9+/=]+)$'`,
    ),
  ],
).enableRLS();
