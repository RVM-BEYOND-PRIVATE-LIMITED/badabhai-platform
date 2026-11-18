import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** The system an import reads from. Only BadaBhai Campus today (#2754). */
export type CompanyImportSourceSystem = "campus";

/** A batch's lifecycle: written by `--apply`, reversed by `--rollback`. */
export type CompanyImportBatchState = "applying" | "applied" | "rolled_back";

/** What one ledger row stands for: one source record of the Campus export bundle. */
export type CompanyImportRowKind = "company" | "job" | "application" | "balance" | "access";

/**
 * What the import did with one source record.
 * - `created`: a new BadaBhai row was written (its id is `target_id`).
 * - `matched`: an existing BadaBhai row was reused (company found by phone, email or GSTIN).
 * - `held`: not moved yet, waiting on something outside the import (an RVM student's consent).
 * - `skipped`: deliberately not moved (closed job, unmapped status, not converted by rule).
 * - `exception`: needs a person (no usable phone, phone proven elsewhere, bad record).
 * - `rolled_back`: reversed by `--rollback`; `target_id` still names what was archived or closed.
 */
export type CompanyImportRowState =
  | "created"
  | "matched"
  | "held"
  | "skipped"
  | "exception"
  | "rolled_back";

// ---------------------------------------------------------------------------
// company_import_batches — one row per run of the Campus company import (#2754 item 4).
//
// A batch is one named run of `import-campus-companies.cli.ts --apply` over one export bundle of
// RVMBeyond_jobportal#156. The bundle's own identity (format, version, generation time, the
// manifest's sha256) is stored so a report can always say which file a batch came from; the
// bundle itself is never stored (it holds names and phones and is deleted after the move).
//
// `is_test` marks a rehearsal or a pilot of our own dummy companies (ruling 17 Nov 2026): every
// company it creates is also marked as a test account (#2755), so it stays out of the numbers.
//
// `run_by` is the operator's own label for who ran the batch (the issue's "log who ran each
// batch"). It is free text written by the operator, never read back into any decision.
//
// No PII. RLS forced, every role revoked (the migration's hand-written tail).
// ---------------------------------------------------------------------------
export const companyImportBatches = pgTable(
  "company_import_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchKey: text("batch_key").notNull(),
    sourceSystem: text("source_system").$type<CompanyImportSourceSystem>().notNull(),
    bundleFormat: text("bundle_format").notNull(),
    bundleVersion: integer("bundle_version").notNull(),
    bundleGeneratedAt: timestamp("bundle_generated_at", { withTimezone: true }).notNull(),
    manifestSha256: text("manifest_sha256").notNull(),
    isTest: boolean("is_test").notNull().default(false),
    state: text("state").$type<CompanyImportBatchState>().notNull().default("applying"),
    runBy: text("run_by").notNull(),
    // The manifest's `counts` block as read, for the verification report. Counts only.
    manifestCounts: jsonb("manifest_counts").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    rolledBackAt: timestamp("rolled_back_at", { withTimezone: true }),
    rolledBackBy: text("rolled_back_by"),
  },
  (t) => [
    uniqueIndex("company_import_batches_batch_key_uq").on(t.batchKey),
    check("company_import_batches_source_chk", sql`${t.sourceSystem} IN ('campus')`),
    check(
      "company_import_batches_state_chk",
      sql`${t.state} IN ('applying', 'applied', 'rolled_back')`,
    ),
    check(
      "company_import_batches_text_chk",
      sql`char_length(${t.batchKey}) BETWEEN 1 AND 64 AND char_length(${t.runBy}) BETWEEN 1 AND 128 AND char_length(${t.manifestSha256}) = 64 AND (${t.rolledBackBy} IS NULL OR char_length(${t.rolledBackBy}) BETWEEN 1 AND 128)`,
    ),
    check(
      "company_import_batches_rollback_chk",
      sql`(${t.state} = 'rolled_back') = (${t.rolledBackAt} IS NOT NULL)`,
    ),
  ],
).enableRLS();

// ---------------------------------------------------------------------------
// company_import_rows — the source-to-target map of the import (#2754 item 4).
//
// ONE ROW PER SOURCE RECORD, ACROSS ALL BATCHES: unique on (source system, kind, source id). A
// second run over the same bundle finds every row already present and adds nothing, which is what
// makes the import idempotent; `--rollback` reads the same rows to know what to archive, close or
// reverse. The first batch to touch a record owns its row (`batch_id`).
//
// `source_id` is the Campus row's uuid, or for a balance the bundle's stable `key` (the ledger's
// `campus_conversion:<key>`). `company_source_id` groups a company's jobs, applications and
// balances for the per-company verification report. `target_id` is the BadaBhai row written or
// matched (`payers.id`, `job_postings.id`, `applications.id`, `credit_lots.id`, `unlocks.id`).
//
// This map is deliberately NOT a column on `job_postings` or `applications`: both are read with
// bare selects, so a new column there would be apply-before-deploy (MIGRATIONS.md 0131/0132/0159).
//
// `detail` holds ids, counts, codes and mapped values only — never a name, phone, email or GSTIN.
// No PII. RLS forced, every role revoked (the migration's hand-written tail).
// ---------------------------------------------------------------------------
export const companyImportRows = pgTable(
  "company_import_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => companyImportBatches.id, { onDelete: "restrict" }),
    sourceSystem: text("source_system").$type<CompanyImportSourceSystem>().notNull(),
    kind: text("kind").$type<CompanyImportRowKind>().notNull(),
    sourceId: text("source_id").notNull(),
    companySourceId: text("company_source_id"),
    targetId: uuid("target_id"),
    state: text("state").$type<CompanyImportRowState>().notNull(),
    reason: text("reason"),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("company_import_rows_source_uq").on(t.sourceSystem, t.kind, t.sourceId),
    index("company_import_rows_batch_idx").on(t.batchId, t.kind, t.state),
    index("company_import_rows_company_idx").on(t.companySourceId),
    index("company_import_rows_target_idx").on(t.targetId),
    check("company_import_rows_source_chk", sql`${t.sourceSystem} IN ('campus')`),
    check(
      "company_import_rows_kind_chk",
      sql`${t.kind} IN ('company', 'job', 'application', 'balance', 'access')`,
    ),
    check(
      "company_import_rows_state_chk",
      sql`${t.state} IN ('created', 'matched', 'held', 'skipped', 'exception', 'rolled_back')`,
    ),
    // A row that wrote or reused something names it; a row that moved nothing names nothing.
    check(
      "company_import_rows_target_chk",
      sql`(${t.state} IN ('created', 'matched', 'rolled_back')) = (${t.targetId} IS NOT NULL)`,
    ),
    // Every row that moved nothing says why, in a short machine code.
    check(
      "company_import_rows_reason_chk",
      sql`(${t.state} IN ('held', 'skipped', 'exception')) <= (${t.reason} IS NOT NULL) AND (${t.reason} IS NULL OR char_length(${t.reason}) BETWEEN 1 AND 64)`,
    ),
    check(
      "company_import_rows_text_chk",
      sql`char_length(${t.sourceId}) BETWEEN 1 AND 200 AND (${t.companySourceId} IS NULL OR char_length(${t.companySourceId}) BETWEEN 1 AND 200)`,
    ),
  ],
).enableRLS();
