import { describe, it, expect, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { AdminFinanceService } from "./admin-finance.service";
import type { AdminFinanceRepository } from "./admin-finance.repository";
import { decodeEntityCursor } from "./admin-entities.cursor";

/**
 * The finance service.
 *
 * The load-bearing behaviour is the PAYMENTS POSTURE. `PAYMENTS_ENABLE_REAL` is false by
 * default and false today, which means every rupee this surface reports is simulated. A
 * screen that renders mock money in the same type as real money is exactly the TD81 failure
 * — staging looked healthy for weeks behind a mocked AI provider because nothing said so.
 * These tests pin that the caveat is present on EVERY money-bearing response.
 */

function repoStub(over: Partial<AdminFinanceRepository> = {}): AdminFinanceRepository {
  return {
    outstandingCredits: vi.fn(async () => ({ credits: 0, payers: 0 })),
    topBalances: vi.fn(async () => []),
    ledgerByReason: vi.fn(async () => []),
    listLedger: vi.fn(async () => []),
    ordersByStatus: vi.fn(async () => []),
    listOrders: vi.fn(async () => []),
    ...over,
  } as unknown as AdminFinanceRepository;
}

/** Minimal config shapes. `PAYMENTS_ENABLE_REAL` is what the posture turns on. */
const MOCK_CFG = { PAYMENTS_ENABLE_REAL: false } as unknown as ServerConfig;
/** The full set `realPaymentsBlockedReason` requires: the flag AND all three secrets. */
const REAL_CFG = {
  PAYMENTS_ENABLE_REAL: true,
  PAYMENTS_PROVIDER_KEY: "rzp_test_key",
  PAYMENTS_PROVIDER_SECRET: "sec",
  RAZORPAY_WEBHOOK_SECRET: "whsec",
} as unknown as ServerConfig;

const svc = (repo = repoStub(), cfg = MOCK_CFG) => new AdminFinanceService(repo, cfg);

function rows(n: number, base = Date.parse("2026-08-04T12:00:00Z")) {
  return Array.from({ length: n }, (_, i) => ({
    id: `id-${i}`,
    created_at: new Date(base - i * 1000),
  }));
}

describe("payments posture — mock money must never look like real money", () => {
  it("summary reports mode 'mock' when real payments are off", async () => {
    const s = await svc().summary({ windowDays: 30 } as never);
    expect(s.payments.mode).toBe("mock");
    expect(s.payments.blocked_reason).toBeTruthy();
  });

  it("the LEDGER page carries the posture too — not just the summary", async () => {
    // An operator can land straight on the ledger. The caveat has to travel with the rows.
    const p = await svc().ledger({ limit: 10 } as never);
    expect(p.payments.mode).toBe("mock");
  });

  it("the ORDERS page carries the posture too", async () => {
    const p = await svc().orders({ limit: 10 } as never);
    expect(p.payments.mode).toBe("mock");
  });

  it("reports mode 'real' only when the provider is genuinely configured", async () => {
    const s = await svc(repoStub(), REAL_CFG).summary({ windowDays: 30 } as never);
    expect(s.payments.mode).toBe("real");
    expect(s.payments.blocked_reason).toBeNull();
  });

  it("a flag set WITHOUT credentials is still mock — it fails closed", async () => {
    // The dangerous middle state: someone flips PAYMENTS_ENABLE_REAL and forgets the keys.
    // Reporting "real" there would label simulated money as genuine.
    const halfCfg = { PAYMENTS_ENABLE_REAL: true } as unknown as ServerConfig;
    const s = await svc(repoStub(), halfCfg).summary({ windowDays: 30 } as never);
    expect(s.payments.mode).toBe("mock");
    expect(s.payments.blocked_reason).toBeTruthy();
  });
});

describe("summary aggregation", () => {
  it("reports outstanding credits and the payer count", async () => {
    const s = await svc(
      repoStub({ outstandingCredits: vi.fn(async () => ({ credits: 1250, payers: 7 })) } as never),
    ).summary({ windowDays: 30 } as never);
    expect(s.outstanding_credits).toBe(1250);
    expect(s.payers_with_balance).toBe(7);
  });

  it("splits paid, unsettled and failed orders — an unsettled order is NOT revenue", async () => {
    const s = await svc(
      repoStub({
        ordersByStatus: vi.fn(async () => [
          { status: "paid", count: 3, amountInr: 3000, credits: 30 },
          { status: "created", count: 5, amountInr: 5000, credits: 50 },
          { status: "failed", count: 2, amountInr: 2000, credits: 20 },
        ]),
      } as never),
    ).summary({ windowDays: 30 } as never);

    expect(s.paid_orders).toEqual({ count: 3, credits: 30, amount_inr: 3000 });
    // The abandoned-checkout bucket is reported separately and must not be added to paid.
    expect(s.unsettled_orders).toEqual({ count: 5, amount_inr: 5000 });
    expect(s.failed_orders).toEqual({ count: 2 });
    expect(s.paid_orders.amount_inr).not.toBe(8000);
  });

  it("a status absent from the window reports 0, not undefined", async () => {
    const s = await svc().summary({ windowDays: 30 } as never);
    expect(s.paid_orders).toEqual({ count: 0, credits: 0, amount_inr: 0 });
    expect(s.unsettled_orders).toEqual({ count: 0, amount_inr: 0 });
    expect(s.failed_orders).toEqual({ count: 0 });
  });

  it("passes the window through and derives `since` from it", async () => {
    const ledgerByReason = vi.fn(async (_since: Date) => []);
    const s = await svc(repoStub({ ledgerByReason } as never)).summary({
      windowDays: 7,
    } as never);
    expect(s.window_days).toBe(7);
    const since = ledgerByReason.mock.calls[0]![0];
    const days = (Date.now() - since.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });
});

describe("keyset paging", () => {
  it("over-fetches by one and reports a cursor only when more exists", async () => {
    const listLedger = vi.fn(async () => rows(6));
    const p = await svc(repoStub({ listLedger } as never)).ledger({ limit: 5 } as never);
    expect(listLedger).toHaveBeenCalledWith(expect.anything(), null, 6);
    expect(p.items).toHaveLength(5);
    expect(decodeEntityCursor(p.nextCursor!)?.id).toBe("id-4");
  });

  it("a full last page reports nextCursor null — no phantom page", async () => {
    const p = await svc(repoStub({ listLedger: vi.fn(async () => rows(5)) } as never)).ledger({
      limit: 5,
    } as never);
    expect(p.items).toHaveLength(5);
    expect(p.nextCursor).toBeNull();
  });

  it("forwards the ledger filters", async () => {
    const listLedger = vi.fn(async () => []);
    await svc(repoStub({ listLedger } as never)).ledger({
      limit: 10,
      payerId: "p1",
      reason: "grant",
    } as never);
    expect(listLedger).toHaveBeenCalledWith({ payerId: "p1", reason: "grant" }, null, 11);
  });

  it("forwards the order filters", async () => {
    const listOrders = vi.fn(async () => []);
    await svc(repoStub({ listOrders } as never)).orders({
      limit: 10,
      status: "paid",
    } as never);
    expect(listOrders).toHaveBeenCalledWith({ payerId: undefined, status: "paid" }, null, 11);
  });

  it("a garbage cursor is the first page, not a 500", async () => {
    const listOrders = vi.fn(async () => []);
    await svc(repoStub({ listOrders } as never)).orders({ limit: 10, cursor: "junk" } as never);
    expect(listOrders).toHaveBeenCalledWith(expect.anything(), null, 11);
  });
});
