import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { jobPostings } from "./job";
import { unlocks } from "./payer";

/** Who a waiver frees: every RVM applicant of one company, or the RVM applicants of one job. */
export type RvmWaiverScope = "company" | "job";

/** Where the waiver was set: Campus's placement team (service route) or a BadaBhai admin. */
export type RvmWaiverSource = "campus" | "admin";

// ---------------------------------------------------------------------------
// rvm_applicant_waivers — the placement team's waiver of the contact cost (#2750 item 5).
//
// Under the credit rules an RVM student who applied costs one credit to open; RVM's placement
// team can waive that for ONE COMPANY (every RVM student who applied to any of its jobs) or ONE
// JOB (the RVM students who applied to that job). Everyone else still pays.
//
// ONE ROW PER WAIVER, NEVER DELETED. Setting a waiver inserts a row (`active`); clearing it sets
// `active = false` and the `cleared_*` columns on that same row, so the table is the full history
// of who waived what, when and why. The partial unique indexes keep at most one ACTIVE waiver per
// company and per job; `rvm_applicant_waivers_active_chk` ties `active` to `cleared_at`.
//
// `payer_id` is the company's TENANT key (ADR-0053): the key its opens are made under. For a job
// waiver it is the posting's owner, checked when the waiver is set.
//
// STAFF NAMES ARE ENCRYPTED (owner ruling 2026-11-17). `set_by_ref` / `cleared_by_ref` are the
// Campus staff uuid or the `admin_users.id`; `*_label_enc` is that person's name as an AES-GCM
// token (PiiCryptoService), decrypted only for the admin list and Campus's own read. A null label
// is an admin with no stored name. `reason` / `clear_reason` are staff-written text, length-capped.
//
// READ ONLY WHILE `CREDIT_RULES_ROLLOUT` IS ON. RLS forced, every role revoked (the migration's
// hand-written tail).
// ---------------------------------------------------------------------------
export const rvmApplicantWaivers = pgTable(
  "rvm_applicant_waivers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: text("scope").$type<RvmWaiverScope>().notNull(),
    // The company's tenant key. No FK, like `unlocks.payer_id` (faceless rails).
    payerId: uuid("payer_id").notNull(),
    // Set for a job waiver only. A deleted posting takes its waivers (and their uses) with it.
    jobPostingId: uuid("job_posting_id").references(() => jobPostings.id, { onDelete: "cascade" }),
    active: boolean("active").notNull().default(true),
    source: text("source").$type<RvmWaiverSource>().notNull(),
    setByRef: text("set_by_ref").notNull(),
    setByLabelEnc: text("set_by_label_enc"),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
    clearedByRef: text("cleared_by_ref"),
    clearedByLabelEnc: text("cleared_by_label_enc"),
    clearReason: text("clear_reason"),
  },
  (t) => [
    uniqueIndex("rvm_applicant_waivers_company_active_uq")
      .on(t.payerId)
      .where(sql`${t.active} AND ${t.scope} = 'company'`),
    uniqueIndex("rvm_applicant_waivers_job_active_uq")
      .on(t.jobPostingId)
      .where(sql`${t.active} AND ${t.scope} = 'job'`),
    // The list (newest first) and a company's waivers.
    index("rvm_applicant_waivers_payer_idx").on(t.payerId, t.createdAt.desc()),
    index("rvm_applicant_waivers_job_posting_idx").on(t.jobPostingId),
    check("rvm_applicant_waivers_scope_chk", sql`${t.scope} IN ('company', 'job')`),
    check("rvm_applicant_waivers_source_chk", sql`${t.source} IN ('campus', 'admin')`),
    check(
      "rvm_applicant_waivers_scope_posting_chk",
      sql`(${t.scope} = 'company' AND ${t.jobPostingId} IS NULL) OR (${t.scope} = 'job' AND ${t.jobPostingId} IS NOT NULL)`,
    ),
    check(
      "rvm_applicant_waivers_active_chk",
      sql`${t.active} = (${t.clearedAt} IS NULL) AND (${t.clearedAt} IS NULL OR ${t.clearedByRef} IS NOT NULL)`,
    ),
    check(
      "rvm_applicant_waivers_text_chk",
      sql`char_length(${t.setByRef}) BETWEEN 1 AND 128 AND char_length(${t.reason}) BETWEEN 1 AND 500 AND (${t.clearedByRef} IS NULL OR char_length(${t.clearedByRef}) BETWEEN 1 AND 128) AND (${t.clearReason} IS NULL OR char_length(${t.clearReason}) <= 500)`,
    ),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + four REVOKEs carried by the migration's tail

export type RvmApplicantWaiverRow = typeof rvmApplicantWaivers.$inferSelect;
export type NewRvmApplicantWaiverRow = typeof rvmApplicantWaivers.$inferInsert;

// ---------------------------------------------------------------------------
// rvm_waiver_uses — which open each waiver paid for (#2750 item 5).
//
// One row per waived open, written in the open's own transaction beside its zero-credit `waived`
// ledger line. It answers Campus's "contacts opened under it" per waiver; the ledger line answers
// the numbers screen's "credits waived by the placement team". One open is waived at most once
// (`unlock_id` unique). PII-free: ids and a time.
// ---------------------------------------------------------------------------
export const rvmWaiverUses = pgTable(
  "rvm_waiver_uses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    waiverId: uuid("waiver_id")
      .notNull()
      .references(() => rvmApplicantWaivers.id, { onDelete: "cascade" }),
    unlockId: uuid("unlock_id")
      .notNull()
      .references(() => unlocks.id, { onDelete: "cascade" }),
    payerId: uuid("payer_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("rvm_waiver_uses_unlock_uq").on(t.unlockId),
    index("rvm_waiver_uses_waiver_idx").on(t.waiverId),
  ],
).enableRLS();

export type RvmWaiverUseRow = typeof rvmWaiverUses.$inferSelect;

// ---------------------------------------------------------------------------
// rvm_waiver_end_dates — the last day a waiver applies (#2778).
//
// A NEW TABLE, NOT A COLUMN on `rvm_applicant_waivers`: the waiver code reads that table with bare
// selects, so a model column would be named in production before its ALTER (the deploy-safe schema
// rule). ONE ROW PER DATED WAIVER, written in the transaction that sets the waiver and never
// changed: a new end date is a clear and a new set, like a new reason. A waiver with no row runs
// until someone clears it, as before.
//
// `ends_on` is the LAST DAY (India time) the waiver applies. From the next day the waiver no longer
// frees anyone: the quote and the open both price the contact as if there were no waiver, the
// in-force list leaves it out, and the waiver row itself is untouched (nothing is deleted; it stays
// `active` until a clear, or until a new waiver of the same scope replaces it).
//
// `payer_id` is the waiver's tenant key, copied for the company's own reads. PII-free.
//
// READ AND WRITTEN ONLY WHILE `RVM_WAIVER_END_DATES_ENABLED` IS ON. RLS forced, every role revoked
// (the migration's hand-written tail).
// ---------------------------------------------------------------------------
export const rvmWaiverEndDates = pgTable(
  "rvm_waiver_end_dates",
  {
    waiverId: uuid("waiver_id")
      .primaryKey()
      .references(() => rvmApplicantWaivers.id, { onDelete: "cascade" }),
    payerId: uuid("payer_id").notNull(),
    endsOn: date("ends_on", { mode: "string" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("rvm_waiver_end_dates_payer_idx").on(t.payerId)],
).enableRLS();

export type RvmWaiverEndDateRow = typeof rvmWaiverEndDates.$inferSelect;
