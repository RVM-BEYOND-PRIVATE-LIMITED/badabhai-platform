import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  ManagedHiringCallbackReason,
  ManagedHiringOrderStatus,
  ManagedHiringTier,
  VacancyBand,
} from "@badabhai/types";
import { jobPostings } from "./job";
import { paymentOrders } from "./payer";
import { workers } from "./worker";

// ---------------------------------------------------------------------------
// MANAGED HIRING (#2751 items 4 to 13; brief section 2 and 4B.9). A company pays, per job, for
// BadaBhai's desk to find workers who confirm by phone that they are interested: at least
// `target_count` (5) in `working_days` (7) working days, with a free extension when it misses.
// The service NEVER promises a hire.
//
// NOTHING READS OR WRITES THESE TABLES unless `MANAGED_HIRING_ROLLOUT` is on for the company (or,
// for the sweep, on anywhere). The migration is apply-before-switch-on, not apply-before-deploy.
//
// `payer_id` is the company's TENANT key (ADR-0053): the wallet its payment order was stamped with
// and the key its job ownership is read by. PII-FREE except `managed_hiring_interest.note`, a short
// staff note that is never put on an event, never shown to the company, and cascades away with the
// worker.
// ---------------------------------------------------------------------------

/**
 * managed_hiring_orders — one prepaid order for one job. `created` at checkout (a
 * `payment_orders` row of kind `managed_hiring` is created with it); `active` once that payment is
 * captured, with the clock stamped (`started_at`, `due_at`, `extended_until`); then `met`,
 * `extended`, `closed_unmet` (the sweep), or `cancelled` (reserved). At most ONE open order
 * (`created`, `active`, `extended`) per job.
 *
 * The tier, the price and the clock terms are STAMPED here at checkout, so an ops edit of the
 * catalogue never changes an order already sold; the holiday list is read once, at activation.
 */
