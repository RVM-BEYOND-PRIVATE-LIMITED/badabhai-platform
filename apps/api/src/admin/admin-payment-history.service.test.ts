import { describe, expect, it, vi } from "vitest";
import { AdminPaymentHistoryService } from "./admin-payment-history.service";
import { AdminPaymentHistoryRepository } from "./admin-payment-history.repository";
import type { AdminPaymentHistoryItem } from "./admin-payment-history.dto";

const PAYER = "66666666-6666-4666-8666-666666666666";

function item(partial: Partial<AdminPaymentHistoryItem> & { id: string }): AdminPaymentHistoryItem {
  return {
    date: new Date("2026-10-01T00:00:00.000Z"),
    type: "credit_purchase",
    item: "pack_50",
    credits: 50,
    amount_inr: 2000,
    status: "pack_purchase",
    provider_reference: null,
    simulated: false,
    ...partial,
  };
}

function serviceWith(
  sources: AdminPaymentHistoryItem[],
  opts: { mode?: "real" | "mock"; balance?: number; anchor?: string; members?: string[] } = {},
) {
  const repo = {
    resolveOrgPayerIds: vi.fn().mockResolvedValue({
      anchor: opts.anchor ?? PAYER,
      memberPayerIds: opts.members ?? [PAYER],
    }),
    readSources: vi.fn().mockResolvedValue(sources),
    orgBalance: vi.fn().mockResolvedValue(opts.balance ?? 0),
  } as unknown as AdminPaymentHistoryRepository;
  const db = {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [{ id: PAYER }] }) }),
    }),
  } as never;
  const config = (
    opts.mode === "real"
      ? {
          PAYMENTS_ENABLE_REAL: true,
          PAYMENTS_PROVIDER_KEY: "rzp_test_key",
          PAYMENTS_PROVIDER_SECRET: "secret",
          RAZORPAY_WEBHOOK_SECRET: "webhook",
        }
      : { PAYMENTS_ENABLE_REAL: false }
  ) as never;
  const svc = new AdminPaymentHistoryService(repo, db, config);
  return { svc, repo };
}

describe("admin payment-history totals and ordering (#2565 B11)", () => {
  it("sorts newest-first and stamps every row simulated while real payments are off", async () => {
    const { svc } = serviceWith(
      [
        item({ id: "credit_purchase:old", date: new Date("2026-10-01T00:00:00.000Z") }),
        item({ id: "credit_purchase:new", date: new Date("2026-10-03T00:00:00.000Z") }),
      ],
      { mode: "mock" },
    );
    const out = await svc.history(PAYER, { limit: 50 });
    expect(out.items.map((i) => i.id)).toEqual(["credit_purchase:new", "credit_purchase:old"]);
    expect(out.items.every((i) => i.simulated)).toBe(true);
    expect(out.payments.mode).toBe("mock");
  });

  it("marks rows real when payments are live", async () => {
    const { svc } = serviceWith([item({ id: "credit_purchase:a" })], { mode: "real" });
    const out = await svc.history(PAYER, { limit: 50 });
    expect(out.items.every((i) => i.simulated)).toBe(false);
    expect(out.payments.mode).toBe("real");
  });

  it("counts a ledger purchase once even when its payment_orders twin exists", async () => {
    const { svc } = serviceWith([
      item({
        id: "payment_order:o1",
        type: "payment_order",
        item: "pack_50",
        credits: 50,
        amount_inr: 2000,
        status: "paid",
        date: new Date("2026-10-01T10:00:00.000Z"),
      }),
      item({
        id: "credit_purchase:l1",
        type: "credit_purchase",
        item: "pack_50",
        credits: 50,
        amount_inr: 2000,
        date: new Date("2026-10-01T10:01:00.000Z"),
      }),
    ]);
    const out = await svc.history(PAYER, { limit: 50 });
    // One purchase, not two: the ledger row is the money SoR, the order is its twin.
    expect(out.totals.inr_spent).toBe(2000);
    expect(out.totals.credits_bought).toBe(50);
  });

  it("counts an order with no ledger twin (abandoned-then-paid outside the ledger window)", async () => {
    const { svc } = serviceWith([
      item({
        id: "payment_order:o2",
        type: "payment_order",
        item: "pack_200",
        credits: 200,
        amount_inr: 8000,
        status: "paid",
        date: new Date("2026-10-02T00:00:00.000Z"),
      }),
    ]);
    const out = await svc.history(PAYER, { limit: 50 });
    expect(out.totals.inr_spent).toBe(8000);
    expect(out.totals.credits_bought).toBe(200);
  });

  it("adds plan/boost/capacity/topup prices to ₹ spent and unlock debits to credits used", async () => {
    const { svc } = serviceWith(
      [
        item({
          id: "posting_plan:p1",
          type: "posting_plan",
          item: "standard",
          credits: null,
          amount_inr: 1000,
          status: "active",
          date: new Date("2026-10-03T00:00:00.000Z"),
        }),
        item({
          id: "credit_purchase:l1",
          type: "credit_purchase",
          credits: 50,
          amount_inr: 2000,
          date: new Date("2026-10-01T00:00:00.000Z"),
        }),
        item({
          id: "credit_spend:s1",
          type: "credit_spend",
          item: "u1",
          credits: -1,
          amount_inr: null,
          status: "unlock_debit",
          date: new Date("2026-10-04T00:00:00.000Z"),
        }),
      ],
      { balance: 49 },
    );
    const out = await svc.history(PAYER, { limit: 50 });
    expect(out.totals.inr_spent).toBe(3000);
    expect(out.totals.credits_bought).toBe(50);
    expect(out.totals.credits_used).toBe(1);
    expect(out.totals.balance).toBe(49);
  });

  it("null prices contribute 0, never a guess", async () => {
    const { svc } = serviceWith([
      item({
        id: "posting_plan:legacy",
        type: "posting_plan",
        item: "pro",
        credits: null,
        amount_inr: null,
        status: "active",
      }),
    ]);
    const out = await svc.history(PAYER, { limit: 50 });
    expect(out.totals.inr_spent).toBe(0);
    expect(out.items[0]!.amount_inr).toBeNull();
  });

  it("rolls team members into one company timeline", async () => {
    const member = "77777777-7777-4777-8777-777777777777";
    const { svc, repo } = serviceWith([item({ id: "credit_purchase:a" })], {
      anchor: PAYER,
      members: [PAYER, member],
    });
    const out = await svc.history(member, { limit: 50 });
    expect(out.payer_id).toBe(PAYER);
    expect(out.member_payer_ids).toEqual(expect.arrayContaining([PAYER, member]));
    expect(repo.readSources).toHaveBeenCalledWith(expect.arrayContaining([PAYER, member]));
  });

  it("404s on an unknown payer", async () => {
    const repo = {
      resolveOrgPayerIds: vi.fn(),
      readSources: vi.fn(),
      orgBalance: vi.fn(),
    } as unknown as AdminPaymentHistoryRepository;
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    } as never;
    const svc = new AdminPaymentHistoryService(repo, db, { PAYMENTS_ENABLE_REAL: false } as never);
    await expect(svc.history(PAYER, { limit: 50 })).rejects.toThrow("Payer not found");
  });
});
