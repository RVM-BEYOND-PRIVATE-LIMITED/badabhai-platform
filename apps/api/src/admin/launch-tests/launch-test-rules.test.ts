import { describe, expect, it } from "vitest";
import { workforceUuid } from "@badabhai/db";
// A TEST may import it (BC-8 scans non-test files): the drift check of REAL_PAYMENT_PROVIDER.
import { RAZORPAY_PROVIDER } from "../../unlocks/unlocks.repository";
import {
  CONTACTS_PER_HIRE_LIMIT,
  REAL_PAYMENT_PROVIDER,
  autoLinkedPayer,
  changedFields,
  cohortIdForKey,
  compareHires,
  contactsBeforeHire,
  contactsPerHireReport,
  contactsReason,
  exceedsShareLimit,
  firstHires,
  mergeFactoryPatch,
  paymentOrderRefusal,
  portalRefusal,
  refusalBeforePool,
  refusedWorkers,
  sameCreate,
  stateFingerprint,
  stateRefusal,
  type FactoryState,
  type HireRecordRow,
  type OpenedContactRow,
} from "./launch-test-rules";

/**
 * #2755 part D — every rule of the two launch-test records, one at a time. The DB gate
 * (`admin-launch-tests.db.test.ts`) ties the SQL halves to these.
 */

const W = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const ADMIN = "33333333-3333-4333-8333-333333333333";

describe("Test A — which workers may be sent", () => {
  const ok = { workerId: W(1), exists: true, testWorker: false, linkedRvmIdentity: false };

  it("a real worker passes every rule but the pool (the pool is asked next)", () => {
    expect(refusalBeforePool(ok)).toBeNull();
  });

  it("names the FIRST rule that holds, in precedence order", () => {
    expect(refusalBeforePool({ ...ok, exists: false })).toBe("not_found");
    // A seeded sample id is a sample worker whatever its row says.
    const sample = workforceUuid("worker", 7);
    expect(refusalBeforePool({ ...ok, workerId: sample })).toBe("sample_worker");
    expect(refusalBeforePool({ ...ok, workerId: sample, testWorker: true })).toBe("sample_worker");
    expect(refusalBeforePool({ ...ok, testWorker: true, linkedRvmIdentity: true })).toBe(
      "test_worker",
    );
    expect(refusalBeforePool({ ...ok, linkedRvmIdentity: true })).toBe("linked_rvm_identity");
    // Missing beats everything: there is no row to read the other rules from.
    expect(refusalBeforePool({ ...ok, exists: false, testWorker: true })).toBe("not_found");
  });

  it("the refused list keeps the request's order and names each offender once", () => {
    const answers = new Map([
      [W(1), null],
      [W(2), "not_in_search_pool" as const],
      [W(3), null],
      [W(4), "test_worker" as const],
    ]);
    expect(refusedWorkers([W(4), W(1), W(2), W(3)], answers)).toEqual([
      { worker_id: W(4), reason: "test_worker" },
      { worker_id: W(2), reason: "not_in_search_pool" },
    ]);
    expect(refusedWorkers([W(1), W(3)], answers)).toEqual([]);
  });

  it("a requested worker with no answer is a defect, never silently passed", () => {
    expect(() => refusedWorkers([W(9)], new Map())).toThrow(/no eligibility answer/);
  });

  it("at most five shares per factory", () => {
    expect(exceedsShareLimit(0, 5)).toBe(false);
    expect(exceedsShareLimit(0, 6)).toBe(true);
    expect(exceedsShareLimit(3, 2)).toBe(false);
    expect(exceedsShareLimit(3, 3)).toBe(true);
    expect(exceedsShareLimit(5, 1)).toBe(true);
    expect(exceedsShareLimit(5, 0)).toBe(false);
  });
});

