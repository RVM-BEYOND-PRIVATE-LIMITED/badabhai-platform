import { createHash } from "node:crypto";
import { LAUNCH_TEST_SHARES_MAX } from "@badabhai/db";
import type { LaunchTestFactoryField } from "@badabhai/event-schema";
import type { LaunchTestResult, UnlockOutcome, UnlockOutcomeAnswerer } from "@badabhai/types";
import { isSampleWorkerId } from "../numbers/exclusions";

/**
 * #2755 part D — THE RULES of the two launch-test records, as pure functions. No database, no
 * clock, no config: the service reads the facts, asks here, and writes or answers what these say.
 * Each rule is written once and unit-tested on its own (`launch-test-rules.test.ts`); the DB gate
 * ties the SQL halves to them.
 */

// -----------------------------------------------------------------------------------------------
// Test A — which workers may be sent to a factory
// -----------------------------------------------------------------------------------------------

/**
 * Why a worker may not be sent, one closed code each, IN PRECEDENCE ORDER: the first that holds
 * is the one named. `not_found` (no such worker), `sample_worker` (a seeded id), `test_worker`
 * (`workers.is_test_account`), `linked_rvm_identity` (a Campus-created row whose student never
 * signed in, #2752), `not_in_search_pool` (he is not in company search with his own consent: the
 * search's own membership rule, which also keeps out an actively linked RVM student).
 */
export const LAUNCH_TEST_WORKER_REFUSALS = [
  "not_found",
  "sample_worker",
  "test_worker",
  "linked_rvm_identity",
  "not_in_search_pool",
] as const;
export type LaunchTestWorkerRefusal = (typeof LAUNCH_TEST_WORKER_REFUSALS)[number];

/** What the service read about one requested worker, before the pool check. */
export interface ShareWorkerFacts {
  readonly workerId: string;
  /** The `workers` row exists. */
  readonly exists: boolean;
  /** Part A's `excludeTestWorkers` does NOT hold (`workers.is_test_account`). */
  readonly testWorker: boolean;
  /** Part A's `excludeLinkedRvmIdentities` does NOT hold (pending + an institute origin). */
  readonly linkedRvmIdentity: boolean;
}

/**
 * The refusal of one worker on every rule but the pool, or `null` when they all pass and the pool
 * must be asked. The sample rule is part A's `isSampleWorkerId`, so it holds for an id with no row.
 */
export function refusalBeforePool(facts: ShareWorkerFacts): LaunchTestWorkerRefusal | null {
  if (!facts.exists) return "not_found";
  if (isSampleWorkerId(facts.workerId)) return "sample_worker";
  if (facts.testWorker) return "test_worker";
  if (facts.linkedRvmIdentity) return "linked_rvm_identity";
  return null;
}

/** One offending worker in a refused write. */
export interface RefusedWorker {
  readonly worker_id: string;
  readonly reason: LaunchTestWorkerRefusal;
}

/**
 * The refused workers in the REQUEST's order, from the per-worker answers (`null` = may be sent).
 * Empty means the whole set may be sent.
 */
export function refusedWorkers(
  requested: readonly string[],
  refusals: ReadonlyMap<string, LaunchTestWorkerRefusal | null>,
): RefusedWorker[] {
  return requested.flatMap((workerId) => {
    const reason = refusals.get(workerId);
    if (reason === undefined) {
      throw new Error("launch tests: a requested worker has no eligibility answer");
    }
    return reason === null ? [] : [{ worker_id: workerId, reason }];
  });
}

/**
 * Whether adding `adding` shares to a factory that holds `existing` would pass the cap of
 * {@link LAUNCH_TEST_SHARES_MAX}. The service asks this under the lock on the factory row, so two
 * racing writes cannot both pass it.
 */
export function exceedsShareLimit(existing: number, adding: number): boolean {
  return existing + adding > LAUNCH_TEST_SHARES_MAX;
}

// -----------------------------------------------------------------------------------------------
// Test A — "outside the portal"
// -----------------------------------------------------------------------------------------------

