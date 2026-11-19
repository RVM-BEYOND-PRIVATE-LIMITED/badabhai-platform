import { describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import type { EventsService } from "../events/events.service";
import type { FetchedPayment, RazorpayClient } from "../unlocks/razorpay.client";
import type {
  RazorpayReconcileRepository,
  ReconcileOrder,
  ReconcileOrdersSnapshot,
} from "./razorpay-reconcile.repository";
import {
  RECONCILE_LOG_IDS_PER_CLASS,
  RECONCILE_MAX_FETCHES,
  RECONCILE_MAX_PAGES,
  RazorpayReconcileService,
  paymentIdsToFetch,
  reconcile,
  reconcileAlertKey,
  reconcileWindow,
} from "./razorpay-reconcile.service";

/**
 * #2773 — the nightly Razorpay reconciliation: the comparison's three findings (and the unknown
 * order), what is NOT a finding, the window, the test-key skip, and the once-a-day alert.
 */

const NOW = new Date("2026-11-19T21:30:00.000Z");
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const pay = (n: number, over: Partial<FetchedPayment> = {}): FetchedPayment => ({
  id: `pay_${n}`,
  orderId: `order_${n}`,
  amountPaise: 117_900,
  currency: "INR",
  status: "captured",
  ...over,
});

const order = (n: number, over: Partial<ReconcileOrder> = {}): ReconcileOrder => ({
  orderId: uuid(n),
  providerOrderId: `order_${n}`,
  status: "paid",
  providerPaymentRef: `pay_${n}`,
  expectedPaise: 117_900,
  refundRecorded: false,
  ...over,
});

const snap = (
  byProviderOrderId: ReconcileOrder[],
  paidInWindow: ReconcileOrder[] = byProviderOrderId.filter((o) => o.status === "paid"),
): ReconcileOrdersSnapshot => ({ byProviderOrderId, paidInWindow });

const NONE = new Map<string, FetchedPayment | null>();

describe("reconcile — the comparison", () => {
  it("a captured payment settling its own paid order for the right amount is clean", () => {
    const s = reconcile({ listed: [pay(1)], orders: snap([order(1)]), fetched: NONE });
    expect(s).toEqual({ paymentsChecked: 1, ordersChecked: 1, findings: [], unverified: 0 });
  });

  it("(a) captured, but our order is created, failed or held: the company got nothing", () => {
    const s = reconcile({
      listed: [pay(1), pay(2), pay(3)],
      orders: snap([
        order(1, { status: "created", providerPaymentRef: null }),
        order(2, { status: "failed", providerPaymentRef: null }),
        order(3, { status: "held" }),
      ]),
      fetched: NONE,
    });
    expect(s.findings).toEqual([
      {
        kind: "captured_not_paid",
        orderId: uuid(1),
        providerOrderId: "order_1",
        paymentId: "pay_1",
        reason: "order_created",
      },
      {
        kind: "captured_not_paid",
        orderId: uuid(2),
        providerOrderId: "order_2",
        paymentId: "pay_2",
        reason: "order_failed",
      },
      {
        kind: "captured_not_paid",
        orderId: uuid(3),
        providerOrderId: "order_3",
        paymentId: "pay_3",
        reason: "order_held",
      },
    ]);
  });

  it("(a) a second captured payment on an order already paid by another is a double charge", () => {
    const second = pay(9, { orderId: "order_1" });
    const s = reconcile({ listed: [pay(1), second], orders: snap([order(1)]), fetched: NONE });
    expect(s.findings).toEqual([
      {
        kind: "captured_not_paid",
        orderId: uuid(1),
        providerOrderId: "order_1",
        paymentId: "pay_9",
        reason: "order_paid_by_other_payment",
      },
    ]);
  });

  it("(b) a paid order whose payment Razorpay shows failed, authorized or refunded without our refund", () => {
    const listed = [
      pay(1, { status: "failed" }),
      pay(2, { status: "authorized" }),
      pay(3, { status: "refunded" }),
    ];
    const s = reconcile({ listed, orders: snap([order(1), order(2), order(3)]), fetched: NONE });
    expect(s.findings.map((f) => [f.kind, f.orderId, f.paymentId, f.reason])).toEqual([
      ["paid_not_captured", uuid(1), "pay_1", "payment_failed"],
      ["paid_not_captured", uuid(2), "pay_2", "payment_authorized"],
      ["paid_not_captured", uuid(3), "pay_3", "payment_refunded"],
    ]);
    expect(s.paymentsChecked).toBe(0);
  });

  it("(b) a paid order with no payment ref, a payment on another order, or a read that failed", () => {
    const s = reconcile({
      listed: [pay(2, { orderId: "order_99" })],
      orders: snap([order(1, { providerPaymentRef: null }), order(2), order(3)]),
      fetched: new Map([["pay_3", null]]),
    });
    expect(s.findings.map((f) => [f.kind, f.orderId, f.reason])).toEqual([
      // pay_2 is captured on a Razorpay order we have no row for: side one reports that too.
      ["captured_unknown_order", null, "no_order"],
      ["paid_not_captured", uuid(1), "no_payment_ref"],
      ["paid_not_captured", uuid(2), "payment_on_other_order"],
      ["paid_not_captured", uuid(3), "payment_fetch_failed"],
    ]);
  });

  it("NOT (b): a paid order refunded by our own refund path", () => {
    const s = reconcile({
      listed: [pay(1, { status: "refunded" })],
      orders: snap([order(1, { refundRecorded: true })]),
      fetched: NONE,
    });
    expect(s.findings).toEqual([]);
  });

  it("NOT (b): a paid order whose payment fell outside the list, read one by one and captured", () => {
    const s = reconcile({
      listed: [],
      orders: snap([order(1)]),
      fetched: new Map([["pay_1", pay(1)]]),
    });
    expect(s.findings).toEqual([]);
    expect(s.ordersChecked).toBe(1);
  });

  it("(c) the captured amount or currency differs, from the list or read one by one", () => {
    const s = reconcile({
      listed: [pay(1, { amountPaise: 99_900 }), pay(2, { currency: "USD" })],
      orders: snap([order(1), order(2), order(3)]),
      fetched: new Map([["pay_3", pay(3, { amountPaise: 117_800 })]]),
    });
    expect(s.findings.map((f) => [f.kind, f.orderId, f.paymentId, f.reason])).toEqual([
      ["amount_mismatch", uuid(1), "pay_1", "captured_99900_expected_117900"],
      ["amount_mismatch", uuid(2), "pay_2", "currency_not_inr"],
      ["amount_mismatch", uuid(3), "pay_3", "captured_117800_expected_117900"],
    ]);
  });

  it("an old paid order outside the window is still checked when its payment is in it", () => {
    // Created 49 hours ago (not in paidInWindow), captured in the window for the wrong amount.
    const s = reconcile({
      listed: [pay(1, { amountPaise: 1 })],
      orders: snap([order(1)], []),
      fetched: NONE,
    });
    expect(s.findings.map((f) => f.kind)).toEqual(["amount_mismatch"]);
  });

  it("a captured payment with no Razorpay order is not ours and is not compared", () => {
    const s = reconcile({ listed: [pay(1, { orderId: null })], orders: snap([]), fetched: NONE });
    expect(s.findings).toEqual([]);
  });

  it("a paid order whose payment was not read (beyond the fetch cap) is unverified, not a finding", () => {
    const s = reconcile({ listed: [], orders: snap([order(1)]), fetched: NONE });
    expect(s.findings).toEqual([]);
    expect(s.unverified).toBe(1);
  });
});

describe("paymentIdsToFetch", () => {
  it("names the paid orders' payments the list does not hold, once each", () => {
    // Listed payments are compared from the list whatever their status; only pay_4 is missing.
    const listed = [pay(1), pay(2, { status: "refunded" }), pay(3, { orderId: "order_x" })];
    const paid = [
      order(1),
      order(2),
      order(3),
      order(4),
      order(6, { providerPaymentRef: "pay_4" }),
      order(5, { providerPaymentRef: null }),
    ];
    expect(paymentIdsToFetch(listed, paid)).toEqual(["pay_4"]);
  });
});

describe("reconcileWindow", () => {
  it("is the last 48 hours, less the newest half hour", () => {
    const { from, to } = reconcileWindow(NOW);
    expect(from.toISOString()).toBe("2026-11-17T21:30:00.000Z");
    expect(to.toISOString()).toBe("2026-11-19T21:00:00.000Z");
  });
});

// ── the service: switch, test keys, provider calls, the alert ────────────────

function setup(opts: {
  enabled?: boolean;
  keyId?: string;
  isLive?: boolean;
  listed?: FetchedPayment[];
  truncated?: boolean;
  orders?: ReconcileOrdersSnapshot;
  fetchPayment?: (id: string) => Promise<FetchedPayment>;
  written?: boolean;
}) {
  const listPayments = vi.fn(async () => ({
    payments: opts.listed ?? [],
    truncated: opts.truncated ?? false,
  }));
  const fetchPayment = vi.fn(opts.fetchPayment ?? (async (id: string) => pay(Number(id.slice(4)))));
  const read = vi.fn(async () => opts.orders ?? snap([]));
  const emitOnce = vi.fn(async () => ({ event: {} as never, written: opts.written ?? true }));
  const service = new RazorpayReconcileService(
    { read } as unknown as RazorpayReconcileRepository,
    { isLive: opts.isLive ?? true, listPayments, fetchPayment } as unknown as RazorpayClient,
    { emitOnce } as unknown as EventsService,
    {
      RAZORPAY_RECONCILE_ENABLED: opts.enabled ?? true,
      PAYMENTS_PROVIDER_KEY: opts.keyId ?? "rzp_live_abc",
    } as ServerConfig,
  );
  const logger = (service as unknown as { logger: Record<string, (m: string) => void> }).logger;
  const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  vi.spyOn(logger, "log").mockImplementation(() => undefined);
  return { service, listPayments, fetchPayment, read, emitOnce, error, warn };
}

describe("RazorpayReconcileService.run", () => {
  it("off: returns at once without a provider call, a query or an event", async () => {
    const t = setup({ enabled: false, listed: [pay(1)] });
    expect(await t.service.run(NOW)).toEqual({ armed: false });
    expect(t.listPayments).not.toHaveBeenCalled();
    expect(t.read).not.toHaveBeenCalled();
    expect(t.emitOnce).not.toHaveBeenCalled();
  });

  it("a rzp_test_ key skips the run (the invoice code's test-mode rule)", async () => {
    const t = setup({ keyId: " rzp_test_abc" });
    expect(await t.service.run(NOW)).toEqual({ armed: true, skipped: "test_mode" });
    expect(t.listPayments).not.toHaveBeenCalled();
    expect(t.read).not.toHaveBeenCalled();
  });

  it("real payments not configured: skipped without a call", async () => {
    const t = setup({ isLive: false });
    expect(await t.service.run(NOW)).toEqual({ armed: true, skipped: "not_live" });
    expect(t.listPayments).not.toHaveBeenCalled();
  });

  it("clean: lists the window once, reads our orders for the captured ones, emits nothing", async () => {
    const t = setup({
      listed: [pay(1), pay(2, { status: "failed", orderId: "order_2" }), pay(3, { orderId: null })],
      orders: snap([order(1)]),
    });
    expect(await t.service.run(NOW)).toEqual({
      armed: true,
      paymentsChecked: 2,
      ordersChecked: 1,
      capturedNotPaid: 0,
      paidNotCaptured: 0,
      amountMismatches: 0,
      capturedUnknownOrder: 0,
      unverified: 0,
      truncated: false,
      alerted: false,
    });
    expect(t.listPayments).toHaveBeenCalledWith({
      ...reconcileWindow(NOW),
      maxPages: RECONCILE_MAX_PAGES,
    });
    // Only the captured payment's Razorpay order is looked up; a captured payment with no order
    // is not ours.
    expect(t.read).toHaveBeenCalledWith({ providerOrderIds: ["order_1"], ...reconcileWindow(NOW) });
    expect(t.fetchPayment).not.toHaveBeenCalled();
    expect(t.emitOnce).not.toHaveBeenCalled();
    expect(t.error).not.toHaveBeenCalled();
  });

  it("findings: one error line with the order and payment ids, one counts-only alert per day", async () => {
    const t = setup({
      listed: [pay(1, { amountPaise: 1 }), pay(2), pay(7, { orderId: "order_7" })],
      orders: snap([order(1), order(2, { status: "created", providerPaymentRef: null }), order(3)]),
      fetchPayment: async () => {
        throw new Error("payment provider payment fetch failed");
      },
    });
    expect(await t.service.run(NOW)).toMatchObject({
      armed: true,
      paymentsChecked: 3,
      ordersChecked: 2,
      capturedNotPaid: 1,
      paidNotCaptured: 1,
      amountMismatches: 1,
      capturedUnknownOrder: 1,
      alerted: true,
    });
    expect(t.fetchPayment).toHaveBeenCalledWith("pay_3");
    expect(t.error).toHaveBeenCalledTimes(1);
    const line = t.error.mock.calls[0]![0];
    expect(line).toContain("razorpay reconciliation FAILED");
    expect(line).toContain("nothing was changed");
    expect(line).toContain(`order=${uuid(2)} rzp_order=order_2 payment=pay_2 reason=order_created`);
    expect(line).toContain(
      `order=${uuid(3)} rzp_order=order_3 payment=pay_3 reason=payment_fetch_failed`,
    );
    expect(line).toContain(
      `order=${uuid(1)} rzp_order=order_1 payment=pay_1 reason=captured_1_expected_117900`,
    );
    expect(line).toContain("order=- rzp_order=order_7 payment=pay_7 reason=no_order");

    expect(t.emitOnce).toHaveBeenCalledTimes(1);
    expect(t.emitOnce).toHaveBeenCalledWith({
      event_name: "payment.reconciliation_failed",
      actor: { actor_type: "system" },
      subject: { subject_type: "payer", subject_id: null },
      payload: {
        window_hours: 48,
        payments_checked: 3,
        orders_checked: 2,
        captured_not_paid: 1,
        paid_not_captured: 1,
        amount_mismatches: 1,
        captured_unknown_order: 1,
      },
      idempotencyKey: "payment.reconciliation_failed:2026-11-19",
    });
    // Counts only on the spine: no id rides in the payload.
    expect(JSON.stringify(t.emitOnce.mock.calls[0])).not.toMatch(/pay_|order_\d|0000-4000/);
  });

  it("a second run the same day still logs, but the alert is deduped (alerted: false)", async () => {
    const t = setup({ listed: [pay(1)], orders: snap([]), written: false });
    expect(await t.service.run(NOW)).toMatchObject({ capturedUnknownOrder: 1, alerted: false });
    expect(t.error).toHaveBeenCalledTimes(1);
  });

  it("reads at most RECONCILE_MAX_FETCHES payments one by one; the rest are unverified", async () => {
    const paid = Array.from({ length: RECONCILE_MAX_FETCHES + 3 }, (_, i) => order(i + 1));
    const t = setup({ listed: [], orders: snap([], paid) });
    expect(await t.service.run(NOW)).toMatchObject({ unverified: 3, alerted: false });
    expect(t.fetchPayment).toHaveBeenCalledTimes(RECONCILE_MAX_FETCHES);
    expect(t.warn).toHaveBeenCalledWith(expect.stringContaining("3 paid order(s) not verified"));
  });

  it("caps the log at RECONCILE_LOG_IDS_PER_CLASS per class and says how many more", async () => {
    const n = RECONCILE_LOG_IDS_PER_CLASS + 2;
    const listed = Array.from({ length: n }, (_, i) => pay(i + 1));
    const t = setup({ listed, orders: snap([]) });
    await t.service.run(NOW);
    const line = t.error.mock.calls[0]![0];
    expect(line).toContain(`captured_unknown_order=${n}`);
    expect(line).toContain("(+2 more)");
  });

  it("a truncated list is logged as a warning", async () => {
    const t = setup({ listed: [pay(1)], orders: snap([order(1)]), truncated: true });
    expect(await t.service.run(NOW)).toMatchObject({ truncated: true, alerted: false });
    expect(t.warn).toHaveBeenCalledWith(expect.stringContaining("stopped at"));
  });

  it("a provider list failure fails the tick (BullMQ records it) and alerts nothing", async () => {
    const t = setup({});
    t.listPayments.mockRejectedValueOnce(new Error("payment provider payment list failed"));
    await expect(t.service.run(NOW)).rejects.toThrow("payment provider payment list failed");
    expect(t.read).not.toHaveBeenCalled();
    expect(t.emitOnce).not.toHaveBeenCalled();
  });
});

describe("reconcileAlertKey", () => {
  it("is one key per UTC day", () => {
    expect(reconcileAlertKey(new Date("2026-11-19T00:00:00.000Z"))).toBe(
      reconcileAlertKey(new Date("2026-11-19T23:59:59.999Z")),
    );
    expect(reconcileAlertKey(new Date("2026-11-20T00:00:00.000Z"))).toBe(
      "payment.reconciliation_failed:2026-11-20",
    );
  });
});