describe("Test A — outside the portal", () => {
  it("a Campus company holding the phone refuses the factory", () => {
    expect(
      portalRefusal(
        [
          { payerId: P1, campusCompany: false },
          { payerId: P2, campusCompany: true },
        ],
        false,
      ),
    ).toBe("campus_company");
  });

  it("the #2754 import ledger hook refuses when it holds the phone", () => {
    expect(portalRefusal([], true)).toBe("portal_import");
    // Campus is named first when both hold.
    expect(portalRefusal([{ payerId: P1, campusCompany: true }], true)).toBe("campus_company");
  });

  it("an ordinary BadaBhai company, or none, is outside the portal", () => {
    expect(portalRefusal([{ payerId: P1, campusCompany: false }], false)).toBeNull();
    expect(portalRefusal([], false)).toBeNull();
  });

  it("links the ONE ordinary company holding the phone, and none when several or none do", () => {
    expect(autoLinkedPayer([{ payerId: P1, campusCompany: false }])).toBe(P1);
    expect(
      autoLinkedPayer([
        { payerId: P1, campusCompany: false },
        { payerId: P1, campusCompany: false },
      ]),
    ).toBe(P1);
    expect(
      autoLinkedPayer([
        { payerId: P1, campusCompany: false },
        { payerId: P2, campusCompany: false },
      ]),
    ).toBeNull();
    expect(autoLinkedPayer([])).toBeNull();
  });
});

describe("Test A — the idempotent create", () => {
  it("one admin and one key name one row id: stable, uuid-shaped, scoped by admin", () => {
    const a = cohortIdForKey(ADMIN, "key-00000001");
    expect(a).toBe(cohortIdForKey(ADMIN, "key-00000001"));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(cohortIdForKey(ADMIN, "key-00000002")).not.toBe(a);
    expect(cohortIdForKey(P1, "key-00000001")).not.toBe(a);
  });

  it("a replay is the same create when phone, groups, time and the worker SET agree", () => {
    const base = {
      phoneHash: "h1",
      cityGroup: "ncr",
      tradeGroup: "cnc_operator",
      sentAtMs: 1_000,
      workerIds: [W(1), W(2)],
    };
    expect(sameCreate(base, { ...base, workerIds: [W(2), W(1)] })).toBe(true);
    expect(sameCreate(base, { ...base, phoneHash: null })).toBe(false);
    expect(sameCreate(base, { ...base, cityGroup: "pune" })).toBe(false);
    expect(sameCreate(base, { ...base, tradeGroup: "other" })).toBe(false);
    expect(sameCreate(base, { ...base, sentAtMs: 1_001 })).toBe(false);
    expect(sameCreate(base, { ...base, workerIds: [W(1)] })).toBe(false);
    expect(sameCreate(base, { ...base, workerIds: [W(1), W(3)] })).toBe(false);
  });
});

