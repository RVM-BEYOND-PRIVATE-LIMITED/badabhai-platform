import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { workers } from "./worker";

/** Where a moved student came from. Only Campus today (RVMBeyond_jobportal#197's export). */
export type StudentImportSource = "campus";

/** One import run's state. */
export type StudentImportBatchStatus = "running" | "applied" | "failed" | "rolled_back";

/** What one run did to one Campus candidate. */
export type StudentImportRowAction =
  | "created"
  | "updated"
  | "unchanged"
  | "held"
  | "failed"
  | "rolled_back";

/** Who last wrote a profile field: the import, or the worker himself on BadaBhai. */
export type WorkerFieldSource = "campus_import" | "worker";

// ---------------------------------------------------------------------------
// #2887 — moving RVM students into BadaBhai as workers (ruling of 17 Nov 2026).
//
// THE IMPORT LEDGER. `student_import_batches` is one run of the import CLI (a full move or a
// `--since` sync); `student_import_rows` is what that run did to each Campus candidate (created,
// updated, unchanged, held with a reason, failed, rolled back), which is the run's report and what
// `--rollback` undoes; `student_import_subjects` maps a Campus candidate id to the ONE BadaBhai
// worker he became, which is what makes a re-run idempotent.
//
// THE FIELD SOURCE MARKER. `worker_field_sources` records, per worker and field, who wrote it
// last: the import, or the worker himself on BadaBhai. A field the worker edited is never
// overwritten by a later sync (ruling 4: the BadaBhai profile wins). Keys are the admin override
// fact keys (`WORKER_ADMIN_OVERRIDE_FACT_KEYS`).
//
// THE VISIBILITY SWITCH. `student_visibility` holds one row per moved student: `visible` false
// at import. While false he is out of matching (`job_reach`) and the #2752 rules keep him from
// companies; when an admin turns it on he is an ordinary BadaBhai worker. A worker with no row
// was never moved, and nothing about him changes.
//
// The reach statements read `student_visibility` whenever it exists (reach depends on no switch,
// #2746 M2); everything else here is read and written only while STUDENT_MOVE_ENABLED is on.
// PII-free: ids, closed codes, counts and times. RLS forced, every role revoked (the migration's
// hand-written tail).
// ---------------------------------------------------------------------------

export const studentImportBatches = pgTable(
  "student_import_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source").$type<StudentImportSource>().notNull(),
    // An operator's short label for the run ("bulk move 1", "nightly 2026-11-18"). Not a name.
    label: text("label").notNull(),
    // Set for a `--since` sync: the export's change time the run started from.
    since: timestamp("since", { withTimezone: true }),
    status: text("status").$type<StudentImportBatchStatus>().notNull().default("running"),
    // created / updated / unchanged / held / failed counts, written when the run ends.
    counts: jsonb("counts").notNull().default(sql`'{}'::jsonb`),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    rolledBackAt: timestamp("rolled_back_at", { withTimezone: true }),
  },
  (t) => [
    check("student_import_batches_source_chk", sql`${t.source} IN ('campus')`),
    check(
      "student_import_batches_status_chk",
      sql`${t.status} IN ('running', 'applied', 'failed', 'rolled_back')`,
    ),
    check("student_import_batches_label_chk", sql`char_length(${t.label}) BETWEEN 1 AND 120`),
    check("student_import_batches_counts_chk", sql`jsonb_typeof(${t.counts}) = 'object'`),
    check(
      "student_import_batches_rolled_back_chk",
      sql`(${t.status} = 'rolled_back') = (${t.rolledBackAt} IS NOT NULL)`,
    ),
  ],
).enableRLS();

