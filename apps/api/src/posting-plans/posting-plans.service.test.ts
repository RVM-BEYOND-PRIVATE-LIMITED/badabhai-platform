import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { DEFAULT_CATALOG, parseCatalog, type Catalog } from "@badabhai/pricing";
import { PostingPlansService } from "./posting-plans.service";

const POSTING = "33333333-3333-4333-8333-333333333333";
const PAYER = "44444444-4444-4444-8444-444444444444";
const CTX = { correlationId: "22222222-2222-4222-8222-222222222222", requestId: "req-1" };

function make(
  opts: {
    catalog?: Catalog;
    activeBoost?: boolean;
    couponUsage?: { total: number; perPayer: number };
    postingExists?: boolean;
    // Capacity-chokepoint knobs (ADR-0016):
    capacity?: { maxActiveVacancies: number } | null; // null/undefined → no row (config default)
    activeCount?: number; // currently-active plans for the payer
    capacityDefault?: number; // config default allowance
    enforceCapacity?: boolean; // ADR-0016 posture B flag (default OFF = shadow)
    pausedPlans?: { id: string; jobPostingId: string; expiresAt: Date | null }[];
  } = {},
) {
  const emit = vi.fn().mockResolvedValue(undefined);
  const postingExists = vi.fn().mockResolvedValue(opts.postingExists ?? true);
  const insertPlan = vi.fn().mockImplementation(async (input: Record<string, unknown>) => ({ id: "p-1", ...input }));
  const insertBoost = vi.fn().mockImplementation(async (input: Record<string, unknown>) => ({ id: "b-1", ...input }));
  const findActiveBoost = vi.fn().mockResolvedValue(opts.activeBoost ? { id: "b-old" } : undefined);
  const couponUsage = vi.fn().mockResolvedValue(opts.couponUsage ?? { total: 0, perPayer: 0 });
  // The transaction simply runs its callback with a sentinel tx (the repo methods below
  // are all mocked, so the sentinel is never really used by Drizzle).
  const withTransaction = vi.fn().mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => work({}));
  const lockPayer = vi.fn().mockResolvedValue(undefined);
  const getCapacity = vi.fn().mockResolvedValue(opts.capacity ?? undefined);
  const countActivePlansForPayer = vi.fn().mockResolvedValue(opts.activeCount ?? 0);
  const upsertCapacity = vi.fn().mockImplementation(async (input: Record<string, unknown>) => ({ id: "cap-1", ...input }));
  const listPausedPlansForPayer = vi.fn().mockResolvedValue(opts.pausedPlans ?? []);
  const setPlanStatus = vi.fn().mockResolvedValue(undefined);
  const getActiveCatalog = vi.fn().mockResolvedValue({ catalog: opts.catalog ?? DEFAULT_CATALOG, revision: 1, source: "db" });
  const service = new PostingPlansService(
    {
      postingExists,
      insertPlan,
      insertBoost,
      findActiveBoost,
      couponUsage,
      withTransaction,
      lockPayer,
      getCapacity,
      countActivePlansForPayer,
      upsertCapacity,
      listPausedPlansForPayer,
      setPlanStatus,
    } as never,
    { emit } as never,
    { getActiveCatalog } as never,
    {
      PAYMENTS_ENABLE_REAL: false,
      CAPACITY_DEFAULT_MAX_ACTIVE_VACANCIES: opts.capacityDefault ?? 1,
      CAPACITY_ENFORCEMENT_ENABLED: opts.enforceCapacity ?? false,
    } as never,
  );
  const names = () => emit.mock.calls.map((c) => c[0].event_name);
  return { service, emit, names, insertPlan, insertBoost, couponUsage, upsertCapacity, setPlanStatus, lockPayer, withTransaction };
}

