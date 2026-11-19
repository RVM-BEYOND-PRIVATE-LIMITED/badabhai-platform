import { describe, expect, it, vi } from "vitest";
import type { PaymentOrder } from "@badabhai/db";
import { issueMissingInvoice, type IssueMissingInvoiceDeps } from "./issue-missing-invoice";
import { parseIssueMissingInvoiceArgs, testModeFromEnv } from "./issue-missing-invoice.cli";

/** #2749 part 4 — the missing-invoice repair: every refusal writes nothing; dry run by default. */
const ORDER = "aaaaaaaa-0000-4000-8000-000000000001";

const paid = (over: Partial<PaymentOrder> = {}): PaymentOrder =>
  ({
    id: ORDER,
    payerId: "bbbbbbbb-0000-4000-8000-000000000002",
    provider: "razorpay",
    status: "paid",
    providerPaymentRef: "pay_1",
    ...over,
  }) as PaymentOrder;

function deps(over: Partial<IssueMissingInvoiceDeps> = {}) {
  const d = {
    findOrder: vi.fn(async () => paid() as PaymentOrder | undefined),
    hasInvoice: vi.fn(async () => false),
    sellerCheck: vi.fn(async () => "ok" as const),
    issue: vi.fn(async () => "inv-1"),
    ...over,
  };
  return d;
}

const run = (d: IssueMissingInvoiceDeps, apply = true, testMode: boolean | null = false) =>
  issueMissingInvoice(d, { orderId: ORDER, apply, testMode });

describe("issueMissingInvoice — refusals write nothing", () => {
  it("an unknown order", async () => {
    const d = deps({ findOrder: vi.fn(async () => undefined) });
    expect(await run(d)).toEqual({ outcome: "refused", reason: "order_not_found" });
    expect(d.issue).not.toHaveBeenCalled();
  });

  it.each([
    ["created", { status: "created" as const }],
    ["failed", { status: "failed" as const }],
    ["held", { status: "held" as const }],
    ["no provider payment id", { providerPaymentRef: null }],
    ["not a Razorpay order", { provider: "mock" }],
  ])("not a real captured paid order (%s)", async (_n, over) => {
    const d = deps({ findOrder: vi.fn(async () => paid(over)) });
    expect(await run(d)).toEqual({ outcome: "refused", reason: "not_real_paid_order" });
    expect(d.issue).not.toHaveBeenCalled();
  });

  it("an order that already has an invoice", async () => {
    const d = deps({ hasInvoice: vi.fn(async () => true) });
    expect(await run(d)).toEqual({ outcome: "refused", reason: "already_invoiced" });
    expect(d.issue).not.toHaveBeenCalled();
  });

  it("test mode, and an unknown mode (no key id given: fails closed)", async () => {
    const d = deps();
    expect(await run(d, true, true)).toEqual({ outcome: "refused", reason: "test_mode" });
    expect(await run(d, true, null)).toEqual({ outcome: "refused", reason: "mode_unknown" });
    expect(d.issue).not.toHaveBeenCalled();
  });

  it.each(["seller_not_configured", "seller_config_invalid"] as const)("no usable seller row (%s)", async (reason) => {
    const d = deps({ sellerCheck: vi.fn(async () => reason) });
    expect(await run(d)).toEqual({ outcome: "refused", reason });
    expect(d.issue).not.toHaveBeenCalled();
  });
});

describe("issueMissingInvoice — dry run by default, --apply issues", () => {
  it("a dry run says it would issue and writes nothing", async () => {
    const d = deps();
    expect(await run(d, false)).toEqual({ outcome: "would_issue" });
    expect(d.issue).not.toHaveBeenCalled();
  });

  it("apply issues through the issuer", async () => {
    const d = deps();
    expect(await run(d, true)).toEqual({ outcome: "issued", invoiceId: "inv-1" });
    expect(d.issue).toHaveBeenCalledWith(expect.objectContaining({ id: ORDER }));
  });
});

describe("argv and the mode", () => {
  it("needs a uuid order id; --apply is opt-in; unknown flags refuse", () => {
    expect(parseIssueMissingInvoiceArgs([`--payment-order-id=${ORDER}`])).toEqual({
      orderId: ORDER,
      apply: false,
    });
    expect(parseIssueMissingInvoiceArgs([`--payment-order-id=${ORDER}`, "--apply"]).apply).toBe(true);
    expect(() => parseIssueMissingInvoiceArgs([])).toThrow(/payment-order-id/);
    expect(() => parseIssueMissingInvoiceArgs(["--payment-order-id=nope"])).toThrow(/payment-order-id/);
    expect(() => parseIssueMissingInvoiceArgs([`--payment-order-id=${ORDER}`, "--force"])).toThrow();
  });

  it("reads test mode from the key ID; none given is unknown", () => {
    expect(testModeFromEnv({ PAYMENTS_PROVIDER_KEY: "rzp_test_abc" })).toBe(true);
    expect(testModeFromEnv({ PAYMENTS_PROVIDER_KEY: "rzp_live_abc" })).toBe(false);
    expect(testModeFromEnv({})).toBeNull();
    expect(testModeFromEnv({ PAYMENTS_PROVIDER_KEY: "  " })).toBeNull();
  });
});