/** A BadaBhai company holding the factory's phone, as the service read it. */
export interface PhoneHolder {
  readonly payerId: string;
  /** Campus created it (`institute_companies`, #2752 item 5). */
  readonly campusCompany: boolean;
}

/** Why a factory is not "outside the portal". */
export const LAUNCH_TEST_PORTAL_REFUSALS = ["campus_company", "portal_import"] as const;
export type LaunchTestPortalRefusal = (typeof LAUNCH_TEST_PORTAL_REFUSALS)[number];

/**
 * The portal refusal for a factory, or `null`: `campus_company` when any company holding its phone
 * (or the account named for it) is one Campus created; `portal_import` when the #2754 import
 * ledger holds it (the hook answers false until that ledger exists).
 */
export function portalRefusal(
  holders: readonly PhoneHolder[],
  importedFromPortal: boolean,
): LaunchTestPortalRefusal | null {
  if (holders.some((h) => h.campusCompany)) return "campus_company";
  if (importedFromPortal) return "portal_import";
  return null;
}

/**
 * The account a new factory row links when the desk names none: the ONE ordinary company holding
 * its phone, or `null` when none does or several do (the desk links it by hand then). A Campus
 * company never reaches here: {@link portalRefusal} refuses first.
 */
export function autoLinkedPayer(holders: readonly PhoneHolder[]): string | null {
  const ordinary = [...new Set(holders.filter((h) => !h.campusCompany).map((h) => h.payerId))];
  return ordinary.length === 1 ? ordinary[0]! : null;
}

// -----------------------------------------------------------------------------------------------
// Test A — idempotency of the create
// -----------------------------------------------------------------------------------------------

/**
 * The factory row's id for one admin's Idempotency-Key: a version-5-shaped uuid from a SHA-256 of
 * the admin and the key, so a retried create names the SAME row and `ON CONFLICT (id) DO NOTHING`
 * makes it a replay. Scoped by admin, so two admins can never collide on one key.
 */
