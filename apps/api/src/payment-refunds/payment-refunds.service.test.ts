import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { PaymentOrder, PaymentRefundRow } from "@badabhai/db";
import { DEFAULT_CREDIT_RULES } from "@badabhai/pricing";
import {
  PaymentRefundsService,
  checkRefundRules,
  orderTotalPaise,
  statusFromProvider,
} from "./payment-refunds.service";
import type { OrderPackLot } from "./payment-refunds.repository";

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORDER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PAYER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LOT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RETURNED_LOT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const REFUND = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const JOB = "12121212-1212-4212-8212-121212121212";
const CTX = { correlationId: "11111111-1111-4111-8111-111111111111", requestId: "req-1" };
const REASON = "Company bought the wrong pack by mistake";
const FAKE_TX = { tx: true };
const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

const order = (over: Partial<PaymentOrder> = {}): PaymentOrder =>
  ({
    id: ORDER,
    payerId: PAYER,
    productKind: "credit_pack",
    packCode: "pack_20",
    amountInr: 1179,
    creditsGranted: 20,
    provider: "razorpay",
    providerOrderId: "order_1",
    status: "paid",
    providerPaymentRef: "pay_1",
    totalPaise: 117900,
    originJobPostingId: null,
    ...over,
  }) as PaymentOrder;

const lot = (over: Partial<OrderPackLot> = {}): OrderPackLot => ({
  id: LOT,
  creditsGranted: 20,
  creditsRemaining: 20,
  expiredAt: null,
  createdAt: new Date(NOW - 2 * DAY),
  ...over,
});

const refundRow = (over: Partial<PaymentRefundRow> = {}): PaymentRefundRow =>
  ({
    id: REFUND,
    paymentOrderId: ORDER,
    payerId: PAYER,
    rule: "unused",
    jobPostingId: null,
    applicantsCounted: null,
    requestedBy: ADMIN,
    amountPaise: 117900,
    creditsRemoved: 23,
    status: "requested",
    providerRefundId: null,
    failureCode: null,
    creditNoteNumber: null,
    requestedAt: new Date(NOW),
    processedAt: null,
    updatedAt: new Date(NOW),
    ...over,
  }) as PaymentRefundRow;

function make(opts: { creditNotes?: boolean; live?: boolean } = {}) {
  const repo = {
    reader: {},
    withTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(FAKE_TX)),
    getOrder: vi.fn(async () => order()),
    lockOrder: vi.fn(async () => order()),
    findPackLot: vi.fn(async () => lot()),
    returnedLotIds: vi.fn(async () => [RETURNED_LOT]),
    postingOwnedBy: vi.fn(async () => true),
    countApplicants: vi.fn(async () => 1),
    removeLot: vi.fn(async (_tx: unknown, _wallet: string, lotId: string) =>
      lotId === LOT ? 20 : 3,
    ),
    insertRefund: vi.fn(async (_tx: unknown, v: Record<string, unknown>) => refundRow(v as never)),
    findByOrder: vi.fn(async () => undefined as PaymentRefundRow | undefined),
    getRefund: vi.fn(async () => refundRow() as PaymentRefundRow | undefined),
    findByProviderRefundId: vi.fn(async () => undefined as PaymentRefundRow | undefined),
    transition: vi.fn(
      async (_tx: unknown, _id: string, _from: unknown, to: string, patch: Record<string, unknown>) =>
        refundRow({
          status: to as never,
          providerRefundId: (patch.providerRefundId as string | undefined) ?? null,
          failureCode: to === "failed" ? ((patch.failureCode as never) ?? "provider_error") : null,
          processedAt: to === "processed" ? new Date() : null,
        }) as PaymentRefundRow | undefined,
    ),
    audit: vi.fn(async () => undefined),
  };
  const creditRules = { get: vi.fn(async () => ({ ...DEFAULT_CREDIT_RULES })) };
  const razorpay = {
    isLive: opts.live ?? true,
    findRefundForRow: vi.fn(async () => null as { id: string; status: string; amountPaise: number } | null),
    refundPayment: vi.fn(async () => ({ id: "rfnd_1", status: "pending", amountPaise: 117900 })),
  };
  const events = { emit: vi.fn(async (_params: unknown) => undefined) };
  const service = new PaymentRefundsService(
    repo as never,
    creditRules as never,
    razorpay as never,
    events as never,
    { available: opts.creditNotes ?? true },
  );
  return { service, repo, creditRules, razorpay, events };
}

const emitted = (events: { emit: { mock: { calls: unknown[][] } } }) =>
  events.emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name);

