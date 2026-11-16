import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { jobPostings } from "./job";
import { payers } from "./payer";
import { workers } from "./worker";

// ---------------------------------------------------------------------------
// pay_on_joining_hires — the PAY-ON-JOINING PILOT's record, one row per hire (#2753 item 11).
//
// The pilot (3 anchor factories, 5 partners, NCR, December to January): a factory pays a fee for a
// worker who joined and stayed 30 days; the partner who brought him is owed a share of it, paid
// when the factory pays; BadaBhai keeps the rest. THIS TABLE IS THE RECORD AND NOTHING ELSE. An
// admin writes every row by hand (`POST` / `PATCH /admin/pay-on-joining-hires`); nothing here
// raises an invoice, moves money, pays a partner or decides which factory qualifies — the owner
// chooses the factories by hand during the pilot.
//
// MONEY IN INTEGER PAISE. `fee_paise` is what the factory owes for this hire. `partner_share_percent`
// is COPIED from the `POJ_PARTNER_SHARE_PERCENT` setting when the row is created, so a later change
// of the setting never rewrites a recorded hire. `partner_share_paise` is computed by the SERVER,
// never accepted from a client: floor(fee_paise * percent / 100). FLOOR: BadaBhai keeps the
// remainder paisa. `pay_on_joining_hires_share_math_chk` pins that arithmetic in the database, so no
// writer can store any other figure.
//
// IDS, DATES AND PAISE. `note` is the one free-text column: an admin's own words, never logged and
// never on an event (the event carries the field KEY `note`, not its text).
//
// ONE ROW PER HIRE: UNIQUE (factory, worker, job posting) NULLS NOT DISTINCT, so a hire recorded
// without a posting is still unique per factory and worker.
//
// FOREIGN KEYS:
//   factory_payer_id  CASCADE  — as every admin-written table on `payers` (feature_pilot_payers,
//                                0162/0163). A payer row is only ever hard-deleted by the QA seam.
//   partner_payer_id  SET NULL — the hire stays with its factory if the partner's login goes.
//   job_posting_id    SET NULL — the hire stands without its posting.
//   worker_id         CASCADE  — DPDP erasure removes the worker's hires (indexed).
// `created_by_admin_id` / `updated_by_admin_id` are opaque admin ids with no FK, so the record
// survives a change to the admin's account (the worker_flags / worker_admin_override convention).
//
// RLS forced, every role revoked, no policy (migration 0171's hand-written tail).
// ---------------------------------------------------------------------------

/** The longest admin note, in characters. */
export const POJ_NOTE_MAX_CHARS = 500;

export const payOnJoiningHires = pgTable(
  "pay_on_joining_hires",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The factory the worker joined: an employer payer chosen by hand for the pilot. */
    factoryPayerId: uuid("factory_payer_id")
      .notNull()
      .references(() => payers.id, { onDelete: "cascade" }),
    /** The factory's posting he was hired against, when there is one. */
    jobPostingId: uuid("job_posting_id").references(() => jobPostings.id, {
      onDelete: "set null",
    }),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    /** The agency partner owed the share, when there is one. */
    partnerPayerId: uuid("partner_payer_id").references(() => payers.id, {
      onDelete: "set null",
    }),
    joinedOn: date("joined_on", { mode: "string" }).notNull(),
    /** The 30-day check: the day it was made and what it found (both or neither). */
    stayCheckedOn: date("stay_checked_on", { mode: "string" }),
    stayed30Days: boolean("stayed_30_days"),
    /** What the factory owes for this hire, in paise. */
    feePaise: bigint("fee_paise", { mode: "number" }).notNull(),
    /** The setting as it stood when the row was created. Never rewritten. */
    partnerSharePercent: integer("partner_share_percent").notNull(),
    /** floor(fee_paise * partner_share_percent / 100), computed by the server. */
    partnerSharePaise: bigint("partner_share_paise", { mode: "number" }).notNull(),
    invoicedOn: date("invoiced_on", { mode: "string" }),
    factoryPaidOn: date("factory_paid_on", { mode: "string" }),
    partnerPaidOn: date("partner_paid_on", { mode: "string" }),
    /** Admin free text. Never logged, never on an event. */
    note: text("note"),
    createdByAdminId: uuid("created_by_admin_id").notNull(),
    updatedByAdminId: uuid("updated_by_admin_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One row per hire. A table CONSTRAINT, because this drizzle version models NULLS NOT DISTINCT
    // on a constraint only (see 0037 / 0067). Its leading column also serves the factory filter.
    unique("pay_on_joining_hires_hire_uq")
      .on(t.factoryPayerId, t.workerId, t.jobPostingId)
      .nullsNotDistinct(),
    // Backs the worker_id ON DELETE CASCADE: without it every worker erasure scans the table.
    index("pay_on_joining_hires_worker_id_idx").on(t.workerId),
    // The partner filter, and the partner_payer_id ON DELETE SET NULL.
    index("pay_on_joining_hires_partner_payer_id_idx").on(t.partnerPayerId),
    check("pay_on_joining_hires_fee_chk", sql`${t.feePaise} >= 0`),
    check(
      "pay_on_joining_hires_percent_chk",
      sql`${t.partnerSharePercent} >= 0 AND ${t.partnerSharePercent} <= 100`,
    ),
    check("pay_on_joining_hires_share_chk", sql`${t.partnerSharePaise} >= 0`),
    // The server's arithmetic, pinned: bigint * integer / 100 truncates, which is the floor for a
    // non-negative fee. A fee within Number.MAX_SAFE_INTEGER times 100 stays inside bigint.
    check(
      "pay_on_joining_hires_share_math_chk",
      sql`${t.partnerSharePaise} = (${t.feePaise} * ${t.partnerSharePercent}) / 100`,
    ),
    // The 30-day check has a date and an outcome, or neither.
    check(
      "pay_on_joining_hires_stay_check_chk",
      sql`(${t.stayCheckedOn} IS NULL) = (${t.stayed30Days} IS NULL)`,
    ),
    check(
      "pay_on_joining_hires_note_chk",
      sql`${t.note} IS NULL OR char_length(${t.note}) BETWEEN 1 AND 500`,
    ),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by migration 0171

export type PayOnJoiningHire = typeof payOnJoiningHires.$inferSelect;
export type NewPayOnJoiningHire = typeof payOnJoiningHires.$inferInsert;
