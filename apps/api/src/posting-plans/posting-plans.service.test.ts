import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { DEFAULT_CATALOG, parseCatalog, type Catalog } from "@badabhai/pricing";
import { DEFAULT_MATCH_CONFIG } from "@badabhai/match-engine";
import { PostingPlansService } from "./posting-plans.service";
import { PricingService } from "../pricing/pricing.service";
import { AGENCY_TWIN_READ_ONLY_MESSAGE } from "../common/agency-twin-fence";
import type { ServerConfig } from "@badabhai/config";
import type { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import {
  defaultModeResolver,
  ownScope,
  ownTenantKey,
  resolverOver,
} from "../payers/payer-tenant-scope.test-support";

const POSTING = "33333333-3333-4333-8333-333333333333";
const PAYER = "44444444-4444-4444-8444-444444444444";
const CTX = { correlationId: "22222222-2222-4222-8222-222222222222", requestId: "req-1" };

function make(
  opts: {
    catalog?: Catalog;
    activeBoost?: boolean;
    couponUsage?: { total: number; perPayer: number };
    postingExists?: boolean;
    /** ADR-0050 — the posting's `sync_source` ('agency_job' = a system-owned twin). */
    syncSource?: string | null;
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
    /** ADR-0053 — the REAL resolver; the default mode (`off`) keys every payer to themself. */
    tenancy?: PayerTenantScopeService;
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
  // ADR-0050 §4.3 — the purchases read the posting's sync_source: undefined = no posting.
  const findPostingSyncSource = vi
    .fn()
    .mockResolvedValue(opts.postingExists === false ? undefined : (opts.syncSource ?? null));
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
      findPostingSyncSource,
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
    opts.tenancy ?? defaultModeResolver(),
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
    listPausedPlansForPayer,
    findActiveBoost,
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

  it("ADR-0050 §4.3 — refuses a plan on an agency TWIN with the fence's 409, before any price or write", async () => {
    const { service, emit } = make({ syncSource: "agency_job" });
    const err = await service
      .buyPlan(POSTING, { payer_id: PAYER, tier: "standard" }, CTX)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toBe(AGENCY_TWIN_READ_ONLY_MESSAGE);
    expect(emit).not.toHaveBeenCalled();
  });

  it("ADR-0050 §4.3 — refuses a boost on an agency TWIN with the identical 409", async () => {
    const { service, emit } = make({ syncSource: "agency_job" });
    const err = await service
      .buyBoost(POSTING, { payer_id: PAYER, tier: "all_candidates" }, CTX)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toBe(AGENCY_TWIN_READ_ONLY_MESSAGE);
    expect(emit).not.toHaveBeenCalled();
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

describe("PostingPlansService payer seams (B3/LC-1 — the session scope is stamped)", () => {
  const SESSION_PAYER = "55555555-5555-4555-8555-555555555555";

  it("buyPlanInScope stamps the SESSION scope's tenant onto the plan + the purchased event", async () => {
    const { service, insertPlan, emit } = make();
    const { plan, quote } = await service.buyPlanInScope(
      POSTING,
      await ownScope(SESSION_PAYER),
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

  it("buyBoostInScope stamps the SESSION scope's tenant onto the boost", async () => {
    const { service, insertBoost, emit } = make();
    const { boost } = await service.buyBoostInScope(
      POSTING,
      await ownScope(SESSION_PAYER),
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

describe("PostingPlansService.topUpQuotaInScope (B2 — pricing-engine refill on an active plan)", () => {
  const SESSION_PAYER = "55555555-5555-4555-8555-555555555555";

  it("resolves the top-up price, atomically increments quota_topup_count, and emits payment + quota_topped", async () => {
    const { service, emit, names, addQuotaTopup } = make();
    const { plan, quote } = await service.topUpQuotaInScope(POSTING, await ownScope(SESSION_PAYER), { tier: "topup_10" }, CTX);
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
    const { plan } = await service.topUpQuotaInScope(POSTING, await ownScope(SESSION_PAYER), { tier: "topup_30" }, CTX);
    expect(plan.quotaTopupCount).toBe(60); // 30 prior + 30 added
  });

  it("409s when the posting has no active plan to top up (no payment emitted)", async () => {
    const { service, names } = make({ activeTopupPlan: null });
    await expect(
      service.topUpQuotaInScope(POSTING, await ownScope(SESSION_PAYER), { tier: "topup_10" }, CTX),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(names()).not.toContain("payment.authorized");
    expect(names()).not.toContain("posting_plan.quota_topped");
  });

  it("409s (no phantom grant/payment) when the plan raced to expiry between read and increment", async () => {
    const { service, names } = make({ topupRaced: true });
    await expect(
      service.topUpQuotaInScope(POSTING, await ownScope(SESSION_PAYER), { tier: "topup_10" }, CTX),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(names()).not.toContain("payment.authorized");
    expect(names()).not.toContain("posting_plan.quota_topped");
  });

  it.each([
    ["no plan at the read", { activeTopupPlan: null }],
    ["the plan raced to expiry before the increment", { topupRaced: true }],
  ] as const)("#2111: %s → 409 reason no_active_plan, message unchanged", async (_label, opts) => {
    const { service } = make(opts);
    const err = await service
      .topUpQuotaInScope(POSTING, await ownScope(SESSION_PAYER), { tier: "topup_10" }, CTX)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toStrictEqual({
      statusCode: 409,
      error: "Conflict",
      message: "no active plan to top up for this posting",
      reason: "no_active_plan",
    });
  });

  it("rejects an unknown top-up tier fail-closed (unavailable → 400)", async () => {
    const { service } = make();
    await expect(
      service.topUpQuotaInScope(POSTING, await ownScope(SESSION_PAYER), { tier: "nope" }, CTX),
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
      defaultModeResolver(),
    );
    return { service, findActivePlanForPostingAndPayer, findActiveBoost };
  }

  it("reports EFFECTIVE quota (receipt + top-ups), used count, tier, and active boost", async () => {
    const { service } = makeStats(
      { tier: "pro", applicantVisibilityQuota: 30, quotaTopupCount: 10, applicantsViewedCount: 12 },
      { id: "b-1" },
    );
    const stats = await service.getPostingStats(POSTING, await ownTenantKey(PAYER));
    expect(stats).toEqual({
      plan_tier: "pro",
      applicant_visibility_quota: 40, // immutable receipt 30 + 10 topped up
      applicants_viewed_count: 12,
      boosted: true,
    });
  });

  it("a plan-less posting is honest: nulls + not boosted (no fabricated numbers)", async () => {
    const { service } = makeStats(undefined, undefined);
    const stats = await service.getPostingStats(POSTING, await ownTenantKey(PAYER));
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
    const stats = await service.getPostingStats(POSTING, await ownTenantKey(PAYER));
    expect(stats.boosted).toBe(false);
    expect(stats.applicant_visibility_quota).toBe(10);
  });

  it("resolves the plan tenant-scoped and the boost posting-scoped", async () => {
    const { service, findActivePlanForPostingAndPayer, findActiveBoost } = makeStats(
      undefined,
      undefined,
    );
    await service.getPostingStats(POSTING, await ownTenantKey(PAYER));
    expect(findActivePlanForPostingAndPayer).toHaveBeenCalledWith(POSTING, PAYER, expect.any(Date));
    expect(findActiveBoost).toHaveBeenCalledWith(POSTING, expect.any(Date));
  });
});

// ---------------------------------------------------------------------------
// #2085 — price integrity on every posting-plans purchase route.
//
// (a) `expected_price_inr` is the ₹ the payer CONFIRMED. Absent → unchanged; equal → charged;
//     different → a 409 `price_mismatch` thrown BEFORE any receipt row or payment event, so a
//     refusal charges nothing.
// (b) The payer catalog prices each tier through the SAME function the charge does, so with an
//     ops offer live the catalog shows the offer price and the charge takes exactly that.
// ---------------------------------------------------------------------------
describe("#2085 — expected_price_inr guards every posting-plans purchase", () => {
  const SESSION_PAYER = "55555555-5555-4555-8555-555555555555";
  const PAYMENT_EVENTS = ["payment.authorized", "payment.captured"];

  async function expectMismatch(promise: Promise<unknown>, expected: number, current: number) {
    const err = await promise.then(
      () => {
        throw new Error("expected a 409 price_mismatch");
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      statusCode: 409,
      reason: "price_mismatch",
      expected_price_inr: expected,
      current_price_inr: current,
    });
  }

  it("quota top-up: a matching expected price is charged exactly as before", async () => {
    const { service, names, addQuotaTopup } = make();
    const { quote } = await service.topUpQuotaInScope(
      POSTING,
      await ownScope(SESSION_PAYER),
      { tier: "topup_10", expected_price_inr: 1000 },
      CTX,
    );
    expect(quote.finalInr).toBe(1000);
    expect(addQuotaTopup).toHaveBeenCalledOnce();
    expect(names()).toEqual([...PAYMENT_EVENTS, "posting_plan.quota_topped"]);
  });

  it("quota top-up: a mismatched expected price is refused — no grant, no payment event", async () => {
    const { service, emit, addQuotaTopup, findActivePlanForPostingAndPayer } = make();
    await expectMismatch(
      service.topUpQuotaInScope(
        POSTING,
        await ownScope(SESSION_PAYER),
        { tier: "topup_10", expected_price_inr: 900 },
        CTX,
      ),
      900,
      1000,
    );
    expect(addQuotaTopup).not.toHaveBeenCalled();
    expect(findActivePlanForPostingAndPayer).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("capacity: mismatch refused before the locked tx (no upsert, no event); match charged", async () => {
    const refused = make();
    await expectMismatch(
      refused.service.buyCapacity(SESSION_PAYER, { tier: "cap_5", expected_price_inr: 4999 }, CTX),
      4999,
      5000,
    );
    expect(refused.withTransaction).not.toHaveBeenCalled();
    expect(refused.upsertCapacity).not.toHaveBeenCalled();
    expect(refused.emit).not.toHaveBeenCalled();

    const ok = make();
    const res = await ok.service.buyCapacity(
      SESSION_PAYER,
      { tier: "cap_5", expected_price_inr: 5000 },
      CTX,
    );
    expect(res.quote.finalInr).toBe(5000);
    expect(ok.upsertCapacity).toHaveBeenCalledOnce();
  });

  it("plan: the payer seam forwards expected_price_inr; mismatch writes no plan", async () => {
    const { service, insertPlan, emit } = make();
    await expectMismatch(
      service.buyPlanInScope(POSTING, await ownScope(SESSION_PAYER), { tier: "standard", expected_price_inr: 1 }, CTX),
      1,
      1000,
    );
    expect(insertPlan).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("boost: the payer seam forwards expected_price_inr; mismatch writes no boost", async () => {
    const { service, insertBoost, emit, extendPostingBoostWindow } = make();
    await expectMismatch(
      service.buyBoostInScope(POSTING, await ownScope(SESSION_PAYER), { tier: "boost_7", expected_price_inr: 500 }, CTX),
      500,
      499,
    );
    expect(insertBoost).not.toHaveBeenCalled();
    expect(extendPostingBoostWindow).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("the comparison is against the FINAL price, coupon included", async () => {
    const cat = parseCatalog({
      ...DEFAULT_CATALOG,
      coupons: [
        {
          code: "save10",
          scope: { productCode: "quota_topup" },
          kind: "percent",
          value: 10,
          from: "2026-01-01T00:00:00.000Z",
          until: "2099-01-01T00:00:00.000Z",
          totalUsageCap: 100,
          perPayerLimit: 5,
        },
      ],
    });
    const { service } = make({ catalog: cat });
    const { quote } = await service.topUpQuotaInScope(
      POSTING,
      await ownScope(SESSION_PAYER),
      { tier: "topup_10", coupon: "save10", expected_price_inr: 900 },
      CTX,
    );
    expect(quote.finalInr).toBe(900);
  });

  it("an ACTIVE OFFER: the payer catalog shows the offer price and the charge equals it", async () => {
    const until = "2099-01-01T00:00:00.000Z";
    const cat = parseCatalog({
      ...DEFAULT_CATALOG,
      offers: [
        {
          code: "diwali25",
          scope: { productCode: "quota_topup", tierCode: "topup_10" },
          kind: "percent",
          value: 25,
          from: "2026-01-01T00:00:00.000Z",
          until,
        },
      ],
    });
    // The REAL PricingService projection over the same catalog the charge reads.
    const pricing = new PricingService(
      { getActive: vi.fn().mockResolvedValue({ catalog: cat, revision: 7 }) } as never,
      { emit: vi.fn() } as never,
    );
    const view = await pricing.getPayerCatalog();
    const shown = view.prices.find(
      (p) => p.product_code === "quota_topup" && p.tier_code === "topup_10",
    )!;
    expect(shown).toEqual({
      product_code: "quota_topup",
      tier_code: "topup_10",
      base_price_inr: 1000,
      price_inr: 750,
      discount_inr: 250,
      offer: { code: "diwali25", ends_at: until },
    });

    // The web sends the price it showed; the charge accepts it and takes exactly that.
    const { service, emit } = make({ catalog: cat });
    const { quote } = await service.topUpQuotaInScope(
      POSTING,
      await ownScope(SESSION_PAYER),
      { tier: "topup_10", expected_price_inr: shown.price_inr },
      CTX,
    );
    expect(quote.finalInr).toBe(shown.price_inr);
    expect(quote.offerApplied).toBe("diwali25");
    const captured = emit.mock.calls.find((c) => c[0].event_name === "payment.captured")![0];
    expect(captured.payload.amount_inr).toBe(750);

    // A client still showing the LIST price is refused rather than silently charged ₹750.
    const stale = make({ catalog: cat });
    await expectMismatch(
      stale.service.topUpQuotaInScope(
        POSTING,
        await ownScope(SESSION_PAYER),
        { tier: "topup_10", expected_price_inr: 1000 },
        CTX,
      ),
      1000,
      750,
    );
    expect(stale.addQuotaTopup).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ADR-0053 (PAY-DB-01) P2c — plans, boosts, quota top-ups, capacity and coupons follow the
// TENANT; every event names the acting LOGIN. The REAL resolver over an in-memory membership
// table; the repository fakes below answer by the tenant key they are handed, exactly as their
// WHERE does (`payer_id = $tenant`), so a call keyed by the wrong id reads the wrong world.
// ---------------------------------------------------------------------------
describe("ADR-0053 P2c — PostingPlansService follows the TENANT", () => {
  const ANCHOR = PAYER;
  const MEMBER = "66666666-6666-4666-8666-666666666666";
  const TEAM = [{ anchor: ANCHOR, members: [MEMBER] }];
  const ON = { PAYER_ORG_TENANCY_MODE: "on" } as unknown as ServerConfig;
  const PAUSED = { id: "old-1", jobPostingId: "jp-1", expiresAt: null };
  const SAVE10 = parseCatalog({
    ...DEFAULT_CATALOG,
    coupons: [
      {
        code: "save10",
        scope: { productCode: "job_posting" },
        kind: "percent",
        value: 10,
        from: "2026-01-01T00:00:00.000Z",
        until: "2099-01-01T00:00:00.000Z",
        totalUsageCap: 100,
        perPayerLimit: 1,
      },
    ],
  });

  /**
   * The ANCHOR owns everything: one active plan on POSTING (which also uses the org's whole
   * allowance of 1), a paused plan, a capacity row of 1, and one redemption of `save10`. The
   * teammate owns nothing under their own key.
   */
  function teamWorld(tenancy: PayerTenantScopeService, opts: Parameters<typeof make>[0] = {}) {
    const d = make({ capacityDefault: 1, ...opts, tenancy });
    const theOrg = (tenant: string) => tenant === ANCHOR;
    d.countActivePlansForPayer.mockImplementation(async (_tx: unknown, tenant: string) =>
      theOrg(tenant) ? 1 : 0,
    );
    d.getCapacity.mockImplementation(async (tenant: string) =>
      theOrg(tenant) ? { maxActiveVacancies: 1, sourceTier: "cap_1", expiresAt: null } : undefined,
    );
    d.listPausedPlansForPayer.mockImplementation(async (_tx: unknown, tenant: string) =>
      theOrg(tenant) ? [PAUSED] : [],
    );
    d.findActivePlanForPostingAndPayer.mockImplementation(async (_p: string, tenant: string) =>
      theOrg(tenant) ? { id: "p-1", quotaTopupCount: 0 } : undefined,
    );
    d.addQuotaTopup.mockImplementation(async (id: string, tenant: string, delta: number) =>
      theOrg(tenant) ? { id, quotaTopupCount: delta } : undefined,
    );
    d.couponUsage.mockImplementation(async (_code: string, tenant: string) => ({
      total: 1,
      perPayer: theOrg(tenant) ? 1 : 0,
    }));
    return { ...d, resolve: vi.spyOn(tenancy, "resolve") };
  }

  type Emitted = {
    event_name: string;
    actor: unknown;
    subject: unknown;
    payload: Record<string, unknown>;
  };
  const emitted = (emit: ReturnType<typeof vi.fn>): Emitted[] =>
    emit.mock.calls.map((c) => c[0] as Emitted);
  const asMember = { actor_type: "payer", actor_id: MEMBER };

  it("on: a teammate's plan on the org's posting is the ORG's — locked, counted and capped by the anchor's allowance, stamped with the anchor", async () => {
    const tenancy = resolverOver(ON, TEAM);
    const d = teamWorld(tenancy, { enforceCapacity: true });
    const res = await d.service.buyPlanInScope(
      POSTING,
      await tenancy.resolve(MEMBER),
      { tier: "standard" },
      CTX,
    );

    expect(d.lockPayer).toHaveBeenCalledWith(expect.anything(), ANCHOR);
    expect(d.getCapacity).toHaveBeenCalledWith(ANCHOR, expect.anything());
    expect(d.countActivePlansForPayer).toHaveBeenCalledWith(
      expect.anything(),
      ANCHOR,
      expect.any(Date),
    );
    // The org already uses its whole allowance (1 of 1), so the teammate's plan is paused.
    expect(res.paused).toBe(true);
    expect(d.insertPlan).toHaveBeenCalledWith(
      expect.objectContaining({ jobPostingId: POSTING, payerId: ANCHOR, status: "paused" }),
      expect.anything(),
    );
    const events = emitted(d.emit);
    expect(events.map((e) => e.event_name)).toEqual([
      "payment.authorized",
      "payment.captured",
      "job_posting.purchased",
      "posting_plan.paused",
    ]);
    for (const e of events) expect(e.payload.payer_id, e.event_name).toBe(ANCHOR);
    for (const e of events.slice(0, 3)) expect(e.actor, e.event_name).toEqual(asMember);
    expect(events[3]!.actor).toEqual({ actor_type: "system" });
  });

  it("off (the default): the SAME teammate buys under their own key — own lock, own count, own stamp, as today", async () => {
    const tenancy = defaultModeResolver(TEAM);
    const d = teamWorld(tenancy, { enforceCapacity: true });
    const res = await d.service.buyPlanInScope(
      POSTING,
      await tenancy.resolve(MEMBER),
      { tier: "standard" },
      CTX,
    );

    expect(d.lockPayer).toHaveBeenCalledWith(expect.anything(), MEMBER);
    expect(d.countActivePlansForPayer).toHaveBeenCalledWith(
      expect.anything(),
      MEMBER,
      expect.any(Date),
    );
    expect(res.paused).toBe(false); // the teammate's own (empty) allowance
    expect(d.insertPlan).toHaveBeenCalledWith(
      expect.objectContaining({ payerId: MEMBER, status: "active" }),
      expect.anything(),
    );
    for (const e of emitted(d.emit)) {
      expect(e.payload.payer_id).toBe(MEMBER);
      expect(e.actor).toEqual(asMember);
    }
  });

  it("on: the ops routes resolve the body payer_id through the SAME resolver, once (§5.2 rule 4)", async () => {
    const tenancy = resolverOver(ON, TEAM);
    const plan = teamWorld(tenancy);
    await plan.service.buyPlan(POSTING, { payer_id: MEMBER, tier: "standard" }, CTX);
    expect(plan.resolve).toHaveBeenCalledTimes(1);
    expect(plan.resolve).toHaveBeenCalledWith(MEMBER);
    expect(plan.insertPlan).toHaveBeenCalledWith(
      expect.objectContaining({ payerId: ANCHOR }),
      expect.anything(),
    );
    const purchased = emitted(plan.emit).find((e) => e.event_name === "job_posting.purchased")!;
    expect(purchased.actor).toEqual(asMember);

    const boost = teamWorld(tenancy);
    boost.resolve.mockClear();
    await boost.service.buyBoost(POSTING, { payer_id: MEMBER, tier: "boost_7" }, CTX);
    expect(boost.resolve).toHaveBeenCalledTimes(1);
    expect(boost.insertBoost).toHaveBeenCalledWith(expect.objectContaining({ payerId: ANCHOR }));
  });

  it("on: a teammate's boost is the ORG's receipt; job_posting.boosted and a refusal name the org as payer, the login as actor", async () => {
    const tenancy = resolverOver(ON, TEAM);
    const d = teamWorld(tenancy);
    await d.service.buyBoostInScope(POSTING, await tenancy.resolve(MEMBER), { tier: "boost_7" }, CTX);
    expect(d.insertBoost).toHaveBeenCalledWith(
      expect.objectContaining({ jobPostingId: POSTING, payerId: ANCHOR }),
    );
    const boosted = emitted(d.emit).find((e) => e.event_name === "job_posting.boosted")!;
    expect(boosted).toMatchObject({ actor: asMember, payload: { payer_id: ANCHOR } });

    const refused = teamWorld(tenancy, { boostSupplyFloor: 25, reachTotal: 4 });
    await expect(
      refused.service.buyBoostInScope(
        POSTING,
        await tenancy.resolve(MEMBER),
        { tier: "boost_7" },
        CTX,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(emitted(refused.emit)).toEqual([
      expect.objectContaining({
        event_name: "job_posting.boost_refused",
        actor: asMember,
        payload: expect.objectContaining({ payer_id: ANCHOR }),
      }),
    ]);
  });

  it("on: a teammate tops up the ORG's plan — found and incremented under the anchor's key; off: the org's plan is not theirs (409)", async () => {
    const on = resolverOver(ON, TEAM);
    const d = teamWorld(on);
    const { plan } = await d.service.topUpQuotaInScope(
      POSTING,
      await on.resolve(MEMBER),
      { tier: "topup_10" },
      CTX,
    );
    expect(d.findActivePlanForPostingAndPayer).toHaveBeenCalledWith(
      POSTING,
      ANCHOR,
      expect.any(Date),
    );
    expect(d.addQuotaTopup).toHaveBeenCalledWith("p-1", ANCHOR, 10, expect.any(Date));
    expect(plan.quotaTopupCount).toBe(10);
    const topped = emitted(d.emit).find((e) => e.event_name === "posting_plan.quota_topped")!;
    expect(topped).toMatchObject({ actor: asMember, payload: { payer_id: ANCHOR, plan_id: "p-1" } });

    const offTenancy = defaultModeResolver(TEAM);
    const off = teamWorld(offTenancy);
    const err = await off.service
      .topUpQuotaInScope(POSTING, await offTenancy.resolve(MEMBER), { tier: "topup_10" }, CTX)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ reason: "no_active_plan" });
    expect(off.findActivePlanForPostingAndPayer).toHaveBeenCalledWith(
      POSTING,
      MEMBER,
      expect.any(Date),
    );
    expect(off.emit).not.toHaveBeenCalled();
  });

  it("on: a teammate's capacity purchase raises the ORG's allowance and resumes the org's paused plan; the response echoes the caller", async () => {
    const d = teamWorld(resolverOver(ON, TEAM));
    const res = await d.service.buyCapacity(MEMBER, { tier: "cap_5" }, CTX);

    expect(d.resolve).toHaveBeenCalledTimes(1);
    expect(d.lockPayer).toHaveBeenCalledWith(expect.anything(), ANCHOR);
    expect(d.upsertCapacity).toHaveBeenCalledWith(
      expect.objectContaining({ payerId: ANCHOR, maxActiveVacancies: 5 }),
      expect.anything(),
    );
    expect(d.countActivePlansForPayer).toHaveBeenCalledWith(
      expect.anything(),
      ANCHOR,
      expect.any(Date),
    );
    expect(d.listPausedPlansForPayer).toHaveBeenCalledWith(expect.anything(), ANCHOR);
    expect(res).toMatchObject({ payer_id: MEMBER, resumed_plan_ids: ["old-1"] });

    const events = emitted(d.emit);
    for (const e of events) expect(e.payload.payer_id, e.event_name).toBe(ANCHOR);
    const purchased = events.find((e) => e.event_name === "capacity.purchased")!;
    expect(purchased).toMatchObject({
      actor: asMember,
      subject: { subject_type: "pricing_plan", subject_id: ANCHOR },
    });
    for (const e of events.filter((x) => x.event_name.startsWith("payment."))) {
      expect(e).toMatchObject({
        actor: asMember,
        subject: { subject_type: "pricing_plan", subject_id: ANCHOR },
      });
    }
    const resumed = events.find((e) => e.event_name === "posting_plan.resumed")!;
    expect(resumed.actor).toEqual({ actor_type: "system" });
  });

  it("on: a teammate's capacity view is the ORG's allowance and live count; payer_id echoes the caller (§10)", async () => {
    const d = teamWorld(resolverOver(ON, TEAM));
    const view = await d.service.getCapacity(MEMBER);
    expect(d.resolve).toHaveBeenCalledTimes(1);
    expect(d.getCapacity).toHaveBeenCalledWith(ANCHOR, expect.anything());
    expect(d.countActivePlansForPayer).toHaveBeenCalledWith(
      expect.anything(),
      ANCHOR,
      expect.any(Date),
    );
    expect(view).toMatchObject({
      payer_id: MEMBER,
      max_active_vacancies: 1,
      active_plan_count: 1,
      source_tier: "cap_1",
    });

    const off = teamWorld(defaultModeResolver(TEAM));
    expect(await off.service.getCapacity(MEMBER)).toMatchObject({
      payer_id: MEMBER,
      max_active_vacancies: 1, // the config default: the teammate has no row of their own
      active_plan_count: 0,
      source_tier: null,
    });
  });

  it("O-4: a coupon's per-payer limit is per ORG in `on` — the org has used it, so the teammate pays full price", async () => {
    const tenancy = resolverOver(ON, TEAM);
    const d = teamWorld(tenancy, { catalog: SAVE10 });
    const { quote } = await d.service.buyPlanInScope(
      POSTING,
      await tenancy.resolve(MEMBER),
      { tier: "standard", coupon: "save10" },
      CTX,
    );
    expect(d.couponUsage).toHaveBeenCalledWith("save10", ANCHOR);
    expect(quote.couponApplied).toBeNull();
    expect(quote.finalInr).toBe(1000);
    expect(emitted(d.emit).map((e) => e.event_name)).not.toContain("coupon.redeemed");
  });

  it("O-4: a redemption is stamped with the ORG (so it counts against the org), the login as actor; in `off` it is the login's own", async () => {
    const tenancy = resolverOver(ON, TEAM);
    const d = teamWorld(tenancy, { catalog: SAVE10 });
    d.couponUsage.mockResolvedValue({ total: 0, perPayer: 0 }); // nobody has used it yet
    const { quote } = await d.service.buyPlanInScope(
      POSTING,
      await tenancy.resolve(MEMBER),
      { tier: "standard", coupon: "save10" },
      CTX,
    );
    expect(quote.couponApplied).toBe("save10");
    expect(emitted(d.emit).find((e) => e.event_name === "coupon.redeemed")).toMatchObject({
      actor: asMember,
      subject: { subject_type: "pricing_plan", subject_id: ANCHOR },
      payload: { coupon_code: "save10", payer_id: ANCHOR },
    });

    const offTenancy = defaultModeResolver(TEAM);
    const off = teamWorld(offTenancy, { catalog: SAVE10 });
    const own = await off.service.buyPlanInScope(
      POSTING,
      await offTenancy.resolve(MEMBER),
      { tier: "standard", coupon: "save10" },
      CTX,
    );
    expect(off.couponUsage).toHaveBeenCalledWith("save10", MEMBER);
    expect(own.quote.couponApplied).toBe("save10"); // the org's redemption is not the teammate's
    const redeemed = emitted(off.emit).find((e) => e.event_name === "coupon.redeemed")!;
    expect(redeemed.payload.payer_id).toBe(MEMBER);
  });

  it("the *InScope seams never resolve: they use the scope their caller already resolved", async () => {
    const tenancy = resolverOver(ON, TEAM);
    const scope = await tenancy.resolve(MEMBER);
    const d = teamWorld(tenancy);
    d.resolve.mockClear();
    await d.service.buyPlanInScope(POSTING, scope, { tier: "standard" }, CTX);
    await d.service.buyBoostInScope(POSTING, scope, { tier: "boost_7" }, CTX);
    await d.service.topUpQuotaInScope(POSTING, scope, { tier: "topup_10" }, CTX);
    await d.service.getPostingStats(POSTING, scope.tenantKey);
    expect(d.resolve).not.toHaveBeenCalled();
  });
});
