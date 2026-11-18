import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { jsonArray } from "./internal/sql-defaults";
import { jobPostings } from "./job";
import { payers } from "./payer";

/**
 * The AES-256-GCM token shape `encryptPii` produces (`v1.<iv>.<tag>.<ct>`) and the keyring
 * variant (`v2.<kid>.<iv>.<tag>.<ct>`). Duplicated per schema file, as in `worker.ts`, so each
 * column's invariant can be argued on its own.
 */
const ENC_TOKEN_SQL_PATTERN =
  "^(v1\\.[A-Za-z0-9+/=]+\\.[A-Za-z0-9+/=]+\\.[A-Za-z0-9+/=]+" +
  "|v2\\.[A-Za-z0-9_-]{1,32}\\.[A-Za-z0-9+/=]+\\.[A-Za-z0-9+/=]+\\.[A-Za-z0-9+/=]+)$";

/**
 * `requested` → `scheduled` | `declined` (the placement team's decision, from Campus);
 * `scheduled` → `completed` (Campus, after the drive); `requested` | `scheduled` → `cancelled`
 * (the company).
 */
export const CAMPUS_DRIVE_REQUEST_STATUSES = [
  "requested",
  "scheduled",
  "declined",
  "completed",
  "cancelled",
] as const;
export type CampusDriveRequestStatus = (typeof CAMPUS_DRIVE_REQUEST_STATUSES)[number];

/**
 * A company's request for a campus drive at RVM (#2746 item 8, brief 4B.2). The drive itself
 * lives in Campus; this row keeps the request, the decision and Campus's reference.
 *
 * `payer_id` is the TENANT key (`PayerTenantScopeService`), `created_by` the acting login
 * (opaque, no FK, as `job_postings.created_by`). A `job_posting_id` must be one of the tenant's
 * own postings; the FK proves only that it exists, so the service checks ownership.
 *
 * The contact person's name and phone are B2B personal data, possibly of someone with no
 * BadaBhai account: AES ciphertext at rest, registered for key rotation in
 * `reencrypt-pii-backfill.ts`, never in an event or a log. They can be ERASED without deleting
 * the request (both NULL, `contact_erased_at` set — `cdr_contact_chk`), for a DPDP request by
 * the contact or when the team member who wrote them leaves. `is_test` is copied from
 * `payers.is_test_account` when the row is written.
 *
 * `(payer_id, idempotency_key)` is unique, so a create repeated with the same Idempotency-Key
 * answers the row it made long after `RequestIdempotency`'s Redis window has passed. The key is
 * NOT NULL with the Campus key charset, so the payer route must require the header and validate
 * it with the same pattern (a 400, never a 23502/23514).
 */
