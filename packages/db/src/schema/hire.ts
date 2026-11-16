import { sql } from "drizzle-orm";
import { check, date, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import type { ApplicantPostingKind, HireStatus } from "@badabhai/types";

import { payers } from "./payer";
import { workers } from "./worker";

// ---------------------------------------------------------------------------
// hires — one hire record per company, worker and posting (#2753 item 9).
//
// THREE SOURCES, ONE ROW. A hire is said by the company's board (a move INTO `hired`, #2747), by
// the company's follow-up answer (item 10) and by the worker's own monthly-check answer (item 5);
// the worker desk confirms or rejects it. Every source upserts the SAME row on the unique key
// (tenant, worker, posting kind, posting id), so a mark, a company answer and a worker answer for
// one person and job are one record: the issue's check.
//
// STATES. `reported` (one side said so: today only the worker's own answer, owner question 2
// default), `confirmed` (a company mark or answer, or the desk), `rejected` (the desk, or the
// company taking back its only confirming mark). Only `confirmed` counts toward the target.
//
// HOW IT WAS CONFIRMED is one timestamp per source, each set once (the first time that source said
// so) and never cleared: a repeat report changes nothing, and an undo leaves the history standing.
// `hired_on` is the India day of the first confirming source.
//
// `tenant_payer_id` is the company's TENANT key (`PayerTenantScopeService`), the key the stage
// board resolves ownership with: in `PAYER_ORG_TENANCY_MODE=on` the org's anchor, so a teammate's
// mark and the founder's answer are one company. It cascades with the payer, as every
// tenant-keyed table does (`feature_pilot_payers`). `posting_id` has no FK, as on
// `payer_applicant_stages`: one column names a `jobs` or a `job_postings` row by `posting_kind`.
//
// IDS, DATES AND CLOSED CODES ONLY: no name, phone, title or note. `worker_id` cascades on worker
// deletion (DPDP erasure). RLS forced, every role revoked (hand-written in the migration).
//
// Nothing reads or writes this table while `HIRE_RECORDS_ENABLED` is off.
// ---------------------------------------------------------------------------

export const hires = pgTable(
  "hires",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The company's tenant key (`payers.id` of the org anchor, or the login while tenancy is off). */
    tenantPayerId: uuid("tenant_payer_id")
      .notNull()
      .references(() => payers.id, { onDelete: "cascade" }),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    /** `company_posting` (a `job_postings` row) or `agency_job` (a legacy `jobs` row). */
    postingKind: text("posting_kind").$type<ApplicantPostingKind>().notNull(),
    /** The posting's id in the table `posting_kind` names. No FK (see the header). */
    postingId: uuid("posting_id").notNull(),
    status: text("status").$type<HireStatus>().notNull(),
    /** The company first moved him INTO `hired` on its board. */
    companyMarkedAt: timestamp("company_marked_at", { withTimezone: true }),
    /** The company's follow-up answer first said "hired". */
    companyAnsweredAt: timestamp("company_answered_at", { withTimezone: true }),
    /** The worker's own answer first said "hired". */
    workerAnsweredAt: timestamp("worker_answered_at", { withTimezone: true }),
    /** The worker desk first confirmed it. */
    deskConfirmedAt: timestamp("desk_confirmed_at", { withTimezone: true }),
    /** The India (IST) day of the first confirming source; null until one confirms. */
    hiredOn: date("hired_on", { mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One record per company, worker and posting: the upsert target every source writes through.
    unique("hires_tenant_worker_posting_uq").on(
      t.tenantPayerId,
      t.workerId,
      t.postingKind,
      t.postingId,
    ),
    // Backs the `worker_id` ON DELETE CASCADE: without it every worker erasure scans the table.
    index("hires_worker_id_idx").on(t.workerId),
    // `APPLICANT_POSTING_KINDS` / `HIRE_STATUSES` in @badabhai/types, spelled out because a CHECK
    // is static SQL.
    check("hires_posting_kind_chk", sql`${t.postingKind} IN ('company_posting', 'agency_job')`),
    check("hires_status_chk", sql`${t.status} IN ('reported', 'confirmed', 'rejected')`),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by the migration

export type Hire = typeof hires.$inferSelect;
export type NewHire = typeof hires.$inferInsert;