describe("refunds stay off until credit notes exist (owner ruling 2026-11-18)", () => {
  it.each([
    ["eligibility", (s: PaymentRefundsService) => s.eligibility(ORDER)],
    ["refund", (s: PaymentRefundsService) => s.refund(ADMIN, ORDER, { rule: "unused", reason_text: REASON }, CTX)],
    ["get", (s: PaymentRefundsService) => s.get(REFUND)],
    ["retry", (s: PaymentRefundsService) => s.retry(ADMIN, REFUND, REASON, CTX)],
  ])("%s answers 503 CREDIT_NOTES_UNAVAILABLE and reads nothing", async (_name, call) => {
    const t = make({ creditNotes: false });
    await expect(call(t.service)).rejects.toMatchObject({
      response: { code: "CREDIT_NOTES_UNAVAILABLE" },
    });
    expect(t.repo.getOrder).not.toHaveBeenCalled();
    expect(t.repo.withTransaction).not.toHaveBeenCalled();
    expect(t.repo.getRefund).not.toHaveBeenCalled();
  });

  it("with credit notes but real payments off: 503", async () => {
    const t = make({ live: false });
    await expect(t.service.eligibility(ORDER)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe("checkRefundRules (brief 4C.12)", () => {
  const rules = DEFAULT_CREDIT_RULES;
  const at = (daysAfter: number) => new Date(NOW - 2 * DAY + daysAfter * DAY);

  it("rule 1: an unused pack within 7 days; not on day 8; never a used pack", () => {
    const facts = { lot: lot(), jobPostingId: null, applicants: null };
    expect(checkRefundRules(facts, rules, at(7)).unused).toMatchObject({ eligible: true });
    expect(checkRefundRules(facts, rules, at(7.01)).unused).toMatchObject({
      eligible: false,
      refusal: "window_passed",
    });
    const used = { ...facts, lot: lot({ creditsRemaining: 19 }) };
    expect(checkRefundRules(used, rules, at(1)).unused).toMatchObject({ refusal: "pack_used" });
    const expired = { ...facts, lot: lot({ expiredAt: new Date() }) };
    expect(checkRefundRules(expired, rules, at(1)).unused).toMatchObject({ refusal: "pack_used" });
  });

  it("rule 2: unused, within 30 days, fewer than 3 applicants to the job", () => {
    const two = { lot: lot(), jobPostingId: JOB, applicants: 2 };
    expect(checkRefundRules(two, rules, at(20)).low_match).toMatchObject({
      eligible: true,
      applicants: 2,
      needs_fewer_than: 3,
    });
    expect(checkRefundRules({ ...two, applicants: 3 }, rules, at(20)).low_match).toMatchObject({
      refusal: "too_many_applicants",
    });
    expect(
      checkRefundRules({ lot: lot(), jobPostingId: null, applicants: null }, rules, at(1)).low_match,
    ).toMatchObject({ refusal: "no_job" });
    expect(checkRefundRules(two, rules, at(31)).low_match).toMatchObject({
      refusal: "window_passed",
    });
  });

  it("the amount is the whole order total; a pre-0176 order is amount_inr × 100", () => {
    expect(orderTotalPaise(order())).toBe(117900);
    expect(orderTotalPaise(order({ totalPaise: null, amountInr: 999 }))).toBe(99900);
  });

  it("a provider status maps to ours; anything unknown is still pending", () => {
    expect(statusFromProvider({ status: "processed" })).toEqual({ status: "processed", failureCode: null });
    expect(statusFromProvider({ status: "failed" })).toEqual({
      status: "failed",
      failureCode: "provider_failed",
    });
    expect(statusFromProvider({ status: "weird" })).toEqual({ status: "pending", failureCode: null });
  });
});

describe("refund — credits first, money second", () => {
  it("removes the pack and the credits that came with it, writes the row, audit and event, then asks Razorpay", async () => {
    const t = make();
    const view = await t.service.refund(ADMIN, ORDER, { rule: "unused", reason_text: REASON }, CTX);
    expect(t.repo.lockOrder).toHaveBeenCalledWith(FAKE_TX, ORDER);
    expect(t.repo.removeLot).toHaveBeenCalledWith(FAKE_TX, PAYER, LOT);
    expect(t.repo.removeLot).toHaveBeenCalledWith(FAKE_TX, PAYER, RETURNED_LOT);
    expect(t.repo.returnedLotIds).toHaveBeenCalledWith(FAKE_TX, PAYER, "pay_1");
    expect(t.repo.insertRefund).toHaveBeenCalledWith(FAKE_TX, {
      paymentOrderId: ORDER,
      payerId: PAYER,
      rule: "unused",
      jobPostingId: null,
      applicantsCounted: null,
      requestedBy: ADMIN,
      amountPaise: 117900,
      creditsRemoved: 23,
    });
    expect(t.repo.audit).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({
        adminId: ADMIN,
        action: "payment_refund_requested",
        metadata: expect.objectContaining({ reason_text: REASON, credits_removed: 23 }),
      }),
    );
    // The provider is asked only after the transaction; a refund it already made is looked for first.
    expect(t.razorpay.findRefundForRow).toHaveBeenCalledWith("pay_1", REFUND);
    expect(t.razorpay.refundPayment).toHaveBeenCalledWith({
      paymentId: "pay_1",
      amountPaise: 117900,
      refundRowId: REFUND,
    });
    expect(emitted(t.events)).toEqual(["payment.refund_requested", "payment.refund_status_changed"]);
    expect(t.events.emit.mock.calls[0]![0]).toMatchObject({
      actor: { actor_type: "admin", actor_id: ADMIN },
      payload: { refund_id: REFUND, rule: "unused", amount_paise: 117900, credits_removed: 23 },
      tx: FAKE_TX,
    });
    expect(view).toMatchObject({ status: "pending", provider_refund_id: "rfnd_1" });
  });

  it("an order already refunded: 409 ALREADY_REFUNDED, nothing removed", async () => {
    const t = make();
    t.repo.findByOrder.mockResolvedValueOnce(refundRow());
    await expect(
      t.service.refund(ADMIN, ORDER, { rule: "unused", reason_text: REASON }, CTX),
    ).rejects.toMatchObject({ response: { code: "ALREADY_REFUNDED" } });
    expect(t.repo.removeLot).not.toHaveBeenCalled();
    expect(t.razorpay.refundPayment).not.toHaveBeenCalled();
  });

  it("a rule that does not hold: 409 REFUND_RULE_NOT_MET with the refusal, nothing removed", async () => {
    const t = make();
    t.repo.findPackLot.mockResolvedValueOnce(lot({ creditsRemaining: 5 }));
    await expect(
      t.service.refund(ADMIN, ORDER, { rule: "unused", reason_text: REASON }, CTX),
    ).rejects.toMatchObject({
      response: { code: "REFUND_RULE_NOT_MET", rule: "unused", refusal: "pack_used" },
    });
    expect(t.repo.removeLot).not.toHaveBeenCalled();
    expect(t.events.emit).not.toHaveBeenCalled();
  });

  it("rule 2 counts the order's own job, or the one the admin names; another company's job is a 404", async () => {
    const t = make();
    t.repo.lockOrder.mockResolvedValue(order({ originJobPostingId: JOB }));
    await t.service.refund(ADMIN, ORDER, { rule: "low_match", reason_text: REASON }, CTX);
    expect(t.repo.countApplicants).toHaveBeenCalledWith(FAKE_TX, JOB);
    expect(t.repo.insertRefund).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({ rule: "low_match", jobPostingId: JOB, applicantsCounted: 1 }),
    );

    const other = make();
    other.repo.postingOwnedBy.mockResolvedValue(false);
    await expect(
      other.service.refund(
        ADMIN,
        ORDER,
        { rule: "low_match", reason_text: REASON, job_posting_id: JOB },
        CTX,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("an order that is not a real paid pack (unpaid, or no payment ref): 404", async () => {
    const t = make();
    t.repo.lockOrder.mockResolvedValueOnce(order({ status: "created" }));
    await expect(
      t.service.refund(ADMIN, ORDER, { rule: "unused", reason_text: REASON }, CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("a provider error leaves the credits removed and the refund failed (provider_error)", async () => {
    const t = make();
    t.razorpay.refundPayment.mockRejectedValueOnce(new Error("payment provider refund failed"));
    const view = await t.service.refund(ADMIN, ORDER, { rule: "unused", reason_text: REASON }, CTX);
    expect(view).toMatchObject({ status: "failed", failure_code: "provider_error" });
    expect(t.repo.transition).toHaveBeenCalledWith(
      FAKE_TX,
      REFUND,
      ["requested", "pending"],
      "failed",
      { failureCode: "provider_error" },
    );
  });

  it("a refund Razorpay already made for this row is adopted, never made twice", async () => {
    const t = make();
    t.razorpay.findRefundForRow.mockResolvedValueOnce({
      id: "rfnd_9",
      status: "processed",
      amountPaise: 117900,
    });
    const view = await t.service.refund(ADMIN, ORDER, { rule: "unused", reason_text: REASON }, CTX);
    expect(t.razorpay.refundPayment).not.toHaveBeenCalled();
    expect(view).toMatchObject({ status: "processed", provider_refund_id: "rfnd_9" });
  });
});

describe("retry", () => {
  it("a failed refund is sent again and audited", async () => {
    const t = make();
    t.repo.getRefund.mockResolvedValueOnce(refundRow({ status: "failed", failureCode: "provider_error" }));
    await t.service.retry(ADMIN, REFUND, REASON, CTX);
    expect(t.repo.audit).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({ action: "payment_refund_retried" }),
    );
    expect(t.razorpay.refundPayment).toHaveBeenCalled();
  });

  it.each([
    ["processed", refundRow({ status: "processed", processedAt: new Date() })],
    ["pending", refundRow({ status: "pending", providerRefundId: "rfnd_1" })],
    ["a fresh requested", refundRow({ status: "requested" })],
  ])("%s is not retried (409)", async (_name, row) => {
    const t = make();
    t.repo.getRefund.mockResolvedValueOnce(row);
    await expect(t.service.retry(ADMIN, REFUND, REASON, CTX)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(t.razorpay.refundPayment).not.toHaveBeenCalled();
  });

  it("a requested refund older than ten minutes lost its provider call: it is retried", async () => {
    const t = make();
    t.repo.getRefund.mockResolvedValueOnce(
      refundRow({ status: "requested", requestedAt: new Date(NOW - 11 * 60 * 1000) }),
    );
    await t.service.retry(ADMIN, REFUND, REASON, CTX);
    expect(t.razorpay.findRefundForRow).toHaveBeenCalled();
  });
});

describe("the refund webhook", () => {
  const event = (eventName: string, over: Record<string, unknown> = {}) => ({
    eventName,
    refundId: "rfnd_1",
    status: null,
    notesRefundRowId: null,
    ...over,
  });

  it("refund.processed moves the refund it names to processed, with one event", async () => {
    const t = make();
    t.repo.findByProviderRefundId.mockResolvedValueOnce(refundRow({ status: "pending" }));
    await expect(t.service.handleProviderRefundEvent(event("refund.processed"))).resolves.toBe(
      "updated",
    );
    expect(t.repo.transition).toHaveBeenCalledWith(
      FAKE_TX,
      REFUND,
      ["requested", "pending", "failed"],
      "processed",
      { providerRefundId: "rfnd_1", failureCode: null },
    );
    expect(emitted(t.events)).toEqual(["payment.refund_status_changed"]);
  });

  it("a refund whose answer we lost is found by our row id in its notes", async () => {
    const t = make();
    await t.service.handleProviderRefundEvent(
      event("refund.failed", { notesRefundRowId: REFUND }),
    );
    expect(t.repo.getRefund).toHaveBeenCalledWith(REFUND);
    expect(t.repo.transition).toHaveBeenCalledWith(
      FAKE_TX,
      REFUND,
      ["requested", "pending"],
      "failed",
      { providerRefundId: "rfnd_1", failureCode: "provider_failed" },
    );
  });

  it("a refund this code did not make (the dashboard's) is acknowledged and ignored", async () => {
    const t = make();
    t.repo.getRefund.mockResolvedValueOnce(undefined);
    await expect(t.service.handleProviderRefundEvent(event("refund.processed"))).resolves.toBe(
      "no_op",
    );
    expect(t.repo.transition).not.toHaveBeenCalled();
  });

  it("a move the status does not allow (a replay) writes no event", async () => {
    const t = make();
    t.repo.findByProviderRefundId.mockResolvedValueOnce(refundRow({ status: "processed" }));
    t.repo.transition.mockResolvedValueOnce(undefined);
    await expect(t.service.handleProviderRefundEvent(event("refund.processed"))).resolves.toBe(
      "no_op",
    );
    expect(t.events.emit).not.toHaveBeenCalled();
  });

  it("the table missing (migration not applied): logged and acknowledged", async () => {
    const t = make();
    t.repo.findByProviderRefundId.mockRejectedValueOnce(
      Object.assign(new Error("relation does not exist"), { code: "42P01" }),
    );
    await expect(t.service.handleProviderRefundEvent(event("refund.processed"))).resolves.toBe(
      "no_op",
    );
  });

  it("before credit notes exist no refund of ours can exist: acknowledged without a read", async () => {
    const t = make({ creditNotes: false });
    await expect(t.service.handleProviderRefundEvent(event("refund.processed"))).resolves.toBe(
      "no_op",
    );
    expect(t.repo.findByProviderRefundId).not.toHaveBeenCalled();
  });

  it("an event it does not know is ignored", async () => {
    const t = make();
    await expect(t.service.handleProviderRefundEvent(event("refund.speed_changed"))).resolves.toBe(
      "no_op",
    );
  });
});
