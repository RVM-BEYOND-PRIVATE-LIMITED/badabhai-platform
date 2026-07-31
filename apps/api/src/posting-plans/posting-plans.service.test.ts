import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { DEFAULT_CATALOG, parseCatalog, type Catalog } from "@badabhai/pricing";
import { DEFAULT_MATCH_CONFIG } from "@badabhai/match-engine";
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
    // B2 quota top-up knobs:
    activeTopupPlan?: { id: string; quotaTopupCount: number } | null; // null → no active plan (409)
    topupRaced?: boolean; // addQuotaTopup returns undefined (plan raced to expiry) → 409
    // ADR-0036 §7 boost supply gate:
    boostSupplyFloor?: number; // 0 (the default here) disables the gate
    reachTotal?: number; // what `job_reach` reports for the posting
    reachThrows?: boolean; // an unreadable reach count must FAIL OPEN (sale proceeds)
  } = {},
) {
  const emit = vi.fn().mockResolvedValue(undefined);
  const countReachForPosting = vi
    .fn()
    .mockImplementation(async () =>
      opts.reachThrows
        ? Promise.reject(new Error("job_reach unavailable"))
        : { total: opts.reachTotal ?? 0, tier1: 0 },
    );
  const extendPostingBoostWindow = vi.fn().mockResolvedValue(new Date());
  const postingExists = vi.fn().mockResolvedValue(opts.postingExists ?? true);
  const insertPlan = vi.fn().mockImplementation(async (input: Record<string, unknown>) => ({ id: "p-1", ...input }));
  const insertBoost = vi.fn().mockImplementation(async (input: Record<string, unknown>) => ({ id: "b-1", ...input }));
  const findActiveBoost = vi.fn().mockResolvedValue(opts.activeBoost ? { id: "b-old" } : undefined);
  const couponUsage = vi.fn().mockResolvedValue(opts.couponUsage ?? { total: 0, perPayer: 0 });
  // B2: default to an active plan with 0 prior top-ups; addQuotaTopup returns it with the
  // delta applied (unless topupRaced → undefined, the expiry-race 409 path).
  const topupPlan = opts.activeTopupPlan === undefined ? { id: "p-1", quotaTopupCount: 0 } : opts.activeTopupPlan;
  const findActivePlanForPostingAndPayer = vi.fn().mockResolvedValue(topupPlan ?? undefined);
  const addQuotaTopup = vi.fn().mockImplementation(async (planId: string, _payerId: string, delta: number) =>
    opts.topupRaced || !topupPlan ? undefined : { id: planId, quotaTopupCount: topupPlan.quotaTopupCount + delta },
  );
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
      findActivePlanForPostingAndPayer,
      addQuotaTopup,
      extendPostingBoostWindow,
    } as never,
    { emit } as never,
    { getActiveCatalog } as never,
    {
      PAYMENTS_ENABLE_REAL: false,
      CAPACITY_DEFAULT_MAX_ACTIVE_VACANCIES: opts.capacityDefault ?? 1,
      CAPACITY_ENFORCEMENT_ENABLED: opts.enforceCapacity ?? false,
    } as never,
    // ADR-0036 §7 boost supply gate. The floor defaults to 0 here (gate DISABLED) so
    // the pre-existing boost cases keep testing what they were written to test; the
    // gate's own cases set it explicitly via `opts.boostSupplyFloor`.
    {
      get: vi.fn().mockResolvedValue({
        ...DEFAULT_MATCH_CONFIG,
        boostSupplyFloor: opts.boostSupplyFloor ?? 0,
      }),
    } as never,
    { countReachForPosting: countReachForPosting } as never,
  );
  const names = () => emit.mock.calls.map((c) => c[0].event_name);
  return {
    service,
    emit,
    names,
    insertPlan,
    insertBoost,
    countReachForPosting,
    extendPostingBoostWindow,
    couponUsage,
    upsertCapacity,
    setPlanStatus,
    lockPayer,
    withTransaction,
    getCapacity,
    countActivePlansForPayer,
    findActivePlanForPostingAndPayer,
    addQuotaTopup,
  };
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

  // ── ADR-0036 §7 — the repriced tiers + the supply gate + the served window ──
  it("prices the new ADR-0036 tiers (₹499 / ₹999 / ₹1799) and keeps the retired SKU resolvable", async () => {
    for (const [tier, inr, days] of [
      ["boost_7", 499, 7],
      ["boost_15", 999, 15],
      ["boost_30", 1799, 30],
      // The retired SKU stays RESOLVABLE so a historical `posting_boosts` receipt can
      // still be priced (invariant #8). It is absent from OFFERED_BOOST_TIERS.
      ["all_candidates", 1200, 2],
    ] as const) {
      const { service, extendPostingBoostWindow } = make();
      const { quote } = await service.buyBoost(POSTING, { payer_id: PAYER, tier }, CTX);
      expect(quote.finalInr, `${tier} price`).toBe(inr);
      // The SERVED entity's window is extended by the tier's days — `posting_boosts`
      // stays the immutable receipt, `job_postings.boosted_until` is what the feed reads.
      expect(extendPostingBoostWindow).toHaveBeenCalledWith(POSTING, days);
    }
  });

  it("REFUSES the sale below the supply floor, emits boost_refused, and takes NO payment", async () => {
    const { service, names, insertBoost, extendPostingBoostWindow, emit } = make({
      boostSupplyFloor: 25,
      reachTotal: 4,
    });
    await expect(
      service.buyBoost(POSTING, { payer_id: PAYER, tier: "boost_15" }, CTX),
    ).rejects.toBeInstanceOf(BadRequestException);

    // The ONLY event is the refusal — no payment.authorized for money never taken.
    expect(names()).toEqual(["job_posting.boost_refused"]);
    const payload = emit.mock.calls[0]![0].payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      job_posting_id: POSTING,
      payer_id: PAYER,
      reason: "supply_below_floor",
      reach_total: 4,
      supply_floor: 25,
    });
    expect(insertBoost).not.toHaveBeenCalled();
    expect(extendPostingBoostWindow).not.toHaveBeenCalled();
  });

  it("allows the sale AT the floor (the boundary is inclusive)", async () => {
    const { service, insertBoost } = make({ boostSupplyFloor: 25, reachTotal: 25 });
    await service.buyBoost(POSTING, { payer_id: PAYER, tier: "boost_7" }, CTX);
    expect(insertBoost).toHaveBeenCalledOnce();
  });

  it("FAILS OPEN when the reach count cannot be read (a cache read must not break a paid path)", async () => {
    const { service, insertBoost, names } = make({ boostSupplyFloor: 25, reachThrows: true });
    await service.buyBoost(POSTING, { payer_id: PAYER, tier: "boost_7" }, CTX);
    expect(insertBoost).toHaveBeenCalledOnce();
    expect(names()).not.toContain("job_posting.boost_refused");
  });

  it("does not consult the gate at all when the floor is 0 (config-disabled)", async () => {
    const { service, countReachForPosting, insertBoost } = make({ boostSupplyFloor: 0, reachTotal: 0 });
    await service.buyBoost(POSTING, { payer_id: PAYER, tier: "boost_7" }, CTX);
    expect(countReachForPosting).not.toHaveBeenCalled();
    expect(insertBoost).toHaveBeenCalledOnce();
  });
});