describe("Test A — the edit", () => {
  const T1 = new Date("2026-12-01T10:00:00.000Z");
  const T2 = new Date("2026-12-03T10:00:00.000Z");
  const pending: FactoryState = {
    paymentLinkRef: null,
    linkCreatedAt: null,
    result: "pending",
    paidAt: null,
    payerId: null,
    paymentOrderId: null,
  };

  it("absent leaves a field, null clears it, a value sets it", () => {
    const withLink = mergeFactoryPatch(pending, { paymentLinkRef: "plink_1", linkCreatedAt: T1 });
    expect(withLink).toMatchObject({
      paymentLinkRef: "plink_1",
      linkCreatedAt: T1,
      result: "pending",
    });
    expect(mergeFactoryPatch(withLink, { result: "declined" })).toMatchObject({
      paymentLinkRef: "plink_1",
      result: "declined",
    });
    expect(mergeFactoryPatch(withLink, { linkCreatedAt: null })).toMatchObject({
      paymentLinkRef: "plink_1",
      linkCreatedAt: null,
    });
  });

  it("THE paid_at CHECK, mirrored: set exactly when the result is paid", () => {
    expect(stateRefusal(pending)).toBeNull();
    expect(stateRefusal({ ...pending, result: "paid" })).toBe("paid_at_mismatch");
    expect(stateRefusal({ ...pending, paidAt: T1 })).toBe("paid_at_mismatch");
    expect(stateRefusal({ ...pending, result: "declined", paidAt: T1 })).toBe("paid_at_mismatch");
    expect(stateRefusal({ ...pending, result: "paid", paidAt: T1 })).toBeNull();
    for (const result of ["pending", "declined", "no_response"] as const) {
      expect(stateRefusal({ ...pending, result }), result).toBeNull();
    }
  });

  it("a link's creation time needs the link (the link CHECK, mirrored)", () => {
    expect(stateRefusal({ ...pending, linkCreatedAt: T1 })).toBe("link_created_without_ref");
    expect(stateRefusal({ ...pending, paymentLinkRef: "plink_1" })).toBeNull();
  });

  it("a paid order needs an account and a paid result", () => {
    const paid = { ...pending, result: "paid" as const, paidAt: T2 };
    expect(stateRefusal({ ...paid, paymentOrderId: P2 })).toBe("payment_order_without_payer");
    expect(stateRefusal({ ...pending, payerId: P1, paymentOrderId: P2 })).toBe(
      "payment_order_needs_paid_result",
    );
    expect(stateRefusal({ ...paid, payerId: P1, paymentOrderId: P2 })).toBeNull();
  });

  it("names exactly the parts that changed, instants compared by value", () => {
    const linked = { ...pending, paymentLinkRef: "plink_1", linkCreatedAt: T1 };
    expect(changedFields(linked, { ...linked, linkCreatedAt: new Date(T1.getTime()) })).toEqual([]);
    expect(changedFields(pending, linked)).toEqual(["payment_link"]);
    expect(
      changedFields(linked, {
        ...linked,
        result: "paid",
        paidAt: T2,
        payerId: P1,
        paymentOrderId: P2,
      }),
    ).toEqual(["result", "payer", "payment_order"]);
    expect(
      changedFields(
        { ...linked, result: "paid", paidAt: T1 },
        { ...linked, result: "paid", paidAt: T2 },
      ),
    ).toEqual(["result"]);
  });

  it("the state fingerprint is stable and moves with any part", () => {
    expect(stateFingerprint(pending)).toBe(stateFingerprint({ ...pending }));
    expect(stateFingerprint(pending)).toMatch(/^[0-9a-f]{16}$/);
    expect(stateFingerprint({ ...pending, result: "declined" })).not.toBe(
      stateFingerprint(pending),
    );
  });

  it("THE PAID-ORDER CHECK: a real Razorpay order, paid, of the factory's own account", () => {
    // The real provider is the unlock path's own constant, held equal here.
    expect(REAL_PAYMENT_PROVIDER).toBe(RAZORPAY_PROVIDER);
    const order = { payerId: P1, status: "paid", provider: "razorpay" };
    expect(paymentOrderRefusal(order, P1, "razorpay")).toBeNull();
    expect(paymentOrderRefusal(undefined, P1, "razorpay")).toBe("payment_order_not_found");
    // Never a mock or seed row: any provider but the real one is refused before anything else.
    expect(paymentOrderRefusal({ ...order, provider: "mock" }, P1, "razorpay")).toBe(
      "payment_order_not_real",
    );
    expect(paymentOrderRefusal({ ...order, status: "created" }, P1, "razorpay")).toBe(
      "payment_order_not_paid",
    );
    expect(paymentOrderRefusal({ ...order, status: "failed" }, P1, "razorpay")).toBe(
      "payment_order_not_paid",
    );
    expect(paymentOrderRefusal(order, P2, "razorpay")).toBe("payment_order_other_payer");
  });
});