export function cohortIdForKey(adminId: string, idempotencyKey: string): string {
  const h = createHash("sha256")
    // `|` is outside the key's charset (`A-Z a-z 0-9 . _ : -`) and a uuid's, so the parts cannot run
    // into each other.
    .update(`launch_test_cohort|${adminId}|${idempotencyKey}`)
    .digest();
  h[6] = (h[6]! & 0x0f) | 0x50; // version 5
  h[8] = (h[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** The parts of a create a replay is compared on (the name is ciphertext and cannot be). */
export interface CreateFingerprint {
  readonly phoneHash: string | null;
  readonly cityGroup: string;
  readonly tradeGroup: string;
  readonly sentAtMs: number;
  readonly workerIds: readonly string[];
}

/** True when a replayed create asks for the row that is already stored. */
export function sameCreate(stored: CreateFingerprint, asked: CreateFingerprint): boolean {
  const a = [...stored.workerIds].sort();
  const b = [...asked.workerIds].sort();
  return (
    stored.phoneHash === asked.phoneHash &&
    stored.cityGroup === asked.cityGroup &&
    stored.tradeGroup === asked.tradeGroup &&
    stored.sentAtMs === asked.sentAtMs &&
    a.length === b.length &&
    a.every((id, i) => id === b[i])
  );
}

// -----------------------------------------------------------------------------------------------
// Test A — the edit
// -----------------------------------------------------------------------------------------------

/** The editable state of a factory row. */
export interface FactoryState {
  readonly paymentLinkRef: string | null;
  readonly linkCreatedAt: Date | null;
  readonly result: LaunchTestResult;
  readonly paidAt: Date | null;
  readonly payerId: string | null;
  readonly paymentOrderId: string | null;
}

/** A PATCH, already validated: `undefined` = leave as is, `null` = clear. */
export interface FactoryPatch {
  readonly paymentLinkRef?: string | null;
  readonly linkCreatedAt?: Date | null;
  readonly result?: LaunchTestResult;
  readonly paidAt?: Date | null;
  readonly payerId?: string | null;
  readonly paymentOrderId?: string | null;
}

/** The state after the patch. */
export function mergeFactoryPatch(current: FactoryState, patch: FactoryPatch): FactoryState {
  const pick = <K extends keyof FactoryState>(key: K): FactoryState[K] =>
    patch[key] === undefined ? current[key] : (patch[key] as FactoryState[K]);
  return {
    paymentLinkRef: pick("paymentLinkRef"),
    linkCreatedAt: pick("linkCreatedAt"),
    result: pick("result"),
    paidAt: pick("paidAt"),
    payerId: pick("payerId"),
    paymentOrderId: pick("paymentOrderId"),
  };
}

/** Why a factory row may not hold a state. */
export const LAUNCH_TEST_STATE_REFUSALS = [
  // `launch_test_cohort_paid_chk`, mirrored: paid_at is set exactly when the result is paid.
  "paid_at_mismatch",
  // `launch_test_cohort_link_chk`, mirrored: a link's creation time needs the link.
  "link_created_without_ref",
  // A paid order is linked only to a factory with an account (it must be that account's order)…
  "payment_order_without_payer",
  // …and only once the factory has paid.
  "payment_order_needs_paid_result",
] as const;
export type LaunchTestStateRefusal = (typeof LAUNCH_TEST_STATE_REFUSALS)[number];

/** The first rule the state breaks, or `null`. The DB CHECKs hold the first two as well. */
export function stateRefusal(next: FactoryState): LaunchTestStateRefusal | null {
  if ((next.paidAt !== null) !== (next.result === "paid")) return "paid_at_mismatch";
  if (next.linkCreatedAt !== null && next.paymentLinkRef === null) {
    return "link_created_without_ref";
  }
  if (next.paymentOrderId !== null && next.payerId === null) return "payment_order_without_payer";
  if (next.paymentOrderId !== null && next.result !== "paid") {
    return "payment_order_needs_paid_result";
  }
  return null;
}

const sameInstant = (a: Date | null, b: Date | null): boolean =>
  a === null || b === null ? a === b : a.getTime() === b.getTime();

/** The parts that changed, in `LAUNCH_TEST_FACTORY_FIELDS` order; empty = nothing to write. */
export function changedFields(current: FactoryState, next: FactoryState): LaunchTestFactoryField[] {
  const out: LaunchTestFactoryField[] = [];
  if (
    current.paymentLinkRef !== next.paymentLinkRef ||
    !sameInstant(current.linkCreatedAt, next.linkCreatedAt)
  ) {
    out.push("payment_link");
  }
  if (current.result !== next.result || !sameInstant(current.paidAt, next.paidAt)) {
    out.push("result");
  }
  if (current.payerId !== next.payerId) out.push("payer");
  if (current.paymentOrderId !== next.paymentOrderId) out.push("payment_order");
  return out;
}

/** A short, stable digest of a state: part of the update event's idempotency key. */
export function stateFingerprint(state: FactoryState): string {
  const canonical = JSON.stringify([
    state.paymentLinkRef,
    state.linkCreatedAt?.getTime() ?? null,
    state.result,
    state.paidAt?.getTime() ?? null,
    state.payerId,
    state.paymentOrderId,
  ]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * The provider of a REAL order: Razorpay, the only payment provider, whose orders are the only rows
 * `payment_orders` holds in production (the mock purchase route writes none). The same value as
 * `RAZORPAY_PROVIDER` in `unlocks/unlocks.repository.ts`, which this module may not import (BC-8:
 * only `unlocks/` imports the unlock tables' sole writer); `launch-test-rules.test.ts` holds the
 * two equal.
 */
export const REAL_PAYMENT_PROVIDER = "razorpay";

/** A payment order as the service read it. */
export interface PaymentOrderFacts {
  readonly payerId: string;
  readonly status: string;
  readonly provider: string;
}

/** Why a payment order may not be linked. */
export const LAUNCH_TEST_ORDER_REFUSALS = [
  "payment_order_not_found",
  // Not a provider order: the only real orders are Razorpay's (the mock route writes no order row;
  // any other provider value is a test or seed row, never money).
  "payment_order_not_real",
  "payment_order_not_paid",
  "payment_order_other_payer",
] as const;
export type LaunchTestOrderRefusal = (typeof LAUNCH_TEST_ORDER_REFUSALS)[number];

/**
 * The refusal of linking `order` to a factory whose account is `payerId`, or `null`: it must be a
 * REAL (Razorpay) order with status `paid`, of that account.
 */
export function paymentOrderRefusal(
  order: PaymentOrderFacts | undefined,
  payerId: string,
  realProvider: string,
): LaunchTestOrderRefusal | null {
  if (order === undefined) return "payment_order_not_found";
  if (order.provider !== realProvider) return "payment_order_not_real";
  if (order.status !== "paid") return "payment_order_not_paid";
  if (order.payerId !== payerId) return "payment_order_other_payer";
  return null;
}

// -----------------------------------------------------------------------------------------------
// Test B — contacts per hire
// -----------------------------------------------------------------------------------------------

/** How many confirmed hires the report lists (brief 11.2: "the first 50 BadaBhai hires"). */
export const CONTACTS_PER_HIRE_LIMIT = 50;

/**
 * Why a listed hire has no contact count. `agency_job`: the hire is on an agency's legacy `jobs`
 * row, which a company unlock never names. `posting_deleted`: its `job_postings` row is gone, so
 * the unlocks that named it lost the link (`unlocks.job_posting_id` SET NULL) and cannot be told
 * apart.
 */
export const CONTACTS_PER_HIRE_REASONS = ["agency_job", "posting_deleted"] as const;
export type ContactsPerHireReason = (typeof CONTACTS_PER_HIRE_REASONS)[number];

/**
 * One confirmed hire, as read. `confirmedKey` is the confirmation time as Postgres renders it at
 * MICROSECOND precision (`YYYY-MM-DDTHH:MI:SS.USZ`): a JS Date keeps milliseconds only, and the
 * order and the cut-off must not change inside one millisecond.
 */
export interface HireRecordRow {
  readonly hireId: string;
  readonly tenantPayerId: string;
  readonly workerId: string;
  readonly postingKind: "company_posting" | "agency_job";
  readonly postingId: string;
  /** The `job_postings` row still exists (only read for a company posting). */
  readonly postingExists: boolean;
  readonly confirmedKey: string;
}

/** One opened contact of a listed hire's company and posting, as read (same key precision). */
export interface OpenedContactRow {
  readonly unlockId: string;
  readonly tenantPayerId: string;
  readonly jobPostingId: string;
  /** Null when the worker has been erased (the unlock keeps its row). */
  readonly workerId: string | null;
  readonly grantedKey: string;
  readonly outcome: UnlockOutcome | null;
  readonly answeredBy: UnlockOutcomeAnswerer | null;
  readonly answeredAt: Date | null;
}

/** The report's order: the confirmation time, then the hire id. A total order. */
export function compareHires(a: HireRecordRow, b: HireRecordRow): number {
  if (a.confirmedKey !== b.confirmedKey) return a.confirmedKey < b.confirmedKey ? -1 : 1;
  return a.hireId < b.hireId ? -1 : a.hireId > b.hireId ? 1 : 0;
}

/** The first {@link CONTACTS_PER_HIRE_LIMIT} hires in the report's order. */
export function firstHires(rows: readonly HireRecordRow[]): HireRecordRow[] {
  return [...rows].sort(compareHires).slice(0, CONTACTS_PER_HIRE_LIMIT);
}

/** Why a hire has no contact count, or `null` when it has one. */
export function contactsReason(hire: HireRecordRow): ContactsPerHireReason | null {
  if (hire.postingKind !== "company_posting") return "agency_job";
  if (!hire.postingExists) return "posting_deleted";
  return null;
}

/**
 * THE CUT-OFF: the contacts the hire's company opened FOR THAT POSTING at or before the moment the
 * hire was confirmed, oldest first (then unlock id). Same company (the tenant key), same posting,
 * `granted <= confirmed` at microsecond precision.
 */
export function contactsBeforeHire(
  hire: HireRecordRow,
  contacts: readonly OpenedContactRow[],
): OpenedContactRow[] {
  return contacts
    .filter(
      (c) =>
        c.tenantPayerId === hire.tenantPayerId &&
        c.jobPostingId === hire.postingId &&
        c.grantedKey <= hire.confirmedKey,
    )
    .sort((a, b) =>
      a.grantedKey !== b.grantedKey
        ? a.grantedKey < b.grantedKey
          ? -1
          : 1
        : a.unlockId < b.unlockId
          ? -1
          : a.unlockId > b.unlockId
            ? 1
            : 0,
    );
}

/** One contact on the report. */
export interface ContactsPerHireContact {
  unlock_id: string;
  worker_id: string | null;
  /** When the company opened it (microsecond ISO-8601, UTC). */
  granted_at: string;
  /** The company's (or the desk's) answer about it, or null when none was given. */
  outcome: {
    outcome: UnlockOutcome;
    answered_by: UnlockOutcomeAnswerer;
    answered_at: Date;
  } | null;
}

/** One hire on the report. */
export interface ContactsPerHireHire {
  hire_id: string;
  /** The company's tenant key (`hires.tenant_payer_id`). */
  payer_id: string;
  posting_kind: "company_posting" | "agency_job";
  /** The company posting it was hired on; null for an agency job. */
  job_posting_id: string | null;
  worker_id: string;
  /** The first confirming source (microsecond ISO-8601, UTC). */
  confirmed_at: string;
  /** The contacts opened for the posting before the hire; null with a reason when none count. */
  contacts: ContactsPerHireContact[] | null;
  contacts_reason: ContactsPerHireReason | null;
}

export interface ContactsPerHireTotals {
  /** Hires on the report (at most 50). */
  hires_listed: number;
  /** Hires with a contact count (contacts not null): the mean's denominator. */
  hires_counted: number;
  /** Contacts opened before those hires: the mean's numerator. */
  contacts_opened: number;
  /** The mean as a fraction, never divided here: `denominator` 0 means no hire counts yet. */
  contacts_per_hire: { numerator: number; denominator: number };
}

/** The whole report, from the rows the service read. */
export function contactsPerHireReport(
  hireRows: readonly HireRecordRow[],
  contactRows: readonly OpenedContactRow[],
): { hires: ContactsPerHireHire[]; totals: ContactsPerHireTotals } {
  const hires = firstHires(hireRows).map((hire): ContactsPerHireHire => {
    const reason = contactsReason(hire);
    const contacts =
      reason === null
        ? contactsBeforeHire(hire, contactRows).map((c) => ({
            unlock_id: c.unlockId,
            worker_id: c.workerId,
            granted_at: c.grantedKey,
            outcome:
              c.outcome === null || c.answeredBy === null || c.answeredAt === null
                ? null
                : { outcome: c.outcome, answered_by: c.answeredBy, answered_at: c.answeredAt },
          }))
        : null;
    return {
      hire_id: hire.hireId,
      payer_id: hire.tenantPayerId,
      posting_kind: hire.postingKind,
      job_posting_id: hire.postingKind === "company_posting" ? hire.postingId : null,
      worker_id: hire.workerId,
      confirmed_at: hire.confirmedKey,
      contacts,
      contacts_reason: reason,
    };
  });
  const counted = hires.filter((h) => h.contacts !== null);
  const opened = counted.reduce((n, h) => n + (h.contacts?.length ?? 0), 0);
  return {
    hires,
    totals: {
      hires_listed: hires.length,
      hires_counted: counted.length,
      contacts_opened: opened,
      contacts_per_hire: { numerator: opened, denominator: counted.length },
    },
  };
}