export const campusDriveRequests = pgTable(
  "campus_drive_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    payerId: uuid("payer_id")
      .notNull()
      .references(() => payers.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by").notNull(),
    jobPostingId: uuid("job_posting_id").references(() => jobPostings.id, {
      onDelete: "set null",
    }),
    /** RVM location ids; empty = any branch. */
    branchIds: jsonb("branch_ids").$type<number[]>().notNull().default(jsonArray),
    preferredFrom: date("preferred_from", { mode: "string" }).notNull(),
    preferredTo: date("preferred_to", { mode: "string" }).notNull(),
    openings: integer("openings").notNull(),
    rolesNote: text("roles_note"),
    contactNameEnc: text("contact_name_enc"),
    contactPhoneEnc: text("contact_phone_enc"),
    contactErasedAt: timestamp("contact_erased_at", { withTimezone: true }),
    status: text("status").$type<CampusDriveRequestStatus>().notNull().default("requested"),
    scheduledOn: date("scheduled_on", { mode: "string" }),
    /** Campus's id for the drive it created. Stored verbatim, never resolved here. */
    campusDriveRef: text("campus_drive_ref"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** The Campus staff member who decided (uuid as text). */
    decidedByRef: text("decided_by_ref"),
    decisionReason: text("decision_reason"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    isTest: boolean("is_test").notNull().default(false),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("campus_drive_requests_idempotency_uq").on(t.payerId, t.idempotencyKey),
    // The company's own list, newest first. NULLS FIRST so the index matches a plain
    // `ORDER BY created_at DESC, id DESC` (the chat.ts / ai-trace.ts lesson).
    index("campus_drive_requests_payer_idx").on(
      t.payerId,
      t.createdAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    // Campus's list, in change order.
    index("campus_drive_requests_changed_idx").on(t.updatedAt, t.id),
    // FK-referencing column; Postgres does not index it.
    index("campus_drive_requests_job_posting_idx").on(t.jobPostingId),
    check(
      "cdr_status_chk",
      sql`${t.status} IN ('requested', 'scheduled', 'declined', 'completed', 'cancelled')`,
    ),
    check("cdr_window_chk", sql`${t.preferredTo} >= ${t.preferredFrom}`),
    check("cdr_openings_chk", sql`${t.openings} BETWEEN 1 AND 1000`),
    // The `job_postings_rvm_targeting_chk` branch shape: positive integer location ids, ≤ 50.
    check(
      "cdr_branch_ids_chk",
      sql`jsonb_typeof(${t.branchIds}) = 'array' AND jsonb_array_length(${t.branchIds}) <= 50
        AND NOT jsonb_path_exists(${t.branchIds}, '$[*] ? (@.type() != "number" || @ < 1 || @.floor() != @)')`,
    ),
    check(
      "cdr_roles_note_chk",
      sql`${t.rolesNote} IS NULL OR char_length(${t.rolesNote}) BETWEEN 1 AND 1000`,
    ),
    // A scheduled or completed drive has its date.
    check(
      "cdr_scheduled_on_chk",
      sql`${t.status} NOT IN ('scheduled', 'completed') OR ${t.scheduledOn} IS NOT NULL`,
    ),
    // Every state past `requested`, other than a cancel of a still-open request, was decided
    // by Campus staff.
    check(
      "cdr_decision_chk",
      sql`${t.status} IN ('requested', 'cancelled')
        OR (${t.decidedAt} IS NOT NULL AND ${t.decidedByRef} IS NOT NULL)`,
    ),
    check("cdr_cancelled_chk", sql`${t.status} <> 'cancelled' OR ${t.cancelledAt} IS NOT NULL`),
    // Staff ref: a uuid (the contract's `StaffRefSchema`). Drive ref: Campus's id charset. Neither
    // can hold a name, a phone or an email.
    check(
      "cdr_refs_chk",
      sql`(${t.decidedByRef} IS NULL OR ${t.decidedByRef} ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
        AND (${t.campusDriveRef} IS NULL OR ${t.campusDriveRef} ~ '^[A-Za-z0-9._:-]{1,200}$')`,
    ),
    check(
      "cdr_decision_reason_chk",
      sql`${t.decisionReason} IS NULL OR char_length(${t.decisionReason}) BETWEEN 1 AND 500`,
    ),
    check("cdr_idempotency_key_chk", sql`${t.idempotencyKey} ~ '^[A-Za-z0-9._:-]{8,200}$'`),
    // The contact is present (both ciphertexts) until it is erased (both NULL, dated).
    check(
      "cdr_contact_chk",
      sql`(${t.contactErasedAt} IS NULL AND ${t.contactNameEnc} IS NOT NULL AND ${t.contactPhoneEnc} IS NOT NULL)
        OR (${t.contactErasedAt} IS NOT NULL AND ${t.contactNameEnc} IS NULL AND ${t.contactPhoneEnc} IS NULL)`,
    ),
    check(
      "cdr_contact_name_enc_chk",
      sql`${t.contactNameEnc} IS NULL OR ${t.contactNameEnc} ~ ${sql.raw(`'${ENC_TOKEN_SQL_PATTERN}'`)}`,
    ),
    check(
      "cdr_contact_phone_enc_chk",
      sql`${t.contactPhoneEnc} IS NULL OR ${t.contactPhoneEnc} ~ ${sql.raw(`'${ENC_TOKEN_SQL_PATTERN}'`)}`,
    ),
  ],
).enableRLS();