describe("Test B — contacts per hire", () => {
  const hire = (n: number, over: Partial<HireRecordRow> = {}): HireRecordRow => ({
    hireId: W(100 + n),
    tenantPayerId: P1,
    workerId: W(200 + n),
    postingKind: "company_posting",
    postingId: W(300),
    postingExists: true,
    confirmedKey: "2026-12-10T10:00:00.000000Z",
    ...over,
  });
  const contact = (n: number, over: Partial<OpenedContactRow> = {}): OpenedContactRow => ({
    unlockId: W(400 + n),
    tenantPayerId: P1,
    jobPostingId: W(300),
    workerId: W(500 + n),
    grantedKey: "2026-12-05T10:00:00.000000Z",
    outcome: null,
    answeredBy: null,
    answeredAt: null,
    ...over,
  });

  it("orders by the confirmation time at MICROSECOND precision, then the hire id", () => {
    const a = hire(1, { confirmedKey: "2026-12-10T10:00:00.000002Z" });
    const b = hire(2, { confirmedKey: "2026-12-10T10:00:00.000001Z" });
    const c = hire(0, { confirmedKey: "2026-12-10T10:00:00.000002Z" });
    expect(firstHires([a, b, c]).map((h) => h.hireId)).toEqual([b.hireId, c.hireId, a.hireId]);
    expect(compareHires(a, a)).toBe(0);
  });

  it("lists at most the first 50", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      hire(i, { confirmedKey: `2026-12-10T10:00:${String(59 - i).padStart(2, "0")}.000000Z` }),
    );
    const first = firstHires(many);
    expect(CONTACTS_PER_HIRE_LIMIT).toBe(50);
    expect(first).toHaveLength(50);
    // The latest ten confirmations are the ones left out.
    expect(first[0]!.hireId).toBe(hire(59).hireId);
    expect(first.map((h) => h.hireId)).not.toContain(hire(0).hireId);
  });

  it("THE CUT-OFF: granted at or before the confirmation, same company, same posting", () => {
    const h = hire(1);
    const before = contact(1, { grantedKey: "2026-12-10T09:59:59.999999Z" });
    const atTheMoment = contact(2, { grantedKey: "2026-12-10T10:00:00.000000Z" });
    const afterByOneMicro = contact(3, { grantedKey: "2026-12-10T10:00:00.000001Z" });
    const otherPosting = contact(4, { jobPostingId: W(301) });
    const otherCompany = contact(5, { tenantPayerId: P2 });
    expect(
      contactsBeforeHire(h, [afterByOneMicro, otherPosting, atTheMoment, otherCompany, before]).map(
        (c) => c.unlockId,
      ),
    ).toEqual([before.unlockId, atTheMoment.unlockId]);
  });

  it("an agency job or a deleted posting has no count, with its reason", () => {
    expect(contactsReason(hire(1))).toBeNull();
    expect(contactsReason(hire(1, { postingKind: "agency_job" }))).toBe("agency_job");
    expect(contactsReason(hire(1, { postingExists: false }))).toBe("posting_deleted");
  });

  it("the report: ids only, each contact's outcome or null, and the mean as a fraction", () => {
    const answered = new Date("2026-12-20T00:00:00.000Z");
    const h1 = hire(1);
    const h2 = hire(2, {
      postingId: W(310),
      confirmedKey: "2026-12-11T10:00:00.000000Z",
    });
    const h3 = hire(3, { postingKind: "agency_job", confirmedKey: "2026-12-12T10:00:00.000000Z" });
    const report = contactsPerHireReport(
      [h3, h2, h1],
      [
        contact(1, { outcome: "hired", answeredBy: "company", answeredAt: answered }),
        contact(2, { workerId: null }),
        contact(3, { jobPostingId: W(310) }),
      ],
    );
    expect(report.hires.map((h) => h.hire_id)).toEqual([h1.hireId, h2.hireId, h3.hireId]);
    expect(report.hires[0]).toEqual({
      hire_id: h1.hireId,
      payer_id: P1,
      posting_kind: "company_posting",
      job_posting_id: W(300),
      worker_id: h1.workerId,
      confirmed_at: h1.confirmedKey,
      contacts: [
        {
          unlock_id: W(401),
          worker_id: W(501),
          granted_at: "2026-12-05T10:00:00.000000Z",
          outcome: { outcome: "hired", answered_by: "company", answered_at: answered },
        },
        {
          unlock_id: W(402),
          worker_id: null,
          granted_at: "2026-12-05T10:00:00.000000Z",
          outcome: null,
        },
      ],
      contacts_reason: null,
    });
    expect(report.hires[1]!.contacts).toHaveLength(1);
    expect(report.hires[2]).toMatchObject({
      posting_kind: "agency_job",
      job_posting_id: null,
      contacts: null,
      contacts_reason: "agency_job",
    });
    expect(report.totals).toEqual({
      hires_listed: 3,
      hires_counted: 2,
      contacts_opened: 3,
      contacts_per_hire: { numerator: 3, denominator: 2 },
    });
  });

  it("no hire yet: an empty report with a zero denominator, never a made-up mean", () => {
    expect(contactsPerHireReport([], [])).toEqual({
      hires: [],
      totals: {
        hires_listed: 0,
        hires_counted: 0,
        contacts_opened: 0,
        contacts_per_hire: { numerator: 0, denominator: 0 },
      },
    });
  });
});