describe("PostingPlansService payer-authed wrappers (B3/LC-1 — session payer_id stamped)", () => {
  const SESSION_PAYER = "55555555-5555-4555-8555-555555555555";

  it("buyPlanForPayer stamps the SESSION payer_id onto the plan + the purchased event", async () => {
    const { service, insertPlan, emit } = make();
    const { plan, quote } = await service.buyPlanForPayer(
      POSTING,
      SESSION_PAYER,
      { tier: "standard" },
      CTX,
    );
    // The plan row + every emitted event carry the SESSION payer id — never a body value.
    expect(insertPlan).toHaveBeenCalledWith(
      expect.objectContaining({ jobPostingId: POSTING, payerId: SESSION_PAYER }),
      expect.anything(),
    );
    const purchased = emit.mock.calls.find((c) => c[0].event_name === "job_posting.purchased")![0];
    expect(purchased.actor).toEqual({ actor_type: "payer", actor_id: SESSION_PAYER });
    expect(purchased.payload.payer_id).toBe(SESSION_PAYER);
    expect(plan.payerId).toBe(SESSION_PAYER);
    expect(quote.finalInr).toBeGreaterThanOrEqual(0);
  });

  it("buyBoostForPayer stamps the SESSION payer_id onto the boost", async () => {
    const { service, insertBoost, emit } = make();
    const { boost } = await service.buyBoostForPayer(
      POSTING,
      SESSION_PAYER,
      { tier: "all_candidates" },
      CTX,
    );
    expect(insertBoost).toHaveBeenCalledWith(
      expect.objectContaining({ jobPostingId: POSTING, payerId: SESSION_PAYER }),
    );
    const boosted = emit.mock.calls.find((c) => c[0].event_name === "job_posting.boosted")![0];
    expect(boosted.payload.payer_id).toBe(SESSION_PAYER);
    expect(boost.payerId).toBe(SESSION_PAYER);
  });
});