export const studentImportRows = pgTable(
  "student_import_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => studentImportBatches.id, { onDelete: "cascade" }),
    // The Campus candidate id, verbatim.
    sourceId: text("source_id").notNull(),
    // Null when the row was held or failed before a worker was found, or the worker was erased.
    workerId: uuid("worker_id").references(() => workers.id, { onDelete: "set null" }),
    action: text("action").$type<StudentImportRowAction>().notNull(),
    // A closed reason code for `held` / `failed` (e.g. `no_phone`, `phone_shared`, `not_rvm`).
    reason: text("reason"),
    // True only when THIS run created the worker row: the rollback removes only such workers.
    workerCreated: boolean("worker_created").notNull().default(false),
    // The field keys this run wrote (a JSON array of strings).
    fieldsWritten: jsonb("fields_written").notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("student_import_rows_batch_source_uq").on(t.batchId, t.sourceId),
    index("student_import_rows_worker_idx").on(t.workerId),
    check(
      "student_import_rows_action_chk",
      sql`${t.action} IN ('created', 'updated', 'unchanged', 'held', 'failed', 'rolled_back')`,
    ),
    check(
      "student_import_rows_source_id_chk",
      sql`${t.sourceId} ~ '^[A-Za-z0-9._:-]{1,128}$'`,
    ),
    check(
      "student_import_rows_reason_chk",
      sql`${t.reason} IS NULL OR ${t.reason} ~ '^[a-z0-9_]{1,64}$'`,
    ),
    check(
      "student_import_rows_fields_chk",
      sql`jsonb_typeof(${t.fieldsWritten}) = 'array'`,
    ),
  ],
).enableRLS();

export const studentImportSubjects = pgTable(
  "student_import_subjects",
  {
    source: text("source").$type<StudentImportSource>().notNull(),
    sourceId: text("source_id").notNull(),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    firstBatchId: uuid("first_batch_id")
      .notNull()
      .references(() => studentImportBatches.id),
    lastBatchId: uuid("last_batch_id")
      .notNull()
      .references(() => studentImportBatches.id),
    // A hash of the candidate's exported record at the last run: an unchanged record is skipped.
    contentHash: text("content_hash").notNull(),
    firstImportedAt: timestamp("first_imported_at", { withTimezone: true }).notNull().defaultNow(),
    lastImportedAt: timestamp("last_imported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "student_import_subjects_pk", columns: [t.source, t.sourceId] }),
    // One phone is one person: one Campus candidate per worker. A second candidate on the same
    // phone is held (`phone_shared`), never merged.
    uniqueIndex("student_import_subjects_worker_uq").on(t.workerId),
    check("student_import_subjects_source_chk", sql`${t.source} IN ('campus')`),
    check(
      "student_import_subjects_source_id_chk",
      sql`${t.sourceId} ~ '^[A-Za-z0-9._:-]{1,128}$'`,
    ),
    check(
      "student_import_subjects_hash_chk",
      sql`${t.contentHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
).enableRLS();

export const workerFieldSources = pgTable(
  "worker_field_sources",
  {
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    fieldKey: text("field_key").notNull(),
    source: text("source").$type<WorkerFieldSource>().notNull(),
    // The import run that last wrote it (null for the worker's own edit).
    batchId: uuid("batch_id").references(() => studentImportBatches.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "worker_field_sources_pk", columns: [t.workerId, t.fieldKey] }),
    check("worker_field_sources_source_chk", sql`${t.source} IN ('campus_import', 'worker')`),
    check("worker_field_sources_key_chk", sql`${t.fieldKey} ~ '^[a-z_]{1,64}$'`),
    check(
      "worker_field_sources_batch_chk",
      sql`${t.source} = 'campus_import' OR ${t.batchId} IS NULL`,
    ),
  ],
).enableRLS();

export const studentVisibility = pgTable(
  "student_visibility",
  {
    workerId: uuid("worker_id")
      .primaryKey()
      .references(() => workers.id, { onDelete: "cascade" }),
    visible: boolean("visible").notNull().default(false),
    // The import run that moved him (the bulk switch can select by it).
    batchId: uuid("batch_id").references(() => studentImportBatches.id, { onDelete: "set null" }),
    // The admin who last changed it, and why (null at import).
    changedByAdminId: uuid("changed_by_admin_id"),
    reason: text("reason"),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("student_visibility_batch_idx").on(t.batchId),
    // The hidden set is what job_reach and search exclude: a partial index keeps it small.
    index("student_visibility_hidden_idx").on(t.workerId).where(sql`NOT ${t.visible}`),
    check(
      "student_visibility_reason_chk",
      sql`${t.reason} IS NULL OR char_length(${t.reason}) BETWEEN 1 AND 500`,
    ),
  ],
).enableRLS();

export type StudentImportBatchRow = typeof studentImportBatches.$inferSelect;
export type StudentImportRowRow = typeof studentImportRows.$inferSelect;
export type StudentImportSubjectRow = typeof studentImportSubjects.$inferSelect;
export type WorkerFieldSourceRow = typeof workerFieldSources.$inferSelect;
export type StudentVisibilityRow = typeof studentVisibility.$inferSelect;
