import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import type { LaunchTestResult } from "@badabhai/types";

import { paymentOrders, payers } from "./payer";
import { workers } from "./worker";

// ---------------------------------------------------------------------------
// launch_test_cohort + launch_test_shares — the records of LAUNCH TEST A (#2755 item 9).
//
// THE QUESTION: will factories pay for non-RVM workers on a new app? About 30 factories outside the
// RVM portal each get five real matching worker profiles and a ₹1,179 payment link (Starter ₹999
// plus 18% GST). THE DESK RECORDS EACH FACTORY BY HAND (`POST` / `PATCH /admin/launch-tests/cohort`).
// Nothing here sends a profile, creates a payment link or charges money: these rows are the record
// of what the desk did and what the factory did back, and nothing else.
//
// ONE ROW PER FACTORY (`launch_test_cohort`). The factory's name and phone are AES ciphertext
// (`PiiCryptoService.encrypt`, the payer contact discipline); the phone also carries the keyed HMAC
// `hashPhone` (the same as `payers.phone_hash`), which is how "outside the portal" is checked at
// write time (a phone held by a company Campus created is refused) and why one factory cannot be
// recorded twice (`launch_test_cohort_phone_hash_uq`). A factory recorded without a phone has
// neither (`launch_test_cohort_phone_chk`). The name is read back ONLY through
// `AdminIdentityService` (surface `launch_test_factories`): `read_identity`, the egress cap, the
// audit row committed, then the decrypt. The phone is never read back at all.
//
// THE RESULT. `pending` until the desk records what happened: `paid`, `declined` or `no_response`.
// `paid_at` is set exactly when the result is `paid` (`launch_test_cohort_paid_chk`). A real paid
// order of the factory's account may be linked (`payment_order_id`); the service checks it is a
// Razorpay order with status `paid` of that payer. `payment_link_ref` is the link id or URL the
// desk created by hand (1..300 characters); `link_created_at` needs a ref beside it.
//
// ONE ROW PER WORKER SENT (`launch_test_shares`), at most LAUNCH_TEST_SHARES_MAX (5) per factory:
// the service counts them under a lock on the factory row, in the write transaction. A worker must
// be in the search pool with his own consent, and never a linked RVM student, a test account or a
// sample worker (the service refuses the whole write, naming each offending worker).
//
// FOREIGN KEYS:
//   cohort.payer_id          SET NULL  — the factory's BadaBhai account, when it has one; the
//                                        record stands if the account goes.
//   cohort.payment_order_id  SET NULL  — the order it paid with; one cohort row per order
//                                        (`launch_test_cohort_payment_order_uq`).
//   shares.cohort_id         CASCADE   — a share has no meaning without its factory.
//   shares.worker_id         CASCADE   — DPDP erasure removes the worker's shares (indexed).
// `sent_by_admin_id` / `updated_by_admin_id` are opaque admin ids with no FK, so the record
// survives a change to the admin's account (the pay_on_joining_hires convention).
//
// RLS forced, every role revoked, no policy (the migration's hand-written tail). Nothing reads or
// writes either table while `ADMIN_NUMBERS_ENABLED` is off.
// ---------------------------------------------------------------------------

/** At most this many workers are sent to one factory (brief 11.1: "5 real matching profiles"). */
export const LAUNCH_TEST_SHARES_MAX = 5;

/** The longest payment-link reference the desk may record. */
export const LAUNCH_TEST_PAYMENT_LINK_REF_MAX = 300;

export const launchTestCohort = pgTable(
  "launch_test_cohort",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The factory's name, AES ciphertext. Read back only through `AdminIdentityService`. */
    factoryNameEnc: text("factory_name_enc").notNull(),
    /** The factory's phone, AES ciphertext. Never read back. */
    factoryPhoneEnc: text("factory_phone_enc"),
    /** `hashPhone` of the same phone: the "outside the portal" check and the one-row rule. */
    factoryPhoneHash: text("factory_phone_hash"),
    /** Part A's city group (`ncr`, `pune`, `ahmedabad` or `other`). */
    cityGroup: text("city_group").notNull(),
    /** Part A's trade group (`cnc_operator`, …, or `other`). */
    tradeGroup: text("trade_group").notNull(),
    /** The factory's BadaBhai account, when it has or gets one. */
    payerId: uuid("payer_id").references(() => payers.id, { onDelete: "set null" }),
    /** The admin who sent the profiles. */
    sentByAdminId: uuid("sent_by_admin_id").notNull(),
    /** When the profiles were sent. */
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    /** The payment link's id or URL, as the desk created it. */
    paymentLinkRef: text("payment_link_ref"),
    linkCreatedAt: timestamp("link_created_at", { withTimezone: true }),
    result: text("result").$type<LaunchTestResult>().notNull().default("pending"),
    /** Set exactly when `result` is `paid`. */
    paidAt: timestamp("paid_at", { withTimezone: true }),
    /** The real paid order it paid with. */
    paymentOrderId: uuid("payment_order_id").references(() => paymentOrders.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedByAdminId: uuid("updated_by_admin_id").notNull(),
  },
  (t) => [
    // One factory, one row: a phone already recorded is refused (NULLs are distinct, so factories
    // recorded without a phone are not held to it).
    uniqueIndex("launch_test_cohort_phone_hash_uq").on(t.factoryPhoneHash),
    // One cohort row per paid order; also backs the payment_order_id ON DELETE SET NULL.
    uniqueIndex("launch_test_cohort_payment_order_uq").on(t.paymentOrderId),
    // Backs the payer_id ON DELETE SET NULL.
    index("launch_test_cohort_payer_id_idx").on(t.payerId),
    // `LAUNCH_TEST_RESULTS` in @badabhai/types, spelled out because a CHECK is static SQL.
    check(
      "launch_test_cohort_result_chk",
      sql`${t.result} IN ('pending', 'paid', 'declined', 'no_response')`,
    ),
    // Paid, and when — together or not at all.
    check("launch_test_cohort_paid_chk", sql`(${t.paidAt} IS NOT NULL) = (${t.result} = 'paid')`),
    check(
      "launch_test_cohort_link_ref_chk",
      sql`${t.paymentLinkRef} IS NULL OR char_length(${t.paymentLinkRef}) BETWEEN 1 AND 300`,
    ),
    // A link's creation time needs the link beside it.
    check(
      "launch_test_cohort_link_chk",
      sql`${t.linkCreatedAt} IS NULL OR ${t.paymentLinkRef} IS NOT NULL`,
    ),
    // The phone's ciphertext and its hash, together or not at all.
    check(
      "launch_test_cohort_phone_chk",
      sql`(${t.factoryPhoneEnc} IS NULL) = (${t.factoryPhoneHash} IS NULL)`,
    ),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + four REVOKEs carried by the migration

export const launchTestShares = pgTable(
  "launch_test_shares",
  {
    cohortId: uuid("cohort_id")
      .notNull()
      .references(() => launchTestCohort.id, { onDelete: "cascade" }),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    /** When this worker's profile was sent (the factory row's `sent_at` when recorded with it). */
    sharedAt: timestamp("shared_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "launch_test_shares_pk", columns: [t.cohortId, t.workerId] }),
    // Backs the worker_id ON DELETE CASCADE: without it every worker erasure scans the table.
    index("launch_test_shares_worker_id_idx").on(t.workerId),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + four REVOKEs carried by the migration

export type LaunchTestCohortRow = typeof launchTestCohort.$inferSelect;
export type NewLaunchTestCohortRow = typeof launchTestCohort.$inferInsert;
export type LaunchTestShareRow = typeof launchTestShares.$inferSelect;