describe("PostingPlansService.buyPlan", () => {
  it("resolves price, stamps quota/window, and emits payment + purchase (mock real_call=false)", async () => {
    const { service, emit, names, insertPlan } = make();
    const { plan, quote } = await service.buyPlan(POSTING, { payer_id: PAYER, tier: "standard" }, CTX);
    expect(quote.finalInr).toBe(1000);
    expect(insertPlan).toHaveBeenCalledWith(
      expect.objectContaining({ jobPostingId: POSTING, payerId: PAYER, tier: "standard", applicantVisibilityQuota: 10, status: "active" }),
      expect.anything(),
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

describe("PostingPlansService.buyPlan — per-payer capacity chokepoint (ADR-0016)", () => {
  it("writes status='active' when the payer stays within their allowance (no pause event)", async () => {
    const { service, names, insertPlan } = make({ activeCount: 0, capacityDefault: 1 });
    const { paused, wouldPause } = await service.buyPlan(POSTING, { payer_id: PAYER, tier: "standard" }, CTX);
    expect(paused).toBe(false);
    expect(wouldPause).toBe(false);
    expect(insertPlan).toHaveBeenCalledWith(expect.objectContaining({ status: "active" }), expect.anything());
    expect(names()).not.toContain("posting_plan.paused");
  });

  it("ENFORCEMENT ON: writes status='paused' + emits posting_plan.paused when over the config default", async () => {
    // default allowance 1, already 1 active → this purchase (1+1 > 1) is paused (enforced).
    const { service, names, insertPlan } = make({ activeCount: 1, capacityDefault: 1, enforceCapacity: true });
    const { paused, wouldPause } = await service.buyPlan(POSTING, { payer_id: PAYER, tier: "standard" }, CTX);
    expect(paused).toBe(true);
    expect(wouldPause).toBe(true);
    expect(insertPlan).toHaveBeenCalledWith(expect.objectContaining({ status: "paused" }), expect.anything());
    expect(names()).toContain("posting_plan.paused");
    // payment + purchase still emitted (the receipt is real; a paused plan just does not serve).
    expect(names()).toEqual(["payment.authorized", "payment.captured", "job_posting.purchased", "posting_plan.paused"]);
  });

  it("ENFORCEMENT OFF (default/shadow): over-cap writes status='active', emits NO pause event, returns wouldPause=true", async () => {
    // Same over-cap inputs as the enforced case, but enforcement is OFF (the default).
    const { service, names, insertPlan } = make({ activeCount: 1, capacityDefault: 1 });
    const { paused, wouldPause } = await service.buyPlan(POSTING, { payer_id: PAYER, tier: "standard" }, CTX);
    expect(paused).toBe(false); // nothing actually paused in shadow mode
    expect(wouldPause).toBe(true); // but the would-pause decision is surfaced
    expect(insertPlan).toHaveBeenCalledWith(expect.objectContaining({ status: "active" }), expect.anything());
    // NO posting_plan.paused — pausing nothing must not emit a pause (event↔state honesty).
    expect(names()).not.toContain("posting_plan.paused");
    expect(names()).toEqual(["payment.authorized", "payment.captured", "job_posting.purchased"]);
  });

  it("uses the payer's own capacity row over the config default", async () => {
    // payer row allows 3; 2 already active → 2+1 = 3 ≤ 3 → active.
    const { service, insertPlan } = make({ activeCount: 2, capacity: { maxActiveVacancies: 3 }, capacityDefault: 1 });
    const { paused, wouldPause } = await service.buyPlan(POSTING, { payer_id: PAYER, tier: "standard" }, CTX);
    expect(paused).toBe(false);
    expect(wouldPause).toBe(false);
    expect(insertPlan).toHaveBeenCalledWith(expect.objectContaining({ status: "active" }), expect.anything());
  });

  it("count-and-write runs inside the per-payer advisory-locked transaction", async () => {
    const { service, lockPayer, withTransaction } = make();
    await service.buyPlan(POSTING, { payer_id: PAYER, tier: "standard" }, CTX);
    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(lockPayer).toHaveBeenCalledWith(expect.anything(), PAYER);
  });
});

describe("PostingPlansService.buyCapacity (ADR-0016 — purchase + auto-resume)", () => {
  it("resolves the capacity tier, upserts the allowance, and emits capacity.purchased + payment.*", async () => {
    const { service, names, upsertCapacity } = make();
    const res = await service.buyCapacity(PAYER, { tier: "cap_5" }, CTX);
    expect(res.max_active_vacancies).toBe(5);
    expect(res.quote.finalInr).toBe(5000);
    expect(upsertCapacity).toHaveBeenCalledWith(
      expect.objectContaining({ payerId: PAYER, maxActiveVacancies: 5, sourceTier: "cap_5" }),
      expect.anything(),
    );
    expect(names()).toEqual(["payment.authorized", "payment.captured", "capacity.purchased"]);
  });

  it("auto-resumes paused plans oldest-first up to the new headroom and emits posting_plan.resumed", async () => {
    // new allowance 5, 0 active now → headroom 5; two paused plans both resume.
    const paused = [
      { id: "old-1", jobPostingId: "jp-1", expiresAt: new Date(Date.now() + 86_400_000) },
      { id: "old-2", jobPostingId: "jp-2", expiresAt: null },
    ];
    const { service, names, setPlanStatus } = make({ activeCount: 0, pausedPlans: paused });
    const res = await service.buyCapacity(PAYER, { tier: "cap_5" }, CTX);
    expect(res.resumed_plan_ids).toEqual(["old-1", "old-2"]);
    expect(setPlanStatus).toHaveBeenCalledWith(expect.anything(), "old-1", "active");
    expect(setPlanStatus).toHaveBeenCalledWith(expect.anything(), "old-2", "active");
    const resumedCount = names().filter((n) => n === "posting_plan.resumed").length;
    expect(resumedCount).toBe(2);
  });

  it("resumes only up to the available headroom (allowed − active)", async () => {
    // allowance 5, already 4 active → headroom 1 → only the oldest paused plan resumes.
    const paused = [
      { id: "old-1", jobPostingId: "jp-1", expiresAt: null },
      { id: "old-2", jobPostingId: "jp-2", expiresAt: null },
    ];
    const { service, setPlanStatus } = make({ activeCount: 4, pausedPlans: paused });
    const res = await service.buyCapacity(PAYER, { tier: "cap_5" }, CTX);
    expect(res.resumed_plan_ids).toEqual(["old-1"]);
    expect(setPlanStatus).toHaveBeenCalledTimes(1);
  });

  it("does not resume an expired paused plan", async () => {
    const paused = [{ id: "stale", jobPostingId: "jp-x", expiresAt: new Date(Date.now() - 86_400_000) }];
    const { service, setPlanStatus } = make({ activeCount: 0, pausedPlans: paused });
    const res = await service.buyCapacity(PAYER, { tier: "cap_5" }, CTX);
    expect(res.resumed_plan_ids).toEqual([]);
    expect(setPlanStatus).not.toHaveBeenCalled();
  });

  it("auto-resume runs under the per-payer advisory lock", async () => {
    const { service, lockPayer, withTransaction } = make();
    await service.buyCapacity(PAYER, { tier: "cap_5" }, CTX);
    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(lockPayer).toHaveBeenCalledWith(expect.anything(), PAYER);
  });

  it("400s for an unknown capacity tier (fail-closed pricing)", async () => {
    const { service } = make();
    await expect(service.buyCapacity(PAYER, { tier: "cap_999" }, CTX)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("UPGRADE (cap_5 → cap_15, D4): raises the allowance to 15 and auto-resumes against the higher headroom", async () => {
    // D4 + GREATEST guard (ADR-0016): a payer already on cap_5 (allowance 5) upgrades to
    // cap_15 (allowance 15). The service upserts the catalog grant (15) — the GREATEST
    // guard is the DB-side onConflict (raises, never lowers); the e2e proves the SQL, the
    // unit proves the service passes the RAISED grant through AND resumes against it.
    //
    // Set the scene so resume headroom is what distinguishes 5 from 15: 5 already active
    // (i.e. AT the old cap_5 ceiling → zero headroom under cap_5) + many paused plans.
    // Under cap_15 the headroom is 15 − 5 = 10, so up to 10 paused plans resume.
    const paused = Array.from({ length: 12 }, (_, i) => ({
      id: `paused-${String(i).padStart(2, "0")}`,
      jobPostingId: `jp-${i}`,
      expiresAt: null,
    }));
    const { service, upsertCapacity, setPlanStatus, names } = make({ activeCount: 5, pausedPlans: paused });

    const res = await service.buyCapacity(PAYER, { tier: "cap_15" }, CTX);

    // The allowance after the upgrade is the cap_15 grant (15) — the service stamps the
    // raised grant; it does not re-read its own in-tx write (see service comment).
    expect(res.max_active_vacancies).toBe(15);
    expect(res.source_tier).toBe("cap_15");
    expect(upsertCapacity).toHaveBeenCalledWith(
      expect.objectContaining({ payerId: PAYER, maxActiveVacancies: 15, sourceTier: "cap_15" }),
      expect.anything(),
    );

    // Resume runs against the RAISED headroom (15 − 5 = 10), NOT the old cap_5 (which gave
    // zero headroom). Exactly 10 paused plans flip active, oldest-first, deterministically.
    expect(res.resumed_plan_ids).toHaveLength(10);
    expect(res.resumed_plan_ids).toEqual(paused.slice(0, 10).map((p) => p.id));
    expect(setPlanStatus).toHaveBeenCalledTimes(10);
    expect(setPlanStatus).toHaveBeenCalledWith(expect.anything(), "paused-00", "active");
    expect(setPlanStatus).toHaveBeenCalledWith(expect.anything(), "paused-09", "active");
    expect(setPlanStatus).not.toHaveBeenCalledWith(expect.anything(), "paused-10", "active");

    // One posting_plan.resumed per resumed plan + the capacity/payment spine events.
    expect(names().filter((n) => n === "posting_plan.resumed")).toHaveLength(10);
    expect(names()).toContain("capacity.purchased");
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