describe("PostingPlansService.topUpQuotaForPayer (B2 — pricing-engine refill on an active plan)", () => {
  const SESSION_PAYER = "55555555-5555-4555-8555-555555555555";

  it("resolves the top-up price, atomically increments quota_topup_count, and emits payment + quota_topped", async () => {
    const { service, emit, names, addQuotaTopup } = make();
    const { plan, quote } = await service.topUpQuotaForPayer(POSTING, SESSION_PAYER, { tier: "topup_10" }, CTX);
    expect(quote.finalInr).toBe(1000);
    // Atomic increment called with the SESSION payer + the catalog grant (10 views).
    expect(addQuotaTopup).toHaveBeenCalledWith("p-1", SESSION_PAYER, 10, expect.any(Date));
    expect(plan.quotaTopupCount).toBe(10);
    expect(names()).toEqual(["payment.authorized", "payment.captured", "posting_plan.quota_topped"]);
    const topped = emit.mock.calls.find((c) => c[0].event_name === "posting_plan.quota_topped")![0];
    expect(topped.actor).toEqual({ actor_type: "payer", actor_id: SESSION_PAYER });
    expect(topped.subject).toEqual({ subject_type: "posting_plan", subject_id: "p-1" });
    expect(topped.payload).toMatchObject({
      plan_id: "p-1",
      job_posting_id: POSTING,
      payer_id: SESSION_PAYER,
      tier: "topup_10",
      quota_added: 10,
      quota_topup_total: 10,
      price_inr: 1000,
      real_call: false,
    });
  });

  it("accumulates on top of prior top-ups (quota_topup_total reflects the running total)", async () => {
    const { service } = make({ activeTopupPlan: { id: "p-1", quotaTopupCount: 30 } });
    const { plan } = await service.topUpQuotaForPayer(POSTING, SESSION_PAYER, { tier: "topup_30" }, CTX);
    expect(plan.quotaTopupCount).toBe(60); // 30 prior + 30 added
  });

  it("409s when the posting has no active plan to top up (no payment emitted)", async () => {
    const { service, names } = make({ activeTopupPlan: null });
    await expect(
      service.topUpQuotaForPayer(POSTING, SESSION_PAYER, { tier: "topup_10" }, CTX),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(names()).not.toContain("payment.authorized");
    expect(names()).not.toContain("posting_plan.quota_topped");
  });

  it("409s (no phantom grant/payment) when the plan raced to expiry between read and increment", async () => {
    const { service, names } = make({ topupRaced: true });
    await expect(
      service.topUpQuotaForPayer(POSTING, SESSION_PAYER, { tier: "topup_10" }, CTX),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(names()).not.toContain("payment.authorized");
    expect(names()).not.toContain("posting_plan.quota_topped");
  });

  it("rejects an unknown top-up tier fail-closed (unavailable → 400)", async () => {
    const { service } = make();
    await expect(
      service.topUpQuotaForPayer(POSTING, SESSION_PAYER, { tier: "nope" }, CTX),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("PostingPlansService.getCapacity (ADR-0016 — payer-portal read, A3 active_plan_count)", () => {
  it("returns active_plan_count from the repository count (3 active → 3)", async () => {
    const { service, countActivePlansForPayer } = make({ capacity: { maxActiveVacancies: 10 }, activeCount: 3 });
    const view = await service.getCapacity(PAYER);
    expect(countActivePlansForPayer).toHaveBeenCalledTimes(1);
    expect(view).toMatchObject({
      payer_id: PAYER,
      max_active_vacancies: 10,
      active_plan_count: 3,
      source_tier: null,
      expires_at: null,
    });
  });

  it("reflects a different real count (repo returns 0 → active_plan_count === 0)", async () => {
    const { service } = make({ capacity: { maxActiveVacancies: 5 }, activeCount: 0 });
    const view = await service.getCapacity(PAYER);
    expect(view.active_plan_count).toBe(0);
  });

  it("falls back to the config default allowance when the payer has no capacity row (count still derived)", async () => {
    const { service } = make({ capacity: null, activeCount: 2, capacityDefault: 1 });
    const view = await service.getCapacity(PAYER);
    expect(view.max_active_vacancies).toBe(1);
    expect(view.active_plan_count).toBe(2);
  });
});

/**
 * getPostingStats — the honest per-posting stats the My-jobs card renders. Only
 * findActivePlanForPostingAndPayer + findActiveBoost are exercised; the rest of the
 * repo/pricing/config deps are irrelevant to this read (a minimal mock suffices).
 */
describe("PostingPlansService.getPostingStats", () => {
  function makeStats(plan: unknown, boost: unknown) {
    const findActivePlanForPostingAndPayer = vi.fn().mockResolvedValue(plan);
    const findActiveBoost = vi.fn().mockResolvedValue(boost);
    const service = new PostingPlansService(
      { findActivePlanForPostingAndPayer, findActiveBoost } as never,
      { emit: vi.fn() } as never,
      { getActiveCatalog: vi.fn() } as never,
      { PAYMENTS_ENABLE_REAL: false } as never,
      // Irrelevant to this read (it touches neither the supply gate nor reach).
      { get: vi.fn().mockResolvedValue(DEFAULT_MATCH_CONFIG) } as never,
      { countReachForPosting: vi.fn() } as never,
    );
    return { service, findActivePlanForPostingAndPayer, findActiveBoost };
  }

  it("reports EFFECTIVE quota (receipt + top-ups), used count, tier, and active boost", async () => {
    const { service } = makeStats(
      { tier: "pro", applicantVisibilityQuota: 30, quotaTopupCount: 10, applicantsViewedCount: 12 },
      { id: "b-1" },
    );
    const stats = await service.getPostingStats(POSTING, PAYER);
    expect(stats).toEqual({
      plan_tier: "pro",
      applicant_visibility_quota: 40, // immutable receipt 30 + 10 topped up
      applicants_viewed_count: 12,
      boosted: true,
    });
  });

  it("a plan-less posting is honest: nulls + not boosted (no fabricated numbers)", async () => {
    const { service } = makeStats(undefined, undefined);
    const stats = await service.getPostingStats(POSTING, PAYER);
    expect(stats).toEqual({
      plan_tier: null,
      applicant_visibility_quota: null,
      applicants_viewed_count: null,
      boosted: false,
    });
  });

  it("a plan without a boost reports boosted:false", async () => {
    const { service } = makeStats(
      { tier: "standard", applicantVisibilityQuota: 10, quotaTopupCount: 0, applicantsViewedCount: 0 },
      undefined,
    );
    const stats = await service.getPostingStats(POSTING, PAYER);
    expect(stats.boosted).toBe(false);
    expect(stats.applicant_visibility_quota).toBe(10);
  });

  it("resolves the plan payer-scoped and the boost posting-scoped", async () => {
    const { service, findActivePlanForPostingAndPayer, findActiveBoost } = makeStats(
      undefined,
      undefined,
    );
    await service.getPostingStats(POSTING, PAYER);
    expect(findActivePlanForPostingAndPayer).toHaveBeenCalledWith(POSTING, PAYER, expect.any(Date));
    expect(findActiveBoost).toHaveBeenCalledWith(POSTING, expect.any(Date));
  });
});