export const managedHiringOrders = pgTable(
  "managed_hiring_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    payerId: uuid("payer_id").notNull(),
    // The login that started the checkout (the email recipient for the order's changes).
    createdBy: uuid("created_by").notNull(),
    // ON DELETE CASCADE: an erasure that deletes a posting (a test company's rows) is never
    // blocked by its order; the money record stays on `payment_orders`.
    jobPostingId: uuid("job_posting_id")
      .notNull()
      .references(() => jobPostings.id, { onDelete: "cascade" }),
    tier: text("tier").$type<ManagedHiringTier>().notNull(),
    // The order's payment. RESTRICT: a payment order is a financial record and is never deleted.
    paymentOrderId: uuid("payment_order_id")
      .notNull()
      .references(() => paymentOrders.id, { onDelete: "restrict" }),
    status: text("status").$type<ManagedHiringOrderStatus>().notNull().default("created"),
    // The list price before GST, whole rupees (what the quote showed and the company confirmed).
    priceInr: integer("price_inr").notNull(),
    targetCount: integer("target_count").notNull(),
    workingDays: integer("working_days").notNull(),
    extensionDays: integer("extension_days").notNull(),
    // Stamped on activation (payment capture). NULL while `created`.
    startedAt: timestamp("started_at", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    extendedUntil: timestamp("extended_until", { withTimezone: true }),
    // When the order was extended, and when it ended (`met` or `closed_unmet`).
    extendedAt: timestamp("extended_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    // A staff test company's order (copied from `payers.is_test_account` at checkout, #2746).
    isTest: boolean("is_test").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("managed_hiring_orders_payment_order_uq").on(t.paymentOrderId),
    // ONE OPEN ORDER PER JOB (#2751 item 6), as a constraint: two checkouts racing for one job
    // cannot both write.
    uniqueIndex("managed_hiring_orders_open_job_uq")
      .on(t.jobPostingId)
      .where(sql`${t.status} IN ('created', 'active', 'extended')`),
    // The sweep: open orders by deadline.
    index("managed_hiring_orders_status_due_idx").on(t.status, t.dueAt),
    index("managed_hiring_orders_payer_created_idx").on(t.payerId, t.createdAt),
    // The admin list, newest first.
    index("managed_hiring_orders_created_idx").on(t.createdAt.desc(), t.id.desc()),
    check(
      "managed_hiring_orders_status_chk",
      sql`${t.status} IN ('created', 'active', 'met', 'extended', 'closed_unmet', 'cancelled')`,
    ),
    check("managed_hiring_orders_tier_chk", sql`${t.tier} IN ('standard', 'large')`),
    check(
      "managed_hiring_orders_terms_pos_chk",
      sql`${t.priceInr} > 0 AND ${t.targetCount} > 0 AND ${t.workingDays} > 0 AND ${t.extensionDays} >= ${t.workingDays}`,
    ),
    // Every status but `created` (and `cancelled`, which may never have started) has its clock.
    check(
      "managed_hiring_orders_clock_chk",
      sql`${t.status} IN ('created', 'cancelled') OR (${t.startedAt} IS NOT NULL AND ${t.dueAt} IS NOT NULL AND ${t.extendedUntil} IS NOT NULL)`,
    ),
    check(
      "managed_hiring_orders_clock_order_chk",
      sql`${t.dueAt} IS NULL OR (${t.dueAt} > ${t.startedAt} AND ${t.extendedUntil} >= ${t.dueAt})`,
    ),
  ],
).enableRLS(); // FORCE + four REVOKEs carried by the migration's hand-written tail

export type ManagedHiringOrderRow = typeof managedHiringOrders.$inferSelect;

/**
 * managed_hiring_interest — the tracker: one worker the desk reached by phone and who confirmed he
 * is interested in the order's job. Added and removed by staff only (an admin route), never by the
 * company. UNIQUE per order and worker. While the order is paid, opening his contact costs the
 * company no credits (#2751 item 11, register B7-15).
 *
 * `payer_id` repeats the order's tenant key so the contact-cost read is one index probe.
 * `worker_id` CASCADES: a worker's erasure takes his tracker rows (and the staff note) with him.
 */
export const managedHiringInterest = pgTable(
  "managed_hiring_interest",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => managedHiringOrders.id, { onDelete: "cascade" }),
    payerId: uuid("payer_id").notNull(),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    // The admin who confirmed him (opaque `admin_users.id`; no FK, as on `audit_logs`).
    confirmedBy: uuid("confirmed_by").notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull().defaultNow(),
    // The staff note on the call. Admin-only: never on an event, never on a company read.
    note: text("note").notNull(),
  },
  (t) => [
    uniqueIndex("managed_hiring_interest_order_worker_uq").on(t.orderId, t.workerId),
    index("managed_hiring_interest_payer_worker_idx").on(t.payerId, t.workerId),
    index("managed_hiring_interest_worker_idx").on(t.workerId),
    check("managed_hiring_interest_note_len_chk", sql`char_length(${t.note}) BETWEEN 1 AND 500`),
  ],
).enableRLS();

export type ManagedHiringInterestRow = typeof managedHiringInterest.$inferSelect;

/**
 * managed_hiring_callback_requests — a job above the largest tier (more than 10 vacancies) gets no
 * checkout: the company asks for a call, an admin is alerted, and the request waits in the admin
 * queue (brief sections 7 and 12, register B7-05). ONE per job: asking again returns the first.
 */
export const managedHiringCallbackRequests = pgTable(
  "managed_hiring_callback_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    payerId: uuid("payer_id").notNull(),
    requestedBy: uuid("requested_by").notNull(),
    jobPostingId: uuid("job_posting_id")
      .notNull()
      .references(() => jobPostings.id, { onDelete: "cascade" }),
    // The job's vacancy band when it asked (the reason it could not be sold).
    vacancyBand: text("vacancy_band").$type<VacancyBand>().notNull(),
    reason: text("reason").$type<ManagedHiringCallbackReason>().notNull(),
    isTest: boolean("is_test").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("managed_hiring_callback_requests_job_uq").on(t.jobPostingId),
    index("managed_hiring_callback_requests_created_idx").on(t.createdAt.desc(), t.id.desc()),
    check(
      "managed_hiring_callback_requests_reason_chk",
      sql`${t.reason} IN ('above_largest_tier')`,
    ),
    check(
      "managed_hiring_callback_requests_band_chk",
      sql`${t.vacancyBand} IN ('1', '2-5', '6-10', '11-25', '25+')`,
    ),
  ],
).enableRLS();

export type ManagedHiringCallbackRequestRow = typeof managedHiringCallbackRequests.$inferSelect;
