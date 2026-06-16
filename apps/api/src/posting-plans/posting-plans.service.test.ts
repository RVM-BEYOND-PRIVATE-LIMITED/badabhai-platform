import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { DEFAULT_CATALOG, parseCatalog, type Catalog } from "@badabhai/pricing";
import { PostingPlansService } from "./posting-plans.service";

const POSTING = "33333333-3333-4333-8333-333333333333";
const PAYER = "44444444-4444-4444-8444-444444444444";
const CTX = { correlationId: "22222222-2222-4222-8222-222222222222", requestId: "req-1" };

function make(opts: { catalog?: Catalog; activeBoost?: boolean; couponUsage?: { total: number; perPayer: number }; postingExists?: boolean } = {}) {
  const emit = vi.fn().mockResolvedValue(undefined);
  const postingExists = vi.fn().mockResolvedValue(opts.postingExists ?? true);
  const insertPlan = vi.fn().mockImplementation(async (input: Record<string, unknown>) => ({ id: "p-1", ...input }));
  const insertBoost = vi.fn().mockImplementation(async (input: Record<string, unknown>) => ({ id: "b-1", ...input }));
  const findActiveBoost = vi.fn().mockResolvedValue(opts.activeBoost ? { id: "b-old" } : undefined);
  const couponUsage = vi.fn().mockResolvedValue(opts.couponUsage ?? { total: 0, perPayer: 0 });
  const getActiveCatalog = vi.fn().mockResolvedValue({ catalog: opts.catalog ?? DEFAULT_CATALOG, revision: 1, source: "db" });
  const service = new PostingPlansService(
    { postingExists, insertPlan, insertBoost, findActiveBoost, couponUsage } as never,
    { emit } as never,
    { getActiveCatalog } as never,
    { PAYMENTS_ENABLE_REAL: false } as never,
  );
  const names = () => emit.mock.calls.map((c) => c[0].event_name);
  return { service, emit, names, insertPlan, insertBoost, couponUsage };
}

describe("PostingPlansService.buyPlan", () => {
  it("resolves price, stamps quota/window, and emits payment + purchase (mock real_call=false)", async () => {
    const { service, emit, names, insertPlan } = make();
    const { plan, quote } = await service.buyPlan(POSTING, { payer_id: PAYER, tier: "standard" }, CTX);
    expect(quote.finalInr).toBe(1000);
    expect(insertPlan).toHaveBeenCalledWith(
      expect.objectContaining({ jobPostingId: POSTING, payerId: PAYER, tier: "standard", applicantVisibilityQuota: 10, status: "active" }),
    );
    expect(plan.id).toBe("p-1");
    expect(names()).toEqual(["payment.authorized", "payment.captured", "job_posting.purchased"]);
    const purchased = emit.mock.calls.find((c) => c[0].event_name === "job_posting.purchased")![0];
    expect(purchased.payload).toMatchObject({ tier: "standard", price_inr: 1000, coupon_applied: false, real_call: false, validity_days: 14 });
  });

  it("404s for an unknown posting", async () => {
    const { service } = make({ postingExists: false });
    await expect(service.buyPlan(POSTING, { payer_id: PAYER, tier: "standard" }, CTX)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("resolves the pro tier (₹2500 / 30 views / 30 days)", async () => {
    const { service } = make();
    const { plan, quote } = await service.buyPlan(POSTING, { payer_id: PAYER, tier: "pro" }, CTX);
    expect(quote.finalInr).toBe(2500);
    expect(plan.applicantVisibilityQuota).toBe(30);
  });

  it("applies a valid coupon and emits coupon.redeemed", async () => {
    const cat = parseCatalog({
      ...DEFAULT_CATALOG,
      coupons: [
        {
          code: "save10",
          scope: { productCode: "job_posting", tierCode: "standard" },
          kind: "percent",
          value: 10,
          from: "2026-01-01T00:00:00.000Z",
          until: "2027-01-01T00:00:00.000Z",
          totalUsageCap: 100,
          perPayerLimit: 5,
        },
      ],
    });
    const { service, emit, names } = make({ catalog: cat });
    const { quote } = await service.buyPlan(POSTING, { payer_id: PAYER, tier: "standard", coupon: "save10" }, CTX);
    expect(quote.finalInr).toBe(900);
    expect(quote.couponApplied).toBe("save10");
    expect(names()).toContain("coupon.redeemed");
    const redeemed = emit.mock.calls.find((c) => c[0].event_name === "coupon.redeemed")![0];
    expect(redeemed.payload).toMatchObject({ coupon_code: "save10", product: "job_posting", tier: "standard", discount_inr: 100 });
  });

  it("ignores an over-cap coupon (full price, no redemption event)", async () => {
    const cat = parseCatalog({
      ...DEFAULT_CATALOG,
      coupons: [
        { code: "save10", scope: { productCode: "job_posting" }, kind: "percent", value: 10, from: "2026-01-01T00:00:00.000Z", until: "2027-01-01T00:00:00.000Z", totalUsageCap: 5, perPayerLimit: 5 },
      ],
    });
    const { service, names } = make({ catalog: cat, couponUsage: { total: 5, perPayer: 0 } });
    const { quote } = await service.buyPlan(POSTING, { payer_id: PAYER, tier: "standard", coupon: "save10" }, CTX);
    expect(quote.finalInr).toBe(1000);
    expect(quote.couponApplied).toBeNull();
    expect(names()).not.toContain("coupon.redeemed");
  });
});

describe("PostingPlansService.buyBoost", () => {
  it("creates a boost and emits payment + boosted", async () => {
    const { service, names, insertBoost } = make();
    const { boost, quote } = await service.buyBoost(POSTING, { payer_id: PAYER, tier: "all_candidates" }, CTX);
    expect(quote.finalInr).toBe(1200);
    expect(insertBoost).toHaveBeenCalledWith(expect.objectContaining({ jobPostingId: POSTING, status: "active" }));
    expect(boost.id).toBe("b-1");
    expect(names()).toEqual(["payment.authorized", "payment.captured", "job_posting.boosted"]);
  });

  it("rejects an overlapping active boost (B-R3)", async () => {
    const { service } = make({ activeBoost: true });
    await expect(service.buyBoost(POSTING, { payer_id: PAYER, tier: "all_candidates" }, CTX)).rejects.toBeInstanceOf(ConflictException);
  });
});
